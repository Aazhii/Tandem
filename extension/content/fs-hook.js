'use strict';

/**
 * Runs in the page's own JS world (MAIN), in every frame, before the site's scripts.
 *
 * During a watch party, a player's "fullscreen" request is handed to the extension instead, which
 * makes the whole PAGE fullscreen and lays the player out next to the chat (like Teleparty). That
 * keeps the chat and video call visible and usable in fullscreen, even for players inside iframes.
 *
 * Players check document.fullscreenElement to decide whether they are fullscreen. With the page
 * fullscreen that would be <html>, not the player, and strict players (e.g. Crunchyroll) then
 * exit or reset straight away. So while the takeover is active (data-wp-fs-active on <html>, set
 * by the extension), the player is told that its own element is the fullscreen element, and
 * exitFullscreen() calls are routed to the extension, which honours them only when the user
 * actually clicked/pressed something (a player "cleaning up" on its own is ignored).
 *
 * Outside a party (no data-wp-party attribute on <html>) everything behaves exactly as normal.
 */
(() => {
  if (window.__watchPartyFsHook) return;
  window.__watchPartyFsHook = true;

  const IS_TOP = window === window.top;
  let requested = null; // the element the player asked to make fullscreen

  const root = () => document.documentElement;
  const flag = () => {
    const r = root();
    return r ? r.getAttribute('data-wp-fs-active') : null; // null | 'pending' | 'on'
  };

  /** document.fullscreenElement reports the shadow host when the element is inside a shadow root. */
  function retarget(el) {
    let n = el;
    while (n && n.getRootNode && n.getRootNode() !== document) {
      const r = n.getRootNode();
      n = r && r.host;
    }
    return n || null;
  }

  function spoofed(real) {
    const f = flag();
    if (!f || !requested || !requested.isConnected) return real;
    if (f === 'pending') return retarget(requested);
    if (IS_TOP) return real === root() ? retarget(requested) : real;
    return retarget(requested);
  }

  // --- requestFullscreen ---------------------------------------------------------------------
  function wrapRequest(original) {
    if (typeof original !== 'function') return original;
    return function requestFullscreen(...args) {
      const r = root();
      if (r && r.hasAttribute('data-wp-party') && this !== r && this.isConnected) {
        if (flag() && requested && requested.isConnected) return Promise.resolve(); // already beside the chat
        const prev = requested;
        requested = this;
        const ev = new CustomEvent('watchparty:fullscreen', { bubbles: true, composed: true, cancelable: true });
        this.dispatchEvent(ev);
        if (ev.defaultPrevented) return Promise.resolve();
        requested = prev;
      }
      return original.apply(this, args);
    };
  }

  const EP = Element.prototype;
  EP.requestFullscreen = wrapRequest(EP.requestFullscreen);
  if (EP.webkitRequestFullscreen) EP.webkitRequestFullscreen = wrapRequest(EP.webkitRequestFullscreen);
  if (EP.webkitRequestFullScreen) EP.webkitRequestFullScreen = wrapRequest(EP.webkitRequestFullScreen);
  const VP = window.HTMLVideoElement && HTMLVideoElement.prototype;
  if (VP && VP.webkitEnterFullscreen) VP.webkitEnterFullscreen = wrapRequest(VP.webkitEnterFullscreen);
  if (VP && VP.webkitEnterFullScreen) VP.webkitEnterFullScreen = wrapRequest(VP.webkitEnterFullScreen);

  // --- exitFullscreen ------------------------------------------------------------------------
  function wrapExit(original) {
    if (typeof original !== 'function') return original;
    return function exitFullscreen(...args) {
      if (this === document && flag()) {
        const ev = new CustomEvent('watchparty:exitfullscreen', { cancelable: true });
        document.dispatchEvent(ev);
        if (ev.defaultPrevented) return Promise.resolve();
      }
      return original.apply(this, args);
    };
  }

  const DP = Document.prototype;
  for (const name of ['exitFullscreen', 'webkitExitFullscreen', 'webkitCancelFullScreen']) {
    if (typeof DP[name] === 'function') DP[name] = wrapExit(DP[name]);
  }

  // --- fullscreen state getters --------------------------------------------------------------
  function spoofGetter(name, map) {
    const desc = Object.getOwnPropertyDescriptor(DP, name);
    if (!desc || typeof desc.get !== 'function' || !desc.configurable) return;
    Object.defineProperty(DP, name, {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        const real = desc.get.call(this);
        if (this !== document) return real;
        return map(real);
      },
    });
  }
  const fsEl = Object.getOwnPropertyDescriptor(DP, 'fullscreenElement');
  const realEl = (doc) => (fsEl && fsEl.get ? fsEl.get.call(doc) : null);
  spoofGetter('fullscreenElement', (real) => spoofed(real));
  spoofGetter('webkitFullscreenElement', (real) => spoofed(real));
  spoofGetter('webkitCurrentFullScreenElement', (real) => spoofed(real));
  spoofGetter('fullscreen', (real) => real || !!spoofed(realEl(document)));
  spoofGetter('webkitIsFullScreen', (real) => real || !!spoofed(realEl(document)));
})();
