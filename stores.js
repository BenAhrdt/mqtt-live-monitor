const deviceStore = {};
const topicStore = {};

function getDeviceStore() {
  return deviceStore;
}

function getTopicStore() {
  return topicStore;
}

function resetStores() {
  for (const key of Object.keys(deviceStore)) {
    delete deviceStore[key];
  }

  for (const key of Object.keys(topicStore)) {
    delete topicStore[key];
  }
}

module.exports = {
  deviceStore,
  topicStore,
  getDeviceStore,
  getTopicStore,
  resetStores
};