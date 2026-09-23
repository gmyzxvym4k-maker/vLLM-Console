#!/usr/bin/env python3
"""修复 09-18 kvfill 指标补丁的未注册缺陷：
manager.py 会 set_gauge(CPU_CACHE_FILL_PERC)，但 spec.py 的
build_metric_definitions() 里没有该条元数据 → offloading/metrics.py:489
`assert key in self._offloading_metric_defs` 失败 → 请求 500 / 引擎退出。
补上定义即可（幂等，带备份）。
"""
import os, py_compile, shutil, sys

ROOT = os.environ.get("KVOFF_ROOT",
    "/media/ll/data/vllm-image/rootfs/usr/local/lib/python3.12/dist-packages/vllm")
F = f"{ROOT}/v1/kv_offload/cpu/spec.py"
BAK = F + ".bak-kvfill-metric-0922"

OLD = """            CPUOffloadingMetrics.CPU_CACHE_WRITE_USAGE_PERC: OffloadingGaugeMetadata("""
NEW = """            CPUOffloadingMetrics.CPU_CACHE_FILL_PERC: OffloadingGaugeMetadata(
                documentation=(
                    "[local-patch kvfill] Fraction of CPU offload blocks "
                    "currently holding cached data (vs. free), regardless of "
                    "in-flight transfers."
                ),
            ),
            CPUOffloadingMetrics.CPU_CACHE_WRITE_USAGE_PERC: OffloadingGaugeMetadata("""

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    src = open(F, encoding="utf-8").read()
    if mode == "--check":
        print("APPLIED" if NEW in src else ("PRISTINE" if OLD in src else "ANCHOR-MISSING"))
        return 0
    if mode == "--revert":
        shutil.copy2(BAK, F); py_compile.compile(F, doraise=True); print("reverted"); return 0
    if mode != "--apply":
        print("usage: --check|--apply|--revert"); return 2
    if NEW in src:
        print("already applied"); return 0
    assert src.count(OLD) == 1, "anchor not unique"
    shutil.copy2(F, BAK)
    try:
        open(F, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))
        py_compile.compile(F, doraise=True)
    except Exception as e:
        shutil.copy2(BAK, F); print("FAILED, reverted:", e); return 1
    os.system(f"rm -rf {os.path.dirname(F)}/__pycache__")
    print("applied OK; backup:", BAK)
    return 0

sys.exit(main())
