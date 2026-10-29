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
  const UP = load(['UP_DATE_WTMP_RE', 'UP_DATE_ISO_RE', 'upParseWtmp', 'upParseJournal', 'upMergeIv', 'upSum']);
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

  // ============ 报告 ============
  console.log(`单元测试：通过 ${pass} / 失败 ${fail}`);
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(fail ? 1 : 0);
})();
