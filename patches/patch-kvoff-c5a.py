#!/usr/bin/env python3
# [kvoff-c5a] 解除 offloading 查找侧 eagle +1/-1 双罚（根因修复）
import os, py_compile, shutil, sys
ROOT = os.environ.get("KVOFF_ROOT",
    "/media/ll/data/vllm-image/rootfs/usr/local/lib/python3.12/dist-packages/vllm")
F = f"{ROOT}/distributed/kv_transfer/kv_connector/v1/offloading/scheduler.py"
BAK = F + ".bak-kvoffc5a-0923"
OLD = """                is_eagle_unverified = (
                    group_config.is_eagle_group and group_idx not in eagle_verified
                )"""
NEW = """                # [local-patch kvoff-c5a] Disarm the lookup-side eagle +1/-1
                # double penalty. The store side already excludes the volatile
                # draft tail (storable_chunks -1 while decoding and at finish)
                # and rows below the accepted frontier are never rewritten, so
                # the popped chunk was always a final, stable one. With MTP on,
                # the from_spec fallback marks ALL groups eagle: every
                # multi-turn delta (typically 1 chunk) collapsed to 0, and sw
                # groups got a spurious window +1 (GDN base window is 1),
                # making CPU-tier hits structurally impossible.
                is_eagle_unverified = False"""
mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
src = open(F, encoding="utf-8").read()
if mode == "--check":
    print("APPLIED" if NEW in src else ("PRISTINE" if src.count(OLD) == 1 else "ANCHOR-PROBLEM"))
elif mode == "--apply":
    if NEW in src: print("already applied")
    else:
        assert src.count(OLD) == 1, "anchor not unique"
        shutil.copy2(F, BAK)
        try:
            open(F, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))
            py_compile.compile(F, doraise=True)
        except Exception as e:
            shutil.copy2(BAK, F); print("FAILED reverted:", e); sys.exit(1)
        os.system(f"rm -rf {os.path.dirname(F)}/__pycache__")
        print("applied OK; backup:", BAK)
elif mode == "--revert":
    shutil.copy2(BAK, F); py_compile.compile(F, doraise=True)
    os.system(f"rm -rf {os.path.dirname(F)}/__pycache__")
    print("reverted")
