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

The extension isn't on the Chrome Web Store. Everyone installs it from a **zip** with *Load unpacked*, and points it at the host's server, either built into the zip by the host, or typed into the popup's **⚙ Server settings**. The host can lock the server with a **party key**, so only friends who know it can use it.

```
 You (extension) ──┐                         ┌── Friend (extension)
                   └──►  relay server (host)  ◄─┘
            each of you plays the video from your own account
```

---

## Setup

The host does steps 1–4 once. Everyone does step 5.

> **Just joining a friend's party?** Skip to [Step 5](#step-5-install-the-extension-everyone). Use the zip your host sent you, or download `tandem-vX.Y.Z.zip` from this repo's [Releases](https://github.com/Aazhii/Tandem/releases) and enter the server address and party key your host gives you in **⚙ Server settings**.

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
3. Put your domain in `extension/config.local.js` (see [Step 3](#step-3-point-the-extension-at-your-server-host)).
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

Create **`extension/config.local.js`** with your server's address, starting with **`wss://`**. This file is yours only: git ignores it, so your address never ends up in the public repo.

```js
const SERVER_URL = 'wss://something-random.ngrok-free.dev';   // Option A
// const SERVER_URL = 'wss://your-app.onrender.com';          // Option B
const PARTY_KEY = '';
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];
```

**Lock your server with a party key (recommended).** Without one, anyone who finds your server address can use it, including your TURN relay allowance. Run:

```bash
./scripts/new-party-key.sh
```

It generates a random key and saves it in `server/.env` (the server then refuses anyone without it) and in `config.local.js` (so your zip includes it). Restart the server afterwards. On Render or other hosts, set a `PARTY_KEY` environment variable instead. Run the script again any time to change the key.

> Skip `config.local.js` entirely if you'd rather not build a zip: everyone can install the plain zip and enter the address and key in the popup → **⚙ Server settings** (**Copy for a friend** there copies both, ready to send).

Just testing on one computer? Use `'ws://localhost:8080'` and run `cd server && npm install && npm start`.

### Step 4: Build the zip and share it (host)

```bash
./scripts/package-extension.sh
```

This creates **`dist/tandem-vX.Y.Z.zip`** with your server address and party key built in, and prints the address so you can double-check it. Send this zip to your friends (WhatsApp, Drive, email…), and only to them, since it contains your key. Keep a copy for yourself too.

> No bash (Windows)? Zip the `extension` folder yourself (right-click → *Send to → Compressed folder*). Then everyone enters the server in **⚙ Server settings**.

### Step 5: Install the extension (everyone)

1. **Unzip** the file into a folder you'll keep, e.g. `Documents/tandem`. Chrome loads the extension from this folder, so don't delete it.
2. Open **`chrome://extensions`** (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** (switch in the top-right corner).
4. Click **Load unpacked** and choose the unzipped folder, the one that contains `manifest.json`.
5. Click the puzzle-piece icon in the toolbar and **pin** **Tandem**.
6. If the popup opens **⚙ Server settings**, enter the server address (and party key) your host gave you and click **Save**. Zips built by the host already have this filled in.

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
| Use a different server / party key | Popup → **⚙ Server settings** (bottom of the popup) |

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
| "Could not reach the party server" | Is the host's server running? Is the address in **⚙ Server settings** right (starting with `wss://`)? On Render, wait a minute for it to wake up. |
| "The party server rejected your party key" | Ask the host for the current key and enter it in **⚙ Server settings**. |
| "No party server set yet" | Enter the host's server address in **⚙ Server settings**. |
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
cd server && npm install && npm test        # server protocol tests
cd tests/e2e && npm install && npm test     # browser tests: two Chromes with the extension
```

The browser tests need Chrome for Testing once: `npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer`. They cover playback with real clicks (including a player that misbehaves like streaming sites do), late join, drift correction, host-only mode, reloads, server restarts, fullscreen beside the chat, and the server settings/party key.

To try it on one machine: run `npm start` in `server/`, load the `extension/` folder unpacked in two Chrome profiles, and set the server to `ws://localhost:8080` in **⚙ Server settings**. Tests also run automatically on GitHub for every push.

**Privacy:** the server keeps rooms in memory only (nothing is stored on disk) and never sees your video, camera or microphone. Call media goes directly between participants, or through the TURN relay you configure.

## License

[MIT](LICENSE): free to use, change and share.
