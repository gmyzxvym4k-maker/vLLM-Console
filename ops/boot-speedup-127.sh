#!/bin/bash
# 192.168.1.127 开机提速脚本（2026-09-20）
# 用法：在 127 上以 root 运行  →  sudo bash /tmp/boot-speedup-127.sh
# 目标：消除开机等待项。预计 userspace 12.8s→~5s，loader 14.6s→~4s。
# 全部改动可逆（脚本末尾附回滚说明）。
set -u

echo "===== 优化前 ====="
systemd-analyze | tail -1

# ---------------------------------------------------------------
# 1) GRUB：跳过 10 秒菜单等待；异常关机后 recordfail 只等 3 秒
#    （该机 GPU 故障易非正常关机，recordfail 缺省会进菜单等 30 秒，
#      这就是"开机卡住等待"的最大来源）
#    改后想进菜单：开机狂按 Esc/Shift 仍可。
# ---------------------------------------------------------------
cp -a /etc/default/grub /etc/default/grub.bak-boot-speedup-0920
sed -i 's/^GRUB_TIMEOUT_STYLE=.*/GRUB_TIMEOUT_STYLE=hidden/' /etc/default/grub
sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=0/' /etc/default/grub
grep -q '^GRUB_RECORDFAIL_TIMEOUT=' /etc/default/grub || echo 'GRUB_RECORDFAIL_TIMEOUT=3' >> /etc/default/grub
update-grub
echo "[1] GRUB 已改为 0 秒直通（recordfail 3 秒）"

# ---------------------------------------------------------------
# 2) 取消"等待联网"：NetworkManager-wait-online 耗时 6.6s，
#    且是 docker→multi-user.target 关键路径上唯一的等待。
#    docker 守护进程启动本身不需要网络，禁用无副作用。
# ---------------------------------------------------------------
systemctl disable --now NetworkManager-wait-online.service
echo "[2] NetworkManager-wait-online 已禁用（省 ~6.6s）"

# ---------------------------------------------------------------
# 3) 禁用无用服务（GPU 计算服务器用不到；均可逆）
#    ua-timer：Ubuntu Advantage 遥测定时器（开机耗 2.1s）
#    whoopsie/kerneloops/apport：错误上报
#    ModemManager：拨号调制解调器管理（无拨号设备）
#    cups 全家：打印服务
#    bluetooth：蓝牙（无外设）
#    保留：xrdp/x11vnc（远程桌面）、ssh、docker、snapd（nvtop 是 snap）、
#          gen2/gpu-power-limit（GPU 必需）、ufw、cron
# ---------------------------------------------------------------
for u in ua-timer.timer ua-timer.service whoopsie.service kerneloops.service apport.service ModemManager.service cups.service cups.socket cups.path cups-browsed.service bluetooth.service; do
  systemctl disable --now "$u" 2>/dev/null && echo "    - 已禁用 $u"
done
echo "[3] 无用服务清理完成"

# ---------------------------------------------------------------
# 4) ll 用户级：关文件索引（不省 boot 时间，但省开机后 CPU/IO）
# ---------------------------------------------------------------
LL_UID=$(id -u ll 2>/dev/null || echo 1000)
sudo -u ll XDG_RUNTIME_DIR="/run/user/$LL_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$LL_UID/bus" \
  systemctl --user disable --now tracker-extract-3.service tracker-miner-fs-3.service 2>/dev/null || true
echo "[4] tracker 索引已禁用（用户级）"

echo
echo "===== 完成。重启验证：sudo reboot 后 ssh 上来跑 systemd-analyze ====="
echo "回滚方法："
echo "  cp /etc/default/grub.bak-boot-speedup-0920 /etc/default/grub && update-grub"
echo "  systemctl enable --now NetworkManager-wait-online.service"
echo "  systemctl enable --now <上面列出的任一服务>"
