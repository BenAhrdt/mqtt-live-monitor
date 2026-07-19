const session = require('express-session');
const sqlite3 = require('sqlite3');
const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const mqtt = require("mqtt");
const packageJson = require("./package.json");
const { exec } = require("child_process");
const bcryptjs = require("bcryptjs");
const rateLimit = require("express-rate-limit")
const logicEngine = require('./logicEngine');
const historyStore = require('./historyStore');
const { db } = require('./historyStore');

const dotenv = require("dotenv");
dotenv.config();

const SESSION_DAYS = 30;
const SESSION_MAX_AGE_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = 'mqtt_live_monitor_session';

class SQLiteSessionStore extends session.Store {
  constructor(dbPath) {
    super();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new sqlite3.Database(dbPath);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        session TEXT NOT NULL,
        username TEXT,
        expires_at INTEGER NOT NULL
      )
    `);

    this.cleanupTimer = setInterval(() => {
      this.db.run('DELETE FROM sessions WHERE expires_at <= ?', Date.now());
    }, 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  get(sid, callback) {
    this.db.get(
      'SELECT session, expires_at FROM sessions WHERE sid = ?',
      sid,
      (err, row) => {
        if (err) return callback(err);
        if (!row) return callback(null, null);
        if (row.expires_at <= Date.now()) {
          return this.destroy(sid, destroyErr => callback(destroyErr, null));
        }

        try {
          callback(null, JSON.parse(row.session));
        } catch (parseErr) {
          callback(parseErr);
        }
      }
    );
  }

  set(sid, sessionData, callback = () => {}) {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires).getTime()
      : Date.now() + SESSION_MAX_AGE_MS;
    const username = sessionData.user?.username || null;

    this.db.run(
      `INSERT INTO sessions (sid, session, username, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET
         session = excluded.session,
         username = excluded.username,
         expires_at = excluded.expires_at`,
      sid,
      JSON.stringify(sessionData),
      username,
      expiresAt,
      callback
    );
  }

  destroy(sid, callback = () => {}) {
    this.db.run('DELETE FROM sessions WHERE sid = ?', sid, callback);
  }

  touch(sid, sessionData, callback = () => {}) {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires).getTime()
      : Date.now() + SESSION_MAX_AGE_MS;
    this.db.run(
      'UPDATE sessions SET expires_at = ? WHERE sid = ?',
      expiresAt,
      sid,
      callback
    );
  }

  destroyUserSessions(username, exceptSid = null, callback = () => {}) {
    const sql = exceptSid
      ? 'DELETE FROM sessions WHERE username = ? AND sid != ?'
      : 'DELETE FROM sessions WHERE username = ?';
    const params = exceptSid ? [username, exceptSid] : [username];
    this.db.run(sql, params, callback);
  }
}

let CONFIG_PATH;
const USER_FILE = path.join(__dirname, "usercredentials.json");
const EXTENSION_CONFIG_FILE = path.join(__dirname, "data", "extension-configs.json");
const EXTENSION_TOKENS_FILE = path.join(__dirname, "data", "extension-tokens.json");
const LOGICAL_FILE = path.join(__dirname, "data", "logical-devices.json");

function readUsers() {
  try {
    const filePath = path.join(__dirname, 'usercredentials.json');

    if (!fs.existsSync(filePath)) {
      return { users: [] }; // 🔥 wichtig
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  } catch (err) {
    console.error("Fehler beim Lesen der User:", err);
    return { users: [] };
  }
}

function writeUsers(data) {
  fs.writeFileSync(USER_FILE, JSON.stringify(data, null, 2));
}

function hashExtensionToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token))
    .digest("hex");
}

function readExtensionTokens() {
  try {
    if (!fs.existsSync(EXTENSION_TOKENS_FILE)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(EXTENSION_TOKENS_FILE, "utf8"));
  } catch (err) {
    console.error("Fehler beim Lesen extension-tokens.json:", err.message);
    return {};
  }
}

function writeExtensionTokens(data) {
  const dir = path.dirname(EXTENSION_TOKENS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    EXTENSION_TOKENS_FILE,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

function getUserByUsername(username) {
  const data = readUsers();
  return (data.users || []).find(user => user.username === username);
}

function getExtensionUserFromToken(token) {
  if (!token) return null;

  const tokens = readExtensionTokens();
  const record = tokens[hashExtensionToken(token)];
  if (!record?.username) return null;

  const user = getUserByUsername(record.username);
  if (!user || user.active === false) return null;

  return {
    username: user.username,
    roles: user.roles || [],
    isDefault: user.isDefault
  };
}

function attachExtensionUserFromToken(req) {
  const user = getExtensionUserFromToken(getBearerToken(req));

  if (!user) {
    return false;
  }

  req.extensionUser = user;
  return true;
}

function getRequestUser(req) {
  return req.session?.user || req.extensionUser || null;
}

// 👉 prüfen ob Electron läuft
const isElectron = !!process.versions.electron;

if (isElectron) {
    const { app } = require("electron");

    CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
} else {
    CONFIG_PATH = path.join(__dirname, "config.json");
}

const CONFIG_EXAMPLE_PATH = path.join(__dirname, "config-example.json");
const BROWSER_EXTENSION_DIR = path.join(__dirname, "browser-extension");

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[i] = value >>> 0;
  }

  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function getZipDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());

  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date:
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate()
  };
}

function collectFilesRecursive(dir, baseDir = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  entries.forEach(entry => {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFilesRecursive(fullPath, baseDir));
      return;
    }

    if (!entry.isFile()) return;

    files.push({
      fullPath,
      zipPath: path
        .join("browser-extension", path.relative(baseDir, fullPath))
        .split(path.sep)
        .join("/")
    });
  });

  return files;
}

function createZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach(file => {
    const data = fs.readFileSync(file.fullPath);
    const stats = fs.statSync(file.fullPath);
    const name = Buffer.from(file.zipPath, "utf8");
    const checksum = crc32(data);
    const { time, date } = getZipDateTime(stats.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  });

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}



/**************************************************************
 * ************************************************************
 * ***********************************************************/
// COnfig und .env laden und mergen

// 🔥 config initialisieren + erweitern
try {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log("⚠️ config.json fehlt → erstelle aus config-example.json");

    if (fs.existsSync(CONFIG_EXAMPLE_PATH)) {
      fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
    } else {
      console.warn("⚠️ config-example.json fehlt → fallback auf leere config");
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2));
    }
  } else {

      // 🔥 Alte Auth erkennen
    const hasEnv =
      fs.existsSync(
        path.join(process.cwd(), '.env')
      );
    
    // Nur wenn .env da ist, muss auth aktiviert werden (migration)
    if(hasEnv) {
      // 🔥 Bestehende Config laden
      const userConfig = JSON.parse(
        fs.readFileSync(CONFIG_PATH, "utf8")
      );

      let changed = false;

      // 🔥 auth Objekt fehlt
      if (!userConfig.auth) {
        userConfig.auth = {};
        changed = true;
      }
      // 🔥 auth.enabled fehlt
      if (userConfig.auth.enabled === undefined) {
        userConfig.auth.enabled = hasEnv;
        changed = true;
      }

      // 🔥 Nur speichern wenn geändert
      if (changed) {
        fs.writeFileSync(
          CONFIG_PATH,
          JSON.stringify(userConfig, null, 2)
        );

      }
    }
}

  // 🔥 merge defaults
  if (fs.existsSync(CONFIG_EXAMPLE_PATH)) {
    const userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const defaultConfig = JSON.parse(fs.readFileSync(CONFIG_EXAMPLE_PATH, "utf8"));

    const merged = deepMergeDefaults(defaultConfig, userConfig);

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  }

} catch (err) {
  console.error("❌ Fehler beim Initialisieren der config:", err.message);
}





const ENV_PATH = path.join(__dirname, '.env');
const ENV_EXAMPLE_PATH = path.join(__dirname, '.env.example');

try {
  if (!fs.existsSync(ENV_PATH)) {
    console.log('⚠️ .env fehlt → erstelle aus .env.example');

    if (fs.existsSync(ENV_EXAMPLE_PATH)) {
      fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
      dotenv.config();
    } else {
      console.warn('⚠️ Keine .env.example gefunden');
    }
  } else {
    // 🔥 vergleichen & ergänzen
    if (fs.existsSync(ENV_EXAMPLE_PATH)) {

      const envContent = fs.readFileSync(ENV_PATH, 'utf8');
      const exampleContent = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');

      const env = parseEnv(envContent);
      const example = parseEnv(exampleContent);

      let updated = false;
      let newEnvContent = envContent.trim() + '\n';

      for (const key in example) {
        if (!(key in env)) {
          console.log(`🔧 Ergänze ENV Key: ${key}`);
          newEnvContent += `${key}=${example[key]}\n`;
          updated = true;
        }
      }

      if (updated) {
        fs.writeFileSync(ENV_PATH, newEnvContent);
        dotenv.config();
        console.log('🔧 .env wurde erweitert');
      }
    }
  }

} catch (err) {
  console.error('❌ Fehler bei .env Handling:', err.message);
}

/**************************************************************
 * ************************************************************
 * ***********************************************************/



const { Server } = require("socket.io");

const https = require('https');

const CRED_FILE = path.join(__dirname, "credentials.json");

// Version
function fetchLatestVersion() {
  return new Promise((resolve) => {
    https.get(
      'https://api.github.com/repos/BenAhrdt/mqtt-live-monitor/releases/latest',
      {
        headers: { 'User-Agent': 'mqtt-live-monitor' }
      },
      (res) => {
        let data = '';

        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.tag_name || null);
          } catch {
            resolve(null);
          }
        });
      }
    ).on('error', () => resolve(null));
  });
}

const isDev = process.env.DEV_MODE === "true";
let allowedDiscoveryViaDevicePrefixes = [
  "lorawan"
];

const app = express();
app.set("trust proxy", 1)

const sessionStore = new SQLiteSessionStore(
  path.join(path.dirname(CONFIG_PATH), 'data', 'sessions.sqlite')
);

const sessionMiddleware = session({
    name: SESSION_COOKIE_NAME,
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        secure: process.env.USE_HTTPS === "true",
        sameSite: "lax",
        maxAge: SESSION_MAX_AGE_MS
    }
});

app.use(sessionMiddleware);


app.use(express.json({limit: '5mb'}));
app.use(express.static(path.join(__dirname, "public")));

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Nicht eingeloggt" });
  }
  next();
}

app.use('/api', (req, res, next) => {

  // 🔥 NEU: Auth komplett deaktiviert → alles erlauben
  if (!mqttConfig.auth?.enabled) {
    return next();
  }

  // 🔥 diese Routen bleiben öffentlich
  if (
    req.path.startsWith('/auth/login') ||
    req.path.startsWith('/auth/me') ||
    req.path.startsWith('/auth/enabled') ||
    req.path.startsWith('/extension/login')
  ) {
    return next();
  }

  if (
    req.path.startsWith('/extension/') &&
    attachExtensionUserFromToken(req)
  ) {
    return next();
  }

  return requireAuth(req, res, next);
});

const server = http.createServer(app);
const io = new Server(server);

io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  if (!mqttConfig.auth?.enabled) {
    return next();
  }

  const user =
    socket.request.session?.user ||
    getExtensionUserFromToken(socket.handshake.auth?.token);

  if (!user) {
    return next(new Error("Nicht eingeloggt"));
  }

  socket.user = user;
  next();
});

const loggingFilter = [ 'homeassistant/sensor/badezimmer_fenster/zigbee2mqtt_0_0x00158d0002a63f48_battery/config',
                        'lorawan_0/badezimmer_fenster/zigbee2mqtt_0_0x00158d0002a63f48_battery/state',
                        'homeassistant/sensor/badezimmerfenster/lorawan_1_942ea85a-1ea8-4dff-8900-8141897f95b9_devices_a840414155599145_uplink_decoded_batterypercent/config',
                        'lorawan_1/badezimmerfenster/lorawan_1_942ea85a-1ea8-4dff-8900-8141897f95b9_devices_a840414155599145_uplink_decoded_batterypercent/state'
                      ];
const debugLog = [];
const MAX_LOG = 500;

function addLog(type, topic, data) {
  if (!loggingFilter.length || loggingFilter.some(filter => topic.includes(filter))) {
    let safeData;
    if (Buffer.isBuffer(data)) {
      safeData = { payload: data.toString() };
    } else if (typeof data === 'string') {
      safeData = { payload: data };
    } else if (typeof data === 'object' && data !== null) {
      safeData = data;
    } else {
      safeData = { value: data };
    }

    debugLog.unshift({
      ts: new Date().toISOString(),
      type,
      topic,
      ...safeData
    });

    if (debugLog.length > MAX_LOG) {
      debugLog.pop();
    }
  }
}
app.get("/api/log", (req, res) => {
  res.json(debugLog);
});

// Admin login
function readCredentials() {
  try {
    if (!fs.existsSync(CRED_FILE)) {
      return { passwordHash: null };
    }

    const raw = fs.readFileSync(CRED_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Fehler beim Lesen credentials.json:", err.message);
    return { passwordHash: null };
  }
}

app.get("/api/admin/exists", (req, res) => {
  const creds = readCredentials();

  res.json({ exists: !!creds.passwordHash });
});

function writeCredentials(data) {
  try {
    fs.writeFileSync(CRED_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Fehler beim Schreiben credentials.json:", err.message);
  }
}

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Zu viele Loginversuche"
    }
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  const data = readUsers();
  const users = data.users || [];

  // 🔥 NORMALER LOGIN
  const user = users.find(u => u.username === username);

  if (!user) {
    return res.status(401).json({ error: "User nicht gefunden" });
  }

  if (!user.active) {
    return res.status(401).json({ error: "User nicht aktiv" });
  }

  const valid = await bcryptjs.compare(password, user.passwordHash);

  if (!valid) {
    return res.status(401).json({ error: "Falsches Passwort" });
  }

  req.session.user = {
    username: user.username,
    roles: user.roles,
    isDefault: user.isDefault
  };

  res.json({
    success: true, 
    username: req.session.user.username,
    roles: req.session.user.roles,
    isDefault: req.session.user.isDefault
  });
});

app.get('/api/auth/enabled', (req, res) => {
  res.json({
    enabled: mqttConfig.auth?.enabled ?? false
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) {
    return res.status(401).end();
  }

  res.json({
    success: true, 
    username: req.session.user.username,
    roles: req.session.user.roles,
    isDefault: req.session.user.isDefault
  });
});

app.post('/api/auth/logout', (req, res) => {
  console.log("Logout aufgerufen");

  req.session.destroy(err => {
    if (err) {
      console.error("Logout Fehler:", err);
      return res.status(500).json({ error: 'Logout fehlgeschlagen' });
    }

    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.USE_HTTPS === "true",
      sameSite: 'lax'
    });
    res.json({ success: true });
  });
});

app.post('/api/settings/auth', requireAdmin, (req, res) => {

  try {

    const enabled =
      !!req.body.enabled;

    // 🔥 Config laden
    const config = JSON.parse(
      fs.readFileSync(
        CONFIG_PATH,
        'utf8'
      )
    );

    config.auth ??= {};

    config.auth.enabled = enabled;

    // 🔥 speichern
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(config, null, 2)
    );

    res.json({
      success: true
    });

    // 🔥 verzögert neustarten
    setTimeout(() => {

      process.exit(0);

    }, 1000);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });

  }

});

app.get('/api/browser-extension/download', requireAdmin, (req, res) => {
  try {
    if (!fs.existsSync(BROWSER_EXTENSION_DIR)) {
      return res.status(404).json({
        error: "Browser-Extension Ordner nicht gefunden"
      });
    }

    const files = collectFilesRecursive(BROWSER_EXTENSION_DIR);
    const zip = createZipBuffer(files);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="mqtt-live-monitor-browser-extension.zip"'
    );
    res.setHeader("Content-Length", zip.length);
    res.send(zip);
  } catch (err) {
    console.error("Fehler beim Erstellen des Browser-Extension ZIPs:", err);
    res.status(500).json({
      error: "Browser-Extension konnte nicht gepackt werden"
    });
  }
});

app.get('/api/users', (req, res) => {
  const data = readUsers();
  const visibleUsers = isAdminUser(req)
    ? data.users
    : data.users.filter(u => u.username === req.session?.user?.username);

  // Passwort NICHT mitsenden!
  const users = visibleUsers.map(u => ({
    username: u.username,
    roles: u.roles,
    active: u.active !== false,
    isDefault: u.isDefault
  }));

  res.json(users);
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, password, roles } = req.body;

  const data = readUsers();
  if (data.users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'User existiert bereits' });
  }

  const hash = await bcryptjs.hash(password, 10);
  const newUser = {
    username,
    passwordHash: hash,
    roles: ['Benutzergruppe 1'], // 👈 Default
    active: true
  };

  data.users.push(newUser);

  writeUsers(data);

  res.json({ success: true });
});

app.put('/api/users/:username', async (req, res) => {
  const { username } = req.params;
  const { password, roles, active } = req.body;
  const requester = req.session?.user;

  const data = readUsers();
  const user = data.users.find(u => u.username === username);

  if (!user) {
    return res.status(404).json({ error: 'User nicht gefunden' });
  }

  const isAdminRequest = isAdminUser(req);
  const isSelfRequest = requester?.username === username;

  if (!isAdminRequest && !isSelfRequest) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!isAdminRequest && (roles !== undefined || active !== undefined)) {
    return res.status(403).json({ error: 'Nur Admins dürfen Rollen oder Status ändern' });
  }

  const isDefaultAdmin = user.username === 'admin';

  // 🔥 Passwort ändern
  if (password) {
    user.passwordHash = await bcryptjs.hash(password, 10);
    if(isDefaultAdmin) {
      delete user.isDefault;
    }
  }

  // 🔥 Rollen ändern (nicht für admin)
  if (roles && !isDefaultAdmin) {
    user.roles = roles;
  }

  // 🔥 Active ändern (nicht für admin)
  if (typeof active === 'boolean' && !isDefaultAdmin) {
    user.active = active;
  }

  writeUsers(data);

  if (password || roles !== undefined || active !== undefined) {
    const keepCurrentSession = password && isSelfRequest
      && roles === undefined && active !== false
      ? req.sessionID
      : null;
    await new Promise((resolve, reject) => {
      sessionStore.destroyUserSessions(username, keepCurrentSession, err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  res.json({ success: true });
});

app.delete('/api/users/:username', (req, res) => {
  if (!isAdminUser(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.params.username === 'admin') {
    return res.status(400).json({ error: 'Der Admin-Benutzer darf nicht gelöscht werden' });
  }

  const data = readUsers();

  data.users = data.users.filter(u => u.username !== req.params.username);

  writeUsers(data);
  sessionStore.destroyUserSessions(req.params.username, null, err => {
    if (err) {
      console.error('Sessions des gelöschten Benutzers konnten nicht entfernt werden:', err);
      return res.status(500).json({ error: 'Benutzersitzungen konnten nicht entfernt werden' });
    }
    res.json({ success: true });
  });
});

app.post("/api/admin/create", requireAdmin, async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: "Passwort fehlt" });
  }

  const creds = readCredentials();

  if (creds.passwordHash) {
    return res.status(400).json({ error: "Admin existiert bereits" });
  }

  const hash = await bcryptjs.hash(password, 10)

  creds.passwordHash = hash
  writeCredentials(creds);

  res.json({ success: true });
});

app.post("/api/admin/reset", requireAdmin, (req, res) => {
  const creds = readCredentials();
  creds.passwordHash = null;
  writeCredentials(creds);
  res.json({ success: true });
});

app.post("/api/admin/change-password", requireAdmin, async (req, res) => {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword) {
        return res.status(400).json({ error: "Altes Passwort fehlt" });
    }

    const creds = readCredentials();
    const isValid = await bcryptjs.compare(oldPassword, creds.passwordHash);

    if (!isValid) {
        return res.status(401).json({ error: "Falsches Passwort" });
    }

    // 👉 löschen
    if (!newPassword) {
      creds.passwordHash = null;
        writeCredentials(creds);
        return res.json({ success: true, reset: true });
    }

    // 👉 ändern
    const hash = await bcryptjs.hash(newPassword, 10)
    creds.passwordHash = hash;
    writeCredentials(creds);
    res.json({ success: true });
});

app.post("/api/admin/login", async (req, res) => {
  const { password } = req.body;
  
  const creds = readCredentials();

  if (!creds.passwordHash) {
    return res.status(400).json({ error: "Kein Admin vorhanden" });
  }

  const isValid = await bcryptjs.compare(password, creds.passwordHash);

  if (isValid) {
    return res.json({ success: true });
  }

  res.status(401).json({ error: "Falsches Passwort" });
});

app.get('/api/update/check', async (req, res) => {
  const currentVersion = require('./package.json').version;
  const latestVersion = await fetchLatestVersion();

  res.json({
    current: currentVersion,
    latest: latestVersion,
    updateAvailable:
      !isElectron && latestVersion && latestVersion !== `v${currentVersion}`
  });
});

app.post("/api/update/run", requireAdmin, (req, res) => {
  console.log("Update per Button angefordert");

  res.json({
    success: true,
    message: "Update wird gestartet"
  });

  setTimeout(() => {
    exec("bash /opt/mqtt-live-monitor/update.sh", (err, stdout, stderr) => {
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);

      if (err) {
        console.error("Update fehlgeschlagen:", err.message);
      }
    });
  }, 1000);
});




async function ensureAdminUser() {
  const data = readUsers();

  const adminUser = data.users.find(u => u.username === 'admin');

  if (!adminUser) {
    console.log('⚠️ Kein Admin vorhanden → erstelle Default Admin');

    const hash = await bcryptjs.hash('admin', 10);

    data.users.push({
      username: 'admin',
      passwordHash: hash,
      roles: ['admin'],
      active: true,
      isDefault: true // 👈 wichtig
    });

    writeUsers(data);
  }
}






const DEFAULT_WEB_PORT = 3000;

app.get("/api/version", (req, res) => {
  res.json({
    version: packageJson.version,
  });
});

let mqttClient = null;
let targetedStateRefreshTimer = null;
let targetedStateRefreshCleanupTimer = null;
const targetedStateRefreshTopics = new Set();

/**
 * Store 1:
 * Geräte mit ihren Entitäten
 */
const deviceStore = {};
let logicalDeviceStore = {};

/**
 * Store 2:
 * Topic -> Zuordnung zu Device / Entity
 */
const topicStore = {};
const pendingStateMessages = {};
const MAX_PENDING = 1000;
const PENDING_TTL = 5 * 60 * 1000; // 5 Minuten

function cleanupPending() {
  const before = Object.keys(pendingStateMessages).length;
  const now = Date.now();
  let deleted = 0;

  for (const [topic, entry] of Object.entries(pendingStateMessages)) {
    if (now - entry.ts > PENDING_TTL) {
      delete pendingStateMessages[topic];
      deleted++;
    }
  }

  while (Object.keys(pendingStateMessages).length > MAX_PENDING) {
    const firstKey = Object.keys(pendingStateMessages)[0];
    delete pendingStateMessages[firstKey];
    deleted++;
  }

  const after = Object.keys(pendingStateMessages).length;

  if (deleted > 0) {
    BrowserLog(`Cleanup: ${deleted} Einträge aus pending gelöscht`);
  }

  BrowserLog(`Pending aktuell: ${after}`);
}

setInterval(cleanupPending, 60000);


function BrowserLog(...args) {
  const message = args.map(a =>
    typeof a === "object" ? JSON.stringify(a) : String(a)
  ).join(" ");

  io.emit("debug-log", {
    message,
    timestamp: new Date().toISOString()
  });
}


let mqttConfig = {
  webPort: 3000,
  port: 1883,
  topic: "#",
  clientId: "LiveMonitor",
  discoveryViaPrefixes: ["lorawan"],
  enabledEntityTypes: ["light", "climate", "cover", "lock", "humidifier", "lawn_mower", "sensor", "binary_sensor", "switch", "button", "number", "text"],
  customDashboards: [],
  chartConfigs: [],
  friendlyNames: {},
  auth: {
    enabled: false
  },
  history: {
    enabled: false,
    entities: {}
  }
}

allowedDiscoveryViaDevicePrefixes = Array.isArray(mqttConfig.discoveryViaPrefixes) && mqttConfig.discoveryViaPrefixes.length
  ? [...mqttConfig.discoveryViaPrefixes]
  : ["lorawan"];

loadConfigFromFile();

let mqttStatus = {
  connected: false,
  host: mqttConfig.host,
  port: mqttConfig.port,
  topic: mqttConfig.topic,
  message: "Nicht verbunden",
};

function loadConfigFromFile() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return;
    }

    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);

    mqttConfig = {
      ...mqttConfig,
      ...parsed,
      discoveryViaPrefixes: normalizeDiscoveryPrefixes(parsed.discoveryViaPrefixes),
    };

    // 👇 NEU: adminOnly sauber setzen
    mqttConfig.customDashboards = (mqttConfig.customDashboards || []).map(d => ({
      ...d,
      adminOnly: d.adminOnly ?? false,
      allowedRoles: Array.isArray(d.allowedRoles)
        ? d.allowedRoles.map(role => String(role).trim()).filter(Boolean)
        : d.adminOnly === true
          ? ["admin"]
          : [],
      devices: Array.isArray(d.devices) ? d.devices : []
    }));

    mqttConfig.chartConfigs = Array.isArray(mqttConfig.chartConfigs)
      ? mqttConfig.chartConfigs.map(config => ({
          ...config,
          createdBy: config.createdBy || 'admin',
          createdAt: config.createdAt || config.updatedAt || new Date().toISOString(),
          updatedBy: config.updatedBy || config.createdBy || 'admin',
          updatedAt: config.updatedAt || new Date().toISOString()
        }))
      : [];

    allowedDiscoveryViaDevicePrefixes = mqttConfig.discoveryViaPrefixes
      .filter(p => p.enabled)
      .map(p => p.value);

  } catch (error) {
    console.error(`Fehler beim Laden von ${path.basename(CONFIG_PATH)}:`, error.message);
  }
}

function saveConfigToFile() {
  try {
    mqttConfig.discoveryViaPrefixes = normalizeDiscoveryPrefixes(
      mqttConfig.discoveryViaPrefixes
    );

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(mqttConfig, null, 2), "utf8");
  } catch (error) {
    console.error(`Fehler beim Speichern von ${path.basename(CONFIG_PATH)}:`, error.message);
  }
}

function normalizeDiscoveryPrefixes(prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    return [{ value: "lorawan", enabled: true }];
  }

  return prefixes
    .map(p => {
      // alter String
      if (typeof p === "string") {
        return {
          value: p.trim(),
          enabled: true
        };
      }

      // neues Objekt
      if (typeof p === "object" && p !== null) {
        return {
          value: String(p.value || "").trim(),
          enabled: p.enabled !== false
        };
      }

      return null;
    })
    .filter(p => p && p.value !== "");
}

function emitStatus(status) {
  mqttStatus = { ...mqttStatus, ...status };
  io.emit("mqtt-status", mqttStatus);
}

function resetStores() {
  for (const key of Object.keys(deviceStore)) {
    delete deviceStore[key];
  }

  for (const key of Object.keys(topicStore)) {
    delete topicStore[key];
  }

}

function isDiscoveryTopic(topic) {
  return typeof topic === "string" && topic.endsWith("/config");
}

function getEntityTypeFromDiscoveryTopic(topic) {
  const parts = topic.split("/");
  return parts[1] || "unknown";
}

function parseJsonMessage(message) {
  try {
    return JSON.parse(message.toString());
  } catch (error) {
    return null;
  }
}

function getDeviceIdFromDiscovery(payload, topic) {
  return (
    payload?.device?.identifiers?.[0] ||
    payload?.device?.name ||
    payload?.unique_id ||
    topic
  );
}

function ensureDeviceExists(deviceId, payload) {
  if (!deviceStore[deviceId]) {
    deviceStore[deviceId] = {
      id: deviceId,
      name: payload?.device?.name || deviceId,
      viaDevice: payload?.device?.via_device || "",
      swVersion: payload?.device?.sw_version || "",
      entities: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  } else {
    if (!deviceStore[deviceId].name && payload?.device?.name) {
      deviceStore[deviceId].name = payload.device.name;
    }

    if (!deviceStore[deviceId].viaDevice && payload?.device?.via_device) {
      deviceStore[deviceId].viaDevice = payload.device.via_device;
    }

    if (!deviceStore[deviceId].swVersion && payload?.device?.sw_version) {
      deviceStore[deviceId].swVersion = payload.device.sw_version;
    }

    deviceStore[deviceId].updatedAt = new Date().toISOString();
  }

  return deviceStore[deviceId];
}

function createLightEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: "light",
    name: payload.name || "Beleuchtung",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,
    stateTopic: payload.state_topic || "",
    commandTopic: payload.command_topic || "",
    schema: payload.schema || "default",
    payloadOn: payload.payload_on ?? "ON",
    payloadOff: payload.payload_off ?? "OFF",
    brightness: Boolean(payload.brightness),
    brightnessScale: payload.brightness_scale ?? 255,
    supportedColorModes: Array.isArray(payload.supported_color_modes)
      ? payload.supported_color_modes
      : [],
    effect: Boolean(payload.effect),
    effectList: Array.isArray(payload.effect_list) ? payload.effect_list : [],
    value: null,
    rawState: null,
    lastUpdate: null,
    deviceId,
  };
}

function createClimateEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: "climate",
    name: payload.name || "Thermostat",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,

    modeStateTopic: payload.mode_state_topic || "",
    modeCommandTopic: payload.mode_command_topic || "",

    temperatureStateTopic: payload.temperature_state_topic || "",
    temperatureCommandTopic: payload.temperature_command_topic || "",

    currentTemperatureTopic: payload.current_temperature_topic || "",

    minTemp: typeof payload.min_temp === "number" ? payload.min_temp : 5,
    maxTemp: typeof payload.max_temp === "number" ? payload.max_temp : 30,
    tempStep: typeof payload.temp_step === "number" ? payload.temp_step : 0.5,
    precision: typeof payload.precision === "number" ? payload.precision : 0.1,
    modes: Array.isArray(payload.modes) ? payload.modes : [],

    mode: null,
    targetTemperature: null,
    currentTemperature: null,
    rawState: {},
    lastUpdate: null,
    deviceId,
  };
}

function createCoverEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: "cover",
    name: payload.name || "Cover",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,

    deviceClass: payload.device_class || "",
    commandTopic: payload.command_topic || "",
    stateTopic: payload.state_topic || "",
    positionTopic: payload.position_topic || "",

    deviceClass: payload.device_class || "default",

    payloadOpen: payload.payload_open ?? "OPEN",
    payloadClose: payload.payload_close ?? "CLOSE",
    payloadStop: payload.payload_stop ?? "STOP",

    payloadLock: payload.payload_lock ?? "LOCK",
    payloadUnlock: payload.payload_unlock ?? "UNLOCK",

    state: null,
    position: null,
    rawState: {},
    lastUpdate: null,
    deviceId,
  };
}

function createLockEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: "lock",
    name: payload.name || "Lock",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,

    commandTopic: payload.command_topic || "",
    stateTopic: payload.state_topic || "",

    payloadOpen: payload.payload_open ?? "OPEN",
    payloadLock: payload.payload_lock ?? "LOCK",
    payloadUnlock: payload.payload_unlock ?? "UNLOCK",

    state: null,
    rawState: {},
    lastUpdate: null,
    deviceId,
  };
}

function createHumidifierEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: "humidifier",
    name: payload.name || "Regelung",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,

    deviceClass: payload.device_class || "humidifier",

    stateTopic: payload.state_topic || "",
    commandTopic: payload.command_topic || "",

    stateOn: payload.state_on ?? "ON",
    stateOff: payload.state_off ?? "OFF",
    payloadOn: payload.payload_on ?? "ON",
    payloadOff: payload.payload_off ?? "OFF",

    targetHumidityStateTopic: payload.target_humidity_state_topic || "",
    targetHumidityCommandTopic: payload.target_humidity_command_topic || "",

    currentHumidityTopic: payload.current_humidity_topic || "",

    minHumidity: payload.min_humidity ?? 30,
    maxHumidity: payload.max_humidity ?? 80,

    state: null,
    targetHumidity: null,
    currentHumidity: null,

    rawState: {},
    lastUpdate: null,
    deviceId,
  };
}

function createLawnMowerEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: "lawn_mower",
    name: payload.name || "Mäher",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,

    activityStateTopic: payload.activity_state_topic || "",
    startMowingCommandTopic: payload.start_mowing_command_topic || "",
    pauseCommandTopic: payload.pause_command_topic || "",
    dockCommandTopic: payload.dock_command_topic || "",

    activity: null,
    rawState: {},
    lastUpdate: null,
    deviceId,
  };
}

function createSensorEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;
  return {
    id: entityId,
    type: "sensor",
    name: payload.name || "Sensor",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,

    stateTopic: payload.state_topic || "",
    deviceClass: payload.device_class || "",
    entityCategory: payload.entity_category || "",
    unit: payload.unit_of_measurement || "",
    stateClass: payload.state_class || "",
    suggestedDisplayPrecision:
      typeof payload.suggested_display_precision === "number"
        ? payload.suggested_display_precision
        : null,

    value: null,
    rawState: null,
    lastUpdate: null,
    deviceId,
    valueTemplate: payload.value_template ?? undefined
  };
}

function createBinarySensorEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: "binary_sensor",
    name: payload.name || "Binary Sensor",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,

    stateTopic: payload.state_topic || "",
    deviceClass: payload.device_class || "",
    stateOn: payload.state_on ?? payload.payload_on ?? "ON",
    stateOff: payload.state_off ?? payload.payload_off ?? "OFF",
    payloadOn: payload.payload_on ?? payload.state_on ?? "ON",
    payloadOff: payload.payload_off ?? payload.state_off ?? "OFF",

    state: null,
    value: null,
    rawState: null,
    lastUpdate: null,
    deviceId,
  };
}

function createSwitchEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: "switch",
    name: payload.name || "Switch",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,

    stateTopic: payload.state_topic || "",
    commandTopic: payload.command_topic || "",

    stateOn: payload.state_on ?? payload.payload_on ?? "ON",
    stateOff: payload.state_off ?? payload.payload_off ?? "OFF",
    payloadOn: payload.payload_on ?? payload.state_on ?? "ON",
    payloadOff: payload.payload_off ?? payload.state_off ?? "OFF",

    state: null,
    value: null,
    rawState: null,
    lastUpdate: null,
    deviceId,
  };
}

function createButtonEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: "button",
    name: payload.name || "Button",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,

    commandTopic: payload.command_topic || "",
    payloadPress: payload.payload_press ?? "PRESS",

    stateTopic: payload.state_topic || "",

    lastUpdate: null,
    deviceId,
  };
}

function createNumberEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: "number",
    name: payload.name || "Number",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,

    stateTopic: payload.state_topic || "",
    commandTopic: payload.command_topic || "",

    entityCategory: payload.entity_category || "",
    unit: payload.unit_of_measurement || "",
    stateClass: payload.state_class || "",

    min: typeof payload.min === "number" ? payload.min : null,
    max: typeof payload.max === "number" ? payload.max : null,
    step: typeof payload.step === "number" ? payload.step : 1,

    value: null,
    rawState: null,
    lastUpdate: null,
    deviceId,
  };
}

function createTextEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: "text",
    name: payload.name || "Text",
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,

    stateTopic: payload.state_topic || "",
    commandTopic: payload.command_topic || "",

    value: "",
    rawState: null,
    lastUpdate: null,
    deviceId,
  };
}

function registerEntityTopics(entity, deviceId) {
  if (entity.type === "light") {
    if (entity.stateTopic) {
      addTopicMapping(entity.stateTopic, {
        topicType: "state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.commandTopic) {
      addTopicMapping(entity.commandTopic, {
        topicType: "command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    return;
  }

  if (entity.type === "climate") {
    if (entity.modeStateTopic) {
      addTopicMapping(entity.modeStateTopic, {
        topicType: "climate-mode-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.modeCommandTopic) {
      addTopicMapping(entity.modeCommandTopic, {
        topicType: "climate-mode-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.temperatureStateTopic) {
      addTopicMapping(entity.temperatureStateTopic, {
        topicType: "climate-target-temperature-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.temperatureCommandTopic) {
      addTopicMapping(entity.temperatureCommandTopic, {
        topicType: "climate-target-temperature-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.currentTemperatureTopic) {
      addTopicMapping(entity.currentTemperatureTopic, {
        topicType: "climate-current-temperature-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }
  }

  if (entity.type === "cover") {
    if (entity.stateTopic) {
      addTopicMapping(entity.stateTopic, {
        topicType: "cover-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.positionTopic) {
      addTopicMapping(entity.positionTopic, {
        topicType: "cover-position",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.commandTopic) {
      addTopicMapping(entity.commandTopic, {
        topicType: "cover-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }
  }

  if (entity.type === "lock") {
    if (entity.stateTopic) {
      addTopicMapping(entity.stateTopic, {
        topicType: "lock-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.commandTopic) {
      addTopicMapping(entity.commandTopic, {
        topicType: "lock-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }
  }

  if (entity.type === "humidifier") {
    if (entity.stateTopic) {
      addTopicMapping(entity.stateTopic, {
        topicType: "humidifier-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.targetHumidityStateTopic) {
      addTopicMapping(entity.targetHumidityStateTopic, {
        topicType: "humidifier-target-humidity-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.currentHumidityTopic) {
      addTopicMapping(entity.currentHumidityTopic, {
        topicType: "humidifier-current-humidity",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.commandTopic) {
      addTopicMapping(entity.commandTopic, {
        topicType: "humidifier-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.targetHumidityCommandTopic) {
      addTopicMapping(entity.targetHumidityCommandTopic, {
        topicType: "humidifier-target-humidity-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }
  }

  if (entity.type === "lawn_mower") {
    if (entity.activityStateTopic) {
      addTopicMapping(entity.activityStateTopic, {
        topicType: "lawn-mower-activity-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.startMowingCommandTopic) {
      addTopicMapping(entity.startMowingCommandTopic, {
        topicType: "lawn-mower-start-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.pauseCommandTopic) {
      addTopicMapping(entity.pauseCommandTopic, {
        topicType: "lawn-mower-pause-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.dockCommandTopic) {
      addTopicMapping(entity.dockCommandTopic, {
        topicType: "lawn-mower-dock-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }
  }

  if (entity.type === "sensor") {
    if (entity.stateTopic) {
      addTopicMapping(entity.stateTopic, {
        topicType: "sensor-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }
  }

  if (entity.type === "binary_sensor") {
    if (entity.stateTopic) {
      addTopicMapping(entity.stateTopic, {
        topicType: "binary-sensor-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }
  }

  if (entity.type === "switch") {
    if (entity.stateTopic) {
      addTopicMapping(entity.stateTopic, {
        topicType: "switch-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.commandTopic) {
      addTopicMapping(entity.commandTopic, {
        topicType: "switch-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }
  }

  if (entity.type === "button") {
  if (entity.commandTopic) {
    addTopicMapping(entity.commandTopic, {
      topicType: "button-command",
      deviceId,
      entityId: entity.id,
      entityType: entity.type,
    });
  }

  if (entity.stateTopic) {
      addTopicMapping(entity.stateTopic, {
        topicType: "button-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }
  }

  if (entity.type === "number") {
    if (entity.stateTopic) {
      addTopicMapping(entity.stateTopic, {
        topicType: "number-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.commandTopic) {
      addTopicMapping(entity.commandTopic, {
        topicType: "number-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }
  }

  if (entity.type === "text") {
    if (entity.stateTopic) {
      addTopicMapping(entity.stateTopic, {
        topicType: "text-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }

    if (entity.commandTopic) {
      addTopicMapping(entity.commandTopic, {
        topicType: "text-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      });
    }
  }

}

function applyPendingStateMessagesForEntity(entity) {
  const possibleTopics = getEntityStateTopics(entity);

  for (const topic of possibleTopics) {
    if (pendingStateMessages[topic]) {
      const message = pendingStateMessages[topic].message;
      const result = handleKnownTopicMessage(topic, message);
      if (result.handled) {
        BrowserLog(`Topic: ${topic} aus dem Pending entfernt. Message: ${message}`)
        delete pendingStateMessages[topic];
      } else {
        BrowserLog(`Topic: ${topic} wird nochmal im Pending gehalten`)
      }
    }
  }
}

function getEntityStateTopics(entity) {
  return [
    entity.stateTopic,
    entity.positionTopic,
    entity.modeStateTopic,
    entity.temperatureStateTopic,
    entity.currentTemperatureTopic,
    entity.targetHumidityStateTopic,
    entity.currentHumidityTopic,
    entity.activityStateTopic,
  ].filter(Boolean);
}

function clearTargetedStateRefresh() {
  clearTimeout(targetedStateRefreshTimer);
  clearTimeout(targetedStateRefreshCleanupTimer);
  targetedStateRefreshTimer = null;
  targetedStateRefreshCleanupTimer = null;
  targetedStateRefreshTopics.clear();
}

function scheduleTargetedStateRefresh(client) {
  clearTimeout(targetedStateRefreshTimer);

  targetedStateRefreshTimer = setTimeout(() => {
    targetedStateRefreshTimer = null;

    if (mqttClient !== client || !client.connected) {
      return;
    }

    const topics = [...new Set(
      Object.values(deviceStore).flatMap(device =>
        Object.values(device.entities || {}).flatMap(entity =>
          entity.lastUpdate == null ? getEntityStateTopics(entity) : []
        )
      )
    )];

    if (topics.length === 0) {
      console.log("Gezieltes State-Nachladen: keine fehlenden Werte");
      return;
    }

    topics.forEach(topic => targetedStateRefreshTopics.add(topic));
    console.log(`Gezieltes State-Nachladen: ${topics.length} Topics`);

    client.subscribe(topics, { qos: 0 }, (err, granted = []) => {
      if (err) {
        topics.forEach(topic => targetedStateRefreshTopics.delete(topic));
        console.error("Gezieltes State-Nachladen fehlgeschlagen:", err.message);
        return;
      }

      console.log(`Gezieltes State-Nachladen SUBACK: ${granted.length} Topics`);

      clearTimeout(targetedStateRefreshCleanupTimer);
      targetedStateRefreshCleanupTimer = setTimeout(() => {
        const remainingTopics = topics.filter(topic =>
          targetedStateRefreshTopics.has(topic)
        );

        if (remainingTopics.length === 0 || mqttClient !== client || !client.connected) {
          return;
        }

        const removableTopics = remainingTopics.filter(topic => topic !== mqttConfig.topic);

        if (removableTopics.length > 0) {
          client.unsubscribe(removableTopics, err => {
            if (err) {
              console.error("Aufraeumen der State-Subscriptions fehlgeschlagen:", err.message);
            }
          });
        }

        remainingTopics.forEach(topic => targetedStateRefreshTopics.delete(topic));
        targetedStateRefreshCleanupTimer = null;
        console.log(`Gezieltes State-Nachladen beendet: ${remainingTopics.length} Topics ohne Antwort`);
      }, 10000);
    });
  }, 2000);
}

function handleDiscoveryMessage(topic, message) {
  if (!isDiscoveryTopic(topic)) {
    return { handled: false, reason: "not-discovery-topic" };
  }

  const entityType = getEntityTypeFromDiscoveryTopic(topic);
  const payload = parseJsonMessage(message);

  if (!payload) {
    return { handled: false, reason: "invalid-json" };
  }

  const viaDevice = String(payload?.device?.via_device || "").toLowerCase();

  const isAllowed = allowedDiscoveryViaDevicePrefixes.some(prefix =>
    viaDevice.startsWith(String(prefix).toLowerCase())
  );

  if (!isAllowed) {
    return { handled: false, reason: "via-device-filtered" };
  }

  // Nur unterstützte Typen überhaupt anlegen
  if (
    entityType !== "light" &&
    entityType !== "climate" &&
    entityType !== "cover" &&
    entityType !== "lock" &&
    entityType !== "humidifier" &&
    entityType !== "lawn_mower" &&
    entityType !== "sensor" &&
    entityType !== "binary_sensor" &&
    entityType !== "switch" &&
    entityType !== "button" &&
    entityType !== "number" &&
    entityType !== "text"
  ) {
    return { handled: false, reason: "unsupported-entity-type" };
  }

  const deviceId = getDeviceIdFromDiscovery(payload, topic);
  const device = ensureDeviceExists(deviceId, payload);

  let entity = null;

  if (entityType === "light") {
    entity = createLightEntity(topic, payload, deviceId);
  } else if (entityType === "climate") {
    entity = createClimateEntity(topic, payload, deviceId);
  } else if (entityType === "cover") {
    entity = createCoverEntity(topic, payload, deviceId);
  } else if (entityType === "lock") {
    entity = createLockEntity(topic, payload, deviceId);
  } else if (entityType === "humidifier") {
    entity = createHumidifierEntity(topic, payload, deviceId);
  } else if (entityType === "lawn_mower") {
    entity = createLawnMowerEntity(topic, payload, deviceId);
  } else if (entityType === "sensor") {
    entity = createSensorEntity(topic, payload, deviceId);
  } else if (entityType === "binary_sensor") {
    entity = createBinarySensorEntity(topic, payload, deviceId);
  } else if (entityType === "switch") {
    entity = createSwitchEntity(topic, payload, deviceId);
  } else if (entityType === "button") {
    entity = createButtonEntity(topic, payload, deviceId);
  } else if (entityType === "number") {
    entity = createNumberEntity(topic, payload, deviceId);
  } else if (entityType === "text") {
    entity = createTextEntity(topic, payload, deviceId);
  }

  if (!entity) {
    return { handled: false, reason: "entity-not-created" };
  }

  const existing = device.entities[entity.id];

  device.entities[entity.id] = {
    ...entity,
    value: existing?.value ?? entity.value,
    rawState: existing?.rawState ?? entity.rawState,
    lastUpdate: existing?.lastUpdate ?? entity.lastUpdate
  };
  device.updatedAt = new Date().toISOString();

  registerEntityTopics(entity, deviceId);

  applyPendingStateMessagesForEntity(entity);

  return {
    handled: true,
    type: `${entityType}-discovery`,
    deviceId,
    entityId: entity.id,
  };
}

function parseMaybeJson(payloadText) {
  try {
    return JSON.parse(payloadText);
  } catch {
    return payloadText;
  }
}

function addTopicMapping(topic, mapping) {
  if (!topic) return;

  if (!topicStore[topic]) {
    topicStore[topic] = [];
  }

  const exists = topicStore[topic].some(
    m => m.entityId === mapping.entityId
  );

  if (exists) {
    return;
  }

  topicStore[topic].push(mapping);
}

function handleKnownTopicMessage(topic, message) {
  if (isDiscoveryTopic(topic)) {
    return { handled: false, reason: "ignore-discovery-topic" };
  }
  const mappings = topicStore[topic];

  if (!Array.isArray(mappings) || mappings.length === 0) {
    pendingStateMessages[topic] = {
      message,
      ts: Date.now()
    };
    addLog("Pending hinzufügen", topic, message);
    return { handled: false, reason: "topic-not-registered-pending" };
  }

  let handledAny = false;
  let lastResult = { handled: false, reason: "no-mapping-handled" };

  for (const mapping of mappings) {
    const result = handleKnownTopicMapping(topic, message, mapping);

    if (result.handled) {
      handledAny = true;
      lastResult = result;
    }
  }

  return handledAny ? lastResult : { handled: false, reason: "no-mapping-handled" };
}

function handleKnownTopicMapping(topic, message, mapping) {
  const device = deviceStore[mapping.deviceId];

  if (!device) {
    return { handled: false, reason: "device-not-found" };
  }

  const entity = device.entities[mapping.entityId];
  if (!entity) {
    return { handled: false, reason: "entity-not-found" };
  }

  const payloadText = message.toString();
  const parsed = parseMaybeJson(payloadText);

  if (entity.type === "light") {
    if (mapping.topicType !== "state") {
      return { handled: false, reason: "not-a-light-state-topic" };
    }

    entity.rawState = parsed;
    entity.value = parsed;
    
    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "state-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  if (entity.type === "climate") {
    if (mapping.topicType === "climate-mode-state") {
      entity.mode = typeof parsed === "string" ? parsed : String(parsed ?? "");
      entity.rawState = { ...entity.rawState, mode: entity.mode };
    } else if (mapping.topicType === "climate-target-temperature-state") {
      entity.targetTemperature = Number(parsed);
      entity.rawState = {
        ...entity.rawState,
        targetTemperature: entity.targetTemperature,
      };
    } else if (mapping.topicType === "climate-current-temperature-state") {
      entity.currentTemperature = Number(parsed);
      entity.rawState = {
        ...entity.rawState,
        currentTemperature: entity.currentTemperature,
      };
    } else {
      return { handled: false, reason: "not-a-climate-state-topic" };
    }

    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "climate-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  if (entity.type === "cover") {
    if (mapping.topicType === "cover-state") {
      entity.state = typeof parsed === "string" ? parsed : String(parsed ?? "");
      entity.rawState = { ...entity.rawState, state: entity.state };
    } else if (mapping.topicType === "cover-position") {
      entity.position = Number(parsed);
      entity.rawState = { ...entity.rawState, position: entity.position };
    } else {
      return { handled: false, reason: "not-a-cover-state-topic" };
    }

    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "cover-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  if (entity.type === "lock") {
    if (mapping.topicType !== "lock-state") {
      return { handled: false, reason: "not-a-lock-state-topic" };
    }

    entity.state = typeof parsed === "string" ? parsed : String(parsed ?? "");
    entity.rawState = { ...entity.rawState, state: entity.state };
    
    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "lock-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  if (entity.type === "humidifier") {
    if (mapping.topicType === "humidifier-state") {
      entity.state = String(parsed);
      entity.rawState = { ...entity.rawState, state: entity.state };
    } else if (mapping.topicType === "humidifier-target-humidity-state") {
      entity.targetHumidity = Number(parsed);
      entity.rawState = {
        ...entity.rawState,
        targetHumidity: entity.targetHumidity,
      };
    } else if (mapping.topicType === "humidifier-current-humidity") {
      entity.currentHumidity = Number(parsed);
      entity.rawState = {
        ...entity.rawState,
        currentHumidity: entity.currentHumidity,
      };
    } else {
      return { handled: false, reason: "not-a-humidifier-state-topic" };
    }

    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "humidifier-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  if (entity.type === "lawn_mower") {
    if (mapping.topicType !== "lawn-mower-activity-state") {
      return { handled: false, reason: "not-a-lawn-mower-state-topic" };
    }

    entity.activity = typeof parsed === "string" ? parsed : String(parsed ?? "");
    entity.rawState = { ...entity.rawState, activity: entity.activity };
    
    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "lawn-mower-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  if (entity.type === "sensor") {
    if (mapping.topicType !== "sensor-state") {
      return { handled: false, reason: "not-a-sensor-state-topic" };
    }

    // 🔥 value_template guard
    if (
        entity.valueTemplate &&
        typeof parsed === "object" &&
        parsed !== null
    ) {
        const attribute =
            extractValueJsonKey(entity.valueTemplate);
        if (
            attribute &&
            parsed[attribute] === undefined
        ) {
            return {
                handled: false,
                reason: "sensor-attribute-not-present"
            };
        }
    }

    entity.rawState = parsed;
    entity.value = parsed;
    
    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "sensor-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  if (entity.type === "binary_sensor") {
    if (mapping.topicType !== "binary-sensor-state") {
      return { handled: false, reason: "not-a-binary-sensor-state-topic" };
    }

    const stateText = String(parsed ?? "").trim();
    const isOn = stateText === String(entity.stateOn) || stateText === String(entity.payloadOn);

    entity.state = isOn ? "on" : "off";
    entity.value = isOn;
    entity.rawState = parsed;
    
    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "binary-sensor-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  if (entity.type === "switch") {
    if (mapping.topicType !== "switch-state") {
      return { handled: false, reason: "not-a-switch-state-topic" };
    }

    const stateText = String(parsed ?? "").trim();
    const isOn =
      stateText === String(entity.stateOn) ||
      stateText === String(entity.payloadOn);

    entity.state = isOn ? "on" : "off";
    entity.value = isOn;
    entity.rawState = parsed;
    
    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "switch-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  if (entity.type === "button") {
    if (mapping.topicType !== "button-state") {
      return { handled: false, reason: "not-a-button-state-topic" };
    }

    entity.rawState = parsed;
    
    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "button-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  if (entity.type === "number") {
    if (mapping.topicType !== "number-state") {
      return { handled: false, reason: "not-a-number-state-topic" };
    }

    const numericValue = Number(parsed);

    entity.rawState = parsed;
    entity.value = Number.isNaN(numericValue) ? parsed : numericValue;
    
    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "number-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  if (entity.type === "text") {
    if (mapping.topicType !== "text-state") {
      return { handled: false, reason: "not-a-text-state-topic" };
    }

    const textValue = parsed === null || parsed === undefined
      ? ""
      : String(parsed);

    entity.rawState = parsed;
    entity.value = textValue;

    finalizeEntityUpdate(device, entity, mapping);

    return {
      handled: true,
      type: "text-update",
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
    };
  }

  return { handled: false, reason: "unsupported-entity-runtime-type" };
}


function finalizeEntityUpdate(device, entity, mapping) {
  entity.lastUpdate = new Date().toISOString();
  device.updatedAt = new Date().toISOString();

  io.emit("entity-update", {
    deviceId: mapping.deviceId,
    entityId: mapping.entityId,
    entity,
  });

  // History-Store schreiben
  getHistoryConfigsForEntity(mapping.entityId).forEach(({ historyId, cfg }) => {
    historyStore.writeHistory(historyId, entity, cfg);
  });

  // Logik anstoßen
  logicEngine.runLogicEngine(mapping.entityId);
}


function extractValueJsonKey(template) {
    const match =
        template?.match(/value_json\.([a-zA-Z0-9_]+)/);

    return match ? match[1] : null;
}

let isConnecting = false;
const MQTT_RECONNECT_PERIOD = 3000;
const MQTT_RECONNECT_WATCHDOG_PERIOD = 10000;
let mqttReconnectWanted = true;
let mqttReconnectAttempts = 0;

function disconnectMqtt({ manual = true } = {}) {
  clearTargetedStateRefresh();

  if (manual) {
    mqttReconnectWanted = false;
    isConnecting = false;
  }

  if (!mqttClient) {
    if (manual) {
      emitStatus({
        connected: false,
        message: "Manuell getrennt",
      });
    }
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    try {
      console.log("MQTT wird getrennt...");

      mqttClient.removeAllListeners(); // 🔥 FIX: verhindert doppelte Events

      mqttClient.end(true, () => {
        mqttClient = null;

        if (manual) {
          emitStatus({
            connected: false,
            host: mqttConfig.host,
            port: mqttConfig.port,
            topic: mqttConfig.topic,
            message: "Manuell getrennt",
          });
        }

        console.log(manual ? "MQTT manuell getrennt" : "Alte MQTT-Verbindung beendet");
        resolve();
      });

    } catch (err) {
      console.error("Fehler beim Trennen:", err.message);

      emitStatus({
        connected: false,
        host: mqttConfig.host,
        port: mqttConfig.port,
        topic: mqttConfig.topic,
        message: `Fehler beim Trennen: ${err.message}`,
      });

      mqttClient = null;
      resolve();
    }
  });
}

async function connectMqtt() {
  console.log("connectMqtt wurde aufgerufen");

  // 🔥 FIX: verhindert doppelte Verbindungen
  if (isConnecting) {
    console.log("MQTT verbindet bereits...");
    return;
  }

  isConnecting = true;
  mqttReconnectWanted = true;

  // 🔥 FIX: sauber warten bis alter Client wirklich weg ist
  await disconnectMqtt({ manual: false });

  resetStores();

  const { host, port, topic, username, password } = mqttConfig;

  const clientId = `${mqttConfig.clientId}_${isDev ? "dev" : "prod"}`;
  console.log("Mode:", isDev ? "DEV" : "PROD");
  console.log("MQTT ClientId:", clientId);

  const url = `mqtt://${host}:${port}`;

  console.log(`Verbinde zu MQTT Broker: ${url}, Topic: ${topic}`);

  emitStatus({
    connected: false,
    host,
    port,
    topic,
    message: "Verbinde...",
  });

  mqttClient = mqtt.connect(url, {
    username: username || undefined,
    password: password || undefined,

    clientId,

    protocolVersion: 4, // MQTT 3.1.1

    // Der Monitor baut seinen Zustand bei jeder Verbindung aus retained
    // Discovery- und State-Nachrichten neu auf. Eine persistente Session kann
    // dazu fuehren, dass Mosquitto eine bestehende Subscription fortsetzt und
    // die retained Nachrichten nicht erneut als frischen Snapshot zustellt.
    clean: true,

    reconnectPeriod: MQTT_RECONNECT_PERIOD,
    connectTimeout: 10000,
    keepalive: 30,

    // Der Subscribe wird unten bei jedem "connect" bewusst selbst ausgefuehrt.
    resubscribe: false,
    queueQoSZero: true,
  });

  // 🔥 OPTIONAL FIX: doppelte Listener vermeiden (sicher ist sicher)
  mqttClient.removeAllListeners();

  mqttClient.on("connect", (connack) => {
    console.log("Mit MQTT verbunden");
    console.log("MQTT Session vorhanden:", Boolean(connack?.sessionPresent));
    mqttReconnectAttempts = 0;

    mqttClient.subscribe(topic, { qos: 0 }, (err, granted = []) => {
      if (err) {
        console.error("Subscribe-Fehler:", err.message);

        emitStatus({
          connected: false,
          host,
          port,
          topic,
          message: `Subscribe-Fehler: ${err.message}`,
        });

        isConnecting = false;
        return;
      }

      const subscriptions = granted
        .map(({ topic: grantedTopic, qos }) => `${grantedTopic} (QoS ${qos})`)
        .join(", ");
      console.log(`SUBACK: ${subscriptions || topic}`);

      emitStatus({
        connected: true,
        host,
        port,
        topic,
        message: "Verbunden",
      });

      console.log(`Abonniert: ${topic}`);
      isConnecting = false;
    });
  });

  mqttClient.on("message", (topic, message, packet) => {
    const isDiscovery = isDiscoveryTopic(topic);

    if (isDiscovery) {
      addLog("DISCOVERY", topic, message);
      const discoveryResult = handleDiscoveryMessage(topic, message);

      if (discoveryResult.handled) {
        addLog("DISCOVERY", topic, "behandelt");
        scheduleTargetedStateRefresh(mqttClient);
      }
    } else {
      addLog("STATE", topic, message);
      const stateResult = handleKnownTopicMessage(topic, message);

      if (targetedStateRefreshTopics.delete(topic)) {
        if (topic !== mqttConfig.topic) {
          mqttClient.unsubscribe(topic, err => {
            if (err) {
              console.error("State-Zusatzsubscription konnte nicht entfernt werden:", err.message);
            }
          });
        }

        if (targetedStateRefreshTopics.size === 0) {
          clearTimeout(targetedStateRefreshCleanupTimer);
          targetedStateRefreshCleanupTimer = null;
          console.log("Gezieltes State-Nachladen abgeschlossen");
        }
      }

      if (stateResult.handled) {
        // optional logging
      }
    }

    io.emit("mqtt-message", {
      topic,
      payload: message.toString(),
      retain: Boolean(packet?.retain),
      timestamp: new Date().toISOString(),
    });
  });

  mqttClient.on("reconnect", () => {
    mqttReconnectAttempts += 1;
    emitStatus({
      connected: false,
      host,
      port,
      topic,
      message: `Reconnect-Versuch ${mqttReconnectAttempts}...`,
    });
  });

  mqttClient.on("close", () => {
    isConnecting = false;

    emitStatus({
      connected: false,
      host,
      port,
      topic,
      message: mqttReconnectWanted
        ? `Getrennt – neuer Versuch in ${MQTT_RECONNECT_PERIOD / 1000} Sekunden`
        : "Manuell getrennt",
    });
  });

  mqttClient.on("error", (err) => {
    console.error("MQTT Fehler:", err.message);

    emitStatus({
      connected: false,
      host,
      port,
      topic,
      message: `Fehler: ${err.message}`,
    });

    isConnecting = false;
  });
}

// MQTT.js versucht selbst zyklisch einen Reconnect. Der Watchdog deckt zusätzlich
// den Fall ab, dass kein Client mehr existiert oder dessen Reconnect-Schleife steht.
setInterval(() => {
  if (!mqttReconnectWanted || mqttStatus.connected || isConnecting) {
    return;
  }

  if (!mqttClient) {
    connectMqtt();
    return;
  }

  if (!mqttClient.connected && !mqttClient.reconnecting) {
    console.log("MQTT-Watchdog startet Reconnect");
    try {
      mqttClient.reconnect();
    } catch (error) {
      console.error("MQTT-Watchdog-Reconnect fehlgeschlagen:", error.message);
    }
  }
}, MQTT_RECONNECT_WATCHDOG_PERIOD);

function getDevicesForDashboard() {

  const combined = getCombinedStore();

  return Object.values(combined).map((device) => {
    const entities = Object.values(device.entities || {}).map((entity) => ({
      id: entity.id,
      type: entity.type,
      name: entity.name,
      value: entity.value,
      rawState: entity.rawState,
      deviceId: entity.deviceId,
      lastUpdate: entity.lastUpdate,

      stateTopic: entity.stateTopic,
      commandTopic: entity.commandTopic,
      brightness: entity.brightness,
      brightnessScale: entity.brightnessScale,
      supportedColorModes: entity.supportedColorModes,
      effect: entity.effect,
      effectList: entity.effectList,

      mode: entity.mode,
      targetTemperature: entity.targetTemperature,
      currentTemperature: entity.currentTemperature,
      modeStateTopic: entity.modeStateTopic,
      modeCommandTopic: entity.modeCommandTopic,
      temperatureStateTopic: entity.temperatureStateTopic,
      temperatureCommandTopic: entity.temperatureCommandTopic,
      currentTemperatureTopic: entity.currentTemperatureTopic,
      minTemp: entity.minTemp,
      maxTemp: entity.maxTemp,
      tempStep: entity.tempStep,
      precision: entity.precision,
      modes: entity.modes,

      deviceClass: entity.deviceClass,
      state: entity.state,
      position: entity.position,
      positionTopic: entity.positionTopic,
      payloadOpen: entity.payloadOpen,
      payloadClose: entity.payloadClose,
      payloadStop: entity.payloadStop,

      payloadLock: entity.payloadLock,
      payloadUnlock: entity.payloadUnlock,

      stateOn: entity.stateOn,
      stateOff: entity.stateOff,
      payloadOn: entity.payloadOn,
      payloadOff: entity.payloadOff,
      targetHumidity: entity.targetHumidity,
      currentHumidity: entity.currentHumidity,
      targetHumidityStateTopic: entity.targetHumidityStateTopic,
      targetHumidityCommandTopic: entity.targetHumidityCommandTopic,
      currentHumidityTopic: entity.currentHumidityTopic,
      minHumidity: entity.minHumidity,
      maxHumidity: entity.maxHumidity,

      activity: entity.activity,
      activityStateTopic: entity.activityStateTopic,
      startMowingCommandTopic: entity.startMowingCommandTopic,
      pauseCommandTopic: entity.pauseCommandTopic,
      dockCommandTopic: entity.dockCommandTopic,

      entityCategory: entity.entityCategory,
      unit: entity.unit,
      stateClass: entity.stateClass,
      suggestedDisplayPrecision: entity.suggestedDisplayPrecision,

      min: entity.min,
      max: entity.max,
      step: entity.step,
      isCalculated: Boolean(entity.isCalculated),

    }));

    return {
      id: device.id,
      name: device.name,
      viaDevice: device.viaDevice,
      swVersion: device.swVersion,
      entityCount: entities.length,
      entities,
      createdAt: device.createdAt,
      updatedAt: device.updatedAt,
      isVirtual: device.isVirtual,
      isLogical: device.isLogical
    };
  });
}

function readExtensionConfigs() {
  try {
    if (!fs.existsSync(EXTENSION_CONFIG_FILE)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(EXTENSION_CONFIG_FILE, "utf8"));
  } catch (err) {
    console.error("Fehler beim Lesen extension-configs.json:", err.message);
    return {};
  }
}

function writeExtensionConfigs(data) {
  const dir = path.dirname(EXTENSION_CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    EXTENSION_CONFIG_FILE,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function getDeviceDisplayNameServer(device) {
  return String(
    mqttConfig.friendlyNames?.[device?.id]?.name ||
    device?.name ||
    device?.id ||
    ""
  );
}

function getEntityDisplayNameServer(entity, deviceId) {
  return String(
    mqttConfig.friendlyNames?.[deviceId]?.entities?.[entity?.id] ||
    entity?.name ||
    entity?.id ||
    ""
  );
}

function getExtensionUsername(req) {
  return getRequestUsername(req);
}

function canUserAccessCustomDashboard(user, dashboard) {
  if (!mqttConfig.auth?.enabled) return true;
  if (user?.roles?.includes("admin")) return true;

  const allowedRoles = Array.isArray(dashboard?.allowedRoles)
    ? dashboard.allowedRoles
    : [];

  if (!allowedRoles.length) return true;

  return allowedRoles.some(role => user?.roles?.includes(role));
}

function getAllowedExtensionEntityIds(req) {
  const user = getRequestUser(req);
  const allowedEntityIds = new Set();

  if (!mqttConfig.auth?.enabled || user?.roles?.includes("admin")) {
    Object.values(getCombinedStore()).forEach(device => {
      Object.values(device.entities || {}).forEach(entity => {
        allowedEntityIds.add(entity.id);
      });
    });

    return allowedEntityIds;
  }

  (mqttConfig.customDashboards || [])
    .filter(dashboard => canUserAccessCustomDashboard(user, dashboard))
    .forEach(dashboard => {
      (dashboard.devices || []).forEach(deviceConfig => {
        (deviceConfig.entityIds || []).forEach(entityId => {
          allowedEntityIds.add(entityId);
        });
      });
    });

  return allowedEntityIds;
}

function createExtensionSourceId(entityId, key) {
  return `${entityId}::${key}`;
}

function parseExtensionSourceId(sourceId) {
  const [entityId, key] = String(sourceId || "").split("::");
  return {
    entityId,
    key: key || null
  };
}

function formatExtensionValue(value, unit = "") {
  if (typeof value === "boolean") {
    return value ? "An" : "Aus";
  }

  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const formatted =
      Math.abs(numeric) >= 100
        ? numeric.toFixed(0)
        : numeric.toFixed(2).replace(/\.?0+$/, "");

    return `${formatted}${unit ? ` ${unit}` : ""}`;
  }

  return `${value}${unit ? ` ${unit}` : ""}`;
}

function getExtensionOriginalDeviceName(device) {
  return String(device?.name || device?.id || "");
}

function getExtensionOriginalEntityName(entity) {
  return String(entity?.name || entity?.id || "");
}

function getNestedExtensionValue(entity, key) {
  if (!key) return entity?.value;

  if (key === "lightState") {
    const raw = entity?.rawState;
    if (raw && typeof raw === "object" && raw.state !== undefined) {
      return raw.state;
    }
    return entity?.value;
  }

  if (key === "brightnessPercent") {
    const raw = entity?.rawState;
    const brightness = raw && typeof raw === "object"
      ? Number(raw.brightness)
      : Number.NaN;
    const scale = Number(entity?.brightnessScale || 255);

    if (!Number.isFinite(brightness) || !Number.isFinite(scale) || scale <= 0) {
      return null;
    }

    return Math.round((brightness / scale) * 100);
  }

  return entity?.[key];
}

function getExtensionIcon(entity, sourceKey = null) {
  const type = String(entity?.type || "").toLowerCase();
  const deviceClass = String(entity?.deviceClass || "").toLowerCase();
  const unit = String(entity?.unit || "").toLowerCase();
  const name = String(entity?.name || "").toLowerCase();
  const rawName = `${name} ${String(entity?.id || "").toLowerCase()}`;
  const key = String(sourceKey || "").toLowerCase();

  if (deviceClass === "carbon_dioxide" || rawName.includes("co2")) return "co2";
  if (deviceClass === "battery" || rawName.includes("battery") || rawName.includes("batterie") || rawName.includes("akku")) return "battery";
  if (rawName.includes("intervall") || rawName.includes("interval") || unit === "min") return "timer";
  if (rawName.includes("pv") || rawName.includes("solar")) return "sun";
  if (deviceClass === "energy" || deviceClass === "power" || rawName.includes("leistung") || rawName.includes("netz") || unit.includes("w")) return "zap";
  if (rawName.includes("pool") || rawName.includes("wasser") || rawName.includes("water")) return "waves";
  if (rawName.includes("garten") || rawName.includes("garden")) return "leaf";
  if (key.includes("temperature") || deviceClass === "temperature" || unit.includes("°c")) return "thermometer";
  if (deviceClass === "humidity" || unit === "%") return "droplets";
  if (deviceClass === "window") return "panel-top";
  if (deviceClass === "door" || deviceClass === "opening") return "door-open";
  if (deviceClass === "motion" || deviceClass === "presence") return "activity";
  if (rawName.includes("air") || rawName.includes("luft")) return "cloud";
  if (type === "climate") return "thermometer";
  if (type === "light") return "lightbulb";
  if (type === "cover") return "blinds";
  if (type === "switch") return "toggle-left";
  if (type === "binary_sensor") return "circle-dot";
  return "gauge";
}

function createExtensionSource(device, entity, source = {}) {
  const sourceId = source.id || entity.id;
  const key = source.key || null;
  const value = getNestedExtensionValue(entity, key);
  const historyConfig = getHistoryConfig(sourceId);
  const bucketMinutes = Number(historyConfig?.bucketMinutes);
  const unit = source.unit ?? entity?.unit ?? "";
  const type = source.type || (
    typeof value === "boolean" || entity.type === "binary_sensor"
      ? "boolean"
      : Number.isFinite(Number(value))
        ? "numeric"
        : "text"
  );
  const deviceName = getDeviceDisplayNameServer(device);
  const entityName = source.name || getEntityDisplayNameServer(entity, device.id);
  const originalDeviceName = getExtensionOriginalDeviceName(device);
  const originalEntityName = getExtensionOriginalEntityName(entity);
  const label = `${deviceName}: ${entityName}`;

  return {
    id: sourceId,
    entityId: entity.id,
    sourceKey: key,
    type,
    deviceId: device.id,
    deviceName,
    originalDeviceName,
    name: entityName,
    originalEntityName,
    label,
    searchText: [
      sourceId,
      entity.id,
      key,
      type,
      device.id,
      deviceName,
      originalDeviceName,
      entityName,
      originalEntityName,
      label,
      entity.type,
      entity.deviceClass,
      entity.unit
    ].filter(Boolean).join(" "),
    value,
    unit,
    deviceClass: source.deviceClass ?? entity.deviceClass ?? "",
    stateClass: source.stateClass ?? entity.stateClass ?? "",
    displayValue: formatExtensionValue(value, unit),
    icon: source.icon || getExtensionIcon(entity, key),
    control: source.control || null,
    historyEnabled: Boolean(historyConfig?.enabled),
    historyBucketSeconds: Number.isFinite(bucketMinutes) && bucketMinutes > 0
      ? bucketMinutes * 60
      : 5 * 60,
    updatedAt: entity.lastUpdate || device.updatedAt || null
  };
}

function createToggleControl(action = "set") {
  return {
    type: "toggle",
    action
  };
}

function createNumberControl(action, min, max, step) {
  return {
    type: "number",
    action,
    min,
    max,
    step
  };
}

function getExtensionSourcesForEntity(device, entity) {
  if (entity.type === "light") {
    const sources = [
      createExtensionSource(device, entity, {
        id: createExtensionSourceId(entity.id, "lightState"),
        key: "lightState",
        name: "Status",
        type: "text",
        unit: "",
        icon: "lightbulb",
        control: entity.commandTopic ? createToggleControl("set") : null
      })
    ];

    if (getNestedExtensionValue(entity, "brightnessPercent") !== null) {
      sources.push(
        createExtensionSource(device, entity, {
          id: createExtensionSourceId(entity.id, "brightnessPercent"),
          key: "brightnessPercent",
          name: "Helligkeit",
          type: "numeric",
          unit: "%",
          icon: "sun",
          control: entity.commandTopic
            ? createNumberControl("setBrightness", 0, 100, 1)
            : null
        })
      );
    }

    return sources;
  }

  if (entity.type === "climate") {
    return [
      createExtensionSource(device, entity, {
        id: createExtensionSourceId(entity.id, "mode"),
        key: "mode",
        name: "Modus",
        type: "text",
        unit: "",
        icon: "thermometer",
        control: entity.modeCommandTopic && Array.isArray(entity.modes) && entity.modes.length
          ? { type: "select", action: "setMode", options: entity.modes }
          : null
      }),
      createExtensionSource(device, entity, {
        id: createExtensionSourceId(entity.id, "currentTemperature"),
        key: "currentTemperature",
        name: "Isttemperatur",
        type: "numeric",
        unit: "°C",
        icon: "thermometer"
      }),
      createExtensionSource(device, entity, {
        id: createExtensionSourceId(entity.id, "targetTemperature"),
        key: "targetTemperature",
        name: "Solltemperatur",
        type: "numeric",
        unit: "°C",
        icon: "thermometer",
        control: entity.temperatureCommandTopic
          ? createNumberControl(
              "setTargetTemperature",
              entity.minTemp ?? 5,
              entity.maxTemp ?? 30,
              entity.tempStep ?? entity.precision ?? 0.5
            )
          : null
      })
    ];
  }

  if (entity.type === "humidifier") {
    return [
      createExtensionSource(device, entity, {
        id: createExtensionSourceId(entity.id, "currentHumidity"),
        key: "currentHumidity",
        name: "Luftfeuchtigkeit",
        type: "numeric",
        unit: "%",
        icon: "droplets"
      }),
      createExtensionSource(device, entity, {
        id: createExtensionSourceId(entity.id, "targetHumidity"),
        key: "targetHumidity",
        name: "Sollfeuchte",
        type: "numeric",
        unit: "%",
        icon: "droplets",
        control: entity.targetHumidityCommandTopic
          ? createNumberControl(
              "setTargetHumidity",
              entity.minHumidity ?? 30,
              entity.maxHumidity ?? 80,
              1
            )
          : null
      }),
      createExtensionSource(device, entity, {
        id: createExtensionSourceId(entity.id, "state"),
        key: "state",
        name: "Status",
        type: "text",
        unit: "",
        icon: "fan",
        control: entity.commandTopic ? createToggleControl("set") : null
      })
    ];
  }

  if (entity.type === "cover") {
    const sources = [];

    sources.push(
      createExtensionSource(device, entity, {
        id: createExtensionSourceId(entity.id, "state"),
        key: "state",
        name: "Zustand",
        type: "text",
        unit: "",
        icon: "blinds",
        control: entity.commandTopic ? { type: "buttons", actions: ["OPEN", "STOP", "CLOSE"] } : null
      })
    );

    if (entity.position !== null && entity.position !== undefined) {
      sources.push(
        createExtensionSource(device, entity, {
          id: createExtensionSourceId(entity.id, "position"),
          key: "position",
          name: "Position",
          type: "numeric",
          unit: "%",
          icon: "blinds"
        })
      );
    }

    return sources;
  }

  if (entity.type === "lock") {
    return [
      createExtensionSource(device, entity, {
        id: createExtensionSourceId(entity.id, "state"),
        key: "state",
        name: "Zustand",
        type: "text",
        unit: "",
        icon: "lock",
        control: entity.commandTopic ? { type: "buttons", actions: ["LOCK", "UNLOCK", "OPEN"] } : null
      })
    ];
  }

  if (entity.type === "lawn_mower") {
    return [
      createExtensionSource(device, entity, {
        id: createExtensionSourceId(entity.id, "activity"),
        key: "activity",
        name: "Aktivitaet",
        type: "text",
        unit: "",
        icon: "activity",
        control: {
          type: "buttons",
          actions: [
            ...(entity.startMowingCommandTopic ? ["start_mowing"] : []),
            ...(entity.pauseCommandTopic ? ["pause"] : []),
            ...(entity.dockCommandTopic ? ["dock"] : [])
          ]
        }
      })
    ];
  }

  if (entity.type === "button") {
    return [createExtensionSource(device, entity, {
      type: "text",
      unit: "",
      icon: "circle-dot",
      control: entity.commandTopic ? { type: "button", action: "press" } : null
    })];
  }

  return [createExtensionSource(device, entity, {
    control: getExtensionControlForSimpleEntity(entity)
  })];
}

function getExtensionControlForSimpleEntity(entity) {
  if (entity.type === "switch" && entity.commandTopic) {
    return createToggleControl("set");
  }

  if (entity.type === "number" && entity.commandTopic) {
    return createNumberControl(
      "set",
      entity.min ?? null,
      entity.max ?? null,
      entity.step ?? 1
    );
  }

  if (entity.type === "text" && entity.commandTopic) {
    return { type: "text", action: "set" };
  }

  return null;
}

function getAllowedExtensionSources(req) {
  const allowedEntityIds = getAllowedExtensionEntityIds(req);
  const sources = [];

  Object.values(getCombinedStore()).forEach(device => {
    Object.values(device.entities || {}).forEach(entity => {
      if (!allowedEntityIds.has(entity.id)) return;

      getExtensionSourcesForEntity(device, entity)
        .forEach(source => sources.push(source));
    });
  });

  return sources.sort((a, b) =>
    a.label.localeCompare(b.label, "de", { sensitivity: "base" })
  );
}

function publishExtensionCommand(topic, payload, res) {
  if (!mqttClient) {
    return res.status(400).json({
      ok: false,
      error: "MQTT ist nicht verbunden"
    });
  }

  if (!topic) {
    return res.status(400).json({
      ok: false,
      error: "Command-Topic fehlt"
    });
  }

  const finalPayload =
    typeof payload === "string" || typeof payload === "number" || typeof payload === "boolean"
      ? String(payload)
      : JSON.stringify(payload);

  mqttClient.publish(String(topic), finalPayload, (err) => {
    if (err) {
      return res.status(500).json({
        ok: false,
        error: err.message
      });
    }

    res.json({ ok: true });
  });
}

function clampNumber(value, min = null, max = null, step = null) {
  let next = Number(value);
  if (!Number.isFinite(next)) return null;

  const minNumber = Number(min);
  const maxNumber = Number(max);
  const stepNumber = Number(step);

  if (Number.isFinite(minNumber)) next = Math.max(minNumber, next);
  if (Number.isFinite(maxNumber)) next = Math.min(maxNumber, next);

  if (Number.isFinite(stepNumber) && stepNumber > 0) {
    next = Math.round(next / stepNumber) * stepNumber;
  }

  return Number(next.toFixed(6));
}

function buildExtensionCommandPayload(entity, source, action, value) {
  const key = source.sourceKey || null;

  if (entity.type === "light") {
    if (!entity.commandTopic) return null;

    if (key === "brightnessPercent" || action === "setBrightness") {
      const percent = clampNumber(value, 0, 100, 1);
      if (percent === null) return null;

      const scale = Number(entity.brightnessScale || 255);
      return {
        topic: entity.commandTopic,
        payload: {
          state: "ON",
          brightness: Math.round((percent / 100) * scale)
        }
      };
    }

    const isOn = Boolean(value);
    return {
      topic: entity.commandTopic,
      payload: { state: isOn ? "ON" : "OFF" }
    };
  }

  if (entity.type === "switch") {
    if (!entity.commandTopic) return null;

    return {
      topic: entity.commandTopic,
      payload: value ? (entity.payloadOn ?? "ON") : (entity.payloadOff ?? "OFF")
    };
  }

  if (entity.type === "climate") {
    if (key === "targetTemperature" || action === "setTargetTemperature") {
      const temperature = clampNumber(
        value,
        entity.minTemp ?? 5,
        entity.maxTemp ?? 30,
        entity.tempStep ?? entity.precision ?? 0.5
      );

      return temperature === null || !entity.temperatureCommandTopic
        ? null
        : { topic: entity.temperatureCommandTopic, payload: temperature };
    }

    if (key === "mode" || action === "setMode") {
      const mode = String(value ?? "");
      if (Array.isArray(entity.modes) && entity.modes.length && !entity.modes.includes(mode)) {
        return null;
      }

      return !entity.modeCommandTopic
        ? null
        : { topic: entity.modeCommandTopic, payload: mode };
    }
  }

  if (entity.type === "humidifier") {
    if (key === "targetHumidity" || action === "setTargetHumidity") {
      const humidity = clampNumber(
        value,
        entity.minHumidity ?? 30,
        entity.maxHumidity ?? 80,
        1
      );

      return humidity === null || !entity.targetHumidityCommandTopic
        ? null
        : { topic: entity.targetHumidityCommandTopic, payload: humidity };
    }

    return !entity.commandTopic
      ? null
      : {
          topic: entity.commandTopic,
          payload: value ? (entity.payloadOn ?? "ON") : (entity.payloadOff ?? "OFF")
        };
  }

  if (entity.type === "cover") {
    if (!entity.commandTopic || !["OPEN", "CLOSE", "STOP"].includes(action)) return null;

    const payloadByAction = {
      OPEN: entity.payloadOpen || "OPEN",
      CLOSE: entity.payloadClose || "CLOSE",
      STOP: entity.payloadStop || "STOP"
    };

    return { topic: entity.commandTopic, payload: payloadByAction[action] };
  }

  if (entity.type === "lock") {
    if (!entity.commandTopic || !["OPEN", "LOCK", "UNLOCK"].includes(action)) return null;

    const payloadByAction = {
      OPEN: entity.payloadOpen || "OPEN",
      LOCK: entity.payloadLock || "LOCK",
      UNLOCK: entity.payloadUnlock || "UNLOCK"
    };

    return { topic: entity.commandTopic, payload: payloadByAction[action] };
  }

  if (entity.type === "lawn_mower") {
    const commandByAction = {
      start_mowing: entity.startMowingCommandTopic,
      pause: entity.pauseCommandTopic,
      dock: entity.dockCommandTopic
    };

    return !commandByAction[action]
      ? null
      : { topic: commandByAction[action], payload: action };
  }

  if (entity.type === "button") {
    return !entity.commandTopic
      ? null
      : { topic: entity.commandTopic, payload: entity.payloadPress ?? "PRESS" };
  }

  if (entity.type === "number") {
    const next = clampNumber(value, entity.min, entity.max, entity.step ?? 1);
    return next === null || !entity.commandTopic
      ? null
      : { topic: entity.commandTopic, payload: next };
  }

  if (entity.type === "text") {
    return !entity.commandTopic
      ? null
      : { topic: entity.commandTopic, payload: String(value ?? "") };
  }

  return null;
}

function normalizeExtensionConfig(config, allowedSourceIds = new Set()) {
  const layout = ["compact", "list", "tiles"].includes(config?.layout)
    ? config.layout
    : "compact";

  const items = Array.isArray(config?.items)
    ? config.items
        .map((item, index) => ({
          sourceId: String(item?.sourceId || "").trim(),
          label: String(item?.label || "").trim(),
          icon: String(item?.icon || "").trim(),
          order: Number.isFinite(Number(item?.order))
            ? Number(item.order)
            : index + 1
        }))
        .filter(item =>
          item.sourceId &&
          (!allowedSourceIds.size || allowedSourceIds.has(item.sourceId))
        )
        .sort((a, b) => a.order - b.order)
    : [];

  return { layout, items };
}

function getExtensionConfigForUser(username, allowedSourceIds) {
  const configs = readExtensionConfigs();
  return normalizeExtensionConfig(configs[username], allowedSourceIds);
}

function createExtensionSnapshot(req) {
  const sources = getAllowedExtensionSources(req);
  const sourceMap = new Map(sources.map(source => [source.id, source]));
  const config = getExtensionConfigForUser(
    getExtensionUsername(req),
    new Set(sourceMap.keys())
  );

  const items = config.items
    .map(item => {
      const source = sourceMap.get(item.sourceId);

      // Die Auswahl der Schnellansicht ist dauerhaft gespeichert, die MQTT-
      // Entities existieren dagegen nur im Laufzeitspeicher. Ist der Broker
      // nicht verbunden, bleiben die konfigurierten Zeilen deshalb sichtbar
      // und zeigen lediglich keinen aktuellen Wert an.
      if (!source) {
        const { entityId, key } = parseExtensionSourceId(item.sourceId);

        return {
          id: item.sourceId,
          entityId,
          sourceKey: key,
          name: item.label || item.sourceId,
          label: item.label || item.sourceId,
          icon: item.icon || "gauge",
          value: null,
          displayValue: "-",
          control: null,
          updatedAt: null,
          unavailable: true,
          order: item.order
        };
      }

      return {
        ...source,
        value: mqttStatus.connected ? source.value : null,
        displayValue: mqttStatus.connected ? source.displayValue : "-",
        control: mqttStatus.connected ? source.control : null,
        unavailable: !mqttStatus.connected,
        label: item.label || source.name || source.label,
        icon: item.icon || source.icon,
        order: item.order
      };
    })
    .filter(Boolean);

  return {
    layout: config.layout,
    items
  };
}

function getPublicConfig() {
  return {
    webPort: mqttConfig.webPort,
    host: mqttConfig.host,
    port: mqttConfig.port,
    topic: mqttConfig.topic,
    clientId: mqttConfig.clientId,
    discoveryViaPrefixes: mqttConfig.discoveryViaPrefixes,
    enabledEntityTypes: mqttConfig.enabledEntityTypes,
    authConfigured: Boolean(mqttConfig.username || mqttConfig.password),
    mqttUsernameConfigured: Boolean(mqttConfig.username),
    mqttPasswordConfigured: Boolean(mqttConfig.password),
    customDashboards: mqttConfig.customDashboards || [],
    chartConfigs: mqttConfig.chartConfigs || [],
    friendlyNames: mqttConfig.friendlyNames || {},
    auth: {
      enabled: mqttConfig.auth?.enabled ?? false
    },
    history: mqttConfig.history || { enabled: false, entities: {} }
  };
}

app.get("/api/config", (req, res) => {
  res.json(getPublicConfig());
});


// Middleware zum config schreiben
function requireAdmin(req, res, next) {

  // 🔓 Auth deaktiviert → alles erlaubt
  if (!mqttConfig.auth?.enabled) {
    return next();
  }

  const user = req.session?.user;

  if (!user || !user.roles?.includes('admin')) {
    return res.status(403).json({
      error: 'Forbidden'
    });
  }

  next();
}

function isAdminUser(req) {
  if (!mqttConfig.auth?.enabled) {
    return true;
  }

  return getRequestUser(req)?.roles?.includes('admin');
}

function getRequestUsername(req) {
  if (!mqttConfig.auth?.enabled) {
    return 'admin';
  }

  return getRequestUser(req)?.username || 'unknown';
}

function canManageChartConfig(req, chartConfig) {
  return (
    isAdminUser(req)
    || chartConfig.createdBy === getRequestUsername(req)
  );
}

function normalizeChartConfig(config, existingConfig, username) {
  const now = new Date().toISOString();

  return {
    id: String(config.id || "").trim(),
    name: String(config.name || "").trim(),
    primaryEntityId: String(config.primaryEntityId || "").trim(),
    entityIds: Array.isArray(config.entityIds)
      ? config.entityIds.map(id => String(id).trim()).filter(Boolean)
      : [],
    hours: Number(config.hours) || 12,
    createdBy: existingConfig?.createdBy || username,
    createdAt: existingConfig?.createdAt || now,
    updatedBy: username,
    updatedAt: now
  };
}

app.post("/api/config", requireAdmin, (req, res) => {
  const oldConfig = { ...mqttConfig };
  const {
  webPort,
  host,
  port,
  topic,
  username,
  password,
  clientId,
  discoveryViaPrefixes,
  enabledEntityTypes,
  chartConfigs,
  auth,
  history
} = req.body;

  if (!host || !port || !topic) {
    return res.status(400).json({
      error: "host, port und topic sind erforderlich",
    });
  }

  mqttConfig = {
    ...mqttConfig,

    webPort: Number(webPort) || mqttConfig.webPort || 3000,
    host: String(host).trim(),
    port: Number(port),
    topic: String(topic).trim(),

    username: username === undefined || username === ''
      ? mqttConfig.username
      : String(username).trim(),

    password: password === undefined || password === ''
      ? mqttConfig.password
      : String(password),

    clientId: clientId === undefined || clientId === ''
      ? mqttConfig.clientId
      : String(clientId).trim(),

    discoveryViaPrefixes: normalizeDiscoveryPrefixes(discoveryViaPrefixes),

    enabledEntityTypes: Array.isArray(enabledEntityTypes)
      ? enabledEntityTypes.map(v => String(v).trim()).filter(v => v !== "")
      : (Array.isArray(mqttConfig.enabledEntityTypes)
          ? mqttConfig.enabledEntityTypes
          : ["light", "climate", "cover", "lock", "humidifier", "lawn_mower", "sensor", "binary_sensor", "switch", "button", "number", "text"]),
  };

  // 🔥 AUTH übernehmen
  if (auth && typeof auth.enabled !== 'undefined') {
    mqttConfig.auth = {
      ...mqttConfig.auth,
      enabled: !!auth.enabled
    };
  }

  // 🔥 HISTORY übernehmen
  if (history && typeof history === 'object') {
    mqttConfig.history = {
      enabled: !!history.enabled,
      entities: typeof history.entities === 'object' ? history.entities : {}
    };
  }

  if (Array.isArray(chartConfigs)) {
    const username = getRequestUsername(req);

    mqttConfig.chartConfigs = chartConfigs.map(config =>
      normalizeChartConfig(config, config, username)
    ).filter(config =>
      config.id
      && config.name
      && config.primaryEntityId
      && config.entityIds.length
    );
  }

  allowedDiscoveryViaDevicePrefixes = mqttConfig.discoveryViaPrefixes
  .filter(p => p.enabled)
  .map(p => p.value);

  const brokerChanged =
    oldConfig.host !== mqttConfig.host ||
    oldConfig.port !== mqttConfig.port ||
    oldConfig.topic !== mqttConfig.topic ||
    oldConfig.username !== mqttConfig.username ||
    oldConfig.password !== mqttConfig.password ||
    oldConfig.clientId !== mqttConfig.clientId;

  saveConfigToFile();

  // Ein vorhandenes, aber getrenntes Client-Objekt darf "Verbinden" nicht
  // blockieren. Genau dieser Zustand konnte bisher erst durch "Trennen"
  // und anschließendes erneutes "Verbinden" behoben werden.
  const shouldReconnect = brokerChanged || !mqttClient || !mqttStatus.connected;

  if (shouldReconnect) {
    connectMqtt();
  }

  res.json({
    success: true,
    reconnected: shouldReconnect,
    config: {
      webPort: mqttConfig.webPort,
      host: mqttConfig.host,
      port: mqttConfig.port,
      topic: mqttConfig.topic,
      clientId: mqttConfig.clientId,
      discoveryViaPrefixes: mqttConfig.discoveryViaPrefixes,
      enabledEntityTypes: mqttConfig.enabledEntityTypes,
      authConfigured: Boolean(mqttConfig.username || mqttConfig.password),
      mqttUsernameConfigured: Boolean(mqttConfig.username),
      mqttPasswordConfigured: Boolean(mqttConfig.password),
      auth: {
        enabled: mqttConfig.auth?.enabled ?? false
      },
      chartConfigs: mqttConfig.chartConfigs || [],
      history: mqttConfig.history || { enabled: false, entities: {} }
    }
  });
});

app.post("/api/chart-configs", (req, res) => {
  const username = getRequestUsername(req);
  const incomingConfig = req.body?.config;

  if (!incomingConfig || typeof incomingConfig !== 'object') {
    return res.status(400).json({
      error: "config ist erforderlich"
    });
  }

  if (!Array.isArray(mqttConfig.chartConfigs)) {
    mqttConfig.chartConfigs = [];
  }

  const existingIndex =
    mqttConfig.chartConfigs.findIndex(config =>
      config.id === String(incomingConfig.id || "").trim()
    );
  const existingConfig =
    existingIndex >= 0
      ? mqttConfig.chartConfigs[existingIndex]
      : null;

  if (existingConfig && !canManageChartConfig(req, existingConfig)) {
    return res.status(403).json({
      error: "Nur Ersteller oder Admin dürfen diese Ansicht ändern"
    });
  }

  const chartConfig =
    normalizeChartConfig(incomingConfig, existingConfig, username);

  if (
    !chartConfig.id
    || !chartConfig.name
    || !chartConfig.primaryEntityId
    || !chartConfig.entityIds.length
  ) {
    return res.status(400).json({
      error: "Ungültige Chart-Konfiguration"
    });
  }

  if (existingIndex >= 0) {
    mqttConfig.chartConfigs[existingIndex] = chartConfig;
  } else {
    mqttConfig.chartConfigs.push(chartConfig);
  }

  saveConfigToFile();

  res.json({
    success: true,
    chartConfig,
    chartConfigs: mqttConfig.chartConfigs
  });
});

app.delete("/api/chart-configs/:id", (req, res) => {
  const id = String(req.params.id || "").trim();

  if (!Array.isArray(mqttConfig.chartConfigs)) {
    mqttConfig.chartConfigs = [];
  }

  const existingIndex =
    mqttConfig.chartConfigs.findIndex(config => config.id === id);

  if (existingIndex < 0) {
    return res.status(404).json({
      error: "Chart-Konfiguration nicht gefunden"
    });
  }

  const existingConfig =
    mqttConfig.chartConfigs[existingIndex];

  if (!canManageChartConfig(req, existingConfig)) {
    return res.status(403).json({
      error: "Nur Ersteller oder Admin dürfen diese Ansicht löschen"
    });
  }

  mqttConfig.chartConfigs.splice(existingIndex, 1);
  saveConfigToFile();

  res.json({
    success: true,
    chartConfigs: mqttConfig.chartConfigs
  });
});

app.post("/api/entity-types", requireAdmin, (req, res) => {
  const { enabledEntityTypes } = req.body;

  if (!Array.isArray(enabledEntityTypes)) {
    return res.status(400).json({
      error: "enabledEntityTypes muss ein Array sein",
    });
  }

  mqttConfig.enabledEntityTypes = enabledEntityTypes
    .map(v => String(v).trim())
    .filter(v => v !== "");

  saveConfigToFile();

  res.json({
    success: true,
    enabledEntityTypes: mqttConfig.enabledEntityTypes,
  });
});

app.post("/api/discovery-prefixes", requireAdmin, (req, res) => {
  const { discoveryViaPrefixes } = req.body;

  mqttConfig.discoveryViaPrefixes = normalizeDiscoveryPrefixes(discoveryViaPrefixes);

  allowedDiscoveryViaDevicePrefixes = mqttConfig.discoveryViaPrefixes
    .filter(p => p.enabled)
    .map(p => p.value);

  saveConfigToFile();

  connectMqtt();

  res.json({
    success: true,
    discoveryViaPrefixes: mqttConfig.discoveryViaPrefixes,
  });
});

app.post("/api/custom-dashboards", requireAdmin, (req, res) => {
  const { customDashboards } = req.body;
  if (!Array.isArray(customDashboards)) {
    return res.status(400).json({
      error: "customDashboards muss ein Array sein",
    });
  }

  mqttConfig.customDashboards = customDashboards.map(dashboard => ({
    id: String(dashboard.id || "").trim(),
    name: String(dashboard.name || "").trim(),
    allowedRoles: Array.isArray(dashboard.allowedRoles)
        ? dashboard.allowedRoles
            .map(role => String(role).trim())
            .filter(Boolean)
        : [],
    devices: Array.isArray(dashboard.devices)
      ? dashboard.devices.map(device => ({
          deviceId: String(device.deviceId || "").trim(),
          entityIds: Array.isArray(device.entityIds)
            ? device.entityIds.map(id => String(id).trim()).filter(Boolean)
            : [],
          isVirtual: Boolean(device.isVirtual),
          name: device.isVirtual
            ? String(device.name || "Virtuelles Gerät").trim()
            : undefined
        })).filter(device => device.deviceId)
      : []
  })).filter(dashboard => dashboard.id && dashboard.name);

  saveConfigToFile();

  res.json({
    success: true,
    customDashboards: mqttConfig.customDashboards,
  });
});

app.post("/api/disconnect", requireAdmin, async (req, res) => {
  await disconnectMqtt({ manual: true });
  res.json({ success: true });
});

app.post("/api/reconnect", requireAdmin, async (req, res) => {
  await connectMqtt();

  res.json({
    success: true,
    message: "MQTT reconnect gestartet"
  });
});

app.post("/api/mqtt/publish", (req, res) => {
  const { topic, payload } = req.body;

  if (!mqttClient) {
    return res.status(400).json({
      success: false,
      error: "MQTT ist nicht verbunden",
    });
  }

  if (!topic) {
    return res.status(400).json({
      success: false,
      error: "Topic fehlt",
    });
  }

  mqttClient.publish(String(topic), String(payload ?? ""), (err) => {
    if (err) {
      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }

    res.json({
      success: true,
    });
  });
});

// Mqtt Publisch auch in anderen Backend Dateien nutzen
function publishMqttDirect(topic, payload) {

  if (!mqttClient) {
    console.warn('MQTT nicht verbunden');
    return;
  }

  if (!topic) {
    console.warn('Kein Topic angegeben');
    return;
  }

  const finalPayload =
    typeof payload === 'string' || typeof payload === 'number'
      ? String(payload)
      : JSON.stringify(payload);

  mqttClient.publish(String(topic), finalPayload, (err) => {
    if (err) {
      console.error('MQTT Fehler:', err.message);
    }
  });
}

// FUnktion an LogicEngine übergeben
logicEngine.setMqttPublisher(publishMqttDirect);

app.post("/api/friendly-names", requireAdmin, (req, res) => {
  const { friendlyNames, deviceId, name, entityId, entityName } = req.body;

  // 👉 INIT falls nicht vorhanden
  if (!mqttConfig.friendlyNames || typeof mqttConfig.friendlyNames !== "object") {
    mqttConfig.friendlyNames = {};
  }

  // =========================
  // 🔥 FALL 1: FULL REPLACE (Import)
  // =========================
  if (friendlyNames && typeof friendlyNames === "object") {
    mqttConfig.friendlyNames = friendlyNames;

    saveConfigToFile();

    return res.json({
      success: true,
      mode: "full-replace",
      friendlyNames: mqttConfig.friendlyNames,
    });
  }

  // =========================
  // 🔥 FALL 2: DEVICE RENAME
  // =========================
  if (deviceId && entityId === undefined) {
    if (!mqttConfig.friendlyNames[deviceId]) {
      mqttConfig.friendlyNames[deviceId] = { name: null, entities: {} };
    }

    if (!name) {
      delete mqttConfig.friendlyNames[deviceId].name;
    } else {
      mqttConfig.friendlyNames[deviceId].name = name;
    }

    saveConfigToFile();

    return res.json({
      success: true,
      mode: "device-rename",
      deviceId,
      friendlyNames: mqttConfig.friendlyNames,
    });
  }

  // =========================
  // 🔥 FALL 3: ENTITY RENAME
  // =========================
  if (deviceId && entityId) {
    if (!mqttConfig.friendlyNames[deviceId]) {
      mqttConfig.friendlyNames[deviceId] = { name: null, entities: {} };
    }

    if (!entityName) {
      delete mqttConfig.friendlyNames[deviceId].entities?.[entityId];
    } else {
      mqttConfig.friendlyNames[deviceId].entities[entityId] = entityName;
    }

    saveConfigToFile();

    return res.json({
      success: true,
      mode: "entity-rename",
      deviceId,
      entityId,
      friendlyNames: mqttConfig.friendlyNames,
    });
  }

  res.status(400).json({
    success: false,
    error: "Ungültige Anfrage",
  });
});

app.get("/api/device-store", (req, res) => {
  res.json(deviceStore);
});

app.get("/api/topic-store", (req, res) => {
  res.json(topicStore);
});

app.get("/api/pending", (req, res) => {
  res.json(pendingStateMessages);
});

app.get("/api/devices", (req, res) => {
  res.json(getDevicesForDashboard());
});

app.get("/api/combined", (req, res) => {
  res.json(getCombinedStore());
});

// logical Store ins Backend
app.post('/api/logical-devices', requireAdmin, (req, res) => {

    const devices = req.body.devices || [];

    devices.forEach(d => {

        if (!logicalDeviceStore[d.id]) {
            logicalDeviceStore[d.id] = {
                ...d,
                entities: {},
                isLogical: true
            };
        }

        (d.entities || []).forEach(e => {
            logicalDeviceStore[d.id].entities[e.id] = e;
        });

    });

    console.log("💾 Virtuelle Geräte gespeichert:", Object.keys(logicalDeviceStore));
    saveLogicalDevices();
    res.json({ success: true });
});

app.get('/api/logical-devices', (req, res) => {
  
    const devices = Object.values(logicalDeviceStore).map(d => ({
        ...d,
        entities: Object.values(d.entities || {}) // 🔥 zurück zu Array
    }));

  res.json({ devices });

});

function createCalculatedEntityId(name) {
  const base = String(name || 'wert')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'wert';
  let id = `calculated_${base}`;
  let suffix = 2;

  while (findEntityById(id)) {
    id = `calculated_${base}_${suffix}`;
    suffix += 1;
  }

  return id;
}

app.post('/api/calculated-entities', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const unit = String(req.body?.unit || '').trim().slice(0, 24);

  if (!name) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }

  const deviceId = 'logic_calculated_values';
  const now = new Date().toISOString();

  if (!logicalDeviceStore[deviceId]) {
    logicalDeviceStore[deviceId] = {
      id: deviceId,
      name: 'Berechnete Werte',
      isLogical: true,
      entities: {},
      createdAt: now,
      updatedAt: now
    };
  }

  const entity = {
    id: createCalculatedEntityId(name),
    deviceId,
    name: name.slice(0, 120),
    type: 'sensor',
    value: 0,
    unit,
    isCalculated: true,
    createdAt: now,
    lastUpdate: now
  };

  logicalDeviceStore[deviceId].entities[entity.id] = entity;
  logicalDeviceStore[deviceId].updatedAt = now;
  saveLogicalDevices();

  res.status(201).json({
    device: {
      ...logicalDeviceStore[deviceId],
      entities: Object.values(logicalDeviceStore[deviceId].entities)
    },
    entity
  });
});

app.patch('/api/calculated-entities/:entityId', requireAdmin, (req, res) => {
  const entityId = String(req.params.entityId || '').trim();
  const entity = findEntityById(entityId);

  if (!entity?.isCalculated) {
    return res.status(404).json({ error: 'Berechnete Entity nicht gefunden' });
  }

  const name = String(req.body?.name || '').trim();
  const unit = String(req.body?.unit || '').trim().slice(0, 24);

  if (!name) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }

  const device = logicalDeviceStore[entity.deviceId];
  entity.name = name.slice(0, 120);
  entity.unit = unit;
  entity.lastUpdate = new Date().toISOString();
  if (device) device.updatedAt = entity.lastUpdate;
  saveLogicalDevices();

  io.emit('entity-update', {
    deviceId: entity.deviceId,
    entityId: entity.id,
    entity
  });

  res.json({
    device: {
      ...device,
      entities: Object.values(device?.entities || {})
    },
    entity
  });
});

function getCombinedStore() {
    return {
        ...deviceStore,
        ...logicalDeviceStore
    };
}

const LOGIC_FILE = path.join(__dirname, './data/logics.json');

app.post('/api/logics', requireAdmin, (req, res) => {
  const dir = path.dirname(LOGIC_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(LOGIC_FILE, JSON.stringify(req.body, null, 2));
  logicEngine.setLogics(req.body);
  res.json({ success: true });
});

app.get('/api/logics', (req, res) => {
  if (!fs.existsSync(LOGIC_FILE)) {
    return res.json({ nodes: [], connections: [] });
  }

  const data = JSON.parse(fs.readFileSync(LOGIC_FILE, 'utf-8'));
  res.json(data);
});

function normalizeHistoryBooleanValue(value) {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value ? 1 : 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'on', 'open', 'yes'].includes(normalized)) {
      return 1;
    }

    if (['false', '0', 'off', 'closed', 'no'].includes(normalized)) {
      return 0;
    }
  }

  return null;
}

function sendHistoryResponse(req, res, entityId) {
  const entity = findEntityById(entityId);
  const cfg = getHistoryConfig(entityId);

  const isBinarySensor =
      cfg?.source?.type === 'boolean' ||
      entity?.type === 'binary_sensor';

  const hours = parseFloat(req.query.hours) || 24;

  // 🔥 Aggregation in Sekunden
  const aggregation =
    parseInt(req.query.aggregation) || 300;
  // cutoff berechnen
  let cutoff =
    Math.floor(Date.now() / 1000) - (hours * 60 * 60);

  if (aggregation >= 24 * 60 * 60) {
    const cutoffDate = new Date(cutoff * 1000);
    cutoffDate.setHours(0, 0, 0, 0);
    cutoff = Math.floor(cutoffDate.getTime() / 1000);
  }

  if (isBinarySensor) {

      db.get(`

          SELECT
              value

          FROM history_boolean

          WHERE entityId = ?
            AND timestamp < ?

          ORDER BY timestamp DESC

          LIMIT 1

      `, [

          entityId,
          cutoff

      ], (previousErr, previousRow) => {

          if (previousErr) {
              console.error(previousErr);

              return res.status(500).json({
                  error: previousErr.message
              });
          }

          db.all(`

          SELECT
              timestamp as t,
              value

          FROM history_boolean

          WHERE entityId = ?
            AND timestamp >= ?

          ORDER BY timestamp ASC

      `, [

          entityId,
          cutoff

      ], (err, rows) => {

          if (err) {
              console.error(err);

              return res.status(500).json({
                  error: err.message
              });
          }

          let booleanRows = rows;

          if (previousRow) {
              booleanRows = [
                  {
                      t: cutoff,
                      value: previousRow.value
                  },
                  ...rows
              ];
          } else if (rows.length > 0) {
              const firstRow = rows[0];
              const firstValue =
                  normalizeHistoryBooleanValue(firstRow.value);

              if (
                  firstValue !== null
                  && Number(firstRow.t) > cutoff
              ) {
                  booleanRows = [
                      {
                          t: cutoff,
                          value: firstValue ? 0 : 1,
                          inferred: true
                      },
                      ...rows
                  ];
              }
          } else {
              const liveValue =
                  normalizeHistoryBooleanValue(entity?.value);

              booleanRows =
                  liveValue === null
                      ? []
                      : [
                          {
                              t: cutoff,
                              value: liveValue,
                              inferred: true
                          }
                      ];
          }

          res.json(booleanRows);
      });
      });

      return;
  }

  const aggregationSelect =
    aggregation >= 24 * 60 * 60
      ? `
        CAST(strftime(
          '%s',
          date(bucket, 'unixepoch', 'localtime') || ' 00:00:00',
          'utc'
        ) AS INTEGER) as t
      `
      : `((bucket / ?) * ?) as t`;

  const aggregationParams =
    aggregation >= 24 * 60 * 60
      ? []
      : [aggregation, aggregation];

  db.all(`

    SELECT

      ${aggregationSelect},

      MIN(min) as min,
      MAX(max) as max,

      AVG(avg) as avg,

      MIN(first) as first,
      MAX(last) as last,

      SUM(positive_change)
        as positive_change,

      SUM(negative_change)
        as negative_change,

      SUM(count) as count

    FROM history

    WHERE entityId = ?
      AND bucket >= ?

    GROUP BY t

    ORDER BY t ASC

  `, [

    ...aggregationParams,

    entityId,
    cutoff

  ], (err, rows) => {

    if (err) {
      console.error(err);

      return res.status(500).json({
        error: err.message
      });
    }

    res.json(rows);

  });

}

app.get('/api/history/:entityId', (req, res) => {
  sendHistoryResponse(req, res, req.params.entityId);
});

app.post('/api/extension/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const user = getUserByUsername(username);

  if (!user || user.active === false) {
    return res.status(401).json({ error: "Login fehlgeschlagen" });
  }

  const valid = await bcryptjs.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Login fehlgeschlagen" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokens = readExtensionTokens();

  tokens[hashExtensionToken(token)] = {
    username: user.username,
    createdAt: new Date().toISOString()
  };

  writeExtensionTokens(tokens);

  res.json({
    ok: true,
    token,
    user: {
      username: user.username,
      roles: user.roles || [],
      isDefault: user.isDefault
    }
  });
});

app.get('/api/extension/me', (req, res) => {
  const user = getRequestUser(req);

  res.json({
    ok: true,
    user: {
      username: getExtensionUsername(req),
      roles: user?.roles || ['admin']
    }
  });
});

app.get('/api/extension/sources', (req, res) => {
  res.json({
    ok: true,
    sources: getAllowedExtensionSources(req)
  });
});

app.get('/api/extension/config', (req, res) => {
  const sources = getAllowedExtensionSources(req);
  const allowedSourceIds = new Set(sources.map(source => source.id));

  res.json({
    ok: true,
    config: getExtensionConfigForUser(
      getExtensionUsername(req),
      allowedSourceIds
    )
  });
});

app.post('/api/extension/config', (req, res) => {
  const sources = getAllowedExtensionSources(req);
  const allowedSourceIds = new Set(sources.map(source => source.id));
  const config = normalizeExtensionConfig(req.body, allowedSourceIds);
  const configs = readExtensionConfigs();

  configs[getExtensionUsername(req)] = config;
  writeExtensionConfigs(configs);

  res.json({
    ok: true,
    config
  });
});

app.get('/api/extension/snapshot', (req, res) => {
  const snapshot = createExtensionSnapshot(req);

  res.json({
    ok: true,
    ...snapshot
  });
});

app.post('/api/extension/command', (req, res) => {
  const sourceId = String(req.body?.sourceId || "").trim();
  const action = String(req.body?.action || "set").trim();
  const value = req.body?.value;

  const source = getAllowedExtensionSources(req)
    .find(item => item.id === sourceId);

  if (!source) {
    return res.status(404).json({
      ok: false,
      error: "Extension-Wert nicht gefunden"
    });
  }

  if (!source.control) {
    return res.status(400).json({
      ok: false,
      error: "Dieser Wert ist nicht steuerbar"
    });
  }

  const entity = findEntityById(source.entityId);
  if (!entity) {
    return res.status(404).json({
      ok: false,
      error: "Entity nicht gefunden"
    });
  }

  const command = buildExtensionCommandPayload(entity, source, action, value);
  if (!command) {
    return res.status(400).json({
      ok: false,
      error: "Befehl kann fuer diese Entity nicht ausgefuehrt werden"
    });
  }

  return publishExtensionCommand(command.topic, command.payload, res);
});

function sendExtensionHistoryResponse(req, res, sourceId) {
  const source = getAllowedExtensionSources(req)
    .find(item => item.id === sourceId);

  if (!source) {
    return res.status(404).json({
      error: "History-Wert nicht gefunden"
    });
  }

  if (!getHistoryConfig(source.id)?.enabled) {
    return res.status(404).json({
      error: "History fuer diesen Wert nicht aktiviert"
    });
  }

  return sendHistoryResponse(req, res, source.id);
}

app.get('/api/extension/history', (req, res) => {
  return sendExtensionHistoryResponse(
    req,
    res,
    String(req.query.sourceId || "")
  );
});

app.get('/api/extension/history/:sourceId', (req, res) => {
  return sendExtensionHistoryResponse(
    req,
    res,
    String(req.params.sourceId || "")
  );
});

// Restliche API Routen als unbekannt melden
app.use('/api/',(req, res) => {
  return res.status(401).json({ error: "API unbekannt"});
});

// Restliche routen => catch all
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


io.on("connection", (socket) => {
  console.log("Browser verbunden:", socket.id);
  socket.emit("mqtt-status", mqttStatus);
  socket.emit("device-store", deviceStore);
  socket.emit("topic-store", topicStore);
});

const WEB_PORT = Number(mqttConfig.webPort || DEFAULT_WEB_PORT);

server.listen(WEB_PORT, "0.0.0.0", async () => {
  console.log(`Webserver läuft auf http://0.0.0.0:${WEB_PORT}`);

  //Admin prüfen
  await ensureAdminUser();

  // automatische Verbindung beim Start
  connectMqtt();
});





// Virtuele Geräte

function loadLogicalDevices() {
    try {
        const raw = fs.readFileSync(LOGICAL_FILE, 'utf-8');
        const data = JSON.parse(raw);

        // 🔥 array → map umwandeln
        logicalDeviceStore = {};

        data.forEach(d => {
            const entityMap = {};

            (d.entities || []).forEach(e => {
                entityMap[e.id] = e;
            });

            logicalDeviceStore[d.id] = {
                ...d,
                entities: entityMap,
                isLogical: true
            };
        });

        console.log("📂 Virtuelle Geräte geladen");

    } catch (err) {
        console.warn("⚠️ Keine virtuellen Geräte gefunden");
        logicalDeviceStore = {};
    }
}

function saveLogicalDevices() {

    const devices = Object.values(logicalDeviceStore).map(d => ({
        ...d,
        entities: Object.values(d.entities || {})
    }));

    fs.writeFileSync(
        LOGICAL_FILE,
        JSON.stringify(devices, null, 2)
    );

    console.log("💾 Virtuelle Geräte gespeichert");
}

let logicalSaveTimer = null;
const activeCalculatedUpdates = new Set();

function scheduleLogicalDevicesSave() {
    clearTimeout(logicalSaveTimer);
    logicalSaveTimer = setTimeout(saveLogicalDevices, 250);
}

function updateCalculatedEntity(entityId, value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;

    const entity = findEntityById(entityId);
    if (!entity?.isCalculated) return;
    if (Math.abs(Number(entity.value) - numericValue) < 0.000001) return;

    const device = logicalDeviceStore[entity.deviceId];
    const now = new Date().toISOString();
    entity.value = numericValue;
    entity.lastUpdate = now;
    if (device) device.updatedAt = now;

    scheduleLogicalDevicesSave();

    io.emit('entity-update', {
      deviceId: entity.deviceId,
      entityId: entity.id,
      entity
    });

    getHistoryConfigsForEntity(entity.id).forEach(({ historyId, cfg }) => {
      historyStore.writeHistory(historyId, entity, cfg);
    });

    if (!activeCalculatedUpdates.has(entity.id)) {
      activeCalculatedUpdates.add(entity.id);
      try {
        logicEngine.runLogicEngine(entity.id);
      } finally {
        activeCalculatedUpdates.delete(entity.id);
      }
    }
}


// Logiken laden
loadLogicalDevices();

if (fs.existsSync(LOGIC_FILE)) {
  const data = JSON.parse(fs.readFileSync(LOGIC_FILE, 'utf-8'));
  logicEngine.setLogics(data);
}

function findEntityById(entityId) {
  for (const device of Object.values(getCombinedStore())) {

    if (!device.entities) continue;

    if (device.entities[entityId]) {
      return device.entities[entityId];
    }
  }

  return null;
}

logicEngine.setEntityGetter(findEntityById);
logicEngine.setComputedEntityWriter(updateCalculatedEntity);

// Anstoßen des Datenbank cleanups
historyStore.startCleanup();

// Mergen der config.json
function deepMergeDefaults(defaults, target) {
  for (const key in defaults) {
    if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
      if (!target[key]) {
        target[key] = {};
      }
      deepMergeDefaults(defaults[key], target[key]);
    } else {
      if (target[key] === undefined) {
        target[key] = defaults[key];
      }
    }
  }
  return target;
}

function parseEnv(content) {
  const lines = content.split('\n');
  const result = {};

  lines.forEach(line => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) return;

    const [key, ...rest] = trimmed.split('=');
    result[key] = rest.join('=');
  });

  return result;
}

// Configuration der Entity für die db
function getHistoryConfig(entityId) {
  // 🔥 global deaktiviert
  if (!mqttConfig.history?.enabled) return null;

  return mqttConfig.history?.entities?.[entityId];
}

function getHistoryConfigsForEntity(entityId) {
  if (!mqttConfig.history?.enabled) return [];

  const entries = [];
  const configs = mqttConfig.history?.entities || {};
  const directConfig = configs[entityId];

  if (directConfig) {
    entries.push({
      historyId: entityId,
      cfg: directConfig
    });
  }

  Object.entries(configs).forEach(([historyId, cfg]) => {
    if (
      historyId.startsWith(`${entityId}::`) &&
      cfg?.source?.entityId === entityId
    ) {
      entries.push({ historyId, cfg });
    }
  });

  return entries;
}
