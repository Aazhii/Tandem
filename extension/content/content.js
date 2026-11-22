'use strict';

/**
 * Watch Party content script (runs in every frame).
 *
 * - Finds the main <video> (largest visible one), re-scanning on DOM mutations (SPAs swap players).
 * - Hooks play / pause / seeked / ratechange (+ waiting / playing for buffering) and reports them.
 * - Applies remote commands with echo suppression so they are not re-broadcast (no sync loops).
 * - Host: sends a heartbeat every 3s. Guests: correct drift from heartbeats (hard seek / rate nudge).
 * - Top frame only: mounts the chat overlay.
 *
 * All timestamps here are local Date.now() values; the background converts to/from server time.
 */
(() => {
  const WP = (globalThis.__watchParty = globalThis.__watchParty || {});
  if (WP.contentStarted) return;
  WP.contentStarted = true;

  const IS_TOP = window === window.top;

  const HEARTBEAT_MS = 3000;
  const TICK_MS = 1000;
  const KEEPALIVE_MS = 25_000;
  const MIN_VIDEO_AREA = 160 * 90; // ignore thumbnails / tiny previews
  const HARD_SEEK_DRIFT = 1.0; // seconds, while playing
  const PAUSED_SEEK_DRIFT = 0.3; // seconds, while paused
  const SYNC_SEEK_DRIFT = 0.5; // seconds, for explicit sync responses (late join / revert)
  const SOFT_DRIFT = 0.3; // seconds, nudge playbackRate above this
  const NUDGE_FACTOR = 0.05; // ±5% speed
  const NUDGE_MAX_MS = 6000;
  const REMOTE_QUIET_MS = 300; // ignore all video events right after applying a remote command
  const HEARTBEAT_GRACE_MS = 1500; // ignore heartbeats sent before/around our latest command
  const REVERT_WINDOW_MS = 800; // a play/pause this soon after a remote one, without user input, is the player undoing it
  const USER_INPUT_MS = 1200; // input this recent means a play/pause event came from the person
  const SEEK_DEBOUNCE_MS = 250; // scrubbing fires many `seeked` events
  const EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'waiting', 'playing', 'canplay'];

  const adapterDef = [WP.adapters.youtube, WP.adapters.netflix]
    .find((a) => a && a.matches(location.hostname)) || WP.adapters.generic;

  let alive = true;
  let party = { inRoom: false };

  let video = null;
  let adapter = null;
  let reportedArea = 0;

  let expectations = []; // [{ type, until }] events we caused ourselves and must not re-broadcast
  let quietUntil = 0;
  let lastCommandAt = 0;
  let lastApplied = { action: null, at: 0, retries: 0 }; // last remote play/pause we applied
  let lastUserInputAt = 0;
  let mutedBySync = false;
  let buffering = false;
  let baseRate = 1; // the "real" playback rate (excludes drift nudges)
  let nudge = null;
  let adActive = false;

  let seekTimer = null;
  let heartbeatTimer = null;
  let tickTimer = null;
  let keepaliveTimer = null;
  let rescanTimer = null;
  let revertTimer = null;
  let observer = null;
  let lastSyncRequestAt = 0;
  let lastRevertNoticeAt = 0;
  let tickCount = 0;

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  function isInvalidated(err) {
    return /Extension context invalidated/i.test(String((err && err.message) || err));
  }

  function send(msg) {
    if (!alive) return Promise.resolve(undefined);
    try {
      return chrome.runtime.sendMessage(msg).catch((err) => {
        if (isInvalidated(err)) shutdown();
        return undefined;
      });
    } catch (err) {
      if (isInvalidated(err)) shutdown();
      return Promise.resolve(undefined);
    }
  }

  function notice(text, action) {
    send({ cmd: 'notice', text, action: action || null });
  }

  function debug(...args) {
    console.debug('[WatchParty sync]', ...args);
  }

  // Real clicks/keys in this frame: tells a person's play/pause apart from the player's own.
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(type, (e) => {
      if (e.isTrusted) lastUserInputAt = Date.now();
    }, { capture: true, passive: true });
  }

  const ctx = {
    rescan: () => queueRescan(),
    suppressAll(ms) {
      quietUntil = Math.max(quietUntil, Date.now() + ms);
    },
  };

  // -------------------------------------------------------------------------
  // Video discovery
  // -------------------------------------------------------------------------

  function areaOf(v) {
    if (!v || !v.isConnected) return 0;
    const r = v.getBoundingClientRect();
    return r.width > 1 && r.height > 1 ? Math.round(r.width * r.height) : 0;
  }

  function findMainVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.getElementsByTagName('video')) {
      const area = areaOf(v);
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return bestArea >= MIN_VIDEO_AREA ? { video: best, area: bestArea } : { video: null, area: 0 };
  }

  function rescan() {
    rescanTimer = null;
    if (!party.inRoom) return;
    const found = findMainVideo();
    let next = found.video;
    let area = found.area;
    // Hysteresis: keep the current video unless something clearly bigger shows up.
    const curArea = areaOf(video);
    if (video && curArea >= MIN_VIDEO_AREA && (!next || found.area < curArea * 1.3)) {
      next = video;
      area = curArea;
    }
    if (next !== video) attach(next);
    reportStatus(false, next ? area : 0);
  }

  function queueRescan() {
    if (!rescanTimer) rescanTimer = setTimeout(rescan, 300);
  }

  function reportStatus(force, area = areaOf(video)) {
    if (!party.inRoom) return;
    const presenceChanged = (area === 0) !== (reportedArea === 0);
    const sizeChanged = Math.abs(area - reportedArea) > reportedArea * 0.25;
    if (!(presenceChanged || sizeChanged || (force && area > 0))) return;
    if (area === 0 && reportedArea === 0) return;
    reportedArea = area;
    send({ cmd: 'video_status', area });
  }

  function attach(v) {
    if (video) for (const t of EVENTS) video.removeEventListener(t, onVideoEvent);
    stopNudge();
    if (adapter) adapter.destroy();
    clearTimeout(seekTimer);
    video = v;
    adapter = null;
    buffering = false;
    expectations = [];
    adActive = false;
    if (!v) return;

    adapter = adapterDef.create(v, ctx);
    baseRate = adapter.getRate() || 1;
    for (const t of EVENTS) v.addEventListener(t, onVideoEvent);
    if (party.inRoom && !party.isHost) requestSync();
    if (party.inRoom && party.isHost) sendHeartbeat();
  }

  // -------------------------------------------------------------------------
  // Echo suppression
  // -------------------------------------------------------------------------

  function expect(type, ms = 1500) {
    expectations.push({ type, until: Date.now() + ms });
  }

  function consumeExpectation(type) {
    const now = Date.now();
    expectations = expectations.filter((x) => x.until > now);
    const i = expectations.findIndex((x) => x.type === type);
    if (i < 0) return false;
    expectations.splice(i, 1);
    return true;
  }

  function dropExpectation(type) {
    const i = expectations.findIndex((x) => x.type === type);
    if (i >= 0) expectations.splice(i, 1);
  }

  function markRemote() {
    quietUntil = Math.max(quietUntil, Date.now() + REMOTE_QUIET_MS);
  }

  // -------------------------------------------------------------------------
  // Local events → server
  // -------------------------------------------------------------------------

  function onVideoEvent(e) {
    const type = e.type;
    if (type === 'waiting') {
      buffering = true;
      return;
    }
    if (type === 'playing' || type === 'canplay') {
      buffering = false;
      return;
    }
    if (!party.inRoom || !adapter || e.target !== video) return;

    if (consumeExpectation(type)) return; // caused by us applying a remote command
    if (type === 'ratechange' && nudge) return; // drift nudge, not a user action
    if (adapter.isAdPlaying()) return;

    // The site's player flipped back right after we applied a remote play/pause, and nobody touched
    // anything here: re-apply instead of broadcasting (that would stop everyone else too).
    const now = Date.now();
    const opposite = (type === 'pause' && lastApplied.action === 'play') || (type === 'play' && lastApplied.action === 'pause');
    if (opposite && now - lastApplied.at < REVERT_WINDOW_MS && now - lastUserInputAt > USER_INPUT_MS && lastApplied.retries < 2) {
      lastApplied.retries++;
      debug('player undid remote', lastApplied.action, '→ re-applying');
      setTimeout(() => {
        if (!adapter) return;
        if (lastApplied.action === 'play') doPlay(true);
        else doPause(true);
      }, 150);
      return;
    }
    if (Date.now() < quietUntil) return;

    if (type === 'ratechange') {
      const r = adapter.getRate();
      if (Math.abs(r - baseRate) < 0.001) return;
      baseRate = r;
    }

    if (!party.canControl) {
      revertToHost();
      return;
    }

    if (type === 'seeked') {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => emit('seek'), SEEK_DEBOUNCE_MS);
      return;
    }
    emit(type === 'ratechange' ? 'rate' : type);
  }

  function emit(action) {
    if (!adapter || !party.inRoom) return;
    const now = Date.now();
    debug('local', action, 'at', adapter.getTime().toFixed(2));
    lastApplied = { action: null, at: 0, retries: 0 };
    lastCommandAt = now;
    send({
      cmd: 'playback',
      action,
      currentTime: adapter.getTime(),
      playbackRate: baseRate,
      paused: adapter.isPaused(),
      sentAt: now,
    });
  }

  /** Guest touched the controls in host-only mode: snap back to the host. */
  function revertToHost() {
    clearTimeout(revertTimer);
    revertTimer = setTimeout(() => {
      requestSync(true);
      const now = Date.now();
      if (now - lastRevertNoticeAt > 5000) {
        lastRevertNoticeAt = now;
        notice('Only the host can control playback right now.');
      }
    }, 150);
  }

  function requestSync(force = false) {
    const now = Date.now();
    if (!force && now - lastSyncRequestAt < 1000) return;
    lastSyncRequestAt = now;
    send({ cmd: 'sync_request' });
  }

  function sendHeartbeat() {
    if (!party.inRoom || !party.isHost || !adapter) return;
    if (adapter.isAdPlaying() || buffering) return; // a stalled clock would drag everyone back
    send({
      cmd: 'heartbeat',
      currentTime: adapter.getTime(),
      paused: adapter.isPaused(),
      playbackRate: baseRate,
      sentAt: Date.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Remote commands → player
  // -------------------------------------------------------------------------

  function targetTime(d) {
    const elapsed = Math.min(Math.max((Date.now() - d.sentAt) / 1000, 0), 30);
    return d.paused ? d.currentTime : d.currentTime + elapsed * (d.playbackRate || 1);
  }

  function callPlay() {
    try {
      return Promise.resolve(adapter.play());
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function doPlay(retry = false) {
    if (!adapter.isPaused()) return;
    if (!retry) lastApplied = { action: 'play', at: Date.now(), retries: 0 };
    else lastApplied.at = Date.now();
    expect('play');
    callPlay().catch((err) => {
      dropExpectation('play');
      debug('play() rejected:', err && err.name);
      if (!err || err.name !== 'NotAllowedError') return;
      // Chrome blocks sound until the person clicks the page (e.g. right after a refresh).
      // Play muted so the party stays in sync, and offer an Unmute button.
      if (video && !video.muted) {
        debug('autoplay with sound blocked → playing muted');
        video.muted = true;
        mutedBySync = true;
        expect('play');
        callPlay().then(() => {
          notice('🔇 Chrome blocked the sound until you click the page, so your video is playing muted to stay in sync.', { id: 'unmute_video', label: '🔊 Unmute' });
        }).catch(() => {
          dropExpectation('play');
          video.muted = false;
          mutedBySync = false;
          notice('Chrome blocked playback. Click play on the video once and sync will continue.');
        });
      } else {
        notice('Chrome blocked playback. Click play on the video once and sync will continue.');
      }
    });
  }

  function doPause(retry = false) {
    if (adapter.isPaused()) return;
    if (!retry) lastApplied = { action: 'pause', at: Date.now(), retries: 0 };
    else lastApplied.at = Date.now();
    expect('pause');
    adapter.pause();
  }

  /** "Unmute" clicked in the chat after a muted autoplay. */
  function unmuteVideo() {
    if (!video) return;
    const wasPlaying = !video.paused;
    const unmutedAt = Date.now();
    expect('pause', 800); // Chrome may pause it if unmuting still isn't allowed
    video.muted = false;
    mutedBySync = false;
    setTimeout(() => {
      // Only blame the unmute if nobody paused/played the party in the meantime.
      const remoteSince = lastCommandAt > unmutedAt || lastApplied.at > unmutedAt;
      if (!video || !wasPlaying || !video.paused || remoteSince) {
        dropExpectation('pause');
        return;
      }
      debug('unmute paused the video → back to muted');
      // Still not allowed: go back to muted playback and ask for a click on the video itself.
      video.muted = true;
      mutedBySync = true;
      expect('play');
      callPlay().catch(() => dropExpectation('play'));
      notice('Chrome still wants a click on the video itself: click the player’s own volume/unmute button.');
    }, 400);
  }

  function doSeek(t) {
    expect('seeked', 3000);
    adapter.seek(t);
  }

  function seekIfNeeded(t, threshold) {
    if (Math.abs(adapter.getTime() - t) > threshold) doSeek(t);
  }

  function setRateRemote(r) {
    if (!Number.isFinite(r) || r <= 0) return;
    stopNudge();
    baseRate = r;
    if (Math.abs(adapter.getRate() - r) > 0.001) {
      expect('ratechange');
      adapter.setRate(r);
    }
  }

  function startNudge(drift) {
    if (nudge || !adapter.supportsRateNudge) return;
    const factor = drift > 0 ? 1 - NUDGE_FACTOR : 1 + NUDGE_FACTOR; // ahead → slow down
    const duration = Math.min(NUDGE_MAX_MS, (Math.abs(drift) / NUDGE_FACTOR) * 1000);
    expect('ratechange');
    adapter.setRate(baseRate * factor);
    nudge = { timer: setTimeout(stopNudge, duration) };
  }

  function stopNudge() {
    if (!nudge) return;
    clearTimeout(nudge.timer);
    nudge = null;
    if (adapter && Math.abs(adapter.getRate() - baseRate) > 0.001) {
      expect('ratechange');
      adapter.setRate(baseRate);
    }
  }

  function applyRemotePlayback(d) {
    if (!party.inRoom || !adapter || !d) return;
    debug('remote', d.action, 'paused=' + d.paused, 'at', Number(d.currentTime).toFixed(2));
    if (adapter.isAdPlaying()) {
      adActive = true; // re-sync once the ad finishes
      return;
    }
    clearTimeout(seekTimer); // a remote command wins over a pending local seek broadcast
    lastCommandAt = Date.now();
    markRemote();
    stopNudge();

    const t = targetTime(d);
    switch (d.action) {
      case 'play':
        seekIfNeeded(t, 0.5);
        doPlay();
        break;
      case 'pause':
        doPause();
        seekIfNeeded(d.currentTime, 0.25);
        break;
      case 'seek':
        seekIfNeeded(t, 0.25);
        if (d.paused) doPause();
        else doPlay();
        break;
      case 'rate':
        break;
      default:
        return;
    }
    if (Math.abs(baseRate - d.playbackRate) > 0.001) setRateRemote(d.playbackRate);
  }

  function applyHeartbeat(d) {
    if (!party.inRoom || !adapter || !d) return;
    if (party.isHost) return; // the host is the reference clock
    if (adapter.isAdPlaying()) {
      adActive = true;
      return;
    }
    const forced = !!d.sync;
    if (!forced && d.sentAt < lastCommandAt + HEARTBEAT_GRACE_MS) return; // stale vs. a newer command

    if (Math.abs(baseRate - d.playbackRate) > 0.001) {
      markRemote();
      setRateRemote(d.playbackRate);
    }
    if (d.paused && !adapter.isPaused()) {
      markRemote();
      doPause();
    } else if (!d.paused && adapter.isPaused()) {
      markRemote();
      doPlay();
    }

    if (buffering && !forced) return;
    const t = targetTime(d);
    const drift = adapter.getTime() - t; // > 0: we are ahead
    const abs = Math.abs(drift);
    const hardLimit = forced ? SYNC_SEEK_DRIFT : d.paused ? PAUSED_SEEK_DRIFT : HARD_SEEK_DRIFT;

    if (abs > hardLimit) {
      stopNudge();
      markRemote();
      doSeek(t);
    } else if (!d.paused && abs > SOFT_DRIFT) {
      startNudge(drift);
    }
  }

  // -------------------------------------------------------------------------
  // Party lifecycle
  // -------------------------------------------------------------------------

  function tick() {
    if (!alive) return;
    if (!chrome.runtime || !chrome.runtime.id) {
      shutdown(); // extension was reloaded/removed
      return;
    }
    tickCount++;
    if (!video || !video.isConnected || tickCount % 3 === 0) rescan();

    if (adapter) {
      const ad = adapter.isAdPlaying();
      if (ad) {
        adActive = true;
      } else if (adActive) {
        adActive = false;
        if (!party.isHost) requestSync(true);
        else sendHeartbeat();
      }
    }
    if (IS_TOP && WP.overlay) WP.overlay.ensureAttached();
  }

  // ---------------------------------------------------------------------------
  // Fullscreen takeover (see fs-hook.js): the page goes fullscreen with the player beside the chat
  // ---------------------------------------------------------------------------

  const FS_NS = 'watch-party-fs';

  function onFullscreenRequest(e) {
    if (!party.inRoom) return;
    if (IS_TOP) {
      if (!WP.overlay || !WP.overlay.isMounted()) return;
      e.preventDefault();
      WP.overlay.togglePageFullscreen(e.target);
    } else {
      // A player inside an iframe: the top page fullscreens itself and enlarges this iframe.
      e.preventDefault();
      try { window.top.postMessage({ ns: FS_NS, cmd: 'fullscreen' }, '*'); } catch { /* detached */ }
    }
  }

  /** Top frame: which <iframe> in this document contains the window that sent a message. */
  function iframeFor(source) {
    let w = source;
    try {
      while (w && w.parent !== window) {
        if (w.parent === w) return null;
        w = w.parent;
      }
    } catch {
      return null;
    }
    if (!w) return null;
    for (const f of document.querySelectorAll('iframe, frame')) {
      if (f.contentWindow === w) return f;
    }
    return null;
  }

  function onFrameMessage(e) {
    const d = e.data;
    if (!d || d.ns !== FS_NS || d.cmd !== 'fullscreen' || !party.inRoom || !WP.overlay || !WP.overlay.isMounted()) return;
    const frame = e.source && e.source !== window ? iframeFor(e.source) : null;
    if (frame) WP.overlay.togglePageFullscreen(frame);
  }

  function startPartyMode() {
    document.documentElement.setAttribute('data-wp-party', '');
    document.addEventListener('watchparty:fullscreen', onFullscreenRequest, true);
    if (IS_TOP) window.addEventListener('message', onFrameMessage);
    observer = new MutationObserver(queueRescan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    tickTimer = setInterval(tick, TICK_MS);
    if (IS_TOP) {
      if (WP.invite) WP.invite.hide();
      WP.overlay.mount({
        onSend: (text) => send({ cmd: 'chat', text }),
        onReaction: (emoji) => send({ cmd: 'reaction', emoji }),
        onTyping: (active) => send({ cmd: 'typing', active }),
        onAction: (id) => send({ cmd: id }), // 'call_open' | 'follow_host'
      });
      // Restore the chat after a page change / reload (history lives in the background).
      send({ cmd: 'get_history' }).then((list) => {
        if (Array.isArray(list) && party.inRoom && WP.overlay) WP.overlay.loadHistory(list);
      });
      // Keep the service worker awake/restored and self-heal if our party state went stale.
      keepaliveTimer = setInterval(async () => {
        const s = await send({ cmd: 'keepalive' });
        if (s && typeof s.inRoom === 'boolean') setParty(s);
      }, KEEPALIVE_MS);
    }
    rescan();
  }

  function stopPartyMode() {
    document.documentElement.removeAttribute('data-wp-party');
    document.removeEventListener('watchparty:fullscreen', onFullscreenRequest, true);
    window.removeEventListener('message', onFrameMessage);
    if (observer) observer.disconnect();
    observer = null;
    clearInterval(tickTimer);
    clearInterval(heartbeatTimer);
    clearInterval(keepaliveTimer);
    clearTimeout(rescanTimer);
    clearTimeout(revertTimer);
    tickTimer = heartbeatTimer = keepaliveTimer = rescanTimer = revertTimer = null;
    attach(null);
    reportedArea = 0;
    if (IS_TOP && WP.overlay) WP.overlay.unmount();
  }

  function setParty(state) {
    const prev = party;
    party = state && state.inRoom ? state : { inRoom: false };

    if (party.inRoom && !prev.inRoom) startPartyMode();
    else if (!party.inRoom && prev.inRoom) stopPartyMode();
    if (!party.inRoom) return;

    if (party.isHost && !heartbeatTimer) {
      heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
      if (prev.inRoom && !prev.isHost) sendHeartbeat(); // just promoted
    } else if (!party.isHost && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (IS_TOP) WP.overlay.setState(party);
  }

  function onMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg.cmd !== 'string') return false;
    switch (msg.cmd) {
      case 'ping':
        break;
      case 'state':
        setParty(msg.state);
        break;
      case 'request_status':
        if (party.inRoom) reportStatus(true);
        else send({ cmd: 'get_state' }).then((s) => s && setParty(s));
        break;
      case 'remote_playback':
        applyRemotePlayback(msg.data);
        break;
      case 'remote_heartbeat':
        applyHeartbeat(msg.data);
        break;
      case 'heartbeat_now':
        sendHeartbeat();
        break;
      case 'request_sync':
        if (adapter) requestSync(true);
        break;
      case 'unmute':
        unmuteVideo();
        break;
      case 'chat':
        if (IS_TOP && party.inRoom) WP.overlay.addChat(msg.data);
        break;
      case 'system':
        if (IS_TOP && party.inRoom) WP.overlay.addSystem(msg.text, msg.action);
        break;
      case 'reaction':
        if (IS_TOP && party.inRoom) WP.overlay.addReaction(msg.data);
        break;
      case 'typing':
        if (IS_TOP && party.inRoom) WP.overlay.setTyping(msg.data);
        break;
      default:
        return false;
    }
    // Always answer so the background's sendMessage promise resolves cleanly.
    sendResponse({ ok: true });
    return false;
  }

  function shutdown() {
    if (!alive) return;
    try {
      stopPartyMode();
    } catch { /* ignore */ }
    alive = false;
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch { /* ignore */ }
    // Let a fresh injection (after an extension reload) start cleanly.
    if (globalThis.__watchParty === WP) delete globalThis.__watchParty;
  }

  // -------------------------------------------------------------------------
  // Invite links: https://site/video#watchparty=ABC234 → offer to join
  // -------------------------------------------------------------------------

  const INVITE_RE = /(?:^#|[#&])watchparty=([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6})\b/i;

  async function checkInvite() {
    if (!IS_TOP || !alive || party.inRoom || !WP.invite) return;
    const m = INVITE_RE.exec(location.hash);
    if (!m) return;
    const roomId = m[1].toUpperCase();
    let saved = {};
    try { saved = await chrome.storage.local.get(['nickname', 'avatar']); } catch { /* ignore */ }
    if (party.inRoom) return;
    WP.invite.show({
      roomId,
      nickname: saved.nickname || '',
      onJoin: async (nickname) => {
        if (nickname) chrome.storage.local.set({ nickname }).catch(() => {});
        const res = await send({ cmd: 'join_link', roomId, nickname, avatar: saved.avatar });
        return res || { ok: false, error: 'Extension not responding — reload the page.' };
      },
    });
  }

  chrome.runtime.onMessage.addListener(onMessage);
  send({ cmd: 'hello', top: IS_TOP }).then((s) => {
    if (s && typeof s.inRoom === 'boolean') setParty(s);
    checkInvite();
  });
  if (IS_TOP) window.addEventListener('hashchange', checkInvite);
})();
