#!/usr/bin/env python3
"""gpu-clock-loadtest.py — 带载下实测 CMP 170HX 的 SM 频率/功耗/限频原因，并给出吞吐。

用途：验证 GPC VF offset（170tune/nvml_oc 路线，如 +150）在真实负载下到底抬不抬频、
有没有换来吞吐。判据口径与 09-26 定档一致：
  · 高频采样（默认 0.5s）clocks.sm / power.draw / utilization.gpu / clocks_event_reasons.active
  · 原因位：0x0 不限频、0x2 Applications Clocks、0x4 SW Power Cap、0x8 HW Slowdown
  · 负载源只用被测引擎的现有请求，不新建 CUDA 上下文（避免扰动已分配的 KV 池）

在 GPU 机上直接跑：python3 gpu-clock-loadtest.py --label plus150
参数：--port 18420 --model qwen3.8-flash-next --rounds 3 --tokens 2048 --max-tokens 128
"""
import argparse
import json
import statistics
import subprocess
import threading
import time
import urllib.request

TOPICS = (
    "分段存储管理 分页存储管理 虚拟内存地址转换 TLB快表 页面置换算法LRU与Clock "
    "透明大页THP NUMA亲和性与远端访存 swap与zswap mmap文件映射 多级页表与PCID "
    "缺页异常处理 内存回收writeback与dirty页 cgroup内存控制器与OOM 缺页中断的性能影响"
)


def q_fields():
    return "clocks.sm,power.draw,utilization.gpu,temperature.gpu,clocks_event_reasons.active"


def sampler(stop, out, interval):
    """0.5s 级采样；timeout 包裹防 D 状态卡死（09-20 铁律）。"""
    while not stop.is_set():
        try:
            r = subprocess.run(["timeout", "6", "nvidia-smi", "--query-gpu=" + q_fields(),
                                "--format=csv,noheader,nounits"],
                               capture_output=True, text=True, timeout=8)
            for line in r.stdout.strip().splitlines():
                f = [x.strip() for x in line.split(",")]
                if len(f) < 5:
                    continue
                out.append({"t": time.time(), "idx": len(out),
                            "sm": int(float(f[0])), "w": float(f[1]),
                            "util": int(float(f[2])), "temp": int(float(f[3])),
                            "reason": f[4]})
        except Exception:
            pass
        time.sleep(interval)


def one_request(base, model, ntok, maxtok, nonce):
    """固定长度、带 nonce 的长 prompt（nonce 保证前缀缓存不命中，真正压 prefill）。

    实测标定：TOPICS 约 230 字符重复一段 ≈ 110 token（中文+重复文本的 BPE 口径，
    按 0930 那版按字符估的系数会缩水到 1/5，负载远不够）。"""
    reps = max(1, int(round(ntok / 110.0)))
    prompt = (("[%s] " % nonce) + TOPICS * reps) + "请用中文分三段总结上述要点，每段不超过80字。"
    body = {"model": model, "messages": [{"role": "user", "content": prompt}],
            "max_tokens": maxtok, "temperature": 0.3, "stream": False}
    t0 = time.time()
    req = urllib.request.Request(base + "/v1/chat/completions",
                                data=json.dumps(body).encode(),
                                headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.load(r)
    el = time.time() - t0
    u = d.get("usage", {})
    return {"wall_s": round(el, 2), "prompt_tokens": u.get("prompt_tokens"),
            "completion_tokens": u.get("completion_tokens"),
            "tps_apparent": round((u.get("prompt_tokens") or 0) / el, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18420)
    ap.add_argument("--model", default="qwen3.8-flash-next")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--tokens", type=int, default=2048, help="每发 prompt 近似 token 数")
    ap.add_argument("--max-tokens", type=int, default=128)
    ap.add_argument("--concurrency", type=int, default=2, help="每轮并发请求数（1=串行）")
    ap.add_argument("--interval", type=float, default=0.5)
    ap.add_argument("--label", default="run")
    ap.add_argument("--json-out", default="")
    a = ap.parse_args()

    base = "http://127.0.0.1:%d" % a.port
    # 先探活
    try:
        with urllib.request.urlopen(base + "/v1/models", timeout=10) as r:
            json.load(r)
    except Exception as e:
        print("引擎不可达 %s：%s" % (base, e))
        return 2

    samples, stop = [], threading.Event()
    th = threading.Thread(target=sampler, args=(stop, samples, a.interval), daemon=True)
    th.start()
    res = []
    for i in range(a.rounds):
        # 每批发 --concurrency 发并发请求（PP2 下两 stage 都在跑，才压得出真实功耗/频率）
        def _run(j):
            return one_request(base, a.model, a.tokens, a.max_tokens,
                               "load%d-%d-r%d" % (i, int(time.time()), j))
        if a.concurrency <= 1:
            try:
                res.append(_run(0))
            except Exception as e:
                res.append({"error": "%s: %s" % (type(e).__name__, e)})
        else:
            box = [None] * a.concurrency
            t0 = time.time()
            ths = [threading.Thread(target=lambda j=j: box.__setitem__(j, _run(j)))
                   for j in range(a.concurrency)]
            for t in ths:
                t.start()
            for t in ths:
                t.join(timeout=600)
            wall = time.time() - t0
            ok = [r for r in box if r and not r.get("error")]
            agg = {"round": i, "concurrency": a.concurrency, "wall_s": round(wall, 2),
                   "requests": box}
            if ok:
                pt = sum(r["prompt_tokens"] or 0 for r in ok)
                ct = sum(r["completion_tokens"] or 0 for r in ok)
                agg["total_prompt_tokens"] = pt
                agg["total_completion_tokens"] = ct
                agg["decode_tps_sum"] = round(ct / wall, 1)          # 并发合计出字速度
                agg["prefill_tps_sum"] = round(pt / wall, 1)         # 粗口径（含出字时间）
            res.append(agg)
    time.sleep(1.0)
    stop.set()
    th.join(timeout=3)

    # 只取"真正在干活"的样本（util>=50），避免混入空载
    busy = [s for s in samples if s["util"] >= 50]
    def stat(key, seq):
        v = [s[key] for s in seq]
        if not v:
            return None
        return {"min": min(v), "med": int(statistics.median(v)), "max": max(v),
                "mean": round(statistics.mean(v), 1), "n": len(v)}
    reasons = {}
    for s in busy:
        reasons[s["reason"]] = reasons.get(s["reason"], 0) + 1
    out = {"label": a.label, "base": base, "requests": res,
           "samples_total": len(samples), "samples_busy": len(busy),
           "sm_busy": stat("sm", busy), "power_busy": stat("w", busy),
           "temp_busy": stat("temp", busy),
           "reason_hist": reasons}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    if a.json_out:
        with open(a.json_out, "w") as f:
            f.write(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
