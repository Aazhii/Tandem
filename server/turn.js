'use strict';

/**
 * TURN relay credentials for the video call.
 *
 * Direct (peer-to-peer) video fails when both friends sit behind strict NATs, which is common on
 * mobile networks and on ISPs that share one public IP between many customers (CGNAT). A TURN
 * server relays the video in that case. Credentials stay on the server and are handed to party
 * members when they join, so the extension zip never contains secrets.
 *
 * Configure ONE of these in server/.env (./scripts/setup-turn.sh writes it for you):
 *   Cloudflare:  CF_TURN_KEY_ID, CF_TURN_API_TOKEN          (short-lived credentials via API)
 *   Metered:     METERED_DOMAIN, METERED_API_KEY            (e.g. myapp.metered.live)
 *   Any server:  TURN_URLS (comma-separated), TURN_USERNAME, TURN_CREDENTIAL
 */

const TTL_SECONDS = 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 8000;

let cache = null; // { servers, expiresAt }
let inflight = null;
let lastError = null;

function provider(env = process.env) {
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) return 'cloudflare';
  if (env.METERED_DOMAIN && env.METERED_API_KEY) return 'metered';
  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) return 'static';
  return null;
}

/** Keep only well-formed STUN/TURN entries (never trust a remote API blindly). */
function sanitize(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : [list]) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls || s.url])
      .filter((u) => typeof u === 'string' && /^(stun|turn|turns):[^\s]{1,250}$/i.test(u))
      .slice(0, 8);
    if (!urls.length) continue;
    const entry = { urls };
    if (typeof s.username === 'string') entry.username = s.username.slice(0, 512);
    if (typeof s.credential === 'string') entry.credential = s.credential.slice(0, 512);
    out.push(entry);
    if (out.length >= 6) break;
  }
  return out;
}

async function fetchJson(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function load(env) {
  switch (provider(env)) {
    case 'cloudflare': {
      const id = encodeURIComponent(env.CF_TURN_KEY_ID.trim());
      const body = await fetchJson(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      });
      // Port 53 is often blocked by browsers/firewalls; Cloudflare's docs suggest dropping it.
      const servers = sanitize(body.iceServers).map((s) => ({ ...s, urls: s.urls.filter((u) => !/:53(\?|$)/.test(u)) }));
      return { servers: servers.filter((s) => s.urls.length), ttlMs: (TTL_SECONDS / 2) * 1000 };
    }
    case 'metered': {
      const domain = env.METERED_DOMAIN.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const body = await fetchJson(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY.trim())}`);
      return { servers: sanitize(body), ttlMs: 60 * 60 * 1000 };
    }
    case 'static':
      return {
        servers: sanitize({
          urls: env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL,
        }),
        ttlMs: Infinity,
      };
    default:
      return { servers: [], ttlMs: Infinity };
  }
}

/** Resolves to an RTCIceServer[] (possibly empty). Never rejects. */
function getIceServers(env = process.env) {
  if (cache && Date.now() < cache.expiresAt) return Promise.resolve(cache.servers);
  if (inflight) return inflight;
  inflight = load(env)
    .then(({ servers, ttlMs }) => {
      lastError = servers.length || !provider(env) ? null : 'provider returned no usable servers';
      cache = { servers, expiresAt: Date.now() + (servers.length ? ttlMs : 60 * 1000) };
      return servers;
    })
    .catch((err) => {
      lastError = err.message || String(err);
      cache = { servers: cache ? cache.servers : [], expiresAt: Date.now() + 60 * 1000 }; // retry in a minute
      return cache.servers;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

function status() {
  return { provider: provider(), lastError };
}

function resetCache() {
  cache = null;
  inflight = null;
  lastError = null;
}

module.exports = { getIceServers, provider, status, sanitize, resetCache };
