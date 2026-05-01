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
apt install -y git curl build-essential python3 make g++

echo ">> Prüfe Node.js"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)

  if [ "$NODE_MAJOR" -lt 22 ]; then
    echo ">> Upgrade Node.js auf v22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt install -y nodejs
  else
    echo ">> Node.js Version ist aktuell: $(node -v)"
  fi
else
  echo ">> Installiere Node.js v22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
fi

echo ">> Installationsverzeichnis vorbereiten"
rm -rf "$APP_DIR"
git clone "$REPO_URL" "$APP_DIR"

cd "$APP_DIR"

if [ ! -f config.json ] && [ -f config.example.json ]; then
  echo ">> Erstelle config.json aus config.example.json"
  cp config.example.json config.json
fi

echo ">> Installiere npm Abhängigkeiten"
npm install --omit=dev

echo ">> Rebuild native modules (z. B. bcrypt)"
npm rebuild

echo ">> Installiere systemd Service"
cp deploy/${SERVICE_NAME}.service /etc/systemd/system/${SERVICE_NAME}.service

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}

echo ">> Warte auf API..."

SUCCESS=0

for i in {1..10}; do
  if curl -s http://127.0.0.1:3000/api/version > /dev/null; then
    echo ">> API erreichbar:"
    curl -s http://127.0.0.1:3000/api/version
    echo ""
    SUCCESS=1
    break
  fi
  sleep 1
done

if [ "$SUCCESS" -ne 1 ]; then
  echo "❌ API nicht erreichbar nach Installation"
  systemctl status "$SERVICE_NAME" --no-pager
fi

echo ""
echo "==== Installation abgeschlossen ===="
echo "Webinterface: http://$(hostname -I | awk '{print $1}'):3000"
echo ""
echo "Service Status prüfen:"
echo "systemctl status ${SERVICE_NAME}"