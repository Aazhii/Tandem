'use strict';

/**
 * Play / pause / seek with REAL mouse clicks between a host and a guest, on two kinds of player:
 *   plain  – a normal <video> with play/pause and +30s buttons
 *   nasty  – behaves like streaming players (Crunchyroll, Shaka/hls.js based ones):
 *            small automatic "gap skip" seeks while playing, a pause/resume blip after every seek
 *            (rebuffering), a tiny seek right after playback starts, and it swaps in a new <video>
 *            element the first time it plays.
 * After every action both videos must actually be moving (or staying paused) and be in sync, and the
 * two sides must not keep bouncing messages at each other.
 *
 * Env: EXT_SRC / SERVER_SRC to test another build, MODE=plain|nasty (default: both), PORT0.
 */

const path = require('path');
const { sleep, prepareExtension, startServer, startWeb, launch, checker, ROOT } = require('./lib');

const pageHtml = (mode) => `<!doctype html><title>Episode</title><body style="margin:0;background:#111">
<div id="box" style="position:relative;width:100%;height:420px;background:#000">
<video id="v" src="/clip.wav" preload="auto" style="position:absolute;inset:0;width:100%;height:100%"></video>
<button id="pp" style="position:absolute;left:8px;bottom:8px;z-index:2;width:40px;height:30px">⏯</button>
<button id="fwd" style="position:absolute;left:60px;bottom:8px;z-index:2;width:40px;height:30px">+30</button></div>
<script>
const NASTY = ${JSON.stringify(mode)} === 'nasty';
const box = document.getElementById('box');
const cur = () => document.querySelector('#box video');
document.getElementById('pp').onclick = () => { const x = cur(); x.paused ? x.play() : x.pause(); };
document.getElementById('fwd').onclick = () => { const x = cur(); x.currentTime += 30; };
if (NASTY) {
  let internal = false, swapped = false;
  const wire = (x) => {
    x.addEventListener('seeked', () => {
      if (internal) { internal = false; return; }
      if (x.paused) return;
      setTimeout(() => { if (!x.paused) { x.pause(); setTimeout(() => x.play(), 900); } }, 450); // rebuffer blip
    });
    x.addEventListener('play', () => {
      setTimeout(() => { if (!x.paused && !x.seeking) { internal = true; x.currentTime += 0.05; } }, 600); // start-up nudge
      if (!swapped) { // first play: the player swaps in its "real" video element
        swapped = true;
        setTimeout(() => {
          const n = document.createElement('video'); n.src = '/clip.wav'; n.preload = 'auto'; n.style.cssText = x.style.cssText;
          const t = x.currentTime, wasPlaying = !x.paused;
          x.pause(); x.remove(); box.prepend(n); wire(n);
          n.addEventListener('loadedmetadata', () => { n.currentTime = t + 0.3; if (wasPlaying) n.play(); }, { once: true });
        }, 900);
      }
    });
  };
  wire(cur());
  setInterval(() => { const x = cur(); if (x && !x.paused && !x.seeking) { internal = true; x.currentTime += 0.2; } }, 3500); // gap jumps
}
</script>`;

async function run(mode, port0) {
  const WS = port0 + 1;
  const WEB = port0 + 2;
  const c = checker(`playback with real clicks (${mode} player${process.env.EXT_SRC ? ', OTHER BUILD' : ''})`);
  const ext = prepareExtension({ src: process.env.EXT_SRC || path.join(ROOT, 'extension'), wsPort: WS });
  const server = startServer({ port: WS, dir: process.env.SERVER_SRC || path.join(ROOT, 'server') });
  const web = startWeb(WEB, { '*': pageHtml(mode) });
  await sleep(700);
  const url = `http://localhost:${WEB}/ep`;
  const A = await launch(ext, url);
  const B = await launch(ext, url);
  const st = (X) => X.page.evaluate(() => { const v = document.querySelector('#box video'); return { t: v.currentTime, paused: v.paused }; });

  async function expectPlaying(label) {
    await sleep(2500);
    const a0 = await st(A); const b0 = await st(B);
    await sleep(5000);
    const a1 = await st(A); const b1 = await st(B);
    const da = a1.t - a0.t; const db = b1.t - b0.t;
    c.check(!a1.paused && da > 3.5, `${label}: host video keeps playing`, `moved ${da.toFixed(1)}s in 5s, paused=${a1.paused}`);
    c.check(!b1.paused && db > 3.5, `${label}: guest video keeps playing`, `moved ${db.toFixed(1)}s in 5s, paused=${b1.paused}`);
    c.check(Math.abs(a1.t - b1.t) < 1.5, `${label}: in sync`, `host ${a1.t.toFixed(1)} / guest ${b1.t.toFixed(1)}`);
  }
  async function expectPaused(label) {
    await sleep(2500);
    const a0 = await st(A); const b0 = await st(B);
    await sleep(3000);
    const a1 = await st(A); const b1 = await st(B);
    c.check(a1.paused && Math.abs(a1.t - a0.t) < 0.3, `${label}: host video stays paused`, `paused=${a1.paused} at ${a1.t.toFixed(1)}`);
    c.check(b1.paused && Math.abs(b1.t - b0.t) < 0.3, `${label}: guest video stays paused`, `paused=${b1.paused} at ${b1.t.toFixed(1)}`);
    c.check(Math.abs(a1.t - b1.t) < 1.0, `${label}: paused at the same spot`, `host ${a1.t.toFixed(1)} / guest ${b1.t.toFixed(1)}`);
  }

  try {
    await A.page.waitForFunction(() => document.querySelector('#box video').readyState >= 1);
    await B.page.waitForFunction(() => document.querySelector('#box video').readyState >= 1);
    await A.bg('popup_create', { nickname: 'Host', tabId: A.tabId });
    const room = (await A.bg('popup_get_state')).roomId;
    await B.bg('popup_join', { nickname: 'Guest', tabId: B.tabId, roomId: room });
    await sleep(2500);

    await B.page.click('#pp'); await expectPlaying('1 guest presses play');
    await A.page.click('#pp'); await expectPaused('2 host pauses');
    await A.page.click('#pp'); await expectPlaying('3 host presses play');
    await B.page.click('#pp'); await expectPaused('4 guest pauses');
    await B.page.click('#pp'); await expectPlaying('5 guest resumes');
    await A.page.click('#fwd'); await expectPlaying('6 host skips +30s');
    await B.page.click('#fwd'); await expectPlaying('7 guest skips +30s');
    await sleep(12000); await expectPlaying('8 still fine 20s later');
    await A.page.click('#pp'); await sleep(400); await A.page.click('#pp'); await expectPlaying('9 host quick pause + play');
    await B.page.click('#pp'); await sleep(300); await A.page.click('#pp');
    await sleep(4000);
    const a = await st(A); const b = await st(B);
    c.check(a.paused === b.paused && Math.abs(a.t - b.t) < 1.0, '10 both press at nearly the same time: both end in the same state', `host ${a.paused ? 'paused' : 'playing'} ${a.t.toFixed(1)} / guest ${b.paused ? 'paused' : 'playing'} ${b.t.toFixed(1)}`);

    const logA = await A.page.evaluate(() => document.documentElement.dataset.wplog || '');
    const logB = await B.page.evaluate(() => document.documentElement.dataset.wplog || '');
    const sentA = (logA.match(/ local /g) || []).length;
    const sentB = (logB.match(/ local /g) || []).length;
    // 11 clicks in total; anything far beyond that means the two sides are bouncing events.
    c.check(sentA + sentB <= 16, 'no message ping-pong between the two', `host sent ${sentA}, guest sent ${sentB}`);
    if (c.fails && process.env.SHOWLOG) {
      console.log('host log:', logA.slice(-2500));
      console.log('guest log:', logB.slice(-2500));
    }
  } catch (err) {
    c.check(false, 'test crashed', err.stack);
  } finally {
    await A.close(); await B.close(); server.stop(); web.close();
  }
  return c.done();
}

module.exports = run;

if (require.main === module) {
  (async () => {
    const port0 = Number(process.env.PORT0 || 8160);
    const modes = process.env.MODE ? [process.env.MODE] : ['plain', 'nasty'];
    let fails = 0;
    for (const [i, m] of modes.entries()) fails += await run(m, port0 + i * 10);
    process.exit(fails ? 1 : 0);
  })();
}
