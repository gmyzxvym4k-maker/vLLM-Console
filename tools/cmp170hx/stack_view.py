#!/usr/bin/env python3
"""把 FBPA(24 位) / FBP(12 位) / FBIO(24 位) 掩码按 HBM stack 分组展开。

映射（数据反推，6 个 stack 全部自洽）：
  stack k  <=>  FBPA/FBIO 位 [4k, 4k+1, 4k+2, 4k+3]   （每 stack 4 个 FBPA 位 × 4 GiB = 16 GiB）
           <=>  FBP 位 [2k, 2k+1]                      （每 stack 2 个 FBP 位）
命名按 A~F 顺序（GA100 惯例，仅作标签）。

用法: python3 stack_view.py probe2-g0.json
"""
import json
import sys

GIB = 4
NAMES = "ABCDEF"


def bits(v, lo, hi):
    return [i for i in range(lo, hi) if v & (1 << i)]


def main(path):
    d = json.load(open(path, encoding="utf-8"))
    reg = {r["name"]: int(r["value"], 16) for r in d["registers"]}

    fbpa_dis = reg["STATUS_OPT_FBPA"] & 0xFFFFFF
    fbpa_def = reg["OPT_FBPA_DEFECTIVE"] & 0xFFFFFF
    fbio_dis = reg["STATUS_OPT_FBIO"] & 0xFFFFFF
    fbio_def = reg["OPT_FBIO_DEFECTIVE"] & 0xFFFFFF
    fbp_dis = reg["STATUS_OPT_FBP"] & 0xFFF
    fbp_def = reg["OPT_FBP_DEFECTIVE"] & 0xFFF

    print(f"{d['target']['bdf']} {d['target']['gpu_uuid']}")
    print(f"{'stack':7s} {'FBP位':6s} {'FBP态':14s} {'FBPA位':10s} {'FBIO位':10s} {'现状':7s} {'可救':7s}")
    total_now = total_rec = 0
    for k in range(6):
        fb_lo, fb_hi = 4 * k, 4 * k + 4
        fp_lo, fp_hi = 2 * k, 2 * k + 2
        a_dis = bits(fbpa_dis, fb_lo, fb_hi)
        a_def = bits(fbpa_def, fb_lo, fb_hi)
        i_dis = bits(fbio_dis, fb_lo, fb_hi)
        i_def = bits(fbio_def, fb_lo, fb_hi)
        p_dis = bits(fbp_dis, fp_lo, fp_hi)
        p_def = bits(fbp_def, fp_lo, fp_hi)
        now_bits = 4 - len(a_dis)
        save = [b for b in range(fb_lo, fb_hi) if b in a_dis and b not in a_def]
        now = now_bits * GIB
        rec = (now_bits + len(save)) * GIB
        total_now += now
        total_rec += rec
        fbptxt = ",".join(str(x) for x in p_dis) + (" [defect]" if p_def else "")
        state = "标坏" if p_def else ("禁用未标坏" if p_dis else "正常")
        print(f"{NAMES[k]}({k})   {fp_lo},{fp_hi-1}  {state:14s} {a_dis!s:10s} {i_dis!s:10s} {now:5d}G  {rec:5d}G")
        # 内部一致性断言：同一 stack 的 FBP 状态与 FBPA 状态必须同向
        if p_def and not a_def:
            print(f"   ! 不一致：stack {NAMES[k]} FBP 标坏但 FBPA 无 defect")
        if p_dis and not p_def and not a_dis:
            print(f"   ! 不一致：stack {NAMES[k]} FBP 禁用但 FBPA 全有效")
        if a_def and not p_def:
            print(f"   ! 不一致：stack {NAMES[k]} FBPA 标坏但 FBP 未标坏")
    print(f"合计：现状 {total_now} GiB，可救 {total_rec} GiB（+{total_rec-total_now}）")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "probe2-g0.json")
