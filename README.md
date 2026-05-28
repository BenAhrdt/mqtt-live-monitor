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
Umgebungsvariablen anlegen
```bash
nano .env
```
Inhalt der Datei:
```bash
SESSION_SECRET=irgendeinLangesGeheimesSecret
USE_HTTPS=false
RATE_LIMIT=20
```
Erklärung:
Den Key, könnt ihr euch wie folgt erzeugen und einfach einsetzen:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
USE_HTTPS:
wenn Ihr das Tool online stellen wollt, dann nutzt am besten dieses wert = true

Rate_LIMIT:
Limit der Loginversuche innerhalb von 15 Minuten

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

Komforatebl über den Webserver.
Wird eine neue Version online erkannt, so wird dies angezeigt.
Durch einen Klick auf den Button und bestätigen, wird ein Update durchgeführt.
Ein Reload der Seite erfolgt nach dem update. 
![Update](image.png)

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

## Login
Zu Login erscheint dieses Fenster
![alt text](image-1.png)

Die Grundeinstellungen, wenn kein User angelegt ist sind
Benutzername:   admin
Passwort:       admin

Dies sollte nach dem ersten Login durch Anlege eines Benutzers in der Benutzerverwealtung geändert werden.

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

### V1.6.7 Cconfig removed
* (BenAhrdt) config.json entfernt

### V1.6.6 CHecks für spätere history Store
* (BenAhrdt) Erste Chartdarstellungen für Sensorwerte.
* (BenAhrdt) Erste Logiken / Berechnungen möglich. AKtuell nur number Zuweisungen.

### V1.6.5 Login sicherer gemacht
* (BenAhrdt) Secutity eingebau bezüglich secret und rateLimit

### V1.6.4 Bugfix Entity virtuelles Gerät
* (BenAhrdt) Entities können wirder ausgewählt werden.

### V1.6.3 Useransicht verbessert
* (BenAhrdt) Sidebar Handle Position festgesetzt
* (BenAhrdt) Slider vor Input unter den Text
* (BenAhrdt) User sieht kein Home und keione Home Geräte

### V1.6.2 Neues Benutzerkonzept (1. Step)
* (BenAhrdt) Usermanagement Step 1
* (BenAhrdt) Drag & Drop verbessert
* (BenAhrdt) Nur nötigste API Routen frei
* (BenAhrdt) Toggelbutton für Mobile Anficht angepasst

### V1.6.1 User Login
* (BenAhrdt) User Login
* (BenAhrdt) Logiken (1. Step)
* (BenAhrdt) Hover auch in Settings
* (BenAhrdt) Virtuelle Geräte, werden nicht mehr in eigener Entitätsauswahl angezeigt
* (BenAhrdt) Löschen der Friendly Names, wenn Gerät gelöscht wird, oder wenn dashboard gelöscht wird

### V1.6.0 Virtuelle Geräte (2. Step)
* (BenAhrdt) Umbenennen der Entitäten in Virtuellen Geräten unabhängig von den realen Geräten
* (BenAhrdt) Windows Installer aus dem Repo entfernt
* (BenAhrdt) Entitätsuche in virtuellen Geräten auch nach Gerätename möglich

### V1.5.9 Mehrere gleiche Entitäten auf einem Dashboard
* (BenAhrdt) Check for updates auf 10min Intervall gestellt
* (BenAhrdt) Mehrere Entitäten können auf einem Dashboard sein.

### V1.5.8 Windows Installer
* (BenAhrdt) Erster Windows installer

### V1.5.5 Virtuelle Geräte (1. Step)
* (BenAhrdt) Umstellung des Hashverfahrens
* (BenAhrdt) Virtuelle Geräte (1. Step)

### V1.5.4 Anzeigen von abgewählten ENtitäten in den Settings
* (BenAhrdt) Abgewählte Entitäten, wurden fälschlicherweise nicht mehr angezeigt.

### V1.5.3 Kein Rendern im Bearbeitungsmodus
* (BenAhrdt) Rendern im Bearbeitungsmodus deaktiviert, damit drag and Drop besser funktioniert.

### V1.5.2 Bugfix Bedienung
* (BenAhrdt) Bugfix in Sethandling

### V1.5.1 Farbanpassungen / Drag & Drop
* (BenAhrdt) Farbanpassungen für das neue helle Konzept
* (BenAhrdt) Drag & Drop auch für Dashboards und Entities

### V1.5.0 Einführung Hell / dunkel Optik
* (BenAhrdt) Möglichkeit das optische Erscheinungsbild von Hell auf Dunkel zu ändern.

### Older entries

[Older changelogs can be found there](CHANGELOG_OLD.md)

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