#!/usr/bin/env python3
"""在 check_cmp170hx_readonly.py 的 JSON 基础上，区分「现状上限」与「按 fuse 标签折算的可救上限」。

现状上限 = STATUS_OPT_* 生效值（当前驱动看到的拓扑）。
可救上限 = 现状 + 所有「被 disable 但没有 defect 标记」的单元：
  - SM：GPC 未标坏但整块禁用 → 该 GPC 内 (TPC_DISABLE & ~TPC_DEFECTIVE) 的位可救，每 TPC 2 SM
        存活 GPC 内被禁且无缺陷的 TPC 同理
        GPC 本身带 defect 标记 → 整块不救（保守口径）
  - 显存：FBPA_DISABLE & ~FBPA_DEFECTIVE 的位，每 FBPA 位 4 GiB（本机实测口径）

用法: python3 recoverable.py probe2-g0.json ...
"""
import json
import sys

FBPA_GIB = 4  # 实测：16 位 = 65536 MiB


def bits(v, w):
    return [i for i in range(w) if v & (1 << i)]


def calc(path):
    d = json.load(open(path, encoding="utf-8"))
    if not d.get("complete"):
        return None
    reg = {r["name"]: int(r["value"], 16) for r in d["registers"]}

    gpc_dis = reg["STATUS_OPT_GPC"] & 0xFF
    gpc_def = reg["OPT_GPC_DEFECTIVE"] & 0xFF

    now_tpc = 0
    rec_tpc = 0
    detail = []
    for g in range(8):
        tdis = reg[f"STATUS_OPT_TPC_GPC{g}"] & 0xFF
        tdef = reg[f"OPT_TPC_GPC{g}_DEFECTIVE"] & 0xFF
        g_dis = bool(gpc_dis & (1 << g))
        g_def = bool(gpc_def & (1 << g))
        alive = [] if g_dis else [i for i in range(8) if not tdis & (1 << i)]
        now_tpc += len(alive)
        if g_dis:
            save = [] if g_def else bits(tdis & ~tdef, 8)
        else:
            save = bits(tdis & ~tdef, 8)
        rec_tpc += len(alive) + len(save)
        detail.append({
            "gpc": g, "blocked": g_dis, "defect": g_def,
            "alive_tpc": alive, "rescuable_tpc": save,
        })

    fbpa_dis = reg["STATUS_OPT_FBPA"] & 0xFFFFFF
    fbpa_def = reg["OPT_FBPA_DEFECTIVE"] & 0xFFFFFF
    fbpa_now = 24 - len(bits(fbpa_dis, 24))
    fbpa_save = bits(fbpa_dis & ~fbpa_def, 24)

    fbp_dis = reg["STATUS_OPT_FBP"] & 0xFFF
    fbp_def = reg["OPT_FBP_DEFECTIVE"] & 0xFFF
    fbp_save = bits(fbp_dis & ~fbp_def, 12)

    return {
        "file": path,
        "bdf": d["target"]["bdf"],
        "uuid": d["target"]["gpu_uuid"],
        "now_tpc": now_tpc, "now_sm": now_tpc * 2,
        "rec_tpc": rec_tpc, "rec_sm": rec_tpc * 2,
        "fbpa_now": fbpa_now, "fbpa_save_bits": fbpa_save,
        "vram_now": fbpa_now * FBPA_GIB,
        "vram_rec": (fbpa_now + len(fbpa_save)) * FBPA_GIB,
        "fbp_save_bits": fbp_save,
        "detail": detail,
    }


def main(argv):
    rows = [calc(p) for p in argv]
    rows = [r for r in rows if r]
    print(f"{'卡':5s} {'现状 SM':>8s} {'可救 SM':>8s} {'增量':>6s} {'现状显存':>9s} {'可救显存':>9s}")
    for r in rows:
        print(f"{r['file']:5s} {r['now_sm']:8d} {r['rec_sm']:8d} {r['rec_sm']-r['now_sm']:+6d} "
              f"{r['vram_now']:8d}G {r['vram_rec']:8d}G")
    print()
    for r in rows:
        print(f"== {r['file']} {r['bdf']}  FBPA 可救位 {r['fbpa_save_bits']}  FBP 可救位 {r['fbp_save_bits']}")
        for d in r["detail"]:
            tag = "整块禁用" + ("(带缺陷标记·不救)" if d["defect"] else "")
            if d["blocked"]:
                print(f"   GPC{d['gpc']:<2d} {tag} 可救 TPC {d['rescuable_tpc']} -> +{len(d['rescuable_tpc'])*2} SM")
            elif d["rescuable_tpc"]:
                print(f"   GPC{d['gpc']:<2d} 存活 现用 TPC {len(d['alive_tpc'])} 另可救 TPC {d['rescuable_tpc']} -> +{len(d['rescuable_tpc'])*2} SM")


if __name__ == "__main__":
    main(sys.argv[1:] or ["probe2-g0.json"])
