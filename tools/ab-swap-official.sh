#!/bin/bash
# A/B 交换编排：停定制栈 → 等显存归零 → 起官方栈 → 探活；官方栈起不来自动回滚定制栈。
# 全程 detached 跑，状态写 /home/ll/deploy/ab-swap.status
ST=/home/ll/deploy/ab-swap.status
LOG=/home/ll/deploy/ab-swap.log
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG" >> "$ST"; }

health(){ curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:18420/health 2>/dev/null; }
vram_used(){ timeout 20 nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | awk '{s+=$1} END{print s+0}'; }

say "STEP1 stop custom (18420)"
bash /home/ll/deploy/stop-flash-next-w4a16.sh >>"$LOG" 2>&1
say "STEP1 done stop issued"

say "STEP2 wait vram drain"
ok=0
for i in $(seq 1 40); do
  u=$(vram_used)
  [ "$u" -lt 2000 ] && { ok=1; break; }
  sleep 5
done
[ "$ok" = 1 ] || say "WARN vram not drained (used=$(vram_used)) after 200s, continue anyway"
say "STEP2 vram used=$(vram_used)"

say "STEP3 start official 0.30.0"
: > /home/ll/deploy/vllm-official-18420.log
setsid nohup bash /home/ll/deploy/start-official-18420.sh >/dev/null 2>&1 < /dev/null &
sleep 20

say "STEP4 poll health (<=13min)"
for i in $(seq 1 156); do
  code=$(health)
  if [ "$code" = "200" ]; then say "OFFICIAL_READY iter=$i"; echo OFFICIAL_READY > "$ST.done"; exit 0; fi
  # 进程死了就提前止损（找宿主 venv 的 vllm 主进程，括号防自匹配）
  if ! pgrep -f "vllm-env/bin/[v]llm serve" >/dev/null 2>&1; then
    say "official process died at iter=$i, early rollback"
    break
  fi
  sleep 5
done

say "STEP5 OFFICIAL FAILED -> rollback custom"
tail -30 /home/ll/deploy/vllm-official-18420.log >> "$LOG" 2>&1
bash /home/ll/deploy/stop-flash-next-w4a16.sh >>"$LOG" 2>&1
pkill -TERM -f "vllm-env/bin/[v]llm serve" 2>/dev/null
sleep 10
u=$(vram_used); say "rollback pre-check vram used=$u"
setsid nohup bash /home/ll/deploy/start-flash-next-w4a16.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 156); do
  code=$(health)
  [ "$code" = "200" ] && { say "CUSTOM_RESTORED iter=$i"; echo CUSTOM_RESTORED > "$ST.done"; exit 0; }
  sleep 5
done
say "ROLLBACK ALSO NOT HEALTHY after 13min - MANUAL ATTENTION"
echo NEED_MANUAL > "$ST.done"
