'use strict';

process.env.QUIET = '1';
process.env.RECONNECT_GRACE_MS = '300';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createServer, rooms, CONFIG } = require('../server');

CONFIG.partyKey = ''; // a PARTY_KEY in server/.env must not affect the tests (one test sets it)

let server;
let url;

test.before(async () => {
  ({ server } = createServer());
  await new Promise((r) => server.listen(0, r));
  url = `ws://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  // Force-exit lingering sockets/timers.
  setTimeout(() => process.exit(0), 50).unref();
});

/** Small client helper that queues incoming messages and lets tests await specific types. */
function client() {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      queue.push(msg);
    }
  });
  const api = {
    ws,
    open: () => new Promise((r) => (ws.readyState === 1 ? r() : ws.once('open', r))),
    send: (type, payload = {}) => ws.send(JSON.stringify({ type, ...payload })),
    next(type, pred = () => true, timeout = 1000) {
      const match = (m) => m.type === type && pred(m);
      const i = queue.findIndex(match);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve, timer: setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout) };
        waiters.push(w);
      });
    },
    async none(type, ms = 200) {
      await new Promise((r) => setTimeout(r, ms));
      const found = queue.find((m) => m.type === type);
      assert.equal(found, undefined, `did not expect ${type} but got ${JSON.stringify(found)}`);
    },
    close: () => ws.close(),
  };
  return api;
}

async function createParty(nickname = 'Host', version = '1.0.0') {
  const c = client();
  await c.open();
  c.send('create_room', { nickname, version });
  const created = await c.next('room_created');
  return { c, created };
}

async function joinParty(roomId, nickname = 'Guest', version = '1.0.0', extra = {}) {
  const c = client();
  await c.open();
  c.send('join_room', { roomId, nickname, version, ...extra });
  const joined = await c.next('room_joined');
  return { c, joined };
}

test('health endpoint returns ok', async () => {
  const res = await fetch(url.replace('ws', 'http') + '/health');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('create room returns 6-char unambiguous code', async () => {
  const { c, created } = await createParty();
  assert.match(created.roomId, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(created.isHost, true);
  assert.ok(created.clientId);
  assert.ok(created.resumeToken);
  c.close();
});

test('join, playback relay, chat, and member updates', async () => {
  const { c: host, created } = await createParty('Alice');
  const { c: guest, joined } = await joinParty(created.roomId, 'Bob');
  assert.equal(joined.isHost, false);
  assert.equal(joined.members.length, 2);

  const upd = await host.next('member_update');
  assert.equal(upd.members.length, 2);
  assert.equal(upd.hostId, created.clientId);

  guest.send('playback', { action: 'pause', currentTime: 42.5, playbackRate: 1, sentAt: Date.now() });
  const pb = await host.next('playback');
  assert.equal(pb.action, 'pause');
  assert.equal(pb.currentTime, 42.5);
  assert.equal(pb.from, joined.clientId);
  assert.equal(pb.nickname, 'Bob');
  await guest.none('playback'); // not echoed to sender

  host.send('chat', { text: '<b>hi</b>' });
  const chatG = await guest.next('chat');
  const chatH = await host.next('chat');
  assert.equal(chatG.text, '<b>hi</b>');
  assert.equal(chatH.nickname, 'Alice');
  host.close();
  guest.close();
});

test('unknown types dropped, invalid shapes rejected', async () => {
  const { c } = await createParty();
  c.send('hack_the_planet', {});
  await c.none('error');
  c.send('playback', { action: 'explode', currentTime: 1 });
  const err = await c.next('error');
  assert.equal(err.code, 'BAD_MESSAGE');
  c.ws.send('not json');
  await c.none('error');
  c.close();
});

test('oversized messages rejected', async () => {
  const { c } = await createParty();
  c.send('chat', { text: 'x'.repeat(5000) });
  const err = await c.next('error');
  assert.equal(err.code, 'MESSAGE_TOO_LARGE');
  c.close();
});

test('room not found', async () => {
  const c = client();
  await c.open();
  c.send('join_room', { roomId: 'ZZZZZZ', nickname: 'X', version: '1.0.0' });
  const err = await c.next('error');
  assert.equal(err.code, 'ROOM_NOT_FOUND');
  c.close();
});

test('host-only control enforced server-side', async () => {
  const { c: host, created } = await createParty();
  const { c: guest } = await joinParty(created.roomId);
  host.send('set_settings', { hostOnlyControl: true });
  const upd = await guest.next('member_update', (m) => m.settings.hostOnlyControl === true);
  assert.equal(upd.settings.hostOnlyControl, true);

  guest.send('playback', { action: 'pause', currentTime: 10, playbackRate: 1, sentAt: Date.now() });
  const err = await guest.next('error');
  assert.equal(err.code, 'NOT_ALLOWED');
  await host.none('playback');

  guest.send('set_settings', { hostOnlyControl: false });
  const err2 = await guest.next('error');
  assert.equal(err2.code, 'NOT_ALLOWED');

  // Guest heartbeats are ignored.
  guest.send('heartbeat', { currentTime: 5, paused: false, playbackRate: 1, sentAt: Date.now() });
  await host.none('heartbeat');
  host.close();
  guest.close();
});

test('late joiner sync_request gets host state and host is asked for fresh heartbeat', async () => {
  const { c: host, created } = await createParty();
  host.send('heartbeat', { currentTime: 123.4, paused: false, playbackRate: 1, sentAt: Date.now() });
  await new Promise((r) => setTimeout(r, 50));
  const { c: guest, joined } = await joinParty(created.roomId);
  assert.equal(joined.lastState.currentTime, 123.4);
  guest.send('sync_request', {});
  const hb = await guest.next('heartbeat');
  assert.equal(hb.currentTime, 123.4);
  assert.equal(hb.sync, true);
  const req = await host.next('sync_request');
  assert.equal(req.from, joined.clientId);
  host.close();
  guest.close();
});

test('chat rate limit', async () => {
  const { c } = await createParty();
  for (let i = 0; i < 6; i++) c.send('chat', { text: `m${i}` });
  const err = await c.next('error');
  assert.equal(err.code, 'RATE_LIMITED');
  c.close();
});

test('room full at 20 members', async () => {
  const { c: host, created } = await createParty();
  const guests = [];
  for (let i = 0; i < 19; i++) guests.push((await joinParty(created.roomId, `G${i}`)).c);
  const extra = client();
  await extra.open();
  extra.send('join_room', { roomId: created.roomId, nickname: 'Late', version: '1.0.0' });
  const err = await extra.next('error');
  assert.equal(err.code, 'ROOM_FULL');
  [host, extra, ...guests].forEach((g) => g.close());
});

test('host leaves -> oldest member promoted; empty room deleted', async () => {
  const { c: host, created } = await createParty('H');
  const { c: g1, joined: j1 } = await joinParty(created.roomId, 'G1');
  const { c: g2 } = await joinParty(created.roomId, 'G2');
  host.send('leave_room', {});
  const upd = await g2.next('member_update', (m) => m.hostId === j1.clientId);
  assert.equal(upd.members.find((m) => m.isHost).nickname, 'G1');
  g1.send('leave_room', {});
  g2.send('leave_room', {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rooms.has(created.roomId), false);
  [host, g1, g2].forEach((c) => c.close());
});

test('unexpected disconnect keeps slot for grace period and resume restores host', async () => {
  const { c: host, created } = await createParty('H');
  const { c: guest } = await joinParty(created.roomId, 'G');
  host.ws.terminate();
  const upd = await guest.next('member_update', (m) => m.members.some((x) => !x.connected));
  assert.equal(upd.hostId, created.clientId); // still host during grace

  const { c: host2, joined } = await joinParty(created.roomId, 'H', '1.0.0', {
    rejoin: true,
    resumeToken: created.resumeToken,
  });
  assert.equal(joined.resumed, true);
  assert.equal(joined.isHost, true);
  assert.equal(joined.clientId, created.clientId);
  host2.close();
  guest.close();
});

test('grace expiry promotes new host', async () => {
  const { c: host, created } = await createParty('H');
  const { c: guest, joined } = await joinParty(created.roomId, 'G');
  host.ws.terminate();
  const upd = await guest.next('member_update', (m) => m.hostId === joined.clientId, 2000);
  assert.equal(upd.members.length, 1);
  guest.close();
});

test('rejoin after server restart recreates room with same code', async () => {
  const c = client();
  await c.open();
  c.send('join_room', { roomId: 'ABCDEF', nickname: 'H', version: '1.0.0', rejoin: true, hostOnlyControl: true });
  const joined = await c.next('room_joined');
  assert.equal(joined.roomId, 'ABCDEF');
  assert.equal(joined.isHost, true);
  assert.equal(joined.settings.hostOnlyControl, true);
  c.close();
});

test('version mismatch warns but allows join', async () => {
  const { c: host, created } = await createParty('H', '1.0.0');
  const g = client();
  await g.open();
  g.send('join_room', { roomId: created.roomId, nickname: 'G', version: '1.2.0' });
  await g.next('room_joined');
  const warn = await g.next('error');
  assert.equal(warn.code, 'VERSION_MISMATCH');
  const hostWarn = await host.next('error');
  assert.equal(hostWarn.code, 'VERSION_MISMATCH');
  host.close();
  g.close();
});

test('ping returns pong with serverTime', async () => {
  const c = client();
  await c.open();
  const t = Date.now();
  c.send('ping', { t });
  const pong = await c.next('pong');
  assert.equal(pong.t, t);
  assert.ok(typeof pong.serverTime === 'number');
  c.close();
});

// ---------------------------------------------------------------------------
// v1.1 features
// ---------------------------------------------------------------------------

test('avatars, profile changes and member fields', async () => {
  const c = client();
  await c.open();
  c.send('create_room', { nickname: 'A', version: '1.1.0', avatar: '🦊' });
  const created = await c.next('room_created');
  assert.equal(created.members[0].avatar, '🦊');
  assert.equal(created.members[0].inCall, false);
  const { c: g } = await joinParty(created.roomId, 'B', '1.1.0', { avatar: '<script>' });
  const upd = await c.next('member_update');
  assert.equal(upd.members.find((m) => m.nickname === 'B').avatar, '🙂'); // not in allowlist → default
  g.send('set_profile', { nickname: 'Bobby', avatar: '🐼' });
  const upd2 = await c.next('member_update', (m) => m.members.some((x) => x.nickname === 'Bobby'));
  assert.equal(upd2.members.find((m) => m.nickname === 'Bobby').avatar, '🐼');
  c.close();
  g.close();
});

test('reactions relay to others, allowlisted and rate limited', async () => {
  const { c: host, created } = await createParty('H');
  const { c: guest } = await joinParty(created.roomId, 'G');
  host.send('reaction', { emoji: '😂' });
  const r = await guest.next('reaction');
  assert.equal(r.emoji, '😂');
  assert.equal(r.nickname, 'H');
  await host.none('reaction'); // not echoed
  host.send('reaction', { emoji: 'not-an-emoji' });
  const err = await host.next('error');
  assert.equal(err.code, 'BAD_MESSAGE');
  for (let i = 0; i < 15; i++) host.send('reaction', { emoji: '🔥' });
  await new Promise((res) => setTimeout(res, 150));
  let count = 0;
  while (true) {
    try { await guest.next('reaction', () => true, 50); count++; } catch { break; }
  }
  assert.ok(count <= 10, `expected ≤10 reactions, got ${count}`);
  host.close();
  guest.close();
});

test('typing indicator relays', async () => {
  const { c: host, created } = await createParty('H');
  const { c: guest } = await joinParty(created.roomId, 'G');
  guest.send('typing', { active: true });
  const t = await host.next('typing');
  assert.equal(t.active, true);
  assert.equal(t.nickname, 'G');
  host.close();
  guest.close();
});

test('navigate: relayed to everyone, guests allowed unless host-only, stored for late joiners', async () => {
  const { c: host, created } = await createParty('H');
  const { c: guest, joined } = await joinParty(created.roomId, 'G');
  host.send('navigate', { url: 'https://www.youtube.com/watch?v=abc', title: 'Episode 2' });
  const nav = await guest.next('navigate');
  assert.equal(nav.url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(nav.title, 'Episode 2');
  assert.equal(nav.from, created.clientId);
  const echo = await host.next('navigate'); // sender gets it too (ordering)
  assert.equal(echo.from, created.clientId);

  // Guest may change the video when host-only is off…
  guest.send('navigate', { url: 'https://www.youtube.com/watch?v=xyz', title: 'Other' });
  const gnav = await host.next('navigate');
  assert.equal(gnav.from, joined.clientId);
  await guest.next('navigate');

  // …but not when host-only is on.
  host.send('set_settings', { hostOnlyControl: true });
  await guest.next('member_update', (m) => m.settings.hostOnlyControl);
  guest.send('navigate', { url: 'https://www.youtube.com/watch?v=nope', title: 'x' });
  assert.equal((await guest.next('error')).code, 'NOT_ALLOWED');
  await host.none('navigate');

  host.send('navigate', { url: 'javascript:alert(1)' });
  assert.equal((await host.next('error')).code, 'BAD_MESSAGE');
  const { c: late, joined: lj } = await joinParty(created.roomId, 'L');
  assert.equal(lj.currentUrl, 'https://www.youtube.com/watch?v=xyz');
  assert.equal(lj.currentFrom, joined.clientId);
  [host, guest, late].forEach((c) => c.close());
});

test('call join/state/leave and WebRTC signal relay', async () => {
  const { c: host, created } = await createParty('H');
  const { c: guest, joined } = await joinParty(created.roomId, 'G');
  await host.next('member_update');

  // Signals are refused until both are in the call.
  host.send('rtc_signal', { to: joined.clientId, data: { type: 'offer', callId: 'aaaa1111', sdp: 'v=0' } });
  await guest.none('rtc_signal');

  host.send('call_join', { callId: 'aaaa1111', mic: true, cam: true });
  const u1 = await guest.next('member_update', (m) => m.members.some((x) => x.inCall));
  assert.equal(u1.members.find((m) => m.id === created.clientId).callId, 'aaaa1111');
  guest.send('call_join', { callId: 'bbbb2222', mic: true, cam: false });
  await host.next('member_update', (m) => m.members.filter((x) => x.inCall).length === 2);

  const bigSdp = 'v=0\r\n' + 'a=x\r\n'.repeat(1500); // ~7.5 KB, above the normal 4 KB limit
  host.send('rtc_signal', { to: joined.clientId, data: { type: 'offer', callId: 'aaaa1111', sdp: bigSdp } });
  const sig = await guest.next('rtc_signal');
  assert.equal(sig.from, created.clientId);
  assert.equal(sig.data.type, 'offer');
  assert.equal(sig.data.sdp.length, bigSdp.length);

  guest.send('rtc_signal', { to: created.clientId, data: { type: 'candidate', callId: 'bbbb2222', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0, evil: 'x' } } });
  const cand = await host.next('rtc_signal');
  assert.equal(cand.data.candidate.sdpMid, '0');
  assert.equal(cand.data.candidate.evil, undefined);

  guest.send('call_state', { mic: false, cam: false });
  const u2 = await host.next('member_update', (m) => m.members.some((x) => x.id === joined.clientId && !x.micOn));
  assert.equal(u2.members.find((x) => x.id === joined.clientId).camOn, false);

  guest.send('call_leave', {});
  const u3 = await host.next('member_update', (m) => m.members.filter((x) => x.inCall).length === 1);
  assert.equal(u3.members.find((x) => x.id === joined.clientId).callId, null);
  host.close();
  guest.close();
});

test('after a server restart the previous host gets host back even if a guest reconnects first', async () => {
  const g = client();
  await g.open();
  g.send('join_room', { roomId: 'HHHHHH', nickname: 'Guest', version: '1.1.0', rejoin: true, wasHost: false });
  const gj = await g.next('room_joined');
  assert.equal(gj.isHost, true); // temporarily host: first one back
  const h = client();
  await h.open();
  h.send('join_room', { roomId: 'HHHHHH', nickname: 'Host', version: '1.1.0', rejoin: true, wasHost: true, hostOnlyControl: true });
  const hj = await h.next('room_joined');
  assert.equal(hj.isHost, true);
  assert.equal(hj.settings.hostOnlyControl, true);
  const upd = await g.next('member_update', (m) => m.hostId === hj.clientId);
  assert.equal(upd.members.find((m) => m.id === gj.clientId).isHost, false);
  g.close();
  h.close();
});

test('server reports its version; title-only navigate never moves the party', async () => {
  const { c: host, created } = await createParty('H');
  assert.equal(created.serverVersion, require('../package.json').version);
  const { c: guest } = await joinParty(created.roomId, 'G');
  host.send('navigate', { url: 'https://www.youtube.com/watch?v=one', title: '' });
  await guest.next('navigate');
  await host.next('navigate');
  guest.send('navigate', { url: 'https://www.youtube.com/watch?v=two', title: 'Two' });
  await host.next('navigate', (m) => m.url.endsWith('two'));
  await guest.next('navigate', (m) => m.url.endsWith('two')); // own echo
  // Stale title refresh from the host for the old video: dropped.
  host.send('navigate', { url: 'https://www.youtube.com/watch?v=one', title: 'One', titleOnly: true });
  await guest.none('navigate');
  // Title refresh from the member who picked the current video: relayed as title-only.
  guest.send('navigate', { url: 'https://www.youtube.com/watch?v=two', title: 'Two (HD)', titleOnly: true });
  const t = await host.next('navigate', (m) => m.titleOnly);
  assert.equal(t.title, 'Two (HD)');
  host.close();
  guest.close();
});

test('turn: sanitize keeps only valid STUN/TURN entries; static provider', async () => {
  const turn = require('../turn');
  assert.deepEqual(turn.sanitize([
    { urls: ['turn:a.example.com:3478', 'javascript:x', 'turns:a.example.com:443?transport=tcp'], username: 'u', credential: 'c' },
    { urls: 'stun:s.example.com:3478' },
    { urls: ['http://bad'] },
    null,
  ]), [
    { urls: ['turn:a.example.com:3478', 'turns:a.example.com:443?transport=tcp'], username: 'u', credential: 'c' },
    { urls: ['stun:s.example.com:3478'] },
  ]);
  turn.resetCache();
  const servers = await turn.getIceServers({ TURN_URLS: 'turn:t.example.com:3478, turn:t.example.com:443?transport=tcp', TURN_USERNAME: 'x', TURN_CREDENTIAL: 'y' });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].urls.length, 2);
  assert.equal(servers[0].username, 'x');
  turn.resetCache();
  assert.deepEqual(await turn.getIceServers({}), []);
  turn.resetCache();
});

test('ice_servers is sent after joining', async () => {
  const { c: host, created } = await createParty('H');
  const ice = await host.next('ice_servers');
  assert.ok(Array.isArray(ice.iceServers));
  assert.equal(typeof ice.relay, 'boolean');
  host.send('get_ice', {});
  await host.next('ice_servers');
  const { c: guest } = await joinParty(created.roomId, 'G');
  await guest.next('ice_servers');
  host.close();
  guest.close();
});

test('party key: wrong or missing key is refused, right key works', async () => {
  CONFIG.partyKey = 's3cret key';
  try {
    const closeCode = (u) => new Promise((resolve) => {
      const ws = new WebSocket(u);
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
    });
    assert.equal(await closeCode(url), 4401);
    assert.equal(await closeCode(`${url}/?key=wrong`), 4401);
    const ok = new WebSocket(`${url}/?key=${encodeURIComponent('s3cret key')}`);
    await new Promise((r) => ok.once('open', r));
    const got = new Promise((r) => ok.once('message', (m) => r(JSON.parse(m.toString()))));
    ok.send(JSON.stringify({ type: 'create_room', nickname: 'K', version: '1.5.0' }));
    assert.equal((await got).type, 'room_created');
    ok.close();
  } finally {
    CONFIG.partyKey = '';
  }
});
