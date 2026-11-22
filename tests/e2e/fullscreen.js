'use strict';

/**
 * Fullscreen during a party: the page goes fullscreen with the chat beside the player, for a player
 * in the page and one inside an iframe, and for three kinds of player:
 *   plain  – toggles on document.fullscreenElement
 *   strict – exits again if document.fullscreenElement isn't its own box (like Crunchyroll)
 *   double – requests fullscreen twice per click
 */

const { sleep, prepareExtension, startServer, startWeb, launch, checker } = require('./lib');

const player = (mode) => `<!doctype html><title>Ep</title><body style="margin:0;background:#000"><div id="box" style="position:relative;width:100%;height:480px">
<video id="v" style="width:100%;height:100%" muted loop></video>
<button id="fsbtn" style="position:absolute;left:10px;bottom:10px">FS</button></div>
<script>
const mode='${mode}'; const box=document.getElementById('box'); window.log=[]; window.isFs=false;
document.addEventListener('fullscreenchange',()=>{ const el=document.fullscreenElement; window.isFs = el===box; log.push(el?(el===box?'enter-box':'enter-OTHER:'+el.tagName):'exit');
  if(mode==='strict' && el && el!==box){ log.push('strict-exit'); document.exitFullscreen(); } });
document.getElementById('fsbtn').onclick=async()=>{
  if(mode==='strict'||mode==='double'){ if(document.fullscreenElement===box){ log.push('btn-exit'); return document.exitFullscreen(); } }
  else if(document.fullscreenElement){ log.push('btn-exit'); return document.exitFullscreen(); }
  log.push('btn-enter'); await box.requestFullscreen();
  if(mode==='double'){ await box.requestFullscreen(); await document.getElementById('v').requestFullscreen().catch(()=>{}); }
};</script>`;

async function run(port0 = 8400) {
  const WS = port0 + 1;
  const TOP = port0 + 2;
  const PL = port0 + 3;
  const c = checker('fullscreen beside the chat');
  const ext = prepareExtension({ wsPort: WS });
  const server = startServer({ port: WS });
  const top = startWeb(TOP, { '*': (req) => {
    const [, kind, mode] = req.url.split('/');
    return kind === 'div' ? player(mode) : `<!doctype html><title>Ep</title><body style="margin:0"><iframe id="pl" src="http://127.0.0.1:${PL}/${mode}" allow="fullscreen; autoplay" allowfullscreen style="width:100%;height:500px;border:0"></iframe>`;
  } });
  const pl = startWeb(PL, { '*': (req) => player(req.url.slice(1)) });
  await sleep(700);
  const A = await launch(ext, null);
  const B = await launch(ext, null);
  try {
    let first = true;
    for (const kind of ['div', 'iframe']) {
      for (const mode of ['plain', 'strict', 'double']) {
        const url = `http://localhost:${TOP}/${kind}/${mode}`;
        await A.page.goto(url); await B.page.goto(url); await A.page.bringToFront();
        const tabA = await A.popup.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url);
        const tabB = await B.popup.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url);
        if (!first) { await A.bg('popup_leave'); await B.bg('popup_leave'); await sleep(500); }
        first = false;
        await A.bg('popup_create', { nickname: 'Ari', tabId: tabA });
        const room = (await A.bg('popup_get_state')).roomId;
        await B.bg('popup_join', { nickname: 'Nan', tabId: tabB, roomId: room }).catch(() => {});
        await sleep(2500);
        const frame = kind === 'iframe' ? A.page.frames().find((f) => f.url().includes(`:${PL}/`)) : A.page.mainFrame();
        const real = () => A.page.evaluate(() => ({ pageFs: document.documentElement.matches(':fullscreen'), beside: document.documentElement.hasAttribute('data-wp-pagefs') }));
        const btn = async () => (await frame.$('#fsbtn')).click();
        const label = `${kind}/${mode}`;
        await btn(); await sleep(2000);
        let r = await real();
        const p1 = await frame.evaluate(() => ({ isFs: window.isFs, log: window.log.join(',') }));
        c.check(r.pageFs && r.beside, `${label}: click fullscreen → stays fullscreen beside the chat`, `${JSON.stringify(r)} player=${p1.log}`);
        c.check(p1.isFs, `${label}: player believes it is fullscreen`);
        await btn(); await sleep(1500);
        r = await real();
        const p2 = await frame.evaluate(() => ({ isFs: window.isFs, log: window.log.join(',') }));
        c.check(!r.pageFs && !r.beside, `${label}: click again → leaves fullscreen`, `${JSON.stringify(r)} player=${p2.log}`);
        c.check(!p2.isFs, `${label}: player knows it left fullscreen`);
        const leftovers = await A.page.evaluate(() => document.querySelectorAll('[data-wp-fs-target], #box[popover], iframe[popover], html[data-wp-fs-active]').length);
        c.check(leftovers === 0, `${label}: nothing left behind on the page`);
      }
    }
    // Outside a party the site's own fullscreen is untouched.
    await A.bg('popup_leave'); await sleep(500);
    await A.page.goto(`http://localhost:${TOP}/div/strict`);
    await (await A.page.$('#fsbtn')).click(); await sleep(1500);
    c.check(await A.page.evaluate(() => document.fullscreenElement && document.fullscreenElement.id === 'box'), 'no party: the site\'s own fullscreen works normally');
  } catch (err) {
    c.check(false, 'test crashed', err.stack);
  } finally {
    await A.close(); await B.close(); server.stop(); top.close(); pl.close();
  }
  return c.done();
}

module.exports = run;
if (require.main === module) run().then((f) => process.exit(f ? 1 : 0));
