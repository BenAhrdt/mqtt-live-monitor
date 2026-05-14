#!/usr/bin/env bash
set -e

APP_DIR="/opt/mqtt-live-monitor"
SERVICE_NAME="mqtt-live-monitor"
BACKUP_DIR="/root/mqtt-live-monitor-backup"

echo "==== Update MQTT Live Monitor ===="

if [ "$EUID" -ne 0 ]; then
  echo "Bitte als root ausführen (sudo bash update.sh)"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

echo ">> Backup config.json"
if [ -f config.json ]; then
  cp config.json "$BACKUP_DIR/config.json.backup"
fi

echo ">> Backup credentials.json"
if [ -f credentials.json ]; then
  cp credentials.json "$BACKUP_DIR/credentials.json.backup"
fi

echo ">> Hole neuesten Stand von GitHub"
git fetch --all --tags
git checkout -f main
git reset --hard origin/main

echo ">> Stelle config.json wieder her"
if [ -f "$BACKUP_DIR/config.json.backup" ]; then
  cp "$BACKUP_DIR/config.json.backup" config.json
fi

echo ">> Stelle credentials.json wieder her"
if [ -f "$BACKUP_DIR/credentials.json.backup" ]; then
  cp "$BACKUP_DIR/credentials.json.backup" credentials.json
fi

echo ">> Prüfe Node.js Version"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)

  if [ "$NODE_MAJOR" -lt 22 ]; then
    echo ">> Upgrade Node.js auf v22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt install -y nodejs

    echo ">> Entferne alte node_modules (wegen ABI Änderungen)"
    rm -rf node_modules
  else
    echo ">> Node.js Version ist aktuell: $(node -v)"
  fi
else
  echo ">> Installiere Node.js v22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
fi

echo ">> Installiere npm Abhängigkeiten"
npm install --omit=dev

echo ">> Rebuild native modules"
npm rebuild

echo ">> Cleanup"
npm prune

echo ">> Lade systemd neu"
systemctl daemon-reload

echo ">> Starte Service neu"
if ! systemctl restart "$SERVICE_NAME"; then
  echo "❌ Restart fehlgeschlagen"
  systemctl status "$SERVICE_NAME" --no-pager
  exit 1
fi

echo ">> Prüfe Version"

SUCCESS=0

for i in {1..10}; do
  if curl -s http://127.0.0.1:3000/api/version > /dev/null; then
    curl -s http://127.0.0.1:3000/api/version
    echo ""
    SUCCESS=1
    break
  fi
  sleep 1
done

if [ "$SUCCESS" -ne 1 ]; then
  echo "❌ API nicht erreichbar nach Start"
  systemctl status "$SERVICE_NAME" --no-pager
fi

echo ""
echo "==== Update abgeschlossen ===="