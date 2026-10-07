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
