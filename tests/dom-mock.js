// tests/dom-mock.js — 极简浏览器环境 mock，用于在 node 里对页面内联 JS 做行为仿真。
// 目标不是还原浏览器，而是让「轮询链 + 看门狗 + 渲染函数」在受控虚拟时钟下可观测：
//   · 虚拟时钟 env.advance(ms) 驱动 setTimeout/setInterval，可注入「fetch 永不 settle」等故障；
//   · 任意 getElementById 都返回可读写桩元素，渲染调用不会因缺 DOM 而崩；
//   · 所有 console.error / 定时器抛错都收进 env.errors，供断言「页面 JS 是否静默失效」。
// 用法见 tests/pages.test.js。
'use strict';

function msg(e) { return (e && (e.stack || e.message)) || String(e); }
function fmt(v) { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { return String(v); } }
function drain() { return new Promise((r) => setImmediate(r)); }

function makeEnv(opts) {
  opts = opts || {};
  const errors = [];
  const log = [];
  const byId = new Map();
  const counters = { text: 0, html: 0, fetch: 0 };

  let now = 1700000000000;
  let seq = 1;
  const timers = new Map(); // id -> {at, ms, fn, once}

  function mkCtx(canvas) {
    const noop = () => {};
    const ctx = {};
    ['clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'fillRect', 'strokeRect', 'clear',
      'arcTo', 'arc', 'closePath', 'save', 'restore', 'translate', 'scale', 'rotate', 'setTransform',
      'fillText', 'strokeText', 'bezierCurveTo', 'quadraticCurveTo', 'rect', 'clip', 'drawImage', 'setLineDash',
      'roundRect', 'ellipse'].forEach((k) => { ctx[k] = noop; });
    ctx.measureText = () => ({ width: 10 });
    ctx.createLinearGradient = () => ({ addColorStop: noop });
    ctx.createRadialGradient = () => ({ addColorStop: noop });
    ctx.getImageData = () => ({ data: new Uint8ClampedArray(4) });
    ctx.putImageData = noop;
    ctx.canvas = canvas;
    return ctx;
  }

  function mkEl(tag, id) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), id: id || '', _text: '', _html: '',
      style: new Proxy({}, { get: (t, k) => (k in t ? t[k] : ''), set: (t, k, v) => { t[k] = v; return true; } }),
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { f ? this._s.add(c) : this._s.delete(c); } return this._s.has(c); },
        contains(c) { return this._s.has(c); },
      },
      children: [], childNodes: [], dataset: {}, attrs: {}, value: '', checked: false, disabled: false,
      scrollTop: 0, scrollHeight: 0, scrollLeft: 0, scrollWidth: 0,
      offsetWidth: 800, offsetHeight: 400, clientWidth: 800, clientHeight: 400,
      width: 800, height: 200,
      // 表单/表格元素的常见属性（桩元素不分标签，一律给空集合，
      // 否则 `sel.options.length` / `tbl.rows.length` 这类读取会直接抛错）
      options: [], selectedOptions: [], selectedIndex: -1, rows: [], cells: [], tBodies: [], files: [],
      add() {}, remove() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
      replaceChildren(...c) { this.children = c; },
      insertBefore(c) { this.children.unshift(c); return c; },
      remove() {}, replaceWith(c) { return c; }, append(...c) { this.children.push(...c); }, prepend(...c) { this.children.unshift(...c); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      hasAttribute(k) { return k in this.attrs; },
      querySelector(sel) { const e = mkEl('div'); if (/\.page\.active$/.test(sel)) e.id = 'page-dash'; return e; },
    querySelectorAll() { return []; }, closest() { return null; },
      focus() {}, blur() {}, click() {}, scrollIntoView() {}, select() {}, scroll() {},
      insertAdjacentHTML(pos, html) { this._html += String(html); },
      getBoundingClientRect() { return { top: 0, left: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight, x: 0, y: 0 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      getContext() { return mkCtx(el); },
    };
    Object.defineProperty(el, 'textContent', { get() { return this._text; }, set(v) { this._text = String(v); counters.text++; } });
    Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = String(v); counters.html++; } });
    Object.defineProperty(el, 'innerText', { get() { return this._text; }, set(v) { this._text = String(v); counters.text++; } });
    if (id) byId.set(id, el);
    return el;
  }

  const win = {
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} }),
    scrollTo() {}, scrollBy() {}, open() {}, close() {},
    prompt: () => null, alert: (m) => log.push('alert:' + m), confirm: () => true,
    localStorage: { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } },
    sessionStorage: { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } },
    console: {
      log: (...a) => log.push('log:' + a.map(fmt).join(' ')),
      info: (...a) => log.push('info:' + a.map(fmt).join(' ')),
      debug: (...a) => log.push('debug:' + a.map(fmt).join(' ')),
      warn: (...a) => log.push('warn:' + a.map(fmt).join(' ')),
      error: (...a) => { errors.push(a.map(fmt).join(' ')); log.push('error:' + a.map(fmt).join(' ')); },
    },
    setTimeout(fn, ms) { const id = seq++; timers.set(id, { at: now + (ms || 0), fn, once: true }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = seq++; timers.set(id, { at: now + (ms || 0), ms: ms || 1, fn, once: false }); return id; },
    clearInterval(id) { timers.delete(id); },
    requestAnimationFrame(fn) { const id = seq++; timers.set(id, { at: now + 16, fn, once: true }); return id; },
    cancelAnimationFrame(id) { timers.delete(id); },
    AbortController: class { constructor() { this.signal = { aborted: false, addEventListener() {}, onabort: null }; } abort() { this.signal.aborted = true; } },
    AbortSignal: { timeout: () => ({ aborted: false, addEventListener() {} }) },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }),
    Chart: function () { return { destroy() {}, update() {}, resize() {}, data: { labels: [], datasets: [] }, options: {} }; },
    performance: { now: () => now, mark() {}, measure() {} },
    location: { href: 'http://console.local/', protocol: 'http:', host: 'console.local', hostname: 'console.local', port: '', search: '', hash: '', pathname: '/' },
    navigator: { userAgent: 'node-mock', language: 'zh-CN', clipboard: { writeText: async () => {} }, sendBeacon: () => true },
    getComputedStyle: () => new Proxy({}, { get: () => '' }),
    WebSocket: function () { return { send() {}, close() {}, addEventListener() {} }; },
    Event: function (t, o) { this.type = t; Object.assign(this, o || {}); },
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    URL, URLSearchParams, TextEncoder, TextDecoder,
    Image: function () { return { addEventListener() {}, src: '' }; },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    ResizeObserver: function () { return { observe() {}, disconnect() {} }; },
    IntersectionObserver: function () { return { observe() {}, disconnect() {} }; },
    Date: class FakeDate extends Date {
      constructor(...a) { super(...(a.length ? a : [now])); }
      static now() { return now; }
    },
  };
  win.window = win; win.self = win; win.globalThis = win; win.top = win; win.parent = win;

  const doc = {
    hidden: !!opts.hidden, visibilityState: opts.hidden ? 'hidden' : 'visible', title: 'console',
    documentElement: mkEl('html'), body: mkEl('body'), head: mkEl('head'),
    getElementById(id) { if (!byId.has(id)) byId.set(id, mkEl('div', id)); return byId.get(id); },
    createElement: (t) => mkEl(t), createElementNS: (ns, t) => mkEl(t), createTextNode: (t) => ({ textContent: t }),
    createDocumentFragment: () => mkEl('fragment'),
    querySelector(sel) { const e = mkEl('div'); if (/\.page\.active$/.test(sel)) e.id = 'page-dash'; return e; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, attachEvent() {},
    cookie: '', fonts: { ready: Promise.resolve(), check: () => true },
    execCommand: () => true, activeElement: null,
  };
  win.document = doc;

  const env = {
    win, doc, byId, timers, errors, log, counters, mkEl,
    now: () => now,
    setNow(v) { now = v; },
    timerCount: () => timers.size,
    setFetch(handler) { win.fetch = handler; },
    // 推进虚拟时钟；每步后清空微任务队列，让 async 轮询链自然续排
    async advance(ms, step) {
      step = step || 50;
      const target = now + ms;
      let guard = 0;
      while (now < target && guard++ < 200000) {
        now = Math.min(target, now + step);
        const due = [...timers.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
        for (const [id, t] of due) {
          if (!timers.has(id)) continue;
          if (t.once) timers.delete(id); else t.at = now + t.ms;
          try { const r = t.fn(); if (r && typeof r.then === 'function') r.catch((e) => errors.push('timer-reject: ' + msg(e))); }
          catch (e) { errors.push('timer-throw: ' + msg(e)); }
        }
        await drain();
      }
    },
  };
  return env;
}

module.exports = { makeEnv, drain };
