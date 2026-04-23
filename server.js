const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const mqtt = require("mqtt");
const packageJson = require("./package.json");

const { Server } = require("socket.io");

const https = require('https');

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
const server = http.createServer(app);
const io = new Server(server);

app.get('/api/update/check', async (req, res) => {
  const currentVersion = require('./package.json').version;
  const latestVersion = '1.0.0';//await fetchLatestVersion();

  res.json({
    current: currentVersion,
    latest: latestVersion,
    updateAvailable:
      latestVersion && latestVersion !== `v${currentVersion}`
  });
});

const DEFAULT_WEB_PORT = 3000;
const CONFIG_PATH = path.join(__dirname, "config.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

/**
 * Store 2:
 * Topic -> Zuordnung zu Device / Entity
 */
const topicStore = {};

let mqttConfig = {
  webPort: 3000,
  port: 1883,
  topic: "#",
  clientId: "LiveMonitor",
  discoveryViaPrefixes: ["lorawan"],
  enabledEntityTypes: ["light", "climate", "cover", "lock", "humidifier", "lawn_mower"],
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
      discoveryViaPrefixes: Array.isArray(parsed.discoveryViaPrefixes) && parsed.discoveryViaPrefixes.length
        ? parsed.discoveryViaPrefixes.map(v => String(v).trim()).filter(v => v !== "")
        : ["lorawan"],
    };

    allowedDiscoveryViaDevicePrefixes = [...mqttConfig.discoveryViaPrefixes];
  } catch (error) {
    console.error("Fehler beim Laden von config.json:", error.message);
  }
}

function saveConfigToFile() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(mqttConfig, null, 2), "utf8");
  } catch (error) {
    console.error("Fehler beim Speichern von config.json:", error.message);
  }
}

function emitStatus(status) {
  mqttStatus = { ...mqttStatus, ...status };
  io.emit("mqtt-status", mqttStatus);
}

function emitStores() {
  io.emit("device-store", deviceStore);
  io.emit("topic-store", topicStore);
}

function resetStores() {
  for (const key of Object.keys(deviceStore)) {
    delete deviceStore[key];
  }

  for (const key of Object.keys(topicStore)) {
    delete topicStore[key];
  }

  emitStores();
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

function registerEntityTopics(entity, deviceId) {
  if (entity.type === "light") {
    if (entity.stateTopic) {
      topicStore[entity.stateTopic] = {
        topicType: "state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }

    if (entity.commandTopic) {
      topicStore[entity.commandTopic] = {
        topicType: "command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }

    return;
  }

  if (entity.type === "climate") {
    if (entity.modeStateTopic) {
      topicStore[entity.modeStateTopic] = {
        topicType: "climate-mode-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }

    if (entity.modeCommandTopic) {
      topicStore[entity.modeCommandTopic] = {
        topicType: "climate-mode-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }

    if (entity.temperatureStateTopic) {
      topicStore[entity.temperatureStateTopic] = {
        topicType: "climate-target-temperature-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }

    if (entity.temperatureCommandTopic) {
      topicStore[entity.temperatureCommandTopic] = {
        topicType: "climate-target-temperature-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }

    if (entity.currentTemperatureTopic) {
      topicStore[entity.currentTemperatureTopic] = {
        topicType: "climate-current-temperature-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }
  }

  if (entity.type === "cover") {
    if (entity.stateTopic) {
      topicStore[entity.stateTopic] = {
        topicType: "cover-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }

    if (entity.positionTopic) {
      topicStore[entity.positionTopic] = {
        topicType: "cover-position",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }

    if (entity.commandTopic) {
      topicStore[entity.commandTopic] = {
        topicType: "cover-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }
  }

  if (entity.type === "lock") {
    if (entity.stateTopic) {
      topicStore[entity.stateTopic] = {
        topicType: "lock-state",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }

    if (entity.commandTopic) {
      topicStore[entity.commandTopic] = {
        topicType: "lock-command",
        deviceId,
        entityId: entity.id,
        entityType: entity.type,
      };
    }
  }

if (entity.type === "humidifier") {
  if (entity.stateTopic) {
    topicStore[entity.stateTopic] = {
      topicType: "humidifier-state",
      deviceId,
      entityId: entity.id,
      entityType: entity.type,
    };
  }

  if (entity.targetHumidityStateTopic) {
    topicStore[entity.targetHumidityStateTopic] = {
      topicType: "humidifier-target-humidity-state",
      deviceId,
      entityId: entity.id,
      entityType: entity.type,
    };
  }

  if (entity.currentHumidityTopic) {
    topicStore[entity.currentHumidityTopic] = {
      topicType: "humidifier-current-humidity",
      deviceId,
      entityId: entity.id,
      entityType: entity.type,
    };
  }

  if (entity.commandTopic) {
    topicStore[entity.commandTopic] = {
      topicType: "humidifier-command",
      deviceId,
      entityId: entity.id,
      entityType: entity.type,
    };
  }

  if (entity.targetHumidityCommandTopic) {
    topicStore[entity.targetHumidityCommandTopic] = {
      topicType: "humidifier-target-humidity-command",
      deviceId,
      entityId: entity.id,
      entityType: entity.type,
    };
  }
}

if (entity.type === "lawn_mower") {
  if (entity.activityStateTopic) {
    topicStore[entity.activityStateTopic] = {
      topicType: "lawn-mower-activity-state",
      deviceId,
      entityId: entity.id,
      entityType: entity.type,
    };
  }

  if (entity.startMowingCommandTopic) {
    topicStore[entity.startMowingCommandTopic] = {
      topicType: "lawn-mower-start-command",
      deviceId,
      entityId: entity.id,
      entityType: entity.type,
    };
  }

  if (entity.pauseCommandTopic) {
    topicStore[entity.pauseCommandTopic] = {
      topicType: "lawn-mower-pause-command",
      deviceId,
      entityId: entity.id,
      entityType: entity.type,
    };
  }

  if (entity.dockCommandTopic) {
    topicStore[entity.dockCommandTopic] = {
      topicType: "lawn-mower-dock-command",
      deviceId,
      entityId: entity.id,
      entityType: entity.type,
    };
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
    viaDevice.startsWith(prefix.toLowerCase())
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
    entityType !== "lawn_mower"
  ) {
    return { handled: false, reason: "unsupported-entity-type" };
  }

  const isEntityTypeAllowed = (mqttConfig.enabledEntityTypes || []).includes(entityType);

  if (!isEntityTypeAllowed) {
    return { handled: false, reason: "entity-type-filtered" };
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
  }

  if (!entity) {
    return { handled: false, reason: "entity-not-created" };
  }

  device.entities[entity.id] = entity;
  device.updatedAt = new Date().toISOString();

  registerEntityTopics(entity, deviceId);
  emitStores();

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

function handleKnownTopicMessage(topic, message) {
  const mapping = topicStore[topic];

  if (!mapping) {
    return { handled: false, reason: "topic-not-registered" };
  }

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
    entity.lastUpdate = new Date().toISOString();
    device.updatedAt = new Date().toISOString();

    emitStores();

    io.emit("entity-update", {
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
      entity,
    });

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

    entity.lastUpdate = new Date().toISOString();
    device.updatedAt = new Date().toISOString();

    emitStores();

    io.emit("entity-update", {
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
      entity,
    });

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

    entity.lastUpdate = new Date().toISOString();
    device.updatedAt = new Date().toISOString();

    emitStores();

    io.emit("entity-update", {
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
      entity,
    });

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
    entity.lastUpdate = new Date().toISOString();
    device.updatedAt = new Date().toISOString();

    emitStores();

    io.emit("entity-update", {
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
      entity,
    });

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

    entity.lastUpdate = new Date().toISOString();
    device.updatedAt = new Date().toISOString();

    emitStores();

    io.emit("entity-update", {
      deviceId: mapping.deviceId,
      entityId: mapping.entityId,
      entity,
    });

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
  entity.lastUpdate = new Date().toISOString();
  device.updatedAt = new Date().toISOString();

  emitStores();

  io.emit("entity-update", {
    deviceId: mapping.deviceId,
    entityId: mapping.entityId,
    entity,
  });

  return {
    handled: true,
    type: "lawn-mower-update",
    deviceId: mapping.deviceId,
    entityId: mapping.entityId,
  };
}

  return { handled: false, reason: "unsupported-entity-runtime-type" };
}

function disconnectMqtt() {
  if (!mqttClient) {
    emitStatus({
      connected: false,
      message: "Nicht verbunden",
    });
    return;
  }

  try {
    mqttClient.end(true);
    mqttClient = null;

    emitStatus({
      connected: false,
      host: mqttConfig.host,
      port: mqttConfig.port,
      topic: mqttConfig.topic,
      message: "Manuell getrennt",
    });

    console.log("MQTT manuell getrennt");
  } catch (err) {
    console.error("Fehler beim Trennen:", err.message);

    emitStatus({
      connected: false,
      host: mqttConfig.host,
      port: mqttConfig.port,
      topic: mqttConfig.topic,
      message: `Fehler beim Trennen: ${err.message}`,
    });
  }
}

function connectMqtt() {
  console.log("connectMqtt wurde aufgerufen");

  if (mqttClient) {
    try {
      mqttClient.end(true);
      mqttClient = null;
    } catch (err) {
      console.error(
        "Fehler beim Beenden der alten MQTT-Verbindung:",
        err.message,
      );
    }
  }

  resetStores();

  const { host, port, topic, username, password } = mqttConfig;
  const clientId = isDev
    ? `${mqttConfig.clientId}_dev_${process.pid}`
    : `${mqttConfig.clientId}_prod_${process.pid}`

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
    reconnectPeriod: 3000,
  });

  mqttClient.on("connect", () => {
    console.log("Mit MQTT verbunden");

      mqttClient.subscribe(topic, (err) => {
      if (err) {
        console.error("Subscribe-Fehler:", err.message);

        emitStatus({
          connected: false,
          host,
          port,
          topic,
          message: `Subscribe-Fehler: ${err.message}`,
        });
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
    });
  });

  mqttClient.on("message", (topic, message, packet) => {
    const discoveryResult = handleDiscoveryMessage(topic, message);

    if (discoveryResult.handled) {
      console.log("Discovery erkannt:", discoveryResult);
    }

    const stateResult = handleKnownTopicMessage(topic, message);

    if (stateResult.handled) {
      console.log("State aktualisiert:", stateResult);
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
  });
}

function getDevicesForDashboard() {
  return Object.values(deviceStore).map((device) => {
    const entities = Object.values(device.entities || {}).map((entity) => ({
      id: entity.id,
      type: entity.type,
      name: entity.name,
      value: entity.value,
      rawState: entity.rawState,
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
      state: entity.state,

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
    };
  });
}

app.get("/api/config", (req, res) => {
  res.json({
    webPort: mqttConfig.webPort,
    host: mqttConfig.host,
    port: mqttConfig.port,
    topic: mqttConfig.topic,
    username: mqttConfig.username,
    password: mqttConfig.password,
    clientId: mqttConfig.clientId,
    discoveryViaPrefixes: mqttConfig.discoveryViaPrefixes || ["lorawan"],
    enabledEntityTypes: mqttConfig.enabledEntityTypes || [
      "light",
      "climate",
      "cover",
      "lock",
      "humidifier",
      "lawn_mower",
    ],
  });
});

app.post("/api/config", (req, res) => {
  const {
  webPort,
  host,
  port,
  topic,
  username,
  password,
  clientId,
  discoveryViaPrefixes,
  enabledEntityTypes
} = req.body;

  if (!host || !port || !topic) {
    return res.status(400).json({
      error: "host, port und topic sind erforderlich",
    });
  }

  mqttConfig = {
    webPort: Number(webPort) || mqttConfig.webPort || 3000,
    host: String(host).trim(),
    port: Number(port),
    topic: String(topic).trim(),
    username: String(username || "").trim(),
    password: String(password || ""),
    clientId: String(clientId || "").trim(),
    discoveryViaPrefixes: Array.isArray(discoveryViaPrefixes) && discoveryViaPrefixes.length
      ? discoveryViaPrefixes.map(v => String(v).trim()).filter(v => v !== "")
      : ["lorawan"],
    enabledEntityTypes: Array.isArray(enabledEntityTypes)
      ? enabledEntityTypes.map(v => String(v).trim()).filter(v => v !== "")
      : (Array.isArray(mqttConfig.enabledEntityTypes)
          ? mqttConfig.enabledEntityTypes
          : ["light", "climate", "cover", "lock", "humidifier", "lawn_mower"]),
  };

  allowedDiscoveryViaDevicePrefixes = [...mqttConfig.discoveryViaPrefixes];

  saveConfigToFile();
  connectMqtt();

  res.json({
    success: true,
    config: mqttConfig,
  });
});

app.post("/api/disconnect", (req, res) => {
  disconnectMqtt();
  res.json({ success: true });
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

app.get("/api/device-store", (req, res) => {
  res.json(deviceStore);
});

app.get("/api/topic-store", (req, res) => {
  res.json(topicStore);
});

app.get("/api/devices", (req, res) => {
  res.json(getDevicesForDashboard());
});

io.on("connection", (socket) => {
  console.log("Browser verbunden:", socket.id);
  socket.emit("mqtt-status", mqttStatus);
  socket.emit("device-store", deviceStore);
  socket.emit("topic-store", topicStore);
});

const WEB_PORT = Number(mqttConfig.webPort || DEFAULT_WEB_PORT);

server.listen(WEB_PORT, "0.0.0.0", () => {
  console.log(`Webserver läuft auf http://0.0.0.0:${WEB_PORT}`);

  // automatische Verbindung beim Start
  connectMqtt();
});