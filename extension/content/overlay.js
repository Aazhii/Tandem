'use strict';

/**
 * Chat overlay: collapsible sidebar rendered inside a closed Shadow DOM so site CSS can't touch it.
 * Only mounted in the top frame of the party tab. Also hosts:
 *   - floating emoji reactions (over the video, fullscreen included)
 *   - the video call (an extension iframe) — docked at the top of the sidebar or floating/draggable
 *   - the "Join party?" card for invite links (WP.invite)
 *
 * Security: user-provided text is only ever assigned via textContent — never innerHTML.
 */
(() => {
  const WP = (globalThis.__watchParty = globalThis.__watchParty || {});
  if (WP.overlay) return;

  const MAX_MESSAGES = 200;
  const HOST_ID = 'watch-party-overlay-host';
  const INVITE_HOST_ID = 'watch-party-invite-host';
  const DEFAULT_PANEL_WIDTH = 320;
  const MIN_PANEL_WIDTH = 260;
  const MAX_PANEL_WIDTH = 640;
  const PAGE_STYLE_ID = 'watch-party-page-style';
  const CALL_NS = 'watch-party-call';
  const REACTIONS = ['😂', '❤️', '😮', '😢', '👏', '🔥', '😡', '👍', '💀', '🎉'];
  const PICKER_EMOJIS = [
    '😀', '😁', '😂', '🤣', '😊', '😍', '🥰', '😘', '😎', '🤩', '🥳', '😏',
    '😮', '😱', '😳', '🥺', '😢', '😭', '😤', '😡', '🤯', '🤔', '🙄', '😴',
    '🤢', '💀', '👻', '🤡', '👍', '👎', '👏', '🙌', '🙏', '💪', '👀', '🫶',
    '❤️', '💔', '🔥', '✨', '🎉', '💯', '🍿', '🎬', '📺', '⭐', '⚡', '☕',
  ];

  let hostEl = null;
  let root = null;
  let els = null;
  let open = true;
  let unread = 0;
  let handlers = {};
  let membersKey = '';
  let lastState = null;
  const typers = new Map(); // id -> { nickname, timer }
  let typingActive = false;
  let typingTimer = null;
  let panelWidth = DEFAULT_PANEL_WIDTH;
  let pageFs = null; // { target, addedPopover } while the page is fullscreen with the player beside the chat
  let fitTimer = null;
  const fitted = new Map(); // element -> original inline max-width/min-width (restored when the chat closes)

  // Video call container state
  const call = {
    container: null,
    iframe: null,
    count: 0,
    mode: 'dock', // 'dock' | 'float'
    rect: null, // float position { x, y, w, h }
    layoutTimers: [],
    dockH: null, // user-chosen docked height (px); null = automatic
  };

  chrome.storage.local.get(['callLayout', 'panelWidth']).then(({ callLayout, panelWidth: pw }) => {
    if (callLayout && (callLayout.mode === 'dock' || callLayout.mode === 'float')) call.mode = callLayout.mode;
    if (callLayout && callLayout.rect) call.rect = callLayout.rect;
    if (callLayout && Number.isFinite(callLayout.dockH)) call.dockH = callLayout.dockH;
    if (Number.isFinite(pw)) setPanelWidth(pw, false);
  }).catch(() => {});

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(className, text, title) {
    const b = el('button', className, text);
    b.type = 'button';
    if (title) {
      b.title = title;
      b.setAttribute('aria-label', title);
    }
    return b;
  }

  function formatClock(ts) {
    const d = new Date(ts || Date.now());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function loadStyles(shadow) {
    const url = chrome.runtime.getURL('content/overlay.css');
    try {
      const css = await (await fetch(url)).text();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      shadow.prepend(link);
    }
  }

  /** Keep keystrokes typed into the chat from triggering site shortcuts (space, k, f, arrows…). */
  function isolateKeys(node) {
    for (const type of ['keydown', 'keyup', 'keypress']) {
      node.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  function build() {
    // A previous copy of the extension (before a reload) may have left its overlay behind.
    const stale = document.getElementById(HOST_ID);
    if (stale) stale.remove();
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    // Inline styles on the host so page CSS can't hide or shift it.
    hostEl.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; width: 0; height: 100%; z-index: 2147483647; pointer-events: none;';
    root = hostEl.attachShadow({ mode: 'closed' });
    loadStyles(root);
    isolateKeys(hostEl);

    // Reactions layer (full viewport, never blocks clicks)
    const fx = el('div', 'wp-fx');

    const wrap = el('div', 'wp');
    const tab = button('wp-tab', null, 'Toggle Watch Party chat');
    const tabIcon = el('span', 'wp-tab-icon', '💬');
    const badge = el('span', 'wp-badge');
    badge.hidden = true;
    tab.append(tabIcon, badge);

    const panel = el('aside', 'wp-panel');
    panel.setAttribute('aria-label', 'Watch Party chat');

    // Header
    const header = el('header', 'wp-header');
    const titleBox = el('div', 'wp-title-box');
    const title = el('div', 'wp-title', 'Watch Party');
    const sub = el('div', 'wp-sub');
    titleBox.append(title, sub);
    const callBtn = button('wp-icon-btn wp-call-btn', '📹', 'Video call');
    const callCount = el('span', 'wp-call-count');
    callCount.hidden = true;
    callBtn.append(callCount);
    const close = button('wp-icon-btn wp-close', '›', 'Hide chat');
    header.append(titleBox, callBtn, close);

    // Space reserved for the docked video call
    const callSlot = el('div', 'wp-call-slot');

    const members = el('div', 'wp-members');
    const messages = el('div', 'wp-messages');
    messages.setAttribute('role', 'log');
    messages.setAttribute('aria-live', 'polite');

    const typing = el('div', 'wp-typing');

    // Reaction bar
    const reactBar = el('div', 'wp-reactions');
    for (const emoji of REACTIONS) {
      const b = button('wp-react', emoji, `React ${emoji}`);
      b.addEventListener('click', () => {
        spawnReaction({ emoji, nickname: 'You', self: true });
        if (handlers.onReaction) handlers.onReaction(emoji);
      });
      reactBar.append(b);
    }

    // Emoji picker (inserts into the message)
    const picker = el('div', 'wp-picker');
    picker.hidden = true;
    for (const emoji of PICKER_EMOJIS) {
      const b = button('wp-pick', emoji);
      b.addEventListener('click', () => insertEmoji(emoji));
      picker.append(b);
    }

    const form = el('form', 'wp-form');
    const emojiBtn = button('wp-emoji-btn', '😊', 'Emoji');
    const input = el('input', 'wp-input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'Say something…';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Chat message');
    const send = el('button', 'wp-send', 'Send');
    send.type = 'submit';
    form.append(emojiBtn, input, send);

    const panelGrip = el('div', 'wp-panel-resize');
    panelGrip.title = 'Drag to make the chat wider or narrower';
    panel.append(panelGrip, header, callSlot, members, messages, typing, picker, reactBar, form);
    wrap.append(tab, panel);
    root.append(fx, wrap);

    tab.addEventListener('click', () => setOpen(!open));
    close.addEventListener('click', () => setOpen(false));
    callBtn.addEventListener('click', () => {
      if (lastState && lastState.callUiOpen) {
        // Already in the call: bring it into view (undock if the chat is closed).
        setOpen(true);
      } else if (handlers.onAction) {
        handlers.onAction('call_open');
      }
    });
    emojiBtn.addEventListener('click', () => {
      picker.hidden = !picker.hidden;
    });
    input.addEventListener('input', onTypingInput);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      picker.hidden = true;
      stopTyping();
      if (handlers.onSend) handlers.onSend(text);
    });

    els = { fx, wrap, tab, badge, panel, sub, members, messages, input, typing, picker, callBtn, callCount, callSlot };
    wrap.style.setProperty('--wp-width', `${panelWidth}px`);
    enablePanelResize(panelGrip);
    new ResizeObserver(() => layoutCall()).observe(members);
    window.addEventListener('resize', onResize);
    window.addEventListener('message', onCallMessage);
    setOpen(open);
  }

  function onResize() {
    layoutCall();
    scheduleFit();
  }

  // -------------------------------------------------------------------------
  // Page layout: shrink the page/player so the chat sits beside the video (no overlap)
  // -------------------------------------------------------------------------

  function ensurePageStyle() {
    if (document.getElementById(PAGE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = PAGE_STYLE_ID;
    style.textContent = `
html[data-wp-squeeze] { width: calc(100% - var(--wp-squeeze, 0px)) !important; min-width: 0 !important; }
html[data-wp-pagefs] { overflow: hidden !important; }
html[data-wp-pagefs] [data-wp-fs-target] {
  position: fixed !important; inset: 0 auto auto 0 !important;
  width: calc(100vw - var(--wp-squeeze, 0px)) !important; height: 100vh !important;
  max-width: none !important; max-height: none !important; min-width: 0 !important; min-height: 0 !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important;
  transform: none !important; translate: none !important; scale: none !important;
  display: block !important; visibility: visible !important; opacity: 1 !important; overflow: hidden !important;
  background: #000 !important; z-index: 2147483646 !important; box-shadow: none !important;
}`;
    document.documentElement.append(style);
  }

  function squeezeWidth() {
    return hostEl && open ? panelWidth : 0;
  }

  /** Apply the current chat width to the page (call after open/close/resize of the chat). */
  function applySqueeze() {
    const de = document.documentElement;
    const w = squeezeWidth();
    const was = de.style.getPropertyValue('--wp-squeeze');
    if (w > 0) {
      ensurePageStyle();
      de.style.setProperty('--wp-squeeze', `${w}px`);
      de.setAttribute('data-wp-squeeze', '');
    } else {
      de.style.removeProperty('--wp-squeeze');
      de.removeAttribute('data-wp-squeeze');
      unfitAll();
    }
    if (was !== (w > 0 ? `${w}px` : '')) {
      // Let players recompute their size, then shrink anything still wider than the free space.
      window.dispatchEvent(new Event('resize'));
      scheduleFit();
      setTimeout(fitPlayer, 300);
    }
  }

  /** The element that shows the movie in this document: the biggest <video>, else the biggest player iframe. */
  function findPlayer() {
    const area = (n) => {
      const r = n.getBoundingClientRect();
      return r.width >= 200 && r.height >= 112 ? r.width * r.height : 0;
    };
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const a = area(v);
      if (a > bestArea) { best = v; bestArea = a; }
    }
    if (best) return best;
    for (const f of document.querySelectorAll('iframe')) {
      if (f.closest(`#${HOST_ID}`)) continue;
      const a = area(f);
      if (a > bestArea) { best = f; bestArea = a; }
    }
    return best;
  }

  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitPlayer, 150);
  }

  /** Cap the player and its containers at the free width left of the chat. */
  function fitPlayer() {
    if (!hostEl || pageFs || squeezeWidth() === 0) return;
    const avail = window.innerWidth - squeezeWidth();
    const player = findPlayer();
    for (let n = player; n && n !== document.documentElement && n !== document.body; n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right <= avail + 1 && !fitted.has(n)) continue;
      const max = Math.max(160, Math.floor(avail - Math.max(0, r.left)));
      if (!fitted.has(n)) {
        fitted.set(n, {
          maxW: [n.style.getPropertyValue('max-width'), n.style.getPropertyPriority('max-width')],
          minW: [n.style.getPropertyValue('min-width'), n.style.getPropertyPriority('min-width')],
        });
      }
      n.style.setProperty('max-width', `${max}px`, 'important');
      n.style.setProperty('min-width', '0px', 'important');
    }
  }

  function unfitAll() {
    for (const [n, o] of fitted) {
      n.style.removeProperty('max-width');
      n.style.removeProperty('min-width');
      if (o.maxW[0]) n.style.setProperty('max-width', o.maxW[0], o.maxW[1]);
      if (o.minW[0]) n.style.setProperty('min-width', o.minW[0], o.minW[1]);
    }
    fitted.clear();
  }

  function setPanelWidth(w, save = true) {
    panelWidth = Math.round(Math.max(MIN_PANEL_WIDTH, Math.min(w, MAX_PANEL_WIDTH, window.innerWidth - 240)));
    if (els) els.wrap.style.setProperty('--wp-width', `${panelWidth}px`);
    applySqueeze();
    layoutCall();
    if (save) chrome.storage.local.set({ panelWidth }).catch(() => {});
  }

  /** Drag the chat's left edge to resize it (a bigger sidebar = a bigger docked video call). */
  function enablePanelResize(grip) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      if (call.iframe) call.iframe.style.pointerEvents = 'none';
      els.wrap.classList.add('wp-resizing');
      const move = (ev) => {
        panelWidth = Math.round(Math.max(MIN_PANEL_WIDTH, Math.min(window.innerWidth - ev.clientX, MAX_PANEL_WIDTH, window.innerWidth - 240)));
        els.wrap.style.setProperty('--wp-width', `${panelWidth}px`);
        layoutCall();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        els.wrap.classList.remove('wp-resizing');
        if (call.iframe) call.iframe.style.pointerEvents = '';
        setPanelWidth(panelWidth);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }

  // -------------------------------------------------------------------------
  // Fullscreen: the whole page goes fullscreen with the player beside the chat
  // -------------------------------------------------------------------------

  function raiseToTopLayer(node, wasPopover) {
    if (!node.hasAttribute('popover')) node.setAttribute('popover', 'manual');
    try {
      if (node.matches(':popover-open')) node.hidePopover();
      node.showPopover();
    } catch { /* not supported / not connected */ }
    return wasPopover;
  }

  function lowerFromTopLayer(node, keepAttr) {
    try {
      if (node.matches(':popover-open')) node.hidePopover();
    } catch { /* ignore */ }
    if (!keepAttr) node.removeAttribute('popover');
  }

  /** Called when the site asks to make `target` (player div / iframe / video) fullscreen. */
  async function togglePageFullscreen(target) {
    if (!hostEl || !target || !target.isConnected) return false;
    const de = document.documentElement;
    if (pageFs && document.fullscreenElement === de) {
      // The player's fullscreen button works as a toggle.
      try { await document.exitFullscreen(); } catch { /* ignore */ }
      return true;
    }
    try {
      if (document.fullscreenElement !== de) await de.requestFullscreen({ navigationUI: 'hide' });
    } catch (err) {
      WP.overlay.addSystem('Chrome blocked fullscreen. Click the fullscreen button once more.');
      return false;
    }
    ensurePageStyle();
    unfitAll();
    pageFs = { target, hadPopover: target.hasAttribute('popover') };
    de.setAttribute('data-wp-pagefs', '');
    target.setAttribute('data-wp-fs-target', '');
    // Top layer: escapes any site container/transform, then the chat goes above it.
    raiseToTopLayer(target);
    raiseToTopLayer(hostEl);
    window.dispatchEvent(new Event('resize'));
    relayoutSoon();
    return true;
  }

  function exitPageFullscreen() {
    if (!pageFs) return;
    const { target, hadPopover } = pageFs;
    pageFs = null;
    document.documentElement.removeAttribute('data-wp-pagefs');
    if (target) {
      target.removeAttribute('data-wp-fs-target');
      lowerFromTopLayer(target, hadPopover);
    }
    if (hostEl) lowerFromTopLayer(hostEl, false);
    window.dispatchEvent(new Event('resize'));
    scheduleFit();
    relayoutSoon();
  }

  function insertEmoji(emoji) {
    const input = els.input;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = (input.value.slice(0, start) + emoji + input.value.slice(end)).slice(0, 500);
    const pos = Math.min(start + emoji.length, input.value.length);
    input.focus();
    input.setSelectionRange(pos, pos);
  }

  function onTypingInput() {
    if (!els.input.value.trim()) {
      stopTyping();
      return;
    }
    if (!typingActive) {
      typingActive = true;
      if (handlers.onTyping) handlers.onTyping(true);
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 2500);
  }

  function stopTyping() {
    clearTimeout(typingTimer);
    if (typingActive) {
      typingActive = false;
      if (handlers.onTyping) handlers.onTyping(false);
    }
  }

  function setOpen(value) {
    open = value;
    if (!els) return;
    els.wrap.classList.toggle('wp-collapsed', !open);
    if (open) {
      unread = 0;
      els.badge.hidden = true;
      els.messages.scrollTop = els.messages.scrollHeight;
    }
    // The panel slides for ~220ms; keep the docked call glued to it.
    relayoutSoon();
    applySqueeze();
  }

  function mountTarget() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    // A fullscreened <video>/<iframe> can't render children; fall back to the document.
    if (fs && !/^(VIDEO|IFRAME|IMG|CANVAS)$/.test(fs.tagName)) return fs;
    return document.documentElement;
  }

  function place() {
    if (!hostEl) return;
    const target = mountTarget();
    if (hostEl.parentNode === target) return;
    // moveBefore() keeps the video-call iframe alive across the move (appendChild would reload it).
    if (hostEl.isConnected && typeof target.moveBefore === 'function') {
      try {
        target.moveBefore(hostEl, null);
        layoutCall();
        return;
      } catch { /* fall through */ }
    }
    target.appendChild(hostEl);
    layoutCall();
  }

  function onFullscreenChange() {
    if (pageFs && document.fullscreenElement !== document.documentElement) exitPageFullscreen();
    if (pageFs) {
      raiseToTopLayer(hostEl); // stay above anything the site put in the top layer
    } else {
      place(); // fallback: site fullscreen we didn't take over (chat moves inside it when possible)
    }
    setTimeout(layoutCall, 100);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  let replaying = false;

  function addMessage(node) {
    if (!els) return;
    const box = els.messages;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.append(node);
    while (box.childElementCount > MAX_MESSAGES) box.firstElementChild.remove();
    if (nearBottom || open || replaying) box.scrollTop = box.scrollHeight;
    if (!open && !replaying) {
      unread++;
      els.badge.textContent = unread > 9 ? '9+' : String(unread);
      els.badge.hidden = false;
    }
  }

  function renderTyping() {
    if (!els) return;
    const names = [...typers.values()].map((t) => t.nickname);
    let text = '';
    if (names.length === 1) text = `${names[0]} is typing…`;
    else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
    else if (names.length > 2) text = 'Several people are typing…';
    els.typing.textContent = text;
    els.typing.classList.toggle('wp-typing-on', !!text);
  }

  // -------------------------------------------------------------------------
  // Floating reactions
  // -------------------------------------------------------------------------

  function spawnReaction({ emoji, nickname, avatar, self }) {
    if (!els) return;
    if (els.fx.childElementCount > 40) els.fx.firstElementChild.remove();
    const vw = window.innerWidth;
    const usable = open ? vw - panelWidth : vw;
    const x = usable * (0.55 + Math.random() * 0.38);
    const node = el('div', 'wp-float');
    node.style.left = `${Math.round(x)}px`;
    node.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 80)}px`);
    node.style.setProperty('--dur', `${(2.4 + Math.random() * 0.8).toFixed(2)}s`);
    node.append(el('span', 'wp-float-emoji', emoji));
    const who = el('span', 'wp-float-name', self ? 'You' : `${avatar ? avatar + ' ' : ''}${nickname || ''}`);
    node.append(who);
    node.addEventListener('animationend', () => node.remove());
    els.fx.append(node);
  }

  // -------------------------------------------------------------------------
  // Video call container (dock in the sidebar / float anywhere)
  // -------------------------------------------------------------------------

  function saveLayout() {
    chrome.storage.local.set({ callLayout: { mode: call.mode, rect: call.rect, dockH: call.dockH } }).catch(() => {});
  }

  function showCall() {
    if (call.container || !root) return;
    const box = el('div', 'wp-callbox');
    const bar = el('div', 'wp-callbar');
    const grip = el('span', 'wp-callbar-grip', '⠿ Video call');
    const toggle = button('wp-callbar-btn', '', 'Float / dock');
    bar.append(grip, toggle);
    const iframe = document.createElement('iframe');
    iframe.className = 'wp-call-frame';
    iframe.src = chrome.runtime.getURL('call/call.html');
    iframe.setAttribute('allow', 'camera *; microphone *; autoplay *');
    iframe.title = 'Watch Party video call';
    const resize = el('div', 'wp-callresize');
    resize.title = 'Resize';
    const dockResize = el('div', 'wp-dockresize');
    dockResize.title = 'Drag to make the video bigger or smaller';
    box.append(iframe, bar, resize, dockResize);
    root.append(box);
    call.container = box;
    call.iframe = iframe;
    call.toggle = toggle;
    toggle.addEventListener('click', toggleCallLayout);
    enableDrag(bar);
    enableResize(resize);
    enableDockResize(dockResize);
    relayoutSoon();
  }

  /** Docked: drag the bottom edge to make the call taller (bigger faces) or shorter (more chat). */
  function enableDockResize(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || effectiveMode() !== 'dock') return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      if (call.iframe) call.iframe.style.pointerEvents = 'none';
      const startY = e.clientY;
      const startH = dockHeight();
      const move = (ev) => {
        call.dockH = Math.max(MIN_DOCK_H, Math.min(startH + ev.clientY - startY, maxDockHeight()));
        layoutCall();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (call.iframe) call.iframe.style.pointerEvents = '';
        saveLayout();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => {
      call.dockH = null; // back to automatic size
      layoutCall();
      saveLayout();
    });
  }

  function hideCall() {
    if (!call.container) return;
    call.container.remove();
    call.container = null;
    call.iframe = null;
    call.count = 0;
    if (els) els.callSlot.style.height = '0px';
  }

  function toggleCallLayout() {
    call.mode = effectiveMode() === 'dock' ? 'float' : 'dock';
    if (call.mode === 'dock' && !open) setOpen(true);
    saveLayout();
    relayoutSoon();
  }

  /** Lay out now and again over the next frames (panel slide / slot resize settle). */
  function relayoutSoon() {
    for (const t of call.layoutTimers) clearTimeout(t);
    call.layoutTimers = [0, 50, 120, 250, 400].map((ms) => setTimeout(layoutCall, ms));
  }

  function effectiveMode() {
    return call.mode === 'dock' && open ? 'dock' : 'float';
  }

  function defaultFloatRect() {
    const w = 320;
    const h = 180;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return { x: vw - w - (open ? panelWidth : 0) - 24, y: vh - h - 96, w, h };
  }

  function clampRect(r) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.max(200, Math.min(r.w, vw - 16));
    const h = Math.max(112, Math.min(r.h, vh - 16));
    return { x: Math.max(8, Math.min(r.x, vw - w - 8)), y: Math.max(8, Math.min(r.y, vh - h - 8)), w, h };
  }

  const MIN_DOCK_H = 110;

  function maxDockHeight() {
    return Math.round(window.innerHeight * 0.85);
  }

  function dockHeight() {
    if (Number.isFinite(call.dockH)) return Math.round(Math.max(MIN_DOCK_H, Math.min(call.dockH, maxDockHeight())));
    const n = Math.max(call.count, 1);
    const per = Math.round((panelWidth * 9) / 16); // 180 for a 16:9 tile at a 320px sidebar
    const want = n === 1 ? per : per * 2;
    return Math.min(want, Math.round(window.innerHeight * 0.55));
  }

  function layoutCall() {
    if (!call.container || !els) return;
    const box = call.container;
    const mode = effectiveMode();
    box.classList.toggle('wp-docked', mode === 'dock');
    box.classList.toggle('wp-floating', mode === 'float');
    if (call.toggle) {
      call.toggle.textContent = mode === 'dock' ? '⇱ Float' : '⇥ Dock';
    }
    if (mode === 'dock') {
      els.callSlot.style.height = `${dockHeight()}px`;
      const r = els.callSlot.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    } else {
      els.callSlot.style.height = '0px';
      call.rect = clampRect(call.rect || defaultFloatRect());
      const r = call.rect;
      Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    }
  }

  /** While dragging over an iframe, pointer events would vanish into it — disable them temporarily. */
  function withPointerCapture(handle, onMove, onEnd) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || effectiveMode() !== 'float' || e.target.closest('button')) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      if (call.iframe) call.iframe.style.pointerEvents = 'none';
      const start = { x: e.clientX, y: e.clientY, rect: { ...call.rect } };
      const move = (ev) => {
        onMove(ev.clientX - start.x, ev.clientY - start.y, start.rect);
        layoutCall();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (call.iframe) call.iframe.style.pointerEvents = '';
        if (onEnd) onEnd();
        saveLayout();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  function enableDrag(bar) {
    withPointerCapture(bar, (dx, dy, r) => {
      call.rect = { ...r, x: r.x + dx, y: r.y + dy };
    });
  }

  function enableResize(handle) {
    // Bottom-left corner: drag left/down to grow (the box usually sits near the right edge).
    withPointerCapture(handle, (dx, dy, r) => {
      const w = Math.max(200, r.w - dx);
      call.rect = { x: r.x + (r.w - w), y: r.y, w, h: Math.max(112, r.h + dy) };
    });
  }

  function onCallMessage(e) {
    if (!call.iframe || e.source !== call.iframe.contentWindow) return;
    const d = e.data;
    if (!d || d.ns !== CALL_NS) return;
    if (d.cmd === 'count' && Number.isInteger(d.n)) {
      if (d.n !== call.count) {
        call.count = d.n;
        relayoutSoon();
      }
    } else if (d.cmd === 'toggle_layout') {
      toggleCallLayout();
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  WP.overlay = {
    /** handlers: { onSend(text), onReaction(emoji), onTyping(active), onAction(id) } */
    mount(h) {
      handlers = h || {};
      if (!hostEl) {
        build();
        document.addEventListener('fullscreenchange', onFullscreenChange);
        document.addEventListener('webkitfullscreenchange', onFullscreenChange);
        fitTimer = setTimeout(fitPlayer, 500);
        WP.overlay._fitInterval = setInterval(fitPlayer, 1500); // SPA players re-render
      }
      place();
      applySqueeze();
    },

    togglePageFullscreen,

    unmount() {
      if (!hostEl) return;
      hideCall();
      if (pageFs && document.fullscreenElement === document.documentElement) document.exitFullscreen().catch(() => {});
      exitPageFullscreen();
      clearInterval(WP.overlay._fitInterval);
      clearTimeout(fitTimer);
      document.documentElement.style.removeProperty('--wp-squeeze');
      document.documentElement.removeAttribute('data-wp-squeeze');
      unfitAll();
      window.dispatchEvent(new Event('resize'));
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('message', onCallMessage);
      stopTyping();
      for (const t of typers.values()) clearTimeout(t.timer);
      typers.clear();
      hostEl.remove();
      hostEl = null;
      root = null;
      els = null;
      unread = 0;
      membersKey = '';
      lastState = null;
    },

    isMounted() {
      return !!hostEl;
    },

    /** Re-attach if a SPA re-render removed us. */
    ensureAttached() {
      if (hostEl && !hostEl.isConnected) place();
    },

    setState(state) {
      if (!els) return;
      lastState = state;
      const list = state.members || [];
      const conn = state.connected ? '' : ' · reconnecting…';
      els.sub.textContent = `Room ${state.roomId} · ${list.length} watching${conn}`;

      // Members (re-render only on change)
      const key = JSON.stringify(list.map((m) => [m.id, m.nickname, m.avatar, m.isHost, m.connected, m.inCall]));
      if (key !== membersKey) {
        membersKey = key;
        els.members.replaceChildren();
        for (const m of list) {
          const chip = el('span', 'wp-chip');
          if (!m.connected) chip.classList.add('wp-chip-off');
          chip.append(el('span', 'wp-chip-avatar', m.avatar || '🙂'));
          chip.append(document.createTextNode(m.id === state.clientId ? `${m.nickname} (you)` : m.nickname));
          if (m.isHost) chip.append(el('span', 'wp-crown', '👑'));
          if (m.inCall) chip.append(el('span', 'wp-chip-call', '📹'));
          els.members.append(chip);
        }
      }

      // Call button + call UI
      const inCallOthers = list.filter((m) => m.inCall && m.id !== state.clientId).length;
      els.callCount.textContent = String(inCallOthers);
      els.callCount.hidden = !(inCallOthers > 0 && !state.callUiOpen);
      els.callBtn.classList.toggle('wp-call-live', inCallOthers > 0 && !state.callUiOpen);
      els.callBtn.classList.toggle('wp-call-active', !!state.callUiOpen);
      els.callBtn.title = state.callUiOpen ? 'Video call (open)' : inCallOthers ? `Join video call (${inCallOthers} in call)` : 'Start a video call';

      if (state.callUiOpen && state.callMode !== 'window') showCall();
      else hideCall();

      // Drop typing indicators for people who left.
      for (const id of [...typers.keys()]) {
        if (!list.some((m) => m.id === id)) {
          clearTimeout(typers.get(id).timer);
          typers.delete(id);
        }
      }
      renderTyping();
    },

    addChat({ nickname, text, at, self, avatar }) {
      const row = el('div', self ? 'wp-msg wp-self' : 'wp-msg');
      const meta = el('div', 'wp-meta');
      meta.append(el('span', 'wp-avatar', avatar || '🙂'), el('span', 'wp-name', nickname), el('span', 'wp-time', formatClock(at)));
      row.append(meta, el('div', 'wp-text', text));
      addMessage(row);
    },

    /** action: optional { id, label } → renders a button that calls handlers.onAction(id). */
    addSystem(text, action) {
      const row = el('div', 'wp-system', text);
      if (action && action.id && action.label) {
        if (action.id === 'follow_host' && els) {
          // Only the latest "Go there" prompt is useful.
          for (const old of els.messages.querySelectorAll('.wp-action[data-action="follow_host"]')) old.remove();
        }
        const b = button('wp-action', action.label);
        b.dataset.action = action.id;
        b.addEventListener('click', () => {
          if (handlers.onAction) handlers.onAction(action.id);
          b.disabled = true;
        });
        row.append(document.createElement('br'), b);
      }
      addMessage(row);
    },

    addReaction(data) {
      spawnReaction(data);
    },

    /** Replace the message list with the saved history (after a page change). */
    loadHistory(list) {
      if (!els) return;
      replaying = true;
      els.messages.replaceChildren();
      for (const entry of list.slice(-MAX_MESSAGES)) {
        if (entry && entry.type === 'chat' && entry.data) WP.overlay.addChat(entry.data);
        else if (entry && entry.type === 'system' && typeof entry.text === 'string') WP.overlay.addSystem(entry.text);
      }
      replaying = false;
      els.messages.scrollTop = els.messages.scrollHeight;
    },

    setTyping({ from, nickname, active }) {
      const prev = typers.get(from);
      if (prev) clearTimeout(prev.timer);
      if (active) {
        typers.set(from, { nickname, timer: setTimeout(() => { typers.delete(from); renderTyping(); }, 6000) });
      } else {
        typers.delete(from);
      }
      renderTyping();
    },
  };

  // -------------------------------------------------------------------------
  // Invite link card: "Join Alice's party?" (shown when opening …#watchparty=CODE)
  // -------------------------------------------------------------------------

  let inviteHost = null;

  WP.invite = {
    show({ roomId, nickname, onJoin }) {
      if (inviteHost) return;
      const stale = document.getElementById(INVITE_HOST_ID);
      if (stale) stale.remove();
      inviteHost = document.createElement('div');
      inviteHost.id = INVITE_HOST_ID;
      inviteHost.style.cssText = 'all: initial; position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;';
      const shadow = inviteHost.attachShadow({ mode: 'closed' });
      loadStyles(shadow);
      isolateKeys(inviteHost);

      const card = el('form', 'wp-invite');
      const head = el('div', 'wp-invite-head');
      head.append(el('span', 'wp-invite-icon', '🎬'));
      const t = el('div', 'wp-invite-title');
      t.append(el('div', 'wp-title', 'Watch Party'), el('div', 'wp-sub', `You're invited to party ${roomId}`));
      head.append(t);
      const x = button('wp-icon-btn', '✕', 'Dismiss');
      head.append(x);
      const input = el('input', 'wp-input');
      input.type = 'text';
      input.maxLength = 24;
      input.placeholder = 'Your nickname';
      input.value = nickname || '';
      input.setAttribute('aria-label', 'Your nickname');
      const join = el('button', 'wp-send wp-invite-join', 'Join party');
      join.type = 'submit';
      const err = el('div', 'wp-invite-err');
      card.append(head, input, join, err);
      shadow.append(card);
      document.documentElement.appendChild(inviteHost);
      setTimeout(() => input.focus(), 50);

      x.addEventListener('click', () => WP.invite.hide());
      card.addEventListener('submit', async (e) => {
        e.preventDefault();
        join.disabled = true;
        join.textContent = 'Joining…';
        err.textContent = '';
        const res = await onJoin(input.value.trim());
        if (res && res.ok) {
          WP.invite.hide();
        } else {
          join.disabled = false;
          join.textContent = 'Join party';
          err.textContent = (res && res.error) || 'Could not join the party.';
        }
      });
    },
    hide() {
      if (inviteHost) inviteHost.remove();
      inviteHost = null;
    },
  };
})();
