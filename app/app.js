'use strict';
(() => {

/*
 * Markup UI.
 *
 * The page under review lives in a same-origin iframe. Marks are drawn on an overlay
 * above it and each one is anchored to the DOM element it refers to, so marks follow
 * their element through any kind of scrolling, reflow or viewport change, and the
 * exported feedback can name the exact element (tag, selector, source line).
 */

const $ = (s, r = document) => r.querySelector(s);
const API = 'api/';

const COLORS = [
  { name: 'red', c: '#e5484d', t: '#fff' },
  { name: 'orange', c: '#f5a623', t: '#1b1b1f' },
  { name: 'green', c: '#2b9a66', t: '#fff' },
  { name: 'blue', c: '#0b84f3', t: '#fff' },
  { name: 'purple', c: '#8e4ec6', t: '#fff' },
  { name: 'black', c: '#1b1b1f', t: '#fff' },
];
const KIND = { pin: 'Comment', rect: 'Box', ellipse: 'Circle', arrow: 'Arrow', pen: 'Drawing', text: 'Text' };
const VIEWPORTS = { 1440: { w: 1440 }, 1280: { w: 1280 }, 768: { w: 768, h: 1024 }, 390: { w: 390, h: 844 } };
const KEYS = { i: 'interact', v: 'select', c: 'pin', r: 'rect', o: 'ellipse', a: 'arrow', p: 'pen', t: 'text' };
const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'br', 'wbr', 'template', 'noscript', 'head', 'title']);

const ui = {
  frame: $('#frame'), wrap: $('#wrap'), stage: $('#stage'), overlay: $('#overlay'), layer: $('#layer'),
  hover: $('#hover'), sel: $('#sel'), editor: $('#editor'), editorText: $('#editor textarea'),
  list: $('#list'), general: $('#general'), count: $('#count'), modal: $('#modal'), ask: $('#ask'),
};

const S = {
  doc: null, tool: 'pin', color: COLORS[0], anns: [], nextN: 1, nextId: 1,
  selected: null, editing: null, drag: null, pointer: null,
  undo: [], redo: [], dirty: false, exporting: false,
  vp: 'fit', W: 0, H: 0, scale: 1, wait: false, lastExport: null,
};

// ───────────────────────────────────────────────────────── small helpers

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n = 1) => new Promise((resolve) => {
  const step = () => (n-- > 0 ? requestAnimationFrame(step) : resolve());
  step();
});
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...kids.filter((k) => k != null));
  return node;
}

async function post(name, body, raw) {
  const init = { method: 'POST' };
  if (raw) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const res = await fetch(API + name, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('error', !!isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3200);
}

function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busy-text').textContent = text;
}

// ───────────────────────────────────────────────────────── the reviewed page

const fwin = () => ui.frame.contentWindow;
function fdoc() {
  try { return ui.frame.contentDocument; } catch { return null; }
}
function viewer() {
  try { return fwin().__mkViewer || null; } catch { return null; }
}
function pagePath() {
  try { return fwin().location.pathname + fwin().location.search; } catch { return ''; }
}
function pageFile() {
  try {
    let p = decodeURIComponent(fwin().location.pathname);
    if (p.endsWith('/')) p += 'index.html';
    return p.replace(/^\//, '');
  } catch { return S.doc ? S.doc.name : ''; }
}

function pt(e) {
  const r = ui.overlay.getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.scale, y: (e.clientY - r.top) / S.scale };
}

function elAt(x, y) {
  const d = fdoc();
  if (!d) return null;
  x = clamp(x, 0, S.W - 1);
  y = clamp(y, 0, S.H - 1);
  let e = d.elementFromPoint(x, y);
  while (e && e.shadowRoot) {
    const inner = e.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === e) break;
    e = inner;
  }
  return e || d.body || d.documentElement;
}

function isVisible(e) {
  if (!e.checkVisibility) return true;
  return e.checkVisibility({ visibilityProperty: true, opacityProperty: true, checkVisibilityCSS: true, checkOpacity: true });
}

function withBox(e) {
  while (e && !e.getClientRects().length && e.parentElement) e = e.parentElement;
  return e;
}

// ── describing elements for the agent

const goodClass = (c) => /^[A-Za-z_][\w-]*$/.test(c);
const classesOf = (e) => (e.getAttribute('class') || '').split(/\s+/).filter(goodClass);

function shortName(e) {
  if (!e) return '';
  if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) return `${e.localName}#${e.id}`;
  const cls = classesOf(e).slice(0, 2);
  return e.localName + (cls.length ? '.' + cls.join('.') : '');
}

function cssPath(e) {
  const root = e.getRootNode();
  const count = (sel) => { try { return root.querySelectorAll(sel).length; } catch { return 0; } };
  const parts = [];
  let cur = e;
  while (cur && cur.nodeType === 1) {
    const tag = cur.localName;
    if (tag === 'html' || tag === 'body') { parts.unshift(tag); break; }
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id) && count('#' + cur.id) === 1) { parts.unshift('#' + cur.id); break; }
    let part = /^[a-z][a-z0-9-]*$/.test(tag) ? tag : CSS.escape(tag);
    const cls = classesOf(cur).slice(0, 2);
    if (cls.length) part += '.' + cls.join('.');
    const parent = cur.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.localName === tag);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    if (count(parts.join(' > ')) === 1) break;
    cur = parent;
  }
  return parts.join(' > ');
}

function openTag(e) {
  let s = '<' + e.localName;
  for (const a of e.attributes) {
    if (a.name === 'data-mk-line') continue;
    let v = a.value;
    if (v.length > 90) v = v.slice(0, 87) + '…';
    s += v === '' ? ` ${a.name}` : ` ${a.name}="${v.replace(/"/g, '&quot;')}"`;
    if (s.length > 260) { s += ' …'; break; }
  }
  return s + '>';
}

function textOf(e) {
  const tag = e.localName;
  let t;
  if (tag === 'img') t = e.getAttribute('alt');
  else if (tag === 'input' || tag === 'textarea' || tag === 'select') t = e.value || e.getAttribute('placeholder');
  else t = e.innerText !== undefined ? e.innerText : e.textContent;
  t = (t || '').replace(/\s+/g, ' ').trim();
  return t.length > 90 ? t.slice(0, 87) + '…' : t;
}

function describe(e) {
  if (!e || e.nodeType !== 1) return null;
  const whole = e.localName === 'body' || e.localName === 'html';
  const lineEl = e.closest ? e.closest('[data-mk-line]') : null;
  return {
    short: shortName(e),
    tag: openTag(e),
    selector: cssPath(e),
    text: whole ? '' : textOf(e),
    line: lineEl ? +lineEl.getAttribute('data-mk-line') : null,
    lineExact: lineEl === e,
    file: lineEl ? pageFile() : null,
    whole,
  };
}

// ───────────────────────────────────────────────────────── geometry

/** Geometry is stored relative to the anchor element's top-left corner. */
function shift(a, g, dx, dy) {
  switch (a.type) {
    case 'rect': case 'ellipse': return { x: g.x + dx, y: g.y + dy, w: g.w, h: g.h };
    case 'arrow': return { x1: g.x1 + dx, y1: g.y1 + dy, x2: g.x2 + dx, y2: g.y2 + dy };
    case 'pen': return { pts: g.pts.map(([x, y]) => [x + dx, y + dy]) };
    default: return a.outline ? {} : { x: g.x + dx, y: g.y + dy };
  }
}

function geoBox(a, g) {
  switch (a.type) {
    case 'rect': case 'ellipse': return { x: g.x, y: g.y, w: g.w, h: g.h };
    case 'arrow': return { x: Math.min(g.x1, g.x2), y: Math.min(g.y1, g.y2), w: Math.abs(g.x2 - g.x1), h: Math.abs(g.y2 - g.y1) };
    case 'pen': {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const [x, y] of g.pts) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    default: return { x: g.x - 12, y: g.y - 12, w: 24, h: 24 };
  }
}

/** Current viewport-space geometry of a placed annotation. */
function vgeo(a) {
  const r = a.anchor.getBoundingClientRect();
  return a.outline ? { el: a.anchor } : shift(a, a.geo, r.left, r.top);
}

function vbox(a) {
  const r = a.anchor.getBoundingClientRect();
  if (a.outline) return { x: r.left - 3, y: r.top - 3, w: r.width + 6, h: r.height + 6 };
  const b = geoBox(a, a.geo);
  return { x: b.x + r.left, y: b.y + r.top, w: b.w, h: b.h };
}

/** Box of what is actually painted (shape + badge), in overlay coordinates. */
function domBox(a) {
  if (!a.el) return null;
  const o = ui.overlay.getBoundingClientRect();
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of a.el.querySelectorAll('.ink, .badge')) {
    const r = n.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
  }
  if (x1 === Infinity) return null;
  return { x: (x1 - o.left) / S.scale, y: (y1 - o.top) / S.scale, w: (x2 - x1) / S.scale, h: (y2 - y1) / S.scale };
}

const inView = (a) => {
  const b = vbox(a);
  return b.x >= -2 && b.y >= -2 && b.x + b.w <= S.W + 2 && b.y + b.h <= S.H + 2;
};
const touchesView = (a) => {
  const b = vbox(a);
  return b.x < S.W && b.y < S.H && b.x + b.w > 0 && b.y + b.h > 0;
};

// ───────────────────────────────────────────────────────── finding targets

function regionTargets(r) {
  const center = elAt(r.x + r.w / 2, r.y + r.h / 2);
  let container = center;
  const holds = (e) => {
    const b = e.getBoundingClientRect();
    return b.left <= r.x && b.top <= r.y && b.right >= r.x + r.w && b.bottom >= r.y + r.h;
  };
  while (container.parentElement && !holds(container)) container = container.parentElement;
  const R = { l: r.x - 6, t: r.y - 6, r: r.x + r.w + 6, b: r.y + r.h + 6 };
  const enclosed = [];
  let budget = 5000;
  (function walk(node) {
    for (const ch of node.children) {
      if (--budget < 0 || enclosed.length >= 40) return;
      if (SKIP_TAGS.has(ch.localName)) continue;
      const b = ch.getBoundingClientRect();
      if (b.width < 1 && b.height < 1) { if (ch.children.length) walk(ch); continue; }
      if (b.right < R.l || b.left > R.r || b.bottom < R.t || b.top > R.b) continue;
      if (b.left >= R.l && b.top >= R.t && b.right <= R.r && b.bottom <= R.b) {
        if (b.width >= 4 && b.height >= 4 && isVisible(ch)) enclosed.push(ch);
      } else walk(ch);
    }
  })(container);
  return { center, container, enclosed };
}

/** An arrow usually stops just short of what it points at, so look a little further along it. */
function aimOf(g) {
  const head = elAt(g.x2, g.y2);
  const len = Math.hypot(g.x2 - g.x1, g.y2 - g.y1) || 1;
  const ux = (g.x2 - g.x1) / len, uy = (g.y2 - g.y1) / len;
  for (const step of [8, 16, 26]) {
    const e = elAt(g.x2 + ux * step, g.y2 + uy * step);
    if (e && e !== head && head.contains(e)) return e;
  }
  return head;
}

/** Works out which element(s) a mark refers to and which element it should stick to. */
function analyze(a, g) {
  const v = viewer();
  if (v) {
    let region;
    let point;
    if (a.type === 'arrow') point = { x: g.x2, y: g.y2 };
    else if (a.type === 'text' || a.type === 'pin') point = { x: g.x, y: g.y };
    else { region = geoBox(a, g); point = { x: region.x + region.w / 2, y: region.y + region.h / 2 }; }
    if (!region) region = { x: point.x - 60, y: point.y - 16, w: 120, h: 32 };
    return { anchor: v.anchorAt(point.x, point.y), targets: { relation: 'viewer', items: [{ viewer: true, ...v.describe(region, point) }] } };
  }
  if (a.type === 'pin') {
    const e = g.el || elAt(g.x, g.y);
    return { anchor: e, targets: { relation: 'element', items: [describe(e)] } };
  }
  if (a.type === 'text') {
    const e = elAt(g.x, g.y);
    return { anchor: e, targets: { relation: 'on', items: [describe(e)] } };
  }
  if (a.type === 'arrow') {
    const head = aimOf(g);
    const tail = elAt(g.x1, g.y1);
    const targets = { relation: 'points', items: [describe(head)] };
    const tailIsContext = tail === head || tail.contains(head) || tail.localName === 'body' || tail.localName === 'html';
    if (!tailIsContext) targets.from = describe(tail);
    return { anchor: head, targets };
  }
  const { center, container, enclosed } = regionTargets(geoBox(a, g));
  if (enclosed.length === 1) return { anchor: enclosed[0], targets: { relation: 'encloses', items: [describe(enclosed[0])], total: 1 } };
  if (enclosed.length > 1) {
    return {
      anchor: enclosed[0],
      targets: { relation: 'encloses', items: enclosed.slice(0, 8).map(describe), total: enclosed.length, container: { ...describe(container), text: '' } },
    };
  }
  return { anchor: center, targets: { relation: 'inside', items: [describe(center)] } };
}

/** True when the anchor is what you actually hit at its on-screen centre (null if off-screen). */
function hitTest(anchor) {
  const r = anchor.getBoundingClientRect();
  const l = Math.max(r.left, 0), t = Math.max(r.top, 0), rt = Math.min(r.right, S.W), b = Math.min(r.bottom, S.H);
  if (rt - l < 1 || b - t < 1) return null;
  const e = elAt((l + rt) / 2, (t + b) / 2);
  return !!e && (e === anchor || anchor.contains(e) || e.contains(anchor));
}

function place(a, g) {
  const found = analyze(a, g);
  const anchor = withBox(found.anchor) || fdoc().body;
  a.anchor = anchor;
  a.targets = found.targets;
  a.sel = cssPath(anchor);
  const r = anchor.getBoundingClientRect();
  a.geo = shift(a, g, -r.left, -r.top);
  a.hitOk = hitTest(anchor) === true;
  a.occluded = false;
  a._x = a._y = a._w = a._h = a._flip = undefined;
}

// ───────────────────────────────────────────────────────── drawing marks

function penPath(pts) {
  if (pts.length < 2) return `M${r1(pts[0][0])} ${r1(pts[0][1])}l.1 0`;
  let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${r1(pts[i][0])} ${r1(pts[i][1])} ${r1(mx)} ${r1(my)}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${r1(last[0])} ${r1(last[1])}`;
}

function shape(a) {
  const g = a.geo;
  switch (a.type) {
    case 'rect': {
      const at = `x="${r1(g.x)}" y="${r1(g.y)}" width="${r1(g.w)}" height="${r1(g.h)}" rx="4"`;
      return `<rect class="halo" ${at}/><rect class="ink" ${at}/><rect class="hit" ${at}/>`;
    }
    case 'ellipse': {
      const at = `cx="${r1(g.x + g.w / 2)}" cy="${r1(g.y + g.h / 2)}" rx="${r1(g.w / 2)}" ry="${r1(g.h / 2)}"`;
      return `<ellipse class="halo" ${at}/><ellipse class="ink" ${at}/><ellipse class="hit" ${at}/>`;
    }
    case 'arrow': {
      const dx = g.x2 - g.x1, dy = g.y2 - g.y1, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const hl = Math.min(17, len * 0.5), hw = hl * 0.5;
      const bx = g.x2 - ux * hl, by = g.y2 - uy * hl;
      const shaft = `M${r1(g.x1)} ${r1(g.y1)}L${r1(bx)} ${r1(by)}`;
      const head = `M${r1(g.x2)} ${r1(g.y2)}L${r1(bx - uy * hw)} ${r1(by + ux * hw)}L${r1(bx + uy * hw)} ${r1(by - ux * hw)}Z`;
      return `<path class="halo" d="${shaft}"/><path class="halo fill" d="${head}"/><path class="ink" d="${shaft}"/>` +
        `<path class="ink fill" d="${head}"/><path class="hit" d="M${r1(g.x1)} ${r1(g.y1)}L${r1(g.x2)} ${r1(g.y2)}"/>`;
    }
    case 'pen': {
      const d = penPath(g.pts);
      return `<path class="halo" d="${d}"/><path class="ink" d="${d}"/><path class="hit" d="${d}"/>`;
    }
    case 'pin': {
      if (!a.outline) return '';
      const at = `x="-3" y="-3" width="${r1((a._w || 0) + 6)}" height="${r1((a._h || 0) + 6)}" rx="5"`;
      return `<rect class="tint" ${at}/><rect class="halo" ${at}/><rect class="ink dash" ${at}/><rect class="hit" ${at}/>`;
    }
    default: return '';
  }
}

function badgePoint(a) {
  const g = a.geo;
  switch (a.type) {
    case 'rect': return { x: g.x, y: g.y };
    case 'ellipse': return { x: g.x + g.w / 2 - (g.w / 2) * 0.7071, y: g.y + g.h / 2 - (g.h / 2) * 0.7071 };
    case 'arrow': return { x: g.x1, y: g.y1 };
    case 'pen': return { x: g.pts[0][0], y: g.pts[0][1] };
    default: return a.outline ? { x: -3, y: -3 } : { x: g.x, y: g.y };
  }
}

function labelOf(a) {
  if (a.type === 'text') return a.note;
  const first = a.note.split('\n')[0];
  return first.length > 46 ? first.slice(0, 44) + '…' : first;
}

function draw(a) {
  if (!a.el) {
    a.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    a.svg.setAttribute('class', 'ann-svg');
    a.badge = h('div', { class: 'badge' });
    a.el = h('div', { class: 'ann' });
    a.el.append(a.svg, a.badge);
    ui.layer.append(a.el);
  }
  a.el.dataset.type = a.type;
  a.el.style.setProperty('--c', a.color.c);
  a.el.style.setProperty('--ct', a.color.t);
  a.el.classList.toggle('selected', S.selected === a);
  a.el.toggleAttribute('data-fixed', !!a.outline);
  a.el.dataset.badge = a.type === 'rect' || a.outline ? 'tab' : 'dot';
  a.svg.innerHTML = shape(a);
  const b = badgePoint(a);
  a.badge.style.left = r1(b.x) + 'px';
  a.badge.style.top = r1(b.y) + 'px';
  const label = labelOf(a);
  a.badge.innerHTML = `<b>${a.n}</b>` + (label ? `<span>${esc(label)}</span>` : '');
}

function isLive(a, d) {
  const an = a.anchor;
  return !!(an && an.isConnected && an.ownerDocument === d && an.getClientRects().length);
}

function position(a, d) {
  const show = a.draft || (isLive(a, d) && !a.occluded);
  if (show && !a.draft) {
    const r = a.anchor.getBoundingClientRect();
    const x = Math.round(r.left * 2) / 2, y = Math.round(r.top * 2) / 2;
    if (x !== a._x || y !== a._y) { a.el.style.transform = `translate(${x}px, ${y}px)`; a._x = x; a._y = y; }
    if (a.outline && (r.width !== a._w || r.height !== a._h)) { a._w = r.width; a._h = r.height; a.svg.innerHTML = shape(a); }
    // A label tab sits above its box; tuck it inside when the box touches the top edge.
    const flip = a.el.dataset.badge === 'tab' && y + (a.outline ? -3 : a.geo.y) < 27;
    if (flip !== a._flip) { a._flip = flip; a.el.classList.toggle('flip', flip); }
  }
  if (show !== a._show) {
    a._show = show;
    a.el.style.display = show ? '' : 'none';
    const card = cardOf(a);
    if (card) card.classList.toggle('offpage', !show);
  }
}

function tick() {
  const d = fdoc();
  if (d !== wiredDoc) wireFrame(d);
  for (const a of S.anns) position(a, d);
  if (S.drag && S.drag.kind === 'draw') position(S.drag.a, d);
  placeHandles();
  placeEditor();
  refreshHover();
  requestAnimationFrame(tick);
}

/** Slower housekeeping: hide marks whose element is covered or hidden; re-find lost elements. */
function housekeeping() {
  const d = fdoc();
  if (!d) return;
  const page = pagePath();
  for (const a of S.anns) {
    const an = a.anchor;
    if (an && an.isConnected && an.ownerDocument === d) {
      if (!an.getClientRects().length) continue;
      if (!isVisible(an)) { a.occluded = true; continue; }
      if (!a.hitOk) { a.occluded = false; continue; }
      const hit = hitTest(an);
      if (hit !== null) a.occluded = !hit;
    } else if (a.sel && a.page === page) {
      // The element was replaced (page reload, framework re-render): pick it up again.
      let found = null;
      try { found = d.querySelector(a.sel); } catch { /* selector no longer valid */ }
      if (found && found.getClientRects().length) { a.anchor = found; a.occluded = false; a._x = a._y = a._w = a._h = undefined; }
    }
  }
}

let housekeepingQueued = false;
function queueHousekeeping() {
  if (housekeepingQueued) return;
  housekeepingQueued = true;
  requestAnimationFrame(() => { housekeepingQueued = false; housekeeping(); });
}

// ───────────────────────────────────────────────────────── annotations

function addAnn(type, g, extra = {}) {
  pushUndo();
  const a = { id: S.nextId++, n: S.nextN++, type, color: S.color, note: '', page: pagePath(), vw: S.W, ...extra };
  place(a, g);
  S.anns.push(a);
  draw(a);
  position(a, fdoc());
  renderSide();
  return a;
}

function removeAnn(a) {
  if (S.editing && S.editing.a === a) { S.editing = null; ui.editor.hidden = true; }
  pushUndo();
  dropAnn(a);
  renderSide();
}

function dropAnn(a) {
  if (a.el) a.el.remove();
  S.anns = S.anns.filter((x) => x !== a);
  if (S.selected === a) select(null);
}

function select(a) {
  if (S.selected === a) return;
  if (S.selected && S.selected.el) S.selected.el.classList.remove('selected');
  S.selected = a;
  if (a && a.el) a.el.classList.add('selected');
  for (const card of ui.list.children) card.classList.toggle('selected', !!a && +card.dataset.id === a.id);
  buildHandles();
  if (a) {
    const card = cardOf(a);
    if (card) card.scrollIntoView({ block: 'nearest' });
  }
}

function retarget(a) {
  try {
    const found = analyze(a, vgeo(a));
    a.targets = found.targets;
  } catch { /* keep what we knew */ }
}

// ── undo / redo

function snapshot() {
  return {
    nextN: S.nextN,
    anns: S.anns.map((a) => ({ ...a, geo: structuredClone(a.geo), el: null, svg: null, badge: null })),
  };
}

function restore(snap) {
  closeEditor(false);
  for (const a of S.anns) if (a.el) a.el.remove();
  S.selected = null;
  S.nextN = snap.nextN;
  S.anns = snap.anns.map((a) => ({ ...a, geo: structuredClone(a.geo), _x: undefined, _y: undefined, _w: undefined, _h: undefined, _show: undefined, _flip: undefined }));
  const d = fdoc();
  for (const a of S.anns) { draw(a); position(a, d); }
  buildHandles();
  renderSide();
  syncHistoryButtons();
}

function pushUndo(snap) {
  S.undo.push(snap || snapshot());
  if (S.undo.length > 100) S.undo.shift();
  S.redo = [];
  S.dirty = true;
  syncHistoryButtons();
}

function undo() {
  if (!S.undo.length) return;
  closeEditor(true);
  S.redo.push(snapshot());
  restore(S.undo.pop());
}

function redo() {
  if (!S.redo.length) return;
  closeEditor(true);
  S.undo.push(snapshot());
  restore(S.redo.pop());
}

function syncHistoryButtons() {
  $('#btn-undo').disabled = !S.undo.length;
  $('#btn-redo').disabled = !S.redo.length;
}

// ───────────────────────────────────────────────────────── sidebar

const cardOf = (a) => ui.list.querySelector(`.card[data-id="${a.id}"]`);

function whereText(a) {
  const t = a.targets;
  if (!t || !t.items[0]) return '';
  const first = t.items[0];
  if (t.total > 1) return `${t.total} elements`;
  return first.short || '';
}

function renderSide() {
  ui.list.textContent = '';
  for (const a of S.anns) {
    let before = null;
    const note = h('textarea', {
      rows: '1',
      placeholder: 'Add a note…',
      oninput: () => { a.note = note.value; draw(a); S.dirty = true; },
      onfocus: () => { before = snapshot(); before.note = a.note; select(a); },
      onblur: () => {
        if (before && before.note !== a.note) { pushUndo(before); snap(a); }
        before = null;
        if (a.type === 'text' && !a.note.trim() && S.anns.includes(a)) { dropAnn(a); renderSide(); }
      },
      onkeydown: (e) => { if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); note.blur(); } },
    });
    note.value = a.note;
    const card = h('div', { class: 'card', 'data-id': a.id, onclick: (e) => { if (e.target === note) return; select(a); reveal(a); } },
      h('div', { class: 'card-head' },
        h('span', { class: 'num' }, String(a.n)),
        h('span', { class: 'kind' }, KIND[a.type]),
        h('span', { class: 'where', title: a.sel || '' }, whereText(a)),
        h('button', { class: 'del', title: 'Delete this mark', 'aria-label': `Delete mark ${a.n}`, onclick: (e) => { e.stopPropagation(); removeAnn(a); } }, '×'),
      ),
      note,
      h('div', { class: 'off' }, 'Not visible right now — it will still be included.'),
    );
    card.style.setProperty('--c', a.color.c);
    card.style.setProperty('--ct', a.color.t);
    card.classList.toggle('selected', S.selected === a);
    card.classList.toggle('offpage', a._show === false);
    ui.list.append(card);
  }
  ui.count.textContent = S.anns.length ? String(S.anns.length) : '';
  $('#btn-clear').disabled = !S.anns.length;
}

function syncCard(a) {
  const card = cardOf(a);
  if (!card) return;
  const ta = card.querySelector('textarea');
  if (ta && document.activeElement !== ta) ta.value = a.note;
  card.querySelector('.where').textContent = whereText(a);
  card.style.setProperty('--c', a.color.c);
  card.style.setProperty('--ct', a.color.t);
}

async function reveal(a) {
  if (a._show && !inView(a)) { bringIntoView(a); await frames(2); }
  if (!a.el) return;
  a.el.classList.remove('flash');
  void a.el.offsetWidth;
  a.el.classList.add('flash');
}

// ───────────────────────────────────────────────────────── note editor

function openEditor(a, isNew) {
  closeEditor(true);
  S.editing = { a, isNew, before: snapshot(), beforeNote: a.note };
  ui.editorText.value = a.note;
  ui.editorText.placeholder = a.type === 'text' ? 'Type your note…' : a.type === 'pin' ? 'What should change here?' : 'What should change here? (optional)';
  ui.editor.hidden = false;
  placeEditor();
  ui.editorText.focus();
  ui.editorText.select();
}

function closeEditor(commit) {
  const ed = S.editing;
  if (!ed) return;
  S.editing = null;
  ui.editor.hidden = true;
  const a = ed.a;
  if (!S.anns.includes(a)) return;
  const value = ui.editorText.value.trim();
  if ((a.type === 'text' || a.type === 'pin') && ed.isNew && (!commit || !value)) {
    // A text note or comment with nothing written is nothing: take it back out and forget
    // it was ever added. (Shapes can stand on their own, so they stay.)
    dropAnn(a);
    S.undo.pop();
    if (a.n === S.nextN - 1) S.nextN--;
    syncHistoryButtons();
    renderSide();
    return;
  }
  const final = commit && (value || a.type !== 'text') ? value : ed.beforeNote;
  if (final !== ed.beforeNote && !ed.isNew) pushUndo(ed.before);
  a.note = final;
  S.dirty = true;
  draw(a);
  syncCard(a);
  snap(a);
}

function placeEditor() {
  const ed = S.editing;
  if (!ed) return;
  const a = ed.a;
  if (!a._show) return;
  const b = domBox(a) || vbox(a);
  const s = S.scale;
  const ox = ui.wrap.offsetLeft, oy = ui.wrap.offsetTop;
  const ew = ui.editor.offsetWidth, eh = ui.editor.offsetHeight;
  const sw = ui.stage.clientWidth, sh = ui.stage.clientHeight;
  let left = ox + b.x * s;
  let top = oy + (b.y + b.h) * s + 10;
  if (top + eh > sh - 8) top = oy + b.y * s - eh - 10;
  if (top < 8) top = clamp(oy + (b.y + b.h) * s - eh - 12, 8, Math.max(8, sh - eh - 8));
  left = clamp(left, 8, Math.max(8, sw - ew - 8));
  ui.editor.style.left = Math.round(left) + 'px';
  ui.editor.style.top = Math.round(top) + 'px';
}

ui.editorText.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeEditor(true); }
  else if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
});
ui.editorText.addEventListener('input', () => {
  const ed = S.editing;
  if (!ed) return;
  ed.a.note = ui.editorText.value;
  draw(ed.a);
  syncCard(ed.a);
});
ui.editorText.addEventListener('blur', () => {
  // Leaving the window (e.g. to check something) should not close the editor.
  setTimeout(() => { if (document.hasFocus() && document.activeElement !== ui.editorText) closeEditor(true); }, 0);
});

// ───────────────────────────────────────────────────────── selection handles

function buildHandles() {
  ui.sel.textContent = '';
  const a = S.selected;
  if (!a || a.outline) return;
  const names = a.type === 'rect' || a.type === 'ellipse' ? ['nw', 'ne', 'sw', 'se'] : a.type === 'arrow' ? ['p1', 'p2'] : [];
  for (const n of names) ui.sel.append(h('div', { class: 'handle', 'data-h': n }));
}

function placeHandles() {
  const a = S.selected;
  const show = !!a && a._show && S.tool === 'select';
  ui.sel.style.display = show ? '' : 'none';
  if (!show || a.outline) return;
  const g = vgeo(a);
  for (const node of ui.sel.children) {
    let x, y;
    switch (node.dataset.h) {
      case 'nw': x = g.x; y = g.y; break;
      case 'ne': x = g.x + g.w; y = g.y; break;
      case 'sw': x = g.x; y = g.y + g.h; break;
      case 'se': x = g.x + g.w; y = g.y + g.h; break;
      case 'p1': x = g.x1; y = g.y1; break;
      default: x = g.x2; y = g.y2;
    }
    node.style.left = r1(x) + 'px';
    node.style.top = r1(y) + 'px';
  }
}

// ───────────────────────────────────────────────────────── hover (comment tool)

function refreshHover() {
  const active = S.tool === 'pin' && S.pointer && !S.drag && !S.editing && !viewer() && fdoc() && !S.exporting;
  let e = active ? elAt(S.pointer.x, S.pointer.y) : null;
  if (e && (e.localName === 'body' || e.localName === 'html')) e = null;
  if (e && S.anns.some((a) => a.outline && a.anchor === e && a._show)) e = null;
  if (!e) { ui.hover.style.display = 'none'; return; }
  const r = e.getBoundingClientRect();
  const st = ui.hover.style;
  st.display = 'block';
  st.left = r1(r.left - 2) + 'px';
  st.top = r1(r.top - 2) + 'px';
  st.width = r1(r.width + 4) + 'px';
  st.height = r1(r.height + 4) + 'px';
  ui.hover.classList.toggle('below', r.top < 24);
  const label = shortName(e);
  if (ui.hover.firstChild.textContent !== label) ui.hover.firstChild.textContent = label;
}

// ───────────────────────────────────────────────────────── pointer input

function simplify(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = out[out.length - 1];
    if (Math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]) >= 3) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

ui.overlay.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !S.doc || S.exporting) return;
  const p = pt(e);
  const handle = e.target.closest('.handle');
  // With a note open, a click on the page only closes it. Otherwise every "click away"
  // with the comment tool leaves another mark behind.
  const dismissing = !!S.editing && (S.tool === 'pin' || S.tool === 'text');
  closeEditor(true);
  if (!fdoc()) return;
  e.preventDefault();
  window.focus();

  if (handle && S.selected) {
    const a = S.selected;
    const g = a.geo;
    const fixed = { nw: [g.x + g.w, g.y + g.h], ne: [g.x, g.y + g.h], sw: [g.x + g.w, g.y], se: [g.x, g.y] }[handle.dataset.h];
    S.drag = { kind: 'handle', a, h: handle.dataset.h, fixed, moved: false, before: snapshot() };
    ui.overlay.setPointerCapture(e.pointerId);
    return;
  }

  if (S.tool === 'select') {
    const annEl = e.target.closest('.ann');
    const a = annEl ? S.anns.find((x) => x.el === annEl) : null;
    select(a);
    if (!a) return;
    if (e.detail >= 2) { openEditor(a, false); return; }
    if (a.outline) return; // element comments stay glued to their element
    S.drag = { kind: 'move', a, last: p, moved: false, before: snapshot() };
    ui.overlay.setPointerCapture(e.pointerId);
    return;
  }

  if (dismissing) return;

  if (S.tool === 'pin') {
    const target = elAt(p.x, p.y);
    const whole = !target || target.localName === 'body' || target.localName === 'html';
    const a = viewer() || whole ? addAnn('pin', { x: p.x, y: p.y }) : addAnn('pin', { el: target }, { outline: true });
    openEditor(a, true);
    return;
  }

  if (S.tool === 'text') {
    openEditor(addAnn('text', { x: p.x, y: p.y }), true);
    return;
  }

  const type = S.tool;
  const geo = type === 'pen' ? { pts: [[p.x, p.y]] } : type === 'arrow' ? { x1: p.x, y1: p.y, x2: p.x, y2: p.y } : { x: p.x, y: p.y, w: 0, h: 0 };
  const a = { id: S.nextId++, n: S.nextN, type, color: S.color, note: '', draft: true, geo };
  draw(a);
  a.el.style.transform = '';
  S.drag = { kind: 'draw', a, x0: p.x, y0: p.y };
  ui.overlay.setPointerCapture(e.pointerId);
});

ui.overlay.addEventListener('pointermove', (e) => {
  const p = pt(e);
  S.pointer = p;
  const drag = S.drag;
  if (!drag) return;
  const a = drag.a;

  if (drag.kind === 'draw') {
    if (a.type === 'pen') {
      const last = a.geo.pts[a.geo.pts.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) >= 1.5) a.geo.pts.push([p.x, p.y]);
    } else if (a.type === 'arrow') {
      let { x, y } = p;
      if (e.shiftKey) {
        const ang = Math.round(Math.atan2(y - drag.y0, x - drag.x0) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x - drag.x0, y - drag.y0);
        x = drag.x0 + Math.cos(ang) * len;
        y = drag.y0 + Math.sin(ang) * len;
      }
      a.geo.x2 = x; a.geo.y2 = y;
    } else {
      let w = p.x - drag.x0, hgt = p.y - drag.y0;
      if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(hgt)); w = Math.sign(w || 1) * m; hgt = Math.sign(hgt || 1) * m; }
      a.geo = { x: Math.min(drag.x0, drag.x0 + w), y: Math.min(drag.y0, drag.y0 + hgt), w: Math.abs(w), h: Math.abs(hgt) };
    }
    draw(a);
    return;
  }

  if (drag.kind === 'move') {
    const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    drag.last = p;
    a.geo = shift(a, a.geo, dx, dy);
    draw(a);
    return;
  }

  if (drag.kind === 'handle') {
    const r = a.anchor.getBoundingClientRect();
    const q = { x: p.x - r.left, y: p.y - r.top };
    drag.moved = true;
    if (drag.h === 'p1') { a.geo.x1 = q.x; a.geo.y1 = q.y; }
    else if (drag.h === 'p2') { a.geo.x2 = q.x; a.geo.y2 = q.y; }
    else {
      const [fx, fy] = drag.fixed;
      a.geo = { x: Math.min(fx, q.x), y: Math.min(fy, q.y), w: Math.abs(q.x - fx), h: Math.abs(q.y - fy) };
    }
    draw(a);
  }
});

function endDrag(e) {
  const drag = S.drag;
  if (!drag) return;
  S.drag = null;
  try { ui.overlay.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  const a = drag.a;

  if (drag.kind === 'draw') {
    a.draft = false;
    if (a.type === 'pen') a.geo.pts = simplify(a.geo.pts);
    const box = geoBox(a, a.geo);
    const tiny = e.type === 'pointercancel' ||
      (a.type === 'arrow' ? Math.hypot(box.w, box.h) < 10 : a.type === 'pen' ? Math.max(box.w, box.h) < 6 : box.w < 6 || box.h < 6);
    if (tiny || !fdoc()) { a.el.remove(); return; }
    pushUndo();
    a.n = S.nextN++;
    a.page = pagePath();
    a.vw = S.W;
    place(a, a.geo);
    S.anns.push(a);
    draw(a);
    position(a, fdoc());
    renderSide();
    openEditor(a, true);
    return;
  }

  if (!drag.moved) return;
  pushUndo(drag.before);
  place(a, vgeo(a));
  draw(a);
  position(a, fdoc());
  syncCard(a);
  snap(a);
}

ui.overlay.addEventListener('pointerup', endDrag);
ui.overlay.addEventListener('pointercancel', endDrag);
ui.overlay.addEventListener('pointerleave', () => { if (!S.drag) S.pointer = null; });

// The overlay sits above the page while a tool is active, so pass scrolling through.
ui.overlay.addEventListener('wheel', (e) => {
  const d = fdoc();
  if (!d) return;
  e.preventDefault();
  if (e.ctrlKey) return;
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 18; dy *= 18; } else if (e.deltaMode === 2) { dx *= S.W; dy *= S.H; }
  const p = pt(e);
  const w = fwin();
  for (let node = elAt(p.x, p.y); node && node.nodeType === 1; node = node.parentElement || (node.getRootNode().host || null)) {
    if (node === d.documentElement || node === d.body) break;
    const cs = w.getComputedStyle(node);
    const canY = dy && /(auto|scroll|overlay)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1 &&
      (dy < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1);
    const canX = dx && /(auto|scroll|overlay)/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 1 &&
      (dx < 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
    if (canY || canX) { node.scrollBy({ left: canX ? dx : 0, top: canY ? dy : 0, behavior: 'instant' }); return; }
  }
  w.scrollBy({ left: dx, top: dy, behavior: 'instant' });
}, { passive: false });

// ───────────────────────────────────────────────────────── tools, colours, keys

function setTool(tool) {
  closeEditor(true);
  S.tool = tool;
  document.body.dataset.tool = tool;
  for (const b of document.querySelectorAll('.tool')) {
    const on = b.dataset.tool === tool;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  if (tool !== 'select') select(null);
  if (tool !== 'interact') { try { ui.frame.blur(); window.focus(); } catch { /* ignore */ } }
}

for (const b of document.querySelectorAll('.tool')) b.addEventListener('click', () => setTool(b.dataset.tool));

function setColor(color) {
  S.color = color;
  for (const b of $('#colors').children) {
    const on = b.dataset.name === color.name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  }
  const a = S.selected;
  if (a && a.color !== color) { pushUndo(); a.color = color; draw(a); syncCard(a); renderSide(); snap(a); }
}

for (const color of COLORS) {
  const b = h('button', { class: 'swatch', role: 'radio', title: color.name[0].toUpperCase() + color.name.slice(1), 'aria-label': color.name, 'data-name': color.name, onclick: () => setColor(color) });
  b.style.setProperty('--c', color.c);
  $('#colors').append(b);
}

function onKey(e) {
  const t = e.target;
  const typing = t && t.matches && t.matches('textarea, input, select');
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); exportFeedback(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); chooseFile(); return; }
  if (!ui.ask.hidden) return;
  if (!ui.modal.hidden) { if (e.key === 'Escape') closeModal(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod || e.altKey || !S.doc) return;
  if (e.key === 'Escape') { if (S.selected) select(null); return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && S.selected) { e.preventDefault(); removeAnn(S.selected); return; }
  if (e.key === 'Enter' && S.selected) { e.preventDefault(); openEditor(S.selected, false); return; }
  const tool = KEYS[e.key.toLowerCase()];
  if (tool) { e.preventDefault(); setTool(tool); }
}
document.addEventListener('keydown', onKey);

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-clear').addEventListener('click', () => {
  if (!S.anns.length) return;
  closeEditor(true);
  pushUndo();
  for (const a of S.anns) if (a.el) a.el.remove();
  S.anns = [];
  S.nextN = 1;
  select(null);
  renderSide();
  toast('Cleared — press ⌘Z to bring the marks back.');
});
ui.general.addEventListener('input', () => { S.dirty = true; });
$('#labels').addEventListener('change', (e) => {
  document.body.classList.toggle('hide-labels', !e.target.checked);
  post('settings', { labels: e.target.checked }).catch(() => {});
});

// ───────────────────────────────────────────────────────── layout

function layout() {
  const sw = ui.stage.clientWidth, sh = ui.stage.clientHeight;
  const preset = VIEWPORTS[S.vp];
  let W, H, s = 1;
  if (!preset) { W = sw; H = sh; } else {
    const pad = 20;
    W = preset.w;
    if (preset.h) { H = preset.h; s = Math.min(1, (sw - pad * 2) / W, (sh - pad * 2) / H); }
    else { s = Math.min(1, (sw - pad * 2) / W); H = Math.round((sh - pad * 2) / s); }
  }
  S.W = W; S.H = H; S.scale = s;
  ui.stage.classList.toggle('framed', !!preset);
  ui.wrap.style.width = W + 'px';
  ui.wrap.style.height = H + 'px';
  ui.wrap.style.transform = s === 1 ? '' : `scale(${s})`;
  ui.wrap.style.left = Math.max(0, Math.round((sw - W * s) / 2)) + 'px';
  ui.wrap.style.top = Math.max(0, Math.round((sh - H * s) / 2)) + 'px';
}

new ResizeObserver(layout).observe(ui.stage);
$('#viewport').addEventListener('change', (e) => { closeEditor(true); S.vp = e.target.value; layout(); });

// ───────────────────────────────────────────────────────── screenshots

let captureChain = Promise.resolve();

/** Screenshot of the whole window (via the DevTools connection), minus transient UI. */
function grab() {
  const run = async () => {
    document.body.classList.add('capturing');
    try {
      await frames(2);
      const res = await fetch(API + 'capture', { method: 'POST' });
      if (!res.ok) throw new Error('Could not take a screenshot');
      return await createImageBitmap(await res.blob());
    } finally {
      document.body.classList.remove('capturing');
    }
  };
  const result = captureChain.then(run, run);
  captureChain = result.catch(() => {});
  return result;
}

async function cropOf(bmp, r, maxEdge) {
  const o = ui.overlay.getBoundingClientRect();
  const k = bmp.width / window.innerWidth;
  const s = S.scale;
  const sx = Math.max(0, (o.left + r.x * s) * k), sy = Math.max(0, (o.top + r.y * s) * k);
  const sw = Math.min(bmp.width - sx, r.w * s * k), sh = Math.min(bmp.height - sy, r.h * s * k);
  if (sw < 2 || sh < 2) return null;
  const f = Math.min(1, maxEdge / Math.max(sw, sh));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(sw * f)), Math.max(1, Math.round(sh * f)));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: 'image/png' });
}

function cropRect(a) {
  const b = domBox(a);
  if (!b) return null;
  const pad = 90;
  let bx1 = b.x, by1 = b.y, bx2 = b.x + b.w, by2 = b.y + b.h;
  // Keep the whole target in the close-up (an arrow's box alone would cut off what it points at),
  // unless the target is a big container.
  const r = a.anchor.getBoundingClientRect();
  if (r.width * r.height < S.W * S.H * 0.3) {
    bx1 = Math.min(bx1, r.left); by1 = Math.min(by1, r.top); bx2 = Math.max(bx2, r.right); by2 = Math.max(by2, r.bottom);
  }
  const x1 = clamp(bx1 - pad, 0, S.W), y1 = clamp(by1 - pad, 0, S.H);
  const x2 = clamp(bx2 + pad, 0, S.W), y2 = clamp(by2 + pad, 0, S.H);
  if (x2 - x1 < 12 || y2 - y1 < 12) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Keeps a close-up of a mark as it looked when made, so marks on things that later
 * disappear (a dialog that gets closed, another page) still export with a picture.
 */
async function snap(a) {
  if (S.exporting) return;
  try {
    await frames(2);
    if (!S.anns.includes(a) || !a._show) return;
    const bmp = await grab();
    const rect = S.anns.includes(a) && a._show ? cropRect(a) : null;
    if (rect) a.crop = (await cropOf(bmp, rect, 1400)) || a.crop;
    bmp.close();
  } catch { /* a missing close-up is not worth interrupting the user for */ }
}

function bringIntoView(a) {
  const w = fwin();
  const chain = [];
  for (let n = a.anchor.parentElement; n; n = n.parentElement) chain.push(n);
  chain.push(null);
  for (const sc of chain) {
    const b = vbox(a);
    const dx = b.x + b.w / 2 - S.W / 2, dy = b.y + b.h / 2 - S.H / 2;
    const needX = b.x < 0 || b.x + b.w > S.W, needY = b.y < 0 || b.y + b.h > S.H;
    if (!needX && !needY) break;
    const move = { left: needX ? dx : 0, top: needY ? dy : 0, behavior: 'instant' };
    if (!sc) w.scrollBy(move);
    else if (sc.scrollHeight > sc.clientHeight + 1 || sc.scrollWidth > sc.clientWidth + 1) {
      const cs = w.getComputedStyle(sc);
      if (/(auto|scroll|overlay)/.test(cs.overflowX + ' ' + cs.overflowY)) sc.scrollBy(move);
    }
  }
}

async function settle() {
  await frames(2);
  await sleep(140);
  const v = viewer();
  if (v && v.idle) await Promise.race([v.idle(), sleep(8000)]);
  await frames(2);
  housekeeping();
  const d = fdoc();
  for (const a of S.anns) position(a, d);
}

/** Takes the screenshots for an export: as few full views as cover every visible mark. */
async function captureAll() {
  const overviews = [];
  if (!fdoc()) return overviews;
  const w = fwin();
  const sx = w.scrollX, sy = w.scrollY;
  for (const a of S.anns) a.overview = null;
  await settle();
  const todo = S.anns.filter((a) => a._show);
  const done = new Set();
  const boxKey = (b) => { const v = vbox(b); return [v.x, v.y, v.w, v.h].map(Math.round).join(','); };
  const shoot = async (lead) => {
    const bmp = await grab();
    // A mark bigger than the viewport never counts as "in view", so each one leads its own
    // shot. If an earlier overview already has it in exactly this place, that is the same
    // picture: reuse it rather than saving it again.
    let index = lead ? overviews.findIndex((o) => o.boxes.get(lead) === boxKey(lead)) + 1 : 0;
    if (!index) {
      const blob = await cropOf(bmp, { x: 0, y: 0, w: S.W, h: S.H }, 1600);
      if (blob) {
        const shown = S.anns.filter((b) => b._show && touchesView(b));
        overviews.push({ blob, nums: shown.map((b) => b.n), boxes: new Map(shown.map((b) => [b, boxKey(b)])) });
        index = overviews.length;
      }
    }
    if (index) {
      for (const b of todo) {
        if (done.has(b) || !b._show || !(b === lead || inView(b))) continue;
        const rect = cropRect(b);
        if (rect) b.crop = (await cropOf(bmp, rect, 1400)) || b.crop;
        b.overview = index;
        retarget(b);
        done.add(b);
      }
    }
    bmp.close();
  };
  for (const a of todo) {
    if (done.has(a)) continue;
    if (!inView(a)) { bringIntoView(a); await settle(); }
    if (!a._show) continue;
    await shoot(a);
  }
  if (!overviews.length) await shoot(null);
  w.scrollTo({ left: sx, top: sy, behavior: 'instant' });
  return overviews;
}

// ───────────────────────────────────────────────────────── feedback document

const code = (s) => (String(s).includes('`') ? '`` ' + s + ' ``' : '`' + s + '`');
const quote = (s) => s.split('\n').map((l) => '> ' + l).join('\n');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function fmtTarget(t) {
  if (!t) return 'unknown';
  if (t.viewer) {
    let s = t.label;
    if (t.pos) s += `, about ${t.pos.x}% across and ${t.pos.y}% down`;
    if (t.text) s += ` — text there: “${t.text}”`;
    return s;
  }
  if (t.whole) return `the page itself (${code(t.short)}), not a specific element`;
  let s = code(t.tag);
  if (t.text) s += ` — “${t.text}”`;
  if (t.line) s += ` — ${t.lineExact ? '' : 'inside the element at '}${code(`${t.file}:${t.line}`)}`;
  return s;
}

function targetLines(a) {
  const t = a.targets;
  const L = [];
  if (!t) return L;
  const items = t.items.filter(Boolean);
  const sel = (it, indent) => { if (it.selector && !it.whole) L.push(`${indent}- selector: ${code(it.selector)}`); };
  if (t.relation === 'encloses' && items.length > 1) {
    L.push(`- **Drawn around ${t.total} elements**${t.container && !t.container.whole ? ` inside ${fmtTarget(t.container)}` : ''}:`);
    for (const it of items) { L.push(`  - ${fmtTarget(it)}`); sel(it, '    '); }
    if (t.total > items.length) L.push(`  - …and ${t.total - items.length} more`);
    return L;
  }
  const label = { element: 'Element', encloses: 'Drawn around', inside: 'Drawn over part of', points: 'Points at', on: 'Placed on', viewer: 'Where' }[t.relation] || 'Target';
  if (items[0]) { L.push(`- **${label}:** ${fmtTarget(items[0])}`); sel(items[0], '  '); }
  if (t.from) { L.push(`- **Arrow starts at:** ${fmtTarget(t.from)}`); sel(t.from, '  '); }
  return L;
}

const hasNote = (a) => !!a.note.trim();
const shotFile = (n) => `annotation-${String(n).padStart(2, '0')}.png`;
const numList = (list) => list.map((b) => b.n).join(', ');

/** What an export amounts to: the points an agent must act on, and the marks left without a note. */
function tally() {
  const noted = S.anns.filter(hasNote);
  const general = ui.general.value.trim();
  return { noted, bare: S.anns.filter((a) => !hasNote(a)), general, points: noted.length + (general ? 1 : 0) };
}

/** Other marks made on the very same element: often one thought spread over several marks. */
function sameElement(a) {
  // Only a mark about exactly one element has "its" element; a box around several does not.
  const key = (m) => {
    const t = m.targets;
    const it = t && t.items[0];
    return it && it.selector && !it.whole && !it.viewer && !(t.total > 1) ? it.selector : null;
  };
  const mine = key(a);
  return mine ? S.anns.filter((b) => b !== a && b.page === a.page && key(b) === mine) : [];
}

function oneLine(text, max = 110) {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

function buildMarkdown(overviews, shotNames) {
  const doc = S.doc;
  const now = new Date();
  const when = now.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const mainPage = doc.kind === 'html' ? doc.url : null;
  const { noted, bare, general, points } = tally();
  const thing = doc.kind === 'pdf' ? 'PDF' : doc.kind === 'image' ? 'image' : 'page';
  const L = [];
  L.push(`# Visual feedback on ${code(doc.name)}`, '');
  L.push(`- **Source file:** ${doc.path ? code(doc.path) : `${code(doc.name)} (opened by upload, original location unknown)`}`);
  L.push(`- **Reviewed:** ${when}, in a ${S.W}×${S.H}px viewport`);
  if (points) L.push(`- **Points to act on:** ${points} (${[noted.length ? plural(noted.length, 'numbered note') : '', general ? 'the overall feedback' : ''].filter(Boolean).join(' plus ')})`);
  if (bare.length) L.push(`- **Marks without a note:** ${bare.length}, listed at the end`);
  L.push('');
  L.push(`The user reviewed this ${thing} in a browser and drew numbered marks on it; the numbers match the numbered marks in the screenshots. Each annotation below gives the user's note (the feedback to act on), what the mark refers to, and a close-up screenshot of the mark in place.` +
    (doc.kind === 'html' ? ' Tags, selectors and `file:line` references were captured automatically to help you find the code; line numbers refer to the file as it was when reviewed.' : ''), '');

  if (points) {
    L.push('## Checklist', '');
    L.push(`${points === 1 ? 'There is 1 point' : `There are ${points} points`} to act on. Each is a separate piece of feedback unless it says it belongs with another. Work through every one, using the details further down, and when you finish report back on each by number: done, not done (with the reason), or a question for the user.`, '');
    if (general) L.push(`- [ ] **Overall:** ${oneLine(general)}`);
    for (const a of noted) {
      const where = whereText(a);
      const mates = sameElement(a).filter(hasNote);
      L.push(`- [ ] **${a.n}**${where ? ` (${code(where)})` : ''}: ${oneLine(a.note)}` + (mates.length ? ` _(same element as ${numList(mates)}: read together)_` : ''));
    }
    L.push('');
  }

  if (general) L.push('## Overall feedback', '', quote(general), '');
  if (overviews.length) {
    L.push('## Overview screenshots', '');
    overviews.forEach((o, i) => {
      L.push(`- ${code(`overview-${i + 1}.png`)} — ${o.nums.length ? `shows annotation${o.nums.length === 1 ? '' : 's'} ${o.nums.join(', ')}` : 'the page as reviewed'}`);
    });
    L.push('');
  }

  const details = (a) => {
    L.push(...targetLines(a));
    const mates = sameElement(a);
    const withNotes = mates.filter(hasNote);
    if (withNotes.length && hasNote(a)) L.push(`- **Same element as:** annotation${withNotes.length === 1 ? '' : 's'} ${numList(withNotes)}. These may be one instruction written across several marks; read them together.`);
    else if (mates.length && !hasNote(a)) L.push(`- **Same element as:** annotation${mates.length === 1 ? '' : 's'} ${numList(mates)}`);
    if (mainPage && a.page && a.page !== mainPage) L.push(`- **On page:** ${code(a.page)}`);
    if (a.vw && a.vw !== S.W) L.push(`- **Viewport when marked:** ${a.vw}px wide`);
    const shot = shotNames.get(a);
    if (shot) {
      L.push(`- **Screenshot:** ${code(shot.name)}` + (shot.n !== a.n ? `, the same close-up as annotation ${shot.n}` : '') + (a.overview ? ` (in context: ${code(`overview-${a.overview}.png`)})` : ''));
    }
    if (!a._show) L.push('- _This mark was not visible when the feedback was exported (for example it sits in a dialog that was closed, or on another page)' + (shot ? '; its screenshot is from when the mark was made._' : ', so it has no screenshot._'));
    L.push('');
  };

  if (noted.length) L.push('## Annotations', '');
  for (const a of noted) {
    L.push(`### ${a.n}. ${KIND[a.type]} (${a.color.name})`, '');
    L.push(quote(a.note.trim()), '');
    details(a);
  }

  if (bare.length) {
    L.push('## Marks without a note', '');
    L.push(`The user drew ${bare.length === 1 ? 'this mark' : `these ${bare.length} marks`} but wrote nothing${points ? `, so ${bare.length === 1 ? 'it is' : 'they are'} not in the checklist` : ''}. A mark like this may be emphasis for a note nearby, or its screenshot may make the intent plain. Where it does not, do not guess at a change: say in your report that the mark was unclear.`, '');
    for (const a of bare) {
      L.push(`### ${a.n}. ${KIND[a.type]} (${a.color.name}), no note`, '');
      details(a);
    }
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1]);
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(blob);
});

/** A small in-page question. Resolves with the chosen value, or null if dismissed. */
function ask(title, text, choices) {
  return new Promise((resolve) => {
    const done = (value) => {
      ui.ask.hidden = true;
      ui.ask.onpointerdown = ui.ask.onkeydown = null;
      resolve(value);
    };
    $('#ask-title').textContent = title;
    $('#ask-text').textContent = text;
    const actions = $('#ask-actions');
    actions.textContent = '';
    for (const c of choices) {
      actions.append(h('button', { class: c.primary ? 'btn primary' : 'btn', 'data-value': c.value, onclick: () => done(c.value) }, c.label));
    }
    ui.ask.onpointerdown = (e) => { if (e.target === ui.ask) done(null); };
    ui.ask.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    ui.ask.hidden = false;
    (actions.querySelector('.primary') || actions.firstChild).focus();
  });
}

/**
 * An agent can only guess at a mark with no note, and a pile of them buries the real
 * feedback, so check before sending any. Returns false if the user went back to add notes.
 */
async function settleBareMarks() {
  const { bare, noted } = tally();
  if (!bare.length) return true;
  const n = bare.length;
  const choice = await ask(
    n === 1 ? '1 mark has no note' : `${n} marks have no note`,
    `${n === 1 ? `Mark ${bare[0].n} has` : `Marks ${numList(bare)} have`} nothing written, so your agent can only guess what ${n === 1 ? 'it means' : 'they mean'}. ` +
      (noted.length ? `The ${plural(noted.length, 'mark')} with a note will be sent either way.` : 'Notes make the feedback much easier to act on.'),
    [
      { label: n === 1 ? 'Add a note' : 'Add notes', value: 'edit', primary: true },
      { label: n === 1 ? 'Remove it and export' : 'Remove them and export', value: 'remove' },
      { label: 'Export as it is', value: 'keep' },
    ],
  );
  if (choice === 'keep') return true;
  if (choice === 'remove') {
    pushUndo();
    for (const a of bare) dropAnn(a);
    renderSide();
    return true;
  }
  if (choice === 'edit' && S.anns.includes(bare[0])) {
    select(bare[0]);
    await reveal(bare[0]);
    const field = cardOf(bare[0]) && cardOf(bare[0]).querySelector('textarea');
    if (field) field.focus();
  }
  return false;
}

async function exportFeedback() {
  if (!S.doc || S.exporting || !ui.ask.hidden) return;
  closeEditor(true);
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const nothing = () => !S.anns.length && !ui.general.value.trim();
  if (nothing()) { toast('Nothing to export yet — add a mark or some overall feedback first.'); return; }
  if (!(await settleBareMarks())) return;
  if (nothing()) { toast('Nothing left to export — add a mark or some overall feedback first.'); return; }
  S.exporting = true;
  select(null);
  busy('Capturing screenshots…');
  try {
    const overviews = await captureAll();
    const files = [];
    const shotNames = new Map();
    for (let i = 0; i < overviews.length; i++) files.push({ name: `overview-${i + 1}.png`, data: await toBase64(overviews[i].blob) });
    // Marks on the same element often get the very same close-up: save it once.
    const saved = new Map();
    for (const a of S.anns) {
      if (!a.crop) continue;
      const data = await toBase64(a.crop);
      if (!saved.has(data)) {
        saved.set(data, { name: shotFile(a.n), n: a.n });
        files.push({ name: shotFile(a.n), data });
      }
      shotNames.set(a, saved.get(data));
    }
    busy('Saving…');
    const { points, bare } = tally();
    const result = await post('export', { markdown: buildMarkdown(overviews, shotNames), files, points, unnoted: bare.length });
    S.dirty = false;
    showExport(result);
  } catch (err) {
    toast(err.message || 'Export failed', true);
  } finally {
    S.exporting = false;
    busy(null);
  }
}

$('#btn-export').addEventListener('click', () => exportFeedback());

// ── export dialog

async function copyPrompt() {
  if (!S.lastExport) return false;
  try {
    await navigator.clipboard.writeText(S.lastExport.prompt);
    $('#modal-copy').textContent = 'Copied ✓';
    return true;
  } catch {
    $('#modal-copy').textContent = 'Copy prompt';
    return false;
  }
}

function showExport(r) {
  S.lastExport = r;
  const shots = r.files.filter((f) => f.endsWith('.png')).length;
  $('#modal-title').textContent = r.wait || r.sent ? 'Feedback sent to your agent' : 'Feedback saved';
  if (r.sent) setWait(false);
  $('#modal-sub').textContent = `feedback.md with ${r.points ? plural(r.points, 'point') + ' to act on' : plural(S.anns.length, 'annotation')} and ${plural(shots, 'screenshot')}` + (r.wait ? ' — this window will close in a moment.' : '');
  $('#modal-path').textContent = r.dir;
  $('#modal-where').value = r.where;
  $('#modal-where-row').hidden = !r.canChooseLocation;
  $('#modal-prompt').textContent = r.prompt;
  $('#modal-copy').textContent = 'Copy prompt';
  $('#modal-zip').href = `${API}export.zip?t=${Date.now()}`;
  ui.modal.hidden = false;
  if (!r.wait && !r.sent) copyPrompt();
  $('#modal-copy').focus();
}

function closeModal() { ui.modal.hidden = true; }

$('#modal-copy').addEventListener('click', copyPrompt);
$('#modal-close').addEventListener('click', closeModal);
$('#modal-reveal').addEventListener('click', () => post('reveal').catch((e) => toast(e.message, true)));
ui.modal.addEventListener('pointerdown', (e) => { if (e.target === ui.modal) closeModal(); });
$('#modal-where').addEventListener('change', async (e) => {
  try { showExport(await post('relocate', { saveTo: e.target.value })); } catch (err) { toast(err.message, true); }
});

// ───────────────────────────────────────────────────────── opening documents

function resetMarks() {
  closeEditor(false);
  for (const a of S.anns) if (a.el) a.el.remove();
  Object.assign(S, { anns: [], nextN: 1, selected: null, undo: [], redo: [], dirty: false, drag: null, lastExport: null });
  ui.general.value = '';
  buildHandles();
  renderSide();
  syncHistoryButtons();
}

async function loadDoc(doc) {
  resetMarks();
  S.doc = doc;
  document.body.classList.toggle('no-doc', !doc);
  document.body.classList.toggle('viewer', !!doc && doc.kind !== 'html');
  document.title = doc ? `${doc.name} — Markup` : 'Markup';
  if (!doc) { ui.frame.src = 'about:blank'; return; }
  $('#doc-name').textContent = doc.name;
  $('#doc-name').title = doc.path || doc.name;
  // A page reviewed earlier may have left a service worker on this origin; it must not answer for this one.
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch { /* no service workers */ }
  layout();
  ui.frame.src = doc.url;
}

const okToReplace = () => !S.anns.length || !S.dirty || confirm('Open another file? Your marks on this one have not been exported and will be lost.');

async function openFile(file) {
  if (!file || !okToReplace()) return;
  busy('Opening…');
  try {
    window.__mkPendingFile = file;
    let r = await post('open-file');
    if (r.needUpload) r = await post('upload?name=' + encodeURIComponent(file.name), file, true);
    await loadDoc(r.doc);
  } catch (err) {
    toast(err.message, true);
  } finally {
    window.__mkPendingFile = null;
    busy(null);
  }
}

function chooseFile() {
  const input = $('#file-input');
  input.value = '';
  input.click();
}

$('#file-input').addEventListener('change', (e) => openFile(e.target.files[0]));
$('#btn-open').addEventListener('click', chooseFile);
$('#btn-choose').addEventListener('click', chooseFile);
$('#btn-reload').addEventListener('click', () => {
  closeEditor(true);
  try { fwin().location.reload(); } catch { ui.frame.src = S.doc.url; }
});

function renderRecent(recent) {
  const box = $('#recent');
  box.textContent = '';
  if (!recent || !recent.length) return;
  box.append(h('h3', {}, 'Recent'));
  recent.forEach((item, index) => {
    box.append(h('button', {
      class: 'recent-item',
      onclick: async () => {
        try { await loadDoc((await post('recent', { index })).doc); } catch (err) { toast(err.message, true); }
      },
    }, h('b', {}, item.name), h('span', {}, item.dir)));
  });
}

// ── drag and drop (the page inside the frame must not swallow or navigate on a dropped file)

const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
let dragDepth = 0;

function wireDrop(target) {
  target.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } }, true);
  target.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } }, true);
  target.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }, true);
  target.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    openFile(e.dataTransfer.files[0]);
  }, true);
}
wireDrop(window);

/**
 * Hooks into each new document in the frame as soon as it exists (checked every animation
 * frame rather than on "load", so a file dropped on a half-loaded page is still caught).
 */
let wiredDoc = null;
function wireFrame(d) {
  if (!d || d === wiredDoc || !S.doc) return;
  wiredDoc = d;
  try {
    const w = d.defaultView;
    d.addEventListener('scroll', queueHousekeeping, { capture: true, passive: true });
    wireDrop(w);
    w.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'e' || e.key === 'o')) onKey(e);
    }, true);
  } catch { /* cross-origin page */ }
}

ui.frame.addEventListener('load', () => { wireFrame(fdoc()); housekeeping(); });

window.addEventListener('beforeunload', (e) => {
  if (S.dirty && (S.anns.length || ui.general.value.trim())) { e.preventDefault(); e.returnValue = ''; }
});

// ───────────────────────────────────────────────────────── start

function setWait(on) {
  S.wait = !!on;
  $('#btn-export').textContent = S.wait ? 'Send feedback' : 'Export feedback';
}

// Called by the server when the command line hands this window another file.
window.__mkDocChanged = async () => {
  try {
    const st = await (await fetch(API + 'state')).json();
    setWait(st.wait);
    if (st.doc && (!S.doc || st.doc.id !== S.doc.id)) await loadDoc(st.doc);
  } catch { /* window is closing */ }
};
window.__mkWaitChanged = setWait;
window.__mkCanReplace = () => okToReplace();

async function init() {
  setTool('pin');
  setColor(COLORS[0]);
  layout();
  renderSide();
  requestAnimationFrame(tick);
  setInterval(housekeeping, 250);
  try {
    const st = await (await fetch(API + 'state')).json();
    $('#labels').checked = st.settings.labels !== false;
    document.body.classList.toggle('hide-labels', st.settings.labels === false);
    if (st.platform !== 'darwin') $('#modal-reveal').textContent = 'Show in folder';
    setWait(st.wait);
    renderRecent(st.recent);
    if (st.doc) await loadDoc(st.doc);
  } catch (err) {
    toast('Could not reach the Markup server: ' + err.message, true);
  }
}

// Exposed for the automated smoke test.
window.__mk = { S, exportFeedback, setTool, undo, redo };

init();

})();
