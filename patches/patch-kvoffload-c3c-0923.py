#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kvoff c3c 探针：分组网格 + store/lookup 键样本对照。只加日志不改行为。"""
import argparse, os, shutil, subprocess, sys

ROOT = os.environ.get("KVOFF_ROOT",
    "/media/ll/data/vllm-image/rootfs/usr/local/lib/python3.12/dist-packages/vllm")
F = f"{ROOT}/distributed/kv_transfer/kv_connector/v1/offloading/scheduler.py"
MARK = "[local-patch kvoff-c3c]"
BAK = ".bak-kvoffc3c-0923"
CHROOT = "/media/ll/data/vllm-image/rootfs"

def compile_check(path):
    if path.startswith(CHROOT + "/"):
        rel = "/" + path[len(CHROOT) + 1:]
        subprocess.run(["chroot", CHROOT, "/usr/bin/python3.12", "-m", "py_compile", rel], check=True)
    else:
        import py_compile; py_compile.compile(path, doraise=True)

HUNKS = [
    # H0 helper
    (
        "def get_sliding_window_size_in_chunks(",
        '''def _c3c_group_hist(keys):
    # [local-patch kvoff-c3c] count offload keys per packed group index.
    h: dict[int, int] = {}
    for k in keys:
        g = int.from_bytes(k[-4:], "big")
        h[g] = h.get(g, 0) + 1
    return h


def get_sliding_window_size_in_chunks(''',
    ),
    # H1 qgrid after c3b LOOKUP line
    (
        """            num_computed_tokens,
            num_hit_tokens,
        )
""",
        """            num_computed_tokens,
            num_hit_tokens,
        )
        # [local-patch kvoff-c3c] probe: per-group grid + query key samples.
        logger.info(
            "[kvoff-c3c] qgrid req=%s %s",
            request.request_id,
            [
                (
                    gc.group_idx,
                    gc.tokens_per_chunk,
                    gc.hashes_per_chunk,
                    len(gs.offload_keys),
                    gs.offload_keys[0][:6].hex() if gs.offload_keys else "-",
                    gs.offload_keys[min(2, len(gs.offload_keys) - 1)][:6].hex()
                    if gs.offload_keys
                    else "-",
                )
                for gc, gs in zip(
                    self.config.kv_group_configs, req_status.group_states
                )
            ],
        )
""",
    ),
    # H2 skeys in _build_store_jobs
    (
        "            keys_to_store = set(store_output.keys_to_store)\n",
        """            keys_to_store = set(store_output.keys_to_store)
            # [local-patch kvoff-c3c] probe: accepted-store key groups.
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
    ),
]

def read():
    with open(F, encoding="utf-8") as f: return f.read()

def self_test():
    rc = 0; src = read()
    for i, (old, new) in enumerate(HUNKS, 1):
        n_old, n_new = src.count(old), src.count(new)
        if n_new == 1 and (n_old == 0 or old in new):
            print(f"[self-test] OK(applied)   #{i:02d}")
        elif n_old == 1 and n_new == 0:
            print(f"[self-test] OK(pristine)  #{i:02d}")
        else:
            print(f"[self-test] FAIL(anchor)  #{i:02d} old={n_old} new={n_new}"); rc = 1
    return rc

def apply():
    if self_test() != 0: return 1
    src = read()
    if MARK in src:
        print("[apply] skip (already patched)"); return 0
    shutil.copy2(F, F + BAK)
    for old, new in HUNKS:
        assert src.count(old) == 1
        src = src.replace(old, new, 1)
    try:
        with open(F, "w", encoding="utf-8") as f: f.write(src)
        compile_check(F)
    except Exception as e:
        shutil.copy2(F + BAK, F); print(f"[apply] FAILED: {e}"); return 1
    subprocess.run(["rm", "-rf", f"{os.path.dirname(F)}/__pycache__"], check=False)
    print("[apply] OK"); return 0

def revert():
    shutil.copy2(F + BAK, F); compile_check(F)
    subprocess.run(["rm", "-rf", f"{os.path.dirname(F)}/__pycache__"], check=False)
    print("[revert] OK"); return 0

if __name__ == "__main__":
    a = sys.argv[1] if len(sys.argv) > 1 else "--check"
    sys.exit(self_test() if a == "--self-test" else apply() if a == "--apply"
             else revert() if a == "--revert" else 0)
