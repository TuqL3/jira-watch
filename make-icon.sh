#!/bin/bash
set -euo pipefail
SRC="$1"
OUT="$2"
TMP="$(mktemp -d)/i.iconset"
mkdir -p "$TMP"

emit() { sips -z "$1" "$1" "$SRC" --out "$TMP/$2.png" >/dev/null; }

emit 16   icon_16x16
emit 32   icon_16x16@2x
emit 32   icon_32x32
emit 64   icon_32x32@2x
emit 128  icon_128x128
emit 256  icon_128x128@2x
emit 256  icon_256x256
emit 512  icon_256x256@2x
emit 512  icon_512x512

echo "iconset: $(ls "$TMP" | wc -l | tr -d ' ') file"
iconutil -c icns "$TMP" -o "$OUT"
echo "icns: $(wc -c < "$OUT" | tr -d ' ') bytes"
