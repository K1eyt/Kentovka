#!/usr/bin/env bash
# Сборка APK без Gradle: aapt2 + javac + dx + подпись (v1+v2+v3). Инструменты — в $TOOLS.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="${TOOLS:-/tmp/claude-0/andk}"
OUT="${OUT:-$HERE/build}"
AJAR="$TOOLS/android.jar"
rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"
"$TOOLS/aapt2" compile --dir "$HERE/res" -o "$OUT/res.zip"
"$TOOLS/aapt2" link -I "$AJAR" --manifest "$HERE/AndroidManifest.xml" -A "$HERE/assets" --java "$OUT/gen" -o "$OUT/base.apk" "$OUT/res.zip" --min-sdk-version 26 --target-sdk-version 34 --version-code 171 --version-name 1.7.1
javac -encoding UTF-8 --release 8 -Xlint:-options -nowarn -cp "$AJAR" -d "$OUT/classes" $(find "$HERE/src" "$OUT/gen" -name '*.java') 2>&1 | grep -v "Picked up" || true
[ -f "$OUT/classes/ru/kentovka/app/MainActivity.class" ] || { echo "javac failed"; exit 1; }
java -cp "$TOOLS/d2j/dex-tools-v2.4/lib/dx-30.0.2.jar" com.android.dx.command.Main --dex --min-sdk-version=26 --output="$OUT/dex/classes.dex" "$OUT/classes" 2>&1 | grep -v "Picked up" || true
[ -f "$OUT/dex/classes.dex" ] || { echo "dx failed"; exit 1; }
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -j "$OUT/unsigned.apk" classes.dex)
python3 "$HERE/zipalign.py" "$OUT/unsigned.apk" "$OUT/aligned.apk"
node "$HERE/sign.mjs" "$OUT/aligned.apk" "$OUT/Kentovka-1.7.1.apk" "${KEYDIR:-$HERE/keys}"
echo "APK: $OUT/Kentovka-1.7.1.apk"
