const express = require("express");
const path = require("path");
const http = require("http");
const mqtt = require("mqtt");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
  host: "192.168.2.243",
  port: 1883,
  topic: "#",
  username: "mqttuser",
  password: "MQTTpass1",
  clientId: "LiveMonitor",
};

let mqttStatus = {
  connected: false,
  host: mqttConfig.host,
  port: mqttConfig.port,
  topic: mqttConfig.topic,
  message: "Nicht verbunden",
};

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
  // Beispiel:
  // homeassistant/light/bettbeleuchtung/lorawan_1_beleuchtung/config
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

function registerEntityTopics(entity, deviceId) {
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
}

function handleLightDiscovery(topic, message) {
  if (!isDiscoveryTopic(topic)) {
    return { handled: false, reason: "not-discovery-topic" };
  }

  const entityType = getEntityTypeFromDiscoveryTopic(topic);

  if (entityType !== "light") {
    return { handled: false, reason: "unsupported-entity-type" };
  }

  const payload = parseJsonMessage(message);

  if (!payload) {
    return { handled: false, reason: "invalid-json" };
  }

  const deviceId = getDeviceIdFromDiscovery(payload, topic);
  const device = ensureDeviceExists(deviceId, payload);

  const entity = createLightEntity(topic, payload, deviceId);

  device.entities[entity.id] = entity;
  device.updatedAt = new Date().toISOString();

  registerEntityTopics(entity, deviceId);
  emitStores();

  return {
    handled: true,
    type: "light-discovery",
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

  if (mapping.topicType !== "state") {
    return { handled: false, reason: "not-a-state-topic" };
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

  const { host, port, topic, username, password, clientId } = mqttConfig;
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
    clientId: clientId || undefined,
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
    // 1. Discovery für Light-Entitäten
    const discoveryResult = handleLightDiscovery(topic, message);

    if (discoveryResult.handled) {
      console.log("Discovery erkannt:", discoveryResult);
    }

    // 2. Falls Topic bereits bekannt ist, State zuordnen
    const stateResult = handleKnownTopicMessage(topic, message);

    if (stateResult.handled) {
      console.log("State aktualisiert:", stateResult);
    }

    // 3. Live-Nachrichten wie bisher ans Frontend senden
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
    host: mqttConfig.host,
    port: mqttConfig.port,
    topic: mqttConfig.topic,
    username: mqttConfig.username,
    password: mqttConfig.password,
    clientId: mqttConfig.clientId,
  });
});

app.post("/api/config", (req, res) => {
  const { host, port, topic, username, password, clientId } = req.body;

  if (!host || !port || !topic) {
    return res.status(400).json({
      error: "host, port und topic sind erforderlich",
    });
  }

  mqttConfig = {
    host: String(host).trim(),
    port: Number(port),
    topic: String(topic).trim(),
    username: String(username || "").trim(),
    password: String(password || ""),
    clientId: String(clientId || "").trim(),
  };

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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Webserver läuft auf http://0.0.0.0:${PORT}`);
});