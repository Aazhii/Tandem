'use strict';

/**
 * Helpers for the browser tests: a copy of the extension pointed at a local server, the relay
 * server itself, a tiny web server for test pages, and Chrome launched with the extension.
 *
 * Chrome: set CHROME_PATH, or install Chrome for Testing once with
 *   npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  const candidates = fs.existsSync(base) ? fs.readdirSync(base).sort().reverse() : [];
  for (const dir of candidates) {
    for (const rel of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-linux64/chrome',
      'chrome-win64/chrome.exe',
    ]) {
      const p = path.join(base, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('Chrome for Testing not found. Set CHROME_PATH or run: npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-e2e-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

/** Copies the extension, points it at ws://localhost:<wsPort>, and (optionally) writes its debug log into the page. */
function prepareExtension({ src = path.join(ROOT, 'extension'), wsPort, partyKey = '', serverUrl, domLog = true, openShadow = false }) {
  const ext = fs.mkdtempSync(path.join(tmp, 'ext-'));
  fs.cpSync(src, ext, { recursive: true });
  fs.rmSync(path.join(ext, 'config.local.js'), { force: true });
  const url = serverUrl === undefined ? `ws://localhost:${wsPort}` : serverUrl;
  fs.writeFileSync(path.join(ext, 'config.js'), `const SERVER_URL = ${JSON.stringify(url)};\nconst PARTY_KEY = ${JSON.stringify(partyKey)};\nconst ICE_SERVERS = [];\n`);
  const cs = path.join(ext, 'content', 'content.js');
  let code = fs.readFileSync(cs, 'utf8');
  if (domLog) {
    code = code.replace(
      /console\.debug\('\[(?:WatchParty|Tandem) sync\]', \.\.\.args\);/,
      "document.documentElement.dataset.wplog = ((document.documentElement.dataset.wplog || '') + (Date.now() % 100000) + ' ' + args.join(' ') + ' | ').slice(-6000);",
    );
  }
  fs.writeFileSync(cs, code);
  if (openShadow) {
    const ov = path.join(ext, 'content', 'overlay.js');
    fs.writeFileSync(ov, fs.readFileSync(ov, 'utf8').replace(/mode: 'closed'/g, "mode: 'open'"));
  }
  return ext;
}

function startServer({ port, dir = path.join(ROOT, 'server'), env = {} }) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { ...process.env, PARTY_KEY: '', QUIET: '1', ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  return { proc, output: () => out, stop: () => proc.kill() };
}

function makeWav(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const WAV = makeWav(900);

/** Web server for test pages: routes = { '/path': html | (req) => html }. Also serves /clip.wav (15 min, seekable). */
function startWeb(port, routes) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/clip.wav') {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = +range[1];
        const end = range[2] ? +range[2] : WAV.length - 1;
        res.writeHead(206, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${WAV.length}`, 'Content-Length': end - start + 1 });
        res.end(WAV.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': WAV.length });
      res.end(WAV);
      return;
    }
    const route = routes[url] || routes['*'];
    if (!route) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(typeof route === 'function' ? route(req) : route);
  }).listen(port);
  return server;
}

/** Launches Chrome with the extension; returns the page (at url), a background-command helper and the tab id. */
async function launch(ext, url, extraArgs = []) {
  const profile = fs.mkdtempSync(path.join(tmp, 'profile-'));
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: !process.env.HEADFUL,
    userDataDir: profile,
    defaultViewport: { width: 1280, height: 720 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run', '--autoplay-policy=no-user-gesture-required', ...extraArgs],
  });
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  if (url) await page.goto(url);
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  if (url) await page.bringToFront();
  const tabId = url ? await popup.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url) : null;
  const bg = (cmd, payload) => popup.evaluate((c, p) => chrome.runtime.sendMessage({ cmd: c, ...p }), cmd, payload || {});
  return { browser, page, popup, tabId, extId, bg, close: () => browser.close() };
}

function checker(title) {
  let fails = 0;
  console.log(`\n=== ${title}`);
  return {
    check(ok, msg, detail = '') {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${detail ? `  — ${detail}` : ''}`);
      if (!ok) fails++;
      return ok;
    },
    get fails() { return fails; },
    done() {
      console.log(fails ? `${fails} FAILED` : 'ALL PASS');
      return fails;
    },
  };
}

async function waitFor(fn, timeout = 5000, step = 200) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(step);
  }
  return false;
}

module.exports = { ROOT, sleep, findChrome, prepareExtension, startServer, startWeb, launch, checker, waitFor };
