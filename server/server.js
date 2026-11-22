'use strict';

/**
 * Tandem relay server.
 *
 * Keeps rooms in memory and relays play/pause/seek/rate, host heartbeats, chat, reactions and
 * WebRTC call signaling between members. No video or audio ever passes through here: the movie is
 * played by each member from their own account, and video-call media flows peer-to-peer.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

loadEnvFile(path.join(__dirname, '.env')); // TURN credentials etc. (written by scripts/setup-turn.sh)
const turn = require('./turn');

/** Minimal KEY=value .env reader; real environment variables win. */
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  port: Number(process.env.PORT) || 8080,
  maxMembers: 20,
  maxMessageBytes: 4 * 1024,
  maxSignalBytes: 16 * 1024, // WebRTC offers/answers (SDP) are larger than normal messages
  chatLimit: { count: 5, windowMs: 5000 },
  reactionLimit: { count: 10, windowMs: 5000 },
  navigateLimit: { count: 6, windowMs: 10000 },
  floodLimit: { count: 150, windowMs: 5000 }, // any message type (ICE candidates come in bursts)
  maxCallMembers: 8, // mesh video call: every member connects to every other
  roomIdleMs: Number(process.env.ROOM_IDLE_MS) || 6 * 60 * 60 * 1000,
  sweepIntervalMs: 10 * 60 * 1000,
  reconnectGraceMs: Number(process.env.RECONNECT_GRACE_MS) || 15 * 1000,
  wsPingIntervalMs: 30 * 1000,
  maxNicknameLength: 24,
  maxChatLength: 500,
  maxUrlLength: 2048,
  // Optional shared secret. When set, only clients that know it can connect (and get the TURN
  // relay login). Friends enter it in the extension popup → Server settings.
  partyKey: (process.env.PARTY_KEY || '').trim(),
};

const SERVER_VERSION = require('./package.json').version;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const ROOM_ID_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const PLAYBACK_ACTIONS = new Set(['play', 'pause', 'seek', 'rate']);
const AVATARS = new Set(['🙂', '🦊', '🐼', '🐯', '🐸', '🐵', '🦁', '🐨', '🐙', '🦄', '🐧', '🐶', '🐱', '🐰', '🐻', '🐲', '👽', '🤖', '👻', '🎃']);
const REACTIONS = new Set(['😂', '❤️', '😮', '😢', '👏', '🔥', '😡', '👍', '💀', '🎉']);
const SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate']);
const CALL_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {{ id: string, nickname: string, ws: WebSocket|null, token: string,
 *             connected: boolean, graceTimer: NodeJS.Timeout|null,
 *             chatTimes: number[], reactionTimes: number[], avatar: string,
 *             inCall: boolean, micOn: boolean, camOn: boolean, callId: string|null }} Member
 * @typedef {{ id: string, hostId: string, hostOnlyControl: boolean,
 *             members: Map<string, Member>, lastState: object|null,
 *             version: string, createdAt: number, lastActivity: number }} Room
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args) {
  if (process.env.QUIET) return;
  console.log(new Date().toISOString(), ...args);
}

function randomId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateRoomId() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const bytes = crypto.randomBytes(6);
    let id = '';
    for (let i = 0; i < 6; i++) id += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
    if (!rooms.has(id)) return id;
  }
  throw new Error('Could not allocate room id');
}

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function sendError(ws, code, message, extra = {}) {
  send(ws, 'error', { code, message, ...extra });
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function cleanText(v, maxLen) {
  if (typeof v !== 'string') return null;
  // Strip control characters (keep normal whitespace), collapse, trim.
  const s = v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  if (!s || s.length > maxLen) return null;
  return s;
}

function cleanNickname(v) {
  const s = cleanText(typeof v === 'string' ? v.replace(/\s+/g, ' ') : v, CONFIG.maxNicknameLength);
  return s;
}

function majorMinor(version) {
  if (typeof version !== 'string') return null;
  const m = /^(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Clamp a client-supplied server-clock timestamp into a sane window. */
function sanitizeSentAt(sentAt) {
  const now = Date.now();
  if (!isFiniteNumber(sentAt) || Math.abs(now - sentAt) > 60 * 1000) return now;
  return sentAt;
}

/** Sliding-window rate limiter on an array of timestamps. Returns true if allowed. */
function allow(times, limit) {
  const now = Date.now();
  while (times.length && now - times[0] > limit.windowMs) times.shift();
  if (times.length >= limit.count) return false;
  times.push(now);
  return true;
}

function cleanAvatar(v) {
  return typeof v === 'string' && AVATARS.has(v) ? v : '🙂';
}

function cleanUrl(v) {
  if (typeof v !== 'string' || v.length > CONFIG.maxUrlLength) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function memberList(room) {
  return [...room.members.values()].map((m) => ({
    id: m.id,
    nickname: m.nickname,
    avatar: m.avatar,
    isHost: m.id === room.hostId,
    connected: m.connected,
    inCall: m.inCall,
    micOn: m.micOn,
    camOn: m.camOn,
    callId: m.callId,
  }));
}

function roomSettings(room) {
  return { hostOnlyControl: room.hostOnlyControl };
}

function broadcast(room, type, payload, exceptId = null) {
  for (const m of room.members.values()) {
    if (m.id !== exceptId && m.connected) send(m.ws, type, payload);
  }
}

function broadcastMembers(room) {
  broadcast(room, 'member_update', {
    members: memberList(room),
    hostId: room.hostId,
    settings: roomSettings(room),
  });
}

// ---------------------------------------------------------------------------
// Validation: each type maps to a function returning a cleaned payload or null.
// ---------------------------------------------------------------------------

const validators = {
  create_room(msg) {
    const nickname = cleanNickname(msg.nickname);
    if (!nickname) return null;
    return {
      nickname,
      avatar: cleanAvatar(msg.avatar),
      version: typeof msg.version === 'string' ? msg.version.slice(0, 20) : '0.0.0',
    };
  },
  join_room(msg) {
    const nickname = cleanNickname(msg.nickname);
    const roomId = typeof msg.roomId === 'string' ? msg.roomId.trim().toUpperCase() : '';
    if (!nickname || !ROOM_ID_RE.test(roomId)) return null;
    return {
      roomId,
      nickname,
      avatar: cleanAvatar(msg.avatar),
      version: typeof msg.version === 'string' ? msg.version.slice(0, 20) : '0.0.0',
      rejoin: msg.rejoin === true,
      wasHost: msg.wasHost === true,
      resumeToken: typeof msg.resumeToken === 'string' ? msg.resumeToken.slice(0, 64) : null,
      hostOnlyControl: msg.hostOnlyControl === true,
    };
  },
  leave_room() {
    return {};
  },
  playback(msg) {
    if (!PLAYBACK_ACTIONS.has(msg.action)) return null;
    if (!isFiniteNumber(msg.currentTime) || msg.currentTime < 0) return null;
    const playbackRate = isFiniteNumber(msg.playbackRate) && msg.playbackRate > 0 && msg.playbackRate <= 16
      ? msg.playbackRate : 1;
    return {
      action: msg.action,
      currentTime: msg.currentTime,
      playbackRate,
      paused: typeof msg.paused === 'boolean' ? msg.paused : msg.action === 'pause',
      sentAt: sanitizeSentAt(msg.sentAt),
    };
  },
  heartbeat(msg) {
    if (!isFiniteNumber(msg.currentTime) || msg.currentTime < 0) return null;
    if (typeof msg.paused !== 'boolean') return null;
    const playbackRate = isFiniteNumber(msg.playbackRate) && msg.playbackRate > 0 && msg.playbackRate <= 16
      ? msg.playbackRate : 1;
    return { currentTime: msg.currentTime, paused: msg.paused, playbackRate, sentAt: sanitizeSentAt(msg.sentAt) };
  },
  sync_request() {
    return {};
  },
  chat(msg) {
    const text = cleanText(msg.text, CONFIG.maxChatLength);
    return text ? { text } : null;
  },
  set_settings(msg) {
    if (typeof msg.hostOnlyControl !== 'boolean') return null;
    return { hostOnlyControl: msg.hostOnlyControl };
  },
  ping(msg) {
    return { t: isFiniteNumber(msg.t) ? msg.t : null };
  },
  get_ice() {
    return {};
  },
  set_profile(msg) {
    const nickname = cleanNickname(msg.nickname);
    if (!nickname) return null;
    return { nickname, avatar: cleanAvatar(msg.avatar) };
  },
  reaction(msg) {
    return typeof msg.emoji === 'string' && REACTIONS.has(msg.emoji) ? { emoji: msg.emoji } : null;
  },
  typing(msg) {
    return { active: msg.active === true };
  },
  navigate(msg) {
    const url = cleanUrl(msg.url);
    if (!url) return null;
    const title = typeof msg.title === 'string' ? (cleanText(msg.title, 200) || '') : '';
    return { url, title, titleOnly: msg.titleOnly === true };
  },
  call_join(msg) {
    if (typeof msg.callId !== 'string' || !CALL_ID_RE.test(msg.callId)) return null;
    return { callId: msg.callId, mic: msg.mic !== false, cam: msg.cam !== false };
  },
  call_leave() {
    return {};
  },
  call_state(msg) {
    if (typeof msg.mic !== 'boolean' || typeof msg.cam !== 'boolean') return null;
    return { mic: msg.mic, cam: msg.cam };
  },
  rtc_signal(msg) {
    if (typeof msg.to !== 'string' || msg.to.length > 32) return null;
    const d = msg.data;
    if (!d || typeof d !== 'object' || !SIGNAL_TYPES.has(d.type)) return null;
    if (typeof d.callId !== 'string' || !CALL_ID_RE.test(d.callId)) return null;
    const data = { type: d.type, callId: d.callId };
    if (d.type === 'candidate') {
      const c = d.candidate;
      if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > 1000) return null;
      data.candidate = {
        candidate: c.candidate,
        sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 64) : null,
        sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
        usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 256) : null,
      };
    } else {
      if (typeof d.sdp !== 'string' || !d.sdp || d.sdp.length > 15000) return null;
      data.sdp = d.sdp;
    }
    return { to: msg.to, data };
  },
};

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------

function createRoom(id, version, hostOnlyControl = false) {
  const room = {
    id,
    hostId: null,
    hostOnlyControl,
    members: new Map(),
    lastState: null,
    currentUrl: null,
    currentTitle: '',
    version,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

function addMember(room, ws, nickname, avatar = '🙂') {
  const member = {
    id: randomId(6),
    nickname,
    avatar,
    ws,
    token: randomId(16),
    connected: true,
    graceTimer: null,
    chatTimes: [],
    reactionTimes: [],
    navigateTimes: [],
    inCall: false,
    micOn: true,
    camOn: true,
    callId: null,
  };
  room.members.set(member.id, member);
  if (!room.hostId) room.hostId = member.id;
  ws.ctx.roomId = room.id;
  ws.ctx.clientId = member.id;
  return member;
}

function deleteRoom(room, reason) {
  for (const m of room.members.values()) {
    if (m.graceTimer) clearTimeout(m.graceTimer);
    if (m.ws) {
      m.ws.ctx.roomId = null;
      m.ws.ctx.clientId = null;
    }
  }
  rooms.delete(room.id);
  log(`room ${room.id} deleted (${reason})`);
}

/** Remove a member immediately, promoting a new host if needed. */
function removeMember(room, memberId) {
  const member = room.members.get(memberId);
  if (!member) return;
  if (member.graceTimer) clearTimeout(member.graceTimer);
  room.members.delete(memberId);
  if (member.ws && member.ws.ctx.clientId === memberId) {
    member.ws.ctx.roomId = null;
    member.ws.ctx.clientId = null;
  }

  if (room.members.size === 0) {
    deleteRoom(room, 'empty');
    return;
  }
  if (room.hostId === memberId) {
    // Promote the oldest member, preferring one that is currently connected.
    const all = [...room.members.values()];
    const next = all.find((m) => m.connected) || all[0];
    room.hostId = next.id;
    log(`room ${room.id}: host promoted to ${next.nickname}`);
  }
  broadcastMembers(room);
}

/** Socket dropped without leave_room: keep the slot for a short grace period. */
function markDisconnected(room, memberId) {
  const member = room.members.get(memberId);
  if (!member) return;
  member.connected = false;
  member.ws = null;
  if (member.graceTimer) clearTimeout(member.graceTimer);
  member.graceTimer = setTimeout(() => {
    member.graceTimer = null;
    if (!member.connected && rooms.get(room.id) === room) removeMember(room, memberId);
  }, CONFIG.reconnectGraceMs);

  if ([...room.members.values()].every((m) => !m.connected)) {
    // Nobody connected: room will be deleted when the last grace timer fires.
    return;
  }
  broadcastMembers(room);
}

function leaveCurrentRoom(ws) {
  const { roomId, clientId } = ws.ctx;
  if (!roomId) return;
  const room = rooms.get(roomId);
  ws.ctx.roomId = null;
  ws.ctx.clientId = null;
  if (room) removeMember(room, clientId);
}

function versionWarning(room, ws, nickname, version) {
  const roomMM = majorMinor(room.version);
  const joinMM = majorMinor(version);
  if (!roomMM || !joinMM || roomMM === joinMM) return;
  const message = `Your friend has a different version (${room.version} vs ${version}) — update the extension folder.`;
  sendError(ws, 'VERSION_MISMATCH', message, { warning: true });
  for (const m of room.members.values()) {
    if (m.ws !== ws && m.connected) {
      sendError(m.ws, 'VERSION_MISMATCH', `${nickname} has a different version (${version} vs ${room.version}) — update the extension folder.`, { warning: true });
    }
  }
}

/** Relay (TURN) servers for the video call, sent right after joining. */
function sendIce(ws) {
  turn.getIceServers().then((iceServers) => {
    if (ws.readyState === WebSocket.OPEN) send(ws, 'ice_servers', { iceServers, relay: iceServers.some((s) => s.urls.some((u) => /^turns?:/i.test(u))) });
  });
}

function joinedPayload(room, member) {
  return {
    roomId: room.id,
    clientId: member.id,
    isHost: room.hostId === member.id,
    hostId: room.hostId,
    members: memberList(room),
    settings: roomSettings(room),
    lastState: room.lastState,
    currentUrl: room.currentUrl,
    currentTitle: room.currentTitle,
    currentFrom: room.currentFrom || null,
    resumeToken: member.token,
    serverVersion: SERVER_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

const handlers = {
  create_room(ws, data) {
    leaveCurrentRoom(ws);
    const room = createRoom(generateRoomId(), data.version);
    const member = addMember(room, ws, data.nickname, data.avatar);
    log(`room ${room.id} created by ${member.nickname}`);
    send(ws, 'room_created', joinedPayload(room, member));
    sendIce(ws);
  },

  join_room(ws, data) {
    let room = rooms.get(data.roomId);

    // Resume an existing slot (reconnect within grace period).
    if (room && data.resumeToken) {
      const existing = [...room.members.values()].find((m) => m.token === data.resumeToken);
      if (existing) {
        if (ws.ctx.roomId && ws.ctx.clientId !== existing.id) leaveCurrentRoom(ws);
        if (existing.ws && existing.ws !== ws) {
          existing.ws.ctx.roomId = null;
          existing.ws.ctx.clientId = null;
          try { existing.ws.close(4000, 'replaced'); } catch { /* ignore */ }
        }
        if (existing.graceTimer) clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
        existing.ws = ws;
        existing.connected = true;
        existing.nickname = data.nickname;
        existing.avatar = data.avatar;
        ws.ctx.roomId = room.id;
        ws.ctx.clientId = existing.id;
        send(ws, 'room_joined', { ...joinedPayload(room, existing), resumed: true });
        sendIce(ws);
        broadcastMembers(room);
        log(`room ${room.id}: ${existing.nickname} resumed`);
        return;
      }
    }

    leaveCurrentRoom(ws);

    if (!room) {
      if (!data.rejoin) {
        sendError(ws, 'ROOM_NOT_FOUND', `Room ${data.roomId} does not exist.`);
        return;
      }
      // Server restarted (rooms are in memory): recreate the room under the same code.
      room = createRoom(data.roomId, data.version, data.hostOnlyControl);
      room.recreatedAt = Date.now();
      room.hostClaimed = data.wasHost;
      log(`room ${room.id} recreated on rejoin`);
    }

    if (room.members.size >= CONFIG.maxMembers) {
      sendError(ws, 'ROOM_FULL', `Room ${room.id} is full (${CONFIG.maxMembers} max).`);
      return;
    }

    const member = addMember(room, ws, data.nickname, data.avatar);
    // After a restart a guest may reconnect first; hand host back to the previous host when they return.
    if (data.rejoin && data.wasHost && room.recreatedAt && !room.hostClaimed
        && Date.now() - room.recreatedAt < 60 * 1000 && room.hostId !== member.id) {
      room.hostId = member.id;
      room.hostClaimed = true;
      if (data.hostOnlyControl) room.hostOnlyControl = true;
      log(`room ${room.id}: host restored to ${member.nickname}`);
    }
    log(`room ${room.id}: ${member.nickname} joined (${room.members.size} members)`);
    send(ws, 'room_joined', joinedPayload(room, member));
    sendIce(ws);
    broadcastMembers(room);
    versionWarning(room, ws, data.nickname, data.version);
  },

  leave_room(ws) {
    leaveCurrentRoom(ws);
  },

  playback(ws, data, room, member) {
    if (room.hostOnlyControl && room.hostId !== member.id) {
      sendError(ws, 'NOT_ALLOWED', 'Only the host can control playback.', { context: 'playback' });
      return;
    }
    room.lastState = {
      currentTime: data.currentTime,
      paused: data.action === 'play' ? false : data.action === 'pause' ? true : data.paused,
      playbackRate: data.playbackRate,
      sentAt: data.sentAt,
    };
    broadcast(room, 'playback', { ...data, from: member.id, nickname: member.nickname }, member.id);
  },

  heartbeat(ws, data, room, member) {
    if (room.hostId !== member.id) {
      // Silently drop: a former host may still send one or two heartbeats after demotion.
      return;
    }
    room.lastState = { ...data };
    broadcast(room, 'heartbeat', { ...data, from: member.id }, member.id);
  },

  sync_request(ws, data, room, member) {
    if (room.lastState) send(ws, 'heartbeat', { ...room.lastState, from: room.hostId, sync: true });
    // Ask the host for a fresh heartbeat so the requester gets an exact position.
    if (room.hostId !== member.id) {
      const host = room.members.get(room.hostId);
      if (host && host.connected) send(host.ws, 'sync_request', { from: member.id });
    }
  },

  chat(ws, data, room, member) {
    if (!allow(member.chatTimes, CONFIG.chatLimit)) {
      sendError(ws, 'RATE_LIMITED', 'You are sending messages too quickly.', { context: 'chat' });
      return;
    }
    broadcast(room, 'chat', { from: member.id, nickname: member.nickname, text: data.text, at: Date.now() });
  },

  set_settings(ws, data, room, member) {
    if (room.hostId !== member.id) {
      sendError(ws, 'NOT_ALLOWED', 'Only the host can change settings.', { context: 'settings' });
      return;
    }
    room.hostOnlyControl = data.hostOnlyControl;
    broadcastMembers(room);
  },

  ping(ws, data) {
    send(ws, 'pong', { t: data.t, serverTime: Date.now() });
  },

  get_ice(ws) {
    sendIce(ws);
  },

  set_profile(ws, data, room, member) {
    member.nickname = data.nickname;
    member.avatar = data.avatar;
    broadcastMembers(room);
  },

  reaction(ws, data, room, member) {
    if (!allow(member.reactionTimes, CONFIG.reactionLimit)) return; // silently drop spam
    broadcast(room, 'reaction', { from: member.id, nickname: member.nickname, avatar: member.avatar, emoji: data.emoji }, member.id);
  },

  typing(ws, data, room, member) {
    broadcast(room, 'typing', { from: member.id, nickname: member.nickname, active: data.active }, member.id);
  },

  navigate(ws, data, room, member) {
    // Same rule as playback: the host always, guests only when host-only control is off.
    if (room.hostOnlyControl && room.hostId !== member.id) {
      sendError(ws, 'NOT_ALLOWED', 'Only the host can change the video.', { context: 'navigate' });
      return;
    }
    if (data.titleOnly) {
      // Late-arriving page title for the current video. Ignore if the party already moved on.
      if (data.url !== room.currentUrl || room.currentFrom !== member.id) return;
      room.currentTitle = data.title;
      broadcast(room, 'navigate', { ...data, from: member.id, nickname: member.nickname });
      return;
    }
    if (!allow(member.navigateTimes, CONFIG.navigateLimit)) return;
    room.currentUrl = data.url;
    room.currentTitle = data.title;
    room.currentFrom = member.id;
    // Sent to everyone, sender included, so simultaneous changes resolve to the same final video.
    broadcast(room, 'navigate', { ...data, from: member.id, nickname: member.nickname });
  },

  call_join(ws, data, room, member) {
    if (!member.inCall) {
      const inCall = [...room.members.values()].filter((m) => m.inCall).length;
      if (inCall >= CONFIG.maxCallMembers) {
        sendError(ws, 'CALL_FULL', `The video call is full (${CONFIG.maxCallMembers} max).`, { context: 'call' });
        return;
      }
    }
    member.inCall = true;
    member.callId = data.callId;
    member.micOn = data.mic;
    member.camOn = data.cam;
    broadcastMembers(room);
  },

  call_leave(ws, data, room, member) {
    if (!member.inCall) return;
    member.inCall = false;
    member.callId = null;
    broadcastMembers(room);
  },

  call_state(ws, data, room, member) {
    member.micOn = data.mic;
    member.camOn = data.cam;
    if (member.inCall) broadcastMembers(room);
  },

  rtc_signal(ws, data, room, member) {
    const target = room.members.get(data.to);
    if (!member.inCall || !target || !target.inCall || !target.connected || target.id === member.id) return;
    send(target.ws, 'rtc_signal', { from: member.id, data: data.data });
  },
};

const ROOMLESS_TYPES = new Set(['create_room', 'join_room', 'leave_room', 'ping']);

function handleMessage(ws, raw, isBinary) {
  if (isBinary) return;
  const size = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw));
  if (size > CONFIG.maxSignalBytes) {
    sendError(ws, 'MESSAGE_TOO_LARGE', `Messages must be under ${CONFIG.maxMessageBytes} bytes.`);
    return;
  }
  if (!allow(ws.ctx.msgTimes, CONFIG.floodLimit)) return; // silently drop floods

  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
  const { type } = msg;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(validators, type)) return; // unknown type
  if (type !== 'rtc_signal' && size > CONFIG.maxMessageBytes) {
    sendError(ws, 'MESSAGE_TOO_LARGE', `Messages must be under ${CONFIG.maxMessageBytes} bytes.`);
    return;
  }

  const data = validators[type](msg);
  if (!data) {
    sendError(ws, 'BAD_MESSAGE', `Invalid ${type} message.`);
    return;
  }

  if (ROOMLESS_TYPES.has(type)) {
    handlers[type](ws, data);
    return;
  }

  const room = ws.ctx.roomId ? rooms.get(ws.ctx.roomId) : null;
  const member = room ? room.members.get(ws.ctx.clientId) : null;
  if (!room || !member) {
    sendError(ws, 'NOT_IN_ROOM', 'Join a room first.');
    return;
  }
  room.lastActivity = Date.now();
  handlers[type](ws, data, room, member);
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

/** Checks ?key=… on the WebSocket URL against CONFIG.partyKey (constant-time). */
function keyAccepted(req) {
  if (!CONFIG.partyKey) return true;
  let given = '';
  try {
    given = new URL(req.url || '/', 'http://x').searchParams.get('key') || '';
  } catch { /* bad url */ }
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(CONFIG.partyKey).digest();
  return crypto.timingSafeEqual(a, b);
}

function createServer() {
  const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Tandem relay server v${SERVER_VERSION}.`);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

  wss.on('connection', (ws, req) => {
    if (!keyAccepted(req)) {
      ws.close(4401, 'party key required');
      return;
    }
    ws.ctx = { roomId: null, clientId: null, msgTimes: [], alive: true };
    ws.on('pong', () => { ws.ctx.alive = true; });
    ws.on('message', (raw, isBinary) => {
      try {
        handleMessage(ws, raw, isBinary);
      } catch (err) {
        log('handler error', err);
      }
    });
    ws.on('close', () => {
      const { roomId, clientId } = ws.ctx;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (room) markDisconnected(room, clientId);
    });
    ws.on('error', () => { /* close follows */ });
  });

  // Detect dead TCP connections (laptop sleep, network change).
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.ctx.alive) {
        ws.terminate();
        continue;
      }
      ws.ctx.alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, CONFIG.wsPingIntervalMs);

  // Expire idle rooms.
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (now - room.lastActivity > CONFIG.roomIdleMs) {
        broadcast(room, 'error', { code: 'ROOM_EXPIRED', message: 'This party expired after being idle.' });
        deleteRoom(room, 'idle');
      }
    }
  }, CONFIG.sweepIntervalMs);

  server.on('close', () => {
    clearInterval(pingTimer);
    clearInterval(sweepTimer);
  });

  return { server, wss };
}

if (require.main === module) {
  const { server } = createServer();
  server.listen(CONFIG.port, () => {
    log(`Tandem server v${SERVER_VERSION} listening on :${CONFIG.port}`);
    log(CONFIG.partyKey
      ? 'party key: required ✓ (only people with the key can join)'
      : 'party key: NOT set, so anyone who knows this address can use it. Add PARTY_KEY=… to server/.env to lock it.');
    const p = turn.provider();
    if (!p) {
      log('video call relay (TURN): NOT configured. Calls may stay on "Connecting…" between different networks. Run ./scripts/setup-turn.sh');
      return;
    }
    turn.getIceServers().then((servers) => {
      const st = turn.status();
      if (!servers.length) {
        log(`video call relay (TURN): ${p}, FAILED: ${st.lastError}. Check server/.env or rerun ./scripts/setup-turn.sh`);
        return;
      }
      // Log in to the relay once, so wrong credentials show up here and not as a stuck call.
      require('./turn-check').checkIceServers(servers).then(({ ok, results }) => {
        const tested = results.filter((r) => !r.skipped);
        if (ok || !tested.length) log(`video call relay (TURN): ${p}, ready ✓`);
        else log(`video call relay (TURN): ${p}, login FAILED (${tested[0].error}). Rerun ./scripts/setup-turn.sh`);
      });
    });
  });
  const shutdown = () => {
    log('shutting down');
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, rooms, CONFIG, ROOM_ALPHABET };
