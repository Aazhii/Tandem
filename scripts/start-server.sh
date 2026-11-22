#!/usr/bin/env bash
# Starts the Watch Party relay server on this Mac and exposes it to the internet through ngrok.
# The ngrok domain is read from extension/config.js (SERVER_URL), so there is one place to change it.
# Keeps the Mac awake while running. Press Ctrl+C to stop everything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8080}"

DOMAIN="$(sed -n "s/^[[:space:]]*const SERVER_URL[[:space:]]*=[[:space:]]*['\"]wss:\/\/\([^/'\"]*\).*/\1/p" "$ROOT/extension/config.js" | head -n 1)"
if [[ -z "$DOMAIN" ]]; then
  echo "error: SERVER_URL in extension/config.js must be a wss:// ngrok address" >&2
  exit 1
fi

command -v node >/dev/null || { echo "error: Node.js is not installed (brew install node)" >&2; exit 1; }
command -v ngrok >/dev/null || { echo "error: ngrok is not installed (brew install ngrok)" >&2; exit 1; }

# A Watch Party server left over from an earlier run (e.g. its window was closed) still runs old code:
# stop it and start fresh. Anything else on the port is not ours, so leave it alone.
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | tail -n 1)"
  if [[ "$cwd" == "$ROOT/server" ]] && ps -o command= -p "$pid" | grep -q "server.js"; then
    echo "Stopping the old Watch Party server (pid $pid) so the latest version starts…"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
    kill -9 "$pid" 2>/dev/null || true
  fi
done
pkill -f "ngrok http --url=$DOMAIN" 2>/dev/null || true # old tunnel for the same domain

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: port $PORT is used by another program (not Watch Party). Stop it or run with PORT=8081." >&2
  exit 1
fi

if [[ ! -d "$ROOT/server/node_modules" ]]; then
  echo "Installing server dependencies…"
  (cd "$ROOT/server" && npm install --omit=dev --no-audit --no-fund)
fi

SERVER_PID=""
CAFFEINATE_PID=""
cleanup() {
  echo
  echo "Stopping Watch Party server…"
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "$CAFFEINATE_PID" ]] && kill "$CAFFEINATE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

(cd "$ROOT/server" && PORT="$PORT" node server.js) &
SERVER_PID=$!

# Keep the Mac (and its network) awake while the party server runs.
caffeinate -ims &
CAFFEINATE_PID=$!

sleep 1
if ! curl -fs "http://localhost:$PORT/health" >/dev/null; then
  echo "error: server did not start" >&2
  exit 1
fi

echo
echo "  Watch Party server is running on this Mac."
echo "  Public address: wss://$DOMAIN"
echo "  Keep this window open while you watch. Ctrl+C to stop."
echo

ngrok http --url="$DOMAIN" "$PORT" --log=false
