#!/usr/bin/env bash
# gpu-ab-offset.sh — 在 GPU 机本地跑「GPC VF 偏移 0 vs +N」的重负载 A/B 实测
# 用法: bash gpu-ab-offset.sh [偏移MHz，默认150] [负载token档，默认6000] [并发，默认2] [轮数，默认3]
# 依赖: /tmp/gpu-clock-loadtest.py（本项目 tools/gpu-clock-loadtest.py）
#       /home/ll/deploy/170tune/nvml_oc（170tune NVML 路线，写 GPC VF offset 并回读）
# 提权: nvmlDeviceSetGpcClkVfOffset 需 root；口令走 lib/sudo-pass.sh
#       （CONSOLE_SUDO_PASS 环境变量或 ~/.console-sudo，仓库内不留明文）
set -uo pipefail
OFF="${1:-150}"; TOK="${2:-6000}"; CONC="${3:-2}"; ROUNDS="${4:-3}"
NV=/home/ll/deploy/170tune/nvml_oc
LT=/tmp/gpu-clock-loadtest.py
# 提权口令来源（仓库内不留明文）：CONSOLE_SUDO_PASS 环境变量 → ~/.console-sudo（600）→ 交互输入。
# helper 查找顺序：DEPLOY_DIR → 脚本所在目录 → 上级目录，兼容仓库开发与单文件 scp 上线两种摆放。
CDIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
for _csudo_lib in "${DEPLOY_DIR:-/home/ll/deploy}/lib/sudo-pass.sh" ${CDIR:+$CDIR/lib/sudo-pass.sh} ${CDIR:+$CDIR/../lib/sudo-pass.sh}; do
  [ -n "$_csudo_lib" ] && [ -f "$_csudo_lib" ] && { . "$_csudo_lib"; break; }
done
if [ -z "${CSUDO_PW+isset}" ]; then CSUDO_PW=""; require_sudo_pass || exit 1; fi
SUDO() { sudo_run "$@"; }

read_off() { timeout 15 "$NV" -i "$1" 2>&1 | sed -n '/GPC/,+2p' | grep -i 'current offset' | sed 's/.*: //'; }

[ -x "$NV" ] || { echo "缺 $NV"; exit 1; }
[ -f "$LT" ] || { echo "缺 $LT"; exit 1; }

echo "### 预热（丢弃）"
timeout 300 python3 "$LT" --rounds 1 --tokens "$TOK" --concurrency "$CONC" --label warm --json-out /tmp/ab_warm.json >/dev/null 2>&1

for LBL_OFF in 0 "$OFF"; do
  echo "### 设定 GPC 偏移 = +${LBL_OFF} MHz"
  for i in 0 1; do SUDO timeout 30 "$NV" "$LBL_OFF" 0 "$i" >/dev/null 2>&1; done
  for i in 0 1; do echo "  GPU$i 回读: $(read_off "$i")"; done
  J=/tmp/ab_off${LBL_OFF}.json
  echo "### 带载实测（tokens=${TOK} concurrency=${CONC} rounds=${ROUNDS}）→ $J"
  timeout 900 python3 "$LT" --rounds "$ROUNDS" --tokens "$TOK" --concurrency "$CONC" \
    --label "off${LBL_OFF}" --json-out "$J" >/dev/null 2>&1
  python3 - "$J" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print("  样本 busy=%d/%d" % (d.get("samples_busy",0), d.get("samples_total",0)))
for k in ("sm_busy","power_busy","temp_busy"):
    v=d.get(k) or {}
    print("  %-11s min=%s med=%s max=%s mean=%s" % (k, v.get("min"), v.get("med"), v.get("max"), v.get("mean")))
print("  限频原因位:", d.get("reason_hist"))
for r in d.get("requests",[]):
    if isinstance(r,dict) and "decode_tps_sum" in r:
        print("   轮%s wall=%ss prompt=%s decode合计=%s tok/s" % (r["round"], r["wall_s"], r["total_prompt_tokens"], r["decode_tps_sum"]))
PY
done

echo "### 收尾：恢复到 +${OFF}（保持用户要求的偏移）"
for i in 0 1; do SUDO timeout 30 "$NV" "$OFF" 0 "$i" >/dev/null 2>&1; done
for i in 0 1; do echo "  GPU$i 回读: $(read_off "$i")"; done
timeout 8 nvidia-smi --query-gpu=index,clocks.sm,power.limit --format=csv,noheader
