#!/usr/bin/env node
'use strict';

// Rebuilds assets/Markup.icns from assets/icon.svg using headless
// Chrome, so no image tooling is needed beyond macOS's own iconutil.
// Usage: node scripts/render-icons.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { CDP, findChrome } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const SIZES = [16, 32, 64, 128, 256, 512, 1024];

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'markup-icons-'));
  const chrome = spawn(findChrome(), [
    `--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--disable-extensions', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const cdp = new CDP(chrome);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

  const render = async (svgFile, size) => {
    const svg = fs.readFileSync(svgFile, 'utf8');
    const html = `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;
    await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
    await new Promise((r) => setTimeout(r, 250));
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
    return Buffer.from(shot.data, 'base64');
  };

  const iconset = path.join(profile, 'Markup.iconset');
  fs.mkdirSync(iconset);
  const png = {};
  for (const size of SIZES) png[size] = await render(path.join(ROOT, 'assets', 'icon.svg'), size);
  for (const base of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(iconset, `icon_${base}x${base}.png`), png[base]);
    fs.writeFileSync(path.join(iconset, `icon_${base}x${base}@2x.png`), png[base * 2]);
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ROOT, 'assets', 'Markup.icns')]);
  // Small favicon renders, only to eyeball legibility.
  if (process.argv[2]) {
    for (const size of [16, 32, 64]) fs.writeFileSync(path.join(process.argv[2], `favicon-${size}.png`), await render(path.join(ROOT, 'app', 'favicon.svg'), size));
    fs.writeFileSync(path.join(process.argv[2], 'icon-1024.png'), png[1024]);
  }

  await Promise.race([cdp.send('Browser.close'), new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
  try { chrome.kill(); } catch { /* already gone */ }
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  console.log('Wrote assets/Markup.icns');
})().catch((err) => { console.error(err); process.exit(1); });
