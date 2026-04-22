const { deviceStore, topicStore } = require('./stores');

function isDiscoveryTopic(topic) {
  return typeof topic === 'string' && topic.endsWith('/config');
}

function getEntityTypeFromDiscoveryTopic(topic) {
  const parts = topic.split('/');
  // erwartet z. B. homeassistant/light/bettbeleuchtung/lorawan_1_beleuchtung/config
  return parts[1] || 'unknown';
}

function parseJsonMessage(message) {
  try {
    return JSON.parse(message.toString());
  } catch (error) {
    return null;
  }
}

function getDeviceId(payload, topic) {
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
      viaDevice: payload?.device?.via_device || '',
      swVersion: payload?.device?.sw_version || '',
      entities: {}
    };
  } else {
    // bestehende Device-Metadaten vorsichtig ergänzen
    if (!deviceStore[deviceId].name && payload?.device?.name) {
      deviceStore[deviceId].name = payload.device.name;
    }

    if (!deviceStore[deviceId].viaDevice && payload?.device?.via_device) {
      deviceStore[deviceId].viaDevice = payload.device.via_device;
    }

    if (!deviceStore[deviceId].swVersion && payload?.device?.sw_version) {
      deviceStore[deviceId].swVersion = payload.device.sw_version;
    }
  }

  return deviceStore[deviceId];
}

function createLightEntity(topic, payload, deviceId) {
  const entityId = payload.unique_id || topic;

  return {
    id: entityId,
    type: 'light',
    name: payload.name || entityId,
    uniqueId: payload.unique_id || entityId,
    discoveryTopic: topic,
    stateTopic: payload.state_topic || '',
    commandTopic: payload.command_topic || '',
    schema: payload.schema || 'default',
    payloadOn: payload.payload_on ?? 'ON',
    payloadOff: payload.payload_off ?? 'OFF',
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
    deviceId
  };
}

function registerEntityTopics(entity, deviceId) {
  if (entity.stateTopic) {
    topicStore[entity.stateTopic] = {
      topicType: 'state',
      deviceId,
      entityId: entity.id,
      entityType: entity.type
    };
  }

  if (entity.commandTopic) {
    topicStore[entity.commandTopic] = {
      topicType: 'command',
      deviceId,
      entityId: entity.id,
      entityType: entity.type
    };
  }
}

function handleLightDiscovery(topic, message) {
  if (!isDiscoveryTopic(topic)) {
    return { handled: false, reason: 'not-discovery-topic' };
  }

  const entityType = getEntityTypeFromDiscoveryTopic(topic);
  if (entityType !== 'light') {
    return { handled: false, reason: 'unsupported-entity-type' };
  }

  const payload = parseJsonMessage(message);
  if (!payload) {
    return { handled: false, reason: 'invalid-json' };
  }

  const deviceId = getDeviceId(payload, topic);
  const device = ensureDeviceExists(deviceId, payload);

  const entity = createLightEntity(topic, payload, deviceId);
  device.entities[entity.id] = entity;

  registerEntityTopics(entity, deviceId);

  return {
    handled: true,
    type: 'light-discovery',
    deviceId,
    entityId: entity.id
  };
}

module.exports = {
  isDiscoveryTopic,
  getEntityTypeFromDiscoveryTopic,
  handleLightDiscovery
};