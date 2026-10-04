#!/bin/bash
# vLLM 控制台 · GPU 控制（gpu-ctl）安装/更新 + 免密自测（幂等，可反复执行）
#
# 用法（在你自己的终端）：
#   scp gpu-ctl ops/install-gpu-ctl-127.sh ll@192.168.1.126:/tmp/
#   ssh -t ll@<控制台机IP> "sudo bash /tmp/install-gpu-ctl-127.sh"   # -t 分配 TTY，现场输口令
#   （口令不写进仓库、也不留在 shell 历史里；控制台机是 DHCP 地址，换了就用当时实际的 IP）
#
# 做什么：
#   [1] /tmp/gpu-ctl → /usr/local/bin/gpu-ctl（root:root 0755，ll 改不动 = 白名单可信）
#   [2] /etc/sudoers.d/ll-gpu-ctl：只放行固定路径的 gpu-ctl（visudo -cf 校验后才装）
#   [3] 以 ll 身份走 sudo 自测 status --json（与 server.js 的调用方式完全一致）
#
# 授权范围刻意收得很窄：只允许免密跑 /usr/local/bin/gpu-ctl 这一个 root:root 脚本，
# 不给通用 sudo、不给 nvidia-smi 裸命令。脚本内部再调 nvidia-smi 时已是 root，
# 能力边界=脚本自身的参数白名单（功耗 50-500W / 频率 100-4000MHz / 卡号 0-7|all）。
#
# 撤销：sudo rm -f /etc/sudoers.d/ll-gpu-ctl && sudo rm -f /usr/local/bin/gpu-ctl
set -euo pipefail

SRC=/tmp/gpu-ctl
DST=/usr/local/bin/gpu-ctl
SUDOERS_TMP=/tmp/ll-gpu-ctl.sudoers
SUDOERS_DST=/etc/sudoers.d/ll-gpu-ctl

[ "$(id -u)" = "0" ] || { echo "必须用 root 跑：sudo bash $0"; exit 1; }
[ -f "$SRC" ] || { echo "缺少 $SRC，请先 scp 上传 gpu-ctl"; exit 1; }

bash -n "$SRC" || { echo "gpu-ctl 语法校验失败，中止"; exit 1; }
install -o root -g root -m 0755 "$SRC" "$DST"
echo "[1/3] gpu-ctl 已安装：$DST"

cat > "$SUDOERS_TMP" <<'EOS'
# vLLM 控制台 GPU 控制 · 只放行固定路径的 gpu-ctl（可逆：删除本文件即撤销）
ll ALL=(root) NOPASSWD: /usr/local/bin/gpu-ctl, /usr/local/bin/gpu-ctl *
EOS
if visudo -cf "$SUDOERS_TMP" >/dev/null; then
    install -o root -g root -m 0440 "$SUDOERS_TMP" "$SUDOERS_DST"
    echo "[2/3] sudoers 白名单已安装：$SUDOERS_DST"
else
    echo "[2/3] sudoers 语法校验失败，未安装"
    exit 1
fi

if sudo -u ll -n /usr/bin/sudo -n "$DST" status --json 2>/tmp/gpu-ctl-selftest.err | python3 -c 'import json,sys; d=json.load(sys.stdin); gs=d["gpus"]; print("[3/3] 自测通过：", len(gs), "卡 |", "; ".join("GPU%d %.0f/%.0fW SM %dMHz" % (g["index"], g["power_draw"], g["power_limit"], g["sm_clock"] or 0) for g in gs))'; then
    :
else
    echo "[3/3] 自测失败："; cat /tmp/gpu-ctl-selftest.err; exit 1
fi
