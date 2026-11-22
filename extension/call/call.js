'use strict';
/* global ICE_SERVERS */

/**
 * Tandem video call (WebRTC mesh).
 *
 * Runs as an extension page, either inside the chat overlay (iframe) or in its own popup window.
 * - Media flows peer-to-peer; the relay server only forwards offers/answers/ICE candidates.
 * - Only REMOTE participants are shown. Your own camera is never rendered here — a small "Live"
 *   pill tells you it is on — so the limited space goes to your friends' faces.
 * - Who sends the offer is deterministic (smaller member id), so two peers never offer at once.
 */

const MODE = new URLSearchParams(location.search).get('mode') === 'window' ? 'window' : 'frame';
const NS = 'watch-party-call';
const $ = (id) => document.getElementById(id);

let port = null;
let me = null;
let members = [];
let localStream = null;
let micOn = true;
let camOn = true;
let callId = null;
let joined = false;
let starting = false;
let ended = false;
let volume = 1;
let idleTimer = null;
let audioCtx = null;
let serverRejected = false;
let selfView = false; // show my own camera (small preview)
let selfBig = false;
chrome.storage.local.get(['selfView', 'selfBig']).then((r) => {
  selfView = r.selfView === true;
  selfBig = r.selfBig === true;
  render();
}).catch(() => {});
let extraIce = []; // TURN relay servers from the party server
let relayAvailable = false;
const STUCK_MS = 15000; // no media path after this long: explain why instead of "Connecting…" forever
const notConnectedSince = new Map(); // member id -> first time we saw them not connected
let stuckNoticeSent = false;

/** memberId -> { id, pc, remoteCallId, initiator, pending: [], stream, tile, video, analyser } */
const peers = new Map();

// ---------------------------------------------------------------------------
// Background connection
// ---------------------------------------------------------------------------

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'call' });
  } catch {
    showView('ended');
    return;
  }
  port.onMessage.addListener(onBackground);
  port.onDisconnect.addListener(() => {
    port = null;
    // Service worker restarted: reconnect (it restores the call state from storage).
    if (!ended) setTimeout(connectPort, 500);
  });
}

function post(msg) {
  if (port) {
    try { port.postMessage(msg); } catch { /* reconnecting */ }
  }
}

function toParent(msg) {
  if (MODE === 'frame' && window.parent !== window) window.parent.postMessage({ ns: NS, ...msg }, '*');
}

function onBackground(msg) {
  switch (msg.cmd) {
    case 'init':
      setIce(msg.iceServers, msg.relay);
      me = msg.me;
      members = msg.members || [];
      if (typeof msg.mic === 'boolean') micOn = msg.mic;
      if (typeof msg.cam === 'boolean') camOn = msg.cam;
      if (!msg.inRoom) {
        showView('ended');
        return;
      }
      if (joined) {
        post({ cmd: 'join', callId, mic: micOn && hasTrack('audio'), cam: camOn && hasTrack('video') });
        syncPeers();
      } else if (msg.autoJoin) {
        autoStart(!!msg.fresh);
      }
      render();
      break;
    case 'members':
      me = msg.me;
      members = msg.members || [];
      syncPeers();
      render();
      break;
    case 'signal':
      handleSignal(msg.from, msg.data);
      break;
    case 'ice': {
      const hadRelay = relayAvailable;
      setIce(msg.iceServers, msg.relay);
      // Relay just became available: rebuild connections that haven't connected yet (initiator re-offers).
      if (relayAvailable && !hadRelay) {
        for (const peer of [...peers.values()]) {
          if (peer.pc.connectionState !== 'connected' && peer.initiator) closePeer(peer.id);
        }
        syncPeers();
      }
      break;
    }
    case 'permission_granted':
      if (!joined) start();
      break;
    case 'error':
      toast(msg.message || 'Call error');
      break;
    case 'ended':
      endLocal();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Local media
// ---------------------------------------------------------------------------

function hasTrack(kind) {
  return !!(localStream && localStream.getTracks().some((t) => t.kind === kind && t.readyState === 'live'));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms)),
  ]);
}

const VIDEO_CONSTRAINTS = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' };
const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/** Returns a MediaStream, null (join receive-only), or undefined (waiting for the user / permission). */
async function getMedia() {
  try {
    return await withTimeout(navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS }), 20000);
  } catch (err) {
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError' || err.name === 'NotReadableError') {
      // Missing/busy device: try with whatever is available.
      for (const c of [{ audio: AUDIO_CONSTRAINTS }, { video: VIDEO_CONSTRAINTS }]) {
        try {
          const s = await navigator.mediaDevices.getUserMedia(c);
          toast(c.audio ? 'No camera found — joined with microphone only.' : 'No microphone found — joined with camera only.');
          return s;
        } catch { /* try next */ }
      }
      toast('No camera or microphone available — you can still see and hear your friends.');
      return null;
    }
    showSetup(err);
    return undefined;
  }
}

/**
 * Rejoining after a page reload: only switch the camera on by itself if Chrome already remembers the
 * permission. Otherwise a permission prompt would pop up unasked (and Chrome leaves fullscreen
 * while a prompt is open), so ask with a button instead.
 */
async function autoStart(fresh) {
  if (!fresh) {
    const state = async (name) => {
      try { return (await navigator.permissions.query({ name })).state; } catch { return 'granted'; }
    };
    const [cam, mic] = await Promise.all([state('camera'), state('microphone')]);
    if (cam === 'prompt' || mic === 'prompt') {
      $('setup-title').textContent = 'Rejoin the video call';
      $('setup-text').textContent = 'The page was reloaded. Click to turn your camera and mic back on.';
      $('setup-rejoin').hidden = false;
      $('setup-allow').hidden = true;
      $('setup-window').hidden = true;
      showView('setup');
      return;
    }
  }
  start();
}

function showSetup(err) {
  $('setup-rejoin').hidden = true;
  const blockedBySite = MODE === 'frame' && /permissions policy|not allowed in this document/i.test(String(err && err.message));
  $('setup-title').textContent = blockedBySite ? 'This site blocks cameras in pages' : 'Camera & mic access needed';
  $('setup-text').innerHTML = '';
  $('setup-text').append(
    blockedBySite
      ? 'Open the call in its own small window instead — it stays in sync with the party.'
      : 'Chrome needs your permission once. Click below, choose “Allow”, then come back here.',
  );
  $('setup-allow').hidden = blockedBySite;
  $('setup-window').hidden = MODE === 'window';
  showView('setup');
}

async function start(receiveOnly = false) {
  stuckNoticeSent = false;
  notConnectedSince.clear();
  if (starting || joined || ended) return;
  starting = true;
  showView('connecting');
  const stream = receiveOnly ? null : await getMedia();
  starting = false;
  if (stream === undefined) return; // setup card shown
  localStream = stream;
  callId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  joined = true;
  applyTrackStates();
  post({ cmd: 'join', callId, mic: micOn && hasTrack('audio'), cam: camOn && hasTrack('video') });
  syncPeers();
  render();
  // If the server never lists us as "in call", it is an old server that doesn't support calls.
  setTimeout(() => {
    const self = memberById(me);
    if (joined && !ended && !(self && self.inCall)) {
      serverRejected = true;
      render();
    }
  }, 6000);
}

function applyTrackStates() {
  if (!localStream) return;
  for (const t of localStream.getAudioTracks()) t.enabled = micOn;
  for (const t of localStream.getVideoTracks()) t.enabled = camOn;
}

function setMic(on) {
  micOn = on;
  applyTrackStates();
  post({ cmd: 'state', mic: micOn && hasTrack('audio'), cam: camOn && hasTrack('video') });
  render();
}

function setCam(on) {
  camOn = on;
  applyTrackStates();
  post({ cmd: 'state', mic: micOn && hasTrack('audio'), cam: camOn && hasTrack('video') });
  render();
}

// ---------------------------------------------------------------------------
// Peer connections
// ---------------------------------------------------------------------------

function memberById(id) {
  return members.find((m) => m.id === id) || null;
}

function sendSignal(to, data) {
  post({ cmd: 'signal', to, data: { ...data, callId } });
}

function syncPeers() {
  if (!joined || !me) return;
  const others = members.filter((m) => m.inCall && m.id !== me && m.callId);
  const ids = new Set(others.map((m) => m.id));
  for (const id of [...peers.keys()]) {
    if (!ids.has(id)) closePeer(id);
  }
  for (const m of others) {
    const existing = peers.get(m.id);
    if (existing && existing.remoteCallId && existing.remoteCallId !== m.callId) closePeer(m.id); // they rejoined
    if (!peers.has(m.id) && me < m.id) {
      createPeer(m, true).catch((err) => console.warn('[WatchParty call] offer failed', err));
    }
  }
}

function setIce(list, relay) {
  extraIce = Array.isArray(list) ? list : [];
  relayAvailable = !!relay;
}

function iceConfig() {
  const base = typeof ICE_SERVERS !== 'undefined' ? ICE_SERVERS : [];
  return { iceServers: [...base, ...extraIce] };
}

function newPeer(m, initiator) {
  const pc = new RTCPeerConnection(iceConfig());
  const peer = {
    id: m.id, pc, remoteCallId: m.callId, initiator, pending: [], stream: new MediaStream(), tile: null, video: null, analyser: null,
    localTypes: new Set(), remoteTypes: new Set(),
  };
  peers.set(m.id, peer);
  if (!notConnectedSince.has(m.id)) notConnectedSince.set(m.id, Date.now());

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      if (e.candidate.type) peer.localTypes.add(e.candidate.type);
      sendSignal(m.id, { type: 'candidate', candidate: e.candidate.toJSON() });
    }
  };
  pc.ontrack = (e) => {
    if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
    if (e.track.kind === 'audio') watchSpeaking(peer, e.track);
    ensureTile(peer);
    attachStream(peer);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      notConnectedSince.delete(m.id);
      logRoute(peer);
    }
    render();
    if (pc.connectionState === 'failed' && peers.get(m.id) === peer) {
      // Rebuild the connection; the initiator re-offers.
      closePeer(m.id);
      if (initiator) setTimeout(() => syncPeers(), 1000);
    }
  };
  return peer;
}

function addLocalTracks(pc) {
  if (!localStream) return;
  for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
}

async function createPeer(m, initiator) {
  const peer = newPeer(m, initiator);
  addLocalTracks(peer.pc);
  // Always negotiate audio + video so we can receive even if we have no camera/mic.
  const kinds = new Set(peer.pc.getTransceivers().map((t) => t.receiver.track.kind));
  if (!kinds.has('audio')) peer.pc.addTransceiver('audio', { direction: 'recvonly' });
  if (!kinds.has('video')) peer.pc.addTransceiver('video', { direction: 'recvonly' });
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  sendSignal(m.id, { type: 'offer', sdp: peer.pc.localDescription.sdp });
  render();
  return peer;
}

async function flushCandidates(peer) {
  const list = peer.pending.splice(0);
  for (const c of list) {
    try { await peer.pc.addIceCandidate(c); } catch { /* stale */ }
  }
}

async function handleSignal(from, data) {
  if (!joined || !data) return;
  const m = memberById(from);
  if (!m || !m.inCall) return;
  if (m.callId && data.callId && m.callId !== data.callId) return; // from an older session of theirs
  let peer = peers.get(from);
  try {
    if (data.type === 'offer') {
      if (peer) closePeer(from);
      peer = newPeer(m, false);
      peer.remoteCallId = data.callId || m.callId;
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      addLocalTracks(peer.pc); // after the offer, so tracks reuse the offered transceivers
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      sendSignal(from, { type: 'answer', sdp: peer.pc.localDescription.sdp });
      await flushCandidates(peer);
    } else if (data.type === 'answer') {
      if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      await flushCandidates(peer);
    } else if (data.type === 'candidate') {
      if (!peer) return;
      const typ = / typ (\w+)/.exec((data.candidate && data.candidate.candidate) || '');
      if (typ) peer.remoteTypes.add(typ[1]);
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
      else peer.pending.push(data.candidate);
    }
  } catch (err) {
    console.warn('[WatchParty call] signal error', data.type, err);
  }
  render();
}

/** Which path the media took (direct / via relay), for the console. */
async function logRoute(peer) {
  try {
    const stats = await peer.pc.getStats();
    let pair = null;
    stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    const local = pair && stats.get(pair.localCandidateId);
    const remote = pair && stats.get(pair.remoteCandidateId);
    console.info(`[WatchParty call] connected to ${peer.id}: ${local ? local.candidateType : '?'} ↔ ${remote ? remote.candidateType : '?'}${local && local.candidateType === 'relay' ? ' (via TURN relay)' : ' (direct)'}`);
  } catch { /* ignore */ }
}

/** Why a peer has no media path yet, in plain words (null = still trying normally). */
function stuckReason(peer) {
  const since = notConnectedSince.get(peer.id);
  if (!since || Date.now() - since < STUCK_MS || peer.pc.connectionState === 'connected') return null;
  if (!relayAvailable) return 'norelay';
  return peer.localTypes.has('relay') ? 'relayfail' : 'relayblocked';
}

const STUCK_TEXT = {
  norelay: 'Can’t connect: your networks block direct video. The host needs to set up a relay (TURN).',
  relayblocked: 'Can’t reach the video relay from this network. Retrying…',
  relayfail: 'Still connecting through the relay…',
};

const STUCK_NOTICE = {
  norelay: '📹 Video couldn’t connect: your networks block direct video. Host: run ./scripts/setup-turn.sh once, restart the server, then rejoin the call.',
  relayblocked: '📹 Video couldn’t reach the TURN relay. Check the relay settings (./scripts/setup-turn.sh) or try another network.',
  relayfail: '📹 Video is having trouble connecting even through the relay. Try leaving and rejoining the call.',
};

setInterval(() => {
  if (!joined || !peers.size) return;
  let reason = null;
  for (const peer of peers.values()) reason = reason || stuckReason(peer);
  if (reason && !stuckNoticeSent) {
    stuckNoticeSent = true;
    post({ cmd: 'notice', text: STUCK_NOTICE[reason] });
    const p = [...peers.values()][0];
    console.warn('[WatchParty call] no media path', reason, { local: [...p.localTypes], remote: [...p.remoteTypes], relayAvailable });
  }
  if (reason) render();
}, 2000);

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peers.delete(id);
  const m = memberById(id);
  if (!m || !m.inCall) notConnectedSince.delete(id);
  try { peer.pc.close(); } catch { /* ignore */ }
  if (peer.tile) peer.tile.remove();
}

// ---------------------------------------------------------------------------
// Speaking indicator
// ---------------------------------------------------------------------------

function watchSpeaking(peer, track) {
  try {
    audioCtx = audioCtx || new AudioContext();
    const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    peer.analyser = analyser;
  } catch { /* optional */ }
}

setInterval(() => {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  const buf = new Uint8Array(256);
  for (const peer of peers.values()) {
    if (!peer.analyser || !peer.tile) continue;
    peer.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) * (v - 128);
    const rms = Math.sqrt(sum / buf.length);
    const m = memberById(peer.id);
    peer.tile.classList.toggle('speaking', rms > 6 && !!(m && m.micOn));
  }
}, 200);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function showView(name) {
  for (const id of ['empty', 'connecting', 'setup', 'ended']) $(id).hidden = id !== name;
  $('controls').hidden = name === 'setup' || name === 'ended' || name === 'connecting';
}

function ensureTile(peer) {
  if (peer.tile) return peer.tile;
  const tile = document.createElement('div');
  tile.className = 'tile';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  const ph = document.createElement('div');
  ph.className = 'placeholder';
  const av = document.createElement('div');
  av.className = 'avatar';
  const pt = document.createElement('div');
  pt.className = 'ptext';
  ph.append(av, pt);
  const label = document.createElement('div');
  label.className = 'label';
  const status = document.createElement('div');
  status.className = 'status';
  tile.append(video, ph, label, status);
  tile.addEventListener('dblclick', () => tile.classList.toggle('fit'));
  peer.tile = tile;
  peer.video = video;
  $('tiles').append(tile);
  return tile;
}

function attachStream(peer) {
  if (!peer.video) return;
  if (peer.video.srcObject !== peer.stream) peer.video.srcObject = peer.stream;
  peer.video.volume = volume;
  const p = peer.video.play();
  if (p && p.catch) {
    p.catch((err) => {
      if (err && err.name === 'NotAllowedError') $('unmute-audio').hidden = false;
    });
  }
}

/** Pick the column count that gives the biggest 16:9 tiles for the available space. */
function bestColumns(n, w, h) {
  let best = 1;
  let bestArea = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = w / cols;
    const th = h / rows;
    const area = Math.min(tw, (th * 16) / 9) * Math.min(th, (tw * 9) / 16);
    if (area > bestArea) {
      bestArea = area;
      best = cols;
    }
  }
  return best;
}

function render() {
  if (ended) return;
  if (!joined) {
    if ($('setup').hidden && !starting) showView('connecting');
  } else {
    const list = [...peers.values()];
    const waiting = members.filter((m) => m.inCall && m.id !== me).length === 0;
    const self = memberById(me);
    if (self && self.inCall) serverRejected = false;
    showView(waiting && list.length === 0 ? 'empty' : null);
    $('empty-title').textContent = serverRejected ? 'The call couldn’t connect' : 'You’re in the call';
    $('empty-sub').textContent = serverRejected
      ? 'The party server is running an old version without video calls. The host should press Ctrl+C in the server window and run ./scripts/start-server.sh again.'
      : 'Waiting for friends to join… They can tap “Join call” in the chat.';
    $('controls').hidden = false;

    const n = Math.max(list.length, 1);
    const cols = bestColumns(n, window.innerWidth, window.innerHeight);
    $('tiles').style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

    for (const peer of list) {
      const m = memberById(peer.id) || { nickname: 'Friend', avatar: '🙂', micOn: true, camOn: true };
      const tile = ensureTile(peer);
      const camOff = m.camOn === false || !peer.stream.getVideoTracks().length;
      tile.querySelector('.placeholder').hidden = !camOff;
      tile.querySelector('.avatar').textContent = m.avatar || '🙂';
      tile.querySelector('.ptext').textContent = m.camOn === false ? 'Camera off' : 'Connecting video…';
      tile.querySelector('.label').textContent = `${m.micOn === false ? '🔇 ' : ''}${m.nickname}`;
      const state = peer.pc.connectionState;
      const status = tile.querySelector('.status');
      const stuck = stuckReason(peer);
      status.textContent = state === 'connected' ? '' : stuck ? STUCK_TEXT[stuck] : state === 'failed' ? 'Connection failed — retrying…' : state === 'disconnected' ? 'Reconnecting…' : 'Connecting…';
      status.classList.toggle('stuck', !!stuck);
      status.hidden = !status.textContent;
    }
    toParent({ cmd: 'count', n: list.length });
  }

  // Controls
  const hasA = hasTrack('audio');
  const hasV = hasTrack('video');
  $('btn-mic').textContent = micOn && hasA ? '🎤' : '🔇';
  $('btn-mic').classList.toggle('off', !(micOn && hasA));
  $('btn-mic').title = !hasA ? 'No microphone' : micOn ? 'Mute microphone' : 'Unmute microphone';
  $('btn-mic').disabled = !hasA;
  $('btn-cam').textContent = '📷';
  $('btn-cam').classList.toggle('off', !(camOn && hasV));
  $('btn-cam').title = !hasV ? 'No camera' : camOn ? 'Turn camera off' : 'Turn camera on';
  $('btn-cam').disabled = !hasV;

  $('live').hidden = !joined;
  $('live').classList.toggle('off', !(camOn && hasV));
  $('live-text').textContent = camOn && hasV ? 'You’re live' : hasA && micOn ? 'Audio only' : 'Camera off';

  // Self-view
  const showSelf = selfView && joined && camOn && hasV;
  const selfBox = $('self');
  selfBox.hidden = !showSelf;
  selfBox.classList.toggle('big', selfBig);
  const sv = $('self-video');
  if (showSelf && sv.srcObject !== localStream) {
    sv.srcObject = localStream;
    sv.play().catch(() => {});
  } else if (!showSelf && sv.srcObject) {
    sv.srcObject = null;
  }
  if (showSelf) $('live').hidden = true;
  $('btn-self').classList.toggle('on', selfView);
  $('btn-self').title = selfView ? 'Hide my video' : 'Show my video';
  $('btn-self').disabled = !hasV;

  $('btn-layout').hidden = MODE === 'window';
  $('btn-window').textContent = MODE === 'window' ? '↩' : '⧉';
  $('btn-window').title = MODE === 'window' ? 'Move call back into the page' : 'Open in a separate window';
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
}

function endLocal() {
  ended = true;
  for (const id of [...peers.keys()]) closePeer(id);
  if (localStream) for (const t of localStream.getTracks()) t.stop();
  localStream = null;
  joined = false;
  showView('ended');
  $('live').hidden = true;
  if (MODE === 'window') setTimeout(() => window.close(), 400);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

$('btn-mic').addEventListener('click', () => setMic(!micOn));
$('btn-cam').addEventListener('click', () => setCam(!camOn));
$('btn-self').addEventListener('click', () => {
  selfView = !selfView;
  chrome.storage.local.set({ selfView }).catch(() => {});
  render();
});
$('self').addEventListener('click', () => {
  selfBig = !selfBig;
  chrome.storage.local.set({ selfBig }).catch(() => {});
  render();
});
$('setup-rejoin').addEventListener('click', () => start());
$('btn-leave').addEventListener('click', () => {
  post({ cmd: 'leave' });
  endLocal();
});
$('btn-layout').addEventListener('click', () => toParent({ cmd: 'toggle_layout' }));
$('btn-window').addEventListener('click', () => post({ cmd: MODE === 'window' ? 'use_frame' : 'open_window' }));
$('volume').addEventListener('input', (e) => {
  volume = Number(e.target.value) / 100;
  for (const p of peers.values()) if (p.video) p.video.volume = volume;
});
$('unmute-audio').addEventListener('click', () => {
  $('unmute-audio').hidden = true;
  for (const p of peers.values()) if (p.video) p.video.play().catch(() => {});
  if (audioCtx) audioCtx.resume().catch(() => {});
});
$('setup-allow').addEventListener('click', () => {
  post({ cmd: 'permission' });
  $('setup-text').textContent = 'Approve camera & mic in the tab that just opened, then come back — the call starts automatically.';
});
$('setup-window').addEventListener('click', () => post({ cmd: 'open_window' }));
$('setup-nocam').addEventListener('click', () => start(true));

// Auto-hide controls while friends are on screen.
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (peers.size > 0) document.body.classList.add('idle');
  }, 2500);
}
for (const ev of ['mousemove', 'mousedown', 'touchstart', 'keydown']) document.addEventListener(ev, wake, { passive: true });
document.addEventListener('mouseleave', () => {
  if (peers.size > 0) document.body.classList.add('idle');
});
window.addEventListener('resize', render);
window.addEventListener('pagehide', () => {
  for (const id of [...peers.keys()]) closePeer(id);
  if (localStream) for (const t of localStream.getTracks()) t.stop();
});

showView('connecting');
render();
wake();
connectPort();
