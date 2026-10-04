#!/bin/bash
# vLLM 控制台 · CPU 控制（cpu-ctl）安装/更新 + 免密自测（幂等，可反复执行）
#
# 用法（在你自己的终端）：
#   scp cpu-ctl ops/install-cpu-ctl-127.sh ll@192.168.1.126:/tmp/
#   ssh -t ll@<控制台机IP> "sudo bash /tmp/install-cpu-ctl-127.sh"   # -t 分配 TTY，现场输口令
#   （口令不写进仓库、也不留在 shell 历史里；控制台机是 DHCP 地址，换了就用当时实际的 IP）
#
# 做什么：
#   [1] /tmp/cpu-ctl → /usr/local/bin/cpu-ctl（root:root 0755，ll 改不动 = 白名单可信）
#   [2] /etc/sudoers.d/ll-cpu-ctl：只放行固定路径的 cpu-ctl（visudo -cf 校验后才装）
#   [3] 以 ll 身份走 sudo 自测 status --json（与 server.js 的调用方式完全一致）
#
# 授权范围刻意收得很窄：只允许免密跑 /usr/local/bin/cpu-ctl 这一个 root:root 脚本，
# 不给通用 sudo、不给其它命令。脚本内部再写 sysfs 时已是 root，能力边界=脚本自身。
#
# 撤销：sudo rm -f /etc/sudoers.d/ll-cpu-ctl && sudo rm -f /usr/local/bin/cpu-ctl
set -euo pipefail

SRC=/tmp/cpu-ctl
DST=/usr/local/bin/cpu-ctl
SUDOERS_TMP=/tmp/ll-cpu-ctl.sudoers
SUDOERS_DST=/etc/sudoers.d/ll-cpu-ctl

[ "$(id -u)" = "0" ] || { echo "必须用 root 跑：sudo bash $0"; exit 1; }
[ -f "$SRC" ] || { echo "缺少 $SRC，请先 scp 上传 cpu-ctl"; exit 1; }

bash -n "$SRC" || { echo "cpu-ctl 语法校验失败，中止"; exit 1; }
install -o root -g root -m 0755 "$SRC" "$DST"
echo "[1/3] cpu-ctl 已安装：$DST"

cat > "$SUDOERS_TMP" <<'EOS'
# vLLM 控制台 CPU 控制 · 只放行固定路径的 cpu-ctl（可逆：删除本文件即撤销）
ll ALL=(root) NOPASSWD: /usr/local/bin/cpu-ctl, /usr/local/bin/cpu-ctl *
EOS
if visudo -cf "$SUDOERS_TMP" >/dev/null; then
    install -o root -g root -m 0440 "$SUDOERS_TMP" "$SUDOERS_DST"
    echo "[2/3] sudoers 白名单已安装：$SUDOERS_DST"
else
    echo "[2/3] sudoers 语法校验失败，未安装"
    exit 1
fi

if sudo -u ll -n /usr/bin/sudo -n "$DST" status --json 2>/tmp/cpu-ctl-selftest.err | python3 -c 'import json,sys; d=json.load(sys.stdin); print("[3/3] 自测通过：", d["model"], "| 在线", d["onlineCount"], "/", len(d["present"]), "核 | smt:", d["smtControl"])'; then
    :
else
    echo "[3/3] 自测失败："; cat /tmp/cpu-ctl-selftest.err; exit 1
fi
