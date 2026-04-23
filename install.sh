#!/usr/bin/env bash
set -e

APP_DIR="/opt/mqtt-live-monitor"
SERVICE_NAME="mqtt-live-monitor"
REPO_URL="https://github.com/BenAhrdt/mqtt-live-monitor.git"

echo "==== MQTT Live Monitor Installer ===="

if [ "$EUID" -ne 0 ]; then
  echo "Bitte als root ausführen (sudo bash install.sh)"
  exit 1
fi

echo ">> Update Paketliste"
apt update

echo ">> Installiere benötigte Pakete"
apt install -y git curl

if ! command -v node >/dev/null 2>&1; then
  echo ">> Installiere Node.js"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
else
  echo ">> Node.js bereits installiert"
fi

if [ -d "$APP_DIR/.git" ]; then
  echo ">> Bestehende Git-Installation gefunden in $APP_DIR"
else
  echo ">> Installationsverzeichnis vorbereiten"
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

if [ ! -f config.json ] && [ -f config.example.json ]; then
  echo ">> Erstelle config.json aus config.example.json"
  cp config.example.json config.json
fi

echo ">> Installiere npm Abhängigkeiten"
npm install --omit=dev

echo ">> Installiere systemd Service"
cp deploy/${SERVICE_NAME}.service /etc/systemd/system/${SERVICE_NAME}.service

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}

echo ""
echo "==== Installation abgeschlossen ===="
echo "Webinterface: http://$(hostname -I | awk '{print $1}'):3000"
echo ""
echo "Service Status prüfen:"
echo "systemctl status ${SERVICE_NAME}"