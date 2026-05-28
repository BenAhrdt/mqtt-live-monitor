const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const lastValues = {};
const dataDir = path.join(__dirname, './data');
// Ordner automatisch anlegen
fs.mkdirSync(dataDir, { recursive: true });

const DB_PATH = path.join(__dirname, './data/history.db');

const db = new sqlite3.Database(DB_PATH);

// 🔥 Tabelle erstellen (wenn nicht vorhanden)
db.run(`
  CREATE TABLE IF NOT EXISTS history (
    entityId TEXT,
    bucket INTEGER,

    min REAL,
    max REAL,
    avg REAL,

    first REAL,
    last REAL,

    positive_change REAL,
    negative_change REAL,

    count INTEGER,
    PRIMARY KEY (entityId, bucket)
  );
`);

function writeHistory(entityId, value, cfg) {

    // 🔥 global aus
  if (!cfg) return;

  // 🔥 entity nicht aktiviert
  if (!cfg.enabled) return;

  const timestamp = Math.floor(Date.now() / 1000);

  const bucketSize = (cfg.bucketMinutes || 5) * 60;

  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / bucketSize) * bucketSize;

  // letzter bekannter Wert
  const oldValue = lastValues[entityId];

  // delta berechnen
  const delta =
    oldValue != null
      ? value - oldValue
      : 0;

  // positive / negative Änderungen
  const positiveChange =
    delta > 0 ? delta : 0;

  const negativeChange =
    delta < 0 ? Math.abs(delta) : 0;

  // cache aktualisieren
  lastValues[entityId] = value;

  db.run(`
    INSERT INTO history (

      entityId,
      bucket,

      min,
      max,
      avg,

      first,
      last,

      positive_change,
      negative_change,

      count

    )
    VALUES (

      ?, ?,

      ?, ?, ?,

      ?, ?,

      ?, ?,

      1

    )

    ON CONFLICT(entityId, bucket)
    DO UPDATE SET

      min = MIN(min, excluded.min),

      max = MAX(max, excluded.max),

      avg = (
        (avg * count) + excluded.avg
      ) / (count + 1),

      last = excluded.last,

      positive_change =
        positive_change
        + excluded.positive_change,

      negative_change =
        negative_change
        + excluded.negative_change,

      count = count + 1

  `, [

    entityId,
    bucket,

    value,
    value,
    value,

    value,
    value,

    positiveChange,
    negativeChange

  ]);

}
const config = {
  historyRetentionHours: 24 * 7,
}
// Jede Minute cleanup => Alles größer X aus Datenbank schmeißen
function startCleanup() {

  const retentionHours =
    config.historyRetentionHours || 24;

  setInterval(() => {

    const cutoff =
      Math.floor(Date.now() / 1000)
      - (retentionHours * 60 * 60);

    db.run(`
      DELETE FROM history
      WHERE bucket < ?
    `, [cutoff]);

  }, 60 * 1000);

}

module.exports = {
  writeHistory,
  startCleanup,
  db
};