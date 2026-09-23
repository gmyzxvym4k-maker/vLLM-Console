#!/bin/bash
# 手动恢复定制栈：停官方(18420) → 等显存 → 起生产 chroot 定制栈
ST=/home/ll/deploy/ab-swap.status
say(){ echo "[$(date +%H:%M:%S)] RESTORE $*" | tee -a /home/ll/deploy/ab-swap.log; }
say "stop official"
pkill -TERM -f "vllm-env/bin/[v]llm serve" 2>/dev/null
sleep 15
pkill -KILL -f "vllm-env/bin/[v]llm serve" 2>/dev/null
# 兜底：残留 VLLM:: 子进程（属 root 时需 sudo，这里尽力而为）
for i in $(seq 1 30); do
  u=$(timeout 20 nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | awk '{s+=$1} END{print s+0}')
  [ "$u" -lt 2000 ] && break
  sleep 5
done
say "vram used=$u, start custom production"
setsid nohup bash /home/ll/deploy/start-flash-next-w4a16.sh >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 156); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:18420/health 2>/dev/null)
  [ "$code" = "200" ] && { say "CUSTOM_HEALTHY iter=$i"; echo CUSTOM_RESTORED > "$ST.done"; exit 0; }
  sleep 5
done
say "CUSTOM NOT HEALTHY after 13min - MANUAL ATTENTION"
