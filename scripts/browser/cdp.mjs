// Minimal DevTools-protocol driver: headless Chrome + the dev instance's cookie jar.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
export const ORIGIN = 'http://localhost:3000';

function jarCookies(path) {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l && (!l.startsWith('#') || l.startsWith('#HttpOnly_'))).map((l) => {
    const f = l.split('\t');
    return { name: f[5], value: f[6], url: ORIGIN, httpOnly: l.startsWith('#HttpOnly_') };
  });
}

export async function withBrowser(jarPath, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--window-size=1100,1400', 'about:blank'], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      try { target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    if (!target) throw new Error('chrome did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map(); const errors = []; const loads = []; const dialogs = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
      if (msg.method === 'Runtime.exceptionThrown') errors.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) errors.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
      if (msg.method === 'Page.loadEventFired') loads.forEach((r) => r());
      if (msg.method === 'Page.javascriptDialogOpening') { dialogs.push(msg.params.message); send('Page.handleJavaScriptDialog', { accept: true }); }
    };
    const send = (method, params = {}) => new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
    for (const c of jarCookies(jarPath)) await send('Network.setCookie', c);
    const page = {
      errors, dialogs,
      async goto(url) { const p = new Promise((r) => loads.push(r)); await send('Page.navigate', { url }); await p; },
      async eval(expression) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
      },
      async waitFor(expression, { timeout = 10000, label = expression } = {}) {
        const until = Date.now() + timeout;
        while (Date.now() < until) { if (await page.eval(`Boolean(${expression})`)) return; await new Promise((r) => setTimeout(r, 150)); }
        throw new Error(`timeout waiting for ${label}`);
      },
      async shot(path) {
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        const { writeFileSync } = await import('node:fs'); writeFileSync(path, Buffer.from(data, 'base64'));
      },
      async fill(selector, value) {
        await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      },
      async click(selector) { await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no element ' + ${JSON.stringify(selector)}); el.click(); return true; })()`); },
      async submit(selector) { await page.eval(`(() => { document.querySelector(${JSON.stringify(selector)}).requestSubmit(); return true; })()`); },
      text: (selector) => page.eval(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`),
    };
    return await fn(page);
  } finally {
    chrome.kill('SIGKILL');
  }
}
