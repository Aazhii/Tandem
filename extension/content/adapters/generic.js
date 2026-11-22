'use strict';

/**
 * Generic adapter: direct control of a plain HTML5 <video> element.
 *
 * Adapter interface (all adapters):
 *   play(), pause(), seek(seconds), getTime(), isPaused(), getRate(), setRate(r)
 *   isAdPlaying()          -> true while the site is showing an ad (sync is skipped)
 *   supportsRateNudge      -> whether drift correction may nudge playbackRate
 *   destroy()              -> remove any listeners the adapter added
 *
 * Adapter definitions register on the shared namespace as { name, matches(hostname), create(video, ctx) }.
 * `ctx` is provided by content.js: { rescan(), suppressAll(ms) }.
 */
(() => {
  const WP = (globalThis.__watchParty = globalThis.__watchParty || {});
  WP.adapters = WP.adapters || {};

  function createGenericAdapter(video) {
    return {
      name: 'generic',
      video,
      supportsRateNudge: true,
      play() {
        return video.play();
      },
      pause() {
        video.pause();
      },
      seek(seconds) {
        video.currentTime = Math.max(0, seconds);
      },
      getTime() {
        return video.currentTime;
      },
      isPaused() {
        return video.paused;
      },
      getRate() {
        return video.playbackRate;
      },
      setRate(rate) {
        video.playbackRate = rate;
      },
      isAdPlaying() {
        return false;
      },
      destroy() {},
    };
  }

  WP.adapters.generic = {
    name: 'generic',
    matches: () => true,
    create: createGenericAdapter,
  };
})();
