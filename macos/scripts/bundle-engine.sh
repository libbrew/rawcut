#!/bin/bash
# Xcode build phase: copies the Rawcut engine (server.js, lib, public + production node_modules)
# and a self-contained Node runtime into Rawcut.app/Contents/Resources.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"

ROOT="$(cd "$SRCROOT/.." && pwd)"                  # the rawcut repo
CACHE="$SRCROOT/.build-cache"
RES="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
NODE_VERSION="22.23.1"
ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH="x64"
mkdir -p "$CACHE" "$RES"

# 1) Production node_modules, cached by package-lock.json
LOCKHASH="$(shasum -a 256 "$ROOT/package-lock.json" | cut -c1-16)"
MODS="$CACHE/modules-$LOCKHASH-$ARCH"
if [ ! -d "$MODS/node_modules" ]; then
  echo "Installing engine dependencies (once)…"
  rm -rf "$MODS"; mkdir -p "$MODS"
  cp "$ROOT/package.json" "$ROOT/package-lock.json" "$MODS/"
  (cd "$MODS" && npm ci --omit=dev --no-audit --no-fund)
fi

# 2) Engine source
ENGINE="$RES/engine"
mkdir -p "$ENGINE"
rsync -a --delete --exclude '.DS_Store' "$ROOT/lib" "$ROOT/public" "$ENGINE/"
cp "$ROOT/server.js" "$ROOT/package.json" "$ENGINE/"
rsync -a --delete "$MODS/node_modules/" "$ENGINE/node_modules/"

# 3) Official, self-contained Node runtime from nodejs.org (checksum verified)
NODE_DIR="$CACHE/node-v$NODE_VERSION-darwin-$ARCH"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "Downloading Node $NODE_VERSION ($ARCH) from nodejs.org…"
  TGZ="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$TGZ" -o "$CACHE/$TGZ"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256.txt"
  (cd "$CACHE" && grep " $TGZ\$" SHASUMS256.txt | shasum -a 256 -c -)
  tar -xzf "$CACHE/$TGZ" -C "$CACHE"
  rm -f "$CACHE/$TGZ"
fi
mkdir -p "$RES/node"
cp "$NODE_DIR/bin/node" "$RES/node/node"

# 4) Sign every executable we added, so macOS will run them inside the app
IDENTITY="${EXPANDED_CODE_SIGN_IDENTITY:--}"; [ -z "$IDENTITY" ] && IDENTITY="-"
ENT="$SRCROOT/Rawcut/Rawcut.entitlements"
sign() { codesign --force --timestamp=none --options runtime --entitlements "$ENT" -s "$IDENTITY" "$1" >/dev/null 2>&1 || codesign --force -s - "$1"; }
sign "$RES/node/node"
find "$ENGINE/node_modules" -type f \( -name '*.node' -o -name '*.dylib' -o -name 'ffmpeg' \) -print0 | while IFS= read -r -d '' f; do sign "$f"; done
echo "Rawcut engine bundled → $ENGINE"
