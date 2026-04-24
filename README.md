# MQTT Live Monitor

Ein einfacher Web-Monitor für MQTT-Nachrichten mit Live-Ansicht, Filter, Detailansicht und decodierten Daten (z. B. ChirpStack).

---

## ⚡ Quick Start
Git installieren, wenn nicht vorhanden
```bash
apt install -y git
```
Repository klonen
```bash
git clone https://github.com/BenAhrdt/mqtt-live-monitor.git
```
In das Verzeichnis des mqtt-live-monitors wechseln
```bash
cd mqtt-live-monitor
```
Installationsscript aufrufen
```bash
bash install.sh
```
---

## 🚀 Installation (Details)

Das Installations-Skript übernimmt automatisch:

- Installation von Node.js / npm
- Installation von git (falls nicht vorhanden)
- Installation aller Abhängigkeiten (npm install)
- Einrichtung als systemd Service
- automatischer Start beim Systemstart

---

Installationsscript aufrufen
```bash
bash install.sh
```
---

## 🚀 Update

Das Updatescript (sofern schon vorhanden) übernimmt automatisch das update

```bash
cd /opt/mqtt-live-monitor
sudo bash update.sh
```

Sollte noch keine update.sh vorhanden sein, dann folgernde Befehle ausführen:

```bash
cd /opt/mqtt-live-monitor
cp config.json /root/config.json.backup
git fetch --all --tags
git checkout -f main
git reset --hard origin/main
cp /root/config.json.backup config.json
npm install --omit=dev
systemctl daemon-reload
systemctl restart mqtt-live-monitor
```
---

## 🌐 Zugriff

Nach der Installation erreichst du die Weboberfläche unter:

http://<IP-DEINES-SERVERS>:3000

Beispiel:

http://192.168.1.100:3000

---

## 🔧 Service verwalten

Status anzeigen:

systemctl status mqtt-live-monitor

Neustarten:

systemctl restart mqtt-live-monitor

Stoppen:

systemctl stop mqtt-live-monitor

Logs anzeigen:

journalctl -u mqtt-live-monitor -f

---

## Changelog

### V1.1.5 Update Test
* (BenAhrdt) Test für Update Script

### V1.1.4 Sensor als Entität hinzugefügt
* (BenAhrdt) Der Entitätstyp sensor, wurde hinzugefügt

### V1.1.3 Icon
* (BenAhrdt) icon hinzugefügt

### V1.1.2 Korrektur im Update Verhalten
* (BenAhrdt) update skript verändert


### V1.1.1 Updatefähig
* (BenAhrdt) Coder updatefägi durch button (erster Test)

### V1.1.0 Einige Entitäten verfügbar

## 📦 Voraussetzungen

- Debian / Ubuntu (z. B. LXC Container)
- Root-Rechte für Installation

---

## 📄 Lizenz

Dieses Projekt steht unter der MIT-Lizenz.

Das bedeutet:

- freie Nutzung
- freie Weitergabe
- auch kommerziell nutzbar

Ohne Gewährleistung oder Haftung.