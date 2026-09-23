#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""c3e：_sliding_window_lookup 逐键结果扫描探针（前8个 + idx24..30）。"""
import argparse, os, shutil, subprocess, sys
ROOT = os.environ.get("KVOFF_ROOT",
    "/media/ll/data/vllm-image/rootfs/usr/local/lib/python3.12/dist-packages/vllm")
F = f"{ROOT}/distributed/kv_transfer/kv_connector/v1/offloading/scheduler.py"
CHROOT = "/media/ll/data/vllm-image/rootfs"
BAK = ".bak-kvoffc3e-0923"
def compile_check(p):
    rel = "/" + p[len(CHROOT)+1:]
    subprocess.run(["chroot", CHROOT, "/usr/bin/python3.12", "-m", "py_compile", rel], check=True)
OLD = '''        defer_lookup = False
        consecutive_hits = 0
        for idx in range(len(keys) - 1, -1, -1):
            match self.manager.lookup(keys[idx], req_context):
'''
NEW = '''        defer_lookup = False
        consecutive_hits = 0
        # [local-patch kvoff-c3e] scan-result probes
        _c3e_n = 0
        _c3e_mid: list = []
        for idx in range(len(keys) - 1, -1, -1):
            _c3e_r = self.manager.lookup(keys[idx], req_context)
            if _c3e_n < 8:
                _c3e_n += 1
                logger.info(
                    "[kvoff-c3e] scan q=%d win=%d idx=%d r=%s key=%s",
                    len(keys), sliding_window_size, idx,
                    str(_c3e_r)[:20], keys[idx][:6].hex(),
                )
            if 24 <= idx <= 30:
                _c3e_mid.append((idx, str(_c3e_r)[:12], keys[idx][:6].hex()))
                if idx == 24:
                    logger.info("[kvoff-c3e] scanmid %s", _c3e_mid)
            match _c3e_r:
'''
HUNKS = [(OLD, NEW)]
def read():
    with open(F, encoding="utf-8") as f: return f.read()
def self_test():
    src = read(); rc = 0
    for i,(old,new) in enumerate(HUNKS,1):
        n_old,n_new = src.count(old), src.count(new)
        if n_new==1 and n_old==0: print(f"[self-test] OK(applied)  #{i}")
        elif n_old==1 and n_new==0: print(f"[self-test] OK(pristine) #{i}")
        else: print(f"[self-test] FAIL #{i} old={n_old} new={n_new}"); rc=1
    return rc
def apply():
    if self_test()!=0: return 1
    src=read()
    if "[local-patch kvoff-c3e]" in src: print("[apply] skip"); return 0
    shutil.copy2(F,F+BAK)
    for old,new in HUNKS:
        assert src.count(old)==1
        src=src.replace(old,new,1)
    try:
        with open(F,"w",encoding="utf-8") as f: f.write(src)
        compile_check(F)
    except Exception as e:
        shutil.copy2(F+BAK,F); print(f"[apply] FAILED {e}"); return 1
    subprocess.run(["rm","-rf",f"{os.path.dirname(F)}/__pycache__"],check=False)
    print("[apply] OK"); return 0
if __name__=="__main__":
    a=sys.argv[1] if len(sys.argv)>1 else "--self-test"
    sys.exit(self_test() if a=="--self-test" else apply() if a=="--apply" else 0)
