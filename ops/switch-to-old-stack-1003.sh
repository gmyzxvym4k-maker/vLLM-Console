#!/bin/bash
# switch-to-old-stack-1003.sh —— 18420 从官方 vLLM 0.30.0 新栈回退到 chroot 旧栈（定制镜像 0.1.dev20073）
#
# 背景（2026-10-03）：用户因 `"duct"` 连续重复问题要求回退旧栈。当天 15:30 有人试过旧栈，
# 15:47 两个 PP rank 卡死在 pp_broadcast SeqNum=7（NCCL 600s 超时互杀），疑似与新栈交接时
# GPU/内存状态不干净有关。本脚本按"干净顺序"重来一遍：停净 → 置 DISABLED 哨兵 → 预热 PLE
# 页缓存 → 起旧栈 → 健康检查。全程写日志，可断点复查。
#
# 用法（在 ll@192.168.1.127 上，脱离终端执行）：
#   setsid bash /home/ll/deploy/ops/switch-to-old-stack-1003.sh </dev/null >/dev/null 2>&1 &
# 日志：/home/ll/deploy/switch-old-1003.log
#
# 回退回去（再上新栈）：rm /home/ll/deploy/vllm-0300/DISABLED 后用控制台或
#   vllm-0300/start-flash-next-0300.sh 重新拉起即可（哨兵一删，控制台/看门狗立刻认新栈）。
set -u
DEPLOY=/home/ll/deploy
LOG=$DEPLOY/switch-old-1003.log
exec >>"$LOG" 2>&1
ts(){ date +"%F %T"; }

echo "===== switch-to-old-stack begin $(ts) ====="

# 0) 前置检查
STOP_NEW=$DEPLOY/vllm-0300/stop-flash-next-0300.sh
START_OLD=$DEPLOY/start-flash-next-w4a16.sh
INNER_OLD=/media/ll/data/vllm-image/rootfs/home/ll/deploy/flash-next-w4a16-inner.sh
TABLE=/media/ll/data/models-1m/Qwen3.8-Flash-Next-W4A16-AutoRound-1M/model-00016-of-00017.safetensors
for f in "$STOP_NEW" "$START_OLD" "$INNER_OLD"; do
  [ -e "$f" ] || { echo "[FATAL] 缺少 $f，中止（未做任何改动）"; exit 1; }
done

# 1) 停新栈（显式路径，不受哨兵影响；脚本内含 SIGTERM→90s→SIGKILL 与显存归零等待）
echo "[1/5] stop new stack $(ts)"
bash "$STOP_NEW" 18420
echo "[1/5] stop rc=$? $(ts)"

# 2) 残留复核（vllm serve / VLLM:: 主体；排除本脚本自身链）
sleep 5
LEFT=$(pgrep -f "vllm serve|VLLM::EngineCore|VLLM::Worker" 2>/dev/null | grep -vw "$$" | wc -l)
echo "[2/5] leftover engine procs=$LEFT $(ts)"
if [ "$LEFT" != "0" ]; then
  echo "[2/5] 仍有残留，再等 30s 复查"
  sleep 30
  LEFT=$(pgrep -f "vllm serve|VLLM::EngineCore|VLLM::Worker" 2>/dev/null | wc -l)
  echo "[2/5] leftover=$LEFT（若非 0 将继续，但启动可能受幽灵显存影响）"
fi

# 3) 置 DISABLED 哨兵：控制台 resolveStart/StopScript 与看门狗即刻改路由旧栈
touch $DEPLOY/vllm-0300/DISABLED
echo "[3/5] DISABLED marker created $(ts)"

# 4) PLE 页缓存预热（BF16 heap 档每次冷启要从盘重读 95.4GiB≈97s；预热后命中缓存）
if [ -f "$TABLE" ]; then
  echo "[4/5] prewarm begin ($(du -h "$TABLE" | cut -f1)) $(ts)"
  bash $DEPLOY/flash-next-prewarm.sh "$TABLE"
  echo "[4/5] prewarm end $(ts)"
else
  echo "[4/5] PLE 表文件不存在，跳过预热：$TABLE"
fi

# 5) 起旧栈（参数=10-03 15:30 试验版逐键照抄，去掉旧 inner 不消费的 FN_SIMPLE_OFFLOAD；
#    采样沿用 t0.3/rp1.1——针对复读问题的现行定档；PLE=BF16 heap，251GB 内存足够）
export FN_PORT=18420 FN_SERVED=qwen3.8-flash-next
export FN_MODEL_PATH=/media/ll/data/models/Qwen3.8-Flash-Next-W4A16-AutoRound
export FN_1M_MODEL_PATH=/media/ll/data/models-1m/Qwen3.8-Flash-Next-W4A16-AutoRound-1M
export FN_LONGCTX=1 FN_YARN_FACTOR=4 FN_MAXLEN=1048576
export FN_BLOCK=1616 FN_SEQS=4 FN_MBTOKENS=8192 FN_GPUMEM=0.93
export FN_TP=1 FN_PP=2 FN_ASYNC=1 FN_CHUNKED=1 FN_PREFIX_CACHE=1
export FN_PLE_INT8=0 FN_PLE_LOC=heap FN_KVOFF=0
export FN_SPEC='{"method":"mtp","num_speculative_tokens":4,"use_local_argmax_reduction":false}'
export FN_GENCFG='{"temperature":0.3,"top_p":0.95,"top_k":20,"min_p":0,"presence_penalty":0,"repetition_penalty":1.1}'
export FN_CHATKWARGS='{"enable_thinking":true,"preserve_thinking":true,"reasoning_effort":"xhigh"}'
echo "[5/5] start old stack $(ts)"
bash "$START_OLD" &
WPID=$!

# 6) 健康检查：最长 20 分钟（旧栈 BF16 heap 冷启约 8 分钟，预热后更快）
for i in $(seq 1 240); do
  sleep 5
  if curl -sf -m 3 http://127.0.0.1:18420/v1/models >/dev/null 2>&1; then
    echo "[health] /v1/models UP after $((i*5))s $(ts)"
    echo "[health] smoke generation:"
    curl -s -m 90 http://127.0.0.1:18420/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{"model":"qwen3.8-flash-next","messages":[{"role":"user","content":"请只回复两个字：收到"}],"max_tokens":64,"temperature":0.3}' \
      | head -c 600
    echo
    echo "===== SUCCESS $(ts) ====="
    exit 0
  fi
  if ! kill -0 "$WPID" 2>/dev/null; then
    echo "[health] wrapper(pid=$WPID) 提前退出（引擎多半启动失败），第 $((i*5))s $(ts)"
    break
  fi
done

echo "[health] FAILED：18420 未在时限内起来。看引擎日志：$DEPLOY/vllm-flash-next-w4a16.log"
echo "         最后一次错误摘录："
tail -n 25 "$DEPLOY/vllm-flash-next-w4a16.log" 2>/dev/null | grep -avE "GET /metrics|POST /" | tail -n 15
echo "===== DONE(with failure) $(ts) ====="
exit 1
