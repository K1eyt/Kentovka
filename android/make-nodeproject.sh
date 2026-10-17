#!/usr/bin/env bash
# Собирает программу Кентовки для node на телефоне: assets/nodeproject.zip + версия
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/.."
OUT="${1:-$HERE/build/np}"; rm -rf "$OUT"; mkdir -p "$OUT/app" "$OUT/public" "$OUT/node_modules"
cp "$HERE"/node/*.js "$OUT/"
cp "$ROOT"/app/*.js "$ROOT"/app/*.html "$OUT/app/"; cp "$ROOT"/app/icon.png "$OUT/app/" 2>/dev/null || true
rm -f "$OUT/app/picker.html"
cp "$ROOT/server.js" "$ROOT/package.json" "$OUT/"
cp -r "$ROOT"/public/. "$OUT/public/"
for m in ws selfsigned node-forge qrcode dijkstrajs pngjs; do mkdir -p "$OUT/node_modules/$m"; cp -r "$ROOT/node_modules/$m/." "$OUT/node_modules/$m/"; done
mkdir -p "$OUT/node_modules/@sapphi-red/web-noise-suppressor"; cp -r "$ROOT/node_modules/@sapphi-red/web-noise-suppressor/dist" "$ROOT/node_modules/@sapphi-red/web-noise-suppressor/package.json" "$OUT/node_modules/@sapphi-red/web-noise-suppressor/"
# DeepFilter (30 МБ) на телефон не кладём — там по умолчанию шумодав выключен, есть RNNoise
find "$OUT/node_modules" -name "*.md" -delete; find "$OUT/node_modules" -name "*.d.ts" -delete; find "$OUT/node_modules" -type d \( -name test -o -name tests -o -name example -o -name examples -o -name docs \) -prune -exec rm -rf {} + 2>/dev/null || true
mkdir -p "$HERE/assets"
(cd "$OUT" && rm -f "$HERE/assets/nodeproject.zip" && zip -q -r -X "$HERE/assets/nodeproject.zip" .)
(cd "$OUT" && find . -type f -exec sha1sum {} + | sort | sha1sum | cut -c1-16) > "$HERE/assets/nodeproject.version"
echo "nodeproject: $(du -sh "$HERE/assets/nodeproject.zip" | cut -f1)"
