#!/usr/bin/env bash
# Zips extension/ into dist/watch-party-vX.Y.Z.zip for sharing with friends.
# Does not bump the version: edit "version" in extension/manifest.json yourself when releasing.
# The zip contains a single folder (watch-party-vX.Y.Z/) so unzipping gives a ready-to-load directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"
DIST="$ROOT/dist"

VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$EXT/manifest.json" | head -n 1)"
if [[ -z "$VERSION" ]]; then
  echo "error: could not read version from extension/manifest.json" >&2
  exit 1
fi

SERVER_URL="$(sed -n "s/^[[:space:]]*const SERVER_URL[[:space:]]*=[[:space:]]*['\"]\([^'\"]*\)['\"].*/\1/p" "$EXT/config.js" | head -n 1)"
echo "Packaging Watch Party v$VERSION"
echo "  SERVER_URL = ${SERVER_URL:-<not found>}"
if [[ "$SERVER_URL" == *localhost* || "$SERVER_URL" == *127.0.0.1* ]]; then
  echo "  WARNING: SERVER_URL points to localhost — friends on other computers won't be able to connect."
  echo "           Set it to your deployed wss:// URL in extension/config.js before sharing."
fi
if [[ "$SERVER_URL" == ws://* && "$SERVER_URL" != *localhost* && "$SERVER_URL" != *127.0.0.1* ]]; then
  echo "  WARNING: SERVER_URL uses ws:// (unencrypted). Hosted servers should use wss://."
fi

NAME="watch-party-v$VERSION"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/$NAME" "$DIST"
# Copy everything except OS junk / editor files.
cp -R "$EXT/." "$STAGE/$NAME/"
find "$STAGE/$NAME" \( -name '.*' -o -name '*.swp' \) -mindepth 1 -prune -exec rm -rf {} +

OUT="$DIST/$NAME.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -rqX "$OUT" "$NAME")

echo "Created ${OUT#$ROOT/} ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
