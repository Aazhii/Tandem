'use strict';

/**
 * Netflix adapter.
 *
 * Setting `video.currentTime` on Netflix triggers a player error (M7375), so seeking (and play/pause,
 * for consistency) goes through Netflix's own player API. That API is only reachable from the page's
 * MAIN world, so we inject `page-bridge.js` and talk to it with namespaced window.postMessage calls.
 * Everything falls back to the plain <video> element if the bridge or the API is unavailable.
 */
(() => {
  const WP = (globalThis.__watchParty = globalThis.__watchParty || {});
  WP.adapters = WP.adapters || {};

  const NS = 'watch-party';
  const HOST_RE = /(^|\.)netflix\.com$/;

  let bridgeState = 'none'; // none | injecting | ready | failed
  let seq = 0;
  const waiting = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.ns !== NS || d.dir !== 'to-content') return;
    if (d.id === 'ready') {
      bridgeState = 'ready';
      return;
    }
    const resolve = waiting.get(d.id);
    if (resolve) {
      waiting.delete(d.id);
      resolve(d);
    }
  });

  function callBridge(cmd, args = {}, timeoutMs = 800) {
    return new Promise((resolve) => {
      const id = `c${++seq}`;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);
      waiting.set(id, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
      window.postMessage({ ns: NS, dir: 'to-page', id, cmd, args }, window.location.origin);
    });
  }

  function ensureBridge() {
    if (bridgeState !== 'none') return;
    bridgeState = 'injecting';
    const requestFallback = () => {
      if (bridgeState === 'ready') return;
      chrome.runtime.sendMessage({ cmd: 'need_bridge' }).catch(() => {});
    };
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('content/page-bridge.js');
      s.onload = () => s.remove();
      s.onerror = () => {
        s.remove();
        requestFallback();
      };
      (document.head || document.documentElement).appendChild(s);
    } catch {
      requestFallback();
    }
    // If the bridge has not announced itself shortly (e.g. CSP blocked it), ask the background
    // to inject it via chrome.scripting into the MAIN world.
    setTimeout(async () => {
      if (bridgeState === 'ready') return;
      const r = await callBridge('ping');
      if (r.ok) bridgeState = 'ready';
      else requestFallback();
    }, 1500);
  }

  function createNetflixAdapter(video, ctx) {
    const base = WP.adapters.generic.create(video, ctx);
    ensureBridge();

    async function viaBridge(cmd, args, fallback) {
      const r = await callBridge(cmd, args);
      if (r.ok) return;
      console.debug('[WatchParty] Netflix bridge failed, falling back:', cmd, r.error);
      fallback();
    }

    return {
      ...base,
      name: 'netflix',
      // Netflix's player reacts badly to playbackRate changes; drift is corrected by seeking only.
      supportsRateNudge: false,
      play() {
        return viaBridge('play', {}, () => base.play());
      },
      pause() {
        return viaBridge('pause', {}, () => base.pause());
      },
      seek(seconds) {
        return viaBridge('seek', { ms: Math.max(0, Math.round(seconds * 1000)) }, () => base.seek(seconds));
      },
      setRate() {
        // Not supported reliably on Netflix; ignore.
      },
    };
  }

  WP.adapters.netflix = {
    name: 'netflix',
    matches: (hostname) => HOST_RE.test(hostname),
    create: createNetflixAdapter,
  };
})();
