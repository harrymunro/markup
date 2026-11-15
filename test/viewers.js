'use strict';

// Checks the non-HTML paths and a few cross-cutting features: PDF and image review,
// opening a file through the file picker (real path lookup), responsive presets with
// a scaled stage, and marks that live on a second page.
// Usage: node test/viewers.js [output-dir-for-screenshots]

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { launch } = require('./driver.js');

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'markup-viewers-'));
fs.mkdirSync(outDir, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'markup-fixtures-'));
fs.cpSync(path.join(__dirname, 'fixtures'), work, { recursive: true });

(async () => {
  const t = await launch(path.join(work, 'sample.pdf'), { chromeArgs: process.env.DPR ? [`--force-device-scale-factor=${process.env.DPR}`] : [] });
  const { ev, send, click, drag, wheel, note, shot, sleep, waitFor } = t;
  const frame = (expr) => ev(`(() => { const w = document.querySelector('#frame').contentWindow, d = w.document; return ${expr}; })()`);
  const tool = (name) => ev(`window.__mk.setTool(${JSON.stringify(name)})`);
  // Page-space rect of an element in the reviewed page, converted to window coordinates.
  const at = async (sel) => {
    const r = await frame(`(() => { const r = d.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const o = await ev(`(() => { const o = document.querySelector('#overlay').getBoundingClientRect(); return { x: o.left, y: o.top, s: window.__mk.S.scale }; })()`);
    return { x: o.x + r.x * o.s, y: o.y + r.y * o.s, w: r.w * o.s, h: r.h * o.s };
  };
  const doExport = async (label) => {
    await ev(`(document.querySelector('#modal').hidden = true, 0)`);
    await ev(`window.__mk.exportFeedback()`);
    await waitFor(`!document.querySelector('#modal').hidden`, 30000);
    const exp = t.app.lastExport;
    const md = fs.readFileSync(exp.md, 'utf8');
    for (const f of exp.files.filter((n) => n.endsWith('.png'))) fs.copyFileSync(path.join(exp.dir, f), path.join(outDir, `${label}-${f}`));
    await ev(`(document.querySelector('#modal').hidden = true, 0)`);
    return { exp, md };
  };
  const openViaPicker = async (file) => {
    // Marks from the previous document would trigger a native confirm(); mark them exported.
    await ev(`(window.__mk.S.dirty = false, 0)`);
    const { root } = await send('DOM.getDocument');
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
    await send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await waitFor(`window.__mk.S.doc && window.__mk.S.doc.name === ${JSON.stringify(path.basename(file))}`);
  };

  try {
    // ── PDF
    await waitFor(`!!document.querySelector('#frame').contentWindow.__mkViewer && document.querySelector('#frame').contentDocument.querySelectorAll('.page .t').length > 3`, 30000);
    await sleep(300);
    await tool('rect');
    let r = await at('#mk-page-1 .t');
    await drag(r.x - 10, r.y - 8, r.x + r.w + 60, r.y + r.h + 10);
    await note('Wrong logo on the cover');
    await wheel(600, 500, 1300);
    await sleep(600);
    await tool('pin');
    r = await at('#mk-page-2');
    await click(r.x + r.w / 2, Math.max(120, r.y + 80));
    await note('Second page needs a footer');
    await shot(path.join(outDir, 'pdf.png'));
    let { md, exp } = await doExport('pdf');
    console.log(md);
    assert.ok(/Page 1 of 2/.test(md) && /Page 2 of 2/.test(md), 'PDF marks name their page');
    assert.ok(/text there: “[^”]*Acme/.test(md), 'PDF mark reports the text under it');
    assert.ok(exp.files.includes('overview-2.png'), 'marks on different pages need two overviews');

    // ── image, opened through the file input (exercises the real-path lookup)
    await openViaPicker(path.join(work, 'sample.png'));
    await waitFor(`!!document.querySelector('#frame').contentWindow.__mkViewer && document.querySelector('#frame').contentWindow.__mkViewer.kind === 'image' && document.querySelector('#frame').contentDocument.querySelector('img').naturalWidth > 0`);
    await sleep(300);
    assert.strictEqual(await ev(`window.__mk.S.doc.path`), path.join(work, 'sample.png'), 'picked file resolves to its real path');
    await tool('arrow');
    r = await at('#mk-image');
    await drag(r.x + r.w * 0.7, r.y + r.h * 0.2, r.x + r.w * 0.5, r.y + r.h * 0.4);
    await note('This heading');
    await tool('ellipse');
    await drag(r.x + r.w * 0.1, r.y + r.h * 0.55, r.x + r.w * 0.3, r.y + r.h * 0.8);
    await note('And this card');
    await shot(path.join(outDir, 'image.png'));
    ({ md, exp } = await doExport('image'));
    console.log(md);
    assert.ok(/The image \(1200×800px\), about 50% across and 40% down/.test(md), 'image mark reports where it is');
    assert.ok(exp.dir.startsWith(path.join(work, 'markup-feedback')), 'feedback is saved next to the picked file');

    // ── HTML at a phone preset (scaled stage) plus a mark on a second page
    await openViaPicker(path.join(work, 'site', 'index.html'));
    await waitFor(`document.querySelector('#frame').contentDocument && document.querySelector('#frame').contentDocument.querySelector('#cta')`);
    await ev(`(() => { const s = document.querySelector('#viewport'); s.value = '390'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(400);
    assert.strictEqual(await frame('w.innerWidth'), 390, 'phone preset sets the page width');
    await tool('pin');
    r = await at('.hero-title');
    await click(r.x + r.w / 2, r.y + r.h / 2);
    await note('Wraps badly on phones');
    await tool('rect');
    r = await at('#open-dialog');
    await drag(r.x - 6, r.y - 6, r.x + r.w + 6, r.y + r.h + 6);
    await note('Stack the buttons');
    await shot(path.join(outDir, 'phone.png'));

    await ev(`(() => { const s = document.querySelector('#viewport'); s.value = 'fit'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(300);
    await tool('interact');
    r = await at('header nav a[href="about.html"]');
    await click(r.x + r.w / 2, r.y + r.h / 2);
    await waitFor(`document.querySelector('#frame').contentWindow.location.pathname === '/about.html'`);
    await sleep(500);
    assert.strictEqual(await ev(`window.__mk.S.anns.filter(a => a._show).length`), 0, 'marks from the first page hide on the second');
    await tool('pin');
    r = await at('.lede');
    await click(r.x + 40, r.y + r.h / 2);
    await note('Rewrite this line');
    await shot(path.join(outDir, 'about.png'));
    ({ md, exp } = await doExport('site'));
    console.log(md);
    assert.ok(md.includes('about.html:4'), 'second page gets its own file:line');
    assert.ok(md.includes('Viewport when marked:** 390px'), 'phone-width marks say so');
    assert.ok(md.includes('**On page:** `/about.html`'));

    // going back re-attaches the first page's marks by selector
    await tool('interact');
    r = await at('header nav a[href="index.html"]');
    await click(r.x + r.w / 2, r.y + r.h / 2);
    await waitFor(`document.querySelector('#frame').contentWindow.location.pathname === '/index.html'`);
    await sleep(900);
    assert.strictEqual(await ev(`window.__mk.S.anns.filter(a => a._show).length`), 2, 'marks come back when their page does');
    await shot(path.join(outDir, 'back.png'));

    // zip download
    const zip = await ev(`fetch('api/export.zip').then(r => r.arrayBuffer()).then(b => b.byteLength)`);
    assert.ok(zip > 1000, 'zip download works');

    assert.deepStrictEqual(t.errors, [], 'no console errors');
    console.log('OK — screenshots in', outDir);
  } catch (err) {
    await shot(path.join(outDir, 'failure.png')).catch(() => {});
    console.error('FAILED:', err.stack || err);
    if (t.errors.length) console.error('Page errors:', t.errors);
    process.exitCode = 1;
  } finally {
    await t.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
