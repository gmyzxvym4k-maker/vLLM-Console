#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
kvoff c4 真修 v2（2026-09-23，最小改动）：
  滑动窗口(sw)组在 GDN 对齐模式下，存储端每分段只留尾部检查点（稀疏键，
  c3e 实锤 idx=60/55 孤立 HIT），而查找端 eagle 把 required_window 抬到
  sw+1=2 并要求"连续"命中——稀疏键永远凑不出连续 2 → grp2 hit=0 →
  整个请求 CPU 命中归零。
  修法：对带 alignment 分段的 eagle 组不再 +1（稠密反扫天然容忍空洞，
  win=sw 时能找到最后一个已存检查点作为边界）；调用方保留 eagle 的 -1
  弹出，等价于多回退一个 chunk 重算，安全。非分段组行为逐字不变。
"""
import argparse, os, shutil, subprocess, sys
ROOT = os.environ.get("KVOFF_ROOT",
    "/media/ll/data/vllm-image/rootfs/usr/local/lib/python3.12/dist-packages/vllm")
F = f"{ROOT}/distributed/kv_transfer/kv_connector/v1/offloading/scheduler.py"
CHROOT = "/media/ll/data/vllm-image/rootfs"
BAK = ".bak-kvoffc4-0923"
MARK = "[local-patch kvoff-c4]"
OLD = """                    required_window = sliding_window_size_in_chunks
                    if is_eagle_unverified:
                        required_window += 1
"""
NEW = """                    required_window = sliding_window_size_in_chunks
                    # [local-patch kvoff-c4] Segmented sw groups (GDN align
                    # mode) only store per-segment tail checkpoints, so the
                    # volatile draft-tail neighbour needed for the eagle +1
                    # is never present; requiring 2 consecutive hits makes
                    # the lookup structurally impossible (always 0 -> whole
                    # request's CPU hit collapses). Skip the +1 when the
                    # group is alignment-segmented; the caller's eagle -1
                    # then backs off one extra chunk (safe recompute).
                    if (
                        is_eagle_unverified
                        and group_config.alignment_chunk_count is None
                    ):
                        required_window += 1
"""
def read():
    with open(F, encoding="utf-8") as f: return f.read()
def self_test():
    s = read()
    n_new, n_old = s.count(NEW), s.count(OLD)
    if n_new == 1: print("[c4] OK(applied)"); return 0
    if n_old == 1: print("[c4] OK(pristine)"); return 0
    print(f"[c4] FAIL old={n_old} new={n_new}"); return 1
def apply():
    if self_test() != 0: return 1
    s = read()
    if MARK in s: print("[apply] skip"); return 0
    shutil.copy2(F, F + BAK)
    s = s.replace(OLD, NEW, 1)
    try:
        with open(F, "w", encoding="utf-8") as f: f.write(s)
        subprocess.run(["chroot", CHROOT, "/usr/bin/python3.12", "-m", "py_compile",
                        "/" + F[len(CHROOT)+1:]], check=True)
    except Exception as e:
        shutil.copy2(F + BAK, F); print(f"[apply] FAILED {e}"); return 1
    subprocess.run(["rm", "-rf", f"{os.path.dirname(F)}/__pycache__"], check=False)
    print("[apply] OK c4 v2"); return 0
def revert():
    shutil.copy2(F + BAK, F)
    subprocess.run(["chroot", CHROOT, "/usr/bin/python3.12", "-m", "py_compile",
                    "/" + F[len(CHROOT)+1:]], check=True)
    subprocess.run(["rm", "-rf", f"{os.path.dirname(F)}/__pycache__"], check=False)
    print("[revert] OK"); return 0
if __name__ == "__main__":
    a = sys.argv[1] if len(sys.argv) > 1 else "--self-test"
    sys.exit(self_test() if a in ("--self-test", "--check") else apply() if a == "--apply" else revert())
