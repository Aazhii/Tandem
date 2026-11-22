'use strict';

/**
 * YouTube adapter.
 * - YouTube is a SPA: on `yt-navigate-start/finish` the same <video> is reused for a new video,
 *   so we briefly suppress outgoing events and re-scan for the player.
 * - While an ad plays (`.ad-showing` on the player) sync is skipped; content.js re-syncs afterwards.
 */
(() => {
  const WP = (globalThis.__watchParty = globalThis.__watchParty || {});
  WP.adapters = WP.adapters || {};

  const HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/;

  function createYouTubeAdapter(video, ctx) {
    const base = WP.adapters.generic.create(video, ctx);

    const onNavStart = () => ctx.suppressAll(2000);
    const onNavFinish = () => {
      ctx.suppressAll(1500);
      ctx.rescan();
    };
    document.addEventListener('yt-navigate-start', onNavStart);
    document.addEventListener('yt-navigate-finish', onNavFinish);

    function playerEl() {
      return video.closest('.html5-video-player') || document.getElementById('movie_player');
    }

    return {
      ...base,
      name: 'youtube',
      isAdPlaying() {
        const p = playerEl();
        return !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
      },
      destroy() {
        document.removeEventListener('yt-navigate-start', onNavStart);
        document.removeEventListener('yt-navigate-finish', onNavFinish);
      },
    };
  }

  WP.adapters.youtube = {
    name: 'youtube',
    matches: (hostname) => HOST_RE.test(hostname),
    create: createYouTubeAdapter,
  };
})();
