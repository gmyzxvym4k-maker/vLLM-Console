#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
8889 控制台·基准测试「预填充」档位扩到 1M（10-05）

背景：bench 的 prefill 模式档位原先写死 5 档（1K/4K/16K/32K/64K），服务端还有一条
`n <= 131072` 的硬过滤——用户要把上下文档位一路加到 1M（受管实例本就是 1M/YaRN×4 档）。

本补丁只动 server.js 的 BENCH IIFE（仓库与线上该段逐字节一致，可同一份补丁双落）：
  R1 版本 2.2.1 → 2.3.0；新增 PF_MAX_TOKENS=1048576 / PF_MIN_TOKENS=256 与档位标签 pfLabel()
  R2 buildPrefillPrompt 改「轮转 unit + 倍增复制」并支持 maxChars 收口（1M 档 ≈280 万字符，
     原逐段拼接 3 万次；且顶格档必须留分词余量，否则被判 prompt is too long 白跑几百秒）
  R3 streamPrefill 失败时带上引擎原文（超上下文 / 显存不足 / OOM 的判因全在这句里）
  R4 档位表：256~1M 全接受；按配置快照里的引擎真实 max_model_len 收口，超档跳过并写事件；
     单档失败不再打死整轮（记 rec.error + 跳过该档剩余轮次，继续后面的档位）
  R5 buildFinal 剔除失败档、回传 failed 清单；完成事件用 pfLabel 并点名失败档数

用法（幂等，自动备份，改完 node --check）：
  python3 patches/patch-prefill-tiers-1005.py --check <file>   # 预演：只报当前状态
  python3 patches/patch-prefill-tiers-1005.py <file> ...       # 落刀
"""
import argparse
import os
import shutil
import subprocess
import sys

TAG = "prefill-tiers-1005"

R1_OLD = """  const VERSION = '2.2.1';
  const MODES = ['single', 'conc', 'prefill'];
"""
R1_NEW = """  const VERSION = '2.3.0';
  const MODES = ['single', 'conc', 'prefill'];
  // 预填充档位边界（10-05 扩档）：最高测到 1M tokens。引擎实际 max_model_len 更小时，
  // 超档位在开测前就跳过并写进事件流——绝不能让一次 400 把整轮测试打死。
  const PF_MAX_TOKENS = 1048576;
  const PF_MIN_TOKENS = 256;
  // 档位标签：与前端 fmtK 同口径（≥1M 记 M、≥1K 记 K，非整除留一位小数）
  function pfLabel(n) {
    n = +n || 0;
    if (n >= 1048576) { const m = n / 1048576; return (m % 1 ? m.toFixed(1) : m) + 'M'; }
    if (n >= 1024) { const k = n / 1024; return (k % 1 ? k.toFixed(1) : k) + 'K'; }
    return String(n);
  }
"""

R2_OLD = """  function buildPrefillPrompt(targetTokens, variant, ratio) {
    const chars = Math.max(Math.round(targetTokens * (ratio || 2.7)), 300);
    const header = `请阅读以下材料，读完后输出 OK 即可。\\n材料编号 V${variant}：\\n`;
    let out = header, i = 0;
    while (out.length < chars) { out += FILLERS[(i + variant) % FILLERS.length]; i++; }
    return out.slice(0, chars) + '\\n（材料结束）';
  }
"""
R2_NEW = """  // maxChars = 字符上限（按引擎 max_model_len 折算，防顶格档分词后超出被拒）
  function buildPrefillPrompt(targetTokens, variant, ratio, maxChars) {
    let chars = Math.max(Math.round(targetTokens * (ratio || 2.7)), 300);
    if (maxChars > 0 && chars > maxChars) chars = maxChars;
    const header = `请阅读以下材料，读完后输出 OK 即可。\\n材料编号 V${variant}：\\n`;
    // 1M 档约 280 万字符：原先逐段 while 拼接要三万多次（大字符串反复扩容），改成
    // 「8 段材料按 variant 轮转成一个 unit」再倍增复制，二十次内即到位；
    // 首段随 variant 变化 ⇒ 每轮/每档前缀都不同，前缀缓存照样命不中。
    const start = ((variant % FILLERS.length) + FILLERS.length) % FILLERS.length;
    let unit = '';
    for (let k = 0; k < FILLERS.length; k++) unit += FILLERS[(start + k) % FILLERS.length];
    let body = unit;
    while (body.length < chars) body += body;
    return header + body.slice(0, chars) + '\\n（材料结束）';
  }
"""

R3_OLD = """    const res = await fetch(baseUrl(s) + '/v1/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...svcKey(s) }, body, signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
"""
R3_NEW = """    const res = await fetch(baseUrl(s) + '/v1/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...svcKey(s) }, body, signal,
    });
    if (!res.ok) {
      // 带上引擎原文（截断）：超上下文 / 显存不足 / 引擎已死 的判因全在这句话里
      let detail = '';
      try { detail = (await res.text()).replace(/\\s+/g, ' ').slice(0, 260); } catch (e) {}
      throw new Error('HTTP ' + res.status + (detail ? ' · ' + detail : ''));
    }
"""

R4_OLD = """      if (mode === 'prefill' && prefill && prefill.enabled && Array.isArray(prefill.lengths) && prefill.lengths.length) {
        state.prefill = {};
        let ratio = 2.7;
        try {
          const cal = await streamPrefill(s, model, buildPrefillPrompt(1024, 997, ratio), runAc.signal);
          if (cal.promptTokens) ratio = Math.round(1024 * 2.7) / cal.promptTokens;
        } catch (e) {}
        const lens = prefill.lengths.filter((n) => n >= 256 && n <= 131072).sort((a, b) => a - b);
        for (let li = 0; li < lens.length; li++) {
          const target = lens[li];
          state.stage = 'prefill';
          state.stageNote = `预填充 ~${target >= 1024 ? (target / 1024) + 'K' : target} tokens`;
          state.progress = { phase: '预填充', cur: li + 1, total: lens.length, rep: 0, reps };
          const rec = { reps: [], running: true };
          state.prefill[target] = rec;
          for (let r = 0; r < reps; r++) {
            if (state.abort) throw new Error('aborted');
            state.progress.rep = r + 1;
            state.cur = { phase: '预填充', len: target, rep: r + 1, reps, tokens: 0, t0: Date.now() };
            const prompt = buildPrefillPrompt(target, r * 7 + li, ratio);
            const out = await streamPrefill(s, model, prompt, runAc.signal);
            const pt = out.promptTokens || Math.round(target * 0.9);
"""
R4_NEW = """      if (mode === 'prefill' && prefill && prefill.enabled && Array.isArray(prefill.lengths) && prefill.lengths.length) {
        state.prefill = {};
        let ratio = 2.7;
        try {
          const cal = await streamPrefill(s, model, buildPrefillPrompt(1024, 997, ratio), runAc.signal);
          if (cal.promptTokens) ratio = Math.round(1024 * 2.7) / cal.promptTokens;
        } catch (e) {}
        // 档位区间 256 ~ 1M（PF_MIN/PF_MAX），再用配置快照里的引擎真实 max_model_len 收一道。
        // 字符上限留 1.5% 余量：target*ratio 与实际分词数有偏差，且 max_tokens=1 也要占位，
        // 顶格档一旦被判「prompt is too long」就白跑几百秒，宁可少测 1.5%。
        const ctxCap = +((state.env && state.env.engineParams && state.env.engineParams.max_model_len) || 0);
        const charCap = ctxCap > 0 ? Math.floor(ctxCap * 0.985 * ratio) : 0;
        const uniq = Array.from(new Set(prefill.lengths.map(Number)));
        const bad = uniq.filter((n) => !(Number.isFinite(n) && n >= PF_MIN_TOKENS && n <= PF_MAX_TOKENS));
        const want = uniq.filter((n) => Number.isFinite(n) && n >= PF_MIN_TOKENS && n <= PF_MAX_TOKENS).sort((a, b) => a - b);
        const lens = ctxCap > 0 ? want.filter((n) => n <= ctxCap) : want;
        const over = want.filter((n) => lens.indexOf(n) < 0);
        if (bad.length) {
          addEvent(state, 'pf', '⏭ 非法/超 1M 的档位已忽略',
            '档位须在 ' + PF_MIN_TOKENS + ' ~ ' + PF_MAX_TOKENS + '（1M）之间，已忽略：'
            + bad.map((n) => '~' + pfLabel(n)).join(' / ') + '（要测 1M 以上得先提高引擎 max_model_len）');
        }
        if (over.length) {
          addEvent(state, 'pf', '⏭ 超引擎上下文的档位已跳过',
            '引擎 max_model_len=' + ctxCap + ' tok（' + pfLabel(ctxCap) + '），这些档测不了：'
            + over.map((n) => '~' + pfLabel(n)).join(' / ')
            + '。要测更高档位先在启动页把上下文切到 1M（YaRN×4）再重测');
        }
        if (!lens.length) {
          throw new Error('无档位可测：所选 ' + uniq.map((n) => '~' + pfLabel(n)).join(' / ')
            + ' 全部非法（限 ' + PF_MIN_TOKENS + ' ~ ' + PF_MAX_TOKENS + '）或超出引擎 max_model_len（' + (ctxCap || '未知') + ' tok）');
        }
        for (let li = 0; li < lens.length; li++) {
          const target = lens[li];
          const label = pfLabel(target);
          state.stage = 'prefill';
          state.stageNote = `预填充 ~${label} tokens` + (ctxCap > 0 ? `（引擎上限 ${pfLabel(ctxCap)}）` : '');
          state.progress = { phase: '预填充', cur: li + 1, total: lens.length, rep: 0, reps };
          const rec = { reps: [], running: true, target };
          state.prefill[target] = rec;
          for (let r = 0; r < reps; r++) {
            if (state.abort) throw new Error('aborted');
            state.progress.rep = r + 1;
            state.cur = { phase: '预填充', len: target, rep: r + 1, reps, tokens: 0, t0: Date.now() };
            const prompt = buildPrefillPrompt(target, r * 7 + li, ratio, charCap);
            let out;
            try {
              out = await streamPrefill(s, model, prompt, runAc.signal);
            } catch (e) {
              if (state.abort) throw new Error('aborted');
              // 单档失败不再打死整轮：记原因 + 跳过该档剩余轮次，继续测后面的档位
              rec.error = String((e && e.message) || e).slice(0, 400);
              break;
            }
            const pt = out.promptTokens || Math.round(target * 0.9);
"""

R4B_OLD = """            if (roundIso) await roundIsolate(s, state, '~' + (target >= 1024 ? (target / 1024) + 'K' : target) + 'tok 第' + (r + 1) + '轮后');
          }
          rec.running = false;
          addEvent(state, 'pf', '✔ 预填充 ~' + (target >= 1024 ? (target / 1024) + 'K' : target) + ' tok',
            rec.meanPtps + ' tok/s · TTFT ' + rec.meanTtft + 'ms · ' + reps + '轮 [' + rec.reps.map((x) => x.ptps).join(' / ') + ']');
"""
R4B_NEW = """            if (roundIso) await roundIsolate(s, state, '~' + label + 'tok 第' + (r + 1) + '轮后');
          }
          rec.running = false;
          if (rec.error) {
            addEvent(state, 'pf', '✖ 预填充 ~' + label + ' tok 失败', rec.error + '（该档剩余轮次已跳过，继续后面的档位）');
            continue;
          }
          addEvent(state, 'pf', '✔ 预填充 ~' + label + ' tok',
            rec.meanPtps + ' tok/s · TTFT ' + rec.meanTtft + 'ms · ' + reps + '轮 [' + rec.reps.map((x) => x.ptps).join(' / ') + ']');
"""

R5_OLD = """    if (mode === 'prefill') {
      const ks = Object.keys(state.prefill).map(Number).sort((a, b) => a - b);
      if (!ks.length) return null;
      const rows = ks.map((k) => ({ len: k, ptps: state.prefill[k].meanPtps, ttft: state.prefill[k].meanTtft, tokens: state.prefill[k].meanPromptTokens }));
      const best = rows.filter((r) => r.ptps).reduce((a, b) => (b.ptps > (a.ptps || 0) ? b : a), rows[0]);
      return { mode, rows, best };
    }
"""
R5_NEW = """    if (mode === 'prefill') {
      const ks = Object.keys(state.prefill).map(Number).sort((a, b) => a - b);
      if (!ks.length) return null;
      // 成功的档一律进表（哪怕 ptps 罕见地为 0），只有 error 档被摘出去点名——
      // 否则「跑了但没数」的档既不在 rows 也不在 failed，曲线上凭空少一格没人知道为什么
      const failed = ks.filter((k) => state.prefill[k].error);
      const ok = ks.filter((k) => !state.prefill[k].error);
      if (!ok.length) return null;
      const rows = ok.map((k) => ({ len: k, ptps: state.prefill[k].meanPtps, ttft: state.prefill[k].meanTtft, tokens: state.prefill[k].meanPromptTokens }));
      const best = rows.reduce((a, b) => ((b.ptps || 0) > (a.ptps || 0) ? b : a), rows[0]);
      // failed 原样回传：汇总里点名失败档，不静默丢档（否则曲线少两档没人知道为什么）
      return { mode, rows, best, total: ks.length, failed: failed.length ? failed : null };
    }
"""

R6_OLD = """        else head = '峰值 ~' + (state.final.best.len >= 1024 ? (state.final.best.len / 1024) + 'K' : state.final.best.len) + ' tok 档 ' + state.final.best.ptps + ' tok/s';
"""
R6_NEW = """        else head = '峰值 ~' + pfLabel(state.final.best.len) + ' tok 档 ' + state.final.best.ptps + ' tok/s'
          + (state.final.failed ? ('（另有 ' + state.final.failed.map((n) => '~' + pfLabel(n)).join(' / ') + ' 档失败）') : '');
"""

REPL = [("R1", R1_OLD, R1_NEW), ("R2", R2_OLD, R2_NEW), ("R3", R3_OLD, R3_NEW),
        ("R4", R4_OLD, R4_NEW), ("R4b", R4B_OLD, R4B_NEW), ("R5", R5_OLD, R5_NEW),
        ("R6", R6_OLD, R6_NEW)]


def node_bin():
    """/usr/bin:/bin 的精简 PATH 里没有 node（nvm 装的），逐个常见落点找。"""
    import glob
    p = shutil.which("node")
    if p:
        return p
    cands = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
    cands += sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/node")), reverse=True)
    cands += sorted(glob.glob(os.path.expanduser("~/.volta/bin/node")))
    return next((c for c in cands if os.path.exists(c)), "node")


def syntax_ok(path):
    r = subprocess.run([node_bin(), "--check", path], capture_output=True, text=True)
    return r.returncode == 0, (r.stderr or r.stdout or "").strip()[:400]


def patch(path, check_only):
    src = open(path, encoding="utf-8").read()
    done, todo, miss = [], [], []
    for name, old, new in REPL:
        if new in src:
            done.append(name)
        elif src.count(old) == 1:
            src = src.replace(old, new)
            todo.append(name)
        elif src.count(old) == 0:
            miss.append(name)
        else:
            miss.append(f"{name}(锚点 {src.count(old)} 处，不唯一)")
    if check_only:
        print(f"{path}: 已打 {done} / 可打 {todo} / 未命中 {miss}")
        return 0 if not miss else 1
    if miss:
        print(f"!! {path} 存在未命中锚点 {miss}，本次不落刀")
        return 1
    bak = f"{path}.bak-{TAG}-{os.environ.get('BAK_SUFFIX', 'local')}"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(src)
    ok, err = syntax_ok(path)
    if not ok:
        shutil.copy2(bak, path)
        print(f"!! {path} node --check 失败，已回滚到备份：\n{err}")
        return 1
    print(f"{path}: 补丁完成 {done + todo}（备份 {os.path.basename(bak)}，node --check 通过）")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--check", action="store_true", help="只预演不落刀")
    a = ap.parse_args()
    sys.exit(sum(patch(f, a.check) for f in a.files) and 1 or 0)
