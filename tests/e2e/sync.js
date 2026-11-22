'use strict';

/**
 * Sync behaviour around the edges: late join, catching up after falling behind, host-only mode,
 * a guest reloading the page, and the server restarting mid-party. Real clicks for people's actions.
 */

const { sleep, prepareExtension, startServer, startWeb, launch, checker, waitFor } = require('./lib');

const page = `<!doctype html><title>Episode</title><body style="margin:0;background:#111">
<div id="box" style="position:relative;width:100%;height:420px;background:#000">
<video id="v" src="/clip.wav" preload="auto" style="position:absolute;inset:0;width:100%;height:100%"></video>
<button id="pp" style="position:absolute;left:8px;bottom:8px;z-index:2;width:40px;height:30px">⏯</button></div>
<script>document.getElementById('pp').onclick = () => { const v = document.getElementById('v'); v.paused ? v.play() : v.pause(); };</script>`;

async function run(port0 = 8600) {
  const WS = port0 + 1;
  const WEB = port0 + 2;
  const c = checker('sync: late join, catch-up, host-only, reload, server restart');
  const ext = prepareExtension({ wsPort: WS });
  let server = startServer({ port: WS });
  const web = startWeb(WEB, { '*': page });
  await sleep(700);
  const url = `http://localhost:${WEB}/ep`;
  const A = await launch(ext, url);
  const B = await launch(ext, url);
  const st = (X) => X.page.evaluate(() => { const v = document.getElementById('v'); return { t: v.currentTime, paused: v.paused }; });
  const together = async (playing, ms = 6000) => waitFor(async () => {
    const a = await st(A); const b = await st(B);
    return a.paused === !playing && b.paused === !playing && Math.abs(a.t - b.t) < 1.0;
  }, ms);
  try {
    await A.page.waitForFunction(() => document.getElementById('v').readyState >= 1);
    await B.page.waitForFunction(() => document.getElementById('v').readyState >= 1);
    await A.bg('popup_create', { nickname: 'Host', tabId: A.tabId });
    const room = (await A.bg('popup_get_state')).roomId;
    await A.page.click('#pp');
    await sleep(6000);

    // 1. Late join: the guest lands on the host's position, playing.
    await B.bg('popup_join', { nickname: 'Guest', tabId: B.tabId, roomId: room });
    c.check(await together(true, 8000), '1 late joiner jumps to the host and plays', JSON.stringify([await st(A), await st(B)]));

    // 2. Guest falls 2.5s behind without anyone noticing (a skip the player made by itself):
    //    not passed on, and the next heartbeats pull the guest back.
    await B.page.evaluate(() => { document.getElementById('v').currentTime -= 2.5; });
    await sleep(500);
    const lag = (await st(A)).t - (await st(B)).t;
    c.check(lag > 1.5, '2a the host did not follow the guest\'s automatic skip', `guest is ${lag.toFixed(1)}s behind`);
    c.check(await waitFor(async () => Math.abs((await st(A)).t - (await st(B)).t) < 0.6, 9000), '2b drift correction brings the guest back', JSON.stringify([await st(A), await st(B)]));

    // 3. Host-only: the guest's pause is undone, the host keeps playing.
    await A.bg('popup_set_settings', { hostOnlyControl: true });
    await sleep(800);
    await B.page.click('#pp');
    await sleep(3000);
    const a3 = await st(A); const b3 = await st(B);
    c.check(!a3.paused, '3a host-only: the host keeps playing when the guest pauses');
    c.check(!b3.paused && Math.abs(a3.t - b3.t) < 1.0, '3b host-only: the guest is put back to the host', JSON.stringify([a3, b3]));
    await A.bg('popup_set_settings', { hostOnlyControl: false });
    await sleep(800);

    // 4. Guest reloads the page mid-party: back on the host's position.
    await B.page.reload();
    await B.page.waitForFunction(() => document.getElementById('v').readyState >= 1);
    c.check(await together(true, 9000), '4 after a reload the guest is back in sync', JSON.stringify([await st(A), await st(B)]));

    // 5. Server restart: both reconnect, and controls work again.
    server.stop();
    await sleep(1500);
    server = startServer({ port: WS });
    const back = await waitFor(async () => (await A.bg('popup_get_state')).status === 'connected' && (await B.bg('popup_get_state')).status === 'connected', 20000, 500);
    c.check(back, '5a both reconnect after the server restarts');
    await sleep(1500);
    await B.page.click('#pp');
    c.check(await together(false, 6000), '5b the guest\'s pause reaches the host after the restart', JSON.stringify([await st(A), await st(B)]));
    await A.page.click('#pp');
    c.check(await together(true, 6000), '5c the host\'s play reaches the guest after the restart', JSON.stringify([await st(A), await st(B)]));
    if (c.fails && process.env.SHOWLOG) {
      console.log('host log:', await A.page.evaluate(() => document.documentElement.dataset.wplog));
      console.log('guest log:', await B.page.evaluate(() => document.documentElement.dataset.wplog));
    }
  } catch (err) {
    c.check(false, 'test crashed', err.stack);
  } finally {
    await A.close(); await B.close(); server.stop(); web.close();
  }
  return c.done();
}

module.exports = run;
if (require.main === module) run().then((f) => process.exit(f ? 1 : 0));
