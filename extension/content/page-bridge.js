/**
 * Tandem page bridge — runs in the page's MAIN world (not the extension's isolated world).
 *
 * Exposes a tiny command channel over window.postMessage so the Netflix adapter can use
 * Netflix's internal player API (seeking via `video.currentTime` crashes the Netflix player).
 * Only player commands are supported; nothing is read from or sent to the network.
 */
(() => {
  'use strict';
  if (window.__watchPartyBridge) {
    window.postMessage({ ns: 'watch-party', dir: 'to-content', id: 'ready', ok: true }, window.location.origin);
    return;
  }
  window.__watchPartyBridge = true;

  const NS = 'watch-party';

  function getPlayer() {
    const videoPlayer = window.netflix
      && window.netflix.appContext
      && window.netflix.appContext.state
      && window.netflix.appContext.state.playerApp
      && window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
    if (!videoPlayer) throw new Error('Netflix player API not found');
    const ids = (videoPlayer.getAllPlayerSessionIds && videoPlayer.getAllPlayerSessionIds()) || [];
    const sessionId = ids.find((id) => String(id).startsWith('watch')) || ids[ids.length - 1];
    if (!sessionId) throw new Error('No Netflix player session');
    const player = videoPlayer.getVideoPlayerBySessionId(sessionId);
    if (!player) throw new Error('Netflix player not available');
    return player;
  }

  const commands = {
    ping: () => 'pong',
    seek: ({ ms }) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error('bad seek');
      getPlayer().seek(ms);
    },
    play: () => getPlayer().play(),
    pause: () => getPlayer().pause(),
    getState: () => {
      const p = getPlayer();
      return { timeMs: p.getCurrentTime(), paused: p.isPaused() };
    },
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.ns !== NS || d.dir !== 'to-page' || typeof d.cmd !== 'string') return;
    let reply;
    try {
      const fn = Object.prototype.hasOwnProperty.call(commands, d.cmd) ? commands[d.cmd] : null;
      if (!fn) throw new Error(`unknown command ${d.cmd}`);
      const result = fn(d.args || {});
      reply = { ok: true, result: result === undefined ? null : result };
    } catch (err) {
      reply = { ok: false, error: String((err && err.message) || err) };
    }
    try {
      window.postMessage({ ns: NS, dir: 'to-content', id: d.id, ...reply }, window.location.origin);
    } catch {
      window.postMessage({ ns: NS, dir: 'to-content', id: d.id, ok: reply.ok, error: reply.error }, window.location.origin);
    }
  });

  window.postMessage({ ns: NS, dir: 'to-content', id: 'ready', ok: true }, window.location.origin);
})();
