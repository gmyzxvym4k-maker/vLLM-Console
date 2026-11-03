// tests/pages.test.js — 页面内联 JS 的加载 + 轮询行为仿真。
// 数据源 tests/fixtures/*.json 是从线上 8889 控制台抓的真实载荷（curl 落盘），
// 因此字段名/口径与浏览器实际收到的一致，仿真结论可直接采信。
// 运行：node tests/pages.test.js                （全部页面）
//       node tests/pages.test.js bench.html     （指定页面）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeEnv, drain } = require('./dom-mock.js');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

function inlineScripts(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) {
    if (/\bsrc\s*=/.test(m[1] || '')) continue;
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ line, code: '\n'.repeat(line) + m[2] });
  }
  return out;
}

const fixtures = {};
if (fs.existsSync(FIX)) {
  for (const f of fs.readdirSync(FIX)) {
    if (!f.endsWith('.json')) continue;
    try { fixtures['/' + f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')); } catch (e) {}
  }
}
// 路径 → fixture 名
function fixtureFor(u) {
  const p = u.split('?')[0];
  if (fixtures[p] !== undefined) return fixtures[p];
  const name = p.replace('/v1/internal/', '').replace(/\//g, '-');
  if (fixtures['/' + name] !== undefined) return fixtures['/' + name];
  if (p === '/v1/models') return { object: 'list', data: [{ id: 'qwen3.8-flash-next', object: 'model', owned_by: 'vllm' }] };
  if (p === '/admin/api/server-status') return fixtures['/server-status'];
  if (p === '/v1/internal/quickstart') return fixtures['/quickstart'];
  return {};
}

async function runPage(file, scenario) {
  const env = makeEnv();
  // 未 catch 的 Promise 拒绝 = 页面里的"静默死亡"（本项目多次踩过的轮询链打死形态），
  // 必须捕获进 errors，否则整条渲染链抛错也能"测试通过"。
  const onRej = (e) => env.errors.push('unhandledRejection: ' + ((e && (e.stack || e.message)) || String(e)));
  process.on('unhandledRejection', onRej);
  const scripts = inlineScripts(file);
  const ctx = vm.createContext(env.win);
  const report = { file, loadErrors: [], runtimeErrors: [], notes: [] };

  // fetch 必须在加载页面脚本之前装好：页面顶部的鉴权 IIFE 会在加载期
  // `const of = window.fetch.bind(window)` 捕获当时的 fetch，之后再换就无效了。
  const fetchCalls = [];
  env.setFetch(async (url) => {
    const u = typeof url === 'string' ? url : (url && url.url) || '';
    fetchCalls.push(u);
    const body = scenario.fetch(u, fetchCalls.length, env.now());
    if (body === 'never') return new Promise(() => {}); // 永不 settle（模拟标签页冻结后 fetch 被网络栈吞掉）
    if (body === 'fail') return { ok: false, status: 500, json: async () => ({ error: 'boom' }), text: async () => 'boom' };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  });

  for (const s of scripts) {
    try { vm.runInContext(s.code, ctx, { filename: file + ':' + s.line }); }
    catch (e) { report.loadErrors.push(`@line ${s.line}: ${e && e.message}`); }
  }
  await drain();

  const w = env.win;
  if (scenario.setup) { try { await scenario.setup(w, env, report); } catch (e) { report.runtimeErrors.push('setup: ' + (e && e.message)); } }

  const before = { text: env.counters.text, html: env.counters.html };
  await env.advance(scenario.ms || 20000, 100);
  const renders = { text: env.counters.text - before.text, html: env.counters.html - before.html };
  report.notes.push(`渲染写入 text+${renders.text} html+${renders.html}｜fetch ${fetchCalls.length} 次｜存活定时器 ${env.timerCount()}｜自愈 ${w.__dashRestarts || 0} 次`);
  if (scenario.assert) {
    const problems = scenario.assert(w, env, { renders, fetchCalls, report });
    (problems || []).forEach((p) => report.runtimeErrors.push('断言失败: ' + p));
  }
  process.off('unhandledRejection', onRej);
  report.runtimeErrors.push(...env.errors);
  return report;
}

// —— 场景库 ——
const live = (u) => fixtureFor(u);
const connected = async (w) => {};

// ==== [gpu-temp-1103]「GPU 温度曲线」绘制语义场景的公共件 ====
// canvas 在桩里是空函数，这里换成算子记录器，直接验"画了什么"：纵轴刻度、显存阈值参考线、
// 线尾打点，以及两种缺失形态是否真的断线——
//   ① 单卡缺值（点在、该卡两列 null）→ 只能靠 null 分支断线；
//   ② 整拍缺席（那几秒连点都没有）→ 只能靠时间缺口判据断线。
// 两条判据分场景各测一侧，任一分支被改掉对应场景必红（已做变异自测，防止断言写成空转）。
function gpuTempFixture(o) {
  const N = 1700000000;   // dom-mock 虚拟时钟原点（秒）
  const STEP = 15;        // 抽稀后每点间隔，必须与 sample_s 一致，否则正常步长会被当成缺口
  const points = [];
  for (let i = 0; i < 20; i++) {
    if (o.dropBeats && i >= 14 && i <= 17) continue;
    const t = N - 300 + i * STEP;
    const nullCell = !!(o.nullCells && i === 8);   // 只缺 1 拍（Δ=2×STEP=30s < 缺口判据 45s）→ 只能由 null 分支断线，与时间缺口判据互不遮蔽
    points.push({ t: t, g: {
      0: { c: 60 + i, m: 70 + i * 1.2 },
      1: nullCell ? { c: null, m: null } : { c: 58 + i, m: 68 + i },
    } });
  }
  return {
    ts: N * 1000, win_s: 300, sample_s: STEP, raw_points: 300, points: points,
    stats: {
      0: { core: { cur: 79, avg: 69.5, min: 60, max: 79, max_t: N - STEP, n: 20 }, mem: { cur: 92.8, avg: 81, min: 70, max: 92.8, max_t: N - STEP, n: 20 } },
      1: { core: { cur: 77, avg: 67.5, min: 58, max: 77, max_t: N - STEP, n: 20 }, mem: { cur: 87, avg: 77, min: 68, max: 87, max_t: N - STEP, n: 20 } },
    },
    first_t: points[0].t, last_t: points[points.length - 1].t, now_s: N,
    names: { 0: 'NVIDIA CMP 170HX', 1: 'NVIDIA CMP 170HX' },
    thresholds: { mem_warn: 85, mem_crit: 95, core_warn: 70, core_crit: 85 },
    live_age_s: 1, depth_s: 300,
  };
}
function gpuTempInstallRec(w) {
  const rec = { ops: [], text: [], arcs: 0 };
  const fake = new Proxy({}, { get: (t, k) => {
    if (k === 'fillText') return (txt) => { rec.ops.push('fillText'); rec.text.push(String(txt)); };
    if (k === 'moveTo' || k === 'lineTo' || k === 'beginPath' || k === 'stroke') return () => { rec.ops.push(String(k)); };
    if (k === 'arc') return () => { rec.arcs++; };
    if (k === 'measureText') return () => ({ width: 10 });
    return () => {};
  }, set: () => true });
  w.document.getElementById('gpuTempCanvas').getContext = () => fake;
  w.__gpuTempRec = rec;
  w.loadGpuTempTrend();
  return new Promise((r) => setImmediate(r)).then(() => {
    // 首帧已画完：冻结后续轮询重绘，断言只看这一次绘制的算子
    w.loadGpuTempTrend = () => Promise.resolve();
  });
}
// 每个 stroke 一组算子 → 该路径的子路径数：未断线=1，断一次=2。
// 绘制顺序固定为 5 条网格 + 2 条阈值线 + 每卡（显存、核心）两条序列，故末尾 4 组=四条序列。
function gpuTempSubpaths(rec) {
  const out = []; let cur = 0;
  for (const op of ((rec && rec.ops) || [])) {
    if (op === 'beginPath') cur = 0;
    else if (op === 'moveTo') cur++;
    else if (op === 'stroke') out.push(cur);
  }
  return out;
}

const scenarios = {
  'index.html': [
    { name: '正常轮询（真实线上载荷）', ms: 20000, fetch: live, setup: connected,
      assert: (w, env, r) => {
        const bad = [];
        if (r.renders.text + r.renders.html < 20) bad.push('20s 内几乎没有渲染写入（轮询链可能没跑起来）');
        if (r.fetchCalls.length < 10) bad.push('fetch 次数过少（轮询未持续）');
        return bad;
      } },
    { name: 'fetch 永不 settle → 看门狗应自愈', ms: 45000,
      // 前 5s 正常，之后所有 fetch 挂死（浏览器标签页被节能冻结后的真实形态：
      // pending fetch 既不 resolve 也不 reject，自建 abort 也不再派发）
      fetch: (u, n, t) => (t - 1700000000000 <= 5000 ? live(u) : 'never'), setup: connected,
      assert: (w, env, r) => (w.__dashRestarts >= 1 ? null : ['fetch 挂死 45s 未触发自愈（__dashRestarts=0）']) },
    { name: 'stats 返回 {} → 不得崩', ms: 15000,
      fetch: (u) => (u.indexOf('server-status') >= 0 ? fixtures['/server-status'] : (u.indexOf('stats') >= 0 ? {} : live(u))), setup: connected },
    { name: '全部接口 500 → 不得打死轮询', ms: 15000, fetch: () => 'fail', setup: connected,
      assert: (w, env, r) => (r.fetchCalls.length >= 5 ? null : ['接口 500 后轮询停止（fetch 仅 ' + r.fetchCalls.length + ' 次）']) },
    // [gpu-uptime-1029] 硬件监视页「GPU 累计通电时间」卡：真实形态载荷渲染 + 空态不崩 + 轮询续排
    { name: 'GPU 通电时间卡渲染（真实形态载荷）', ms: 8000, fetch: live,
      setup: async (w) => { w.loadGpuUptime(); await new Promise((r) => setImmediate(r)); },
      assert: (w, env, r) => {
        const bad = [];
        const rows = w.document.getElementById('upRows').innerHTML || '';
        if (rows.indexOf('CMP 170HX') < 0) bad.push('upRows 未渲染逐卡行（实得 ' + JSON.stringify(rows.slice(0, 80)) + '）');
        if (rows.indexOf('秒') < 0) bad.push('upRows 时长未到秒精度');
        if (rows.indexOf('出厂真值·Inforom') < 0) bad.push('inforom 主口径徽标未显示');
        if (rows.indexOf('之前') < 0) bad.push('系统口径对账（来本机之前）未显示');
        const sum = w.document.getElementById('upSummary').innerHTML || '';
        if (sum.indexOf('追溯起点') < 0) bad.push('upSummary 缺追溯起点');
        if (!/20\d\d-\d\d-\d\d \d\d:\d\d:\d\d/.test(sum)) bad.push('时间戳未带年份到秒（实得 ' + JSON.stringify(sum.slice(0, 140)) + '）');
        if (sum.indexOf('累计停机') < 0) bad.push('缺 窗口−停机=通电 对账核算');
        if (sum.indexOf('本次开机 自') < 0) bad.push('本次开机起点缺失（live_tail 未生效）');
        return bad;
      } },
    { name: 'GPU 通电时间卡：gpus=[]（首帧未就绪）→ 空态提示不崩', ms: 8000,
      fetch: (u) => (u.indexOf('gpu-uptime') >= 0 ? { ok: true, hardware_note: 'x', coverage_from: null, machine_power_on_sec: null, window_sec: null, downtime_sec: null, current_boot_since: null, boots_count: null, sources: null, live_tail: false, refreshed_at: null, error: '尚未完成首次采集', gpus: [] } : live(u)),
      setup: async (w) => { w.loadGpuUptime(); await new Promise((r) => setImmediate(r)); },
      assert: (w, env, r) => {
        const bad = [];
        const rows = w.document.getElementById('upRows').innerHTML || '';
        if (rows.indexOf('等待 GPU 静态信息') < 0) bad.push('空态提示缺失（实得 ' + JSON.stringify(rows.slice(0, 80)) + '）');
        const hint = w.document.getElementById('upHint').textContent || '';
        if (hint.indexOf('数据暂缺') < 0) bad.push('error 未透传到 upHint（实得 ' + JSON.stringify(hint) + '）');
        return bad;
      } },
    // [gpu-temp-1103] 硬件监视页「GPU 温度曲线」卡：显存主曲线 + 核心对照线；缺口留白不插值
    { name: 'GPU 温度曲线卡渲染（真实形态载荷）', ms: 8000, fetch: live,
      setup: async (w) => { w.loadGpuTempTrend(); await new Promise((r) => setImmediate(r)); },
      assert: (w, env, r) => {
        const bad = [];
        const legend = w.document.getElementById('gpuTempLegend').innerHTML || '';
        if (legend.indexOf('CMP 170HX') < 0) bad.push('图例未渲染逐卡（实得 ' + JSON.stringify(legend.slice(0, 90)) + '）');
        if (legend.indexOf('显存') < 0 || legend.indexOf('峰 ') < 0 || legend.indexOf('均 ') < 0) bad.push('图例缺显存现值/峰值/均值');
        if (legend.indexOf('核心') < 0) bad.push('未显示核心对照值（默认应开）');
        const hint = w.document.getElementById('storageGpuTempHint').textContent || '';
        if (hint.indexOf('逐秒采样') < 0) bad.push('hint 未显示采样口径（实得 ' + JSON.stringify(hint) + '）');
        if (hint.indexOf('85/95') < 0) bad.push('hint 未透传显存阈值 85/95（阈值分轨口径）');
        const meta = w.document.getElementById('gpuTempMeta').textContent || '';
        if (meta.indexOf('粗实线 = 显存') < 0) bad.push('meta 未标主线口径（实得 ' + JSON.stringify(meta) + '）');
        if (meta.indexOf('最热显存') < 0) bad.push('meta 未给窗口内最热显存值');
        if (meta.indexOf('不插值') < 0) bad.push('meta 未标缺口口径（留白=未采到）');
        if (!r.fetchCalls.some((x) => x.indexOf('/v1/internal/gpu-temp?win=') >= 0)) bad.push('未轮询 /v1/internal/gpu-temp');
        return bad;
      } },
    { name: 'GPU 温度曲线卡：显存列全缺（驱动不返回 temperature.memory）→ 标不可用，绝不画 0 ℃', ms: 8000,
      fetch: (u) => (u.indexOf('gpu-temp') >= 0 ? (() => {
        const n = Math.floor(Date.now() / 1000);
        return { ts: n * 1000, win_s: 600, sample_s: 10, raw_points: 3,
          points: [{ t: n - 30, g: { 0: { c: 61, m: null } } }, { t: n - 20, g: { 0: { c: 62, m: null } } }, { t: n - 10, g: { 0: { c: 63, m: null } } }],
          stats: { 0: { core: { cur: 63, avg: 62, min: 61, max: 63, max_t: null, n: 3 }, mem: { cur: null, avg: null, min: null, max: null, max_t: null, n: 0 } } },
          now_s: n, names: { 0: 'NVIDIA CMP 170HX' },
          thresholds: { mem_warn: 85, mem_crit: 95, core_warn: 70, core_crit: 85 }, live_age_s: 1, depth_s: 300 };
      })() : live(u)),
      setup: async (w) => { w.loadGpuTempTrend(); await new Promise((r) => setImmediate(r)); },
      assert: (w, env, r) => {
        const legend = w.document.getElementById('gpuTempLegend').innerHTML || '';
        const bad = [];
        if (legend.indexOf('显存温度不可用') < 0) bad.push('未标"显存温度不可用"（实得 ' + JSON.stringify(legend.slice(0, 120)) + '）');
        if (legend.indexOf('显存 <b') >= 0) bad.push('缺失值被当成测量值画出了数值');
        return bad;
      } },
    { name: 'GPU 温度曲线卡：采样中断 90s（驱动熔断）→ 黄字明示曲线停更，不得静默', ms: 8000,
      fetch: (u) => (u.indexOf('gpu-temp') >= 0 ? Object.assign({}, fixtureFor(u), { live_age_s: 90 }) : live(u)),
      setup: async (w) => { w.loadGpuTempTrend(); await new Promise((r) => setImmediate(r)); },
      assert: (w, env, r) => {
        const hint = w.document.getElementById('storageGpuTempHint').textContent || '';
        return (hint.indexOf('采样已中断 90 秒') >= 0) ? null : ['未透传采样中断提示（实得 ' + JSON.stringify(hint) + '）'];
      } },
    { name: 'GPU 温度曲线卡：接口 500 → 保留上一帧，轮询不得停', ms: 15000,
      fetch: (u) => (u.indexOf('gpu-temp') >= 0 ? 'fail' : live(u)),
      setup: async (w) => { w.loadGpuTempTrend(); await new Promise((r) => setImmediate(r)); },
      assert: (w, env, r) => {
        const n = r.fetchCalls.filter((x) => x.indexOf('gpu-temp') >= 0).length;
        return n >= 5 ? null : ['取数失败后轮询停止（gpu-temp 仅 ' + n + ' 次）'];
      } },
    // 绘制语义：canvas 的 ctx 在桩里是空函数，这里换成记录器，直接验"画了什么"——
    // 纵轴刻度、显存阈值线、缺口是否真的断线（不是连成一条斜线骗眼睛）、线尾打点。
    { name: 'GPU 温度曲线卡：绘制语义·单卡缺值断线 + 阈值线 + 线尾打点', ms: 8000,
      fetch: (u) => (u.indexOf('gpu-temp') < 0 ? live(u) : gpuTempFixture({ nullCells: true, dropBeats: false })),
      setup: async (w) => gpuTempInstallRec(w),
      assert: (w, env, r) => {
        const rec = w.__gpuTempRec || { ops: [], text: [], arcs: 0 };
        const bad = [];
        const txt = rec.text.join(' | ');
        if (rec.text.length < 5) bad.push('画布几乎没有落笔（fillText ' + rec.text.length + ' 次）');
        if (txt.indexOf('显存警戒 85') < 0 || txt.indexOf('显存危险 95') < 0) bad.push('显存阈值参考线未画（实得 ' + txt + '）');
        if (!/\d+ ℃/.test(txt)) bad.push('纵轴无 ℃ 刻度');
        const sp = gpuTempSubpaths(rec).slice(-4);
        if (sp.length !== 4) bad.push('序列线条数应为 4（2 卡 × 显存/核心），实得 ' + sp.length);
        else {
          if (!(sp[2] >= 2 && sp[3] >= 2)) bad.push('GPU1 单卡缺值处未断线（子路径 ' + JSON.stringify(sp) + '，曲线被连成假直线）');
          if (sp[0] !== 1 || sp[1] !== 1) bad.push('GPU0 全程有值却被误断线（子路径 ' + JSON.stringify(sp) + '）');
        }
        if (rec.arcs !== 2) bad.push('线尾当前值打点应每卡一个，实得 ' + rec.arcs);
        return bad;
      } },
    { name: 'GPU 温度曲线卡：绘制语义·整拍缺席按时间缺口断线', ms: 8000,
      fetch: (u) => (u.indexOf('gpu-temp') < 0 ? live(u) : gpuTempFixture({ nullCells: false, dropBeats: true })),
      setup: async (w) => gpuTempInstallRec(w),
      assert: (w, env, r) => {
        const rec = w.__gpuTempRec || { ops: [] };
        const sp = gpuTempSubpaths(rec).slice(-4);
        const bad = [];
        if (sp.length !== 4) bad.push('序列线条数应为 4，实得 ' + sp.length);
        else if (sp.some((n) => n < 2)) bad.push('整拍缺席处未断线（子路径 ' + JSON.stringify(sp) + '：连续 4 拍没有样本点却连成一条线）');
        return bad;
      } },
  ],
  'bench.html': [
    { name: '加载 + 轮询（真实 run 载荷）', ms: 15000, fetch: live,
      assert: (w, env, r) => (r.renders.text + r.renders.html > 0 ? null : ['bench 页面加载后没有任何渲染']) },
    { name: 'run 载荷字段残缺（summary=null 等）→ 渲染抛错不得打死轮询', ms: 20000,
      fetch: (u) => (u.indexOf('/bench/run') >= 0 ? { runId: 2, status: 'running', stage: 'single', single: { '代码': { reps: [{ tps: 50, ttft: 100 }] } }, conc: null, prefill: null, summary: null, final: null } : live(u)),
      assert: (w, env, r) => (r.fetchCalls.filter((x) => x.indexOf('/bench/run') >= 0).length >= 5 ? null : ['渲染抛错后 /bench/run 轮询停止']) },
  ],
  'vllm.html': [{ name: '加载 + 轮询', ms: 15000, fetch: live }],
  'sglang.html': [{ name: '加载 + 轮询', ms: 15000, fetch: live }],
  'cpu.html': [{ name: '加载 + 轮询', ms: 15000, fetch: live }],
  // [card-compute 1016] 「卡算力」标签内嵌页（部署在 static/compute.html）：
  // 数据源 GET /v1/internal/gpu（静态+实时合并帧）+ GET /v1/internal/gpu-ctl（限频原因位）。
  'compute.html': [
    { name: '加载 + 轮询（真实线上载荷）', ms: 15000, fetch: live,
      assert: (w, env, r) => {
        const bad = [];
        if (r.renders.text + r.renders.html < 10) bad.push('15s 内几乎没有渲染写入（轮询链可能没跑起来）');
        if (!r.fetchCalls.some((x) => x.indexOf('/v1/internal/gpu?') >= 0)) bad.push('未轮询 /v1/internal/gpu');
        if (!r.fetchCalls.some((x) => x.indexOf('/v1/internal/gpu-ctl?') >= 0)) bad.push('未轮询 /v1/internal/gpu-ctl');
        return bad;
      } },
    { name: '全部接口 500 → 保留画面 + 黄条，轮询不得停', ms: 20000, fetch: () => 'fail',
      assert: (w, env, r) => (r.fetchCalls.filter((x) => x.indexOf('/v1/internal/gpu') >= 0).length >= 10 ? null : ['接口 500 后轮询停止（fetch 仅 ' + r.fetchCalls.length + ' 次）']) },
    { name: 'gpu 帧 gpus=[]（驱动熔断）→ 空态提示且轮询继续', ms: 15000,
      fetch: (u) => (u.indexOf('/v1/internal/gpu') >= 0 && u.indexOf('gpu-ctl') < 0 ? { supported: false, gpus: [], error: '熔断' } : live(u)),
      assert: (w, env, r) => (r.fetchCalls.filter((x) => x.indexOf('/v1/internal/gpu?') >= 0).length >= 5 ? null : ['空帧后轮询停止']) },
  ],
  // [client-ips 1027] 「调用方 IP」标签内嵌页（部署在 static/client-ips.html）：
  // 数据源 GET /v1/internal/client-ips（引擎访问日志 tail + /v1 代理入口聚合，含归属地）。
  'client-ips.html': [
    { name: '加载 + 轮询（真实载荷形态）', ms: 15000, fetch: live,
      assert: (w, env, r) => {
        const bad = [];
        if (r.renders.text + r.renders.html < 10) bad.push('15s 内几乎没有渲染写入（轮询链可能没跑起来）');
        if (!r.fetchCalls.some((x) => x.indexOf('/v1/internal/client-ips?') >= 0)) bad.push('未轮询 /v1/internal/client-ips');
        return bad;
      } },
    { name: '全部接口 500 → 保留画面 + 黄条，轮询不得停', ms: 20000, fetch: () => 'fail',
      assert: (w, env, r) => (r.fetchCalls.filter((x) => x.indexOf('/v1/internal/client-ips') >= 0).length >= 5 ? null : ['接口 500 后轮询停止（fetch 仅 ' + r.fetchCalls.length + ' 次）']) },
    { name: 'ips=[]（刚清空统计）→ 空态提示且轮询继续', ms: 15000,
      fetch: (u) => (u.indexOf('/v1/internal/client-ips') >= 0 ? { ok: true, now: Date.now(), windowSec: 60, totals: { unique: 0, active: 0, modelTotal: 0, probeTotal: 0, publicN: 0, modelIps: 0 }, ips: [], meta: { logFile: 'x.log', logKind: 'file', proxyPending: 0, geoPending: 0, geoEnabled: true, seeded: true, config: { activeWindowSec: 60, retentionDays: 30, maxIps: 800, geoEnabled: true } } } : live(u)),
      assert: (w, env, r) => (r.fetchCalls.filter((x) => x.indexOf('/v1/internal/client-ips') >= 0).length >= 4 ? null : ['空列表后轮询停止']) },
  ],
  'mobile.html': [{ name: '加载 + 轮询', ms: 15000, fetch: live }],
  // [strata-remote-monitor 1008] 「Strata 监控」标签内嵌页：克隆 .38:8080 Web UI Monitor。
  // fixture strata-remote.json = 控制台代理 GET /v1/internal/strata-remote 的真实载荷
  // （{ok,base,metrics,health,mcp}，metrics 即远端 Strata /metrics 原样转发）。
  'strata-monitor.html': [
    { name: '加载 + 轮询（真实远端载荷）', ms: 15000, fetch: live,
      assert: (w, env, r) => (r.renders.text + r.renders.html > 0 ? null : ['strata-monitor 加载后没有任何渲染']) },
    { name: '代理 ok:false（远端不可达）→ 保留画面 + 黄条，轮询不得停', ms: 20000,
      fetch: (u) => (u.indexOf('strata-remote') >= 0 ? { ok: false, msg: '远端 Strata /metrics 不可达：aborted' } : live(u)),
      assert: (w, env, r) => (r.fetchCalls.filter((x) => x.indexOf('strata-remote') >= 0).length >= 10 ? null : ['远端不可达时轮询停止（fetch 仅 ' + r.fetchCalls.length + ' 次）']) },
    { name: 'metrics 字段残缺（live/hardware 缺失）→ 渲染抛错不得打死轮询', ms: 20000,
      fetch: (u) => (u.indexOf('strata-remote') >= 0 ? { ok: true, base: 'http://x', metrics: { requests: [] }, health: null, mcp: null } : live(u)),
      assert: (w, env, r) => (r.fetchCalls.filter((x) => x.indexOf('strata-remote') >= 0).length >= 10 ? null : ['字段残缺抛错后轮询停止']) },
    { name: '电源控制：点唤醒 → POST /cmd 发出且结果回显、按钮恢复可用', ms: 3000,
      fetch: (u) => (u.indexOf('strata-remote/cmd') >= 0 ? { ok: true, action: 'wake', msg: '魔术包已发往 192.168.1.255 / 255.255.255.255' } : live(u)),
      setup: async (w) => { w.pwrPost('wake'); await new Promise((r) => setImmediate(r)); },
      assert: (w, env, r) => {
        const bad = [];
        if (!r.fetchCalls.some((x) => x.indexOf('strata-remote/cmd') >= 0)) bad.push('未向 /v1/internal/strata-remote/cmd 发 POST');
        const msg = w.document.getElementById('pwrMsg').textContent;
        if (!msg || msg.indexOf('魔术包') < 0) bad.push('pwrMsg 未回显后端 msg（实际：' + JSON.stringify(msg) + '）');
        return bad;
      } },
  ],
};

(async () => {
  const files = process.argv.slice(2);
  const targets = files.length ? files : Object.keys(scenarios);
  let fail = 0;
  for (const f of targets) {
    const list = scenarios[f] || [{ name: '仅加载', ms: 3000 }];
    for (const sc of list) {
      const r = await runPage(f, sc);
      const bad = r.loadErrors.length || r.runtimeErrors.length;
      if (bad) fail++;
      console.log(`\n=== ${f} · ${sc.name} === ${bad ? '✗' : '✓'}`);
      r.notes.forEach((n) => console.log('   ' + n));
      r.loadErrors.forEach((e) => console.log('   LOAD-ERR ' + e));
      r.runtimeErrors.slice(0, 15).forEach((e) => console.log('   RUN-ERR  ' + String(e).split('\n')[0]));
      if (r.runtimeErrors.length > 15) console.log(`   RUN-ERR  …共 ${r.runtimeErrors.length} 条`);
    }
  }
  console.log(`\n场景失败数：${fail}`);
  process.exit(fail ? 1 : 0);
})();
