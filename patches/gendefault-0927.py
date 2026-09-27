#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
[gendefault 0927] Flash-Next 两套栈 inner 脚本的启动缺省改档（用户定档）：

1) GENCFG_DEFAULT（采样缺省，可被 FN_GENCFG 覆盖）
   {"temperature":0.6,...,"presence_penalty":0.1,"repetition_penalty":1.05}
   → {"temperature":1.0,"top_p":0.95,"top_k":20,"min_p":0.0,"presence_penalty":0.0,"repetition_penalty":1.0}
   与 server.js SCRIPT_MODELS['qwen3.8-flash-next-w4a16'].base 逐字段一致（base 同时是
   「弹窗默认值」与「是否下发 FN_GENCFG 的比较基准」，两处不一致就会出现弹窗显示 ≠ 引擎真值）。

2) 旧栈（chroot）inner 消费 FN_CHATKWARGS
   此前 --default-chat-template-kwargs 写死 '{"enable_thinking":true,"preserve_thinking":true}'，
   弹窗「思考深度」下发的 FN_CHATKWARGS 无人读 → 静默失效（09-26 三跳铁律的最后一个未补键）。
   改为 "${FN_CHATKWARGS:-$CHATKW_DEFAULT}"，与官方 0.30.0 新栈 inner 同写法。
   无 FN_CHATKWARGS 时行为与旧版逐字一致。

用法：python3 gendefault-0927.py            # 就地改（首次自动备份 *.bak-gendefault-0927）
      python3 gendefault-0927.py --check    # 只检查不改
幂等：已是目标值则跳过。改完自行 bash -n 校验。
"""
import os
import re
import shutil
import sys

GENCFG_NEW = '{"temperature":1.0,"top_p":0.95,"top_k":20,"min_p":0.0,"presence_penalty":0.0,"repetition_penalty":1.0}'
CHATKW_DEFAULT = '{"enable_thinking":true,"preserve_thinking":true}'
NOTE = ('# [gendefault 0927] 采样缺省定档 t1.0/p0.95/k20/minp0/pp0/rp1.0'
        '（与 server.js SCRIPT_MODELS.base 逐字段一致）\n')

OLD_INNER = '/home/ll/deploy/flash-next-w4a16-inner.sh'
NEW_INNER = '/home/ll/deploy/vllm-0300/bin/flash-next-0300-inner.sh'
FILES = [OLD_INNER, NEW_INNER]

RE_GEN = re.compile(r"(GENCFG_DEFAULT=')(\{[^'\n]*\})(')")
RE_HARD_KWARGS = re.compile(r"--default-chat-template-kwargs '\{[^'\n]*\}'")

check_only = '--check' in sys.argv
rc = 0


def write_atomic(path, text, mode):
    if check_only:
        return
    bak = path + '.bak-gendefault-0927'
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
        print('  -> 备份: %s' % bak)
    tmp = path + '.tmp-gendefault'
    with open(tmp, 'w', encoding='utf-8') as fh:
        fh.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


for path in FILES:
    if not os.path.isfile(path):
        print('[skip] 不存在: %s' % path)
        rc = 1
        continue
    mode = os.stat(path).st_mode & 0o7777
    src = open(path, encoding='utf-8').read()
    changed = False
    print(path)

    # ---- 1) GENCFG_DEFAULT ----
    m = RE_GEN.search(src)
    if not m:
        print('  [FAIL] 未找到 GENCFG_DEFAULT 行')
        rc = 1
    else:
        print('  GENCFG 现值: %s' % m.group(2))
        print('  GENCFG 目标: %s' % GENCFG_NEW)
        if m.group(2) != GENCFG_NEW:
            def _sub(mm):
                note = '' if 'gendefault 0927' in src else NOTE
                return note + mm.group(1) + GENCFG_NEW + mm.group(3)
            src = RE_GEN.sub(_sub, src, count=1)
            changed = True
            print('  -> GENCFG 已改')
        else:
            print('  -> GENCFG 已是目标值')

    # ---- 2) 旧栈 inner 消费 FN_CHATKWARGS ----
    if RE_HARD_KWARGS.search(src):
        print('  CHATKW: 发现写死的 --default-chat-template-kwargs')
        if check_only:
            print('  -> 待改为 ${FN_CHATKWARGS:-$CHATKW_DEFAULT}（--check 模式不动文件）')
            rc = 1
        # CHATKW_DEFAULT 定义紧跟 GENCFG_DEFAULT 行之后
        if 'CHATKW_DEFAULT=' not in src:
            src = RE_GEN.sub(lambda mm: mm.group(0) + "\nCHATKW_DEFAULT='%s'" % CHATKW_DEFAULT, src, count=1)
        src = RE_HARD_KWARGS.sub('--default-chat-template-kwargs "${FN_CHATKWARGS:-$CHATKW_DEFAULT}"', src, count=1)
        changed = True
        print('  -> CHATKW 已接 FN_CHATKWARGS')
    elif 'FN_CHATKWARGS:-$CHATKW_DEFAULT' in src:
        print('  CHATKW: 已消费 FN_CHATKWARGS，无需改动')
    else:
        print('  [WARN] CHATKW 形态未识别（既非写死也非已接 FN_CHATKWARGS），请人工确认')
        rc = 1

    if changed:
        write_atomic(path, src, mode)

print('OK' if rc == 0 else 'DONE_WITH_ISSUES rc=%d' % rc)
sys.exit(rc)
