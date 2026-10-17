#!/usr/bin/env bash
# Установка моста Кентовки на VPS (Ubuntu 20.04+ / Debian 11+).
# Запуск на VPS от root:   bash install.sh
# В конце скрипт напечатает ссылку KNTB1.… — её вставляют в Кентовку («Аккаунт и сеть» → «Мост на своём VPS»).
set -euo pipefail

DIR=/opt/kentovka-bridge
SRC="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" != "0" ]; then echo "Запусти от root: sudo bash install.sh"; exit 1; fi

echo "== Ставлю Node.js и coturn (TURN для голоса)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nodejs coturn curl

mkdir -p "$DIR"
cp "$SRC/relay.js" "$DIR/relay.js"
id kentovka >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin kentovka
chown -R kentovka:kentovka "$DIR"

PUBIP="$(curl -s --max-time 5 https://api.ipify.org || true)"
[ -z "$PUBIP" ] && PUBIP="$(hostname -I | awk '{print $1}')"

# первый запуск создаёт relay.json с ключом моста и секретом TURN
runuser -u kentovka -- env KENTOVKA_BRIDGE_QUIET=1 node "$DIR/relay.js" link "$PUBIP" >/dev/null
node -e "const f='$DIR/relay.json';const c=require(f);c.publicIp='$PUBIP';require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
TS="$(node -e "console.log(require('$DIR/relay.json').turnSecret)")"
CTL="$(node -e "console.log(require('$DIR/relay.json').controlPort)")"
PF="$(node -e "console.log(require('$DIR/relay.json').portFrom)")"
PT="$(node -e "console.log(require('$DIR/relay.json').portTo)")"

echo "== Настраиваю TURN…"
cat > /etc/turnserver.conf <<EOF
listening-port=3478
external-ip=$PUBIP
fingerprint
use-auth-secret
static-auth-secret=$TS
realm=kentovka
min-port=49160
max-port=49400
total-quota=200
no-cli
no-tls
no-dtls
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
EOF
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn

echo "== Запускаю мост как службу…"
cat > /etc/systemd/system/kentovka-bridge.service <<EOF
[Unit]
Description=Kentovka bridge
After=network.target

[Service]
User=kentovka
WorkingDirectory=$DIR
ExecStart=/usr/bin/env node $DIR/relay.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now kentovka-bridge
systemctl restart kentovka-bridge

# если на VPS включён ufw — открываем только порты моста
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "$CTL"/tcp; ufw allow "$PF:$PT"/tcp; ufw allow 3478; ufw allow 49160:49400/udp
fi

echo
echo "Готово. Порты: $CTL (мост), $PF-$PT (адреса хостов), 3478 и 49160-49400/udp (голос)."
echo "Если у хостинга есть свой файрвол в панели — открой там эти же порты."
echo
echo "Ссылка на мост — вставь её в Кентовку («Аккаунт и сеть» → «Мост на своём VPS»):"
echo
runuser -u kentovka -- node "$DIR/relay.js" link "$PUBIP"
echo
echo "Ссылку можно дать друзьям-хостам: с ней их серверы тоже будут доступны через этот мост."
