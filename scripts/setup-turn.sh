#!/usr/bin/env bash
# One-time setup of a TURN relay for the video call.
#
# Why: video goes directly between friends' computers. When both are behind strict home/mobile
# networks (very common: Jio, Airtel, CGNAT, office Wi-Fi) that direct path is blocked and the call
# shows "Can't connect". A TURN relay passes the video along in that case.
#
# This asks for your relay login (typed here; the password is hidden), saves it to server/.env,
# and tests it by actually logging in to the relay. The server hands it to party members, so your
# friend does not need to do anything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/server/.env"

cat <<'TXT'

  Video call relay (TURN) setup
  ─────────────────────────────
    1) ExpressTURN  (recommended: free, no credit card)
       expressturn.com → Sign up → Dashboard shows: TURN server, Username, Password
    2) Metered Open Relay  (free tier)
       metered.ca/tools/openrelay → Sign up → you get an app domain + API key
    3) Cloudflare  (Realtime → TURN Server: Turn Token ID + API Token)
    4) Any other TURN server (address, username, password)

TXT

read -r -p "  Choose 1, 2, 3 or 4: " choice

trim() { printf '%s' "$1" | tr -d '[:space:]'; }
ask_secret() { # $1 prompt → REPLY_SECRET
  local v=""
  read -r -s -p "  $1: " v
  echo
  REPLY_SECRET="$(trim "$v")"
}

# "relay1.expressturn.com:3478" or "turn:host:port" → "turn:host:port,turn:host:port?transport=tcp"
turn_urls_from_address() {
  local a
  a="$(trim "$1")"
  a="${a#turn:}"; a="${a#turns:}"; a="${a%%\?*}"
  [[ "$a" == *:* ]] || a="$a:3478"
  printf 'turn:%s,turn:%s?transport=tcp' "$a" "$a"
}

case "$choice" in
  1)
    read -r -p "  TURN server (as shown, e.g. relay1.expressturn.com:3478): " addr
    read -r -p "  Username: " user
    ask_secret "Password (hidden)"
    lines="TURN_URLS=$(turn_urls_from_address "$addr")
TURN_USERNAME=$(trim "$user")
TURN_CREDENTIAL=$REPLY_SECRET"
    ;;
  2)
    read -r -p "  App domain (e.g. yourapp.metered.live): " domain
    ask_secret "API key (hidden)"
    lines="METERED_DOMAIN=$(trim "$domain")
METERED_API_KEY=$REPLY_SECRET"
    ;;
  3)
    read -r -p "  Turn Token ID: " id
    ask_secret "API Token (hidden)"
    lines="CF_TURN_KEY_ID=$(trim "$id")
CF_TURN_API_TOKEN=$REPLY_SECRET"
    ;;
  4)
    read -r -p "  TURN address(es), comma-separated (host:port or turn:… URLs): " urls
    if [[ "$urls" != *turn* ]]; then urls="$(turn_urls_from_address "$urls")"; fi
    read -r -p "  Username: " user
    ask_secret "Password (hidden)"
    lines="TURN_URLS=$(trim "$urls")
TURN_USERNAME=$(trim "$user")
TURN_CREDENTIAL=$REPLY_SECRET"
    ;;
  *)
    echo "  Nothing changed."; exit 1 ;;
esac

# Replace any previous TURN settings, keep other lines.
tmp="$(mktemp)"
if [[ -f "$ENV_FILE" ]]; then
  grep -vE '^(CF_TURN_KEY_ID|CF_TURN_API_TOKEN|METERED_DOMAIN|METERED_API_KEY|TURN_URLS|TURN_USERNAME|TURN_CREDENTIAL)=' "$ENV_FILE" > "$tmp" || true
fi
printf '%s\n' "$lines" >> "$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo
echo "  Saved to server/.env (readable only by you). Logging in to the relay to test it…"
cd "$ROOT/server"
node -e '
  const fs = require("fs");
  for (const l of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
  const turn = require("./turn");
  const { checkIceServers } = require("./turn-check");
  (async () => {
    const servers = await turn.getIceServers();
    if (!servers.some((x) => x.urls.some((u) => /^turns?:/.test(u)))) {
      console.log("  ❌ Could not get relay details: " + (turn.status().lastError || "no TURN addresses returned"));
      console.log("     Check the values and run this script again.");
      process.exit(1);
    }
    let { ok, results } = await checkIceServers(servers);
    for (const r of results) console.log("     " + (r.ok ? "✓" : r.skipped ? "·" : "✗") + " " + r.url + (r.ok ? "" : "  (" + r.error + ")"));
    if (!ok && results.every((r) => r.skipped)) ok = true;
    if (ok) {
      console.log("  ✅ Relay login works.");
      console.log("     Now restart the server (Ctrl+C in its window, then ./scripts/start-server.sh) and rejoin the call.");
    } else {
      console.log("  ❌ The relay did not accept the login. Check the server address, username and password, then run this again.");
      process.exit(1);
    }
  })();
'
