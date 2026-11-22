'use strict';

/**
 * Runs in the page's own JS world (MAIN), in every frame, before the site's scripts.
 *
 * During a watch party, a player's "fullscreen" request is handed to the extension instead, which
 * makes the whole PAGE fullscreen and lays the player out next to the chat (like Teleparty). That
 * keeps the chat and video call visible and usable in fullscreen, even for players inside iframes.
 *
 * Outside a party (no data-wp-party attribute on <html>) everything behaves exactly as normal.
 * The extension's isolated content script answers by calling preventDefault() on the event when
 * it takes over; otherwise the original request runs.
 */
(() => {
  if (window.__watchPartyFsHook) return;
  window.__watchPartyFsHook = true;

  const proto = Element.prototype;

  function wrap(original) {
    if (typeof original !== 'function') return original;
    return function requestFullscreen(...args) {
      const de = document.documentElement;
      if (de && de.hasAttribute('data-wp-party') && this !== de && this.isConnected) {
        const ev = new CustomEvent('watchparty:fullscreen', { bubbles: true, composed: true, cancelable: true });
        this.dispatchEvent(ev);
        if (ev.defaultPrevented) return Promise.resolve();
      }
      return original.apply(this, args);
    };
  }

  proto.requestFullscreen = wrap(proto.requestFullscreen);
  if (proto.webkitRequestFullscreen) proto.webkitRequestFullscreen = wrap(proto.webkitRequestFullscreen);
  if (proto.webkitRequestFullScreen) proto.webkitRequestFullScreen = wrap(proto.webkitRequestFullScreen);
})();
