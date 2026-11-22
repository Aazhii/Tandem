'use strict';

/**
 * Verifies TURN credentials by actually logging in to the relay (a TURN "Allocate" request with
 * long-term credentials, RFC 5766/8656), over UDP or TCP. Used by scripts/setup-turn.sh and at
 * server start so a typo shows up immediately instead of as a silent "Connecting…" in the call.
 */

const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');

const MAGIC = 0x2112a442;
const T = { ALLOCATE: 0x0003, REFRESH: 0x0004, ALLOCATE_OK: 0x0103, ALLOCATE_ERR: 0x0113 };
const A = { USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008, ERROR_CODE: 0x0009, LIFETIME: 0x000d, REALM: 0x0014, NONCE: 0x0015, REQUESTED_TRANSPORT: 0x0019 };
const TIMEOUT_MS = 5000;

/** "turn:host:port?transport=tcp" → { host, port, transport, secure } (null if not a TURN url). */
function parseTurnUrl(url) {
  const m = /^(turns?):(\[[^\]]+\]|[^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(String(url).trim());
  if (!m) return null;
  const secure = m[1].toLowerCase() === 'turns';
  return {
    host: m[2].replace(/^\[|\]$/g, ''),
    port: Number(m[3]) || (secure ? 5349 : 3478),
    transport: secure ? 'tcp' : (m[4] || 'udp').toLowerCase(),
    secure,
  };
}

function attr(type, value) {
  const pad = (4 - (value.length % 4)) % 4;
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc(pad)]);
}

function message(type, tid, attrs, key) {
  let body = Buffer.concat(attrs);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt32BE(MAGIC, 4);
  tid.copy(header, 8);
  if (key) {
    // MESSAGE-INTEGRITY covers the message with the length already including the MI attribute.
    header.writeUInt16BE(body.length + 24, 2);
    const hmac = crypto.createHmac('sha1', key).update(Buffer.concat([header, body])).digest();
    body = Buffer.concat([body, attr(A.MESSAGE_INTEGRITY, hmac)]);
  }
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function parse(buf) {
  if (buf.length < 20 || buf.readUInt32BE(4) !== MAGIC) return null;
  const out = { type: buf.readUInt16BE(0), tid: buf.subarray(8, 20), attrs: {} };
  let off = 20;
  const end = 20 + buf.readUInt16BE(2);
  while (off + 4 <= end && off + 4 <= buf.length) {
    const t = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    out.attrs[t] = buf.subarray(off + 4, off + 4 + len);
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  if (out.attrs[A.ERROR_CODE]) {
    const e = out.attrs[A.ERROR_CODE];
    out.error = { code: (e[2] & 7) * 100 + e[3], reason: e.subarray(4).toString() };
  }
  return out;
}

/** Minimal request/response transport over UDP or TCP. */
function openTransport({ host, port, transport }) {
  return new Promise((resolve, reject) => {
    const waiters = new Map();
    const deliver = (buf) => {
      const msg = parse(buf);
      if (!msg) return;
      const w = waiters.get(msg.tid.toString('hex'));
      if (w) { waiters.delete(msg.tid.toString('hex')); w(msg); }
    };
    const request = (sendFn) => (buf) => new Promise((res, rej) => {
      const key = buf.subarray(8, 20).toString('hex');
      const timer = setTimeout(() => { waiters.delete(key); rej(new Error('no answer from the relay (timed out)')); }, TIMEOUT_MS);
      waiters.set(key, (m) => { clearTimeout(timer); res(m); });
      sendFn(buf);
    });

    if (transport === 'udp') {
      const sock = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
      sock.on('message', deliver);
      sock.on('error', reject);
      sock.bind(0, () => resolve({
        send: request((b) => sock.send(b, port, host)),
        close: () => { try { sock.close(); } catch { /* closed */ } },
      }));
      return;
    }
    const sock = net.connect({ host, port });
    let pending = Buffer.alloc(0);
    sock.setTimeout(TIMEOUT_MS, () => sock.destroy(new Error('connection timed out')));
    sock.on('data', (d) => {
      pending = Buffer.concat([pending, d]);
      while (pending.length >= 20) {
        const len = 20 + pending.readUInt16BE(2);
        if (pending.length < len) break;
        deliver(pending.subarray(0, len));
        pending = pending.subarray(len);
      }
    });
    sock.once('error', reject);
    sock.once('connect', () => resolve({
      send: request((b) => sock.write(b)),
      close: () => sock.destroy(),
    }));
  });
}

/** Resolves { ok: true } or { ok: false, error }. Never rejects. */
async function checkTurnUrl(url, username, credential) {
  const target = parseTurnUrl(url);
  if (!target) return { ok: false, error: `not a TURN address: ${url}` };
  if (target.secure) return { ok: false, skipped: true, error: 'turns: (TLS) not checked' };
  let t;
  try {
    t = await openTransport(target);
    const transportAttr = attr(A.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]));
    const first = await t.send(message(T.ALLOCATE, crypto.randomBytes(12), [transportAttr]));
    if (first.type === T.ALLOCATE_OK) return { ok: true, note: 'relay does not require a password' };
    if (!first.error || first.error.code !== 401 || !first.attrs[A.REALM] || !first.attrs[A.NONCE]) {
      return { ok: false, error: `unexpected answer from relay${first.error ? ` (${first.error.code} ${first.error.reason})` : ''}` };
    }
    const realm = first.attrs[A.REALM];
    const nonce = first.attrs[A.NONCE];
    const key = crypto.createHash('md5').update(`${username}:${realm.toString()}:${credential}`).digest();
    const authAttrs = [attr(A.USERNAME, Buffer.from(username)), attr(A.REALM, realm), attr(A.NONCE, nonce)];
    const second = await t.send(message(T.ALLOCATE, crypto.randomBytes(12), [transportAttr, ...authAttrs], key));
    if (second.type === T.ALLOCATE_OK) {
      // Free the test allocation right away (best effort).
      t.send(message(T.REFRESH, crypto.randomBytes(12), [attr(A.LIFETIME, Buffer.alloc(4)), ...authAttrs], key)).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true };
    }
    if (second.error && second.error.code === 401) return { ok: false, error: 'wrong username or password' };
    return { ok: false, error: `relay refused (${second.error ? `${second.error.code} ${second.error.reason}` : 'unknown'})` };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    if (t) t.close();
  }
}

/** Checks every TURN url of an RTCIceServer[]; ok if at least one works. */
async function checkIceServers(servers) {
  const results = [];
  for (const s of servers || []) {
    for (const url of s.urls || []) {
      if (!/^turns?:/i.test(url)) continue;
      results.push({ url, ...(await checkTurnUrl(url, s.username || '', s.credential || '')) });
    }
  }
  return { ok: results.some((r) => r.ok), results };
}

module.exports = { checkTurnUrl, checkIceServers, parseTurnUrl };
