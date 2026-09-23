#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""18420 Flash-Next 复读修复：采样参数三处统一 + inner 消费 FN_GENCFG。
落点：
  1) /home/ll/deploy/flash-next-w4a16-inner.sh
     - 新增 GENCFG_DEFAULT（新采样值），override-generation-config 改为 "${FN_GENCFG:-$GENCFG_DEFAULT}"
       （此前 inner 硬编码、不读 FN_GENCFG → 弹窗/预设采样参数静默失效）
     - 更新注释与行为一致
  2) /home/ll/deploy/server.js  SCRIPT_MODELS['qwen3.8-flash-next-w4a16'].base
     - temperature 0.3→0.6, presencePenalty 0.0→0.1, repetitionPenalty 1.0→1.05
  3) /home/ll/deploy/quickstart-presets.json  预设 p2p-mtp4 同步新采样值
备份后缀 .bak-gencfg-0921。幂等：已打过则跳过。"""
import json, shutil, sys

NEW = {"temperature": 0.6, "top_p": 0.95, "top_k": 20,
       "min_p": 0.0, "presence_penalty": 0.1, "repetition_penalty": 1.05}
NEW_JSON = json.dumps(NEW, separators=(",", ":"))
SUF = ".bak-gencfg-0921"

INNER = "/home/ll/deploy/flash-next-w4a16-inner.sh"
SERVER = "/home/ll/deploy/server.js"
PRESETS = "/home/ll/deploy/quickstart-presets.json"

def backup(p):
    shutil.copy2(p, p + SUF)

# ---------- 1) inner ----------
src = open(INNER, encoding="utf-8").read()
if "GENCFG_DEFAULT" in src:
    print("[inner] 已打过补丁，跳过")
else:
    old_comment = """  # 【2026-09-19 实测调优】temperature 1.0→0.3：MTP 接受率 34.1%→38.9%、接受长度 2.36→2.56、
  # decode 92.1→100.0 tok/s（4 组×3 prompt 配对实验，三 prompt 排序一致）。原值 1.0 见 .bak-temp03-0919
  # 同实验另发现 presence_penalty=1.5 是更大瓶颈（归零后接受率→44.0%、decode→110.0），但影响复读抑制，未改。
  --override-generation-config '{"temperature":0.3,"top_p":0.95,"top_k":20,"min_p":0.0,"presence_penalty":0.0,"repetition_penalty":1.0}'"""
    new_comment = """  # 【2026-09-21 复读修复】temperature 0.3→0.6、repetition_penalty 1.0→1.05、presence_penalty 0→0.1。
  # 0.3 是 09-19 为 MTP 接受率（34.1%→38.9%、decode 92→100 tok/s）刻意调低的，代价=循环复读；
  # 用户拍板优先治复读。presence 仅给 0.1（09-19 实验证高 presence 显著伤 MTP 接受率）。
  # 弹窗/快启预设的采样值经 FN_GENCFG 覆盖本缺省（此前 inner 不读 FN_GENCFG，预设采样值静默失效，已修）。
  # 与 server.js SCRIPT_MODELS.base、快启预设 p2p-mtp4 三处保持一致。
  --override-generation-config "${FN_GENCFG:-$GENCFG_DEFAULT}\""""
    assert src.count(old_comment) == 1, "inner 注释锚点非唯一"
    src = src.replace(old_comment, new_comment)
    # 在 ARGS 数组定义前插入 GENCFG_DEFAULT
    anchor = "ARGS=("
    idx = src.index(anchor)
    ins = ("# 采样参数缺省（可被 FN_GENCFG 覆盖；与 server.js SCRIPT_MODELS.base、快启预设 p2p-mtp4 一致）\n"
           "GENCFG_DEFAULT='%s'\n\n" % NEW_JSON)
    src = src[:idx] + ins + src[idx:]
    backup(INNER)
    open(INNER, "w", encoding="utf-8").write(src)
    print("[inner] 已打补丁")

# ---------- 2) server.js base ----------
src = open(SERVER, encoding="utf-8").read()
old = "blockSize: 1616, temperature: 0.3, topP: 0.95, topK: 20, minP: 0.0,\n    presencePenalty: 0.0, repetitionPenalty: 1.0, pp: 2, mtpTokens: 4,"
new = "blockSize: 1616, temperature: 0.6, topP: 0.95, topK: 20, minP: 0.0,\n    presencePenalty: 0.1, repetitionPenalty: 1.05, pp: 2, mtpTokens: 4,"
if new in src:
    print("[server.js] base 已是新值，跳过")
else:
    assert src.count(old) == 1, "server.js base 锚点非唯一"
    backup(SERVER)
    open(SERVER, "w", encoding="utf-8").write(src.replace(old, new))
    print("[server.js] base 已更新")

# ---------- 3) quickstart-presets.json p2p-mtp4 ----------
data = json.load(open(PRESETS, encoding="utf-8"))
hit = False
for card in data.values():
    for p in card.get("presets", []):
        if p.get("key") == "p2p-mtp4":
            prm = p["params"]
            if prm.get("temperature") == "0.6":
                print("[presets] p2p-mtp4 已是新值，跳过")
            else:
                prm["temperature"] = "0.6"
                prm["presencePenalty"] = "0.1"
                prm["repetitionPenalty"] = "1.05"
                hit = True
if hit:
    backup(PRESETS)
    with open(PRESETS, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("[presets] p2p-mtp4 已更新")

print("NEW_JSON =", NEW_JSON)
print("OK")
