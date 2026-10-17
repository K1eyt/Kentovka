#!/usr/bin/env bash
# Проверка APK в эмуляторе (GitHub Actions): ставим, заходим на тестовый сервер, снимаем экран и журнал
set -x
OUT=ci-out; mkdir -p $OUT
adb wait-for-device
adb shell settings put global window_animation_scale 0; adb shell settings put global transition_animation_scale 0
adb install -r -g android/build/Kentovka-debug.apk > $OUT/install.txt 2>&1
unzip -l android/build/Kentovka-debug.apk | grep -E "lib/|nodeproject|loading" > $OUT/apk.txt
adb logcat -c
adb shell am start -n ru.kentovka.app/.MainActivity --es kname "Тест" > $OUT/start1.txt 2>&1
sleep 20
adb exec-out screencap -p > $OUT/1-launcher.png
# друзья и личка (программа как на ПК внутри приложения)
node android/ci-friends.js > $OUT/friends.txt 2>&1 || true
adb exec-out screencap -p > $OUT/1b-friends.png
adb shell am start -n ru.kentovka.app/.MainActivity --es kconnect 10.0.2.2:8443 > $OUT/start2.txt 2>&1
sleep 25
adb exec-out screencap -p > $OUT/2-server.png
# голосовой канал: нажимаем через отладчик страницы
node android/ci-webview.js > $OUT/webview.txt 2>&1 || true
adb exec-out screencap -p > $OUT/3-voice.png
# кнопка «назад»: чат → список каналов → главная (голос не рвётся) → свернуть, но не закрыть
adb shell input keyevent 4; sleep 2; adb exec-out screencap -p > $OUT/4-back1.png
adb shell input keyevent 4; sleep 2; adb exec-out screencap -p > $OUT/4-back2.png
adb shell input keyevent 4; sleep 2; adb exec-out screencap -p > $OUT/4-back3.png
adb shell input keyevent 4; sleep 2
(echo "pid: $(adb shell pidof ru.kentovka.app)"; adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity") > $OUT/back-alive.txt
adb logcat -d > $OUT/logcat-all.txt
adb shell run-as ru.kentovka.app ls -la files files/nodeproject files/kentovka > $OUT/files.txt 2>&1
adb logcat -d -s kentovka kentovka-node AndroidRuntime > $OUT/logcat-node.txt
grep -E "AndroidRuntime|FATAL|chromium|Kentovka|ru.kentovka" $OUT/logcat-all.txt | tail -400 > $OUT/logcat.txt
adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" > $OUT/activity.txt
exit 0
