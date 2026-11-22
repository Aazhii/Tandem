#!/usr/bin/env bash
# Zips extension/ into dist/tandem-vX.Y.Z.zip for sharing with friends.
# If extension/config.local.js exists (your own server address + party key, not in git), the zip
# uses it as config.js so friends need no setup. Otherwise the zip asks for a server in the popup.
# Does not bump the version: edit "version" in extension/manifest.json yourself when releasing.
# The zip contains a single folder (tandem-vX.Y.Z/) so unzipping gives a ready-to-load directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"
DIST="$ROOT/dist"

VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$EXT/manifest.json" | head -n 1)"
if [[ -z "$VERSION" ]]; then
  echo "error: could not read version from extension/manifest.json" >&2
  exit 1
fi

CONFIG="$EXT/config.js"
[[ -f "$EXT/config.local.js" ]] && CONFIG="$EXT/config.local.js"
read_const() { sed -n "s/^[[:space:]]*const $1[[:space:]]*=[[:space:]]*['\"]\([^'\"]*\)['\"].*/\1/p" "$CONFIG" | head -n 1; }
SERVER_URL="$(read_const SERVER_URL)"
PARTY_KEY="$(read_const PARTY_KEY)"

echo "Packaging Tandem v$VERSION (settings from ${CONFIG#$ROOT/})"
if [[ -z "$SERVER_URL" ]]; then
  echo "  Server: none built in. Each person enters it in the popup → Server settings."
else
  echo "  Server: $SERVER_URL"
  echo "  Party key: $([[ -n "$PARTY_KEY" ]] && echo "built in (hidden)" || echo "none")"
fi
if [[ "$SERVER_URL" == *localhost* || "$SERVER_URL" == *127.0.0.1* ]]; then
  echo "  WARNING: the server is localhost, so friends on other computers won't be able to connect."
fi
if [[ "$SERVER_URL" == ws://* && "$SERVER_URL" != *localhost* && "$SERVER_URL" != *127.0.0.1* ]]; then
  echo "  WARNING: the server uses ws:// (unencrypted). Hosted servers should use wss://."
fi

NAME="tandem-v$VERSION"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/$NAME" "$DIST"
# Copy everything except OS junk / editor files.
cp -R "$EXT/." "$STAGE/$NAME/"
find "$STAGE/$NAME" \( -name '.*' -o -name '*.swp' \) -mindepth 1 -prune -exec rm -rf {} +
if [[ "$CONFIG" != "$EXT/config.js" ]]; then cp "$CONFIG" "$STAGE/$NAME/config.js"; fi
rm -f "$STAGE/$NAME/config.local.js"

OUT="$DIST/$NAME.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -rqX "$OUT" "$NAME")

echo "Created ${OUT#$ROOT/} ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
