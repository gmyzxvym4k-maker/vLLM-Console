// dsh-console index.html 前端片段 —— CPU 控制卡的全部 JS（渲染/轮询/命令）
// 对应的 HTML 卡片结构见 README「前端卡片」一节
/* ==================== 3b) CPU 控制（2026-09-26 hwctl1，「硬件控制」页）==================== */
let cpuTimer = null, cpuCmdBusy = false, cpuTileSig = '', cpuOptSig = '';

function startCpuPolling() { if (!cpuTimer) cpuTimer = setInterval(loadCpuCtl, 5000); }
function stopCpuPolling() { if (cpuTimer) { clearInterval(cpuTimer); cpuTimer = null; } }
function cpuGHz(khz) { return khz ? (khz / 1000000).toFixed(2) : '–'; }

function loadCpuCtl() {
    return fetch('/v1/internal/cpuctl', { cache: 'no-store' })
        .then(r => r.json())
        .then(d => { if (d && d.ok === false) renderCpuErr(d.error || '未知错误'); else if (d) renderCpuCtl(d); })
        .catch(() => {});
}

function renderCpuErr(msg) {
    const chip = document.getElementById('cpuChip');
    if (chip) { chip.textContent = '离线 — ' + msg; chip.style.color = 'var(--red)'; }
}

function renderCpuCtl(d) {
    const set = (id, txt, color) => { const el = document.getElementById(id); if (el) { el.textContent = txt; if (color) el.style.color = color; } };
    const chip = document.getElementById('cpuChip');
    if (chip) {
        chip.textContent = d.model + ' · 在线 ' + d.onlineCount + ' 核 [' + d.onlineStr + ']'
            + ' · 小核 ' + d.ecores.length + ' 个' + (d.nosmt ? ' · nosmt' : '');
        chip.style.color = 'var(--green)';
    }
    set('cpuHtState', d.smtControl === 'on' ? '开启（' + d.onlineCount + ' 线程在线）'
        : d.smtControl === 'off' ? '关闭'
        : d.smtControl === 'forceoff' ? '被 BIOS 强制关闭' : (d.smtControl || '未知'),
        d.smtControl === 'on' ? 'var(--green)' : 'var(--orange)');
    const htBtn = document.getElementById('cpuHtBtn');
    if (htBtn) {
        htBtn.textContent = d.smtControl === 'on' ? '关闭超线程' : '开启超线程';
        htBtn.disabled = (d.smtControl !== 'on' && d.smtControl !== 'off');
    }

    // 调速器 / EPP 下拉：仅当可选值变化时重建（避免打掉用户正选着的项）
    const first = d.cores.find(c => c.online && c.govAvail && c.govAvail.length);
    if (first) {
        const osig = first.govAvail.join(',') + '|' + first.eppAvail.join(',');
        if (osig !== cpuOptSig) {
            cpuOptSig = osig;
            const g = document.getElementById('cpuGov'), e = document.getElementById('cpuEpp');
            if (g) { g.innerHTML = '<option value="">（当前）</option>' + first.govAvail.map(v => '<option value="' + v + '">' + v + '</option>').join(''); g.value = ''; }
            if (e) { e.innerHTML = '<option value="">（当前）</option>' + first.eppAvail.map(v => '<option value="' + v + '">' + v + '</option>').join(''); e.value = ''; }
        }
        const g = document.getElementById('cpuGov'), e = document.getElementById('cpuEpp');
        if (g && document.activeElement !== g) g.placeholder = first.governor;
        if (e && document.activeElement !== e) e.placeholder = first.epp;
    }

    // 核瓦片：仅在核集合/在线状态变化时重建 DOM（防打掉点击），每拍只刷新数值
    const sig = d.cores.map(c => c.cpu + ':' + (c.online ? 1 : 0) + ':' + c.type).join(',');
    const grid = document.getElementById('cpuCoreGrid');
    if (!grid) return;
    if (sig !== cpuTileSig) {
        cpuTileSig = sig;
        grid.innerHTML = d.cores.map(c => {
            const canToggle = c.cpu !== 0;   // cpu0 无 online 文件，恒在线
            // 右下角身份标签（线程属性）：Physical = 物理核主线程（P/E 都是），HT = 超线程兄弟线程
            const isSib = c.siblings && c.siblings.length && c.cpu > Math.min.apply(null, c.siblings);
            const tag = isSib ? ['HT', '#8b5cf6'] : ['Physical', 'var(--accent)'];
            const style = 'position:relative;border:1px solid var(--border);border-radius:8px;padding:6px 9px;'
                + (c.online ? '' : 'opacity:0.5;')
                + (canToggle ? 'cursor:pointer;' : '');
            const attrs = 'data-ctile="' + c.cpu + '" style="' + style + '"'
                + (canToggle
                    ? ' class="cpu-tog" title="点击' + (c.online ? '下线' : '上线') + ' cpu' + c.cpu + '"'
                      + ' onclick="cpuCoreCmd(' + c.cpu + ',' + (c.online ? "'core_off'" : "'core_on'") + ')"'
                    : ' title="cpu0 恒在线，不可下线"');
            return '<div ' + attrs + '>'
                + '<div style="display:flex;align-items:center;gap:5px;font-size:12px;font-weight:600">'
                + '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + (c.online ? 'var(--green)' : 'var(--text-tertiary)') + '"></span>'
                + '<span>cpu' + c.cpu + '</span>'
                + '<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:' + (c.type === 'E' ? 'var(--orange)' : 'var(--accent-weak,#eff6ff)') + ';color:' + (c.type === 'E' ? '#fff' : 'var(--accent)') + '">' + (c.type === 'E' ? 'E' : 'P') + '</span>'
                + '<span style="flex:1"></span>'
                + '<span style="font-size:10px;color:var(--text-tertiary)">' + (canToggle ? (c.online ? '点击下线' : '点击上线') : '恒在线') + '</span>'
                + '</div>'
                + '<div id="cpuFreqV-' + c.cpu + '" style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text-primary)">–</div>'
                + '<div id="cpuRangeV-' + c.cpu + '" style="font-size:10.5px;color:var(--text-tertiary);font-variant-numeric:tabular-nums">–</div>'
                + '<span style="position:absolute;right:7px;bottom:5px;font-size:9.5px;line-height:1;padding:2px 5px;border-radius:4px;color:#fff;background:' + tag[1] + ';opacity:0.85">' + tag[0] + '</span>'
                + '</div>';
        }).join('');
    }
    d.cores.forEach(c => {
        const f = document.getElementById('cpuFreqV-' + c.cpu);
        if (f) {
            if (!c.online) { f.textContent = '（下线）'; f.title = ''; f.style.color = ''; }
            else if (c.min && c.cur < c.min - 200000) {
                // 空闲核读数低于下限：APERF/MPERF 含 C-state 空闲周期的读数特性，非锁频失效（实测负载下锁值精确生效）
                f.textContent = cpuGHz(c.cur) + ' GHz';
                f.style.color = 'var(--text-tertiary)';
                f.title = '空闲核读数（含 C-state 空闲周期，可低于锁定下限）。锁频以负载下的实际频率为准——实测锁 4.6G 满载恰好 4600MHz、锁 3G 满载恰好 3000MHz。';
            } else { f.textContent = cpuGHz(c.cur) + ' GHz'; f.style.color = 'var(--text-primary)'; f.title = ''; }
        }
        const r = document.getElementById('cpuRangeV-' + c.cpu);
        if (r) r.textContent = c.online ? (cpuGHz(c.min) + ' ~ ' + cpuGHz(c.max) + ' GHz') : (c.type === 'E' ? '4.0 GHz 档' : '5.3 GHz 档');
    });
}

async function cpuCmd(action, extra, label) {
    if (cpuCmdBusy) return;
    cpuCmdBusy = true;
    document.querySelectorAll('#cpuCtlCard button').forEach(b => { b.dataset.cpuCtlWasDisabled = b.disabled ? '1' : ''; b.disabled = true; });
    const log = document.getElementById('cpuLog');
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (log) log.textContent = '[' + t + '] ' + label + '\n执行中…（不要离开本页）';
    try {
        const r = await fetch('/v1/internal/cpuctl/cmd', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ action: action }, extra || {})),
        });
        const d = await r.json();
        if (log) log.textContent = '[' + t + '] ' + label + '\n' + (d.msg || (d.ok ? '完成' : '失败'));
        if (d.state) renderCpuCtl(d.state);
    } catch (e) {
        if (log) log.textContent = '[' + t + '] ' + label + '\n请求失败: ' + e;
    }
    cpuCmdBusy = false;
    document.querySelectorAll('#cpuCtlCard button').forEach(b => { if (!b.dataset.cpuCtlWasDisabled) b.disabled = false; delete b.dataset.cpuCtlWasDisabled; });
    loadCpuCtl();
}

function cpuFreqCmd(kind) {
    const sel = document.getElementById(kind === 'freq_max' ? 'cpuSpecMax' : 'cpuSpecMin');
    const inp = document.getElementById(kind === 'freq_max' ? 'cpuFreqMax' : 'cpuFreqMin');
    let spec = sel ? sel.value : 'all';
    if (spec === '') {
        spec = (document.getElementById('cpuSpecNum').value || '').trim();
        if (!spec) { alert('请先填「按编号」，如 0-7,12'); return; }
    }
    const v = (inp.value || '').trim();
    if (!v) { alert('请输入频率，如 4.5G / 3800M / 5300000(kHz)'); return; }
    const act = kind === 'freq_max' ? '限制最高' : '锁定最低';
    cpuCmd(kind, { freq: v, spec: spec }, act + '频率 ' + v + ' @ ' + spec);
}

function cpuFreqReset() {
    if (!confirm('恢复所有核改动前的原始最高/最低频率？')) return;
    cpuCmd('freq_reset', {}, '恢复默认频率');
}

function cpuGovApply() {
    const g = document.getElementById('cpuGov').value;
    const e = document.getElementById('cpuEpp').value;
    const spec = document.getElementById('cpuGovSpec').value;
    if (!g && !e) { alert('先在下拉里选一个调速器或 EPP 值'); return; }
    if (g) cpuCmd('gov', { val: g, spec: spec }, '调速器 -> ' + g + ' @ ' + spec);
    if (e) cpuCmd('epp', { val: e, spec: spec }, 'EPP -> ' + e + ' @ ' + spec);
}

function cpuCoreCmd(cpu, action) {
    const name = action === 'core_off' ? '下线' : '上线';
    if (!confirm((action === 'core_off' ? '下线' : '上线') + ' cpu' + cpu + '？')) return;
    cpuCmd(action, { cpu: cpu }, name + ' cpu' + cpu);
}

function cpuEcoreCmd(action) {
    const off = action === 'ecore_off';
    if (!confirm((off ? '下线' : '上线') + '全部 8 个小核（cpu12–19）？' + (off ? '只剩 6 个 P 核继续服务。' : ''))) return;
    cpuCmd(action, {}, (off ? '下线' : '上线') + '小核');
}

function cpuHtToggle() {
    const st = (document.getElementById('cpuHtState').textContent || '').trim();
    const turningOn = st.indexOf('关闭') >= 0;
    if (!confirm((turningOn ? '开启' : '关闭') + '超线程？（smt/control 运行时直切，立即生效，无需重启）')) return;
    cpuCmd(turningOn ? 'ht_on' : 'ht_off', {}, (turningOn ? '开启' : '关闭') + '超线程');
}

function cpuBench() {
    const secs = parseInt(document.getElementById('cpuBenchSecs').value, 10) || 2;
    const chip = document.getElementById('cpuChip');
    const onlineN = (chip && chip.textContent.match(/在线 (\d+) 核/)) ? parseInt(chip.textContent.match(/在线 (\d+) 核/)[1], 10) : 6;
    if (!confirm('性能测试：' + onlineN + ' 个在线核逐个单线程满载 ' + secs + 's × 3 轮，再加一轮多核并行，约 ' + (onlineN * secs * 3 + secs) + ' 秒。\n期间温度会升高，继续？')) return;
    cpuCmd('bench', { secs: secs }, '性能测试 ' + secs + 's/核');
}

