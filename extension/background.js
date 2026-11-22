'use strict';

/**
 * Tandem background service worker.
 *
 * Owns the single WebSocket connection to the relay server and routes messages between
 * the server, the popup, and the party tab's content scripts.
 *
 * Time handling: the server stamps pongs with its clock, so we estimate `clockOffset`
 * (serverTime - localTime). Outgoing `sentAt` values are converted to server time and incoming
 * ones back to local time, so content scripts only ever deal with their own Date.now().
 */

importScripts('config.js'); /* global SERVER_URL, PARTY_KEY */
/* Also handles: emoji reactions, typing indicator, avatars, invite links, follow-the-host navigation,
   and the WebRTC video call (call/call.html talks to us over a long-lived port named "call"). */

const VERSION = chrome.runtime.getManifest().version;
const CONTENT_FILES = chrome.runtime.getManifest().content_scripts[0].js;

const PING_INTERVAL_MS = 20_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CALL_PORT_GRACE_MS = 10_000; // call UI may reload (fullscreen fallback, page reload) without leaving
const NAVIGATE_DEBOUNCE_MS = 2_000;
const FOLLOW_QUIET_MS = 6_000; // while auto-following, ignore redirects on the way (cleared on arrival)
const LOG_MAX = 150; // chat + system messages kept so the sidebar survives page changes

// Persisted in chrome.storage.session so it survives service-worker restarts.
const session = {
  roomId: null,
  clientId: null,
  isHost: false,
  nickname: '',
  avatar: '🙂',
  tabId: null,
  resumeToken: null,
  hostOnlyControl: false,
  members: [],
  hostId: null,
  // Host's current page, so guests can follow to the next video/episode.
  currentUrl: null,
  currentTitle: '',
  currentFrom: null, // member who picked the current video
  autoFollow: true, // follow video changes automatically (popup toggle)
  iceServers: [], // TURN relay servers handed out by the party server
  relay: false,
  // Video call
  callUiOpen: false, // the user wants the call UI open (persisted so it survives page reloads)
  callMode: 'frame', // 'frame' = inside the page overlay, 'window' = separate popup window
  callId: null,
  callWindowId: null,
  micOn: true,
  camOn: true,
};

let status = 'idle'; // idle | connecting | connected | reconnecting
let warning = null;
let lastError = null;

let socket = null;
let wantConnection = false;

// Party server: the popup's "Server settings" win over the defaults baked into config.js.
let serverUrl = typeof SERVER_URL === 'string' ? SERVER_URL.trim() : '';
let partyKey = typeof PARTY_KEY === 'string' ? PARTY_KEY.trim() : '';
const KEY_REJECTED = 4401; // close code the server uses for a missing/wrong party key

function serverSocketUrl() {
  if (!partyKey) return serverUrl;
  return `${serverUrl}${serverUrl.includes('?') ? '&' : '?'}key=${encodeURIComponent(partyKey)}`;
}
let pingTimer = null;
let reconnectTimer = null;
let backoffMs = BACKOFF_MIN_MS;

/** In-flight create/join request from the popup. */
let pending = null;

let clockOffset = 0;
const offsetSamples = [];

/** frameId -> video area, for the party tab. The frame with the biggest video controls playback. */
const frames = new Map();
let videoFrameId = null;

/** Connected call UIs (iframe in the party tab or the popup call window). */
const callPorts = new Set();
let callLeaveTimer = null;
let navigateTimer = null;
let followingUntil = 0;
let lastWanderNotice = '';
let chatLog = [];
let logTimer = null;
let suppressWindowLeave = false;

// ---------------------------------------------------------------------------
// Startup / persistence
// ---------------------------------------------------------------------------

const ready = (async () => {
  try {
    const { wp, wpLog } = await chrome.storage.session.get(['wp', 'wpLog']);
    if (wp) Object.assign(session, wp);
    if (Array.isArray(wpLog)) chatLog = wpLog;
    const { autoFollow, server } = await chrome.storage.local.get(['autoFollow', 'server']);
    if (typeof autoFollow === 'boolean') session.autoFollow = autoFollow;
    if (server && typeof server.url === 'string' && server.url.trim()) serverUrl = server.url.trim();
    if (server && typeof server.key === 'string' && server.url && server.url.trim()) partyKey = server.key.trim();
  } catch (err) {
    console.warn('[WatchParty] could not restore session', err);
  }
  if (session.roomId) {
    wantConnection = true;
    connect();
    // Ask frames in the party tab to re-announce their videos (our frame map was lost).
    sendToTab({ cmd: 'request_status' });
  }
  updateBadge();
})();

function persist() {
  chrome.storage.session.set({ wp: { ...session } }).catch(() => {});
}

/** Chat history (kept here so the sidebar can be restored after the page reloads / changes video). */
function logEntry(entry) {
  if (!session.roomId) return;
  chatLog.push(entry);
  if (chatLog.length > LOG_MAX) chatLog.splice(0, chatLog.length - LOG_MAX);
  clearTimeout(logTimer);
  logTimer = setTimeout(() => chrome.storage.session.set({ wpLog: chatLog }).catch(() => {}), 300);
}

function clearLog() {
  chatLog = [];
  clearTimeout(logTimer);
  chrome.storage.session.set({ wpLog: [] }).catch(() => {});
}

function updateBadge() {
  const text = session.roomId ? String(session.members.length || 1) : '';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: status === 'connected' ? '#E5484D' : '#8B8D98' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function describePlayback(who, d) {
  switch (d.action) {
    case 'play': return `${who} played at ${formatTime(d.currentTime)}`;
    case 'pause': return `${who} paused at ${formatTime(d.currentTime)}`;
    case 'seek': return `${who} jumped to ${formatTime(d.currentTime)}`;
    case 'rate': return `${who} set speed to ${d.playbackRate}×`;
    default: return null;
  }
}

const toServerTime = (t) => t + clockOffset;
const toLocalTime = (t) => t - clockOffset;

function me() {
  return session.members.find((m) => m.id === session.clientId) || null;
}

function callCount() {
  return session.members.filter((m) => m.inCall).length;
}

function viewState() {
  const self = me();
  return {
    status,
    inRoom: !!session.roomId,
    roomId: session.roomId,
    clientId: session.clientId,
    isHost: session.isHost,
    nickname: session.nickname,
    avatar: session.avatar,
    callUiOpen: session.callUiOpen,
    inCall: !!(self && self.inCall),
    callCount: callCount(),
    currentUrl: session.currentUrl,
    currentTitle: session.currentTitle,
    autoFollow: session.autoFollow,
    members: session.members,
    hostId: session.hostId,
    hostOnlyControl: session.hostOnlyControl,
    tabId: session.tabId,
    warning,
    lastError,
    serverUrl,
    hasPartyKey: !!partyKey,
    version: VERSION,
  };
}

function partyStateFor(tabId) {
  if (!session.roomId || tabId !== session.tabId) return { inRoom: false };
  return {
    inRoom: true,
    roomId: session.roomId,
    clientId: session.clientId,
    isHost: session.isHost,
    hostOnlyControl: session.hostOnlyControl,
    canControl: session.isHost || !session.hostOnlyControl,
    nickname: session.nickname,
    avatar: session.avatar,
    members: session.members,
    hostId: session.hostId,
    connected: status === 'connected',
    callUiOpen: session.callUiOpen,
    callMode: session.callMode,
    callCount: callCount(),
  };
}

function notifyPopup() {
  chrome.runtime.sendMessage({ cmd: 'state_changed', state: viewState() }).catch(() => {});
}

/** Send to the party tab. With frameId → that frame only; without → every frame. */
function sendToTab(msg, frameId) {
  if (session.tabId == null) return Promise.resolve();
  const opts = frameId != null ? { frameId } : undefined;
  return chrome.tabs.sendMessage(session.tabId, msg, opts).catch(() => {
    if (frameId != null && frameId !== 0 && frames.has(frameId)) {
      frames.delete(frameId); // frame navigated away or was removed
      pickVideoFrame();
    }
  });
}

function notifyTab() {
  sendToTab({ cmd: 'state', state: partyStateFor(session.tabId) });
}

/** System message for the chat overlay (lives in the top frame). `action` adds a button: { id, label }. */
function systemToTab(text, action) {
  if (!text) return;
  logEntry({ type: 'system', text, at: Date.now() });
  sendToTab({ cmd: 'system', text, action: action || null }, 0);
}

function postToCall(msg) {
  for (const port of callPorts) {
    try { port.postMessage(msg); } catch { /* port closed */ }
  }
}

function toVideoFrame(msg) {
  return sendToTab(msg, videoFrameId ?? undefined);
}

function pickVideoFrame() {
  let best = null;
  let bestArea = 0;
  for (const [id, area] of frames) {
    if (area > bestArea) {
      best = id;
      bestArea = area;
    }
  }
  videoFrameId = best;
}

function setStatus(next) {
  if (status === next) return;
  status = next;
  updateBadge();
  notifyPopup();
  if (session.roomId) notifyTab();
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function sendServer(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function rejoinMessage() {
  return {
    type: 'join_room',
    roomId: session.roomId,
    nickname: session.nickname,
    avatar: session.avatar,
    version: VERSION,
    rejoin: true,
    wasHost: session.isHost,
    resumeToken: session.resumeToken,
    hostOnlyControl: session.isHost && session.hostOnlyControl,
  };
}

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  setStatus(session.roomId ? 'reconnecting' : 'connecting');

  if (!serverUrl) {
    const msg = 'No party server set yet. Open "Server settings" in this popup and enter the address your host gave you.';
    if (!failPending(msg)) lastError = msg;
    wantConnection = false;
    setStatus('idle');
    notifyPopup();
    return;
  }

  let sock;
  try {
    sock = new WebSocket(serverSocketUrl());
  } catch (err) {
    const msg = `"${serverUrl}" is not a valid server address. It should look like wss://your-server.example.com`;
    if (!failPending(msg)) lastError = msg;
    wantConnection = false;
    setStatus('idle');
    notifyPopup();
    return;
  }
  socket = sock;

  sock.onopen = () => {
    if (socket !== sock) return;
    backoffMs = BACKOFF_MIN_MS;
    setStatus('connected');
    startPing();
    if (pending) sendServer(pending.message);
    else if (session.roomId) sendServer(rejoinMessage());
  };

  sock.onmessage = (ev) => {
    if (socket !== sock) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg && typeof msg.type === 'string') handleServerMessage(msg);
  };

  sock.onclose = (ev) => {
    if (socket !== sock) return;
    socket = null;
    stopPing();
    if (ev && ev.code === KEY_REJECTED) {
      // Retrying with the same key can't work: stop and tell the user what to fix.
      const msg = partyKey
        ? 'The party server rejected your party key. Check it in "Server settings" (ask the host for the right one).'
        : 'This party server needs a party key. Ask the host for it and enter it in "Server settings".';
      if (!failPending(msg)) lastError = msg;
      wantConnection = false;
      setStatus('idle');
      notifyPopup();
      return;
    }
    if (wantConnection) {
      setStatus('reconnecting');
      scheduleReconnect();
    } else {
      setStatus('idle');
    }
  };

  sock.onerror = () => { /* onclose follows */ };
}

function scheduleReconnect() {
  if (!wantConnection) return;
  clearTimeout(reconnectTimer);
  const delay = backoffMs + Math.random() * 250;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  reconnectTimer = setTimeout(connect, delay);
}

function closeSocket() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopPing();
  const sock = socket;
  socket = null;
  if (sock) {
    try { sock.close(1000, 'leave'); } catch { /* ignore */ }
  }
}

function sendPing() {
  sendServer({ type: 'ping', t: Date.now() });
}

function startPing() {
  stopPing();
  // A quick burst for an initial clock-offset estimate, then the keep-alive heartbeat.
  sendPing();
  setTimeout(sendPing, 300);
  setTimeout(sendPing, 700);
  pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
}

function stopPing() {
  clearInterval(pingTimer);
  pingTimer = null;
}

function onPong(msg) {
  if (typeof msg.t !== 'number' || typeof msg.serverTime !== 'number') return;
  const now = Date.now();
  const rtt = now - msg.t;
  if (rtt < 0 || rtt > 30_000) return;
  offsetSamples.push({ rtt, offset: msg.serverTime + rtt / 2 - now });
  if (offsetSamples.length > 8) offsetSamples.shift();
  // The lowest-RTT sample is the most trustworthy.
  clockOffset = offsetSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
}

// ---------------------------------------------------------------------------
// Server → extension
// ---------------------------------------------------------------------------

function memberName(id) {
  const m = session.members.find((x) => x.id === id);
  return m ? m.nickname : 'Someone';
}

function onJoined(msg, created) {
  const req = pending;
  if (req) {
    clearTimeout(req.timer);
    pending = null;
    session.tabId = req.tabId;
    frames.clear();
    videoFrameId = null;
  }
  Object.assign(session, {
    roomId: msg.roomId,
    clientId: msg.clientId,
    isHost: !!msg.isHost,
    resumeToken: msg.resumeToken || null,
    hostOnlyControl: !!(msg.settings && msg.settings.hostOnlyControl),
    members: Array.isArray(msg.members) ? msg.members : [],
    hostId: msg.hostId || (msg.isHost ? msg.clientId : null),
  });
  if (msg.currentUrl) {
    session.currentUrl = msg.currentUrl;
    session.currentTitle = msg.currentTitle || '';
    session.currentFrom = msg.currentFrom || null;
  } else if (req) {
    session.currentUrl = null;
    session.currentTitle = '';
    session.currentFrom = null;
  }
  lastError = null;
  checkServerVersion(msg.serverVersion);
  persist();
  updateBadge();
  notifyPopup();
  notifyTab();

  if (req) {
    req.resolve({ ok: true });
    systemToTab(created
      ? `Party ${msg.roomId} started. Share the invite with your friends!`
      : `You joined party ${msg.roomId}.`);
    if (session.currentUrl) joinPartyVideo();
    else scheduleNavigate(0); // first one here: our page becomes the party's video
  } else {
    systemToTab('Reconnected to the party.');
    if (!session.isHost) toVideoFrame({ cmd: 'request_sync' });
    else if (!msg.currentUrl) scheduleNavigate(0); // server restarted: tell it where we are again
    // Server forgot our call membership (restart) or we resumed: re-announce. Media is peer-to-peer
    // and usually survived, so keeping the same callId lets peers keep their connection.
    if (session.callUiOpen && session.callId) {
      sendServer({ type: 'call_join', callId: session.callId, mic: session.micOn, cam: session.camOn });
    }
  }
  postToCall({ cmd: 'members', me: session.clientId, members: session.members });
}

// Oldest server this extension works with. Raise it only when the server protocol changes
// (so extension-only updates don't ask the host to restart the server).
const MIN_SERVER_VERSION = '1.5.0';

/** The server must support everything this extension uses, or newer features silently fail. */
function checkServerVersion(serverVersion) {
  const mm = (v) => (/^(\d+)\.(\d+)/.exec(v || '') || []).slice(1).map(Number);
  const [sMaj, sMin] = mm(serverVersion);
  const [eMaj, eMin] = mm(MIN_SERVER_VERSION);
  const outdated = !serverVersion || sMaj < eMaj || (sMaj === eMaj && sMin < eMin);
  if (!outdated) return;
  const text = `The party server is outdated (${serverVersion || 'old version'}, extension ${VERSION}). `
    + 'The host must restart it: press Ctrl+C in the server window, then run ./scripts/start-server.sh';
  if (warning !== text) {
    warning = text;
    setTimeout(() => systemToTab(`⚠️ ${text}`), 300);
  }
}

function onMemberUpdate(msg) {
  if (!session.roomId || !Array.isArray(msg.members)) return;
  const before = new Map(session.members.map((m) => [m.id, m]));
  const after = new Map(msg.members.map((m) => [m.id, m]));

  for (const m of msg.members) {
    if (m.id === session.clientId) continue;
    const prev = before.get(m.id);
    if (!prev) systemToTab(`${m.nickname} joined`);
    else if (prev.connected && !m.connected) systemToTab(`${m.nickname} lost connection…`);
    else if (!prev.connected && m.connected) systemToTab(`${m.nickname} is back`);
  }
  for (const m of session.members) {
    if (m.id !== session.clientId && !after.has(m.id)) systemToTab(`${m.nickname} left`);
  }
  for (const m of msg.members) {
    if (m.id === session.clientId) continue;
    const prev = before.get(m.id);
    const wasInCall = !!(prev && prev.inCall);
    if (m.inCall && !wasInCall) {
      systemToTab(`📹 ${m.nickname} joined the video call`, session.callUiOpen ? null : { id: 'call_open', label: 'Join call' });
    } else if (!m.inCall && wasInCall && after.has(m.id)) {
      systemToTab(`${m.nickname} left the video call`);
    }
    if (prev && prev.nickname !== m.nickname) systemToTab(`${prev.nickname} is now ${m.nickname}`);
  }
  if (session.hostId && msg.hostId !== session.hostId) {
    const host = after.get(msg.hostId);
    systemToTab(msg.hostId === session.clientId ? 'You are now the host.' : `${host ? host.nickname : 'Someone'} is now the host.`);
  }
  const hostOnly = !!(msg.settings && msg.settings.hostOnlyControl);
  if (hostOnly !== session.hostOnlyControl) {
    systemToTab(hostOnly ? 'Only the host can control playback now.' : 'Everyone can control playback now.');
  }

  Object.assign(session, {
    members: msg.members,
    hostId: msg.hostId,
    isHost: msg.hostId === session.clientId,
    hostOnlyControl: hostOnly,
  });
  persist();
  updateBadge();
  notifyPopup();
  notifyTab();
  postToCall({ cmd: 'members', me: session.clientId, members: session.members });
}

function failPending(error) {
  const req = pending;
  if (!req) return false;
  clearTimeout(req.timer);
  pending = null;
  if (!session.roomId) {
    wantConnection = false;
    closeSocket();
    setStatus('idle');
  }
  req.resolve({ ok: false, error });
  return true;
}

function onServerError(msg) {
  const { code, message } = msg;
  switch (code) {
    case 'VERSION_MISMATCH':
      warning = message;
      notifyPopup();
      systemToTab(message);
      return;
    case 'NOT_ALLOWED':
      if (msg.context === 'navigate') {
        offerFollow(true);
        return;
      }
      if (msg.context === 'playback') {
        systemToTab('Only the host can control playback.');
        sendServer({ type: 'sync_request' }); // snap back to the host's position
      } else {
        systemToTab(message);
      }
      return;
    case 'RATE_LIMITED':
      systemToTab('Slow down — you are sending messages too quickly.');
      return;
    case 'CALL_FULL':
      postToCall({ cmd: 'error', message });
      systemToTab(message);
      return;
    case 'NOT_IN_ROOM':
      if (session.roomId) sendServer(rejoinMessage());
      return;
    case 'ROOM_NOT_FOUND':
    case 'ROOM_FULL':
    case 'BAD_MESSAGE':
      if (failPending(message)) return;
      if (code !== 'BAD_MESSAGE' && session.roomId) {
        // Automatic rejoin failed: drop the party.
        const text = message;
        leaveRoom();
        lastError = text;
        notifyPopup();
      }
      return;
    case 'ROOM_EXPIRED':
      leaveRoom();
      lastError = message;
      notifyPopup();
      return;
    default:
      console.warn('[WatchParty] server error', code, message);
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'room_created':
      onJoined(msg, true);
      break;
    case 'room_joined':
      onJoined(msg, false);
      break;
    case 'member_update':
      onMemberUpdate(msg);
      break;
    case 'playback': {
      if (!session.roomId) return;
      const data = { ...msg, sentAt: toLocalTime(msg.sentAt) };
      toVideoFrame({ cmd: 'remote_playback', data });
      systemToTab(describePlayback(msg.nickname || memberName(msg.from), msg));
      break;
    }
    case 'heartbeat':
      if (!session.roomId) return;
      toVideoFrame({ cmd: 'remote_heartbeat', data: { ...msg, sentAt: toLocalTime(msg.sentAt) } });
      break;
    case 'sync_request':
      // Server asks the host for a fresh heartbeat for a late joiner.
      if (session.isHost) toVideoFrame({ cmd: 'heartbeat_now' });
      break;
    case 'chat': {
      const data = {
        nickname: msg.nickname,
        text: msg.text,
        at: msg.at,
        self: msg.from === session.clientId,
        avatar: (session.members.find((m) => m.id === msg.from) || {}).avatar || '🙂',
      };
      logEntry({ type: 'chat', data });
      sendToTab({ cmd: 'chat', data }, 0);
      break;
    }
    case 'reaction':
      sendToTab({ cmd: 'reaction', data: { emoji: msg.emoji, nickname: msg.nickname, avatar: msg.avatar } }, 0);
      break;
    case 'typing':
      sendToTab({ cmd: 'typing', data: { from: msg.from, nickname: msg.nickname, active: !!msg.active } }, 0);
      break;
    case 'navigate':
      onNavigate(msg);
      break;
    case 'ice_servers':
      session.iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
      session.relay = !!msg.relay;
      persist();
      postToCall({ cmd: 'ice', iceServers: session.iceServers, relay: session.relay });
      break;
    case 'rtc_signal':
      postToCall({ cmd: 'signal', from: msg.from, data: msg.data });
      break;
    case 'error':
      onServerError(msg);
      break;
    case 'pong':
      onPong(msg);
      break;
    default:
      break; // ignore unknown
  }
}

// ---------------------------------------------------------------------------
// Party actions
// ---------------------------------------------------------------------------

async function ensureContentScripts(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { cmd: 'ping' }, { frameId: 0 });
    return;
  } catch {
    // Tab was opened before the extension was installed/reloaded: inject now.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES });
  } catch (err) {
    console.warn('[WatchParty] could not inject content scripts', err);
  }
}

function startRequest(kind, { nickname, avatar, tabId, roomId }) {
  if (session.roomId) leaveRoom();
  if (pending) failPending('Cancelled');
  clearLog();
  session.nickname = nickname;
  session.avatar = avatar || session.avatar || '🙂';
  persist();
  lastError = null;
  warning = null;

  return new Promise((resolve) => {
    const message = kind === 'create'
      ? { type: 'create_room', nickname, avatar: session.avatar, version: VERSION }
      : { type: 'join_room', roomId, nickname, avatar: session.avatar, version: VERSION };
    const req = { kind, message, resolve, tabId, timer: null };
    req.timer = setTimeout(() => {
      if (pending === req) failPending(`Could not reach the party server (${serverUrl}). Is it running, and is the address right?`);
    }, REQUEST_TIMEOUT_MS);
    pending = req;
    wantConnection = true;
    if (!sendServer(message)) connect();
  });
}

function leaveRoom() {
  const oldTab = session.tabId;
  resetCall();
  if (session.roomId) sendServer({ type: 'leave_room' });
  Object.assign(session, {
    roomId: null,
    clientId: null,
    isHost: false,
    tabId: null,
    resumeToken: null,
    hostOnlyControl: false,
    members: [],
    hostId: null,
    currentUrl: null,
    currentTitle: '',
    currentFrom: null,
  });
  followingUntil = 0;
  clearTimeout(navigateTimer);
  clearLog();
  warning = null;
  frames.clear();
  videoFrameId = null;
  persist();
  if (oldTab != null) chrome.tabs.sendMessage(oldTab, { cmd: 'state', state: { inRoom: false } }).catch(() => {});
  wantConnection = false;
  closeSocket();
  status = 'idle';
  updateBadge();
  notifyPopup();
}

async function moveToTab(tabId) {
  if (!session.roomId || tabId === session.tabId) return;
  const oldTab = session.tabId;
  session.tabId = tabId;
  frames.clear();
  videoFrameId = null;
  persist();
  if (oldTab != null) chrome.tabs.sendMessage(oldTab, { cmd: 'state', state: { inRoom: false } }).catch(() => {});
  await ensureContentScripts(tabId);
  notifyTab();
  notifyPopup();
  systemToTab('Party moved to this tab.');
  if (!session.isHost) toVideoFrame({ cmd: 'request_sync' });
}

// ---------------------------------------------------------------------------
// Follow the host (next video / episode)
// ---------------------------------------------------------------------------

// Query params / path segments that differ per viewer but don't change which video it is.
const NOISE_PARAM = /^(utm_.*|t|si|feature|ref|ref_|trackId|tctx|start|time|pp|ab_channel|index|jbv|track|source|from)$/i;

/** A comparable key for "which video is this page": host + meaningful path + meaningful query. */
function videoKey(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (/(^|\.)youtube\.com$/.test(host) && u.searchParams.get('v')) return `yt:${u.searchParams.get('v')}`;
  if (host === 'youtu.be') return `yt:${u.pathname.slice(1)}`;
  const path = u.pathname.split('/').filter((seg) => seg && !/^ref=/i.test(seg)).join('/');
  const params = [...u.searchParams].filter(([k]) => !NOISE_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
  return `${host}/${path}?${new URLSearchParams(params)}`;
}

function sameVideo(a, b) {
  try {
    return videoKey(a) === videoKey(b);
  } catch {
    return false;
  }
}

function stripHash(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

// Pages that are "watching a video" per site. Browsing (home, search, profiles) is never shared.
const WATCH_PAGES = [
  [/(^|\.)youtube\.com$/, (u) => (u.pathname === '/watch' && u.searchParams.has('v')) || /^\/(shorts|live|embed)\//.test(u.pathname)],
  [/^youtu\.be$/, () => true],
  [/(^|\.)netflix\.com$/, (u) => /^\/watch\//.test(u.pathname)],
  [/(^|\.)primevideo\.com$/, (u) => /\/(detail|watch)\//.test(u.pathname)],
  [/(^|\.)amazon\.[a-z.]+$/, (u) => /\/(gp\/video\/detail|dp)\//.test(u.pathname)],
  [/(^|\.)hotstar\.com$/, (u) => /\/watch\b|\/\d{6,}/.test(u.pathname)],
  [/(^|\.)disneyplus\.com$/, (u) => /\/(video|play)\//.test(u.pathname)],
  [/(^|\.)crunchyroll\.com$/, (u) => /\/watch\//.test(u.pathname)],
  [/(^|\.)hulu\.com$/, (u) => /\/watch\//.test(u.pathname)],
  [/(^|\.)max\.com$/, (u) => /\/video\/watch\//.test(u.pathname)],
];

function isWatchPage(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.replace(/^(www|m)\./, '');
  for (const [re, test] of WATCH_PAGES) if (re.test(host)) return test(u);
  return frames.size > 0; // other sites: any page that is showing a video right now
}

function canChangeVideo() {
  return session.isHost || !session.hostOnlyControl;
}

function scheduleNavigate(delay = NAVIGATE_DEBOUNCE_MS) {
  clearTimeout(navigateTimer);
  navigateTimer = setTimeout(maybeSendNavigate, delay);
}

/** Our tab changed page: if it's a different video than the party's, share it (or offer to go back). */
async function maybeSendNavigate() {
  if (!session.roomId || session.tabId == null) return;
  let tab;
  try { tab = await chrome.tabs.get(session.tabId); } catch { return; }
  if (!tab.url || !isWatchPage(tab.url)) return;
  const url = stripHash(tab.url);
  const title = (tab.title || '').slice(0, 200);
  if (session.currentUrl && sameVideo(url, session.currentUrl)) {
    followingUntil = 0; // arrived: from now on, page changes are the user's own
    // Already the party's video. The person who picked it refreshes the title (it often loads late).
    if (session.currentFrom === session.clientId && title && title !== session.currentTitle) {
      sendServer({ type: 'navigate', url: session.currentUrl, title, titleOnly: true });
    }
    return;
  }
  if (Date.now() < followingUntil) return; // mid auto-follow (redirects etc.)
  if (!canChangeVideo()) {
    offerFollow(true);
    return;
  }
  sendServer({ type: 'navigate', url, title });
}

/** Someone (maybe us) changed the party's video. */
async function onNavigate(msg) {
  if (msg.titleOnly) {
    if (msg.url === session.currentUrl) {
      session.currentTitle = msg.title || '';
      persist();
      notifyPopup();
    }
    return; // never navigate for a title update
  }
  session.currentUrl = msg.url;
  session.currentTitle = msg.title || '';
  session.currentFrom = msg.from || null;
  persist();
  notifyPopup();
  if (msg.from === session.clientId || session.tabId == null) return;
  let tab;
  try { tab = await chrome.tabs.get(session.tabId); } catch { return; }
  if (tab.url && sameVideo(tab.url, msg.url)) return; // already there (or just a title update)
  const who = msg.nickname || memberName(msg.from);
  const what = msg.title ? `“${msg.title}”` : 'a new video';
  if (session.autoFollow) {
    systemToTab(`➡️ ${who} switched to ${what}`);
    followUrl(msg.url);
  } else {
    systemToTab(`${who} switched to ${what}`, { id: 'follow_host', label: 'Go there' });
  }
}

/** Just joined: go to the party's current video if we're elsewhere. */
async function joinPartyVideo() {
  if (!session.currentUrl || session.tabId == null) return;
  let tab;
  try { tab = await chrome.tabs.get(session.tabId); } catch { return; }
  if (tab.url && sameVideo(tab.url, session.currentUrl)) return;
  const who = memberName(session.currentFrom || session.hostId);
  if (session.autoFollow) {
    systemToTab(`➡️ Taking you to ${who === 'Someone' ? 'the party' : who + '’s'} video…`);
    followUrl(session.currentUrl);
  } else {
    offerFollow(false);
  }
}

/** Offer a button to go to the party's video. `wandered`: we left it ourselves (host-only mode). */
async function offerFollow(wandered) {
  if (!session.roomId || !session.currentUrl || session.tabId == null) return;
  let tab;
  try { tab = await chrome.tabs.get(session.tabId); } catch { return; }
  if (tab.url && sameVideo(tab.url, session.currentUrl)) return;
  if (wandered) {
    const key = stripHash(tab.url || '');
    if (key === lastWanderNotice) return;
    lastWanderNotice = key;
    systemToTab('Only the host can change the video, so your friends stayed on the party’s video.', { id: 'follow_host', label: 'Back to party video' });
    return;
  }
  const who = memberName(session.currentFrom || session.hostId);
  const what = session.currentTitle ? `“${session.currentTitle}”` : 'a different video';
  systemToTab(`${who} is watching ${what}`, { id: 'follow_host', label: 'Go there' });
}

async function followUrl(url) {
  if (session.tabId == null) return;
  followingUntil = Date.now() + FOLLOW_QUIET_MS;
  lastWanderNotice = '';
  try {
    await chrome.tabs.update(session.tabId, { url });
  } catch (err) {
    console.warn('[WatchParty] follow failed', err);
  }
}

async function followHost() {
  if (session.currentUrl) followUrl(session.currentUrl);
}

// ---------------------------------------------------------------------------
// Video call (UI = call/call.html in an iframe inside the overlay, or a popup window)
// ---------------------------------------------------------------------------

async function openCall() {
  if (!session.roomId) return { ok: false, error: 'Join a party first.' };
  if (session.callMode === 'window' && session.callWindowId != null) {
    try {
      await chrome.windows.update(session.callWindowId, { focused: true });
      return { ok: true };
    } catch {
      session.callWindowId = null;
      session.callMode = 'frame';
    }
  }
  session.callUiOpen = true;
  session.callOpenedAt = Date.now();
  persist();
  notifyTab();
  notifyPopup();
  return { ok: true };
}

/** Clear call state locally (used when leaving the call or the party). */
function resetCall() {
  clearTimeout(callLeaveTimer);
  callLeaveTimer = null;
  const wasOpen = session.callUiOpen;
  if (wasOpen && session.callId) sendServer({ type: 'call_leave' });
  session.callUiOpen = false;
  session.callId = null;
  session.callMode = 'frame';
  if (session.callWindowId != null) {
    const id = session.callWindowId;
    session.callWindowId = null;
    suppressWindowLeave = true;
    chrome.windows.remove(id).catch(() => {}).finally(() => { suppressWindowLeave = false; });
  }
  postToCall({ cmd: 'ended' });
  return wasOpen;
}

function leaveCall() {
  resetCall();
  persist();
  notifyTab();
  notifyPopup();
}

async function openCallWindow() {
  if (!session.roomId) return;
  session.callMode = 'window';
  session.callUiOpen = true;
  persist();
  notifyTab(); // overlay removes its iframe
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('call/call.html?mode=window'),
      type: 'popup',
      width: 480,
      height: 300,
      focused: true,
    });
    session.callWindowId = win.id;
    persist();
  } catch (err) {
    console.warn('[WatchParty] could not open call window', err);
    session.callMode = 'frame';
    persist();
    notifyTab();
  }
}

/** Move the call from the popup window back into the page overlay. */
function useFrameForCall() {
  if (session.callWindowId != null) {
    const id = session.callWindowId;
    session.callWindowId = null;
    suppressWindowLeave = true;
    chrome.windows.remove(id).catch(() => {}).finally(() => { suppressWindowLeave = false; });
  }
  session.callMode = 'frame';
  session.callUiOpen = true;
  persist();
  notifyTab();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'call' || (port.sender && port.sender.id !== chrome.runtime.id)) return;
  (async () => {
    await ready;
    callPorts.add(port);
    clearTimeout(callLeaveTimer);
    callLeaveTimer = null;
    port.postMessage({
      cmd: 'init',
      inRoom: !!session.roomId,
      me: session.clientId,
      members: session.members,
      autoJoin: session.callUiOpen,
      // Opened just now by a click (vs. restored after a page reload).
      fresh: Date.now() - (session.callOpenedAt || 0) < 8000,
      mode: session.callMode,
      mic: session.micOn,
      cam: session.camOn,
      iceServers: session.iceServers,
      relay: session.relay,
    });
  })();

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg.cmd !== 'string') return;
    switch (msg.cmd) {
      case 'join':
        if (!session.roomId) return;
        session.callUiOpen = true;
        session.callId = String(msg.callId || '');
        session.micOn = msg.mic !== false;
        session.camOn = msg.cam !== false;
        persist();
        sendServer({ type: 'call_join', callId: session.callId, mic: session.micOn, cam: session.camOn });
        notifyPopup();
        break;
      case 'state':
        session.micOn = !!msg.mic;
        session.camOn = !!msg.cam;
        persist();
        sendServer({ type: 'call_state', mic: session.micOn, cam: session.camOn });
        break;
      case 'signal':
        sendServer({ type: 'rtc_signal', to: msg.to, data: msg.data });
        break;
      case 'leave':
        leaveCall();
        break;
      case 'open_window':
        openCallWindow();
        break;
      case 'use_frame':
        useFrameForCall();
        break;
      case 'permission':
        chrome.tabs.create({ url: chrome.runtime.getURL('call/permission.html') });
        break;
      case 'notice':
        systemToTab(String(msg.text || '').slice(0, 200));
        break;
      default:
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    callPorts.delete(port);
    if (callPorts.size === 0 && session.callUiOpen) {
      // The UI may just be reloading (page navigation, fullscreen fallback). Leave only if it doesn't return.
      clearTimeout(callLeaveTimer);
      callLeaveTimer = setTimeout(() => {
        if (callPorts.size === 0 && session.callUiOpen) leaveCall();
      }, CALL_PORT_GRACE_MS);
    }
  });
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await ready;
  if (windowId !== session.callWindowId) return;
  session.callWindowId = null;
  if (!suppressWindowLeave) leaveCall();
});

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

async function handlePopupMessage(msg) {
  switch (msg.cmd) {
    case 'popup_get_state': {
      let tabUrl = null;
      if (session.tabId != null) {
        try { tabUrl = (await chrome.tabs.get(session.tabId)).url || null; } catch { /* tab gone */ }
      }
      return { ...viewState(), tabUrl };
    }
    case 'popup_create':
      await ensureContentScripts(msg.tabId);
      return startRequest('create', msg);
    case 'popup_join':
      await ensureContentScripts(msg.tabId);
      return startRequest('join', msg);
    case 'popup_leave':
      leaveRoom();
      return { ok: true };
    case 'popup_set_settings':
      if (!session.isHost) return { ok: false, error: 'Only the host can change this.' };
      return { ok: sendServer({ type: 'set_settings', hostOnlyControl: !!msg.hostOnlyControl }) };
    case 'popup_use_tab':
      await moveToTab(msg.tabId);
      return { ok: true };
    case 'popup_get_server':
      return {
        url: serverUrl,
        key: partyKey,
        defaultUrl: typeof SERVER_URL === 'string' ? SERVER_URL.trim() : '',
      };
    case 'popup_save_server': {
      let url = String(msg.url || '').trim();
      const key = String(msg.key || '').trim().slice(0, 200);
      if (url && !/^wss?:\/\//i.test(url)) {
        if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
        else url = `wss://${url}`;
      }
      url = url.replace(/\/+$/, '');
      if (url) {
        try { new URL(url); } catch { return { ok: false, error: 'That does not look like a server address.' }; }
      }
      const changed = url !== serverUrl || key !== partyKey;
      await chrome.storage.local.set({ server: { url, key } });
      serverUrl = url || (typeof SERVER_URL === 'string' ? SERVER_URL.trim() : '');
      partyKey = url ? key : (typeof PARTY_KEY === 'string' ? PARTY_KEY.trim() : '');
      lastError = null;
      if (changed) {
        closeSocket();
        if (session.roomId) {
          wantConnection = true;
          connect();
        } else {
          setStatus('idle');
        }
      }
      notifyPopup();
      return { ok: true, url: serverUrl };
    }
    case 'popup_clear_error':
      lastError = null;
      return { ok: true };
    case 'popup_set_profile': {
      const nickname = String(msg.nickname || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      if (!nickname) return { ok: false, error: 'Nickname cannot be empty.' };
      session.nickname = nickname;
      session.avatar = msg.avatar || session.avatar;
      persist();
      if (session.roomId) sendServer({ type: 'set_profile', nickname, avatar: session.avatar });
      notifyPopup();
      return { ok: true };
    }
    case 'popup_call_open':
      return openCall();
    case 'popup_set_autofollow':
      session.autoFollow = !!msg.autoFollow;
      persist();
      chrome.storage.local.set({ autoFollow: session.autoFollow }).catch(() => {});
      notifyPopup();
      if (session.autoFollow) joinPartyVideo();
      return { ok: true };
    case 'popup_call_leave':
      leaveCall();
      return { ok: true };
    case 'call_permission_granted':
      postToCall({ cmd: 'permission_granted' });
      return { ok: true };
    default:
      return undefined;
  }
}

function handleContentMessage(msg, sender) {
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  const isPartyTab = !!session.roomId && tabId === session.tabId;

  switch (msg.cmd) {
    case 'hello':
      if (isPartyTab && frameId === 0) {
        // New top-level document: all previous subframes are gone.
        frames.clear();
        videoFrameId = null;
      }
      return partyStateFor(tabId);
    case 'get_state':
    case 'keepalive':
      return partyStateFor(tabId);
    case 'get_history':
      return isPartyTab ? chatLog : [];
    case 'video_status':
      if (!isPartyTab) return undefined;
      if (msg.area > 0 && frames.size === 0) scheduleNavigate(); // a video just appeared on this page
      if (msg.area > 0) frames.set(frameId, msg.area);
      else frames.delete(frameId);
      pickVideoFrame();
      return undefined;
    case 'playback': {
      if (!isPartyTab) return undefined;
      if (videoFrameId != null && frameId !== videoFrameId) return undefined;
      if (videoFrameId == null) videoFrameId = frameId;
      const ok = sendServer({
        type: 'playback',
        action: msg.action,
        currentTime: msg.currentTime,
        playbackRate: msg.playbackRate,
        paused: msg.paused,
        sentAt: toServerTime(msg.sentAt),
      });
      if (ok) systemToTab(describePlayback('You', msg));
      return { ok };
    }
    case 'heartbeat':
      if (!isPartyTab || !session.isHost) return undefined;
      if (videoFrameId != null && frameId !== videoFrameId) return undefined;
      sendServer({
        type: 'heartbeat',
        currentTime: msg.currentTime,
        paused: msg.paused,
        playbackRate: msg.playbackRate,
        sentAt: toServerTime(msg.sentAt),
      });
      return undefined;
    case 'sync_request':
      if (isPartyTab) sendServer({ type: 'sync_request' });
      return undefined;
    case 'chat': {
      if (!isPartyTab) return { ok: false };
      const ok = sendServer({ type: 'chat', text: String(msg.text || '').slice(0, 500) });
      if (!ok) systemToTab('Not connected — message not sent.');
      return { ok };
    }
    case 'notice': {
      if (!isPartyTab) return undefined;
      const action = msg.action && msg.action.id === 'unmute_video' ? { id: 'unmute_video', label: '🔊 Unmute' } : null;
      systemToTab(String(msg.text || '').slice(0, 200), action);
      return undefined;
    }
    case 'unmute_video':
      if (isPartyTab) toVideoFrame({ cmd: 'unmute' });
      return undefined;
    case 'need_bridge':
      // Netflix: <script src> injection was blocked, inject the page bridge into the MAIN world instead.
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: 'MAIN',
        files: ['content/page-bridge.js'],
      }).catch((err) => console.warn('[WatchParty] bridge injection failed', err));
      return undefined;
    case 'leave':
      if (isPartyTab) leaveRoom();
      return undefined;
    case 'reaction':
      if (isPartyTab) sendServer({ type: 'reaction', emoji: msg.emoji });
      return undefined;
    case 'typing':
      if (isPartyTab) sendServer({ type: 'typing', active: !!msg.active });
      return undefined;
    case 'call_open':
      if (isPartyTab) return openCall();
      return undefined;
    case 'follow_host':
      if (isPartyTab) followHost();
      return undefined;
    case 'join_link':
      // Invite link opened (…#watchparty=CODE): join from this tab.
      return ensureContentScripts(tabId).then(() => startRequest('join', {
        nickname: String(msg.nickname || '').trim().slice(0, 24) || `Viewer${Math.floor(1000 + Math.random() * 9000)}`,
        avatar: msg.avatar,
        tabId,
        roomId: String(msg.roomId || '').toUpperCase(),
      }));
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.cmd !== 'string') return false;
  if (sender.id !== chrome.runtime.id) return false;
  // Extension pages (the popup, even if opened in a tab) vs. content scripts running in web pages.
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
  if (!fromExtensionPage && !sender.tab) return false;
  (async () => {
    await ready;
    try {
      const result = fromExtensionPage ? await handlePopupMessage(msg) : handleContentMessage(msg, sender);
      sendResponse(await result);
    } catch (err) {
      console.error('[WatchParty]', err);
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true; // async response
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (session.roomId && tabId === session.tabId) leaveRoom();
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url && !info.title) return;
  await ready;
  if (!session.roomId || tabId !== session.tabId) return;
  if (info.url) notifyPopup();
  // Debounced: SPA sites change the URL/title several times while loading the next video.
  scheduleNavigate();
});
