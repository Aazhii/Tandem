'use strict';

/** Server settings in the popup and the party key, against a server that requires a key. */

const { sleep, prepareExtension, startServer, startWeb, launch, checker } = require('./lib');

async function run(port0 = 8500) {
  const WS = port0 + 1;
  const WEB = port0 + 2;
  const c = checker('server settings + party key');
  const ext = prepareExtension({ wsPort: WS, serverUrl: '' }); // like the public zip: no server built in
  const server = startServer({ port: WS, env: { PARTY_KEY: 'right-key', QUIET: '' } });
  const web = startWeb(WEB, { '*': '<title>Ep</title><video id="v" muted></video>' });
  await sleep(900);
  const url = `http://localhost:${WEB}/ep`;
  const A = await launch(ext, url);
  try {
    c.check(/party key: required/.test(server.output()), 'server says the party key is required');
    await A.popup.reload(); await sleep(800);
    c.check(await A.popup.evaluate(() => !document.getElementById('server-form').hidden), 'popup opens Server settings when no server is set');
    c.check(await A.popup.evaluate(() => document.querySelector('h1').textContent === 'Tandem'), 'popup is named Tandem');
    let r = await A.bg('popup_create', { nickname: 'A', tabId: A.tabId });
    c.check(!r.ok && /Server settings/.test(r.error), 'starting a party without a server explains what to do', r.error);
    await A.popup.bringToFront();
    await A.popup.$eval('#server-url', (e) => { e.value = ''; });
    await A.popup.type('#server-url', `ws://localhost:${WS}`);
    await A.popup.type('#server-key', 'wrong-key');
    await A.popup.click('#server-save'); await sleep(500);
    c.check((await A.bg('popup_get_server')).url === `ws://localhost:${WS}`, 'server address saved from the form');
    r = await A.bg('popup_create', { nickname: 'A', tabId: A.tabId });
    c.check(!r.ok && /rejected your party key/.test(r.error), 'wrong key: clear error, no endless retry', r.error);
    await A.bg('popup_save_server', { url: `localhost:${WS}`, key: 'right-key' });
    c.check((await A.bg('popup_get_server')).url === `wss://localhost:${WS}`, 'an address without wss:// gets it added');
    await A.bg('popup_save_server', { url: `ws://localhost:${WS}`, key: 'right-key' });
    r = await A.bg('popup_create', { nickname: 'A', tabId: A.tabId });
    c.check(r.ok && (await A.bg('popup_get_state')).roomId, 'right key: the party starts', JSON.stringify(r));
    await A.popup.reload(); await sleep(600);
    c.check(await A.popup.evaluate(() => document.getElementById('server-form').hidden), 'settings stay closed once a server is set');
  } catch (err) {
    c.check(false, 'test crashed', err.stack);
  } finally {
    await A.close(); server.stop(); web.close();
  }
  return c.done();
}

module.exports = run;
if (require.main === module) run().then((f) => process.exit(f ? 1 : 0));
