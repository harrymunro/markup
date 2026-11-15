'use strict';

// End-to-end check: open the sample site, make one mark of every kind, export, and
// verify the feedback bundle. Usage: node test/smoke.js [output-dir-for-screenshots]

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { launch } = require('./driver.js');

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'markup-smoke-'));
fs.mkdirSync(outDir, { recursive: true });

// Work on a copy so the export folder lands somewhere disposable.
const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markup-site-'));
fs.cpSync(path.join(__dirname, 'fixtures', 'site'), siteDir, { recursive: true });
const page = path.join(siteDir, 'index.html');

const TOP = 50; // toolbar height: stage coordinates start below it

(async () => {
  const t = await launch(page, { chromeArgs: process.env.DPR ? [`--force-device-scale-factor=${process.env.DPR}`] : [] });
  const { ev, click, drag, wheel, key, note, shot, sleep, waitFor } = t;
  const frame = (expr) => ev(`(() => { const w = document.querySelector('#frame').contentWindow, d = w.document; return ${expr}; })()`);
  const rectOf = (sel) => frame(`(() => { const r = d.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const tool = (name) => ev(`window.__mk.setTool(${JSON.stringify(name)})`);
  const anns = () => ev(`window.__mk.S.anns.map(a => ({ n: a.n, type: a.type, note: a.note, sel: a.sel, show: a._show, crop: !!a.crop, rel: a.targets.relation, total: a.targets.total, first: a.targets.items[0] && a.targets.items[0].short, line: a.targets.items[0] && a.targets.items[0].line }))`);

  try {
    await waitFor(`document.querySelector('#frame').contentDocument && document.querySelector('#frame').contentDocument.querySelector('#cta')`);
    await sleep(300);
    assert.strictEqual(await frame(`w.getComputedStyle(d.querySelector('.hero-title')).fontSize`), '44px', 'relative stylesheet should load');

    // 1 — comment on an element
    let r = await rectOf('#cta');
    await click(r.x + r.w / 2, TOP + r.y + r.h / 2);
    await note('Make this button bigger and use the brand blue');

    // 2 — box around the middle pricing card
    await tool('rect');
    r = await rectOf('.card:nth-of-type(2)');
    await drag(r.x - 8, TOP + r.y - 8, r.x + r.w + 8, TOP + r.y + r.h + 8);
    await note('Highlight this plan as the recommended one');

    // 3 — circle around all three prices is too fiddly; circle the heading instead
    await tool('ellipse');
    r = await rectOf('.hero-title');
    await drag(r.x - 20, TOP + r.y - 10, r.x + r.w + 20, TOP + r.y + r.h + 10);
    await note('Heading feels too big');

    // 4 — arrow from empty hero space to the ghost button
    await tool('arrow');
    r = await rectOf('#open-dialog');
    await drag(r.x + r.w + 160, TOP + r.y - 60, r.x + r.w + 4, TOP + r.y + r.h / 2);
    await note('Move this under the main button');

    // 5 — free text
    await tool('text');
    await click(120, TOP + 120);
    await note('Add a customer logo strip here');
    await shot(path.join(outDir, '1-top.png'));

    // 6 — scroll the page (through the overlay) and box the last two cards
    await wheel(700, 500, 260);
    await tool('rect');
    const c1 = await rectOf('.card:nth-of-type(2)');
    const c3 = await rectOf('.card:nth-of-type(3)');
    await drag(c1.x - 10, TOP + c1.y - 10, c3.x + c3.w + 10, TOP + c3.y + c3.h + 10);
    await note('Cards need more breathing room');

    // 7 — freehand squiggle inside the inner scroller, then scroll the scroller
    await tool('pen');
    r = await rectOf('#activity li:nth-of-type(3)');
    await drag(r.x + 20, TOP + r.y + r.h - 4, r.x + 220, TOP + r.y + r.h - 2, 12);
    await note('Too many rows');
    const beforeScroll = await ev(`window.__mk.S.anns[6].el.getBoundingClientRect().top`);
    const sc = await rectOf('#activity');
    await wheel(sc.x + 50, TOP + sc.y + 100, 60);
    await sleep(120);
    const afterScroll = await ev(`window.__mk.S.anns[6].el.getBoundingClientRect().top`);
    assert.ok(Math.abs(beforeScroll - afterScroll - 60) < 2, `mark should follow the inner scroller (moved ${beforeScroll - afterScroll})`);
    await shot(path.join(outDir, '2-scrolled.png'));

    // 8 — open the dialog in interact mode, comment on something in it, close it
    await wheel(700, 500, -2000);
    await tool('interact');
    r = await rectOf('#open-dialog');
    await click(r.x + r.w / 2, TOP + r.y + r.h / 2);
    await waitFor(`document.querySelector('#frame').contentDocument.querySelector('#demo').open`);
    await sleep(350);
    assert.strictEqual((await anns())[0].show, false, 'marks under a modal should hide');
    await tool('pin');
    r = await rectOf('.dialog-copy');
    await click(r.x + 30, TOP + r.y + r.h / 2);
    await note('Use a real thumbnail here');
    await shot(path.join(outDir, '3-dialog.png'));
    await tool('interact');
    r = await rectOf('#close-dialog');
    await click(r.x + r.w / 2, TOP + r.y + r.h / 2);
    await sleep(500);

    // move tool: drag the box (2) a little, then undo
    await tool('select');
    r = await rectOf('.card:nth-of-type(2)');
    await wheel(700, 500, 260);
    r = await rectOf('.card:nth-of-type(2)');
    await drag(r.x - 8, TOP + r.y + 40, r.x - 60, TOP + r.y + 70);
    await sleep(300);
    const moved = (await anns())[1];
    await key('z', 4);
    await sleep(100);
    assert.strictEqual((await anns()).length, 8, 'undo of a move keeps all marks');
    await wheel(700, 500, -2000);

    await ev(`(document.querySelector('#general').value = 'Overall: looks good, tighten the spacing.', 0)`);
    await shot(path.join(outDir, '4-before-export.png'));

    const list = await anns();
    console.log(JSON.stringify(list, null, 1));
    assert.strictEqual(list[0].first, 'a#cta');
    assert.strictEqual(list[0].line, 22);
    assert.strictEqual(list[1].rel, 'encloses');
    assert.strictEqual(list[5].total, 2, 'box around two cards should enclose two elements');
    assert.strictEqual(list[7].show, false, 'dialog mark hides once the dialog closes');
    assert.ok(list[7].crop, 'dialog mark keeps its close-up');
    assert.ok(moved, 'move happened');

    await ev(`window.__mk.exportFeedback()`);
    await waitFor(`!document.querySelector('#modal').hidden`, 30000);
    await shot(path.join(outDir, '5-exported.png'));
    const exp = t.app.lastExport;
    const md = fs.readFileSync(exp.md, 'utf8');
    console.log('\n' + md);
    console.log('FILES', exp.files.join(', '));
    for (const f of exp.files.filter((n) => n.endsWith('.png'))) fs.copyFileSync(path.join(exp.dir, f), path.join(outDir, 'export-' + f));
    assert.ok(md.includes('index.html:22'), 'source line reference present');
    assert.ok(exp.files.includes('overview-1.png') && exp.files.includes('annotation-08.png'));
    assert.ok(fs.existsSync(path.join(path.dirname(exp.dir), '.gitignore')));

    assert.deepStrictEqual(t.errors, [], 'no console errors');
    console.log('\nOK — screenshots in', outDir);
  } catch (err) {
    await shot(path.join(outDir, 'failure.png')).catch(() => {});
    console.error('FAILED:', err.stack || err);
    if (t.errors.length) console.error('Page errors:', t.errors);
    process.exitCode = 1;
  } finally {
    await t.stop();
    fs.rmSync(siteDir, { recursive: true, force: true });
  }
})();
