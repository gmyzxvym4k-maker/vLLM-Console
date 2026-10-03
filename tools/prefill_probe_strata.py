#!/usr/bin/env python3
"""Strata / 任意 OpenAI 兼容端点的 prefill 速度实测。

原理：发送**互不相同**的长 prompt（破坏 prefix 复用），max_tokens=1，
测墙钟时间；再用多档长度的差分（Δtokens/Δtime）消掉固定开销，得到边际 prefill 速率。
"""
import json
import random
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://192.168.1.38:8081"
MODEL = sys.argv[2] if len(sys.argv) > 2 else "qwen3.8-flash-next-iq3_s"
SIZES = [int(x) for x in (sys.argv[3].split(",") if len(sys.argv) > 3 else ["1000", "4000", "8000", "16000"])]
REPS = int(sys.argv[4]) if len(sys.argv) > 4 else 1


def make_prompt(target_tokens: int) -> str:
    """随机词 + 随机数字，保证每次内容唯一（不吃 prefix cache），且词/token 比稳定。"""
    rng = random.Random()
    words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf",
             "hotel", "india", "juliet", "kilo", "lima", "mike", "november",
             "oscar", "papa", "quebec", "romeo", "sierra", "tango"]
    out = [f"PROBE{rng.randrange(1 << 30):09x}"]
    n = 0
    while n < target_tokens:
        out.append(rng.choice(words))
        out.append(str(rng.randrange(100000)))
        n += 3
    return " ".join(out)


def call(prompt: str):
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt + "\nReply with the single word: done"}],
        "max_tokens": 1,
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(f"{BASE}/v1/chat/completions", data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.loads(r.read())
    dt = time.perf_counter() - t0
    u = d.get("usage") or {}
    return u.get("prompt_tokens", 0), dt


print(f"target={BASE} model={MODEL}")
print(f"{'prompt_tokens':>14} {'elapsed_s':>10} {'apparent_tps':>13}")
pts = []
for size in SIZES:
    for rep in range(REPS):
        p, dt = call(make_prompt(size))
        rate = p / dt if dt > 0 else 0
        pts.append((p, dt))
        print(f"{p:>14} {dt:>10.3f} {rate:>13,.0f}")

pts.sort()
print("\n--- 差分口径（消固定开销，真实边际 prefill 速率）---")
for i in range(1, len(pts)):
    (p0, t0), (p1, t1) = pts[i - 1], pts[i]
    dp, dt = p1 - p0, t1 - t0
    if dp > 0 and dt > 0:
        print(f"  {p0:>7} -> {p1:>7} tok : +{dp:>7} tok / +{dt:>7.3f} s = {dp / dt:>8,.0f} tok/s")
if len(pts) >= 2:
    dp = pts[-1][0] - pts[0][0]
    dt = pts[-1][1] - pts[0][1]
    print(f"  整体线性拟合: {dp / dt:,.0f} tok/s（固定开销外推 {pts[0][1] - pts[0][0] / (dp / dt):.2f} s）")
