const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const lastValues = {};
const dataDir = path.join(__dirname, './data');
// Ordner automatisch anlegen
fs.mkdirSync(dataDir, { recursive: true });

const DB_PATH = path.join(__dirname, './data/history.db');

const db = new sqlite3.Database(DB_PATH);

function getHistoryValue(entity, cfg) {
  if (!cfg?.source?.key) {
    return entity?.value;
  }

  const value = entity?.[cfg.source.key];

  if (value === undefined || value === null || value === '') {
    return null;
  }

  return value;
}

// Letzten Wetr laden
function loadLastValues() {

  db.all(`
    SELECT entityId, value
    FROM history_boolean
    WHERE rowid IN (
      SELECT MAX(rowid)
      FROM history_boolean
      GROUP BY entityId
    )
  `, (err, rows) => {

    if (err) {
      console.error(
        'Fehler beim Laden der letzten History-Werte:',
        err
      );
      return;
    }

    rows.forEach(row => {

      lastValues[row.entityId] =
        Boolean(row.value);

    });

  });

}

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

// Binary
db.run(`
  CREATE TABLE IF NOT EXISTS history_boolean (
    entityId TEXT,
    timestamp INTEGER,
    value INTEGER
  );
`);

loadLastValues();

function writeBooleanHistory(entityId, value, cfg) {

  if (!cfg) return;
  if (!cfg.enabled) return;

  const timestamp =
    Math.floor(Date.now() / 1000);

  const oldValue =
    lastValues[entityId];

  // Nur Zustandswechsel speichern
  if (oldValue === value) {
    return;
  }

  lastValues[entityId] = value;

  db.run(`
    INSERT INTO history_boolean (
      entityId,
      timestamp,
      value
    )
    VALUES (?, ?, ?)
  `, [
    entityId,
    timestamp,
    value ? 1 : 0
  ]);
}

function writeNumericHistory (entityId, value, cfg) {

    // 🔥 global aus
  if (!cfg) return;

  // 🔥 entity nicht aktiviert
  if (!cfg.enabled) return;

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

function writeHistory(entityId, entity, cfg) {
    const value = getHistoryValue(entity, cfg);

    if (cfg?.source?.type === 'boolean' || entity.type === 'binary_sensor') {
        if (typeof value !== 'boolean') return;
        return writeBooleanHistory(
            entityId,
            value,
            cfg
        );
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;

    return writeNumericHistory(
        entityId,
        numericValue,
        cfg
    );
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

    db.run(`
      DELETE FROM history_boolean
      WHERE timestamp < ?
    `, [cutoff]);

  }, 60 * 1000);

}

module.exports = {
  writeHistory,
  startCleanup,
  db
};
