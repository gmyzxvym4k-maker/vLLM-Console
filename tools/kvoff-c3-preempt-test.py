#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""强制抢占压测（kvoff c3 窗口 P5）。
GPU 池 1,242,870 token；发 2×700K + 1×300K（合计 1.7M > 池），
错峰 8s 注入，逼出 preemption → handle_preemptions → submit_store
（0923 崩溃路径）。RATIO=0.5299 tok/字符（fnx-bench 标定值）。"""
import json
import threading
import time
import urllib.request

BASE = "http://127.0.0.1:18420/v1/chat/completions"
MODEL = "qwen3.8-flash-next"
RATIO = 0.5299
UNIT = (
    "这是一段用于分级缓存压力测试的中文自然文本，讲述 KV 缓存从显存换出到"
    "宿主内存再换回的过程，其中穿插数字 1234567890 与符号 @#%&，"
    "以便稳定地按比例产生 token 并覆盖各种词表分支。"
)


def make_prompt(n_tokens: int, salt: str) -> str:
    chars = int(n_tokens / RATIO)
    seed = f"[kvoff-c3-{salt}] " + UNIT
    reps = chars // len(seed) + 1
    return (seed * reps)[:chars]


def send(name: str, n_tokens: int, salt: str):
    body = json.dumps(
        {
            "model": MODEL,
            "messages": [{"role": "user", "content": make_prompt(n_tokens, salt)}],
            "max_tokens": 64,
            "temperature": 0,
        }
    ).encode()
    req = urllib.request.Request(
        BASE, data=body, headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=2400) as r:
            d = json.loads(r.read())
        u = d.get("usage", {})
        det = u.get("prompt_tokens_details") or {}
        print(
            f"{name} OK {time.time()-t0:.0f}s prompt={u.get('prompt_tokens')} "
            f"cached={det.get('cached_tokens')}",
            flush=True,
        )
    except Exception as e:  # noqa: BLE001
        print(f"{name} FAIL {time.time()-t0:.0f}s {e}", flush=True)


if __name__ == "__main__":
    jobs = [("A", 700_000, "alpha"), ("B", 700_000, "beta"), ("C", 300_000, "gamma")]
    ts = [threading.Thread(target=send, args=(n, t, s)) for n, t, s in jobs]
    for t in ts:
        t.start()
        time.sleep(8)
    for t in ts:
        t.join()
    print("PREEMPT TEST END", flush=True)
