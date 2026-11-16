#!/usr/bin/env node
'use strict';

// Records the demo video in docs/ by driving the real app in headless Chrome, the same
// way the tests do. Every frame is a screenshot of the actual UI; the only things added
// are a pointer (headless Chrome draws none), captions and the title and end cards.
// The export folder's path is shortened on screen so no home directory appears.
//
// Usage: node scripts/record-demo.js     (needs ffmpeg on the PATH)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch } = require('../test/driver.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const W = 1280, H = 720, DPR = 2, STEP = 1 / 30;
const SHOWN_DIR = '~/Sites/acme-cloud';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'markup-demo-'));
const siteDir = path.join(work, 'acme-cloud');
fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'site'), siteDir, { recursive: true });
const framesDir = path.join(work, 'frames');
fs.mkdirSync(framesDir);

const frames = []; // { file, dur }
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const CSS = `
#demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; width: 22px; height: 22px; margin: -2px 0 0 -3px; }
#demo-cursor.down::after { content: ''; position: absolute; left: -9px; top: -9px; width: 28px; height: 28px; border-radius: 50%; background: rgba(59,130,246,.35); border: 2px solid rgba(59,130,246,.8); }
#demo-caption { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 2147483646; pointer-events: none; background: rgba(17,19,24,.94); color: #fff; font: 600 17px/1.3 -apple-system, 'Segoe UI', sans-serif; padding: 11px 20px; border-radius: 999px; box-shadow: 0 8px 28px rgba(0,0,0,.3); white-space: nowrap; }
#demo-caption:empty { display: none; }
#demo-card { position: fixed; inset: 0; z-index: 2147483645; background: #10131a; color: #fff; font-family: -apple-system, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; }
#demo-card[hidden] { display: none; }
#demo-card .title { text-align: center; }
#demo-card .title img { width: 104px; height: 104px; }
#demo-card .title h1 { font-size: 60px; margin: 18px 0 10px; letter-spacing: -1.5px; }
#demo-card .title p { font-size: 25px; margin: 0; color: #b9c0cf; }
#demo-card .title .sub { font-size: 18px; margin-top: 14px; color: #7f8899; }
#demo-card .title code { display: inline-block; margin-top: 30px; font: 500 20px ui-monospace, Menlo, monospace; background: #1c212c; border: 1px solid #2d3545; padding: 10px 18px; border-radius: 10px; color: #dfe5f1; }
#demo-card .agent { display: grid; grid-template-columns: 1.15fr 1fr; gap: 22px; width: 1190px; height: 600px; }
#demo-card .agent h2 { grid-column: 1 / -1; margin: 0; font-size: 26px; letter-spacing: -.4px; }
#demo-card .agent h2 span { color: #7f8899; font-weight: 500; }
#demo-card .pane { background: #1c212c; border: 1px solid #2d3545; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
#demo-card .pane header { font: 600 13px ui-monospace, Menlo, monospace; color: #9aa3b5; padding: 9px 14px; border-bottom: 1px solid #2d3545; }
#demo-card pre { margin: 0; padding: 14px; font: 12.5px/1.55 ui-monospace, Menlo, monospace; color: #dfe5f1; white-space: pre-wrap; overflow: hidden; }
#demo-card .shots { display: grid; grid-template-rows: 1.5fr 1fr; gap: 22px; min-height: 0; }
#demo-card .dock-scene { position: absolute; inset: 0; background: linear-gradient(160deg, #1b2a4a, #3a2a55 60%, #5a2f4a); text-align: center; }
#demo-card .dock-scene h2 { font-size: 40px; letter-spacing: -.8px; margin: 62px 0 12px; }
#demo-card .dock-scene p { font-size: 20px; color: #d5daE6; margin: 0; }
#demo-card .dock-scene code { font: 500 17px ui-monospace, Menlo, monospace; background: rgba(0,0,0,.3); padding: 3px 9px; border-radius: 7px; }
#demo-card .finder { position: absolute; left: 430px; top: 230px; width: 420px; height: 230px; background: #f4f5f7; border-radius: 12px; box-shadow: 0 24px 60px rgba(0,0,0,.45); overflow: hidden; color: #1b1e25; }
#demo-card .finder header { background: #e3e5ea; font: 600 14px -apple-system, sans-serif; padding: 10px; border-bottom: 1px solid #cfd2d9; }
#demo-card .finder .file { display: inline-block; margin-top: 38px; font: 500 14px -apple-system, sans-serif; }
#demo-card .finder .file img { display: block; width: 76px; height: 76px; margin: 0 auto 8px; }
#demo-card .dock { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 24px; background: rgba(255,255,255,.2); border: 1px solid rgba(255,255,255,.3); }
#demo-card .dock i { width: 64px; height: 64px; border-radius: 15px; background: rgba(255,255,255,.32); }
#demo-card .dock b { width: 0; height: 64px; margin-left: -12px; }
#demo-card .dock b img { width: 64px; height: 64px; display: block; }
#demo-drag { position: fixed; left: 0; top: 0; width: 68px; height: 68px; margin: -34px 0 0 -34px; z-index: 2147483646; pointer-events: none; opacity: .92; }
#demo-card .pane img { width: 100%; height: 100%; object-fit: contain; background: #0b0d12; min-height: 0; }
`;

(async () => {
  const t = await launch(path.join(siteDir, 'index.html'), { windowSize: `${W},${H + 87}`, chromeArgs: [`--force-device-scale-factor=${DPR}`] });
  const { ev, send, sleep, waitFor } = t;
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false });

  let cx = W / 2, cy = H / 2;

  async function snap(dur = STEP) {
    const file = path.join(framesDir, `f${String(frames.length).padStart(5, '0')}.png`);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    frames.push({ file, dur });
  }
  const hold = (seconds) => snap(seconds);
  const cursor = (x, y) => ev(`(() => { const c = document.querySelector('#demo-cursor'); c.style.transform = 'translate(${x}px, ${y}px)'; })()`);
  const caption = (text) => ev(`document.querySelector('#demo-caption').textContent = ${JSON.stringify(text)}, 0`);
  const card = (html) => ev(`(() => { const c = document.querySelector('#demo-card'); c.innerHTML = ${JSON.stringify(html || '')}; c.hidden = ${!html}; document.querySelector('#demo-cursor').style.display = ${JSON.stringify(html ? 'none' : '')}; })()`);

  async function glide(x, y, ms = 650, buttons = 0) {
    const n = Math.max(2, Math.round(ms / 1000 / STEP));
    const x0 = cx, y0 = cy;
    for (let i = 1; i <= n; i++) {
      cx = x0 + (x - x0) * ease(i / n); cy = y0 + (y - y0) * ease(i / n);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: buttons ? 'left' : 'none', buttons });
      await cursor(cx, cy);
      await snap();
    }
  }
  const press = (on) => ev(`document.querySelector('#demo-cursor').classList.toggle('down', ${on}), 0`);

  async function click(x, y, ms) {
    await glide(x, y, ms);
    await press(true); await snap(0.12);
    await t.mouse('mousePressed', x, y);
    await t.mouse('mouseReleased', x, y);
    await press(false); await sleep(120); await snap(0.2);
  }

  async function drag(x1, y1, x2, y2, ms = 900) {
    await glide(x1, y1);
    await press(true);
    await t.mouse('mousePressed', x1, y1);
    await glide(x2, y2, ms, 1);
    await t.mouse('mouseReleased', x2, y2);
    await press(false); await sleep(120); await snap(0.2);
  }

  async function note(text) {
    await waitFor('!document.querySelector("#editor").hidden');
    await snap(0.3);
    for (let i = 0; i < text.length; i += 2) {
      await t.type(text.slice(i, i + 2));
      await snap(0.07);
    }
    await snap(0.35);
    await t.key('Enter');
    await sleep(450);
    await snap(0.7);
  }

  // Centre of an element in the app chrome, or (with inFrame) in the reviewed page.
  async function at(sel, inFrame, fx = 0.5, fy = 0.5) {
    return ev(`(() => {
      const f = document.querySelector('#frame');
      const el = ${inFrame ? 'f.contentDocument' : 'document'}.querySelector(${JSON.stringify(sel)});
      const r = el.getBoundingClientRect(), o = ${inFrame ? 'f.getBoundingClientRect()' : '{ left: 0, top: 0 }'};
      return { x: o.left + r.left + r.width * ${fx}, y: o.top + r.top + r.height * ${fy}, l: o.left + r.left, t: o.top + r.top, r: o.left + r.right, b: o.top + r.bottom };
    })()`);
  }

  try {
    await waitFor(`document.querySelector('#frame').contentDocument && document.querySelector('#frame').contentDocument.querySelector('#cta')`);
    await sleep(400);
    const icon = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg')).toString('base64');
    await ev(`(() => {
      const s = document.createElement('style'); s.textContent = ${JSON.stringify(CSS)}; document.head.append(s);
      document.body.insertAdjacentHTML('beforeend', '<div id="demo-card" class="transient" hidden></div><div id="demo-caption" class="transient"></div>' +
        '<svg id="demo-cursor" class="transient" viewBox="0 0 22 22"><path d="M3 2l15 8.2-6.6 1.9-2 6.6z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>');
    })()`);
    await cursor(cx, cy);

    // Title
    await card(`<div class="title"><img src="${icon}"><h1>Markup</h1><p>Visual feedback for coding agents</p><p class="sub">Draw on a web page, PDF or screenshot. Your agent gets the rest.</p></div>`);
    await hold(2.6);
    await card('');

    // 1. Comment on an element
    await caption('Open an HTML page, PDF or screenshot');
    await hold(1.6);
    await caption('Click an element to pin a note to it');
    let p = await at('#cta', true);
    await click(p.x, p.y, 900);
    await note('Make this button bigger and use the brand blue');

    // 2. Box
    await caption('Or draw on it: boxes, circles, arrows, freehand');
    p = await at('.tool[data-tool="rect"]');
    await click(p.x, p.y);
    p = await at('.card:nth-of-type(2)', true);
    await drag(p.l - 9, p.t - 9, p.r + 9, p.b + 9);
    await note('Highlight this plan as the recommended one');

    // 3. Arrow
    p = await at('.tool[data-tool="arrow"]');
    await click(p.x, p.y);
    p = await at('#open-dialog', true);
    await drag(p.r + 150, p.t - 50, p.r + 5, p.y, 700);
    await note('Move this under the main button');

    // 4. Marks follow their elements
    await caption('Marks stay on their elements when the layout changes');
    p = await at('#viewport');
    await click(p.x, p.y);
    await ev(`(() => { const s = document.querySelector('#viewport'); s.value = '390'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(700);
    await hold(2.4);
    await ev(`(() => { const s = document.querySelector('#viewport'); s.value = 'fit'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(700);
    await hold(0.9);

    // 5. Export
    await caption('Export when you are done');
    p = await at('#btn-export');
    await glide(p.x, p.y, 700);
    await press(true); await snap(0.12); await press(false);
    await ev(`document.querySelector('#demo-caption').textContent = '', 0`);
    await t.mouse('mousePressed', p.x, p.y);
    await t.mouse('mouseReleased', p.x, p.y);
    await waitFor('!document.querySelector("#modal").hidden', 30000);
    const exp = t.app.lastExport;
    const tidy = (s) => s.split(fs.realpathSync(siteDir)).join(SHOWN_DIR).split(siteDir).join(SHOWN_DIR);
    await ev(`(() => { const fix = ${JSON.stringify([fs.realpathSync(siteDir), siteDir])};
      for (const id of ['#modal-path', '#modal-prompt']) { const el = document.querySelector(id); let s = el.textContent; for (const d of fix) s = s.split(d).join(${JSON.stringify(SHOWN_DIR)}); el.textContent = s; } })()`);
    await caption('It saves the notes and screenshots, and copies a prompt for your agent');
    await sleep(300);
    await hold(4.2);
    p = await at('#modal-close');
    await click(p.x, p.y);

    // 6. What the agent reads
    const md = tidy(fs.readFileSync(exp.md, 'utf8'));
    const start = md.indexOf('### 1.');
    const excerpt = md.slice(0, md.indexOf('\n', md.indexOf('**Points to act on')) + 1).trim() + '\n\n…\n\n' + md.slice(start, md.indexOf('### 3.', start)).trim();
    const img = (name) => 'data:image/png;base64,' + fs.readFileSync(path.join(exp.dir, name)).toString('base64');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    await caption('');
    await card(`<div class="agent"><h2>What your agent reads <span>- each note with its element, selector, file:line and a screenshot</span></h2>
      <div class="pane"><header>feedback.md</header><pre>${esc(excerpt)}</pre></div>
      <div class="shots"><div class="pane"><header>overview-1.png</header><img src="${img('overview-1.png')}"></div>
      <div class="pane"><header>annotation-01.png</header><img src="${img('annotation-01.png')}"></div></div></div>`);
    await sleep(500);
    await hold(5.5);

    // 7. The Dock. This scene is an illustration: the real Dock is outside the browser
    // window, so it cannot be filmed from headless Chrome.
    await card(`<div class="dock-scene"><h2>On a Mac, keep it in the Dock</h2>
      <p>Run <code>scripts/build-app.sh</code>, then drag <b>Markup.app</b> onto the Dock. One click opens it.</p>
      <div class="finder"><header>html-markup</header><div class="file"><img id="dk-src" src="${icon}"><span>Markup.app</span></div></div>
      <div class="dock"><i></i><i></i><i></i><b id="dk-slot"></b><i></i><i></i></div></div>`);
    await ev(`document.querySelector('#demo-cursor').style.display = '', 0`);
    await sleep(200);
    await hold(1.3);
    const src = await at('#dk-src');
    await glide(src.x, src.y, 800);
    await press(true); await snap(0.2);
    await ev(`document.body.insertAdjacentHTML('beforeend', '<img id="demo-drag" class="transient" src="${icon}">'), 0`);
    const N = 34;
    for (let i = 1; i <= N; i++) {
      const e = ease(i / N), open = Math.min(1, Math.max(0, (i / N - 0.45) / 0.4));
      const slot = await ev(`(() => { const b = document.querySelector('#dk-slot'); b.style.width = '${(64 * open).toFixed(1)}px'; b.style.marginLeft = '${(-12 * (1 - open)).toFixed(1)}px'; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      cx = src.x + (slot.x - src.x) * e; cy = src.y + (slot.y - src.y) * e;
      await ev(`document.querySelector('#demo-drag').style.transform = 'translate(${cx}px, ${cy}px)', 0`);
      await cursor(cx, cy);
      await snap();
    }
    await ev(`(() => { document.querySelector('#demo-drag').remove(); document.querySelector('#dk-slot').innerHTML = '<img src="${icon}">'; })()`);
    await press(false); await snap(0.3);
    await glide(cx + 90, cy - 110, 500);
    await hold(2.2);

    // End card
    await card(`<div class="title"><img src="${icon}"><h1>Markup</h1><p>Open source. Runs locally. No install step.</p><code>github.com/harrymunro/html-markup</code></div>`);
    await sleep(200);
    await hold(3.2);

    if (t.errors.length) throw new Error('Page errors:\n' + t.errors.join('\n'));
  } finally {
    await t.stop();
  }

  // Encode
  fs.mkdirSync(OUT, { recursive: true });
  const list = path.join(work, 'frames.txt');
  const last = frames[frames.length - 1];
  fs.writeFileSync(list, frames.map((f) => `file '${f.file}'\nduration ${f.dur.toFixed(4)}`).join('\n') + `\nfile '${last.file}'\n`);
  const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  const mp4 = path.join(OUT, 'demo.mp4'), gif = path.join(OUT, 'demo.gif'), palette = path.join(work, 'palette.png');
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', mp4]);
  ff(['-i', mp4, '-vf', 'fps=10,scale=880:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff', palette]);
  ff(['-i', mp4, '-i', palette, '-lavfi', 'fps=10,scale=880:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif]);
  fs.copyFileSync(frames[Math.floor(frames.length * 0.45)].file, path.join(work, 'mid.png'));
  const total = frames.reduce((s, f) => s + f.dur, 0);
  console.log(`${frames.length} frames, ${total.toFixed(1)}s\n${mp4} ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB\n${gif} ${(fs.statSync(gif).size / 1e6).toFixed(1)} MB\nframes kept in ${framesDir}`);
})().catch((e) => { console.error(e); process.exit(1); });
