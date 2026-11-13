#!/usr/bin/env python3
# [gpu-ecc-1108] 把「GPU ECC 状态与报错」后端模块重放进 server.js（幂等 + 备份 + node --check）。
# 用法：python3 patches/patch-gpu-ecc-1108.py [server.js 路径] [--check]
#   --check 只预演不落盘。模块正文 = 同目录 gpu-ecc-module-1108.js（唯一真源，改逻辑改它）。
# 三处接入：① 模块插在 gpu-uptime 模块之后（与 GPU 系模块同区）；② 注册 /v1/internal/gpu-ecc 路由；
# ③ /v1/internal/gpu 附带 eccBriefByIndex() 角标（同步查 30s 缓存，零 IO 零子进程——该表 1s 轮询）。
import sys, os, shutil, subprocess
tgt = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'server.js'
dry = '--check' in sys.argv
HERE = os.path.dirname(os.path.abspath(__file__))
mod = open(os.path.join(HERE, 'gpu-ecc-module-1108.js'), encoding='utf8').read().rstrip() + '\n'
s = open(tgt, encoding='utf8').read()
if '[gpu-ecc-1108]' in s:
    print('已是目标状态（幂等退出）'); sys.exit(0)
R = []
def sub(old, new, name):
    global s
    n = s.count(old)
    if n != 1:
        print('锚点异常 %s：命中 %d 次' % (name, n)); sys.exit(1)
    s = s.replace(old, new, 1); R.append(name)
sub('// ==== [gpu-uptime 1029] END module ====\n',
    '// ==== [gpu-uptime 1029] END module ====\n\n' + mod + '\n', '模块插入')
sub("  // === GPU 累计通电时间 API（[gpu-uptime 1029]：GET 只读，wtmp∪journal 开机区间可追溯口径）===",
    "  // === GPU ECC 状态与报错 API（[gpu-ecc-1108]：GET 状态+记录 / POST cmd {action:save|clear|rebase|rescan}）===\n"
    "  if (pathname === '/v1/internal/gpu-ecc' || pathname.startsWith('/v1/internal/gpu-ecc/')) {\n"
    "    return Promise.resolve(eccHandle(req, res, urlObj)).catch((e) => {\n"
    "      try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); } catch (e2) {}\n"
    "    });\n"
    "  }\n\n"
    "  // === GPU 累计通电时间 API（[gpu-uptime 1029]：GET 只读，wtmp∪journal 开机区间可追溯口径）===", '路由注册')
sub("    const pcieBy = (global.__gpuPcie && global.__gpuPcie.byIndex) || {};\n    const gpus = (st.gpus || []).map((s) => {",
    "    const pcieBy = (global.__gpuPcie && global.__gpuPcie.byIndex) || {};\n    const eccBy = eccBriefByIndex();  // [gpu-ecc-1108]\n    const gpus = (st.gpus || []).map((s) => {", 'gpu 帧 ECC 角标（取数）')
sub("      const g = Object.assign({}, s, liveMap[s.index] || {});",
    "      const g = Object.assign({}, s, liveMap[s.index] || {});\n      // [gpu-ecc-1108] ECC 角标（同步查 30s 档缓存，零 IO 零子进程——本表是 1s 轮询）\n      const eccBrief = eccBy[s.index];\n      if (eccBrief) g.ecc = eccBrief;", 'gpu 帧 ECC 角标（写入）')
if dry:
    print('--check 通过：将改动 ' + ' / '.join(R)); sys.exit(0)
bak = tgt + '.bak-gpu-ecc-1108'
shutil.copy2(tgt, bak)
open(tgt, 'w', encoding='utf8').write(s)
r = subprocess.run(['node', '--check', tgt])
if r.returncode:
    shutil.copy2(bak, tgt); print('node --check 失败，已回滚'); sys.exit(1)
print('已应用：' + ' / '.join(R) + '（备份 ' + os.path.basename(bak) + '）')
