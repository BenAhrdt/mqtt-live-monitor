const session = require('express-session');
const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
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

let CONFIG_PATH;
const USER_FILE = path.join(__dirname, "usercredentials.json");

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

// 👉 prüfen ob Electron läuft
const isElectron = !!process.versions.electron;

if (isElectron) {
    const { app } = require("electron");

    CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
} else {
    CONFIG_PATH = path.join(__dirname, "config.json");
}

const CONFIG_EXAMPLE_PATH = path.join(__dirname, "config-example.json");



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

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.USE_HTTPS === "true",
        sameSite: "lax"
    }
}));


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
    req.path.startsWith('/auth/enabled')
  ) {
    return next();
  }

  return requireAuth(req, res, next);
});

const server = http.createServer(app);
const io = new Server(server);

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
    isDefault: users.isDefault
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

    res.clearCookie('connect.sid'); // 🔥 wichtig
    res.json({ success: true });
  });
});

app.post('/api/settings/auth', (req, res) => {

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

app.get('/api/users', (req, res) => {
  const data = readUsers();

  // Passwort NICHT mitsenden!
  const users = data.users.map(u => ({
    username: u.username,
    roles: u.roles,
    active: u.active !== false,
    isDefault: u.isDefault
  }));

  res.json(users);
});

app.post('/api/users', async (req, res) => {
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

  const data = readUsers();
  const user = data.users.find(u => u.username === username);

  if (!user) {
    return res.status(404).json({ error: 'User nicht gefunden' });
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

  res.json({ success: true });
});

app.delete('/api/users/:username', (req, res) => {
  const data = readUsers();

  data.users = data.users.filter(u => u.username !== req.params.username);

  writeUsers(data);

  res.json({ success: true });
});

app.post("/api/admin/create", async (req, res) => {
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

app.post("/api/admin/reset", (req, res) => {
  const creds = readCredentials();
  creds.passwordHash = null;
  writeCredentials(creds);
  res.json({ success: true });
});

app.post("/api/admin/change-password", async (req, res) => {
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

app.post("/api/update/run", (req, res) => {
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
      adminOnly: d.adminOnly ?? false
    }));

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
  const possibleTopics = [
    entity.stateTopic,
    entity.positionTopic,
    entity.modeStateTopic,
    entity.temperatureStateTopic,
    entity.currentTemperatureTopic,
    entity.targetHumidityStateTopic,
    entity.currentHumidityTopic,
    entity.activityStateTopic,
  ].filter(Boolean);

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
  const cfg = getHistoryConfig(mapping.entityId);
  historyStore.writeHistory(mapping.entityId, entity.value, cfg);

  // Logik anstoßen
  logicEngine.runLogicEngine(mapping.entityId);
}


function extractValueJsonKey(template) {
    const match =
        template?.match(/value_json\.([a-zA-Z0-9_]+)/);

    return match ? match[1] : null;
}

let isConnecting = false;

function disconnectMqtt() {
  if (!mqttClient) {
    emitStatus({
      connected: false,
      message: "Nicht verbunden",
    });
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    try {
      console.log("MQTT wird getrennt...");

      mqttClient.removeAllListeners(); // 🔥 FIX: verhindert doppelte Events

      mqttClient.end(true, () => {
        mqttClient = null;

        emitStatus({
          connected: false,
          host: mqttConfig.host,
          port: mqttConfig.port,
          topic: mqttConfig.topic,
          message: "Manuell getrennt",
        });

        console.log("MQTT manuell getrennt");
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

  // 🔥 FIX: sauber warten bis alter Client wirklich weg ist
  await disconnectMqtt();

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

    clean: false,

    reconnectPeriod: 3000,
    connectTimeout: 10000,
    keepalive: 30,

    resubscribe: true,
    queueQoSZero: true,
  });

  // 🔥 OPTIONAL FIX: doppelte Listener vermeiden (sicher ist sicher)
  mqttClient.removeAllListeners();

  mqttClient.on("connect", () => {
    console.log("Mit MQTT verbunden");

    mqttClient.subscribe(topic, { qos: 0 }, (err) => {
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
      }
    } else {
      addLog("STATE", topic, message);
      const stateResult = handleKnownTopicMessage(topic, message);

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
    emitStatus({
      connected: false,
      host,
      port,
      topic,
      message: "Reconnect...",
    });
  });

  mqttClient.on("close", () => {
    emitStatus({
      connected: false,
      host,
      port,
      topic,
      message: "Verbindung geschlossen",
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
    customDashboards: mqttConfig.customDashboards || [],
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

  const shouldReconnect = brokerChanged || !mqttClient;

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
      auth: {
        enabled: mqttConfig.auth?.enabled ?? false
      },
      history: mqttConfig.history || { enabled: false, entities: {} }
    }
  });
});

app.post("/api/entity-types", (req, res) => {
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

app.post("/api/discovery-prefixes", (req, res) => {
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

app.post("/api/custom-dashboards", (req, res) => {
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

app.post("/api/disconnect", (req, res) => {
  disconnectMqtt();
  res.json({ success: true });
});

app.post("/api/reconnect", (req, res) => {
  connectMqtt();

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

app.post("/api/friendly-names", (req, res) => {
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
app.post('/api/logical-devices', (req, res) => {

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

function getCombinedStore() {
    return {
        ...deviceStore,
        ...logicalDeviceStore
    };
}

const LOGIC_FILE = path.join(__dirname, './data/logics.json');

app.post('/api/logics', (req, res) => {
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

app.get('/api/history/:entityId', (req, res) => {

  const { entityId } = req.params;

  const hours = parseFloat(req.query.hours) || 24;

  // 🔥 Aggregation in Sekunden
  const aggregation =
    parseInt(req.query.aggregation) || 300;
  // cutoff berechnen
  const cutoff =
    Math.floor(Date.now() / 1000) - (hours * 60 * 60);

  db.all(`

    SELECT

      ((bucket / ?) * ?) as t,

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

    aggregation,
    aggregation,

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


// Logiken laden
if (fs.existsSync(LOGIC_FILE)) {
  const data = JSON.parse(fs.readFileSync(LOGIC_FILE, 'utf-8'));
  logicEngine.setLogics(data);
}

function findEntityById(entityId) {
  for (const deviceId in deviceStore) {
    const device = deviceStore[deviceId];

    if (!device.entities) continue;

    if (device.entities[entityId]) {
      return device.entities[entityId];
    }
  }

  return null;
}

logicEngine.setEntityGetter(findEntityById);

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