# Watch Party

A free, Teleparty-style browser extension that keeps video playback in sync between friends, plus a tiny relay server.

**No video is ever streamed or shared.** Every participant plays the video in their own browser, on their own account. The extension syncs **play / pause / seek / speed** and adds a social layer on top:

- 💬 **Chat sidebar** with avatars, typing indicator ("Alice is typing…") and an emoji picker
- 😂 **Emoji reactions** that float up over the video for everyone (also in fullscreen)
- 📹 **Video + voice call**: you only see your friends' faces, never your own, so the small screen goes to them. Docks into the chat sidebar or floats anywhere over the video (drag + resize). Mic/camera toggles, call volume, and you can pop it out into its own window
- 🔗 **Invite links**: friends open the link and get a "Join party" card on the page
- ➡️ **Follow the host**: when the host switches video or episode, friends get a "Go there" button
- 👑 **Host-only mode**, automatic reconnects, late-join catch-up, drift correction

- Works in **Chrome, Edge, Brave** (Manifest V3, Chromium 116+).
- Works on any site with an HTML5 `<video>`: YouTube, Prime Video, Disney+/Hotstar, Crunchyroll, …, with special handling for **Netflix** and **YouTube**.
- Shared with friends as a **zip folder** and loaded via *Load unpacked* (no Web Store).
- The relay server runs locally or on a free host (Render / Railway / Fly.io).

> ⚠️ Each person needs their **own subscription/account** for the streaming service you're watching. Watch Party doesn't share accounts, bypass DRM, or capture any video/audio.

---

## Repo layout

```
├── extension/                 # the browser extension (load this folder unpacked)
│   ├── manifest.json
│   ├── config.js              # SERVER_URL — edit before zipping
│   ├── background.js          # service worker: owns the WebSocket, routes messages
│   ├── content/
│   │   ├── content.js         # finds the video, hooks events, applies remote commands, drift correction
│   │   ├── overlay.js         # chat sidebar (Shadow DOM)
│   │   ├── overlay.css
│   │   ├── page-bridge.js     # injected into the page MAIN world (Netflix player API)
│   │   └── adapters/          # generic.js, youtube.js, netflix.js
│   ├── call/                  # video call UI (call.html/js/css) + one-time permission page
│   ├── popup/                 # popup.html / popup.js / popup.css
│   └── icons/
├── server/
│   ├── server.js              # Node + ws, in-memory rooms
│   ├── test/protocol.test.js  # automated protocol tests (npm test)
│   ├── package.json
│   └── Dockerfile
├── scripts/
│   ├── start-server.sh        # run the server on this Mac + expose it via ngrok
│   ├── package-extension.sh   # zips extension/ → dist/watch-party-vX.Y.Z.zip
│   └── generate-icons.js      # regenerates the placeholder icons (no deps)
├── render.yaml                # optional Render Blueprint for one-click deploy
└── README.md
```

---

## 1. Run the server locally and test with two Chrome profiles

Requires **Node 20+**.

```bash
cd server
npm install
npm start          # → "Watch Party server listening on :8080"
```

Check it: open <http://localhost:8080/health>. It should say `ok`. Run the automated protocol tests with `npm test`.

`extension/config.js` already points to `ws://localhost:8080`, so you can load the extension straight away:

1. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and select the `extension/` folder.
2. Create a **second Chrome profile** (profile icon (top right) → *Add*). In that profile, load the extension the same way.
3. In both profiles, open the **same YouTube video**.
4. Profile 1: click the Watch Party icon → enter a nickname → **Start a party on this tab** → **Copy invite**.
5. Profile 2: click the icon → enter the room code → **Join**.
6. Play, pause, and seek in either window. The other follows within about a second. Chat from the sidebar on the right.

> Tip: if a tab was already open before you loaded the extension, that's fine: starting or joining a party injects the scripts into the tab automatically.

---

## 2a. Host the server on your own Mac (ngrok): what this project uses

`extension/config.js` points at an ngrok address that forwards to the server on the host's Mac. Each time you want to watch:

```bash
./scripts/start-server.sh
```

This starts the server, keeps the Mac awake, and opens the ngrok tunnel (the domain is read from `SERVER_URL` in `config.js`). Keep the window open while you watch, and press **Ctrl+C** when done. One-time setup: `brew install ngrok`, claim your free dev domain at dashboard.ngrok.com → Domains, then run `ngrok config add-authtoken <token>` with the token **from the same ngrok account**.

## 2b. Or deploy the server to Render (free)

1. Push this repo to GitHub (or GitLab).
2. Go to <https://dashboard.render.com> → **New +** → **Web Service** → connect your repo.
3. Settings:
   - **Root Directory:** `server`
   - **Runtime:** Node
   - **Build Command:** `npm install --omit=dev`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
   - (Advanced) **Health Check Path:** `/health`
4. Click **Create Web Service** and wait for the deploy to show *Live*. Your URL looks like `https://watch-party-xyz.onrender.com`.
5. Open `https://<your-app>.onrender.com/health`. It should say `ok`.
6. Edit **`extension/config.js`** and use the **`wss://`** version of the URL:

   ```js
   const SERVER_URL = 'wss://watch-party-xyz.onrender.com';
   ```

7. Reload the extension on `chrome://extensions` (↻ on the card), then package it (next section).

*Alternative:* **New + → Blueprint** and pick this repo. `render.yaml` sets everything up for you.

**Free-tier notes:** Render's free instances sleep after ~15 minutes without traffic, and the first connection after that takes ~30-60s while it wakes up. The extension keeps retrying, so just wait a moment. Rooms are kept in memory, so a restart clears them, but connected clients automatically recreate and rejoin their room.

**Other hosts:** the `server/Dockerfile` works on Railway, Fly.io (`fly launch` inside `server/`), or any Docker host. The server reads `PORT` from the environment.

---

## 3. Package the extension

```bash
./scripts/package-extension.sh
# → dist/watch-party-v1.0.0.zip
```

The script reads the version from `extension/manifest.json` (it does **not** bump it) and warns you if `SERVER_URL` still points at `localhost`. The zip contains a single folder, `watch-party-vX.Y.Z/`, ready to load.

When you release a new version, bump `"version"` in `extension/manifest.json` first. The version is sent when joining a room. If friends' versions differ in **major.minor** (e.g. 1.0 vs 1.1), they can still join, but the popup and chat show a *"different version — update the extension folder"* warning.

---

## 4. Friend install guide

Send your friend the zip from `dist/`, and tell them:

1. **Unzip** it somewhere **permanent** (e.g. `Documents/watch-party`). Don't delete the folder later: the browser loads the extension from it.
2. Open **`chrome://extensions`** (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** (toggle, top-right; in Edge it's in the left sidebar).
4. Click **Load unpacked** and select the unzipped `watch-party-vX.Y.Z` folder (the one containing `manifest.json`).
5. Pin it: puzzle-piece icon → pin **Watch Party**.
6. Open the same video as the host, click the Watch Party icon, enter the **room code**, click **Join**.

**Updating:** replace the files in that folder with the new zip's contents, then click the **↻ reload** button on the Watch Party card in `chrome://extensions`, and refresh any open video tabs.

> Chrome may show a "Disable developer mode extensions" bubble on startup. Click the ✕ or *Keep*. That's normal for unpacked extensions.

---

## 5. Using it

| | |
|---|---|
| **Start a party** | Open a video → icon → *Start a party on this tab*. You're the host. |
| **Invite** | *Copy invite* copies the code + the current video URL. |
| **Join** | Open the same video → icon → paste code → *Join*. You jump to the host's position. |
| **Host-only mode** | Host toggles *Only host controls playback*. Guests' play/pause/seek is reverted to the host's position (enforced by the server). |
| **Chat** | Sidebar on the right. The page and video shrink to make room, so the chat never covers the movie. Collapse it with `›` (video goes full width again), reopen with the 💬 tab. Drag the chat's left edge to make it wider or narrower. 😊 opens the emoji picker. |
| **Fullscreen** | Use the player's normal fullscreen button. During a party the whole screen is used: the video fills the left and the chat and call stay on the right, ready to type in. Press the button again or `Esc` to leave. |
| **Reactions** | Tap an emoji in the bar above the message box. It floats over the video for everyone, with your name. |
| **Video call** | 📹 in the chat header (or in the popup). Friends get a **Join call** button in the chat. By default you only see your friends; 🪞 shows your own camera too (click your preview to make it bigger or smaller). "● You're live" means your camera is on. Hover the call for controls: 🎤 mic, 📷 camera, 🪞 my video, 🔊 volume, ⇱ float/dock, ⧉ separate window, ✕ leave. **Make faces bigger:** drag the bar at the bottom of the docked call down, drag the chat's left edge wider, or float the call and drag its bottom-left corner. Double-click the bottom bar to reset. Double-click a face to switch between fill and fit. |
| **🔊 Unmute** | Chrome blocks sound until you've clicked the page (e.g. right after a refresh). Instead of getting stuck, your video plays muted to stay in sync and the chat shows **🔊 Unmute**. |
| **Invite link** | *Copy invite* copies a link like `…/watch?v=…#watchparty=ABC234`. Friends with the extension who open it get a **Join party** card. |
| **Follow host** | When the host opens another video or episode, friends get **Go there** in the chat. |
| **Edit name/avatar** | Popup → *Edit my name* (works mid-party). |
| **Switch tabs** | If the party runs in another tab, the popup offers *Go there* / *Move party here*. |
| **Leave** | *Leave party*, or close the tab. If the host leaves, the oldest member becomes host. |

Everyone needs their **own account** on the streaming service, and should open the **same title/episode** before syncing.

---

## How sync works

- **Events:** the content script hooks `play`, `pause`, `seeked`, `ratechange` (and `waiting`/`playing` for buffering) on the largest visible `<video>`, re-scanning with a `MutationObserver` because single-page sites swap players. The frame with the biggest video controls playback, so players inside iframes work too.
- **Echo suppression:** when applying a remote command, the script records the events it expects to cause and drops them, plus a ~300ms quiet window. Heartbeats older than the latest command are ignored. This prevents play/pause loops.
- **Drift correction:** the host sends a heartbeat every 3s. Guests compute `expected = hostTime + elapsed`. Drift > 1s → hard seek; 0.3-1s → playbackRate nudged to 0.95/1.05 until caught up (not on Netflix).
- **Clock sync:** the server includes its clock in `pong`. The background estimates each client's clock offset, so elapsed-time maths doesn't depend on everyone's system clock being correct.
- **Reconnects:** the background pings every 20s (this also keeps the MV3 service worker alive) and reconnects with exponential backoff (1s → 30s). Party state is in `chrome.storage.session`. A dropped connection keeps your slot (and host role) for 15s. After a server restart, clients recreate the room under the same code.
- **Netflix:** seeking via `video.currentTime` crashes Netflix's player, so `page-bridge.js` runs in the page and uses Netflix's own player API (`videoPlayer.getVideoPlayerBySessionId(...).seek(ms)`), with a fallback if the API changes.
- **YouTube:** handles SPA navigation (`yt-navigate-finish`) and pauses sync while an ad is showing, re-syncing afterwards.

### Server limits
Max 20 members per room · messages ≤ 4 KB · chat ≤ 5 messages / 5s per person · rooms expire after 6 hours idle · every message is validated, unknown types are dropped · `hostOnlyControl` is enforced server-side.

---

## Manual acceptance checklist

- [ ] Two Chrome profiles, same YouTube video: play/pause/seek from either side syncs within ~1s; no infinite play/pause loops.
- [ ] Host-only mode: guest's pause is reverted.
- [ ] Late joiner jumps to the host's current position.
- [ ] Kill and restart the server: both clients reconnect and rejoin automatically (popup goes *Reconnecting…* → *Connected*).
- [ ] Netflix: seeking syncs without the player error.
- [ ] Chat visible in fullscreen.
- [ ] Host closes tab → another member becomes host.

## Video call notes

- **Use headphones.** Otherwise the movie's sound from your speakers goes into your mic and your friend hears it twice.
- **First time only:** Chrome may need camera/mic permission for the extension. If the call shows *Camera & mic access needed*, click **Allow camera & mic**. A tab opens, you choose **Allow**, and the call starts automatically. You can also **Join without camera** and still see and hear your friends.
- Some sites block cameras inside their pages. The call then offers **Open call in a window**, a small separate window that works everywhere.
- Video tries to go **directly between you and your friends** (peer-to-peer). Many home and mobile networks (Jio, Airtel, shared-IP/CGNAT, office Wi-Fi) block that, and the friend's tile then says *"Can't connect: your networks block direct video"*. **Fix, once, on the host's Mac:**
  1. Create a free TURN relay account. **ExpressTURN** (expressturn.com) is free with no credit card; its dashboard shows a *TURN server*, *Username* and *Password*. (Also supported: Metered Open Relay, Cloudflare, or any TURN server.)
  2. Run `./scripts/setup-turn.sh`, choose **1**, and type in those three values. They are saved to `server/.env` (only on your Mac, never in the zip), and the script logs in to the relay to prove they work.
  3. Restart the server. It hands the relay to everyone who joins, so friends don't change anything. The server window prints `video call relay (TURN): static, ready ✓`.
- Up to 8 people per call (everyone connects to everyone).

## Troubleshooting

- **"Could not reach the party server"**: check `SERVER_URL` in `extension/config.js` (must be `wss://` for hosted servers), and that `/health` returns `ok`. On Render's free tier, wait ~60s for it to wake up.
- **Nothing syncs on a site**: reload the video tab after installing/updating the extension. Make sure both people are on the same video.
- **"Your browser blocked autoplay"**: click play once on the video in that tab. After one interaction, sync continues normally.
- **Fullscreen without chat**: during a party the player's fullscreen button makes the whole page fullscreen with the chat beside the video. If a site starts fullscreen in another way (e.g. double-click on some players, or a keyboard shortcut handled before the page loads), you may get the site's own fullscreen without the chat; press `Esc` and use the fullscreen button instead.
