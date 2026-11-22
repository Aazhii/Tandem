#!/usr/bin/env bash
# Creates a new random party key and saves it in both places that need it:
#   server/.env               → the server only lets in people with this key
#   extension/config.local.js → zips you build with ./scripts/package-extension.sh include it
# Neither file is committed to git. Restart the server and send friends the new zip afterwards
# (or tell them the key: popup → ⚙ Server settings). Run again any time to change the key.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/server/.env"
LOCAL="$ROOT/extension/config.local.js"

KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('base64url'))")"

touch "$ENV_FILE"
tmp="$(mktemp)"
grep -v '^PARTY_KEY=' "$ENV_FILE" > "$tmp" || true
printf 'PARTY_KEY=%s\n' "$KEY" >> "$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"

if [[ -f "$LOCAL" ]]; then
  sed -i.bak "s/^const PARTY_KEY = .*/const PARTY_KEY = '$KEY';/" "$LOCAL" && rm -f "$LOCAL.bak"
  grep -q '^const PARTY_KEY' "$LOCAL" || printf "const PARTY_KEY = '%s';\n" "$KEY" >> "$LOCAL"
  echo "Saved the new party key to server/.env and extension/config.local.js."
else
  echo "Saved the new party key to server/.env."
  echo "Friends enter it in the popup → ⚙ Server settings. To build it into your zip instead,"
  echo "create extension/config.local.js (see README → Setup) and run this again."
fi
echo "Next: restart the server, then run ./scripts/package-extension.sh and share the new zip."
