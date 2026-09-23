#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""c3d：加强 c3c 探针——store 按组记录哈希范围，lookup 记录查询切片的哈希首尾。"""
import argparse, os, shutil, subprocess, sys
ROOT = os.environ.get("KVOFF_ROOT",
    "/media/ll/data/vllm-image/rootfs/usr/local/lib/python3.12/dist-packages/vllm")
F = f"{ROOT}/distributed/kv_transfer/kv_connector/v1/offloading/scheduler.py"
CHROOT = "/media/ll/data/vllm-image/rootfs"
BAK = ".bak-kvoffc3d-0923"
def compile_check(p):
    rel = "/" + p[len(CHROOT)+1:]
    subprocess.run(["chroot", CHROOT, "/usr/bin/python3.12", "-m", "py_compile", rel], check=True)
HUNKS = [
    # D1: 替换 skeys 行为按组哈希范围
    (
        """            # [local-patch kvoff-c3c] probe: accepted-store key groups.
            logger.info(
                "[kvoff-c3c] skeys req=%s n=%d bygrp=%s sample=%s",
                req_id,
                len(keys_to_store),
                _c3c_group_hist(keys_to_store),
                [
                    k[:6].hex() + "#" + str(int.from_bytes(k[-4:], "big"))
                    for k in sorted(keys_to_store)[:3]
                ],
            )
""",
        """            # [local-patch kvoff-c3d] probe: per-group stored hash range.
            logger.info(
                "[kvoff-c3d] skeys req=%s n=%d bygrp=%s grphash=%s",
                req_id,
                len(keys_to_store),
                _c3c_group_hist(keys_to_store),
                {
                    g: (
                        min(k[:6].hex() for k in keys_to_store
                            if int.from_bytes(k[-4:], "big") == g),
                        max(k[:6].hex() for k in keys_to_store
                            if int.from_bytes(k[-4:], "big") == g),
                    )
                    for g in sorted({int.from_bytes(k[-4:], "big") for k in keys_to_store})
                },
            )
""",
    ),
    # D2: grp 行加查询切片哈希首尾
    (
        """                logger.info(
                    "[kvoff-c3b]   grp=%d sw=%s eagle=%s q=%d hit=%s max=%d",
                    group_idx,
                    sliding_window_size_in_chunks,
                    group_config.is_eagle_group,
                    num_chunks - start_chunk_idx,
                    num_hit_chunks,
                    max_hit_size_tokens,
                )
""",
        """                logger.info(
                    "[kvoff-c3b]   grp=%d sw=%s eagle=%s q=%d hit=%s max=%d "
                    "qkeys=%s",
                    group_idx,
                    sliding_window_size_in_chunks,
                    group_config.is_eagle_group,
                    num_chunks - start_chunk_idx,
                    num_hit_chunks,
                    max_hit_size_tokens,
                    (
                        offload_keys[0][:6].hex() + ".." + offload_keys[-1][:6].hex()
                        if len(offload_keys)
                        else "-"
                    ),
                )
""",
    ),
]
def read():
    with open(F, encoding="utf-8") as f: return f.read()
def self_test():
    rc=0; src=read()
    for i,(old,new) in enumerate(HUNKS,1):
        n_old,n_new=src.count(old),src.count(new)
        if n_new==1 and (n_old==0 or old in new): print(f"[self-test] OK(applied)   #{i:02d}")
        elif n_old==1 and n_new==0: print(f"[self-test] OK(pristine)  #{i:02d}")
        else: print(f"[self-test] FAIL(anchor)  #{i:02d} old={n_old} new={n_new}"); rc=1
    return rc
def apply():
    if self_test()!=0: return 1
    src=read()
    if "[local-patch kvoff-c3d]" in src: print("[apply] skip"); return 0
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
