#!/usr/bin/env python3
"""控制台侧修复：官方 0.30.0 新栈下仪表盘「二级缓存·CPU」卡不显示。

症状：仪表盘没有「KV Cache 的二级缓存」卡（#kvOffCard 恒 display:none）。
根因：server.js 采样 /metrics 时只认旧栈自研镜像 + kvfill 补丁暴露的
      `vllm:kv_offload_cpu_cache_fill_perc`；官方 0.30.0 只暴露上游原生的
      `vllm:kv_offload_cpu_cache_usage_perc`（口径=被在飞传输钉住的比例），
      且写入/回载序列从 `total_bytes_total{transfer_type}`、`size_count{transfer_type}`
      变为无标签的 `store_bytes_total` / `load_bytes_total` / `store_size_count` /
      `load_size_count`。fillKey 找不到 → tk.kvOffload 恒 null → kv_offload_ports
      空数组 → 前端把卡片 display:none。

修法（最小、双栈兼容、口径不混）：
  1. 采样段：fill_perc 与 usage_perc 任一存在即认定二级缓存已启用；用
     metricKind('fill'|'usage') 记录口径；字节/次数先取无标签新名，回落旧标签名。
  2. 汇总段：透传 metric_kind；usage 口径下 fill_gb 置 null（换算成 GiB 会冒充驻留量）。
  3. 前端（index.html，另随仓库发布）：usage 口径主值改显「容量 · 已启用」，
     钉住比例退到小字与 tooltip。

用法：python3 patch-kvoff-0300-metric-0930.py --check|--apply|--revert [--target DIR]
默认 target=/home/ll/deploy（线上）。幂等、带 .bak-kvoff0300-0930 备份。
"""
import os, shutil, subprocess, sys

TARGET = "/home/ll/deploy"

OLD_A = """        // [kvoff-display 09-22] CPU KV 二级缓存（vLLM OffloadingConnector 才有这些指标；
        // fill_perc 由本地 kvfill 补丁暴露=内存档已用比例，usage_perc 是钉住传输比例，不用）。
        tk.kvOffload = null;
        if (ns !== 'sglang') {
          try {
            const fillKey = Object.keys(m).find(k => k.startsWith('vllm:kv_offload_cpu_cache_fill_perc|'));
            if (fillKey) {
              tk.kvOffload = {
                fillPerc: m[fillKey] || 0,
                storedBytes: counterByLabel(m, 'vllm:kv_offload_total_bytes_total', 'transfer_type', 'GPU_to_CPU'),
                loadedBytes: counterByLabel(m, 'vllm:kv_offload_total_bytes_total', 'transfer_type', 'CPU_to_GPU'),
                // [kvoff-hit 09-22] 命中真值：connector 回载的 prompt token（免重算部分，
                // source=external_kv_transfer）+ 回载/写入次数（histogram _count 序列）
                extTokens: counterBySource(m, 'vllm:prompt_tokens_by_source_total', 'external_kv_transfer'),
                loadCount: counterByLabel(m, 'vllm:kv_offload_size_count', 'transfer_type', 'CPU_to_GPU'),
                storeCount: counterByLabel(m, 'vllm:kv_offload_size_count', 'transfer_type', 'GPU_to_CPU'),
              };
            }
          } catch (e) {}
        }
"""

NEW_A = """        // [kvoff-display 09-22] CPU KV 二级缓存（vLLM OffloadingConnector 才有这些指标）。
        // [kvoff-0300 0930] 双栈兼容：官方 0.30.0 新栈只暴露上游原生
        // cpu_cache_usage_perc（官方文档口径=「被在飞传输钉住」的比例，**不是**驻留占比），
        // 且写入/回载序列变成无标签单值（store_bytes_total / load_size_count）；
        // 旧栈（自研镜像 + kvfill 补丁）才是 cpu_cache_fill_perc（真实驻留占比）
        // + 带 transfer_type 标签的 total_bytes_total / size_count。
        // 两栈任一 gauge 在 = 二级缓存已启用，口径差异用 metricKind 透传给前端，
        // 绝不把 usage 当驻留显示（否则会把「100% 被钉住」误读成「缓存塞满」）。
        tk.kvOffload = null;
        if (ns !== 'sglang') {
          try {
            const fillKey = Object.keys(m).find(k => k.startsWith('vllm:kv_offload_cpu_cache_fill_perc|'));
            const usageKey = Object.keys(m).find(k => k.startsWith('vllm:kv_offload_cpu_cache_usage_perc|'));
            if (fillKey || usageKey) {
              // 无标签单值序列（新栈）优先，回落带 transfer_type 标签的旧栈序列
              const plain = (name) => {
                for (const k of Object.keys(m)) { if (k === name || k.startsWith(name + '|')) return m[k] || 0; }
                return 0;
              };
              const pick = (newName, oldName, tt) => plain(newName) || counterByLabel(m, oldName, 'transfer_type', tt);
              tk.kvOffload = {
                metricKind: fillKey ? 'fill' : 'usage',
                fillPerc: (fillKey ? m[fillKey] : m[usageKey]) || 0,
                storedBytes: pick('vllm:kv_offload_store_bytes_total', 'vllm:kv_offload_total_bytes_total', 'GPU_to_CPU'),
                loadedBytes: pick('vllm:kv_offload_load_bytes_total', 'vllm:kv_offload_total_bytes_total', 'CPU_to_GPU'),
                // [kvoff-hit 09-22] 命中真值：connector 回载的 prompt token（免重算部分，
                // source=external_kv_transfer）+ 回载/写入次数（新栈 _size_count 无标签、
                // 旧栈 _size_count 带 transfer_type）
                extTokens: counterBySource(m, 'vllm:prompt_tokens_by_source_total', 'external_kv_transfer'),
                loadCount: pick('vllm:kv_offload_load_size_count', 'vllm:kv_offload_size_count', 'CPU_to_GPU'),
                storeCount: pick('vllm:kv_offload_store_size_count', 'vllm:kv_offload_size_count', 'GPU_to_CPU'),
              };
            }
          } catch (e) {}
        }
"""

OLD_B = """        model: inst.servedName || inst.modelPath || '',
        capacity_gb: capBytes ? +(capBytes / gib).toFixed(2) : null,
        fill_gb: capBytes ? +(kv.fillPerc * capBytes / gib).toFixed(2) : null,
        fill_pct: +(kv.fillPerc * 100).toFixed(1),
"""

NEW_B = """        model: inst.servedName || inst.modelPath || '',
        // [kvoff-0300 0930] fill=旧栈真实驻留占比；usage=新栈「被在飞传输钉住」占比
        metric_kind: kv.metricKind || 'fill',
        capacity_gb: capBytes ? +(capBytes / gib).toFixed(2) : null,
        // usage 口径换算成 GiB 会冒充驻留量 → 只有 fill 口径才给 fill_gb
        fill_gb: (capBytes && kv.metricKind !== 'usage') ? +(kv.fillPerc * capBytes / gib).toFixed(2) : null,
        fill_pct: +(kv.fillPerc * 100).toFixed(1),
"""

PAIRS = [("采样段", OLD_A, NEW_A), ("汇总段", OLD_B, NEW_B)]


def main():
    args = sys.argv[1:]
    mode = args[0] if args and args[0].startswith("--") else "--check"
    target = TARGET
    if "--target" in args:
        target = args[args.index("--target") + 1]
    f = os.path.join(target, "server.js")
    bak = f + ".bak-kvoff0300-0930"
    src = open(f, encoding="utf-8").read()

    applied = [t for t, _, new in PAIRS if new in src]
    pristine = [t for t, old, _ in PAIRS if old in src]
    if mode == "--check":
        if len(applied) == len(PAIRS):
            print("APPLIED (both)")
        elif applied:
            print("PARTIAL:", applied, "| pristine:", pristine)
        elif len(pristine) == len(PAIRS):
            print("PRISTINE (both)")
        else:
            print("ANCHOR-MISSING | applied:", applied, "| pristine:", pristine, "-> 需人工核对线上基线")
        return 0

    if mode == "--revert":
        shutil.copy2(bak, f)
        print("reverted from", bak)
        return 0

    if mode != "--apply":
        print("usage: --check|--apply|--revert [--target DIR]")
        return 2

    if len(applied) == len(PAIRS):
        print("already applied (nothing to do)")
        return 0
    for tag, old, _ in PAIRS:
        if tag not in pristine:
            print("ABORT: 锚点缺失或非唯一 ->", tag)
            return 1
        if src.count(old) != 1:
            print("ABORT: 锚点不唯一 ->", tag, src.count(old))
            return 1
    shutil.copy2(f, bak)
    out = src
    for _, old, new in PAIRS:
        out = out.replace(old, new, 1)
    open(f, "w", encoding="utf-8").write(out)
    if shutil.which("node"):
        r = subprocess.run(["node", "--check", f], capture_output=True, text=True)
        if r.returncode != 0:
            shutil.copy2(bak, f)
            print("node --check FAILED, reverted:\n", r.stderr[:2000])
            return 1
        check = "node --check passed"
    else:
        check = "本机无 node，语法校验请部署端执行"
    print("applied OK;", check, "; backup:", bak)
    return 0


sys.exit(main())
