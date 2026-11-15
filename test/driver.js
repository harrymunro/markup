'use strict';

// Drives the real app in headless Chrome over the same DevTools pipe the server uses.

const fs = require('fs');
const os = require('os');
const path = require('path');

async function launch(file, opts = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markup-test-config-'));
  process.env.MARKUP_CONFIG_DIR = configDir;
  const { start } = require('../server.js');
  const app = await start({ headless: !opts.headed, quiet: true, file, windowSize: opts.windowSize || '1500,900', chromeArgs: opts.chromeArgs || [], wait: opts.wait });
  const { cdp, sessionId } = app;
  const send = (method, params = {}) => cdp.send(method, params, sessionId);
  const errors = [];
  await send('Runtime.enable');
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function ev(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  async function waitFor(expression, timeout = 15000) {
    const end = Date.now() + timeout;
    for (;;) {
      if (await ev(expression)) return;
      if (Date.now() > end) throw new Error('Timed out waiting for: ' + expression);
      await sleep(50);
    }
  }

  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });

  async function move(x, y) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }

  async function click(x, y, clickCount = 1) {
    await move(x, y);
    await mouse('mousePressed', x, y, { clickCount });
    await mouse('mouseReleased', x, y, { clickCount });
    await sleep(60);
  }

  async function drag(x1, y1, x2, y2, steps = 8) {
    await move(x1, y1);
    await mouse('mousePressed', x1, y1);
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, button: 'left', buttons: 1 });
    }
    await mouse('mouseReleased', x2, y2);
    await sleep(60);
  }

  async function wheel(x, y, deltaY, deltaX = 0) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
    await sleep(120);
  }

  const type = (text) => send('Input.insertText', { text });

  async function key(name, modifiers = 0) {
    const codes = { Enter: 13, Escape: 27, Backspace: 8, Delete: 46 };
    const base = { key: name, code: name.length === 1 ? 'Key' + name.toUpperCase() : name, windowsVirtualKeyCode: codes[name] || name.toUpperCase().charCodeAt(0), modifiers };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: name === 'Enter' ? '\r' : undefined });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(40);
  }

  async function shot(file) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  /** Saves the note editor if it is open, then waits for the close-up capture to finish. */
  async function note(text) {
    await waitFor('!document.querySelector("#editor").hidden');
    await type(text);
    await key('Enter');
    await sleep(350);
  }

  async function stop() {
    await app.stop(0);
    // Chrome may still be flushing its profile for a moment after it is told to quit.
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(configDir, { recursive: true, force: true }); break; } catch { await sleep(150); }
    }
  }

  await waitFor('!!window.__mk');
  return { app, send, ev, waitFor, sleep, mouse, move, click, drag, wheel, type, key, shot, note, stop, errors };
}

module.exports = { launch };
