#!/bin/bash
# vLLM 控制台 · SPD/LM78 只读探测：安装/更新 + 免密自测（幂等，可反复执行）
#
# 用法（在你自己的终端，会让你输一次 ll 的 sudo 密码）：
#   ssh -t ll@192.168.1.127 "sudo bash /tmp/install-hwmon-acl-127.sh"
#
# 为什么改了探测脚本还要再跑这条：sudoers 白名单锁的是固定路径
# /usr/local/sbin/vll-hwmon-probe.py（root:root 0755，ll 改不动），脚本内容
# 更新必须由 root 覆盖安装。装完后 ll 侧的
#   sudo -n /usr/local/sbin/vll-hwmon-probe.py
# 就一直免密可用，后续排查不必再要密码。
#
# 授权范围刻意收得很窄：只允许跑固定路径的只读探测脚本，以及带死参数的
# i2cdetect 只读扫描（地址锁在 SPD 段与 LM78 段）。不给通用 sudo、不给写权限。
#
# 撤销：sudo rm -f /etc/sudoers.d/ll-hwmon
set -euo pipefail

PROBE_SRC=/tmp/vll-hwmon-probe.py
PROBE_DST=/usr/local/sbin/vll-hwmon-probe.py
SUDOERS_TMP=/tmp/ll-hwmon.sudoers
SUDOERS_DST=/etc/sudoers.d/ll-hwmon
SELFTEST=/tmp/hwmon-probe-selftest.json

[ "$(id -u)" = "0" ] || { echo "必须用 root 跑：sudo bash $0"; exit 1; }
[ -f "$PROBE_SRC" ] || { echo "缺少 $PROBE_SRC，请先 scp 上传"; exit 1; }

python3 -m py_compile "$PROBE_SRC" || { echo "探测脚本语法校验失败，中止"; exit 1; }
install -o root -g root -m 0755 "$PROBE_SRC" "$PROBE_DST"
echo "[1/3] 探测脚本已安装：$PROBE_DST"

if [ ! -f "$SUDOERS_DST" ]; then
    cat > "$SUDOERS_TMP" <<'EOS'
# vLLM 控制台硬件监视 · SPD/LM78 只读探测（可逆：删除本文件即撤销）
ll ALL=(root) NOPASSWD: /usr/sbin/modprobe i2c-dev
ll ALL=(root) NOPASSWD: /usr/sbin/modprobe eeprom
ll ALL=(root) NOPASSWD: /usr/sbin/modprobe lm78
ll ALL=(root) NOPASSWD: /usr/sbin/i2cdetect -r -y 0 0x28 0x2f
ll ALL=(root) NOPASSWD: /usr/sbin/i2cdetect -r -y 0 0x50 0x57
ll ALL=(root) NOPASSWD: /usr/local/sbin/vll-hwmon-probe.py
EOS
    visudo -cf "$SUDOERS_TMP" || { echo "sudoers 语法校验失败，未安装"; exit 1; }
    install -o root -g root -m 0440 "$SUDOERS_TMP" "$SUDOERS_DST"
    echo "[2/3] sudoers 白名单已安装：$SUDOERS_DST"
else
    echo "[2/3] sudoers 白名单已存在，保持不变：$SUDOERS_DST"
fi

# 以 ll 身份走 sudo（与将来 server.js 的调用方式完全一致）
if sudo -u ll -n /usr/bin/sudo -n "$PROBE_DST" > "$SELFTEST" 2>/tmp/hwmon-probe-selftest.err; then
    echo "[3/3] 自测完成，完整 JSON 已存 $SELFTEST"
    python3 - "$SELFTEST" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
spd = d.get('spd') or {}
print('  i2c 适配器   :', ', '.join('%s=%s' % (a['adapter'], a['name'])
                                    for a in spd.get('adapters') or []))
print('  SPD 四模式   :', json.dumps(spd.get('scan_modes'), ensure_ascii=False))
print('  SPD 命中地址 :', spd.get('addresses') or '（无）')
for s in spd.get('devices') or []:
    vi = s.get('voltage_interpretation') or {}
    print('   ', s.get('address'), s.get('device_type_guess'),
          'byte6=' + str(s.get('voltage_byte6')),
          '| spd_tool:', '/'.join(vi.get('spd_tool') or []),
          '| decode-dimms:', '/'.join(vi.get('decode-dimms') or []),
          '| PN:', s.get('module_part_number') or '-')
lm = d.get('lm78') or {}
print('  LM78         :', 'found=' + str(lm.get('found')), lm.get('note') or 'present')
if d.get('errors'):
    print('  errors       :', json.dumps(d['errors'][:6], ensure_ascii=False))
PY
else
    echo "[3/3] 自测未通过（授权已生效），错误见 /tmp/hwmon-probe-selftest.err"
    tail -5 /tmp/hwmon-probe-selftest.err 2>/dev/null || true
fi

echo
echo "完成。撤销：sudo rm -f $SUDOERS_DST"
