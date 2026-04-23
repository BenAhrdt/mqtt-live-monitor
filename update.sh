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

echo ">> Hole neuesten Stand von GitHub"
git fetch --all --tags
git checkout -f main
git reset --hard origin/main

echo ">> Stelle config.json wieder her"
if [ -f "$BACKUP_DIR/config.json.backup" ]; then
  cp "$BACKUP_DIR/config.json.backup" config.json
fi

echo ">> Installiere npm Abhängigkeiten"
npm install --omit=dev

echo ">> Lade systemd neu"
systemctl daemon-reload

echo ">> Starte Service neu"
systemctl restart "$SERVICE_NAME"

echo ">> Prüfe Version"
curl -s http://127.0.0.1:3000/api/version || true

echo ""
echo "==== Update abgeschlossen ===="