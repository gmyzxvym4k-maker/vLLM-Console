#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
kvoffload c3 补丁（2026-09-23），叠加在 c1c2-0922 之上，修 KVOFF 两个 bug：

  Bug A（0922 定案）：offloading/metrics.py:489 `assert key in
    self._offloading_metric_defs` 在每请求 record 路径上，一旦 stats 出现
    未定义的 key 就 AssertionError → 全部请求 500。
    修法 = observe() 对未知 key 降级为「丢弃 + 一次性 warning」，
    遥测永远不该有杀死引擎的权力。warning 会打出具体 key，顺带定位
    上报口径与 defs 的偏差来源。

  Bug B（0923 定案）：抢占换出路径 handle_preemptions → submit_store →
    swap_blocks_batch → cuMemcpyBatchAsync failed at index N error 1，
    Worker_PP1 死 → EngineDead。静态排查（scheduler 两处 store/load 构造点、
    CoW 路径、group_sizes 位置对齐、buffer 复用、估算）均未复现出坏指针来源，
    需要一次带 forensic dump 的复现。
    修法（本补丁内）= 在 _swap_blocks_batch 外包 try/except，失败时把
    整批描述符（src/dst/size 逐条）与本 rank 的 GPU/CPU 张量地址区间打进
    日志后再原样 re-raise。一次崩溃即可锁定是哪个 group/block 的哪个
    指针非法，再出 c4 真修。

用法：
  --check       报告每 hunk 状态
  --self-test   锚点唯一性校验（不落盘）
  --apply       备份 *.bak-kvoffc3-0923 后应用 + py_compile + 清 __pycache__
  --revert      从备份还原
"""
import argparse
import os
import py_compile
import shutil
import subprocess
import sys

ROOT = os.environ.get(
    "KVOFF_ROOT",
    "/media/ll/data/vllm-image/rootfs/usr/local/lib/python3.12/dist-packages/vllm",
)
F_METRICS = (
    f"{ROOT}/distributed/kv_transfer/kv_connector/v1/offloading/metrics.py"
)
F_GPUWORKER = f"{ROOT}/v1/kv_offload/cpu/gpu_worker.py"
MARK = "[local-patch kvoff-c3]"
BAK_SUFFIX = ".bak-kvoffc3-0923"

HUNKS = {
    F_METRICS: [
        # M1: logger + bookkeeping set（放在 import 区末尾，类定义之前）
        (
            "from vllm.v1.kv_offload.factory import OffloadingSpecFactory\n",
            """from vllm.v1.kv_offload.factory import OffloadingSpecFactory

# [local-patch kvoff-c3] observe() 的未知 key 降级日志与去重簿记。
from vllm.logger import init_logger

_KVOFF_C3_UNKNOWN_KEYS: set[str] = set()
logger = init_logger(__name__)
""",
        ),
        # M2: observe() 的 assert 降级
        (
            """            if type_str is None:
                raise AssertionError(f"Unknown offloading stats key: {key}")
            assert key in self._offloading_metric_defs
""",
            """            if type_str is None:
                raise AssertionError(f"Unknown offloading stats key: {key}")
            # [local-patch kvoff-c3] Bug A(0922)：未定义 key 曾让每个请求
            # 在此 AssertionError → HTTP 500。遥测降级为丢弃+一次性 warning。
            if key not in self._offloading_metric_defs:
                if key not in _KVOFF_C3_UNKNOWN_KEYS:
                    _KVOFF_C3_UNKNOWN_KEYS.add(key)
                    logger.warning(
                        "[kvoff-c3] offloading stats key without metric "
                        "def (dropped): %s",
                        key,
                    )
                continue
""",
        ),
    ],
    F_GPUWORKER: [
        # G1: forensic dump 函数
        (
            '''class SingleDirectionOffloadingHandler:
    """
    Handles transfers for a single direction, either CPU->GPU or GPU->CPU.''',
            '''def _kvoff_c3_ranges(tensors):
    # [local-patch kvoff-c3] (idx, begin, end) address spans of a tensor list.
    out = []
    for i, t in enumerate(tensors):
        base = t.data_ptr()
        out.append((i, base, base + t.numel() * t.element_size()))
    return out


def _kvoff_c3_dump_failed_batch(handler, src, dst, sizes, job_id):
    """[local-patch kvoff-c3] Bug B(0923) 取证：批拷贝抛错时逐条打印
    src/dst/size 并对照本 rank 张量地址区间标记非法项，然后由调用方
    原样 re-raise。只加日志，不改任何行为。"""
    try:
        src_ts = getattr(handler, "_src_tensors", None)
        dst_ts = getattr(handler, "_dst_tensors", None)
        sr = _kvoff_c3_ranges(src_ts) if src_ts is not None else []
        dr = _kvoff_c3_ranges(dst_ts) if dst_ts is not None else []
        logger.error(
            "[kvoff-c3] batch copy FAILED job=%s gpu_to_cpu=%s ops=%d",
            job_id,
            getattr(handler, "gpu_to_cpu", None),
            len(sizes),
        )
        logger.error(
            "[kvoff-c3]   src_ranges=%s", [(hex(b), hex(e)) for _, b, e in sr]
        )
        logger.error(
            "[kvoff-c3]   dst_ranges=%s", [(hex(b), hex(e)) for _, b, e in dr]
        )

        def _in(ptr, rng):
            return any(b <= ptr < e for _, b, e in rng)

        for i in range(len(sizes)):
            s = int(src[i])
            d = int(dst[i])
            sz = int(sizes[i])
            s_ok = _in(s, sr) if sr else None
            d_ok = _in(d, dr) if dr else None
            bad = (
                sz <= 0
                or (s % 16)
                or (d % 16)
                or (sz % 16)
                or (s_ok is False)
                or (d_ok is False)
            )
            if bad or i < 16:
                logger.error(
                    "[kvoff-c3]   op[%d]%s src=%#x(in_src=%s) "
                    "dst=%#x(in_dst=%s) size=%d",
                    i,
                    " <<<BAD" if bad else "",
                    s,
                    s_ok,
                    d,
                    d_ok,
                    sz,
                )
    except Exception:  # noqa: BLE001  取证永不掩盖原始异常
        logger.exception("[kvoff-c3] forensics dump failed")


class SingleDirectionOffloadingHandler:
    """
    Handles transfers for a single direction, either CPU->GPU or GPU->CPU.''',
        ),
        # G2: 包住批拷贝调用
        (
            """            if op_idx > 0:
                self._swap_blocks_batch(
                    src,
                    dst,
                    sizes,
                    is_src_access_order_any=is_src_access_order_any,
                )
""",
            """            if op_idx > 0:
                try:
                    self._swap_blocks_batch(
                        src,
                        dst,
                        sizes,
                        is_src_access_order_any=is_src_access_order_any,
                    )
                except Exception:
                    # [local-patch kvoff-c3] 先 dump 再原样上抛。
                    _kvoff_c3_dump_failed_batch(self, src, dst, sizes, job_id)
                    raise
""",
        ),
    ],
}


def read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def status(path: str) -> list:
    src = read(path)
    out = []
    for i, (old, new) in enumerate(HUNKS[path], 1):
        applied = new in src
        pristin = (old in src) and (old not in new)
        if applied:
            out.append(f"{i:02d} APPLIED")
        elif pristin:
            out.append(f"{i:02d} PRISTINE")
        else:
            out.append(f"{i:02d} ANCHOR-MISSING(!)")
    return out


def self_test() -> int:
    rc = 0
    for path, hunks in HUNKS.items():
        try:
            src = read(path)
        except OSError as e:
            print(f"[self-test] READ-FAIL {path}: {e}")
            return 2
        for i, (old, new) in enumerate(hunks, 1):
            n_old, n_new = src.count(old), src.count(new)
            if n_new == 1 and (n_old == 0 or old in new):
                print(f"[self-test] OK(applied)   {path.rsplit('/',1)[-1]} #{i:02d}")
            elif n_old == 1 and n_new == 0:
                print(f"[self-test] OK(pristine)  {path.rsplit('/',1)[-1]} #{i:02d}")
            else:
                print(
                    f"[self-test] FAIL(anchor)  {path.rsplit('/',1)[-1]} #{i:02d} "
                    f"old={n_old} new={n_new}"
                )
                rc = 1
    return rc


def apply() -> int:
    if self_test() != 0:
        print("[apply] 锚点校验失败，未做任何修改。")
        return 1
    for path, hunks in HUNKS.items():
        src = read(path)
        if MARK in src:
            print(f"[apply] skip (already patched): {path}")
            continue
        bak = path + BAK_SUFFIX
        shutil.copy2(path, bak)
        for old, new in hunks:
            assert src.count(old) == 1, f"anchor drift in {path}"
            src = src.replace(old, new, 1)
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(src)
            py_compile.compile(path, doraise=True)
        except Exception as e:  # noqa: BLE001
            shutil.copy2(bak, path)
            print(f"[apply] FAILED {path}: {e} — 已从备份还原")
            return 1
        print(f"[apply] OK {path} (backup: {bak})")
    for path in HUNKS:
        subprocess.run(
            ["rm", "-rf", f"{path.rsplit('/',1)[0]}/__pycache__"], check=False
        )
    return 0


def revert() -> int:
    rc = 0
    for path in HUNKS:
        bak = path + BAK_SUFFIX
        try:
            shutil.copy2(bak, path)
            py_compile.compile(path, doraise=True)
            subprocess.run(
                ["rm", "-rf", f"{path.rsplit('/',1)[0]}/__pycache__"], check=False
            )
            print(f"[revert] OK {path}")
        except OSError as e:
            print(f"[revert] no backup / copy fail {path}: {e}")
            rc = 1
    return rc


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true")
    g.add_argument("--self-test", action="store_true")
    g.add_argument("--apply", action="store_true")
    g.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    if args.check:
        for path in HUNKS:
            for line in status(path):
                print(f"{path.rsplit('/',1)[-1]:16s} {line}")
        return 0
    if args.self_test:
        return self_test()
    if args.apply:
        return apply()
    return revert()


if __name__ == "__main__":
    sys.exit(main())
