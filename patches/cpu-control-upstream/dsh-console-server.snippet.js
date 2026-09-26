// dsh-console (vLLM 管理监控台) 集成片段 —— 插在 server.js 的 readahead 模块之后、http.createServer 之前
// 接口: GET /v1/internal/cpuctl (状态 JSON) + POST /v1/internal/cpuctl/cmd (action 白名单)
// ---------------------------- 4) CPU 控制（2026-09-26 hwctl1，「硬件控制」页） ----------------------------
// 调 /usr/local/bin/cpu-ctl-14k（14600K 专用，独立于旧 5950X 的 cpu-ctl）。
// 实测拓扑：6 P 核在线(0,2,4,6,8,10)；小核 cpu12-19 present 可运行时上/下线；
// 超线程被内核 nosmt 压制 → 运行时不可上线兄弟核，开启需改 GRUB 重启。
const CPU_CTL = process.env.CPU_CTL || '/usr/local/bin/cpu-ctl-14k';
const CPU_FREQ_RE = /^\d+(\.\d+)?\s*[GgMm]?$/;          // 4G / 3800M / 5300000
const CPU_SPEC_RE = /^(all|p|e|[0-9][0-9,\-]{0,31})$/;  // all|p|e|0-7,16
const CPU_VAL_RE  = /^[a-z_]{1,40}$/;                    // governor / EPP 值

function cpuCtlRun(args, timeoutMs) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('bash', [CPU_CTL].concat(args.map(String)), { timeout: timeoutMs || 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const errText = String(stderr || '').trim();
        resolve({
          ok: !err,
          output: out || errText || (err ? String(err.message || err) : '(无输出)'),
          killed: !!(err && err.killed),
        });
      });
  });
}

function cpuCtlStatus() {
  return cpuCtlRun(['status', '--json'], 20000).then(r => {
    try { return { ok: true, state: JSON.parse(r.output) }; }
    catch (e) { return { ok: false, error: 'cpu-ctl-14k status 输出无法解析：' + r.output.slice(0, 200) }; }
  });
}

// action 白名单 → cpu-ctl-14k 参数（返回 null = 非法）
function cpuCtlAction(body) {
  const a = String(body.action || '');
  const spec = s => (CPU_SPEC_RE.test(String(s || 'all')) ? String(s || 'all') : null);
  switch (a) {
    case 'freq_max': case 'freq_min': {
      const f = String(body.freq || '').trim();
      if (!CPU_FREQ_RE.test(f) || !spec(body.spec)) return null;
      return { args: ['freq', a === 'freq_max' ? 'max' : 'min', f, spec(body.spec)], timeout: 25000 };
    }
    case 'freq_reset': return { args: ['freq', 'reset'], timeout: 25000 };
    case 'gov': case 'epp': {
      if (!CPU_VAL_RE.test(String(body.val || '')) || !spec(body.spec)) return null;
      return { args: [a, body.val, spec(body.spec)], timeout: 25000 };
    }
    case 'ecore_on':  return { args: ['ecore', 'on'],  timeout: 30000 };
    case 'ecore_off': return { args: ['ecore', 'off'], timeout: 30000 };
    case 'core_on': case 'core_off': {
      const n = body.cpu;
      if (!/^\d{1,3}$/.test(String(n))) return null;
      return { args: ['core', a === 'core_on' ? 'on' : 'off', String(n)], timeout: 30000 };
    }
    case 'ht_off': return { args: ['ht', 'off'], timeout: 30000 };
    case 'ht_on':  return { args: ['ht', 'on'],  timeout: 30000 };
    case 'bench': {
      const s = parseInt(body.secs, 10);
      if (!isFinite(s) || s < 1 || s > 30) return null;
      return { args: ['bench', String(s)], timeout: s * 20000 + 180000, noState: true };
    }
    default: return null;
  }
}

async function cpuCtlPost(body, res) {
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const act = cpuCtlAction(body || {});
  if (!act) return reply(400, { ok: false, msg: '非法参数或不在白名单内' });
  const r = await cpuCtlRun(act.args, act.timeout);
  if (act.noState) return reply(200, { ok: r.ok, msg: r.output, killed: r.killed });
  const st = await cpuCtlStatus();
  reply(200, { ok: r.ok, msg: r.output, state: st.ok ? st.state : null, error: st.ok ? null : st.error });
}


