#!/bin/bash
# kvoff c3 验证窗口（2026-09-23）
# 启动：setsid nohup bash /home/ll/deploy/kvoff-c3-window.sh >/dev/null 2>&1 < /dev/null &
# 进度：cat /home/ll/deploy/kvoff-c3-window.result
R=/home/ll/deploy
LOG=$R/vllm-flash-next-w4a16.log
RES=$R/kvoff-c3-window.result
MARKF=/tmp/kvoff-c3.logmark
say(){ echo "[$(date -u '+%m-%d %H:%M:%S')] $*" >> $RES; }
: > $RES
say "=== kvoff c3 window start ==="

systemctl --user disable --now fnx-18420-watchdog.timer >> $RES 2>&1 && say "W0 watchdog timer disabled"

python3 $R/patch-kvoffload-c1c2-0922.py --check > /tmp/kvoff-c3-c1c2check.txt 2>&1
if grep -q "ANCHOR-MISSING\|PRISTINE" /tmp/kvoff-c3-c1c2check.txt; then
  say "W1 FAIL: c1c2 not fully applied"; tail -5 /tmp/kvoff-c3-c1c2check.txt >> $RES; exit 1
fi
python3 $R/patch-kvoffload-c3-0923.py --self-test >> $RES 2>&1 || { say "W1 FAIL: c3 self-test"; exit 1; }
python3 $R/patch-kvoffload-c3-0923.py --apply >> $RES 2>&1 || { say "W1 FAIL: c3 apply"; exit 1; }
say "W1 c3 applied"

bash $R/stop-flash-next-w4a16.sh >> $RES 2>&1; say "W2 stop rc=$?"
used=99999
for i in $(seq 1 36); do
  used=$(timeout 20 nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | awk '{s+=$1} END{print s+0}')
  [ "${used:-99999}" -lt 1500 ] && break
  sleep 5
done
say "W2 vram used=${used}MiB"

MARK=$(stat -c %s "$LOG" 2>/dev/null || echo 0); echo $MARK > $MARKF
cd $R
env FN_MODEL_PATH=/media/ll/data/models-1m/Qwen3.8-Flash-Next-W4A16-AutoRound-1M \
 FN_LONGCTX=1 FN_1M_MODEL_PATH=/media/ll/data/models-1m/Qwen3.8-Flash-Next-W4A16-AutoRound-1M \
 FN_YARN_FACTOR=4.0 FN_MAXLEN=1048576 FN_GPUMEM=0.96 FN_SEQS=3 FN_MBTOKENS=8192 \
 FN_BLOCK=1616 FN_SPEC=mtp4 FN_ASYNC=1 FN_PLE_INT8=1 FN_PLE_LOC=heap \
 FN_KVOFF=1 FN_KVOFF_BYTES=51539607552 \
 FN_SERVED=qwen3.8-flash-next FN_PORT=18420 \
 setsid nohup bash $R/start-flash-next-w4a16.sh >> $LOG 2>&1 < /dev/null &
say "W3 launched (KVOFF=1, 48GiB)"

ok=0
for i in $(seq 1 84); do
  sleep 10
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18420/health)
  [ "$code" = "200" ] && { ok=1; break; }
done
if [ $ok = 0 ]; then
  say "W4 FAIL health"
  tail -c +$(( $(cat $MARKF) + 1 )) "$LOG" | grep -aE "Error|Traceback" | tail -10 >> $RES
  systemctl --user enable --now fnx-18420-watchdog.timer >> $RES 2>&1
  exit 1
fi
say "W4 health 200"
tail -c +$(( $(cat $MARKF) + 1 )) "$LOG" | grep -a "CPUOffloadingSpec" | head -2 >> $RES

resp=$(curl -s --max-time 300 http://127.0.0.1:18420/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-flash-next","messages":[{"role":"user","content":"用一句话说明前缀缓存的作用"}],"max_tokens":150,"temperature":0}')
if echo "$resp" | grep -q '"content"'; then say "W5 PASS simple request"; else say "W5 FAIL simple"; echo "$resp" | head -c 400 >> $RES; fi

python3 $R/kvoff-c3-preempt-test.py >> $RES 2>&1; say "W6 preempt test rc=$?"

if tail -c +$(( $(cat $MARKF) + 1 )) "$LOG" | grep -qa "cuMemcpyBatchAsync failed"; then
  say "W7 VERDICT: CRASH REPRODUCED, forensic dump:"
  tail -c +$(( $(cat $MARKF) + 1 )) "$LOG" | grep -a -A40 "kvoff-c3. batch copy FAILED" | tail -70 >> $RES
else
  say "W7 VERDICT: no batch-copy crash this window"
fi
tail -c +$(( $(cat $MARKF) + 1 )) "$LOG" | grep -a "kvoff-c3. offloading stats key" | sort -u | head -8 >> $RES

curl -s --max-time 10 http://127.0.0.1:18420/metrics 2>/dev/null | grep -a kv_offload | grep -av '^#' | head -12 >> $RES

systemctl --user enable --now fnx-18420-watchdog.timer >> $RES 2>&1 && say "W9 watchdog re-enabled"
say "=== window end ==="
