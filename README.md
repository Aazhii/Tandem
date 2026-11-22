# Tandem

**Watch videos together with friends, in sync, from your own browsers.** A free, self-hosted alternative to Teleparty.

When one person plays, pauses or skips, everyone else's video does the same. On top of that you get:

- 💬 **Chat** in a sidebar next to the video (it never covers the movie)
- 😂 **Emoji reactions** that float over the video for everyone
- 📹 **Video & voice call** inside the sidebar: see your friends' faces while you watch, optionally your own too
- ➡️ **Auto-follow**: when someone opens the next episode, everyone goes there
- 🔗 **Invite links**, host-only control, fullscreen with chat, automatic reconnects

Works in **Chrome, Edge and Brave** on Netflix, YouTube, Prime Video, Hotstar, Crunchyroll and any site with a normal HTML5 video player.

> **Each person needs their own account** on the streaming site. Tandem never streams or shares video. It only sends small "play / pause / jump to 12:34" messages between you.

---

## How it works

Tandem has two parts:

| Part | What it does | Who needs it |
|---|---|---|
| **Browser extension** (`extension/`) | Watches your video player, syncs it, shows the chat and the call | **Everyone** in the party |
| **Relay server** (`server/`) | A tiny server that passes messages between you. No video goes through it | **One person** (the "host") runs it |

The extension isn't on the Chrome Web Store. The host builds a **zip** of the extension that points to their server, sends it to friends, and everyone installs it with *Load unpacked*.

```
 You (extension) ──┐                         ┌── Friend (extension)
                   └──►  relay server (host)  ◄─┘
            each of you plays the video from your own account
```

---

## Setup

The host does steps 1–4 once. Everyone does step 5.

### Step 1: Get the code (host)

```bash
git clone https://github.com/Aazhii/Tandem.git
cd Tandem
```

No git? On the GitHub page click **Code → Download ZIP** and unzip it.

You need **Node.js 20 or newer** ([nodejs.org](https://nodejs.org)). Check with `node -v`.

### Step 2: Run the relay server (host)

Pick **one** option.

#### Option A: on your own computer, with ngrok (free, recommended for small groups)

Your computer runs the server, and [ngrok](https://ngrok.com) gives it a public address your friends can reach.

1. Install ngrok: `brew install ngrok` (Mac) or download it from [ngrok.com/download](https://ngrok.com/download).
2. Create a free ngrok account. In the dashboard:
   - **Domains** → claim your free static domain (looks like `something-random.ngrok-free.dev`).
   - **Your Authtoken** → copy it, then run once:
     ```bash
     ngrok config add-authtoken <your-token>
     ```
     The token must come from the **same account** as the domain.
3. Put your domain in `extension/config.js` (see [Step 3](#step-3-point-the-extension-at-your-server-host)).
4. Start everything:
   ```bash
   ./scripts/start-server.sh
   ```
   This installs the server's dependencies on first run, starts the server, keeps your computer awake and opens the tunnel. **Leave this window open while you watch.** Press `Ctrl+C` to stop.

   Each time you want to watch, run `./scripts/start-server.sh` again.

> On Windows, run the scripts in **Git Bash** or **WSL**, or start things by hand: `cd server && npm install && npm start`, then in a second window `ngrok http --url=<your-domain> 8080`.

#### Option B: on a free cloud host (Render), always on

1. Fork this repo on GitHub.
2. On [dashboard.render.com](https://dashboard.render.com): **New + → Blueprint** → pick your fork. The included `render.yaml` sets everything up.
3. When it shows **Live**, open `https://<your-app>.onrender.com/health`. It should say `ok`.

Render's free tier sleeps after ~15 minutes idle, so the first connection after a break can take up to a minute. The extension keeps retrying on its own. The server also runs on Railway, Fly.io or any Docker host (`server/Dockerfile`).

### Step 3: Point the extension at your server (host)

Open **`extension/config.js`** and set `SERVER_URL` to your server's address, starting with **`wss://`**:

```js
const SERVER_URL = 'wss://something-random.ngrok-free.dev';   // Option A
// const SERVER_URL = 'wss://your-app.onrender.com';          // Option B
```

Just testing on one computer? Use `'ws://localhost:8080'` and run `cd server && npm install && npm start`.

### Step 4: Build the zip and share it (host)

```bash
./scripts/package-extension.sh
```

This creates **`dist/watch-party-vX.Y.Z.zip`** and prints the server address baked into it, so you can double-check it. Send this zip to your friends (WhatsApp, Drive, email…). Keep a copy for yourself too.

> No bash (Windows)? Zip the `extension` folder yourself (right-click → *Send to → Compressed folder*). It's the same thing.

### Step 5: Install the extension (everyone)

1. **Unzip** the file into a folder you'll keep, e.g. `Documents/tandem`. Chrome loads the extension from this folder, so don't delete it.
2. Open **`chrome://extensions`** (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** (switch in the top-right corner).
4. Click **Load unpacked** and choose the unzipped folder, the one that contains `manifest.json`.
5. Click the puzzle-piece icon in the toolbar and **pin** the extension. It's called **Watch Party** in Chrome.

> On startup Chrome may warn about "developer mode extensions". Click ✕ or *Keep*. That's normal for extensions installed this way.

---

## Start watching

1. Everyone opens **the same video** on the streaming site.
2. The host clicks the extension icon → enters a nickname → **Start a party on this tab** → **Copy invite**, and sends it to friends.
3. Friends click the extension icon → enter the **room code** → **Join**. Or they just open the invite link and click **Join party**.
4. Play, pause or skip from anyone's screen and everyone follows. Chat appears on the right.

### Everyday controls

| To… | Do this |
|---|---|
| Chat / react | Type in the sidebar, or tap an emoji above the message box |
| Hide / show the chat | `›` in the chat header / the 💬 tab on the right edge |
| Make the chat wider | Drag its left edge |
| Fullscreen | Use the player's normal fullscreen button: video on the left, chat and call stay on the right |
| Start a video call | 📹 in the chat header. Friends get a **Join call** button |
| See yourself in the call | 🪞 in the call controls. Click your preview to make it bigger |
| Make faces bigger | Drag the bar under the call down, or ⇱ to float the call and resize it from its corner |
| Only the host controls playback | Popup → **Only host controls playback** |
| Stop auto-following the host to other videos | Popup → turn off **Auto-follow video changes** |
| Change your name / avatar | Popup → **Edit my name** |

**Use headphones during calls.** Otherwise the movie's sound from your speakers goes into your mic.

---

## Optional: make video calls work on every network

Video calls try to connect your computers directly. Many home and mobile networks (Jio, Airtel, office Wi-Fi, CGNAT) block that, and the call then shows *"Can't connect: your networks block direct video"*. A **TURN relay** fixes it. The host sets it up once, and friends don't need to do anything.

1. Create a free account at **[ExpressTURN](https://www.expressturn.com/)** (no credit card). The dashboard shows a **TURN server**, **Username** and **Password**. Metered, Cloudflare and other TURN servers also work.
2. Run:
   ```bash
   ./scripts/setup-turn.sh
   ```
   Choose your provider and type in the values. They're saved to `server/.env`, which never goes into the zip or git, and the script logs in to the relay to confirm they work.
3. Restart the server. It should print `video call relay (TURN): … ready ✓`.

For Render or other hosts, set the same values as environment variables instead: `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.

---

## Updating

When the extension changes:

1. The host bumps `"version"` in `extension/manifest.json`, then runs `./scripts/package-extension.sh` again and shares the new zip.
2. Everyone replaces the files in their extension folder with the new zip's contents, clicks **↻** on the extension in `chrome://extensions`, and refreshes the video tab.

If people in a party run different versions, the chat shows a warning. When the server code changes, the host restarts it (`Ctrl+C`, then `./scripts/start-server.sh`).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not reach the party server" | Is the host's server running? Is `SERVER_URL` in `config.js` correct and starting with `wss://`? On Render, wait a minute for it to wake up. |
| `ERR_NGROK_320` when starting | Your ngrok domain belongs to a different ngrok account than your authtoken. Run `ngrok config add-authtoken` with the token from the account that owns the domain. |
| "Port 8080 is already in use" | Another program uses that port. `start-server.sh` replaces an old Tandem server automatically. Otherwise run with `PORT=8081 ./scripts/start-server.sh`. |
| Nothing syncs | Refresh the video tab after installing or updating. Make sure everyone has the same episode open. |
| 🔊 **Unmute** appears in the chat | Chrome blocks sound until you click the page. Your video plays muted to stay in sync, so click **Unmute**. |
| Call stuck on "Connecting…" | Set up the [TURN relay](#optional-make-video-calls-work-on-every-network). |
| "Stream limit reached" on the streaming site | Two people are using the same streaming account. Each person needs their own account, or a plan that allows more screens. |
| Chat missing in fullscreen | Press `Esc` and use the player's fullscreen **button** (some keyboard shortcuts skip Tandem). |

---

## For developers

```bash
cd server && npm install && npm test     # server protocol tests
```

To try it on one machine: set `SERVER_URL` to `ws://localhost:8080`, run `npm start` in `server/`, and load the `extension/` folder unpacked in two Chrome profiles.

**Privacy:** the server keeps rooms in memory only (nothing is stored on disk) and never sees your video, camera or microphone. Call media goes directly between participants, or through the TURN relay you configure.
