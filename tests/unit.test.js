// tests/unit.test.js — 从 server.js 按名字切出函数源码，在 node 里做单元测试。
// 手法与本项目排障惯例一致（把函数抽进独立模块跑，比静态读代码快且能证伪自己的判断）。
// 运行：node tests/unit.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const acorn = require(process.env.ACORN_PATH || '/Users/Apple/deepseek-harness/node_modules/.pnpm/acorn@8.17.0/node_modules/acorn');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const ast = acorn.parse(SRC, { ecmaVersion: 'latest', locations: true });

// 按名字切源码（顶层 FunctionDeclaration / const 箭头函数 / const 对象字面量）
const pieces = new Map();
for (const n of ast.body) {
  if (n.type === 'FunctionDeclaration' && n.id) pieces.set(n.id.name, src(n));
  else if (n.type === 'VariableDeclaration') {
    for (const d of n.declarations) {
      if (d.id.type !== 'Identifier' || !d.init) continue;
      // let/var 整句切出（保持可变绑定，被测函数要能自增计数器）；const 按原方式重建
      pieces.set(d.id.name, n.kind === 'const'
        ? `const ${d.id.name} = ${src(d.init)};`
        : SRC.slice(n.start, n.end).replace(/\s+$/, '') + ';');
    }
  }
}
function src(node) { return SRC.slice(node.start, node.end); }

function load(names, stubs) {
  const code = names.map((n) => {
    if (!pieces.has(n)) throw new Error('server.js 里找不到函数：' + n);
    return pieces.get(n);
  }).join('\n\n');
  const box = {};
  const ctx = vm.createContext(Object.assign({
    console, JSON, Math, Date, parseInt, parseFloat, isNaN, String, Number, Array, Object, Set, Map,
    setTimeout, clearTimeout, setInterval, clearInterval, Buffer, require,
    spawn: require('child_process').spawn, // 被测函数直接用裸 spawn（server.js 顶部解构引入）
    __dirname: ROOT, process,
  }, stubs || {}));
  vm.runInContext(code + '\n;globalThis.__box = {' + names.join(',') + '};', ctx);
  return ctx.__box;
}

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { const r = fn(); if (r === true || r === undefined) { pass++; } else { fail++; failures.push(`${name}: ${r}`); } }
  catch (e) { fail++; failures.push(`${name}: 抛错 ${e.message}`); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ============ 1. metrics 解析与聚合 ============
const M = load(['parseMetrics', 'metricsNamespace', 'gaugeValue', 'gaugeValuePp', 'counterTotal', 'counterBySource', 'counterByLabel', 'histogramSumCount']);
t('parseMetrics 基本解析', () => {
  const m = M.parseMetrics('# comment\nvllm:kv_cache_usage_perc{model_name="a"} 0.5\nvllm:num_requests_running{model_name="a"} 3\n');
  return eq(m, { 'vllm:kv_cache_usage_perc|{"model_name":"a"}': 0.5, 'vllm:num_requests_running|{"model_name":"a"}': 3 }) || JSON.stringify(m);
});
t('parseMetrics 标签值含空格与逗号（引号内）', () => {
  const m = M.parseMetrics('vllm:x{model_name="a b",tag="c"} 1\n');
  const k = Object.keys(m)[0];
  return m[k] === 1 || k;
});
t('metricsNamespace 识别 sglang', () => M.metricsNamespace(M.parseMetrics('sglang:a 1\n')) === 'sglang');
t('gaugeValuePp：PP 多 stage 取 max（rank0 恒 0 不得遮蔽真值）', () => {
  const m = M.parseMetrics('vllm:spec_accept_rate{pp_rank="0"} 0\nvllm:spec_accept_rate{pp_rank="1"} 0.72\n');
  return M.gaugeValuePp(m, 'vllm:spec_accept_rate') === 0.72 || String(M.gaugeValuePp(m, 'vllm:spec_accept_rate'));
});
t('gaugeValuePp：无 pp_rank 时保持首条语义', () => {
  const m = M.parseMetrics('vllm:g{a="1"} 5\nvllm:g{a="2"} 9\n');
  return M.gaugeValuePp(m, 'vllm:g') === 5;
});
t('counterTotal 累加多标签', () => {
  const m = M.parseMetrics('vllm:prompt_tokens{engine="0"} 10\nvllm:prompt_tokens{engine="1"} 20\n');
  return M.counterTotal(m, 'vllm:prompt_tokens') === 30 || String(M.counterTotal(m, 'vllm:prompt_tokens'));
});
t('counterBySource 按 source 过滤', () => {
  const m = M.parseMetrics('vllm:prompt_tokens_by_source_total{source="cached"} 100\nvllm:prompt_tokens_by_source_total{source="uncached"} 40\n');
  return M.counterBySource(m, 'vllm:prompt_tokens_by_source_total', 'cached') === 100;
});
t('histogramSumCount：单标签 _sum/_count', () => {
  const m = M.parseMetrics('vllm:e2e_seconds_count{model_name="a"} 10\nvllm:e2e_seconds_sum{model_name="a"} 25\nvllm:e2e_seconds_bucket{le="1"} 5\n');
  const r = M.histogramSumCount(m, 'vllm:e2e_seconds');
  return eq(r, { sum: 25, count: 10 }) || JSON.stringify(r);
});
t('histogramSumCount：多标签（多引擎/多模型）应累加而非只取最后一条', () => {
  const m = M.parseMetrics('vllm:e2e_seconds_count{engine="0"} 10\nvllm:e2e_seconds_sum{engine="0"} 100\nvllm:e2e_seconds_count{engine="1"} 7\nvllm:e2e_seconds_sum{engine="1"} 70\n');
  const r = M.histogramSumCount(m, 'vllm:e2e_seconds');
  return eq(r, { sum: 170, count: 17 }) || `实得 ${JSON.stringify(r)}（应为 {sum:170,count:17}：多引擎序列被覆盖）`;
});

// ============ 2. v3 实时测速（10-06 稀释修复的回归护栏）============
const V3 = load(['v3Rate', 'v3LastSec', 'v3TouchRow'], { V3_WIN_MIN: 1.5, V3_WIN_MAX: 6.0, V3_LAST_STALE: 2.2 });
const T0 = 1000;
function stOf(samples, extra) {
  return Object.assign({ samples, g: samples[samples.length - 1].g, gLastT: samples[samples.length - 1].t,
    lastLineT: samples[samples.length - 1].t, firstT: samples[0].t, obsT: samples[0].t, g0: 0, rid: 'r1' }, extra || {});
}
t('v3Rate 正常滑窗', () => {
  const st = stOf([{ t: T0, g: 1 }, { t: T0 + 3, g: 6 }]);
  const r = V3.v3Rate(st, (T0 + 3.5) * 1000);
  return r && Math.abs(r.spd - 5 / 3) < 1e-9 || JSON.stringify(r);
});
t('v3Rate 末样本过期(>2.2s) → null', () => {
  const st = stOf([{ t: T0, g: 1 }, { t: T0 + 1, g: 5 }]);
  return V3.v3Rate(st, (T0 + 4) * 1000) === null;
});
t('v3Rate 全部样本超出窗上限 → null（不得发跨冻结期稀释均速）', () => {
  const st = stOf([{ t: T0, g: 1 }, { t: T0 + 1, g: 3 }]);
  return V3.v3Rate(st, (T0 + 20) * 1000) === null;
});
t('v3Rate g 冻结（Δg≤0）→ null', () => {
  const st = stOf([{ t: T0, g: 5 }, { t: T0 + 3, g: 5 }]);
  return V3.v3Rate(st, (T0 + 3.2) * 1000) === null;
});
t('v3LastSec 1s 口径', () => {
  const st = stOf([{ t: T0, g: 10 }, { t: T0 + 2, g: 20 }]);
  return V3.v3LastSec(st, (T0 + 2) * 1000) === 5 || String(V3.v3LastSec(st, (T0 + 2) * 1000));
});
// v3TouchRow 依赖 Date.now()：用可控时钟替换
function touchRow(st, nowMs, lv) {
  const ctx = vm.createContext({ Date: { now: () => nowMs }, console });
  vm.runInContext(pieces.get('v3TouchRow'), ctx);
  const o = lv || {};
  ctx.v3TouchRow(o, st);
  return o;
}
t('v3TouchRow 活跃期：全程均值分母钉在最后产出（不得被墙钟稀释）', () => {
  const st = stOf([{ t: T0, g: 8 }], { gLastT: T0 + 2, lastLineT: T0 + 2, firstT: T0 });
  const o = touchRow(st, (T0 + 34) * 1000); // 墙钟已 34s，但产出停在 2s
  return (o.v3Avg === undefined || o.v3Avg >= 3) || `稀释成 ${o.v3Avg}（10-06 截图 0.2 形态复现）`;
});
t('v3TouchRow 冻结期：钉住终值不再随墙钟重算', () => {
  const st = stOf([{ t: T0, g: 8 }], { gLastT: T0 + 2, lastLineT: T0 - 10, firstT: T0 });
  const o1 = touchRow(st, (T0 + 5) * 1000);
  const o2 = touchRow(st, (T0 + 60) * 1000, o1);
  return (o1.v3AvgFrozen !== undefined && o2.v3Avg === o1.v3AvgFrozen) || `冻结后仍漂移：${o1.v3Avg} → ${o2.v3Avg}`;
});
t('v3TouchRow 中途接管（无 firstT）：用观测窗增量，不用引擎累计值除零头秒', () => {
  const st = stOf([{ t: T0, g: 500 }], { firstT: null, obsT: T0, g0: 495, gLastT: T0 + 1, lastLineT: T0 + 1 });
  const o = touchRow(st, (T0 + 1.2) * 1000);
  return (o.v3Avg === undefined || o.v3Avg <= 25) || `接管口径异常 ${o.v3Avg}`;
});

// ============ 3. 计费 ============
const B = load(['billingDayKey', 'ensureBillingDay', 'buildBillingDays', 'BILLING_ZERO_BUCKET']);
t('billingDayKey 本地日期补零', () => B.billingDayKey(new Date(2026, 8, 5)) === '2026-09-05' || B.billingDayKey(new Date(2026, 8, 5)));
t('buildBillingDays total 求和 + 缺字段容错', () => {
  const st = { days: { '2026-09-05': { cost: { cached_input: 1, uncached_input: 2, output: 4 }, tokens: { output: 10 } }, '2026-09-06': { tokens: {} } } };
  const d = B.buildBillingDays(st);
  return d['2026-09-05'].cost.total === 7 && d['2026-09-06'].cost.total === 0;
});

// ============ 4. shell 参数解析 ============
const SH = load(['shellTokenize']);
t('shellTokenize 引号与转义', () => eq(SH.shellTokenize("a 'b c' \"d e\" f\\ g"), ['a', 'b c', 'd e', 'f g']) || JSON.stringify(SH.shellTokenize("a 'b c' \"d e\" f\\ g")));
t('shellTokenize $((算术)) 求值', () => eq(SH.shellTokenize('--n $((16*105))'), ['--n', '1680']) || JSON.stringify(SH.shellTokenize('--n $((16*105))')));
t('shellTokenize 空输入', () => eq(SH.shellTokenize('   '), []));
t('shellTokenize 未闭合引号不吞后续', () => eq(SH.shellTokenize("a 'b c"), ['a', 'b c']) || JSON.stringify(SH.shellTokenize("a 'b c")));

// ============ 5. 数值清洗 ============
const G = load(['gpuNum', 'gpuParseRows', 'membwUnitMul']);
t('gpuNum N/A → null', () => G.gpuNum('[N/A]') === null && G.gpuNum(null) === null);
t('gpuNum 带单位字符串', () => G.gpuNum('210.5 W') === 210.5 || String(G.gpuNum('210.5 W')));
t('gpuNum 负温度', () => G.gpuNum('-5') === -5 || String(G.gpuNum('-5')));
t('gpuParseRows 去空行去空格', () => eq(G.gpuParseRows('0, 88 %\n\n1, 90 %\n'), [['0', '88 %'], ['1', '90 %']]));
t('membwUnitMul 单位', () => G.membwUnitMul('GiB') === 1073741824 && G.membwUnitMul('') === 64);

// ============ 6. chat 裁剪 ============
const C = load(['msgChars', 'takeMsgsByChars', 'estimatePromptTokens', 'estimatePieceTokens',
  'chatTrimCapMaxChars', 'chatTrimKeepOldChars', 'chatTrimKeepTailChars', 'trimChatMessages', 'truncateMsgContent', 'CHAT_TRIM_PLACEHOLDER']);
t('estimatePromptTokens 多模态 parts', () => C.estimatePromptTokens({ messages: [{ content: [{ type: 'text', text: 'x'.repeat(100) }] }] }) === 90 || String(C.estimatePromptTokens({ messages: [{ content: [{ type: 'text', text: 'x'.repeat(100) }] }] })));
t('estimatePromptTokens 空/非法输入 → 0', () => C.estimatePromptTokens(null) === 0 && C.estimatePromptTokens({}) === 0);
t('takeMsgsByChars 至少保留 1 条（不得产生空段）', () => {
  const msgs = [{ content: 'x'.repeat(5000) }, { content: 'y'.repeat(10) }];
  const r = C.takeMsgsByChars(msgs, 100);
  return r.length === 1 || `得到 ${r.length} 条`;
});
t('msgChars 兼容 null content', () => C.msgChars({ content: null }) === 0 && C.msgChars(null) === 0);

// ============ 7. Strata 参数编辑 ============
const S = load(['strataArgVal', 'strataArgSet', 'strataArgRemove']);
t('strataArgSet 新增/覆盖/锚点插入', () => {
  let a = ['--max-context', '131072', '--kv', 'int8'];
  S.strataArgSet(a, '--max-context', '262144');
  S.strataArgSet(a, '--spec', '6', '--kv');
  return a.includes('262144') && a[a.indexOf('--spec') + 1] === '6' || JSON.stringify(a);
});
t('strataArgRemove 删除 flag 及其值', () => {
  const a = ['--x', '1', '--y', '2'];
  S.strataArgRemove(a, '--x');
  return !a.includes('--x') && !a.includes('1') && a.includes('--y') || JSON.stringify(a);
});

// ============ 8. GPU 查询通道（09-20 铁律回归：绝不阻塞、必 settle、连续失败熔断）============
const GQ = load(['spawnCollect', 'gpuQuery', 'gpuQueryAvailable', 'gpuQFail', 'gpuSmi', '__gpuQFails', '__gpuQBlockUntil', 'GPU_Q_FAIL_MAX', 'GPU_Q_COOLDOWN_MS']);
async function ta(name, fn) {
  try { const r = await fn(); if (r === true || r === undefined) pass++; else { fail++; failures.push(`${name}: ${r}`); } }
  catch (e) { fail++; failures.push(`${name}: 抛错 ${e.message}`); }
}

(async () => {
  await ta('spawnCollect 命令不存在 → resolve null（不 reject、不抛、不悬挂）', async () => {
    const r = await GQ.spawnCollect('__no_such_binary__', [], 2000, false);
    return r === null || String(r);
  });
  await ta('spawnCollect 正常命令 → 返回 stdout', async () => {
    const r = await GQ.spawnCollect('echo', ['gpu-ok'], 3000, false);
    return (r || '').trim() === 'gpu-ok' || String(r);
  });
  await ta('【铁律核心】子进程不退出 → 自建定时器放弃等待，resolve null（execFile 的 timeout 对 D 状态无效）', async () => {
    const t0 = Date.now();
    const r = await GQ.spawnCollect('sleep', ['30'], 400, false); // sleep 30 永不自然结束
    const el = Date.now() - t0;
    if (r !== null) return '应 resolve null，实得 ' + String(r);
    if (el > 3000) return '未在放弃时限内 settle，耗时 ' + el + 'ms';
    return true;
  });
  await ta('连续失败达阈值 → 熔断打开，gpuQuery 不再起子进程直接 null', async () => {
    for (let i = 0; i < GQ.GPU_Q_FAIL_MAX; i++) GQ.gpuQFail('单元测试模拟');
    if (GQ.gpuQueryAvailable()) return '熔断未打开';
    const t0 = Date.now();
    const r = await GQ.gpuQuery(['--query-gpu=index', '--format=csv,noheader'], 5000);
    const el = Date.now() - t0;
    if (r !== null) return '熔断期应返回 null，实得 ' + String(r);
    if (el > 100) return '熔断期仍去起子进程（耗时 ' + el + 'ms）';
    return true;
  });
  await ta('熔断冷却期内 gpuSmi 抛错而非返回缺省值（缺省值会被自愈层当成真值）', async () => {
    let threw = false;
    try { await GQ.gpuSmi('index'); } catch (e) { threw = true; }
    return threw || '未抛错（可能返回了缺省值）';
  });

  // ============ 9. GPU 累计通电时间解析（[gpu-uptime 1029]：wtmp∪journal 开机区间）============
  const UP = load(['UP_DATE_WTMP_RE', 'UP_DATE_ISO_RE', 'upParseWtmp', 'upParseJournal', 'upMergeIv', 'upSum', 'upLiveIv', 'upParseTimeRun']);
  await ta('upParseWtmp：still running 延到 now、干净配对取 end、忽略 shutdown/wtmp begins 行', async () => {
    const now = Date.parse('2026-10-29T17:00:00');
    const out = [
      'reboot   system boot  5.15.0-139-gener Thu Oct 29 16:22:13 2026   still running',
      'shutdown system down  5.15.0-139-gener Thu Oct 29 16:15:32 2026 - Thu Oct 29 16:22:13 2026  (00:06)',
      'reboot   system boot  5.15.0-139-gener Thu Oct 29 07:31:00 2026 - Thu Oct 29 16:15:32 2026  (08:44)',
      'wtmp begins Sat Sep 19 07:32:47 2026',
      '',
    ].join('\n');
    const iv = UP.upParseWtmp(out, now);
    if (iv.length !== 2) return '应得 2 区间，实得 ' + iv.length;
    if (iv[0].s !== Date.parse('2026-10-29T16:22:13') || iv[0].e !== now) return 'still running 区间错：' + JSON.stringify(iv[0]);
    if (iv[1].s !== Date.parse('2026-10-29T07:31:00') || iv[1].e !== Date.parse('2026-10-29T16:15:32')) return '干净配对区间错：' + JSON.stringify(iv[1]);
    return true;
  });
  await ta('upParseJournal：历史 boot 取首末行、当前 boot(idx 0) 尾行滞后延到 now', async () => {
    const now = Date.parse('2026-10-29T17:00:00');
    const out = [
      '-39 779b057565c14548bd11ca0f2d020010 Sun 2026-10-11 05:41:36 CST—Sun 2026-10-11 07:37:02 CST',
      '  0 c02f59d5e9d8444c9a497ea992ebf4d0 Thu 2026-10-29 16:22:13 CST—Thu 2026-10-29 16:59:30 CST',
    ].join('\n');
    const iv = UP.upParseJournal(out, now);
    if (iv.length !== 2) return '应得 2 区间，实得 ' + iv.length;
    if (iv[0].s !== Date.parse('2026-10-11T05:41:36') || iv[0].e !== Date.parse('2026-10-11T07:37:02')) return '历史 boot 区间错：' + JSON.stringify(iv[0]);
    if (iv[1].e !== now) return '当前 boot 未延到 now：' + JSON.stringify(iv[1]);
    return true;
  });
  await ta('upMergeIv：重叠与 60s 容差桥接合并、大间隔不并、未来区间丢弃', async () => {
    const now = Date.parse('2026-10-29T17:00:00');
    const iv = UP.upMergeIv([
      { s: now - 3600000, e: now - 1800000 },
      { s: now - 1800000 - 30000, e: now - 900000 }, // 与上一区间仅差 30s ≤ 容差 → 合并成一段
      { s: now - 7200000, e: now - 6000000 },
      { s: now + 1000, e: now + 50000 },             // 未来（时钟漂移）→ 丢弃
    ], now);
    if (iv.length !== 2) return '应得 2 区间，实得 ' + iv.length + '：' + JSON.stringify(iv);
    if (iv[0].s !== now - 7200000) return '未按起点排序';
    if (iv[1].s !== now - 3600000 || iv[1].e !== now - 900000) return '合并边界错：' + JSON.stringify(iv[1]);
    return true;
  });
  await ta('upMergeIv：时钟漂移下限钳制（10-29 线上实锤：RTC 复位致 boot 记录带 Jan 1 假时间戳，虚增 262 天）', async () => {
    const now = Date.parse('2026-10-29T17:00:00');
    const floor = Date.parse('2026-09-19T07:32:47'); // wtmp begins
    const iv = UP.upMergeIv([
      { s: Date.parse('2026-01-01T08:17:32'), e: Date.parse('2026-09-20T16:20:12'), src: 'wtmp' }, // 假起点
      { s: Date.parse('2026-09-19T07:42:22'), e: Date.parse('2026-09-19T07:42:46'), src: 'wtmp' },
    ], now, floor);
    if (iv.length !== 1) return '钳制后应与真实区间桥接合并为 1 段，实得 ' + iv.length + '：' + JSON.stringify(iv);
    if (iv[0].s !== floor) return '假起点未被钳到 wtmp begins 下限：' + iv[0].s;
    if (iv[0].e !== Date.parse('2026-09-20T16:20:12')) return 'end 应保持原值';
    // 无下限（floor=0）时不钳制
    const iv2 = UP.upMergeIv([{ s: Date.parse('2026-01-01T08:17:32'), e: Date.parse('2026-01-02T08:17:32'), src: 'wtmp' }], now, 0);
    return (iv2.length === 1 && iv2[0].s === Date.parse('2026-01-01T08:17:32')) || 'floor=0 不应改变起点';
  });
  await ta('upSum：区间 ∩ [from,to] 求和（逐卡通电 = 区间∩[首见,now] 的核）', async () => {
    const iv = [{ s: 0, e: 100000 }, { s: 200000, e: 300000 }];
    const sec = UP.upSum(iv, 50000, 250000); // 交集 50s + 50s = 100s
    return sec === 100 || ('应得 100s，实得 ' + sec);
  });
  await ta('两源同一次开机并集不重复计（wtmp 宽区间 ∪ journal 窄区间 = 一段）', async () => {
    const now = Date.parse('2026-10-29T17:00:00');
    const w = UP.upParseWtmp('reboot   system boot  5.15.0-139-gener Thu Oct 29 16:22:13 2026   still running', now);
    const j = UP.upParseJournal('  0 c02f59d5e9d8444c9a497ea992ebf4d0 Thu 2026-10-29 16:22:30 CST—Thu 2026-10-29 16:59:30 CST', now);
    const iv = UP.upMergeIv(w.concat(j), now);
    if (iv.length !== 1) return '应合并为 1 区间，实得 ' + iv.length;
    const total = UP.upSum(iv, 0, now);
    const expect = (now - Date.parse('2026-10-29T16:22:13')) / 1000;
    return Math.abs(total - expect) < 1 || ('总时长错：' + total + ' vs ' + expect);
  });
  await ta('upLiveIv：liveTail 延尾到 now+起点可提前（10-29 修复：区间表 10min 冻结/本次开机 -- 的核）', async () => {
    const now = Date.parse('2026-10-29T17:10:00');
    const iv = [{ s: Date.parse('2026-10-29T08:00:00'), e: Date.parse('2026-10-29T10:00:00') }, { s: Date.parse('2026-10-29T16:22:13'), e: Date.parse('2026-10-29T17:00:00') }];
    const live = UP.upLiveIv(iv, true, now, Date.parse('2026-10-29T16:22:10'));
    if (live.length !== 2) return '区间数应不变';
    if (live[0].s !== iv[0].s || live[0].e !== iv[0].e) return '非尾段不得改动';
    if (live[1].e !== now) return '尾段未延到 now';
    if (live[1].s !== Date.parse('2026-10-29T16:22:10')) return 'tailStart 未生效（应提前到 /proc/uptime 反推时刻）';
    // liveTail=false 原样返回；tailStart 不早于原起点时不采纳
    if (UP.upLiveIv(iv, false, now, null) !== iv) return '非 live 应原样';
    const keep = UP.upLiveIv(iv, true, now, Date.parse('2026-10-29T16:30:00'));
    return keep[1].s === iv[1].s || 'tailStart 晚于原起点不应生效';
  });
  await ta('upParseTimeRun：bbx.time_run 正常解析（出厂真值主口径，10-29 用户实锤字段名 Time Run）', async () => {
    const out = '0, GPU-75e3aa88-a4b8-7e63-d5bd-62e2f71c1285, 12372363\n1, GPU-8383147b-bdf8-dec5-f0eb-171589d85823, 14276056 seconds\n';
    const m = UP.upParseTimeRun(out);
    if (m['GPU-75e3aa88-a4b8-7e63-d5bd-62e2f71c1285'] !== 12372363) return '纯数字列解析错：' + JSON.stringify(m);
    if (m['GPU-8383147b-bdf8-dec5-f0eb-171589d85823'] !== 14276056) return '带单位列解析错';
    return true;
  });
  await ta('upParseTimeRun：null/空行/N-A/非法值一律缺省不冒充（宁缺毋假）', async () => {
    if (Object.keys(UP.upParseTimeRun(null)).length !== 0) return 'null 应得空表';
    const m = UP.upParseTimeRun('0, GPU-aaa, [N/A]\n1, GPU-bbb, 0\ngarbage line\n2, GPU-ccc, 3600\n');
    if (m['GPU-aaa'] != null) return 'N/A 不应入库';
    if (m['GPU-bbb'] != null) return '0 秒（无数字）不应入库';
    if (m['GPU-ccc'] !== 3600) return '正常行应入库';
    return true;
  });

  // ============ 10. GPU 温度历史与曲线序列（[gpu-temp-1103] 硬件监视页显存温度曲线）============
  const GT_NOW = 1780000000; // 固定"现在"（秒），窗口过滤才可判定
  const GTG = {};            // 沙箱里的 global 替身（vm context 默认没有 global 这个变量）
  const GT = load(['GPU_TEMP_KEEP', 'appendGpuTempHistory', 'gpuTempSeries', 'gpuTempPayload'], { global: GTG, Date: { now: () => GT_NOW * 1000 } });
  await ta('appendGpuTempHistory：逐秒落点，只存核心/显存两值', async () => {
    GTG.__gpuTempHistory = [];
    GT.appendGpuTempHistory([{ index: 0, temp: 61, temp_mem: 68 }, { index: 1, temp: 58, temp_mem: 64 }]);
    const H = GTG.__gpuTempHistory;
    if (H.length !== 1) return '应落 1 点，实得 ' + H.length;
    if (H[0].t !== GT_NOW) return '时间戳应为当前秒，实得 ' + H[0].t;
    if (H[0].g['0'].c !== 61 || H[0].g['0'].m !== 68) return '值错：' + JSON.stringify(H[0].g);
    return true;
  });
  await ta('appendGpuTempHistory：同一秒重复调用只记一次（防定时器重叠造出假密点）', async () => {
    GT.appendGpuTempHistory([{ index: 0, temp: 61, temp_mem: 68 }]);
    return GTG.__gpuTempHistory.length === 1 || ('实得 ' + GTG.__gpuTempHistory.length + ' 点');
  });
  await ta('appendGpuTempHistory：0/超 150℃/null 归 null，全缺则该拍不落点（不得画 0 ℃ 平线冒充）', async () => {
    GTG.__gpuTempHistory = [];
    GT.appendGpuTempHistory([{ index: 0, temp: 0, temp_mem: 0 }]);
    if (GTG.__gpuTempHistory.length !== 0) return '全非法值不应落点';
    GT.appendGpuTempHistory([{ index: 0, temp: 61, temp_mem: 0 }, { index: 1, temp: null, temp_mem: 400 }]);
    const e0 = GTG.__gpuTempHistory[0].g['0'];
    if (e0.m !== null) return '显存 0 ℃ 应归 null，实得 ' + e0.m;
    if (e0.c !== 61) return '核心合法值应保留';
    if (GTG.__gpuTempHistory[0].g['1'] !== undefined) return '核心与显存都非法的卡不应入帧：' + JSON.stringify(GTG.__gpuTempHistory[0].g['1']);
    return true;
  });
  await ta('appendGpuTempHistory：非数组/空数组/无 index 一律不炸不落', async () => {
    GTG.__gpuTempHistory = [];
    GT.appendGpuTempHistory(null); GT.appendGpuTempHistory([]); GT.appendGpuTempHistory([{}]);
    return GTG.__gpuTempHistory.length === 0 || '垃圾输入污染了历史';
  });
  await ta('appendGpuTempHistory：满 3600 点后环形截尾（长跑不涨内存，与 disk 历史同一手法）', async () => {
    GTG.__gpuTempHistory = [];
    for (let i = 0; i < 3600; i++) GTG.__gpuTempHistory.push({ t: GT_NOW - 3600 + i, g: { 0: { c: 60, m: 66 } } });
    GT.appendGpuTempHistory([{ index: 0, temp: 62, temp_mem: 70 }]);
    if (GTG.__gpuTempHistory.length !== 3600) return '应截尾保持 3600，实得 ' + GTG.__gpuTempHistory.length;
    const tail = GTG.__gpuTempHistory[GTG.__gpuTempHistory.length - 1];
    if (tail.t !== GT_NOW || tail.g['0'].m !== 70) return '新点未入尾：' + JSON.stringify(tail);
    return GTG.__gpuTempHistory[0].t === GT_NOW - 3599 || ('头部未丢弃最旧：' + GTG.__gpuTempHistory[0].t);
  });
  await ta('gpuTempSeries：窗口过滤 + 桶均值抽稀到 ≤300 点（1 小时窗口响应也不膨胀）', async () => {
    GTG.__gpuTempHistory = [];
    for (let s = 0; s < 3600; s++) {
      GTG.__gpuTempHistory.push({ t: GT_NOW - 3600 + s, g: { 0: { c: 60 + (s % 10), m: 70 + (s % 10) } } });
    }
    const r = GT.gpuTempSeries(3600);
    if (r.points.length > 300) return '抽稀后应 ≤300 点，实得 ' + r.points.length;
    if (r.raw_points !== 3600) return '窗口内原始点数错：' + r.raw_points;
    if (r.sample_s < 12) return '桶宽应 ≥原始点/300=12，实得 ' + r.sample_s;
    const r5 = GT.gpuTempSeries(600);
    if (r5.raw_points !== 600) return '窗口过滤错：' + r5.raw_points;
    return true;
  });
  await ta('gpuTempSeries：峰值/均值在原始逐秒点上算（抽稀不得抹平真实尖峰）', async () => {
    GTG.__gpuTempHistory = [];
    for (let s = 0; s < 300; s++) GTG.__gpuTempHistory.push({ t: GT_NOW - 300 + s, g: { 0: { c: 60, m: 70 } } });
    GTG.__gpuTempHistory[150].g['0'].m = 99; // 单点真实尖峰：桶均值会摊成 70.x，统计层必须仍抓到 99
    const st = GT.gpuTempSeries(300).stats['0'];
    if (st.mem.max !== 99) return '峰值应为 99，实得 ' + st.mem.max;
    if (st.mem.max_t !== GT_NOW - 150) return '峰值时刻错：' + st.mem.max_t;
    if (st.mem.min !== 70 || st.mem.cur !== 70) return '谷值/现值错：' + JSON.stringify(st.mem);
    if (!(st.mem.avg > 70 && st.mem.avg < 71)) return '均值应≈70.1，实得 ' + st.mem.avg;
    return true;
  });
  await ta('gpuTempSeries：null 不参与均值、不被 0 顶替（缺列如实缺，同 09-22 铁律）', async () => {
    GTG.__gpuTempHistory = [
      { t: GT_NOW - 3, g: { 0: { c: 60, m: null } } },
      { t: GT_NOW - 2, g: { 0: { c: 62, m: null } } },
      { t: GT_NOW - 1, g: { 0: { c: null, m: null } } },
    ];
    const st = GT.gpuTempSeries(60).stats['0'];
    if (st.mem.cur !== null || st.mem.max !== null || st.mem.avg !== null) return '显存全缺应全 null，实得 ' + JSON.stringify(st.mem);
    if (st.core.cur !== 62 || st.core.avg !== 61) return '核心应只按 2 个有效点算：' + JSON.stringify(st.core);
    return st.core.n === 2 || ('有效点计数错：' + st.core.n);
  });
  await ta('gpuTempSeries：多卡按数值序（GPU10 不排到 GPU2 前）且逐卡独立', async () => {
    GTG.__gpuTempHistory = [{ t: GT_NOW - 1, g: { 10: { c: 60, m: 66 }, 2: { c: 61, m: 67 }, 0: { c: 62, m: 68 } } }];
    const ks = Object.keys(GT.gpuTempSeries(60).stats);
    return (ks[0] === '0' && ks[1] === '2' && ks[2] === '10') || ('排序错：' + JSON.stringify(ks));
  });
  await ta('gpuTempPayload：口径字段齐备（阈值分轨 + 卡名 + 追溯深度 + 采样年龄）', async () => {
    GTG.__gpuTempHistory = [{ t: GT_NOW - 2, g: { 0: { c: 60, m: 66 } } }, { t: GT_NOW - 1, g: { 0: { c: 61, m: 67 } } }];
    GTG.__gpuStatic = { gpus: [{ index: 0, name: 'CMP 170HX' }] };
    GTG.__gpuLive = { ts: (GT_NOW - 1) * 1000 };
    const p = GT.gpuTempPayload(300);
    if (p.win_s !== 300) return 'win_s 未透传';
    if (p.names['0'] !== 'CMP 170HX') return '卡名未合并：' + JSON.stringify(p.names);
    if (p.thresholds.mem_warn !== 85 || p.thresholds.mem_crit !== 95 || p.thresholds.core_warn !== 70) return '阈值分轨错：' + JSON.stringify(p.thresholds);
    if (p.depth_s !== 2) return '追溯深度应为 2 秒，实得 ' + p.depth_s;
    if (p.live_age_s !== 1) return '采样年龄应为 1 秒，实得 ' + p.live_age_s;
    return p.raw_points === 2 || ('原始点数错：' + p.raw_points);
  });
  await ta('gpuTempPayload：历史为空（控制台刚启动）→ 空序列不报错，前端据此显示"采样中"', async () => {
    GTG.__gpuTempHistory = [];
    delete GTG.__gpuLive;
    const p = GT.gpuTempPayload(600);
    if (p.points.length !== 0 || Object.keys(p.stats).length !== 0) return '应为空序列';
    if (p.first_t !== null || p.last_t !== null) return '空序列首末应为 null';
    return (p.depth_s === 0 && p.live_age_s === null) || ('空态元数据错：' + JSON.stringify({ d: p.depth_s, a: p.live_age_s }));
  });


// ============ 15. 脚本模型快启参数下发 [spec-dflash-1103] ============
// 背景（09-26「参数三跳」铁律的第三跳断点）：plan 的 dflash 分支此前只 push 警告、从不设
// env.FN_SPEC，inner 于是落到自己的缺省 MTP4 —— 弹窗/快启选 DFlash2 会静默变 MTP 且警告相反。
// 注意：SCRIPT_MODELS 的 w4a16 条目是顶层 ExpressionStatement（SCRIPT_MODELS[...] = {...}），
// pieces 只收 FunctionDeclaration/VariableDeclaration，故这里手工切「声明 + 追加赋值」整段。
function loadPlanChain(totalmemGiB) {
  const i0 = SRC.indexOf('const SCRIPT_MODELS = {');
  const i1 = SRC.indexOf('\nfunction scriptModelForName(', i0);
  const vr0 = SRC.indexOf('function scriptModelVariantResolve(');
  const vr1 = SRC.indexOf('function scriptModelLaunchPlan(', vr0);
  const lp1 = SRC.indexOf('// ====== SGLang 脚本栈', vr1);
  if (i0 < 0 || i1 < 0 || vr0 < 0 || vr1 < 0 || lp1 < 0) throw new Error('plan 链切片锚点失效');
  const code = 'var MODEL_ALIASES = {};\n' + SRC.slice(i0, i1) + '\n' + SRC.slice(vr0, lp1);
  const ctx = vm.createContext({
    console, JSON, Math, parseInt, parseFloat, isNaN, String, Number, Object, Array, process,
    require: (m) => (m === 'os' ? { totalmem: () => totalmemGiB * 1024 * 1024 * 1024 } : require(m)),
  });
  vm.runInContext(code + '\n;globalThis.__box = { scriptModelLaunchPlan, SCRIPT_MODELS };', ctx);
  return ctx.__box;
}
{
  // 251GiB = 11-03 生产机实况（heapoffload/低内存护栏依赖 os.totalmem，测试必须钉死内存而非跟随测试机）
  const P = loadPlanChain(251);
  const SM = () => Object.assign({ key: 'qwen3.8-flash-next-w4a16' }, P.SCRIPT_MODELS['qwen3.8-flash-next-w4a16']);
  const baseParams = {
    modelName: 'Qwen3.8-Flash-Next-W4A16-AutoRound', port: 18420, servedName: 'qwen3.8-flash-next',
    maxModelLen: '1048576', longCtx: '1m', parallelMode: 'pp', gpuCount: '2',
    maxNumSeqs: '4', maxBatchedTokens: '8192', blockSize: '1680', gpuMemUtil: '0.95',
    kvoff: 'simple', kvoffGiB: '96', pleInt8: '0', pleLoc: 'heap',
    thinking: '1', thinkingEffort: 'xhigh',
  };
  t('dflash=1 → FN_SPEC 真下发（键序 method→model→num_speculative_tokens，与 launch.env 逐字可比）', () => {
    const e = P.scriptModelLaunchPlan(SM(), Object.assign({}, baseParams, { dflash: '1', mtpTokens: '7' })).env;
    return e.FN_SPEC === '{"method":"dflash","model":"/media/ll/data/models/Qwen3.8-Flash-Next-DFlash2","num_speculative_tokens":7}' || String(e.FN_SPEC);
  });
  t('dflash 草稿可被预设显式 specDraftModel 覆盖（固化档自带草稿路径，不随注册表默认漂移）', () => {
    const e = P.scriptModelLaunchPlan(SM(), Object.assign({}, baseParams, { dflash: '1', mtpTokens: '7', specDraftModel: '/media/ll/data/models/Other' })).env;
    return JSON.parse(e.FN_SPEC).model === '/media/ll/data/models/Other' || e.FN_SPEC;
  });
  t('dflash 步数钳 1~8（前端口径；0/99 不得原样下发给引擎）', () => {
    const lo = JSON.parse(P.scriptModelLaunchPlan(SM(), Object.assign({}, baseParams, { dflash: '1', mtpTokens: '0' })).env.FN_SPEC).num_speculative_tokens;
    const hi = JSON.parse(P.scriptModelLaunchPlan(SM(), Object.assign({}, baseParams, { dflash: '1', mtpTokens: '99' })).env.FN_SPEC).num_speculative_tokens;
    return (lo === 1 && hi === 8) || (`lo=${lo} hi=${hi}`);
  });
  t('mtp=1 优先级与旧行为不变（method=mtp + use_local_argmax_reduction，dflash 未设时不受新分支影响）', () => {
    const e = P.scriptModelLaunchPlan(SM(), Object.assign({}, baseParams, { mtp: '1', mtpTokens: '4' })).env;
    return e.FN_SPEC === '{"method":"mtp","num_speculative_tokens":4,"use_local_argmax_reduction":false}' || String(e.FN_SPEC);
  });
  t('mtp=1 时即便同时勾了 dflash 也走 MTP（分支次序不得改动，防既有档位行为漂移）', () => {
    const e = P.scriptModelLaunchPlan(SM(), Object.assign({}, baseParams, { mtp: '1', mtpTokens: '4', dflash: '1' })).env;
    return JSON.parse(e.FN_SPEC).method === 'mtp' || e.FN_SPEC;
  });
  t('dspark=1 → 显式 FN_SPEC=none（警告称"无投机"必须成为真值，不得放任 inner 缺省 MTP4）', () => {
    const r = P.scriptModelLaunchPlan(SM(), Object.assign({}, baseParams, { dspark: '1' }));
    return r.env.FN_SPEC === 'none' || String(r.env.FN_SPEC);
  });
  t('未选任何投机 → FN_SPEC=none（回归：旧 else 分支语义不变）', () => {
    const e = P.scriptModelLaunchPlan(SM(), Object.assign({}, baseParams, { mtp: '0' })).env;
    return e.FN_SPEC === 'none' || String(e.FN_SPEC);
  });
  t('线上真实预设文件的 standard 档 = 11-03 实跑真值（固化回归锚：block1680/dflash7/simple96/heap/PP2/1M）', () => {
    const cards = JSON.parse(fs.readFileSync(path.join(ROOT, 'quickstart-presets.json'), 'utf8'));
    const std = (cards.flashnext.presets || []).find((x) => x.standard);
    if (!std) return 'flashnext 卡没有 standard 档';
    const e = P.scriptModelLaunchPlan(SM(), Object.assign({ modelName: std.modelName }, std.params || {})).env;
    const want = { FN_BLOCK: '1680', FN_PP: '2', FN_TP: '1', FN_MAXLEN: '1048576', FN_GPUMEM: '0.95',
      FN_SEQS: '4', FN_MBTOKENS: '8192', FN_SIMPLE_OFFLOAD: '96', FN_PLE_INT8: '0', FN_PLE_LOC: 'heap',
      FN_LONGCTX: '1', FN_YARN_FACTOR: '4', FN_PORT: '18420', FN_SERVED: 'qwen3.8-flash-next',
      FN_CHATKWARGS: '{"enable_thinking":true,"preserve_thinking":true,"reasoning_effort":"xhigh"}',
      FN_1M_MODEL_PATH: '/media/ll/data/models-1m/Qwen3.8-Flash-Next-W4A16-AutoRound-1M',
      FN_MODEL_PATH: '/media/ll/data/models/Qwen3.8-Flash-Next-W4A16-AutoRound',
      FN_SPEC: '{"method":"dflash","model":"/media/ll/data/models/Qwen3.8-Flash-Next-DFlash2","num_speculative_tokens":7}' };
    const bad = Object.keys(want).filter((k) => e[k] !== want[k]).map((k) => `${k}: 得 ${e[k]} 期望 ${want[k]}`);
    if (bad.length) return bad.join(' | ');
    // 采样键刻意不下发（实跑走 inner 缺省 t1.0/p0.95/k20/minp0/pp0/rp1.0）
    return e.FN_GENCFG === undefined || 'FN_GENCFG 不该下发：' + e.FN_GENCFG;
  });
  t('固化历史不覆盖：旧档位（w8a8 PP3/MTP4 等）params 未被本次改动影响', () => {
    const cards = JSON.parse(fs.readFileSync(path.join(ROOT, 'quickstart-presets.json'), 'utf8'));
    const keys = (cards.flashnext.presets || []).map((x) => x.key);
    const must = ['w8a8-pp3-1m-mtp4', 'w8a8-pp3-512k-mtp4', 'w8a8-pp3-750k-mtp4', 'w4a16-pp2-1m-mtp4-bf16pin-gpu01'];
    const missing = must.filter((k) => keys.indexOf(k) < 0);
    if (missing.length) return '旧档位丢失：' + missing.join(',');
    const w8 = (cards.flashnext.presets || []).find((x) => x.key === 'w8a8-pp3-1m-mtp4');
    const e = P.scriptModelLaunchPlan(SM(), Object.assign({ modelName: w8.modelName }, w8.params)).env;
    return (e.FN_SPEC === '{"method":"mtp","num_speculative_tokens":4,"use_local_argmax_reduction":false}' && e.FN_PP === '3' && e.FN_BLOCK === '1616') || JSON.stringify({ s: e.FN_SPEC, pp: e.FN_PP, b: e.FN_BLOCK });
  });
  t('低内存机护栏仍生效：PLE heap + 二级缓存 96GiB 在 <100GiB 机被强制降级 disk（新档不得绕过）', () => {
    const Pl = loadPlanChain(32);
    const e = Pl.scriptModelLaunchPlan(SM(), Object.assign({}, baseParams, { dflash: '1', mtpTokens: '7' })).env;
    return e.FN_PLE_LOC === 'disk' || '未降级：' + e.FN_PLE_LOC;
  });
}


// ============ 16. GPU ECC 解析与判障口径 [gpu-ecc-1108] ============
{
  const EC = load(['ECC_XID_ECC_IDS', 'ECC_COLS', 'eccColsOfLevel', 'eccQueryArgs', 'eccNA', 'gpuNum', 'eccParseRows',
    'eccDiffCounters', 'eccSinceOne', 'eccParseIso', 'eccParseXidLine', 'eccParseXidLines',
    'eccBusToIndex', 'eccModeOn', 'eccModeOff', 'eccGpuStatus']);
  // 本机 192.168.1.127 实测真实行（三卡同构，取 GPU0；[N/A] = 该卡不提供此计数器）
  const REAL0 = '0, GPU-75e3aa88-a4b8-7e63-d5bd-62e2f71c1285, Enabled, Enabled, 6.16, 0, 0, 0, 0, [N/A], [N/A], 0, 0, 0, 0, 0, 0, [N/A], [N/A], 0, 0, No, [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A]';
  t('查询串与列定义同源：level 0 = 全列，level 2 = 仅基础列（防"查了不显示 / 显示了没查"）', () => {
    const q = EC.eccQueryArgs(0)[0];
    const full = 'index,uuid,ecc.mode.current,ecc.mode.pending,inforom.ecc,ecc.errors.corrected.volatile.dram';
    if (q.indexOf('--query-gpu=' + full) !== 0) return '前缀列序不符：' + q.slice(0, 120);
    if (q.indexOf('remapped_rows.correctable') < 0) return '完整档应含行重映射';
    const min = EC.eccColsOfLevel(2).map((c) => c.k);
    if (min.indexOf('remapped_rows.correctable') >= 0 || min.indexOf('ecc.errors.corrected.volatile.sram') >= 0) return '最小档混入了高阶级列';
    if (min.indexOf('ecc.errors.corrected.volatile.dram') < 0) return '最小档缺显存计数';
    return true;
  });
  t('真实 CSV 行解析：模式/Inforom/本轮与终身计数落位，[N/A] → null', () => {
    const cols = EC.eccColsOfLevel(0);
    const rows = EC.eccParseRows(REAL0, cols);
    if (rows.length !== 1) return '行数 ' + rows.length;
    const g = rows[0];
    if (g.index !== 0) return 'index=' + g.index;
    if (g.uuid !== 'GPU-75e3aa88-a4b8-7e63-d5bd-62e2f71c1285') return 'uuid=' + g.uuid;
    if (g.text.mode_current !== 'Enabled' || g.text.inforom_ecc !== '6.16') return JSON.stringify(g.text);
    if (g.counters.v_dram_c !== 0 || g.counters.a_dram_u !== 0) return '计数=' + JSON.stringify(g.counters);
    if (g.counters.v_l2_c !== null || g.counters.remap_c !== null) return 'N/A 列必须是 null（不得当 0）：' + JSON.stringify({ l2: g.counters.v_l2_c, remap: g.counters.remap_c });
    if (g.text.a_sram_thr !== 'No') return 'thresholdExceeded=' + g.text.a_sram_thr;
    return true;
  });
  t('列数不足整行弃（错位会造出根本不存在的"错误增长"）', () => {
    const cols = EC.eccColsOfLevel(0);
    const rows = EC.eccParseRows('0, GPU-x, Enabled, Enabled', cols);
    return rows.length === 0 || '短行未被丢弃';
  });
  t('档位回落时按当档列数解析（核心档行 = 少列但仍是合法行）', () => {
    const cols = EC.eccColsOfLevel(1);
    if (cols.length !== 13) return '核心档应 13 列，实得 ' + cols.length;
    if (cols.map((c) => c.k).join(',').indexOf('ecc.errors.corrected.volatile.sram') >= 0) return '核心档混入 SRAM 分项';
    // 位序 = index,uuid,mode_cur,mode_pend,inforom,v_dram_c,v_dram_u,v_total_c,v_total_u,a_dram_c,a_dram_u,a_total_c,a_total_u
    const head = '1, GPU-bad03bee-db2a-c7bd-cb66-a0e7ea0280fd, Enabled, Enabled, 6.16, 3, 0, 5, 0, 2, 0, 5, 0';
    const rows = EC.eccParseRows(head, cols);
    if (rows.length !== 1) return '核心档行数 ' + rows.length;
    const g = rows[0];
    if (g.counters.v_dram_c !== 3 || g.counters.v_total_c !== 5 || g.counters.a_total_u !== 0 || g.index !== 1) return JSON.stringify(g.counters);
    if (g.counters.a_sram_c !== undefined) return '未查询档位的列不得凭空造值';
    return true;
  });
  t('计数增长/倒退/无基线 三态（倒退=新一轮，不是"错误变少"）', () => {
    const d = EC.eccDiffCounters({ v_dram_c: 2, a_dram_u: 0, v_sram_c: 7 }, { v_dram_c: 5, a_dram_u: 1, v_sram_c: null, v_l2_c: 3 });
    const ev = d.events.map((e) => e.key + ':' + e.delta).sort().join(',');
    if (ev !== 'a_dram_u:1,v_dram_c:3') return '增长=' + ev;
    if (d.resets.length) return '倒退判定误触发：' + JSON.stringify(d.resets);
    const r = EC.eccDiffCounters({ v_dram_c: 9 }, { v_dram_c: 0 });   // 驱动重载/重启后本轮归零
    if (r.resets.length !== 1 || r.resets[0] !== 'v_dram_c') return '未识别轮次重置：' + JSON.stringify(r);
    if (EC.eccDiffCounters(null, { v_dram_c: 4 }).events.length) return '无上一拍基线不得出结论';
    return true;
  });
  t('自基线新增 = 已完成轮次累加 + 当前轮增量（锚点缺失如实 null）', () => {
    if (EC.eccSinceOne(0, 5, 2) !== 3) return '当前轮增量算错';
    if (EC.eccSinceOne(7, 1, 0) !== 8) return '跨轮累加算错';      // 上一轮归档 7 + 新一轮 1
    if (EC.eccSinceOne(7, 1, null) !== null) return '锚点缺失必须 null';
    if (EC.eccSinceOne(7, null, 0) !== null) return '当前值缺失必须 null（不以 0 冒充）';
    return true;
  });
  t('journal 时间戳解析（+0800 无冒号偏移 Date.parse 可能不吃 → 补冒号回退）', () => {
    const a = EC.eccParseIso('2026-11-08T09:18:28+0800');
    const b = EC.eccParseIso('2026-11-08T09:18:28+08:00');
    if (a == null || b == null) return '解析失败 ' + a + '/' + b;
    if (a !== b) return '两种偏移写法不一致：' + a + ' vs ' + b;
    if (EC.eccParseIso('garbage') !== null) return '垃圾输入必须 null';
    return true;
  });
  t('内核 Xid 行解析（本机真实行）+ ECC 类分标 + 非 Xid 行不误吞', () => {
    const l1 = '2026-11-08T09:18:28+0800 ll-desktop kernel: NVRM: Xid (PCI:0000:0a:00): 13, Graphics SM Warp Exception on (GPC 3, TPC 0, SM 0): Out Of Range Address';
    const e1 = EC.eccParseXidLine(l1);
    if (!e1 || e1.xid !== 13 || e1.bus !== '0000:0a:00' || e1.ecc) return JSON.stringify(e1);
    if (e1.msg.indexOf('Out Of Range Address') < 0) return 'msg=' + e1.msg;
    const l2 = '2026-11-08T09:18:28+0800 ll-desktop kernel: NVRM: Xid (PCI:0000:0a:00): 48, Double Bit ECC Error';
    const l3 = '2026-11-08T09:18:28+0800 ll-desktop kernel: NVRM: gpuGetNameString_FWCLIENT: 不是 Xid';
    const all = EC.eccParseXidLines([l1, l2, l3].join('\n'));
    if (all.length !== 2) return '应只收 2 条 Xid，实得 ' + all.length;
    if (!all[1].ecc) return 'Xid 48 必须标 ECC 类';
    return true;
  });
  t('Xid 的 PCI 地址 ↔ nvidia-smi bus_id 对齐（对不上如实 null，不按顺序猜卡号）', () => {
    const gs = [{ index: 0, pci_bus_id: '0000:0a:00.0' }, { index: 1, pci_bus_id: '0000:0b:00.0' }, { index: 2, pci_bus_id: '0000:01:00.0' }];
    if (EC.eccBusToIndex('0000:0a:00', gs) !== 0) return '缺 function 号未匹配';
    if (EC.eccBusToIndex('0000:0b:00.0', gs) !== 1) return '带 function 号未匹配';
    if (EC.eccBusToIndex('0000:99:00.0', gs) !== null) return '未知地址必须 null';
    if (EC.eccBusToIndex(null, gs) !== null) return '空地址必须 null';
    return true;
  });
  t('逐卡健康判定口径（DBE=error / SBE=warn / 关闭=disabled / 无数=unknown / 全零=ok）', () => {
    const mk = (c, text, since) => ({ counters: c || {}, since: since || {}, text: text || { mode_current: 'Enabled' } });
    if (EC.eccGpuStatus(mk({ a_dram_u: 1 })).status !== 'error') return '终身 DBE 必须 error';
    if (EC.eccGpuStatus(mk({}, { mode_current: 'Enabled' }, { a_total_u: 2 })).status !== 'error') return '自基线新增 DBE 必须 error';
    if (EC.eccGpuStatus(mk({ a_dram_c: 3 })).status !== 'warn') return 'SBE 必须 warn';
    if (EC.eccGpuStatus(mk({ remap_pending: 2 })).status !== 'warn') return '重映射待处理必须 warn';
    if (EC.eccGpuStatus(mk({}, { mode_current: 'Disabled' })).status !== 'disabled') return 'ECC 关闭必须 disabled（不得显示成正常 0）';
    if (EC.eccGpuStatus(mk({ v_dram_c: 0, a_dram_c: 0, a_dram_u: 0 })).status !== 'ok') return '全零应 ok';
    if (EC.eccGpuStatus(mk({}, { mode_current: null })).status !== 'unknown') return '无模式字段应 unknown';
    if (!EC.eccModeOn('Enabled') || EC.eccModeOn('Disabled') || EC.eccModeOff('Enabled')) return '模式串判定错';
    return true;
  });
}

  // ============ 报告 ============
  console.log(`单元测试：通过 ${pass} / 失败 ${fail}`);
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(fail ? 1 : 0);
})();
