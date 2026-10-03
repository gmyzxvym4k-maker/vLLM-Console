#!/bin/bash
# 提权口令走 lib/sudo-pass.sh（CONSOLE_SUDO_PASS 或 ~/.console-sudo），仓库内不留明文
# 提权口令来源（仓库内不留明文）：CONSOLE_SUDO_PASS 环境变量 → ~/.console-sudo（600）→ 交互输入。
# helper 查找顺序：DEPLOY_DIR → 脚本所在目录 → 上级目录，兼容仓库开发与单文件 scp 上线两种摆放。
CDIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
for _csudo_lib in "${DEPLOY_DIR:-/home/ll/deploy}/lib/sudo-pass.sh" ${CDIR:+$CDIR/lib/sudo-pass.sh} ${CDIR:+$CDIR/../lib/sudo-pass.sh}; do
  [ -n "$_csudo_lib" ] && [ -f "$_csudo_lib" ] && { . "$_csudo_lib"; break; }
done
if [ -z "${CSUDO_PW+isset}" ]; then CSUDO_PW=""; require_sudo_pass || exit 1; fi
echo "=== 上电后状态 ==="; uptime; echo "boot_id=$(cat /proc/sys/kernel/random/boot_id)"
echo "=== 上次是否为干净关机 ==="; journalctl --list-boots 2>/dev/null | tail -2
sudo_run journalctl -b -1 -n 3 --no-pager 2>/dev/null | cut -c1-110
echo "=== 本 boot MCE 计数 / nvme 错误 ==="
echo -n "  MCE="; sudo_run dmesg 2>/dev/null | grep -c "mce: \[Hardware Error\]"
sudo_run dmesg 2>/dev/null | grep -iE "nvme|I/O error" | tail -4 | cut -c1-120
echo "=== 读速: 单流 512MiB ==="
sudo_run timeout 25 dd if=/dev/nvme0n1 of=/dev/null bs=1M count=512 skip=2048 iflag=direct 2>&1 | tail -1 | sed 's/^/  /'
echo "=== 读速: 16 路并发 (QD16) ==="
sudo_run sh -c 'S=$(date +%s.%N); for i in $(seq 0 15); do (dd if=/dev/nvme0n1 of=/dev/null bs=1M count=128 skip=$((200000+i*5000)) iflag=direct 2>/dev/null) & done; wait; E=$(date +%s.%N); echo "  2048MiB $(echo "$E-$S"|bc)s => $(echo "scale=0;2048/($E-$S)"|bc) MiB/s"'
echo "=== 写速: 256MiB ==="
sudo_run sh -c 'dd if=/dev/zero of=/media/ll/data/.spd.tmp bs=1M count=256 oflag=direct 2>&1|tail -1; rm -f /media/ll/data/.spd.tmp' | sed 's/^/  /'
echo "=== 链路/挂载/GPU ==="
echo "  nvme0 $(cat /sys/class/nvme/nvme0/device/current_link_speed) x$(cat /sys/class/nvme/nvme0/device/current_link_width)"
findmnt -no SOURCE,TARGET,OPTIONS /media/ll/data | sed 's/^/  /'
nvidia-smi --query-gpu=index,memory.total,pcie.link.gen.current --format=csv,noheader | sed 's/^/  /'
echo "=== RA ==="; for d in /sys/block/nvme*n1; do echo "  $(basename $d)=$(cat $d/queue/read_ahead_kb)"; done
