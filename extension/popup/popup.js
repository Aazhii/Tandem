'use strict';

/** Watch Party popup. All state lives in the background worker; this only renders it. */

const $ = (id) => document.getElementById(id);
const ROOM_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const STATUS_TEXT = {
  idle: 'Offline',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
};
const AVATARS = ['🦊', '🐼', '🐯', '🐸', '🐵', '🦁', '🐨', '🐙', '🦄', '🐧', '🐶', '🐱', '🐰', '🐻', '🐲', '👽', '🤖', '👻', '🎃', '🙂'];

let state = null;
let activeTab = null;
let busy = false;
let avatar = AVATARS[Math.floor(Math.random() * 16)];
let editAvatar = avatar;

function bg(cmd, payload = {}) {
  return chrome.runtime.sendMessage({ cmd, ...payload });
}

function isSyncableUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function renderAvatarPicker(container, selected, onPick) {
  container.replaceChildren();
  for (const a of AVATARS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-opt';
    b.textContent = a;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(a === selected));
    b.addEventListener('click', () => {
      onPick(a);
      renderAvatarPicker(container, a, onPick);
    });
    container.append(b);
  }
}

function buildInvite(code, url) {
  let link = '';
  if (url && /^https?:/i.test(url)) {
    try {
      const u = new URL(url);
      u.hash = `watchparty=${code}`;
      link = u.toString();
    } catch { /* ignore */ }
  }
  return [
    '🎬 Join my Watch Party!',
    link ? `Open this link (with the Watch Party extension installed): ${link}` : 'Open the same video as me.',
    `Or click the Watch Party icon → enter code ${code} → Join`,
  ].join('\n');
}

function showError(text) {
  $('error-text').textContent = text || '';
  $('error').hidden = !text;
}

function getNickname() {
  let name = $('nickname').value.trim().replace(/\s+/g, ' ').slice(0, 24);
  if (!name) {
    name = `Viewer${Math.floor(1000 + Math.random() * 9000)}`;
    $('nickname').value = name;
  }
  chrome.storage.local.set({ nickname: name, avatar });
  return name;
}

function setBusy(value, label) {
  busy = value;
  $('create').disabled = value || !isSyncableUrl(activeTab && activeTab.url);
  $('join').disabled = value;
  if (label) $('create').dataset.label = label;
  $('create').textContent = value && label ? label : 'Start a party on this tab';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderMembers(s) {
  const list = $('members');
  list.replaceChildren();
  for (const m of s.members || []) {
    const li = document.createElement('li');
    if (!m.connected) li.classList.add('offline');

    const av = document.createElement('span');
    av.className = 'avatar';
    av.textContent = m.avatar || '🙂';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.nickname;

    li.append(av, name);
    if (m.inCall) {
      const call = document.createElement('span');
      call.className = 'incall';
      call.title = 'In the video call';
      call.textContent = m.micOn === false ? '📹🔇' : '📹';
      li.append(call);
    }
    if (m.id === s.clientId) {
      const you = document.createElement('span');
      you.className = 'tag';
      you.textContent = 'you';
      li.append(you);
    }
    if (m.isHost) {
      const host = document.createElement('span');
      host.className = 'tag host';
      host.textContent = 'host';
      li.append(host);
    }
    if (!m.connected) {
      const off = document.createElement('span');
      off.className = 'tag';
      off.textContent = 'reconnecting';
      li.append(off);
    }
    list.append(li);
  }
  $('count').textContent = String((s.members || []).length);
}

function render(s) {
  state = s;
  const status = s.status || 'idle';
  $('status').dataset.status = status;
  $('status-text').textContent = STATUS_TEXT[status] || status;
  $('version').textContent = s.version || '';
  $('server').textContent = s.serverUrl || '';
  $('server').title = `Server: ${s.serverUrl || ''}`;

  $('warning').textContent = s.warning || '';
  $('warning').hidden = !s.warning;
  if (s.lastError) showError(s.lastError);

  $('view-lobby').hidden = s.inRoom;
  $('view-party').hidden = !s.inRoom;

  if (!s.inRoom) {
    const ok = isSyncableUrl(activeTab && activeTab.url);
    $('create').disabled = busy || !ok;
    $('create-hint').textContent = ok ? '' : 'Open a video page (YouTube, Netflix, …) in this tab first.';
    return;
  }

  $('room-code').textContent = s.roomId;
  const otherTab = activeTab && s.tabId !== activeTab.id;
  $('other-tab').hidden = !otherTab;
  $('use-tab').hidden = !(otherTab && isSyncableUrl(activeTab.url));

  const hostOnly = $('host-only');
  hostOnly.checked = !!s.hostOnlyControl;
  hostOnly.disabled = !s.isHost;
  $('host-only-row').classList.toggle('disabled', !s.isHost);
  $('host-only-note').textContent = s.isHost
    ? ''
    : s.hostOnlyControl
      ? 'The host is controlling playback.'
      : 'Anyone can play, pause and seek. Only the host can change this.';

  renderMembers(s);

  // Auto-follow
  $('auto-follow').checked = s.autoFollow !== false;
  $('auto-follow-note').textContent = s.autoFollow !== false
    ? (s.isHost || !s.hostOnlyControl
      ? 'When anyone opens another video or episode, everyone switches to it.'
      : 'When the host opens another video or episode, you switch to it automatically.')
    : 'You\u2019ll get a “Go there” button instead of switching automatically.';

  // Video call
  const others = (s.members || []).filter((m) => m.inCall && m.id !== s.clientId).length;
  const callBtn = $('call-btn');
  if (s.callUiOpen) {
    callBtn.textContent = s.inCall ? '📹 In video call — show it' : '📹 Connecting to call…';
    callBtn.classList.remove('live');
  } else if (others > 0) {
    callBtn.textContent = `📹 Join video call (${others} in call)`;
    callBtn.classList.add('live');
  } else {
    callBtn.textContent = '📹 Start video call';
    callBtn.classList.remove('live');
  }
  $('call-leave').hidden = !s.callUiOpen;
  $('call-hint').textContent = s.callUiOpen
    ? 'Controls are on the video tile: mic, camera, volume, float/dock, leave.'
    : 'Opens in the chat sidebar. You see your friends\u2019 faces — not your own.';
}

async function refresh() {
  try {
    const s = await bg('popup_get_state');
    if (s) {
      state = s;
      render(s);
    }
  } catch (err) {
    showError(`Extension error: ${err.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function createParty() {
  if (busy || !activeTab) return;
  showError('');
  setBusy(true, 'Starting…');
  const res = await bg('popup_create', { nickname: getNickname(), avatar, tabId: activeTab.id }).catch((e) => ({ ok: false, error: String(e) }));
  setBusy(false);
  if (!res || !res.ok) showError((res && res.error) || 'Could not start the party.');
  await refresh();
}

async function joinParty(e) {
  e.preventDefault();
  if (busy || !activeTab) return;
  const code = $('code').value.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(code)) {
    showError('Room codes are 6 characters (letters and numbers, no 0/O/1/I).');
    return;
  }
  if (!isSyncableUrl(activeTab.url)) {
    showError('Open the same video page as your friend in this tab first, then join.');
    return;
  }
  showError('');
  setBusy(true);
  $('join').textContent = 'Joining…';
  const res = await bg('popup_join', { nickname: getNickname(), avatar, tabId: activeTab.id, roomId: code }).catch((err) => ({ ok: false, error: String(err) }));
  setBusy(false);
  $('join').textContent = 'Join';
  if (!res || !res.ok) showError((res && res.error) || 'Could not join the party.');
  await refresh();
}

async function copyInvite() {
  if (!state || !state.roomId) return;
  const s = await bg('popup_get_state');
  const url = (s && s.tabUrl) || (activeTab && activeTab.url) || '';
  const text = buildInvite(state.roomId, url);
  try {
    await navigator.clipboard.writeText(text);
    $('copy').textContent = 'Copied!';
  } catch {
    $('copy').textContent = 'Copy failed';
  }
  setTimeout(() => { $('copy').textContent = 'Copy invite'; }, 1500);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('create').addEventListener('click', createParty);
$('join-form').addEventListener('submit', joinParty);
$('copy').addEventListener('click', copyInvite);
$('leave').addEventListener('click', async () => {
  await bg('popup_leave');
  await refresh();
});
$('host-only').addEventListener('change', async (e) => {
  const res = await bg('popup_set_settings', { hostOnlyControl: e.target.checked });
  if (!res || !res.ok) {
    showError((res && res.error) || 'Not connected — try again in a moment.');
    e.target.checked = !e.target.checked;
  }
});
$('auto-follow').addEventListener('change', async (e) => {
  await bg('popup_set_autofollow', { autoFollow: e.target.checked });
  await refresh();
});
$('go-tab').addEventListener('click', async () => {
  if (!state || state.tabId == null) return;
  try {
    const tab = await chrome.tabs.update(state.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch { /* tab gone */ }
  window.close();
});
$('use-tab').addEventListener('click', async () => {
  if (!activeTab) return;
  await bg('popup_use_tab', { tabId: activeTab.id });
  await refresh();
});
$('call-btn').addEventListener('click', async () => {
  const res = await bg('popup_call_open');
  if (res && res.ok === false) {
    showError(res.error || 'Could not open the call.');
    return;
  }
  // Bring the party tab forward so the call is visible.
  if (state && state.tabId != null) {
    try {
      const tab = await chrome.tabs.update(state.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch { /* ignore */ }
  }
  window.close();
});
$('call-leave').addEventListener('click', async () => {
  await bg('popup_call_leave');
  await refresh();
});
$('edit-profile').addEventListener('click', () => {
  const form = $('profile-edit');
  form.hidden = !form.hidden;
  if (!form.hidden) {
    $('edit-nickname').value = (state && state.nickname) || '';
    editAvatar = (state && state.avatar) || avatar;
    renderAvatarPicker($('edit-avatars'), editAvatar, (a) => { editAvatar = a; });
    $('edit-nickname').focus();
  }
});
$('edit-cancel').addEventListener('click', () => { $('profile-edit').hidden = true; });
$('profile-edit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nickname = $('edit-nickname').value.trim();
  const res = await bg('popup_set_profile', { nickname, avatar: editAvatar });
  if (!res || !res.ok) {
    showError((res && res.error) || 'Could not save.');
    return;
  }
  avatar = editAvatar;
  chrome.storage.local.set({ nickname, avatar });
  $('nickname').value = nickname;
  $('profile-edit').hidden = true;
  await refresh();
});
$('error-dismiss').addEventListener('click', () => {
  showError('');
  bg('popup_clear_error');
});
$('code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
$('nickname').addEventListener('change', () => {
  chrome.storage.local.set({ nickname: $('nickname').value.trim().slice(0, 24) });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.cmd === 'state_changed' && msg.state) render(msg.state);
});

(async () => {
  const [{ nickname, avatar: savedAvatar } = {}, tabs] = await Promise.all([
    chrome.storage.local.get(['nickname', 'avatar']),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  activeTab = tabs[0] || null;
  if (nickname) $('nickname').value = nickname;
  if (savedAvatar && AVATARS.includes(savedAvatar)) avatar = savedAvatar;
  else chrome.storage.local.set({ avatar });
  renderAvatarPicker($('avatars'), avatar, (a) => {
    avatar = a;
    chrome.storage.local.set({ avatar });
  });
  await refresh();
  if (!state || !state.inRoom) ($('nickname').value ? $('code') : $('nickname')).focus();
})();
