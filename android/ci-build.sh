#!/usr/bin/env bash
# Сборка APK на GitHub официальными инструментами Google (aapt2, d8, zipalign, apksigner)
set -e
MODE=${1:-release}
BT=$(ls -d $ANDROID_HOME/build-tools/* | sort -V | tail -1)
PLAT=$(ls -d $ANDROID_HOME/platforms/android-* | sort -V | tail -1)
echo "build-tools: $BT, platform: $PLAT, mode: $MODE"
# node для телефона (nodejs-mobile) и программа Кентовки
[ -d node_modules/ws ] || npm install --omit=dev --ignore-scripts --no-audit --no-fund
NMV=v18.20.4; NM=/tmp/nm
if [ ! -d $NM/bin ]; then mkdir -p $NM && curl -sL -o /tmp/nm.zip https://github.com/nodejs-mobile/nodejs-mobile/releases/download/$NMV/nodejs-mobile-$NMV-android.zip && unzip -q /tmp/nm.zip -d $NM; fi
NDK=${ANDROID_NDK_LATEST_HOME:-$ANDROID_NDK_HOME}
ABIS="arm64-v8a armeabi-v7a"; [ "$MODE" = debug ] && ABIS="x86_64"
cd android && rm -rf build && mkdir -p build/gen build/classes build/dex
bash make-nodeproject.sh build/np
for abi in $ABIS; do
  case $abi in arm64-v8a) tr=aarch64-linux-android26;; x86_64) tr=x86_64-linux-android26;; armeabi-v7a) tr=armv7a-linux-androideabi26;; esac
  mkdir -p build/lib/lib/$abi; cp $NM/bin/$abi/libnode.so build/lib/lib/$abi/
  $NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/${tr}-clang++ -shared -fPIC -std=c++17 -O2 -I$NM/include/node jni/kentovka-node.cpp -L$NM/bin/$abi -lnode -llog -o build/lib/lib/$abi/libkentovka.so
done
$BT/aapt2 compile --dir res -o build/res.zip
DBG=""; [ "$MODE" = debug ] && DBG="--debug-mode"
$BT/aapt2 link -I $PLAT/android.jar --manifest AndroidManifest.xml -A assets --java build/gen -o build/base.apk build/res.zip --min-sdk-version 26 --target-sdk-version 34 $DBG
javac -encoding UTF-8 --release 8 -nowarn -cp $PLAT/android.jar -d build/classes $(find src build/gen -name '*.java')
$BT/d8 --min-api 26 --output build/dex $(find build/classes -name '*.class')
cp build/base.apk build/unsigned.apk && (cd build/dex && zip -q -j ../unsigned.apk classes.dex) && (cd build/lib && zip -q -r ../unsigned.apk lib)
$BT/zipalign -f -p 4 build/unsigned.apk build/aligned.apk
if [ -n "$KS_B64" ] && [ "$MODE" = release ]; then echo "$KS_B64" | base64 -d > ks.jks; PASS="$KS_PASS"
else keytool -genkeypair -keystore ks.jks -storepass kentovka -keypass kentovka -alias kentovka -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Kentovka" >/dev/null 2>&1; PASS=kentovka; fi
OUTN=Kentovka.apk; [ "$MODE" = debug ] && OUTN=Kentovka-debug.apk
$BT/apksigner sign --ks ks.jks --ks-pass pass:$PASS --out build/$OUTN build/aligned.apk
$BT/apksigner verify --verbose build/$OUTN
