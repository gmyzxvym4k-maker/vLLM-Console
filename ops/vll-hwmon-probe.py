#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
vLLM 控制台 · 硬件电压只读探测器（192.168.1.127）

背景
  SMBIOS type 17 的三个电压字段在本机 BIOS 全部填 Unknown，硬件监视页的
  「电压」列因此只能显示 --。本脚本从两条底层通路补数据：
    ① SPD EEPROM（挂在 i801 SMBus，内核 dmesg 已确认 5/24 槽位有条）
       —— 读内存条出厂烧录的额定电压（JEDEC 21-C Annex K）。
    ② LM78/LM79 监控芯片（SMBIOS type 26 的 Voltage Probe 声称存在）
       —— 若芯片真实存在，可提供实时电压（含 VDD/DIMM 通道）。

安全约束（务必遵守）
  - 全程只读：只 modprobe、new_device 实例化驱动、读 sysfs。
    绝不向 EEPROM 写任何字节，绝不改内存时序/电压/SPD 内容。
  - SMBus 扫描固定用 `-r`（SMBus Read Byte 协议），并把地址范围锁死在
    SPD 段 0x50-0x57 与 LM78 段 0x28-0x2f，避免打扰总线上其它器件。
  - 幂等：驱动/设备已实例化就直接复用，不重复创建、不删除他人设备。
  - 永不抛异常到进程外：所有失败进 JSON 的 errors 数组。

输出：单个 JSON 对象到 stdout，供 server.js 直接 JSON.parse。
"""

import json
import os
import subprocess
import sys

I2C_BUS = 0
SPD_RANGE = (0x50, 0x57)        # DDR2/3/4 SPD EEPROM 地址池
LM78_RANGE = (0x28, 0x2f)       # LM78/LM79 常规地址 0x2d
LM78_ADDR = 0x2d
SPD_BYTES = 256
TIMEOUT = 6

errors = []


def run(argv, timeout=TIMEOUT):
    """执行外部命令，返回 (rc, stdout, stderr)；超时/不存在都不抛。"""
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout or '', p.stderr or ''
    except subprocess.TimeoutExpired:
        errors.append({'step': ' '.join(argv), 'error': 'timeout %ss' % timeout})
        return 124, '', 'timeout'
    except Exception as e:                                   # noqa: BLE001
        errors.append({'step': ' '.join(argv), 'error': repr(e)})
        return 1, '', repr(e)


def modprobe(mod):
    rc, _, err = run(['/usr/sbin/modprobe', mod])
    if rc != 0:
        errors.append({'step': 'modprobe ' + mod, 'error': (err or '').strip()[:200]})
    return rc == 0


def smbus_scan(lo, hi, mode='q'):
    """扫描 SMBus，返回 [(addr, kind)]，kind='free'|'busy'。

    mode 选择探测协议，这直接决定能不能扫到东西：
      'q' 默认 SMBus Quick Command —— 对纯 I2C 的 SPD EEPROM（24Cxx）有效
      'r' SMBus Read Byte        —— 对 SPD 这类纯 I2C 器件本就不该应答
      's' SMBus Send Byte        —— 同上，仅作交叉印证
      'a' I2C 原生 Read Byte     —— 需适配器支持
    UU 表示地址被内核驱动占用，同样是"有器件"，不能当没有。
    """
    argv = ['/usr/sbin/i2cdetect', '-y', str(I2C_BUS), '0x%02x' % lo, '0x%02x' % hi]
    if mode in ('r', 's', 'a'):
        argv.insert(2, '-' + mode)
    rc, out, err = run(argv)
    found = []
    for line in out.splitlines():
        cols = line.split()
        if not cols or not cols[0].endswith(':'):
            continue
        try:
            base = int(cols[0][:-1], 16)          # 去掉行首的冒号再解析
        except ValueError:
            continue
        for i, cell in enumerate(cols[1:]):
            addr = base + i
            if addr < lo or addr > hi:
                continue                          # 只认请求范围内的地址
            if cell == 'UU':
                found.append((addr, 'busy'))
            elif cell and '--' not in cell:
                found.append((addr, 'free'))
    return sorted(found)


def i2c_dev_dir(addr):
    return '/sys/bus/i2c/devices/i2c-%d-%04x' % (I2C_BUS, addr)


def instantiate(driver, addr):
    """实例化 i2c 客户端驱动；已存在视为成功。返回是否为本次新建。"""
    d = i2c_dev_dir(addr)
    if os.path.isdir(d):
        return False
    rc, _, err = run(['/bin/sh', '-c',
                      'echo "%s 0x%02x" > /sys/bus/i2c/devices/i2c-%d/new_device'
                      % (driver, addr, I2C_BUS)])
    if rc != 0:
        errors.append({'step': 'new_device %s@0x%02x' % (driver, addr),
                       'error': (err or '').strip()[:200]})
    return rc == 0


def read_bin(path, n):
    try:
        with open(path, 'rb') as f:
            return f.read(n)
    except Exception as e:                                  # noqa: BLE001
        errors.append({'step': 'read ' + path, 'error': repr(e)})
        return b''


# ---------------------------------------------------------------- SPD 解码
# JEDEC 21-C Annex K（DDR3 SPD）：byte 2 = Key Byte/DRAM Device Type，
# byte 6 = Module Nominal Voltage, VDD，byte 7 = Module Organization，
# byte 8 = Module Memory Bus Width，byte 128 起为扩展块（含料号）。
#
# 【byte 6 的位义在两份权威开源实现里互相矛盾】
#   i2c-tools decode-dimms: 基准 1.5 V，bit0=1.5 V tolerant，bit1=1.35 V，bit2=1.2X V
#   spd_tool               : bit0==0 才支持 1.5 V，bit1=1.35 V，bit2=1.25 V
# 因此这里两种解释都给出，并保留原始字节，由实测（已知型号的条子）反推后固化。
DEVICE_TYPE_BY_BYTE2 = {
    0x01: 'DDR', 0x02: 'DDR2', 0x03: 'DDR3', 0x0C: 'DDR4', 0x12: 'DDR2 FB-DIMM',
}


def volt_from_byte6_ddr3(b6):
    dec = {'decode-dimms': ['1.50 V']}
    if b6 & 0b001:
        dec['decode-dimms'].append('1.5 V tolerant')
    if b6 & 0b010:
        dec['decode-dimms'].append('1.35 V')
    if b6 & 0b100:
        dec['decode-dimms'].append('1.2x V')

    alt = []
    if (b6 & 0b001) == 0:
        alt.append('1.50 V')
    if b6 & 0b010:
        alt.append('1.35 V')
    if b6 & 0b100:
        alt.append('1.25 V')
    dec['spd_tool'] = alt or ['(未定义组合)']
    return dec


def ascii_field(b, lo, hi):
    try:
        return ''.join(chr(c) if 32 <= c <= 126 else ' ' for c in b[lo:hi + 1]).strip()
    except Exception:                                       # noqa: BLE001
        return ''


def decode_spd(addr, raw):
    out = {
        'bus': I2C_BUS, 'address': '0x%02x' % addr,
        'bytes_read': len(raw),
        'raw_first_16': ' '.join('%02x' % c for c in raw[:16]),
    }
    if len(raw) < 128:
        out['decoded'] = False
        out['note'] = 'SPD 读取不足 128 字节，无法解码'
        return out
    b2, b6 = raw[2], raw[6]
    out['decoded'] = True
    out['device_type_byte2'] = '0x%02x' % b2
    out['device_type_guess'] = DEVICE_TYPE_BY_BYTE2.get(b2, 'unknown')
    out['voltage_byte6'] = '0x%02x' % b6
    out['voltage_interpretation'] = volt_from_byte6_ddr3(b6)
    out['organization_byte7'] = '0x%02x' % raw[7]
    out['bus_width_byte8'] = '0x%02x' % raw[8]
    out['module_part_number'] = ascii_field(raw, 128, 145)
    out['serial'] = ' '.join('%02x' % c for c in raw[122:126])
    out['mfg_jep106_raw'] = ' '.join('%02x' % c for c in raw[117:119])
    return out


# 扫描协议：SPD EEPROM 是纯 I2C 器件（2 字节地址），只有默认 Quick Command 模式
# 才会应答；-r/-s 属 SMBus 命令协议，对 24Cxx 本就不应答。所以"扫不到"必须先
# 排除协议选错，四模式全扫一遍才有资格下结论。
SCAN_MODES = ('q', 'r', 's', 'a')


def scan_all_modes(lo, hi):
    """同一地址段逐协议扫描，返回 (合并 {addr: kind}, {mode: 明细})。"""
    hits, per_mode = {}, {}
    for m in SCAN_MODES:
        got = smbus_scan(lo, hi, m)
        per_mode[m] = ['0x%02x:%s' % (a, k) for a, k in got]
        for a, k in got:
            hits.setdefault(a, k)
    return hits, per_mode


def bus_inventory():
    """列出全部 i2c 适配器，用来判断 SPD 可能挂在哪条总线（i801 是否有 MUX 分身）。"""
    out = []
    try:
        for name in sorted(os.listdir('/sys/bus/i2c/devices')):
            p = '/sys/bus/i2c/devices/%s/name' % name
            if name.startswith('i2c-') and os.path.exists(p):
                try:
                    with open(p) as f:
                        out.append({'adapter': name, 'name': f.read().strip()})
                except Exception as e:                          # noqa: BLE001
                    out.append({'adapter': name, 'name': 'ERR ' + repr(e)})
    except Exception as e:                                      # noqa: BLE001
        errors.append({'step': 'bus inventory', 'error': repr(e)})
    return out


def probe_spd():
    res = {'adapters': bus_inventory(), 'scan_modes': None,
           'addresses': [], 'devices': []}
    if not modprobe('i2c-dev'):
        return res
    if not modprobe('eeprom'):
        modprobe('at24')
    hits, per_mode = scan_all_modes(SPD_RANGE[0], SPD_RANGE[1])
    res['scan_modes'] = per_mode
    res['addresses'] = ['0x%02x' % a for a in sorted(hits)]
    for addr in sorted(hits):
        instantiate('eeprom', addr)
        d = i2c_dev_dir(addr)
        raw = read_bin(os.path.join(d, 'eeprom'), SPD_BYTES)
        if not raw:
            raw = read_bin(os.path.join(d, 'spd'), SPD_BYTES)   # at24 命名差异
        if raw:
            res['devices'].append(decode_spd(addr, raw))
        else:
            res['devices'].append({'bus': I2C_BUS, 'address': '0x%02x' % addr,
                                   'decoded': False, 'note': '实例化成功但读不到内容'})
    return res


# --------------------------------------------------------------- LM78 探测
def probe_lm78():
    res = {'scanned_range': '0x%02x-0x%02x' % LM78_RANGE,
           'scan_modes': None, 'found': [], 'present': False, 'hwmon': None}
    if not modprobe('i2c-dev'):
        return res
    hits, per_mode = scan_all_modes(LM78_RANGE[0], LM78_RANGE[1])
    res['scan_modes'] = per_mode
    res['found'] = ['0x%02x' % a for a in sorted(hits)]
    if LM78_ADDR not in hits:
        res['note'] = '四种协议（q/r/s/a）均无应答：SMBIOS 的 LM78A/LM78B 探针表确认为 BIOS 占位'
        return res
    res['present'] = True
    modprobe('lm78')
    instantiate('lm78', LM78_ADDR)
    base = os.path.join(i2c_dev_dir(LM78_ADDR), 'hwmon')
    if not os.path.isdir(base):
        res['note'] = '芯片有应答但 lm78 驱动未注册 hwmon'
        return res
    for hw in sorted(os.listdir(base)):
        hd = os.path.join(base, hw)
        ch = {}
        for fn in sorted(os.listdir(hd)):
            if fn.endswith('_input') or fn.endswith('_label'):
                try:
                    with open(os.path.join(hd, fn)) as f:
                        ch[fn] = f.read().strip()
                except Exception:                           # noqa: BLE001
                    pass
        res['hwmon'] = {'name': hw, 'channels': ch}
    return res


def main():
    purge = '--purge' in sys.argv
    full = '--full' in sys.argv
    result = {'ok': True, 'sources': {
        'spd': 'JEDEC 21-C Annex K byte 6（条子出厂烧录的额定电压，非实时值）',
        'lm78': 'LM78 hwmon in*_input（若芯片存在则为实时值）',
    }}
    spd = probe_spd()
    result['spd'] = spd
    result['lm78'] = probe_lm78()
    if full:
        hits, per_mode = scan_all_modes(0x03, 0x77)
        result['full_bus'] = {
            'bus': I2C_BUS,
            'addresses': ['0x%02x:%s' % (a, k) for a, k in sorted(hits.items())],
            'per_mode': per_mode,
        }
    if purge:
        for a in range(SPD_RANGE[0], SPD_RANGE[1] + 1):
            run(['/bin/sh', '-c',
                 'echo 0x%02x > /sys/bus/i2c/devices/i2c-%d/delete_device 2>/dev/null'
                 % (a, I2C_BUS)])
    result['errors'] = errors
    result['ok'] = bool(spd['devices']) or result['lm78']['present']
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
