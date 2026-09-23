#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kvoff c3b 探针补丁（2026-09-23）：只加 INFO 日志，不改行为。
定位 OffloadingConnector CPU 档 lookup 全零的断点在哪一组/哪一步。
用法 --check/--self-test/--apply/--revert（同 c3 骨架，备份 .bak-kvoffc3b-0923）。"""
import argparse, os, py_compile, shutil, subprocess, sys

ROOT = os.environ.get("KVOFF_ROOT",
    "/media/ll/data/vllm-image/rootfs/usr/local/lib/python3.12/dist-packages/vllm")
F_SCHED = f"{ROOT}/distributed/kv_transfer/kv_connector/v1/offloading/scheduler.py"
MARK = "[local-patch kvoff-c3b]"
BAK_SUFFIX = ".bak-kvoffc3b-0923"

HUNKS = {
    F_SCHED: [
        # P1 lookup 终局
        (
            """        req_status.update_num_hit_chunks(num_computed_tokens + (num_hit_tokens or 0))

        self._touch(req_status)
""",
            """        # [local-patch kvoff-c3b] probe: final lookup verdict per request.
        logger.info(
            "[kvoff-c3b] LOOKUP req=%s skip_read=%s num_computed=%d hit=%s",
            request.request_id,
            request.skip_reading_prefix_cache,
            num_computed_tokens,
            num_hit_tokens,
        )
        req_status.update_num_hit_chunks(num_computed_tokens + (num_hit_tokens or 0))

        self._touch(req_status)
""",
        ),
        # P2 每分组命中
        (
            """                if num_hit_chunks == 0:
                    return 0
""",
            """                # [local-patch kvoff-c3b] probe: per-group hit.
                logger.info(
                    "[kvoff-c3b]   grp=%d sw=%s eagle=%s q=%d hit=%s max=%d",
                    group_idx,
                    sliding_window_size_in_chunks,
                    group_config.is_eagle_group,
                    num_chunks - start_chunk_idx,
                    num_hit_chunks,
                    max_hit_size_tokens,
                )
                if num_hit_chunks == 0:
                    return 0
""",
        ),
        # P3 store 分布
        (
            """            logger.debug(
                "Request %s offloading %s chunks upto %d tokens (job %d)",
""",
            """            # [local-patch kvoff-c3b] probe: store job composition.
            logger.info(
                "[kvoff-c3b] STORE req=%s keys=%d upto=%d groups=%s",
                req_id,
                len(keys_to_store),
                num_offloadable_tokens,
                group_sizes,
            )
            logger.debug(
                "Request %s offloading %s chunks upto %d tokens (job %d)",
""",
        ),
    ],
}

CHROOT = "/media/ll/data/vllm-image/rootfs"

def compile_check(path: str) -> None:
    """py_compile 用 chroot 内的 python3.12（宿主 py3.8 不认识 match 语法）。"""
    if path.startswith(CHROOT + "/"):
        rel = "/" + path[len(CHROOT) + 1 :]
        subprocess.run(
            ["chroot", CHROOT, "/usr/bin/python3.12", "-m", "py_compile", rel],
            check=True,
        )
    else:
        py_compile.compile(path, doraise=True)

def read(p):
    with open(p, encoding="utf-8") as f: return f.read()

def self_test() -> int:
    rc = 0
    for path, hunks in HUNKS.items():
        src = read(path)
        for i, (old, new) in enumerate(hunks, 1):
            n_old, n_new = src.count(old), src.count(new)
            if n_new == 1 and (n_old == 0 or old in new):
                print(f"[self-test] OK(applied)   {path.rsplit('/',1)[-1]} #{i:02d}")
            elif n_old == 1 and n_new == 0:
                print(f"[self-test] OK(pristine)  {path.rsplit('/',1)[-1]} #{i:02d}")
            else:
                print(f"[self-test] FAIL(anchor)  {path.rsplit('/',1)[-1]} #{i:02d} old={n_old} new={n_new}")
                rc = 1
    return rc

def apply() -> int:
    if self_test() != 0:
        print("[apply] anchor check failed, no change."); return 1
    for path, hunks in HUNKS.items():
        src = read(path)
        if MARK in src:
            print(f"[apply] skip (already patched): {path}"); continue
        bak = path + BAK_SUFFIX
        shutil.copy2(path, bak)
        for old, new in hunks:
            assert src.count(old) == 1
            src = src.replace(old, new, 1)
        try:
            with open(path, "w", encoding="utf-8") as f: f.write(src)
            compile_check(path)
        except Exception as e:
            shutil.copy2(bak, path); print(f"[apply] FAILED {path}: {e}"); return 1
        print(f"[apply] OK {path}")
    for path in HUNKS:
        subprocess.run(["rm","-rf",f"{path.rsplit('/',1)[0]}/__pycache__"], check=False)
    return 0

def revert() -> int:
    rc = 0
    for path in HUNKS:
        try:
            shutil.copy2(path + BAK_SUFFIX, path)
            compile_check(path)
            subprocess.run(["rm","-rf",f"{path.rsplit('/',1)[0]}/__pycache__"], check=False)
            print(f"[revert] OK {path}")
        except OSError as e:
            print(f"[revert] fail {path}: {e}"); rc = 1
    return rc

def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true"); g.add_argument("--self-test", action="store_true")
    g.add_argument("--apply", action="store_true"); g.add_argument("--revert", action="store_true")
    a = ap.parse_args()
    if a.self_test: return self_test()
    if a.apply: return apply()
    if a.revert: return revert()
    src = read(F_SCHED)
    for i,(old,new) in enumerate(HUNKS[F_SCHED],1):
        st = "APPLIED" if new in src else ("PRISTINE" if old in src and old not in new else "ANCHOR-MISSING(!)")
        print(f"scheduler.py {i:02d} {st}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
