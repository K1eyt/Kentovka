#!/usr/bin/env bash
# Сборка APK без Gradle: aapt2 + javac + dx + подпись (v1+v2+v3). Инструменты — в $TOOLS.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="${TOOLS:-/tmp/claude-0/andk}"
OUT="${OUT:-$HERE/build}"
AJAR="$TOOLS/android.jar"
rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"
# программа Кентовки для node на телефоне и node сам (nodejs-mobile) с нашей прослойкой JNI
bash "$HERE/make-nodeproject.sh" "$OUT/np"
NM="${NM:-/tmp/claude-0/nm}"; NDK="${NDK:-/tmp/claude-0/ndk/android-ndk-r26d}"; ABIS="${ABIS:-arm64-v8a x86_64}"
for abi in $ABIS; do
  case $abi in arm64-v8a) tr=aarch64-linux-android26;; x86_64) tr=x86_64-linux-android26;; armeabi-v7a) tr=armv7a-linux-androideabi26;; esac
  mkdir -p "$OUT/lib/lib/$abi"; cp "$NM/bin/$abi/libnode.so" "$OUT/lib/lib/$abi/"
  case $abi in arm64-v8a) st=aarch64-linux-android;; x86_64) st=x86_64-linux-android;; armeabi-v7a) st=arm-linux-androideabi;; esac
  cp "$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/$st/libc++_shared.so" "$OUT/lib/lib/$abi/"
  "$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/${tr}-clang++" -shared -fPIC -std=c++17 -O2 -I"$NM/include/node" "$HERE/jni/kentovka-node.cpp" -L"$NM/bin/$abi" -lnode -llog -o "$OUT/lib/lib/$abi/libkentovka.so"
done
"$TOOLS/aapt2" compile --dir "$HERE/res" -o "$OUT/res.zip"
"$TOOLS/aapt2" link -I "$AJAR" --manifest "$HERE/AndroidManifest.xml" -A "$HERE/assets" --java "$OUT/gen" -o "$OUT/base.apk" "$OUT/res.zip" --min-sdk-version 26 --target-sdk-version 34 --version-code 189 --version-name 1.8.9
javac -encoding UTF-8 --release 8 -Xlint:-options -nowarn -cp "$AJAR" -d "$OUT/classes" $(find "$HERE/src" "$OUT/gen" -name '*.java') 2>&1 | grep -v "Picked up" || true
[ -f "$OUT/classes/ru/kentovka/app/MainActivity.class" ] || { echo "javac failed"; exit 1; }
java -cp "$TOOLS/d2j/dex-tools-v2.4/lib/dx-30.0.2.jar" com.android.dx.command.Main --dex --min-sdk-version=26 --output="$OUT/dex/classes.dex" "$OUT/classes" 2>&1 | grep -v "Picked up" || true
[ -f "$OUT/dex/classes.dex" ] || { echo "dx failed"; exit 1; }
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -j "$OUT/unsigned.apk" classes.dex)
(cd "$OUT/lib" && zip -q -r "$OUT/unsigned.apk" lib)
python3 "$HERE/zipalign.py" "$OUT/unsigned.apk" "$OUT/aligned.apk"
node "$HERE/sign.mjs" "$OUT/aligned.apk" "$OUT/Kentovka-1.8.9.apk" "${KEYDIR:-$HERE/keys}"
echo "APK: $OUT/Kentovka-1.8.9.apk"
