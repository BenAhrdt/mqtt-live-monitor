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

let mqttConfig = {
  host: "192.168.2.212",
  port: 1883,
  topic: "#",
  username: "",
  password: "",
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

  mqttClient.on("message", (topic, message) => {
    io.emit("mqtt-message", {
      topic,
      payload: message.toString(),
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

io.on("connection", (socket) => {
  console.log("Browser verbunden:", socket.id);
  socket.emit("mqtt-status", mqttStatus);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Webserver läuft auf http://0.0.0.0:${PORT}`);
});
