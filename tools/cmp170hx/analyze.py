#!/usr/bin/env python3
"""从 check_cmp170hx_readonly.py 输出的 JSON 复算 fuse 上限（SM / 显存）。

口径（GA100 派生芯片）：
  - 8 个 GPC，每个 GPC 最多 8 个 TPC，每个 TPC = 2 SM（GA100 每 SM 64 FP32 核）
  - 24 个 FBPA 位，实测本机每 FBPA 位 = 4 GiB
  - 12 个 FBP 位，实际有效 8 个（每 FBP 管 3 个 FBPA）

用法: python3 analyze.py probe-g0.json [probe-g1.json ...]
"""
import json
import sys


def popcount_indices(mask, width):
    return [i for i in range(width) if mask & (1 << i)]


def analyze(path):
    d = json.load(open(path, encoding="utf-8"))
    if not d.get("complete"):
        print(f"{path}: INCOMPLETE {d.get('error')}")
        return None
    it = d["interpretation"]
    reg = {r["name"]: int(r["value"], 16) for r in d["registers"]}

    gpc_dis = reg["STATUS_OPT_GPC"] & 0xFF
    alive_gpc = [i for i in range(8) if not gpc_dis & (1 << i)]

    tpc_total = 0
    detail = []
    for g in range(8):
        tpc_dis = reg[f"STATUS_OPT_TPC_GPC{g}"] & 0xFF
        alive_tpc = [i for i in range(8) if not tpc_dis & (1 << i)]
        n = 0 if g in [i for i in range(8) if gpc_dis & (1 << i)] else len(alive_tpc)
        tpc_total += n
        detail.append((g, g in [i for i in range(8) if gpc_dis & (1 << i)], alive_tpc, n))

    sm = tpc_total * 2

    fbpa_dis = reg["STATUS_OPT_FBPA"] & 0xFFFFFF
    fbpa_alive = 24 - len(popcount_indices(fbpa_dis, 24))
    fbp_dis = reg["STATUS_OPT_FBP"] & 0xFFF
    fbp_alive = [i for i in range(12) if not fbp_dis & (1 << i)]

    rec = {
        "file": path,
        "bdf": d["target"]["bdf"],
        "uuid": d["target"]["gpu_uuid"],
        "sku": d["target"]["sku"],
        "gpc_total_alive": len(alive_gpc),
        "gpc_alive": alive_gpc,
        "tpc_total": tpc_total,
        "sm": sm,
        "fbpa_alive": fbpa_alive,
        "vram_gib": fbpa_alive * 4,
        "fbp_alive": len(fbp_alive),
        "fbp_alive_bits": fbp_alive,
        "tpc_detail": detail,
    }
    return rec


def main(argv):
    for p in argv:
        r = analyze(p)
        if not r:
            continue
        print("=" * 72)
        print(f"{r['file']}  {r['sku']}")
        print(f"  BDF {r['bdf']}  UUID {r['uuid']}")
        print(f"  有效 GPC {r['gpc_total_alive']}/8 {r['gpc_alive']}   TPC {r['tpc_total']}   SM {r['sm']}")
        print(f"  FBPA {r['fbpa_alive']}/24 -> 显存 {r['vram_gib']} GiB   FBP {r['fbp_alive']}/12 有效")
        for g, off, alive, n in r["tpc_detail"]:
            print(f"    GPC{g}: {'整块禁用' if off else f'存活 TPC {alive} -> {n}'}")


if __name__ == "__main__":
    main(sys.argv[1:] or ["probe-g0.json"])
