// ==== [gpu-ecc-1108] GPU ECC 状态与报错记录（硬件监视页「GPU ECC 状态与报错」卡数据源）====
// 需求：① 每张显卡的 ECC 情况（是否开启、当前/待生效模式、Inforom ECC 版本、显存与 SRAM 的
//   可纠正/不可纠正计数、行重映射与页退役）；② ECC 报错情况（任一计数增长即落一条事件，
//   附当时温度/功耗/利用率快照；并收内核 NVRM Xid 事件，ECC 类与非 ECC 类分标）。
// 数据源与铁律：
//  · 计数唯一真值源 = `nvidia-smi --query-gpu`（本机 CMP 170HX + 驱动 610.43.03 实测单条查询
//    68ms 即返回三卡全部字段）。**驱动不支持某列时整条查询直接报错**（不是该列返回 N/A），
//    故按 完整档(0) → 核心档(1) → 最小档(2) 三级回落，生效级别如实随帧输出（前端标注），
//    级别 >0 时每 10 分钟回探一次完整档（驱动升级后字段会回来，不必重启控制台）。
//  · 全部走 gpuQuery 放弃式熔断通道（09-20 铁律：D 状态下 SIGKILL 无效，超时必须自己结算），
//    缺省 30s 一拍 ≈ 占 GPU 查询占空比 2%，与 1s 实时采样共用单飞队列不叠加驱动压力。
//  · 两级计数语义不可混用：volatile = 自驱动加载以来（重启驱动/整机会归零），aggregate =
//    INFOROM 终身计数（断电不丢）。所以"本轮"原值直接显示；"自观测基线新增"= 已完成轮次的
//    整值累加 + 当前轮相对首次观测的增量。计数倒退 = 新一轮开始（落 reset 事件并重新锚定），
//    绝不解读成"错误减少了"。
//  · 字段 N/A（该卡不提供这个计数器，如 CMP 170HX 的 L2/SRAM 计数与行重映射）一律 null、
//    前端 --，**不以 0 冒充**：0 的含义是"检查过、没有错误"，N/A 的含义是"这张卡不报这个数"，
//    两者混同会让"看不到错误"被误读成"没有错误"。
//  · 内核 Xid 是报错的另一半真相：nvidia-smi 只给累计计数，Xid 给出"什么时候、哪张卡、
//    什么事件"。48/63/64/92/94/95/171/172 属 ECC／行重映射类，其余（13/31/43/79…）属应用与
//    驱动故障，一并收进同一张表并分标，便于把"计数涨了"和"当时崩了"对上。
//    源 = `journalctl -k -o short-iso`（ll 在 adm 组直读，零提权），必须 env LC_ALL=C
//    （10-29 教训：systemd 服务环境带 LANG=zh_CN 时日志时间戳格式随 locale 翻译，解析器静默
//    失效全显 --）；无 journald 时如实标"内核日志源不可用"，不假装没有报错。
//  · 事件落盘 gpu-ecc-events.jsonl（控制台重启不丢，环形 maxRecords 摊还整写截尾），
//    逐卡观测基线/轮次累加落 gpu-ecc-state.json（按 GPU UUID 存，换卡可区分）。
//  · 配置 gpu-ecc.json mtime 热加载（缺省启用）；
//    API：GET /v1/internal/gpu-ecc、POST .../cmd {action:save|clear|rebase|rescan}
//    （POST 自动受 console-auth 口令拦截，与其它写接口同规）。日志前缀 [gpu-ecc]。
const ECC_CONFIG_PATH = path.join(__dirname, 'gpu-ecc.json');
const ECC_STATE_PATH = path.join(__dirname, 'gpu-ecc-state.json');
const ECC_EVENTS_PATH = path.join(__dirname, 'gpu-ecc-events.jsonl');
const ECC_TICK_MS = 10 * 1000;          // 周期任务粒度（计数按 pollSec、Xid 按 60s 各自到点才跑）
const ECC_XID_SCAN_MS = 60 * 1000;      // 内核 Xid 扫描间隔（journalctl 单次数 ms，无需更密）
const ECC_LEVEL_RETRY_MS = 10 * 60 * 1000; // 降级档位回探完整档的间隔
const ECC_DEFAULTS = { enabled: true, pollSec: 30, maxRecords: 1000, xidEnabled: true };
let __eccCfg = Object.assign({ mtime: -1 }, ECC_DEFAULTS);

// 列定义（查询字段与展示口径同源，杜绝"查了不显示/显示了没查"）：
//   t='num' → 参与增长判定；t='str' → 原样展示（Enabled/Disabled/[N/A]/6.16/No）
//   lv 越小越基础：2=任何驱动都该有（模式+显存+合计）、1=多数数据中心卡、0=完整档（含
//   SRAM/L2 分项与行重映射/页退役）
//   scope: volatile=本轮（驱动加载以来） / aggregate=终身（INFOROM）
//   kind:  sbe=可纠正（单比特，硬件自动纠正，不损坏数据）/ dbe=不可纠正（双比特，可能损坏数据）
const ECC_COLS = [
  { k: 'index', t: 'num', key: 'index', lv: 2 },
  { k: 'uuid', t: 'str', key: 'uuid', lv: 2 },
  { k: 'ecc.mode.current', t: 'str', key: 'mode_current', lv: 2, label: 'ECC 模式（当前）' },
  { k: 'ecc.mode.pending', t: 'str', key: 'mode_pending', lv: 2, label: 'ECC 模式（重启后）' },
  { k: 'inforom.ecc', t: 'str', key: 'inforom_ecc', lv: 1, label: 'Inforom ECC 版本' },
  { k: 'ecc.errors.corrected.volatile.dram', t: 'num', key: 'v_dram_c', lv: 2, scope: 'volatile', kind: 'sbe', where: 'dram', label: '本轮 显存(DRAM) 可纠正 SBE' },
  { k: 'ecc.errors.uncorrected.volatile.dram', t: 'num', key: 'v_dram_u', lv: 2, scope: 'volatile', kind: 'dbe', where: 'dram', label: '本轮 显存(DRAM) 不可纠正 DBE' },
  { k: 'ecc.errors.corrected.volatile.sram', t: 'num', key: 'v_sram_c', lv: 0, scope: 'volatile', kind: 'sbe', where: 'sram', label: '本轮 SRAM 可纠正 SBE' },
  { k: 'ecc.errors.uncorrected.volatile.sram', t: 'num', key: 'v_sram_u', lv: 0, scope: 'volatile', kind: 'dbe', where: 'sram', label: '本轮 SRAM 不可纠正 DBE' },
  { k: 'ecc.errors.corrected.volatile.l2_cache', t: 'num', key: 'v_l2_c', lv: 0, scope: 'volatile', kind: 'sbe', where: 'l2', label: '本轮 L2 缓存 可纠正 SBE' },
  { k: 'ecc.errors.uncorrected.volatile.l2_cache', t: 'num', key: 'v_l2_u', lv: 0, scope: 'volatile', kind: 'dbe', where: 'l2', label: '本轮 L2 缓存 不可纠正 DBE' },
  { k: 'ecc.errors.corrected.volatile.total', t: 'num', key: 'v_total_c', lv: 1, scope: 'volatile', kind: 'sbe', where: 'total', label: '本轮 合计 可纠正 SBE' },
  { k: 'ecc.errors.uncorrected.volatile.total', t: 'num', key: 'v_total_u', lv: 1, scope: 'volatile', kind: 'dbe', where: 'total', label: '本轮 合计 不可纠正 DBE' },
  { k: 'ecc.errors.corrected.aggregate.dram', t: 'num', key: 'a_dram_c', lv: 2, scope: 'aggregate', kind: 'sbe', where: 'dram', label: '终身 显存(DRAM) 可纠正 SBE' },
  { k: 'ecc.errors.uncorrected.aggregate.dram', t: 'num', key: 'a_dram_u', lv: 2, scope: 'aggregate', kind: 'dbe', where: 'dram', label: '终身 显存(DRAM) 不可纠正 DBE' },
  { k: 'ecc.errors.corrected.aggregate.sram', t: 'num', key: 'a_sram_c', lv: 0, scope: 'aggregate', kind: 'sbe', where: 'sram', label: '终身 SRAM 可纠正 SBE' },
  { k: 'ecc.errors.uncorrected.aggregate.sram', t: 'num', key: 'a_sram_u', lv: 0, scope: 'aggregate', kind: 'dbe', where: 'sram', label: '终身 SRAM 不可纠正 DBE' },
  { k: 'ecc.errors.corrected.aggregate.l2_cache', t: 'num', key: 'a_l2_c', lv: 0, scope: 'aggregate', kind: 'sbe', where: 'l2', label: '终身 L2 缓存 可纠正 SBE' },
  { k: 'ecc.errors.uncorrected.aggregate.l2_cache', t: 'num', key: 'a_l2_u', lv: 0, scope: 'aggregate', kind: 'dbe', where: 'l2', label: '终身 L2 缓存 不可纠正 DBE' },
  { k: 'ecc.errors.corrected.aggregate.total', t: 'num', key: 'a_total_c', lv: 1, scope: 'aggregate', kind: 'sbe', where: 'total', label: '终身 合计 可纠正 SBE' },
  { k: 'ecc.errors.uncorrected.aggregate.total', t: 'num', key: 'a_total_u', lv: 1, scope: 'aggregate', kind: 'dbe', where: 'total', label: '终身 合计 不可纠正 DBE' },
  { k: 'ecc.errors.uncorrected.aggregate.sram.thresholdExceeded', t: 'str', key: 'a_sram_thr', lv: 0, label: 'SRAM 错误超阈（终身）' },
  { k: 'remapped_rows.correctable', t: 'num', key: 'remap_c', lv: 0, scope: 'aggregate', kind: 'remap', where: 'rows', label: '行重映射 可纠正' },
  { k: 'remapped_rows.uncorrectable', t: 'num', key: 'remap_u', lv: 0, scope: 'aggregate', kind: 'remap', where: 'rows', label: '行重映射 不可纠正' },
  { k: 'remapped_rows.pending', t: 'num', key: 'remap_pending', lv: 0, scope: 'aggregate', kind: 'pending', where: 'rows', label: '行重映射 待处理（需重启）' },
  { k: 'remapped_rows.failure', t: 'num', key: 'remap_fail', lv: 0, scope: 'aggregate', kind: 'remap', where: 'rows', label: '行重映射 失败' },
  { k: 'retired_pages.pending', t: 'str', key: 'retired_pending', lv: 0, label: '页退役待加黑' },
  { k: 'retired_pages.single_bit_ecc.count', t: 'num', key: 'retired_sbe', lv: 0, scope: 'aggregate', kind: 'retire', where: 'pages', label: '退役页 SBE' },
  { k: 'retired_pages.double_bit.count', t: 'num', key: 'retired_dbe', lv: 0, scope: 'aggregate', kind: 'retire', where: 'pages', label: '退役页 DBE' },
];
const ECC_BY_KEY = {};
for (const c of ECC_COLS) ECC_BY_KEY[c.key] = c;
function eccColsOfLevel(lv) { return ECC_COLS.filter((c) => c.lv >= lv); }
function eccQueryArgs(lv) {
  return ['--query-gpu=' + eccColsOfLevel(lv).map((c) => c.k).join(','), '--format=csv,noheader,nounits'];
}

function eccCfg() {
  try {
    const st = fs.statSync(ECC_CONFIG_PATH);
    if (st.mtimeMs !== __eccCfg.mtime) {
      const j = JSON.parse(fs.readFileSync(ECC_CONFIG_PATH, 'utf8'));
      const clamp = (v, lo, hi, dft) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dft; };
      __eccCfg = {
        mtime: st.mtimeMs,
        enabled: j.enabled !== false,
        xidEnabled: j.xidEnabled !== false,
        pollSec: clamp(j.pollSec, 10, 3600, ECC_DEFAULTS.pollSec),
        maxRecords: clamp(j.maxRecords, 50, 20000, ECC_DEFAULTS.maxRecords),
      };
    }
  } catch (e) { /* 文件缺失/损坏：保持上一次值（首跑即缺省：启用 + 30s） */ }
  return __eccCfg;
}
function eccSaveCfg(patch) {
  const cur = eccCfg();
  const next = Object.assign({}, ECC_DEFAULTS, cur, patch, { mtime: -1 });
  const out = { enabled: next.enabled !== false, xidEnabled: next.xidEnabled !== false, pollSec: next.pollSec, maxRecords: next.maxRecords };
  fs.writeFileSync(ECC_CONFIG_PATH, JSON.stringify(out, null, 2));
  return eccCfg();
}

// ---- 解析（纯函数，可单测）----
function eccNA(v) { return v == null || /^\[?N\/A\]?$/i.test(String(v).trim()); }
// 行格式 = --format=csv,noheader,nounits（", " 分隔、无引号包裹的嵌套逗号）。
// 列数与档位不符时整行弃（宁可少一行也不猜列位——错位的计数会造出根本不存在的"错误增长"）。
function eccParseRows(out, cols) {
  const list = [];
  for (const line of String(out == null ? '' : out).split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < cols.length) continue;
    const g = { index: null, uuid: null, counters: {}, text: {} };
    cols.forEach((c, i) => {
      const raw = parts[i];
      if (c.key === 'index') { g.index = gpuNum(raw); return; }
      if (c.key === 'uuid') { g.uuid = /^GPU-/.test(raw) ? raw : null; return; }
      if (c.t === 'num') g.counters[c.key] = eccNA(raw) ? null : gpuNum(raw);
      else g.text[c.key] = eccNA(raw) ? null : raw;
    });
    if (g.index != null) list.push(g);
  }
  return list;
}
// 计数增长 / 轮次重置判定（纯函数）：prev 缺失或该列为 null（N/A、上拍查询失败）→ 无基线不出结论。
function eccDiffCounters(prev, cur) {
  const events = [], resets = [];
  for (const k of Object.keys(cur || {})) {
    const c = cur[k];
    if (c == null || !Number.isFinite(c)) continue;
    const p = prev ? prev[k] : null;
    if (p == null || !Number.isFinite(p)) continue;
    if (c > p) events.push({ key: k, from: p, to: c, delta: c - p });
    else if (c < p) resets.push(k); // 倒退 = 新一轮（驱动重载/重启），不是"错误变少"
  }
  return { events, resets };
}
// 自观测基线新增 = 已完成轮次整值累加 + 当前轮相对锚点的增量（纯函数，锚点缺失如实 null）
function eccSinceOne(acc, cur, base) {
  if (cur == null || !Number.isFinite(cur)) return null;
  if (base == null || !Number.isFinite(base)) return null;
  return Math.max(0, (acc || 0) + (cur - base));
}
// journal 时间戳（short-iso 带 +0800 这种无冒号偏移，Date.parse 按 ES 规范可能不吃 → 先补冒号）
function eccParseIso(s) {
  let t = Date.parse(String(s || ''));
  if (!Number.isFinite(t)) {
    const fixed = String(s || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    t = Date.parse(fixed);
  }
  return Number.isFinite(t) ? t : null;
}
// 内核 Xid 行（实测格式）：
//   2026-11-08T09:18:28+0800 ll-desktop kernel: NVRM: Xid (PCI:0000:0a:00): 13, Graphics SM Warp Exception on ...
// 老内核/无 PCI 括号形态一并兼容。解析不出 = 返回 null（不误吞别的 NVRM 行）。
const ECC_XID_ECC_IDS = { 48: 1, 63: 1, 64: 1, 92: 1, 94: 1, 95: 1, 171: 1, 172: 1 };
function eccParseXidLine(line) {
  const m = String(line || '').match(/^(\S+)\s+\S+\s+kernel:\s*NVRM:\s*Xid\s*(?:\(PCI:([0-9a-fA-F:.]+)\))?\s*:\s*(\d+)\s*,?\s*(.*)$/);
  if (!m) return null;
  const ts = eccParseIso(m[1]);
  if (ts == null) return null;
  const xid = parseInt(m[3], 10);
  const msg = String(m[4] || '').trim();
  return {
    ts, bus: m[2] || null, xid, msg,
    ecc: !!ECC_XID_ECC_IDS[xid] || /\bECC\b|remap|retire|row remap|page retirement/i.test(msg),
  };
}
function eccParseXidLines(out) {
  const list = [];
  for (const line of String(out == null ? '' : out).split('\n')) {
    if (line.indexOf('Xid') < 0) continue;
    const e = eccParseXidLine(line);
    if (e) list.push(e);
  }
  return list;
}
// Xid 的 PCI 地址（内核给 "0000:0a:00"，nvidia-smi 给 "0000:0a:00.0"）→ 卡号。
// 匹配不上返回 null（前端如实显示原始地址，绝不按顺序猜卡号——错配会把 A 卡的故障记到 B 卡头上）。
function eccBusToIndex(bus, staticGpus) {
  if (!bus || !Array.isArray(staticGpus)) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/^0{4,6}/, '').replace(/\.[0-7]$/, '').replace(/[^0-9a-f:]/g, '');
  const b = norm(bus);
  if (!b) return null;
  for (const g of staticGpus) {
    if (g && g.pci_bus_id && norm(g.pci_bus_id) === b) return (g.index == null ? null : g.index);
  }
  return null;
}
function eccModeOn(v) { return /enabled/i.test(String(v || '')) && !/disabled/i.test(String(v || '')); }
function eccModeOff(v) { return /disabled/i.test(String(v || '')); }
// 逐卡健康判定（口径写进注释，前端只照搬不再判一次）：
//   error    终身或本轮存在不可纠正（DBE）计数，或行重映射失败 > 0 —— 数据可能已损坏过，该考虑换卡/送保
//   warn     存在可纠正（SBE）计数、行重映射待处理、或 SRAM 超阈 = Yes —— 显存颗粒在退化，值得盯
//   disabled ECC 未开启 —— 位翻转不可检测（静默算错，比崩更坏），必须显式提示而不是显示 0
//   unknown  没有任何一次成功采样
//   ok       开启且各级计数全为 0（N/A 列不参与判定）
function eccGpuStatus(g) {
  if (!g) return { status: 'unknown', label: '尚无采样' };
  if (eccModeOff(g.text && g.text.mode_current)) return { status: 'disabled', label: 'ECC 已关闭' };
  const c = g.counters || {}, s = g.since || {};
  const anyNum = (o, keys) => keys.some((k) => o[k] != null && o[k] > 0);
  const dbeKeys = ['a_dram_u', 'a_total_u', 'v_dram_u', 'v_total_u', 'a_sram_u', 'v_sram_u', 'a_l2_u', 'v_l2_u', 'remap_fail'];
  if (anyNum(c, dbeKeys) || anyNum(s, dbeKeys)) return { status: 'error', label: '存在不可纠正错误' };
  const sbeKeys = ['a_dram_c', 'a_total_c', 'v_dram_c', 'v_total_c', 'a_sram_c', 'v_sram_c', 'a_l2_c', 'v_l2_c', 'remap_c', 'remap_u', 'retired_sbe', 'retired_dbe'];
  if (anyNum(c, sbeKeys) || anyNum(s, sbeKeys)) return { status: 'warn', label: '存在可纠正错误' };
  if (c.remap_pending != null && c.remap_pending > 0) return { status: 'warn', label: '行重映射待重启生效' };
  if (/yes/i.test(String((g.text && g.text.a_sram_thr) || ''))) return { status: 'warn', label: 'SRAM 错误曾超阈' };
  if (eccNA(g.text && g.text.mode_current)) return { status: 'unknown', label: '驱动不提供 ECC 模式' };
  return { status: 'ok', label: '正常（无 ECC 报错）' };
}

// ---- 运行时状态 ----
// __eccFrame  最近一次成功采样帧（失败不覆盖上一帧——10-07 教训：空帧当正常结果会把好数据抹掉）
// __eccState  持久化：逐卡轮次锚点/累加 + Xid 去重游标
// __ecc.events 事件环（越阈新增计数、轮次重置、模式变更、内核 Xid）
let __eccState = null, __eccFrame = null, __eccBusy = false, __eccLevel = 0, __eccLevelAt = 0;
let __eccLastPollAt = 0, __eccLastXidAt = 0, __eccXidError = null, __eccPollError = null;
const __ecc = { events: [], appends: 0, keys: {} };

function eccState() {
  if (__eccState && typeof __eccState === 'object' && __eccState.gpus && typeof __eccState.gpus === 'object') return __eccState;
  try {
    const j = JSON.parse(fs.readFileSync(ECC_STATE_PATH, 'utf8'));
    if (j && typeof j === 'object' && j.gpus && typeof j.gpus === 'object') {
      __eccState = j;
      if (Array.isArray(j.xid_keys)) for (const k of j.xid_keys) __ecc.keys[k] = 1;
      return __eccState;
    }
  } catch (e) { /* 首跑无文件/损坏 → 重建 */ }
  __eccState = { version: 1, initialized_at: Date.now(), gpus: {}, xid_keys: [], xid_cursor: 0 };
  return __eccState;
}
function eccSaveState() {
  try {
    const st = eccState();
    st.xid_keys = Object.keys(__ecc.keys).slice(-800);
    const tmp = ECC_STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, ECC_STATE_PATH);
  } catch (e) { console.warn('[gpu-ecc] 状态落盘失败（忽略）：' + String((e && e.message) || e)); }
}
function eccDayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function eccIngest(ev) {
  if (!ev || typeof ev !== 'object' || ev.ts == null) return;
  __ecc.events.push(ev);
  const cfg = eccCfg();
  while (__ecc.events.length > cfg.maxRecords) {
    const drop = __ecc.events.shift();
    if (drop && drop.dedupe_key) delete __ecc.keys[drop.dedupe_key];
  }
}
function eccLoadExisting() {
  try {
    const size = fs.statSync(ECC_EVENTS_PATH).size;
    if (!size) return;
    const win = Math.min(size, 262144);
    const buf = Buffer.alloc(win);
    const fd = fs.openSync(ECC_EVENTS_PATH, 'r');
    try { fs.readSync(fd, buf, 0, win, size - win); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    if (size > win) lines.shift();
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try { eccIngest(JSON.parse(ln)); } catch (e) {}
    }
    const cfg = eccCfg();
    while (__ecc.events.length > cfg.maxRecords) __ecc.events.shift();
    __ecc.appends = __ecc.events.length; // 保守计：恢复后很快触发一次整写截尾，收敛文件长度
  } catch (e) {
    // 文件不存在 = 正常首跑；其余错误（权限/坏盘）必须出声，防静默吞掉真故障
    if (!e || e.code !== 'ENOENT') console.warn('[gpu-ecc] 历史读取失败（从空记录开始）：' + String((e && e.message) || e));
  }
}
function eccEmit(ev) {
  eccIngest(ev);
  __ecc.appends++;
  try {
    fs.appendFileSync(ECC_EVENTS_PATH, JSON.stringify(ev) + '\n');
    if (__ecc.appends >= eccCfg().maxRecords) {
      fs.writeFileSync(ECC_EVENTS_PATH, __ecc.events.map((r) => JSON.stringify(r)).join('\n') + (__ecc.events.length ? '\n' : ''));
      __ecc.appends = 0;
    }
  } catch (e) { console.warn('[gpu-ecc] 事件落盘失败（内存记录保留）：' + String((e && e.message) || e)); }
  const where = 'GPU' + (ev.idx == null ? '?' : ev.idx);
  console.warn('[gpu-ecc] ' + where + ' ' + (ev.msg || ev.kind));
}
// 现场快照：与高功耗记录卡同源——复用 1s GPU 采样帧（零新增 nvidia-smi），
// 采样过期(>15s)或该卡缺列一律 null，前端 --，不以 0 冒充。
function eccLiveCtx(idx, now) {
  const live = global.__gpuLive;
  if (!live || !live.ts || now - live.ts > 15000 || !Array.isArray(live.gpus)) return { ctx: null, stale: !!(live && live.ts) };
  const g = live.gpus.find((x) => x && x.index === idx) || null;
  if (!g) return { ctx: null, stale: false };
  return {
    ctx: { temp: g.temp == null ? null : g.temp, temp_mem: g.temp_mem == null ? null : g.temp_mem, power: g.power_draw == null ? null : g.power_draw, util: g.util_gpu == null ? null : g.util_gpu, sm: g.sm_clock == null ? null : g.sm_clock },
    stale: false,
  };
}

// ---- 计数采样 ----
async function eccQueryCounters() {
  const order = [];
  const start = (__eccLevelAt && Date.now() - __eccLevelAt > ECC_LEVEL_RETRY_MS) ? 0 : __eccLevel;
  if (start > 0) order.push(0); // 回探完整档（驱动升级后新字段可用，不必重启控制台）
  for (let lv = start; lv <= 2; lv++) order.push(lv);
  for (const lv of order) {
    const out = await gpuQuery(eccQueryArgs(lv), GPU_Q_MS_LIVE);
    if (!out) continue;
    const gpus = eccParseRows(out, eccColsOfLevel(lv));
    if (gpus.length) {
      if (lv !== __eccLevel) console.warn('[gpu-ecc] 生效字段档位=' + lv + '（完整档=0；该驱动/卡不提供的列已按档剔除）');
      __eccLevel = lv; __eccLevelAt = Date.now();
      return { level: lv, gpus };
    }
  }
  return null;
}
function eccApplyFrame(frame, now) {
  const st = eccState();
  const prev = __eccFrame;
  const prevByIdx = {};
  if (prev && Array.isArray(prev.gpus)) for (const g of prev.gpus) prevByIdx[g.index] = g;
  const gpus = [];
  for (const g of frame.gpus) {
    const key = g.uuid || ('idx:' + g.index);
    let rec = st.gpus[key];
    if (!rec) {
      // 首次在场：锚点=当前值（本轮/终身在控制台开始前已有的量，一律不计入"新增"，
      // 只如实显示硬件报告的当前值）
      rec = st.gpus[key] = {
        uuid: g.uuid || null, index: g.index, first_seen_at: now, epoch_base: {}, accum: {}, last: {},
        mode: g.text ? g.text.mode_current : null,
      };
      for (const k of Object.keys(g.counters)) { rec.epoch_base[k] = g.counters[k]; rec.last[k] = g.counters[k]; }
      eccEmit({ ts: now, kind: 'first_seen', scope: null, sev: 'info', idx: g.index, uuid: g.uuid, msg: 'GPU' + g.index + ' ECC 首次纳入观测（基线锚定在当前计数）' });
    } else {
      const d = eccDiffCounters(rec.last, g.counters);
      rec.index = g.index;
      for (const k of Object.keys(g.counters)) {
        const c = g.counters[k];
        if (c == null) continue;                       // 该列不可用：不动锚点，也不当作 0
        if (rec.epoch_base[k] == null) rec.epoch_base[k] = c;
        if (rec.accum[k] == null) rec.accum[k] = 0;
      }
      for (const e of d.events) {
        const meta = ECC_BY_KEY[e.key] || {};
        const ctx = eccLiveCtx(g.index, now).ctx;
        eccEmit(Object.assign({
          ts: now, kind: 'ecc', scope: meta.scope || null,
          sev: meta.kind === 'dbe' ? 'error' : (meta.kind === 'pending' ? 'warn' : 'warn'),
          idx: g.index, uuid: g.uuid, field: e.key, field_key: e.key,
          ekind: meta.kind || null, where: meta.where || null, label: meta.label || e.key,
          from: e.from, to: e.to, delta: e.delta,
          msg: 'GPU' + g.index + ' ' + (meta.label || e.key) + ' +' + e.delta + '（' + e.from + ' → ' + e.to + '）',
        }, ctx ? { ctx } : {}));
      }
      for (const k of d.resets) {
        const meta = ECC_BY_KEY[k] || {};
        const last = rec.last[k];
        if (last != null && rec.epoch_base[k] != null && rec.accum[k] != null) {
          rec.accum[k] += Math.max(0, last - rec.epoch_base[k]); // 上一轮整值归档（本轮计数即将从 0 重新开始）
        }
        rec.epoch_base[k] = g.counters[k] == null ? null : g.counters[k];
        eccEmit({
          ts: now, kind: 'reset', scope: meta.scope || null, sev: 'info', idx: g.index, uuid: g.uuid,
          field: k, label: meta.label || k, from: last, to: g.counters[k],
          msg: 'GPU' + g.index + ' ' + (meta.label || k) + ' 计数倒退（' + last + ' → ' + g.counters[k] + '）＝驱动重载或整机重启，已重新锚定',
        });
      }
      for (const k of Object.keys(g.counters)) rec.last[k] = g.counters[k];
      const modeNow = g.text ? g.text.mode_current : null;
      if (modeNow && rec.mode && rec.mode !== modeNow) {
        eccEmit({ ts: now, kind: 'mode', scope: null, sev: 'warn', idx: g.index, uuid: g.uuid, from: rec.mode, to: modeNow, msg: 'GPU' + g.index + ' ECC 模式变更：' + rec.mode + ' → ' + modeNow });
      }
      if (modeNow) rec.mode = modeNow;
      rec.last_seen_at = now;
    }
    const since = {};
    for (const k of Object.keys(g.counters)) since[k] = eccSinceOne(rec.accum[k], g.counters[k], rec.epoch_base[k]);
    const out = {
      index: g.index, uuid: g.uuid || null, counters: g.counters, text: g.text || {}, since,
      first_seen_at: rec.first_seen_at || now, observed_at: now,
    };
    const sv0 = eccGpuStatus(out);
    out.status = sv0.status; out.status_label = sv0.label;
    gpus.push(out);
  }
  __eccFrame = { ts: now, level: frame.level, gpus };
  __eccPollError = null;
  eccSaveState();
}
function eccPollNow(force) {
  const cfg = eccCfg();
  const now = Date.now();
  if (!cfg.enabled && !force) return Promise.resolve(false);
  if (__eccBusy) return Promise.resolve(false);
  if (!force && now - __eccLastPollAt < cfg.pollSec * 1000) return Promise.resolve(false);
  __eccBusy = true;
  __eccLastPollAt = now;
  return eccQueryCounters().then((frame) => {
    if (!frame) {
      // 查询失败/熔断：保留上一帧（宁旧勿空），只挂 error 供前端黄字提示
      __eccPollError = 'nvidia-smi ECC 查询无结果（超时 / 驱动不可用 / 熔断冷却中），显示上一帧';
      return false;
    }
    try { eccApplyFrame(frame, Date.now()); return true; }
    catch (e) { __eccPollError = 'ECC 帧解析异常：' + String((e && e.message) || e); return false; }
  }).catch((e) => {
    __eccPollError = 'ECC 采样异常：' + String((e && e.message) || e);
    return false;
  }).finally(() => { __eccBusy = false; });
}

// ---- 内核 Xid 采集（journalctl 直读，零提权；LC_ALL=C 防 locale 破坏时间戳解析）----
function eccXidScan() {
  const cfg = eccCfg();
  if (!cfg.xidEnabled) return Promise.resolve(false);
  const now = Date.now();
  __eccLastXidAt = now;
  return spawnCollect('env', ['LC_ALL=C', 'journalctl', '-k', '--no-pager', '-o', 'short-iso', '-n', '800'], 8000, false)
    .then((out) => {
      if (out == null) { __eccXidError = '内核日志（journalctl -k）不可读，Xid 事件暂不可用（ECC 计数不受影响）'; return false; }
      __eccXidError = null;
      const st = eccState();
      const items = eccParseXidLines(out);
      const staticGpus = (global.__gpuStatic && global.__gpuStatic.gpus) || [];
      let added = 0;
      for (const x of items) {
        const dedupe = x.ts + '|' + (x.bus || '') + '|' + x.xid + '|' + x.msg.slice(0, 160);
        if (__ecc.keys[dedupe]) continue;
        __ecc.keys[dedupe] = 1;
        const idx = eccBusToIndex(x.bus, staticGpus);
        const ev = {
          ts: x.ts, kind: 'xid', scope: null, sev: x.ecc ? 'error' : 'warn',
          idx, xid: x.xid, ecc: !!x.ecc, bus: x.bus, msg: 'Xid ' + x.xid + (x.ecc ? '（ECC/行重映射类）' : '') + (x.bus ? ' @PCI:' + x.bus : '') + (idx != null ? ' = GPU' + idx : '') + (x.msg ? '：' + x.msg : ''),
          detail: x.msg, dedupe_key: dedupe,
        };
        eccEmit(ev);
        added++;
      }
      if (items.length) st.xid_cursor = items[items.length - 1].ts;
      if (added) eccSaveState();
      return added > 0;
    })
    .catch((e) => { __eccXidError = 'Xid 扫描异常：' + String((e && e.message) || e); return false; });
}

// ---- 输出 ----
function eccGpuView(frameGpu) {
  const st = eccState();
  const key = frameGpu.uuid || ('idx:' + frameGpu.index);
  const rec = st.gpus[key] || {};
  const lvl = __eccFrame ? __eccFrame.level : 0;
  const gs = ((global.__gpuStatic && global.__gpuStatic.gpus) || []).find((x) => x && (frameGpu.uuid ? x.uuid === frameGpu.uuid : x.index === frameGpu.index)) || {};
  const cols = {};
  for (const c of ECC_COLS) {
    if (c.key === 'index' || c.key === 'uuid') continue;
    const v = (c.t === 'num') ? frameGpu.counters[c.key] : (frameGpu.text ? frameGpu.text[c.key] : null);
    const o = {
      k: c.key, field: c.k, t: c.t, label: c.label || c.k, scope: c.scope || null, kind: c.kind || null, lv: c.lv,
      value: (v == null ? null : v),
      // avail 三态——'value'=有数（含真实的 0）；'na'=查询了但该卡/驱动不提供此计数器（前端 --，
      // 不能显示 0）；'unqueried'=字段档位不含（整条查询会报错，已按档剔除，前端标"未查询"）
      avail: (c.lv >= lvl) ? (v == null ? 'na' : 'value') : 'unqueried',
    };
    if (c.t === 'num') o.since_baseline = (frameGpu.since[c.key] == null ? null : frameGpu.since[c.key]);
    cols[c.key] = o;
  }
  const sv = eccGpuStatus(frameGpu);
  return {
    index: frameGpu.index, uuid: frameGpu.uuid, name: gs.name || null, pci_bus_id: gs.pci_bus_id || null,
    mode_current: (frameGpu.text && frameGpu.text.mode_current) || null,
    mode_pending: (frameGpu.text && frameGpu.text.mode_pending) || null,
    mode_need_reboot: !!(frameGpu.text && frameGpu.text.mode_current && frameGpu.text.mode_pending && frameGpu.text.mode_current !== frameGpu.text.mode_pending),
    mode_on: eccModeOn(frameGpu.text && frameGpu.text.mode_current),
    inforom_ecc: (frameGpu.text && frameGpu.text.inforom_ecc) || null,
    status: sv.status, status_label: sv.label,
    counters: frameGpu.counters, since: frameGpu.since, columns: cols,
    first_seen_at: rec.first_seen_at || null, observed_at: frameGpu.observed_at,
  };
}
function eccStatus(limit) {
  const cfg = eccCfg();
  const now = Date.now();
  const gpus = __eccFrame ? __eccFrame.gpus.map(eccGpuView) : [];
  const dayK = eccDayKey(now);
  let today = 0, xidTotal = 0, xidEcc = 0, sbeEvents = 0, dbeEvents = 0;
  const perCard = {};
  for (const e of __ecc.events) {
    if (eccDayKey(e.ts) === dayK) today++;
    if (e.kind === 'xid') { xidTotal++; if (e.ecc) xidEcc++; }
    if (e.kind === 'ecc') { if (e.ekind === 'dbe') dbeEvents++; else sbeEvents++; }
    if (e.idx != null) perCard[e.idx] = (perCard[e.idx] || 0) + 1;
  }
  const sum = (pick) => { let v = null; for (const g of gpus) { const x = pick(g); if (x != null) v = (v == null ? 0 : v) + x; } return v; };
  return {
    ok: true,
    config: { enabled: cfg.enabled !== false, xidEnabled: cfg.xidEnabled !== false, pollSec: cfg.pollSec, maxRecords: cfg.maxRecords },
    summary: {
      cards: gpus.length,
      ecc_on: gpus.filter((g) => g.mode_on).length,
      ecc_off: gpus.filter((g) => eccModeOff(g.mode_current)).length,
      unknown_mode: gpus.filter((g) => !g.mode_on && !eccModeOff(g.mode_current)).length,
      pending_reboot: gpus.filter((g) => g.mode_need_reboot).length,
      lifetime_sbe: sum((g) => (g.counters.a_total_c != null ? g.counters.a_total_c : g.counters.a_dram_c)),
      lifetime_dbe: sum((g) => (g.counters.a_total_u != null ? g.counters.a_total_u : g.counters.a_dram_u)),
      session_sbe: sum((g) => (g.counters.v_total_c != null ? g.counters.v_total_c : g.counters.v_dram_c)),
      session_dbe: sum((g) => (g.counters.v_total_u != null ? g.counters.v_total_u : g.counters.v_dram_u)),
      since_sbe: sum((g) => g.since.a_total_c),
      since_dbe: sum((g) => g.since.a_total_u),
      bad_cards: gpus.filter((g) => g.status === 'error' || g.status === 'warn' || g.status === 'disabled').length,
      events: __ecc.events.length, today, sbe_events: sbeEvents, dbe_events: dbeEvents,
      xid_events: xidTotal, xid_ecc_events: xidEcc,
      per_card: perCard,
      last_event_ts: __ecc.events.length ? __ecc.events[__ecc.events.length - 1].ts : null,
      poll_age_s: __eccFrame ? Math.round((now - __eccFrame.ts) / 1000) : null,
      live_age_s: (global.__gpuLive && global.__gpuLive.ts) ? Math.round((now - global.__gpuLive.ts) / 1000) : null,
    },
    source: {
      fields_level: __eccFrame ? __eccFrame.level : __eccLevel,
      fields_level_note: ['完整档（含 SRAM/L2 分项与行重映射/页退役）', '核心档（显存 + 合计，该驱动不返回 SRAM/L2/重映射列）', '最小档（仅 ECC 模式与显存计数）'][(__eccFrame ? __eccFrame.level : __eccLevel)] || '未知',
      gpu_query_ms: GPU_Q_MS_LIVE,
      xid_source: cfg.xidEnabled ? 'journalctl -k' : 'off',
      xid_last_scan_at: __eccLastXidAt || null,
      xid_error: __eccXidError,
      poll_error: __eccPollError,
    },
    gpus,
    // 按时间倒序（不是插入序）：Xid 事件的历史时间戳早于它被扫描入库的时刻，
    // 用插入序会把"刚扫到的 3 小时前故障"排到"刚刚的首次观测"之前，读起来像时间错乱。
    // 同刻事件保持插入顺序（decorate-sort-undecorate，Array.sort 在 V8 是稳定排序，但显式带上
    // 插入下标更省心——旧 node 版本/其他引擎不保证）。
    events: __ecc.events.slice(-Math.max(1, Math.min(1000, limit || 200)))
      .map((e, i) => [e, i])
      .sort((a, b) => ((b[0].ts || 0) - (a[0].ts || 0)) || (b[1] - a[1]))
      .map((x) => x[0]),
    error: __eccFrame ? null : (cfg.enabled ? '尚未完成首次 ECC 采样（' + (__eccPollError || '等待 nvidia-smi 通道空闲') + '）' : 'ECC 采样已在配置中关闭'),
    refreshed_at: __eccFrame ? __eccFrame.ts : null,
  };
}
// 硬件监视页 GPU 明细表的 ECC 角标（同步纯查表，零 IO 零子进程——该表是 1s 轮询）
function eccBriefByIndex() {
  const out = {};
  if (!__eccFrame) return out;
  for (const g of __eccFrame.gpus) {
    const pick = (a, b) => (g.counters[a] != null ? g.counters[a] : (g.counters[b] != null ? g.counters[b] : null));
    out[g.index] = {
      mode: g.text.mode_current || null,
      on: eccModeOn(g.text.mode_current),
      pending: g.text.mode_pending || null,
      lifetime_sbe: pick('a_total_c', 'a_dram_c'),
      lifetime_dbe: pick('a_total_u', 'a_dram_u'),
      session_sbe: pick('v_total_c', 'v_dram_c'),
      session_dbe: pick('v_total_u', 'v_dram_u'),
      since_dbe: (g.since.a_total_u != null) ? g.since.a_total_u : null,
      status: g.status, label: g.status_label, refreshed_at: __eccFrame.ts,
    };
  }
  return out;
}
function eccRebase(now) {
  const st = eccState();
  for (const k of Object.keys(st.gpus)) {
    const r = st.gpus[k];
    r.epoch_base = Object.assign({}, r.last || {});
    r.accum = {};
    r.baselined_at = now;
  }
  eccSaveState();
}
function eccClearEvents() {
  __ecc.events = []; __ecc.appends = 0; __ecc.keys = {};
  const st = eccState();
  st.xid_keys = []; st.xid_cursor = 0;
  try { fs.writeFileSync(ECC_EVENTS_PATH, ''); } catch (e) {}
  eccSaveState();
  console.log('[gpu-ecc] 报错记录已由控制台清空（计数与观测基线保留；下一次扫描会把游标之后的内核 Xid 重新收进来）');
}
async function eccCmd(req, res) {
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const body = await cpuCtlReadBody(req);
  if (!body) return reply(400, { ok: false, msg: '请求体不是合法 JSON' });
  const act = String(body.action || '');
  if (act === 'clear') {
    eccClearEvents();
    return reply(200, Object.assign({ action: act, ok: true, msg: '报错记录已清空' }, eccStatus(1)));
  }
  if (act === 'rebase') {
    eccRebase(Date.now());
    console.log('[gpu-ecc] 观测基线已按当前计数重新锚定（"自基线新增"从 0 起算，硬件终身计数不受影响）');
    return reply(200, Object.assign({ action: act, ok: true, msg: '观测基线已重置为当前计数' }, eccStatus(1)));
  }
  if (act === 'rescan') {
    await eccPollNow(true);
    const n = await eccXidScan();
    return reply(200, Object.assign({ action: act, ok: true, msg: n ? '已重新采样并补扫内核 Xid' : '已重新采样（无新增事件）' }, eccStatus(1)));
  }
  if (act === 'save') {
    const patch = {};
    if (body.enabled != null) patch.enabled = !!body.enabled;
    if (body.xidEnabled != null) patch.xidEnabled = !!body.xidEnabled;
    if (body.pollSec != null) { const v = parseInt(body.pollSec, 10); if (!(v >= 10 && v <= 3600)) return reply(400, { ok: false, msg: 'pollSec 需在 10~3600 之间（秒）' }); patch.pollSec = v; }
    if (body.maxRecords != null) { const v = parseInt(body.maxRecords, 10); if (!(v >= 50 && v <= 20000)) return reply(400, { ok: false, msg: 'maxRecords 需在 50~20000 之间' }); patch.maxRecords = v; }
    eccSaveCfg(patch);
    while (__ecc.events.length > eccCfg().maxRecords) __ecc.events.shift();
    console.log('[gpu-ecc] 配置已更新：' + JSON.stringify(eccCfg()).replace(/"mtime":-?\d+,/, ''));
    return reply(200, Object.assign({ action: act, ok: true, msg: '设置已保存并即时生效' }, eccStatus(1)));
  }
  return reply(400, { ok: false, msg: 'action 必须是 save | clear | rebase | rescan' });
}
function eccHandle(req, res, urlObj) {
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const sub = urlObj.pathname.slice('/v1/internal/gpu-ecc'.length);
  if (req.method === 'POST' && sub === '/cmd') return eccCmd(req, res);
  if (req.method !== 'GET') return reply(405, { ok: false, error: '仅支持 GET / POST .../cmd' });
  let st;
  try { st = eccStatus(parseInt(urlObj.searchParams.get('limit'), 10) || 200); }
  catch (e) { return reply(500, { ok: false, error: String((e && e.message) || e) }); }
  return reply(200, st);
}
eccLoadExisting();
if (!global.__gpuEccTimer) {
  global.__gpuEccTimer = setInterval(() => {
    try {
      eccPollNow(false);
      if (Date.now() - __eccLastXidAt >= ECC_XID_SCAN_MS) eccXidScan();
    } catch (e) { console.warn('[gpu-ecc] 周期任务异常（忽略本拍）：' + String((e && e.message) || e)); }
  }, ECC_TICK_MS);
  if (global.__gpuEccTimer.unref) global.__gpuEccTimer.unref();
  // 启动延迟 3s：让 GPU 采样器与静态规格预热先跑完冷初始化（10-07 熔断教训——
  // 服务启动瞬间多路 nvidia-smi 同时开火会把冷初始化叠加成超时）
  setTimeout(() => { eccPollNow(true); eccXidScan(); }, 3000);
}
// ==== [gpu-ecc-1108] END module ====
