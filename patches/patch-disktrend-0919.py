#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
8889 控制台：硬件监视页新增「磁盘读取速度走势」卡。

后端（server.js）：
  1) sampleDiskStats 每 tick 追加逐秒速率历史 global.__diskHistory（1 秒/点，保留 30 分钟）
  2) 新端点 /v1/internal/disk-trend?win=秒 —— 纯内存读取，不碰 lsblk/smartctl，可 2 秒轮询
  3) buildStorageSnapshot 顺手把设备标签（型号/挂载点）写进 global.__diskLabels 供走势卡图例复用
前端（index.html）：
  4) 磁盘 I/O 表之后插入 #storageDiskTrendCard（canvas 自绘 + 3/10/30 分钟窗口切换 + 图例）
  5) startStoragePolling 挂 2 秒轮询

用法：python3 patch-disktrend-0919.py [--revert]
幂等：已打过补丁时报 already，不重复插入。
"""
import os
import shutil
import sys

DEPLOY = os.environ.get("DEPLOY_DIR", "/home/ll/deploy")
SERVER = os.path.join(DEPLOY, "server.js")
INDEX = os.path.join(DEPLOY, "index.html")
TAG = "disktrend-0919"

# ---------------------------------------------------------------- 后端补丁
B1_OLD = """    arr.push({ ts: now, dev: readDiskStatsRaw() });
    while (arr.length > 32) arr.shift();
  }
"""
B1_NEW = """    arr.push({ ts: now, dev: readDiskStatsRaw() });
    while (arr.length > 32) arr.shift();
    // 逐秒速率历史（磁盘读写速度走势，接口 /v1/internal/disk-trend）
    try { appendDiskHistory(arr[arr.length - 2], arr[arr.length - 1]); } catch (e) {}
  }
"""

B2_OLD = """      avg_queue: dIoMs > 0 ? r3(dWIoMs / dIoMs) : 0,
    };
  }
"""
B2_NEW = """      avg_queue: dIoMs > 0 ? r3(dWIoMs / dIoMs) : 0,
    };
  }

  // ---- 磁盘读写速度历史（走势曲线，接口 /v1/internal/disk-trend）----
  // 注意：本段与 sampleDiskStats 同在 request handler 作用域内，且 setInterval 捕获的是
  // 首个请求的那份闭包——若那个请求在下方某条路由提前 return，handler 作用域里的
  // const/let 会永远停在 TDZ（ReferenceError）。故这里只用函数声明 + 函数内字面量，
  // 不在 handler 作用域放 const。
  function appendDiskHistory(prev, cur) {
    if (!prev || !cur || !prev.dev || !cur.dev) return;
    const devRe = /^(nvme\\d+n\\d+|sd[a-z]+|vd[a-z]+|hd[a-z]+)$/; // 只算物理整盘：分区/dm/loop 与整盘重复计数
    const KEEP = 1800;                                            // 1 秒/点 → 保留 30 分钟
    const dt = (cur.ts - prev.ts) / 1000;
    if (!(dt > 0.2 && dt < 5)) return; // 间隔异常（事件循环卡顿、计数器重置）不出点，避免假尖峰
    const per = {};
    let tr = 0, tw = 0;
    for (const name of Object.keys(cur.dev)) {
      if (!devRe.test(name)) continue;
      const a = prev.dev[name], b = cur.dev[name];
      if (!a || !b) continue;
      const r = Math.max(0, b.read_sectors - a.read_sectors) * 512 / dt;
      const w = Math.max(0, b.write_sectors - a.write_sectors) * 512 / dt;
      per[name] = [Math.round(r), Math.round(w)];
      tr += r; tw += w;
    }
    if (!Object.keys(per).length) return;
    const H = global.__diskHistory || (global.__diskHistory = []);
    H.push({ t: Math.round(cur.ts / 1000), r: Math.round(tr), w: Math.round(tw), d: per });
    if (H.length > KEEP) H.splice(0, H.length - KEEP);
  }
  // 取窗口内走势并按桶抽稀到 ≤300 点（桶内均值）：30 分钟窗口也只有 300 点，响应不膨胀
  function diskTrendSeries(winS) {
    const H = global.__diskHistory || [];
    const from = Math.round(Date.now() / 1000) - winS;
    let i = 0;
    while (i < H.length && H[i].t < from) i++;
    const pts = H.slice(i);
    const bucket = Math.max(1, Math.ceil(pts.length / 300));
    const out = [];
    for (let k = 0; k < pts.length; k += bucket) {
      const seg = pts.slice(k, k + bucket);
      if (!seg.length) continue;
      const acc = { t: seg[seg.length - 1].t, r: 0, w: 0, d: {} };
      for (const p of seg) {
        acc.r += p.r; acc.w += p.w;
        for (const n of Object.keys(p.d)) {
          const a = acc.d[n] || (acc.d[n] = [0, 0]);
          a[0] += p.d[n][0]; a[1] += p.d[n][1];
        }
      }
      acc.r = Math.round(acc.r / seg.length);
      acc.w = Math.round(acc.w / seg.length);
      for (const n of Object.keys(acc.d)) {
        acc.d[n] = [Math.round(acc.d[n][0] / seg.length), Math.round(acc.d[n][1] / seg.length)];
      }
      out.push(acc);
    }
    return { points: out, sample_s: bucket, raw_points: pts.length };
  }
"""

B3_OLD = """      snap = { ts: new Date().toISOString(), error: String(e && e.message || e), disks: [], partitions: [], ioStats: {}, totals: {} };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(snap));
    return;
  }
"""
B3_NEW = """      snap = { ts: new Date().toISOString(), error: String(e && e.message || e), disks: [], partitions: [], ioStats: {}, totals: {} };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(snap));
    return;
  }

  // === Internal API: 磁盘读写速度走势（纯内存历史，不调 lsblk/smartctl，可 2 秒轮询）===
  if (pathname === '/v1/internal/disk-trend') {
    let win = 180;
    try { win = parseInt(urlObj.searchParams.get('win'), 10) || 180; } catch (e) {}
    win = Math.min(1800, Math.max(30, win));
    let body;
    try {
      const s = diskTrendSeries(win);
      const labels = global.__diskLabels || [];
      const names = labels.map((x) => x.name);
      const live = {};
      for (const n of names) {
        const r = diskRateFor(n);
        if (r) live[n] = { read_bps: r.read_bps, write_bps: r.write_bps, window_s: r.window_s };
      }
      body = {
        ts: new Date().toISOString(), win_s: win,
        sample_s: s.sample_s, raw_points: s.raw_points,
        points: s.points, devices: labels, live,
      };
    } catch (e) {
      body = { ts: new Date().toISOString(), win_s: win, points: [], devices: [], live: {}, error: String(e && e.message || e) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }
"""

B4_OLD = """    // 按容量倒序（系统盘/数据盘在前，虚拟设备在后）
    result.disks.sort((a, b) => (b.size_bytes || 0) - (a.size_bytes || 0));
"""
B4_NEW = """    // 按容量倒序（系统盘/数据盘在前，虚拟设备在后）
    result.disks.sort((a, b) => (b.size_bytes || 0) - (a.size_bytes || 0));

    // 设备标签留给走势卡图例复用，省得 /v1/internal/disk-trend 再跑一次 lsblk。
    // mount 取「图例友好」的那一个：lsblk 的 MOUNTPOINT 单列只报一个挂载点，本机数据盘
    // 报的是 chroot bind 的 <真实路径>/rootfs/<真实路径>（如
    // /media/ll/data/vllm-image/rootfs/media/ll/data），故先按 /rootfs/ 剥回真实路径，
    // 再优先 /，最后取最短。表格用的 mount_display 保持原样不动。
    try {
      global.__diskLabels = result.disks.filter((d) => d.kind === 'disk').map((d) => {
        const norm = (m) => { const s = String(m), k = s.indexOf('/rootfs/'); if (k < 0) return s; const rest = s.slice(k + 8); return rest ? (rest.charAt(0) === '/' ? rest : '/' + rest) : '/'; };
        const pool = Array.from(new Set((Array.isArray(d.mountpoints) ? d.mountpoints : []).map(norm)));
        const mount = pool.indexOf('/') >= 0 ? '/' : (pool.length ? pool.sort((a, b) => a.length - b.length)[0] : '未挂载');
        return { name: d.name, model: d.model || '', mount, mount_display: d.mount_display || '未挂载', size_gb: d.size_gb };
      });
    } catch (e) {}
"""

# ---------------------------------------------------------------- 前端补丁
F1_OLD = """            <!-- 处理器（CPU）：整体利用率 / 各核实时负载 / 频率 / 温度 / 负载 / 规格明细 -->
"""
F1_NEW = """            <!-- 磁盘读取速度走势（/proc/diskstats 逐秒采样，控制台内存历史） -->
            <div class="card mb-3" id="storageDiskTrendCard">
                <div class="card-header" style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">
                    <h3 style="font-size:14px;font-weight:600">磁盘读取速度走势</h3>
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                        <div id="diskTrendWinBtns" style="display:flex;gap:4px"></div>
                        <span style="font-size:11px;color:var(--text-tertiary)" id="storageDiskTrendHint">读取中…</span>
                    </div>
                </div>
                <div class="card-body" style="padding:0">
                    <div style="padding:10px 14px">
                        <canvas id="diskTrendCanvas" style="width:100%;height:150px"></canvas>
                        <div id="diskTrendLegend" style="display:flex;flex-wrap:wrap;gap:14px;font-size:11px;margin-top:7px"></div>
                        <div id="diskTrendMeta" style="font-size:11px;color:var(--text-tertiary);margin-top:4px"></div>
                    </div>
                </div>
            </div>

            <!-- 处理器（CPU）：整体利用率 / 各核实时负载 / 频率 / 温度 / 负载 / 规格明细 -->
"""

F2_OLD = """function loadNetData() {
"""
F2_NEW = """// ==== 磁盘读取速度走势卡（数据源 /v1/internal/disk-trend：/proc/diskstats 逐秒采样）====
// 命名一律带 diskTrend/StorageDiskTrend 前缀：index.html 是多会话并写的单体 HTML，
// 同名 function 声明会被后者静默覆盖且无任何报错（09-15 CPU 卡事故）。
var diskTrendTimer = null;
var DISK_TREND_WINS = [{ s: 180, label: '3 分钟' }, { s: 600, label: '10 分钟' }, { s: 1800, label: '30 分钟' }];
var DISK_TREND_COLORS = ['#a78bfa', '#2dd4bf', '#fbbf24', '#f472b6', '#38bdf8', '#fb7185'];

function diskTrendWin() {
    let v = 0;
    try { v = parseInt(localStorage.getItem('dsh_disk_trend_win') || '', 10) || 0; } catch (e) { v = 0; }
    for (const w of DISK_TREND_WINS) { if (w.s === v) return v; }
    return DISK_TREND_WINS[0].s;
}
function renderDiskTrendWinBtns() {
    const box = document.getElementById('diskTrendWinBtns');
    if (!box) return;
    const cur = diskTrendWin();
    box.innerHTML = DISK_TREND_WINS.map((w) =>
        '<button class="btn" data-win="' + w.s + '" style="padding:2px 10px;font-size:11px;line-height:1.7' +
        (w.s === cur ? ';background:var(--blue);border-color:var(--blue);color:#fff' : '') + '">' + w.label + '</button>'
    ).join('');
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        const s = parseInt(b.getAttribute('data-win'), 10);
        if (s === diskTrendWin()) return;
        try { localStorage.setItem('dsh_disk_trend_win', String(s)); } catch (e) {}
        renderDiskTrendWinBtns();
        loadDiskTrendData();
    }));
}
function loadDiskTrendData() {
    apiFetch('/v1/internal/disk-trend?win=' + diskTrendWin()).then((d) => {
        if (d) renderStorageDiskTrendCard(d);
    }).catch(() => {});
}
function diskTrendDevLabel(dv) {
    if (!dv) return '?';
    return (dv.mount && dv.mount !== '未挂载') ? dv.mount : (dv.name || '?');
}
function renderStorageDiskTrendCard(d) {
    const pts = Array.isArray(d.points) ? d.points : [];
    const devs = Array.isArray(d.devices) ? d.devices : [];
    const live = d.live || {};
    const series = [{ key: 'r', label: '合计读取', color: '#60a5fa', width: 2, fill: 'rgba(96,165,250,.14)' }];
    devs.forEach((dv, i) => series.push({
        key: 'd:' + dv.name, label: diskTrendDevLabel(dv),
        color: DISK_TREND_COLORS[i % DISK_TREND_COLORS.length], width: 1.3,
    }));
    series.push({ key: 'w', label: '合计写入', color: '#fb923c', width: 1.2, dashed: true });
    drawStorageDiskTrend('diskTrendCanvas', 'diskTrendMeta', pts, series, d);

    const legend = document.getElementById('diskTrendLegend');
    if (legend) {
        const last = pts.length ? pts[pts.length - 1] : null;
        const chip = (label, val, color, title) =>
            '<span style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap" title="' + (title || '') + '">' +
            '<i style="width:9px;height:9px;border-radius:2px;background:' + color + ';display:inline-block"></i>' +
            '<span style="color:var(--text-tertiary)">' + label + '</span>' +
            '<b style="font-variant-numeric:tabular-nums">' + val + '</b></span>';
        let h = chip('合计读取', last ? fmtRate(last.r) : '--', '#60a5fa', '所有物理盘读取速率之和（蓝实线+填充）');
        devs.forEach((dv, i) => {
            const lv = live[dv.name] ? live[dv.name].read_bps
                : (last && last.d && last.d[dv.name] ? last.d[dv.name][0] : null);
            h += chip(diskTrendDevLabel(dv), lv == null ? '--' : fmtRate(lv),
                DISK_TREND_COLORS[i % DISK_TREND_COLORS.length], dv.name + (dv.model ? ' · ' + dv.model : ''));
        });
        h += chip('合计写入', last ? fmtRate(last.w) : '--', '#fb923c', '所有物理盘写入速率之和（橙虚线）');
        legend.innerHTML = h;
    }
    const hint = document.getElementById('storageDiskTrendHint');
    if (hint) {
        if (d.error) hint.textContent = '走势接口异常：' + d.error;
        else if (!pts.length) hint.textContent = '采样中…（每秒 1 点，控制台启动后开始积累）';
        else hint.textContent = (d.sample_s > 1 ? '每 ' + d.sample_s + ' 秒取均值 · ' : '') + pts.length + ' 点 · 数据源 /proc/diskstats';
    }
}
function drawStorageDiskTrend(cvId, metaId, pts, series, d) {
    const cv = document.getElementById(cvId);
    if (!cv || !cv.getContext) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 600, H = cv.clientHeight || 150;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const meta = document.getElementById(metaId);
    const winS = (d && d.win_s) || 180;
    if (!pts || pts.length < 2) {
        ctx.fillStyle = 'rgba(148,163,184,.75)'; ctx.font = '11px sans-serif';
        ctx.fillText('采样中…（每秒 1 点，积累数秒后显示曲线）', 10, H / 2);
        if (meta) meta.textContent = '';
        return;
    }
    const val = (p, key) => (key.charAt(0) === 'd' && key.charAt(1) === ':')
        ? ((p.d && p.d[key.slice(2)] ? p.d[key.slice(2)][0] : 0))
        : (p[key] || 0);
    let peakR = 0, peakW = 0;
    for (const p of pts) { peakR = Math.max(peakR, p.r || 0); peakW = Math.max(peakW, p.w || 0); }
    // 纵轴上界：以 KB/s 为单位取 2 的幂 ×{1,2,4,8}，保证 0/半/顶 三格都是整齐的二进制值
    const needKb = Math.max(peakR, peakW, 64 * 1024) * 1.15 / 1024;
    const pow = Math.pow(2, Math.floor(Math.log(needKb) / Math.LN2 / 3) * 3);
    let topKb = pow * 8;
    for (const m of [1, 2, 4, 8]) { if (pow * m >= needKb) { topKb = pow * m; break; } }
    const top = Math.max(topKb * 1024, 1048576);
    const padL = 66, padR = 10, padT = 8, padB = 18;
    const plotW = Math.max(10, W - padL - padR), plotH = Math.max(10, H - padT - padB);
    const nowS = Math.floor(Date.now() / 1000);
    const t0 = nowS - winS;
    const x = (t) => padL + plotW * Math.max(0, Math.min(1, (t - t0) / winS));
    const y = (v) => padT + plotH * (1 - Math.min(v, top) / top);
    ctx.strokeStyle = 'rgba(148,163,184,.18)'; ctx.fillStyle = 'rgba(148,163,184,.85)';
    ctx.font = '10px sans-serif'; ctx.lineWidth = 1;
    for (const gv of [0, top / 2, top]) {
        const gy = Math.round(y(gv)) + 0.5;
        ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
        ctx.fillText(fmtBytes(gv) + '/s', 2, gy + 3);
    }
    const step = winS <= 180 ? 30 : (winS <= 600 ? 120 : 300);
    ctx.textAlign = 'center';
    for (let t = Math.ceil(t0 / step) * step; t <= nowS; t += step) {
        const xx = x(t);
        if (xx < padL - 8 || xx > W - padR + 8) continue;
        ctx.fillText(new Date(t * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), xx, H - 5);
    }
    ctx.textAlign = 'left';
    for (const s of series) {
        ctx.beginPath();
        pts.forEach((p, i) => { const px = x(p.t), py = y(val(p, s.key)); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
        ctx.setLineDash(s.dashed ? [4, 3] : []);
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.4; ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.setLineDash([]);
        if (s.fill) {
            ctx.lineTo(x(pts[pts.length - 1].t), y(0));
            ctx.lineTo(x(pts[0].t), y(0));
            ctx.closePath();
            ctx.fillStyle = s.fill; ctx.fill();
        }
    }
    const wl = (DISK_TREND_WINS.find((w) => w.s === winS) || { label: Math.round(winS / 60) + ' 分钟' }).label;
    if (meta) meta.textContent = '近 ' + wl + ' · 读峰 ' + fmtBytes(peakR) + '/s · 写峰 ' + fmtBytes(peakW) +
        '/s · 蓝=合计读 橙虚=合计写 其余=各盘读取（合计=各盘之和）';
}

function loadNetData() {
"""

F3_OLD = """    if (!membwTimer) { loadMembwData(); membwTimer = setInterval(loadMembwData, 1000); } // 内存带宽卡 1 秒刷新
"""
F3_NEW = """    if (!membwTimer) { loadMembwData(); membwTimer = setInterval(loadMembwData, 1000); } // 内存带宽卡 1 秒刷新
    if (!diskTrendTimer) { renderDiskTrendWinBtns(); loadDiskTrendData(); diskTrendTimer = setInterval(loadDiskTrendData, 2000); } // 磁盘读写速度走势 2 秒刷新
"""

BACKEND = [("B1 采样追加历史", B1_OLD, B1_NEW), ("B2 历史/抽稀函数", B2_OLD, B2_NEW),
           ("B3 disk-trend 端点", B3_OLD, B3_NEW), ("B4 设备标签缓存", B4_OLD, B4_NEW)]
FRONTEND = [("F1 走势卡 HTML", F1_OLD, F1_NEW), ("F2 走势卡 JS", F2_OLD, F2_NEW),
            ("F3 轮询挂载", F3_OLD, F3_NEW)]


def apply(path, patches, marker, revert=False):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    applied = marker in src
    if revert:
        if not applied:
            print(f"[{os.path.basename(path)}] 未打补丁，跳过回滚")
            return False
        bak = path + ".bak-" + TAG
        if not os.path.exists(bak):
            raise SystemExit(f"回滚中止：找不到备份 {bak}")
        shutil.copy2(path, path + ".reverted-" + TAG)
        shutil.copy2(bak, path)
        print(f"[{os.path.basename(path)}] 已从 {os.path.basename(bak)} 回滚")
        return True
    if applied:
        print(f"[{os.path.basename(path)}] already（含 {marker}），跳过")
        return False
    for name, old, new in patches:
        n = src.count(old)
        if n != 1:
            raise SystemExit(f"锚点不唯一/缺失：{name} 命中 {n} 次 —— 文件已被并发改动，请重新取基线")
        src = src.replace(old, new, 1)
    bak = path + ".bak-" + TAG
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
        print(f"备份 → {bak}")
    tmp = path + ".tmp-" + TAG
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(src)
    os.replace(tmp, path)
    print(f"[{os.path.basename(path)}] 已打补丁（{len(patches)} 处）")
    return True


def main():
    revert = "--revert" in sys.argv
    apply(SERVER, BACKEND, "appendDiskHistory", revert)
    apply(INDEX, FRONTEND, "drawStorageDiskTrend", revert)
    print("完成")


if __name__ == "__main__":
    main()
