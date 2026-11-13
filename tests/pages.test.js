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
    // 断言抛错必须记为失败，不能让它打断主循环：此前 assert 里一个 TypeError 会让
    // runPage 的 Promise 直接 reject、await 抛出后整个测试静默结束、退出码仍是 0
    // （1103 的 dom-mock 假绿是同类问题，只是那条在 esc() 侧）。现在统一收进 runtimeErrors，
    // 「测试跑到一半就没了」这种形态会显式变红，而不是看起来全绿。
    try {
      const problems = scenario.assert(w, env, { renders, fetchCalls, report });
      (problems || []).forEach((p) => report.runtimeErrors.push('断言失败: ' + p));
    } catch (e) {
      report.runtimeErrors.push('断言抛错: ' + msg(e));
    }
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

// [dash-prefs 1113] 页面把注册表显式导出到 window.__dashPrefsRegistry（顶层 const 不挂 window）。
// 这里统一走 R(w)；页面未加载成功时返回空壳并把缺失记进 w.__dashPrefsMissing，
// 断言据此给出「模块没加载」而不是抛 TypeError（后者会打断整个测试，见 runPage 的断言兜底）。
function R(w) {
  const reg = w && w.__dashPrefsRegistry;
  if (reg) return reg;
  if (w) w.__dashPrefsMissing = true;
  const noop = () => ({});
  return { all: [], blocks: [], metrics: [], apply: () => ({ hit: 0, miss: [], hidden: 0 }),
    read: () => [], write: noop, isHidden: () => false, set: () => false, refresh: noop };
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
    // ==== [dash-prefs 1113] 仪表盘区块显示 / 隐藏配置 ====
    // 这批场景盯的是「配置契约」而非像素：未配置=全显示、隐藏只加类、配置失效不污染、
    // 全部隐藏有兜底、申明不存在的 key 会被过滤。每条都做了「删掉对应实现必红」的变异自测。
    { name: '仪表盘显示设置：未配置 → 全部区块显示（默认行为零漂移）', ms: 3000, fetch: live,
      setup: async (w) => { R(w).apply(); R(w).refresh(); },
      assert: (w, env, r) => {
        const bad = [];
        if (typeof w.dashPrefsApply !== 'function') return ['dashPrefsApply 未定义（模块没加载）'];
        // 注册表里每一项都必须能在页面上找到对应元素——脱节会表现为「配置了却什么也没发生」
        if (!R()) return ['页面未导出 __dashPrefsRegistry（dash-prefs 模块没加载）'];
        const res = R(w).apply();
        if (!res || res.miss.length) bad.push('注册表 id 未命中：' + JSON.stringify(res && res.miss));
        if (res && res.hidden !== 0) bad.push('未配置时 hidden 应为 0（实得 ' + res.hidden + '）');
        ['dashKpiGpuMem', 'dashTokenCard', 'billingCard', 'gpuQueueCard', 'dashConcCard', 'sysDetailCard', 'dashMetricTtft'].forEach((id) => {
          if (w.document.getElementById(id).classList.contains('dash-block-hidden')) bad.push(id + ' 未配置却被隐藏');
        });
        if (w.document.getElementById('dashAllHiddenBar').style.display === 'flex') bad.push('未配置却显示「全部隐藏」兜底条');
        return bad;
      } },
    { name: '仪表盘显示设置：隐藏单个区块 → 只加类，取数与轮询不受影响', ms: 12000, fetch: live,
      setup: async (w) => {
        R(w).write(['block.billing']);
        R(w).apply();
        await new Promise((r) => setImmediate(r));
      },
      assert: (w, env, r) => {
        const bad = [];
        if (!w.document.getElementById('billingCard').classList.contains('dash-block-hidden')) bad.push('billingCard 未被隐藏');
        if (w.document.getElementById('gpuQueueCard').classList.contains('dash-block-hidden')) bad.push('gpuQueueCard 被误隐藏（越界影响）');
        // 铁律：显示偏好只影响渲染，不得反向影响数据链路——隐藏后轮询必须照常推进
        if (r.fetchCalls.length < 8) bad.push('隐藏区块后 fetch 次数骤降（' + r.fetchCalls.length + '），取数链路被显示配置影响');
        if (r.renders.text + r.renders.html < 20) bad.push('隐藏区块后渲染几乎停止（' + (r.renders.text + r.renders.html) + '）');
        return bad;
      } },
    { name: '仪表盘显示设置：KPI 四张全隐藏 → 外层栅格行一并收掉（不留空洞）', ms: 3000, fetch: live,
      setup: async (w) => {
        R(w).write(['kpi.gpumem', 'kpi.util', 'kpi.powertemp', 'kpi.mem']);
        R(w).apply();
      },
      assert: (w, env, r) => {
        const bad = [];
        if (!w.document.getElementById('dashKpiRow').classList.contains('dash-block-hidden')) bad.push('KPI 卡全隐藏后 dashKpiRow 未收掉（会留空行）');
        // 只收容器、不收卡片本身：单张恢复时靠的是卡片自己的类
        if (!w.document.getElementById('dashKpiMem').classList.contains('dash-block-hidden')) bad.push('dashKpiMem 未被隐藏');
        return bad;
      } },
    { name: '仪表盘显示设置：Token 卡与能耗卡同隐 → 整行收掉；只隐其一则保留行', ms: 3000, fetch: live,
      setup: async (w) => {
        R(w).write(['block.token']);
        R(w).apply();
        w.__rowA = w.document.getElementById('dashTokenRow').classList.contains('dash-block-hidden');
        R(w).write(['block.token', 'block.energy']);
        R(w).apply();
        w.__rowB = w.document.getElementById('dashTokenRow').classList.contains('dash-block-hidden');
      },
      assert: (w) => {
        const bad = [];
        if (w.__rowA) bad.push('只隐藏 Token 卡时整行就被收掉了（能耗卡会一起消失）');
        if (!w.__rowB) bad.push('两张卡都隐藏后整行未收掉（留空行）');
        return bad;
      } },
    { name: '仪表盘显示设置：全部区块隐藏 → 兜底条出现，恢复后消失', ms: 3000, fetch: live,
      setup: async (w) => {
        R(w).write(R(w).all.map((b) => b.key));
        R(w).apply();
        R(w).refresh();
      },
      assert: (w) => {
        const bad = [];
        if (w.document.getElementById('dashAllHiddenBar').style.display !== 'flex') bad.push('全部隐藏后兜底条未出现（会白屏且无恢复入口）');
        if (!w.document.getElementById('dashKpiRow').classList.contains('dash-block-hidden')) bad.push('全部隐藏后 KPI 行未收掉');
        // 页头入口必须常驻且带已隐藏计数——这是恢复路径，不能被配置自己藏掉
        const t = w.document.getElementById('dashPrefsTrigger');
        if (t.classList.contains('dash-block-hidden')) bad.push('页头「显示设置」入口被配置藏掉了（自锁风险）');
        const lab = w.document.getElementById('dashPrefsTriggerLabel').textContent || '';
        if (lab.indexOf(String(R(w).all.length)) < 0) bad.push('入口角标未显示已隐藏数（实得 ' + JSON.stringify(lab) + '）');
        // 恢复默认后兜底条必须消失
        try { w.localStorage.removeItem('dashHiddenBlocks'); } catch (e) {}
        R(w).apply();
        if (w.document.getElementById('dashAllHiddenBar').style.display === 'flex') bad.push('恢复默认后兜底条仍在');
        return bad;
      } },
    { name: '仪表盘显示设置：脏配置（未知 key / 非数组 / 坏 JSON）→ 过滤后不污染', ms: 3000, fetch: live,
      setup: async (w) => {
        w.localStorage.setItem('dashHiddenBlocks', JSON.stringify(['ghost.key', 'block.billing', 123]));
        w.__read1 = R(w).read();
        w.localStorage.setItem('dashHiddenBlocks', 'not-json{{{');
        w.__read2 = R(w).read();
        w.localStorage.setItem('dashHiddenBlocks', JSON.stringify({ a: 1 }));
        w.__read3 = R(w).read();
        R(w).apply();
      },
      assert: (w) => {
        const bad = [];
        if (JSON.stringify(w.__read1) !== JSON.stringify(['block.billing'])) bad.push('未知 key/非字符串未被过滤（实得 ' + JSON.stringify(w.__read1) + '）');
        if (!Array.isArray(w.__read2) || w.__read2.length) bad.push('坏 JSON 未降级为空数组（实得 ' + JSON.stringify(w.__read2) + '）');
        if (!Array.isArray(w.__read3) || w.__read3.length) bad.push('非数组未降级为空数组（实得 ' + JSON.stringify(w.__read3) + '）');
        if (w.document.getElementById('sysDetailCard').classList.contains('dash-block-hidden')) bad.push('脏配置把无关区块隐藏了');
        return bad;
      } },
    { name: '仪表盘显示设置：dashBlockSet 单向开关（含非法 key 拒绝）', ms: 3000, fetch: live,
      setup: async (w) => {
        w.__ok1 = R(w).set('block.billing', false);
        w.__hid1 = R(w).isHidden('block.billing');
        w.__ok2 = R(w).set('block.billing', true);
        w.__hid2 = R(w).isHidden('block.billing');
        w.__ok3 = R(w).set('nope.key', false);
        w.__hid3 = R(w).isHidden('nope.key');
      },
      assert: (w) => {
        const bad = [];
        if (!w.__ok1 || !w.__hid1) bad.push('dashBlockSet(key,false) 未生效');
        if (!w.__ok2 || w.__hid2) bad.push('dashBlockSet(key,true) 未恢复');
        if (w.__ok3 || w.__hid3) bad.push('非法 key 未被拒绝');
        return bad;
      } },
    { name: '仪表盘显示设置：配置项与页面元素一一对应（id 存在性 + 无重复 key/id）', ms: 3000, fetch: live,
      setup: async (w) => { R(w).apply(); },
      assert: (w) => {
        const bad = [];
        const all = R(w).all || [];
        if (all.length < 20) bad.push('注册表项过少（实得 ' + all.length + '）');
        const keys = new Set(), ids = new Set();
        all.forEach((b) => {
          if (keys.has(b.key)) bad.push('key 重复：' + b.key);
          if (ids.has(b.id)) bad.push('id 重复：' + b.id);
          keys.add(b.key); ids.add(b.id);
          if (!w.document.getElementById(b.id)) bad.push('注册表 id 在页面上不存在：' + b.id);
          if (!b.label || !b.group) bad.push('项缺 label/group：' + b.key);
        });
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
        // 纵轴刻度必须是 5 的整档且等距——原实现按 (top-bottom)/4 等分，线上截图实锤得到
        // 44/63/81 这种读不出来的刻度（1103 修）。
        const ticks = rec.text.filter((t) => /^\d+ ℃$/.test(t)).map((t) => parseInt(t, 10));
        if (ticks.length < 3) bad.push('纵轴刻度少于 3 条（实得 ' + JSON.stringify(ticks) + '）');
        else {
          if (ticks.some((v) => v % 5 !== 0)) bad.push('纵轴刻度不是 5 的整档：' + JSON.stringify(ticks));
          const diffs = ticks.slice(1).map((v, i) => v - ticks[i]);
          if (new Set(diffs).size !== 1) bad.push('纵轴刻度不等距：' + JSON.stringify(ticks));
        }
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
    // [gpu-ecc-1108] 硬件监视页「GPU ECC 状态与报错」卡：真实形态载荷渲染 + 关闭红标 + 500 保帧 + DBE 显色
    { name: 'GPU ECC 卡渲染（真实形态载荷）', ms: 8000, fetch: live,
      setup: async (w) => { w.loadGpuEcc(); await new Promise((r) => setImmediate(r)); },
      assert: (w, env, r) => {
        const bad = [];
        const rows = w.document.getElementById('eccGpuRows').innerHTML || '';
        if (rows.indexOf('CMP 170HX') < 0) bad.push('eccGpuRows 未渲染逐卡行（实得 ' + JSON.stringify(rows.slice(0, 80)) + '）');
        if (rows.indexOf('已开启') < 0) bad.push('ECC 模式列未渲染开启态');
        if (rows.indexOf('6.16') < 0) bad.push('Inforom ECC 版本未显示');
        if (rows.indexOf('正常（无 ECC 报错）') < 0) bad.push('健康状态列未显示 status_label');
        if (rows.indexOf('--') < 0) bad.push('本机 N/A 列（L2/行重映射/页退役）未按 -- 口径显示');
        const sum = w.document.getElementById('eccSummary').innerHTML || '';
        if (sum.indexOf('ECC 开启') < 0 || sum.indexOf('终身 DBE') < 0) bad.push('摘要缺 显卡数/ECC 开启/终身 DBE 段位');
        if (sum.indexOf('自基线新增') < 0) bad.push('摘要缺 自基线新增 段位');
        const evts = w.document.getElementById('eccEventRows').innerHTML || '';
        if (evts.indexOf('Xid 13') < 0) bad.push('报错记录未渲染内核 Xid 事件');
        if (evts.indexOf('非 ECC') < 0) bad.push('Xid 未按 ECC 类/非 ECC 分标');
        if (evts.indexOf('首次观测') < 0) bad.push('first_seen 事件未渲染');
        const hint = w.document.getElementById('eccHint').textContent || '';
        if (hint.indexOf('采样每 30s') < 0) bad.push('hint 未显示采样周期（实得 ' + JSON.stringify(hint) + '）');
        return bad;
      } },
    { name: 'GPU ECC 卡：ECC 关闭的卡 → 显式红标「已关闭」（位翻转不可检测≠健康）', ms: 8000,
      fetch: (u) => (u.indexOf('gpu-ecc') < 0 ? live(u) : (() => {
        const d = JSON.parse(JSON.stringify(fixtures['/gpu-ecc']));
        const g = d.gpus[0];
        g.mode_current = 'Disabled'; g.mode_pending = 'Disabled'; g.mode_on = false;
        g.status = 'disabled'; g.status_label = 'ECC 已关闭（位翻转不可检测）';
        Object.keys(g.counters).forEach((k) => { g.counters[k] = null; });
        d.summary.ecc_on = 2; d.summary.ecc_off = 1;
        return d;
      })()),
      setup: async (w) => { w.loadGpuEcc(); await new Promise((r) => setImmediate(r)); },
      assert: (w, env, r) => {
        const bad = [];
        const rows = w.document.getElementById('eccGpuRows').innerHTML || '';
        if (rows.indexOf('已关闭') < 0) bad.push('未渲染关闭态标记');
        if (rows.indexOf('var(--red)') < 0) bad.push('关闭态未用红色（disabled=红，不得当正常）');
        const sum = w.document.getElementById('eccSummary').innerHTML || '';
        if (sum.indexOf('（关闭 1）') < 0) bad.push('摘要未透传关闭卡计数（实得 ' + JSON.stringify(sum.slice(0, 120)) + '）');
        return bad;
      } },
    { name: 'GPU ECC 卡：接口 500 → 保留上一帧，轮询不得停', ms: 25000,
      fetch: (u, n, t) => (u.indexOf('gpu-ecc') >= 0 && (t - 1700000000000) > 4000 ? 'fail' : live(u)),
      setup: async (w) => { w.loadGpuEcc(); await new Promise((r) => setImmediate(r)); },
      assert: (w, env, r) => {
        const bad = [];
        const rows = w.document.getElementById('eccGpuRows').innerHTML || '';
        if (rows.indexOf('CMP 170HX') < 0) bad.push('取数失败后上一帧被空数据覆盖（09-22 铁律违例）');
        const n = r.fetchCalls.filter((x) => x.indexOf('gpu-ecc') >= 0).length;
        if (n < 3) bad.push('取数失败后轮询停止（gpu-ecc 仅 ' + n + ' 次）');
        return bad;
      } },
    { name: 'GPU ECC 卡：DBE 计数增长事件 → 红标 + 当时温度/功耗上下文', ms: 8000,
      fetch: (u) => (u.indexOf('gpu-ecc') < 0 ? live(u) : (() => {
        const d = JSON.parse(JSON.stringify(fixtures['/gpu-ecc']));
        const g = d.gpus[1];
        g.counters.a_dram_u = 1; g.columns.a_dram_u.value = 1; g.since.a_dram_u = 1;
        g.status = 'error'; g.status_label = '存在不可纠正错误（DBE）';
        d.summary.lifetime_dbe = 1; d.summary.since_dbe = 1;
        d.events.unshift({ ts: 1794104000000, kind: 'ecc', scope: 'aggregate', sev: 'error', idx: 1, ekind: 'dbe', where: 'dram', field: 'a_dram_u', label: '终身 显存(DRAM) 不可纠正 DBE', from: 0, to: 1, delta: 1, ctx: { temp: 61, temp_mem: 74, power: 198.2, util: 96, sm: 1410 }, msg: '终身 显存(DRAM) 不可纠正 DBE 0 → 1（+1）' });
        return d;
      })()),
      setup: async (w) => { w.loadGpuEcc(); await new Promise((r) => setImmediate(r)); },
      assert: (w, env, r) => {
        const bad = [];
        const evts = w.document.getElementById('eccEventRows').innerHTML || '';
        if (evts.indexOf('不可纠正 DBE') < 0) bad.push('DBE 事件类型未渲染（实得 ' + JSON.stringify(evts.slice(0, 120)) + '）');
        if (evts.indexOf('0 → 1') < 0) bad.push('事件未显示 从→到 增量');
        if (evts.indexOf('61/74 ℃') < 0 || evts.indexOf('198.2 W') < 0) bad.push('报错时刻温度/功耗快照未显示');
        const rows = w.document.getElementById('eccGpuRows').innerHTML || '';
        if (rows.indexOf('存在不可纠正错误') < 0) bad.push('GPU1 状态列未标 DBE 状态');
        const sum = w.document.getElementById('eccSummary').innerHTML || '';
        if (sum.indexOf('终身 DBE') < 0) bad.push('摘要 DBE 段缺失');
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
      // 单个场景抛错不得静默终止整轮测试（否则后面的场景根本没跑，退出码还是 0——
      // 「测试跑一半就没了」这种形态比红更危险）。这里兜住后显式记为失败并继续。
      let r;
      try { r = await runPage(f, sc); }
      catch (e) { r = { file: f, loadErrors: [], runtimeErrors: ['场景执行抛错: ' + msg(e)], notes: [] }; }
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
