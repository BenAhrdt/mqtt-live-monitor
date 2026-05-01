const { deviceStore, topicStore } = require('./stores');

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
    return { handled: false, reason: 'topic-not-registered' };
  }

  if (mapping.topicType !== 'state') {
    return { handled: false, reason: 'not-a-state-topic' };
  }

  const device = deviceStore[mapping.deviceId];
  if (!device) {
    return { handled: false, reason: 'device-not-found' };
  }

  const entity = device.entities[mapping.entityId];
  if (!entity) {
    return { handled: false, reason: 'entity-not-found' };
  }

  const payloadText = message.toString();
  const parsed = parseMaybeJson(payloadText);

  entity.rawState = parsed;
  entity.lastUpdate = Date.now();

  // Für light erstmal einfach den kompletten State übernehmen
  entity.value = parsed;

  return {
    handled: true,
    type: 'state-update',
    deviceId: mapping.deviceId,
    entityId: mapping.entityId
  };
}

module.exports = {
  handleKnownTopicMessage
};