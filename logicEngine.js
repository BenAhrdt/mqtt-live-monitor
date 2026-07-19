let logics = [];

let getEntity = null;
function setEntityGetter(fn) {
  getEntity = fn;
}

let mqttPublish = null;
function setMqttPublisher(fn) {
  mqttPublish = fn;
}

let writeComputedEntity = null;
function setComputedEntityWriter(fn) {
  writeComputedEntity = fn;
}


function setLogics(data) {

  if (!data) {
    logics = [];
    return;
  }

  // 🔥 Wenn einzelne Logik → in Array packen
  if (!Array.isArray(data)) {
    logics = [data];
  } else {
    logics = data;
  }

}

function runLogicEngine(changedEntityId) {

  logics.forEach(logic => {

    // 🔥 check ob Entity in dieser Logik vorkommt
    const isRelevant = logic.nodes.some(n =>
      n.type === 'entity_input' && n.entityId === changedEntityId
    );

    if (!isRelevant) return;

    runSingleLogic(logic);
  });

}

function runSingleLogic(logic) {

  const nodeMap = {};
  const values = {};

  // 🔹 Nodes indexieren
  logic.nodes.forEach(n => {
    nodeMap[n.id] = n;
  });

  // 🔹 Inputs holen
  logic.nodes.forEach(n => {
    if (n.type === 'entity_input') {

      const val = getEntityValue(n.entityId);

      values[n.id] = val;

    }
  });

  // 🔹 Operator berechnen
  logic.nodes.forEach(n => {

  if (n.type !== 'operator') return;

  const inputs = logic.connections
    .filter(c => c.to === n.id)
    .map(c => values[c.from]);

  if (inputs.length < 2) return;

  const op = n.operation || '+';

  let result = 0;

  const A = Number(inputs[0]) || 0;
  const B = Number(inputs[1]) || 0;

  switch (op) {

    case '+':
      result = A + B;
      break;

    case '-':
      result = A - B;
      break;

    case '*':
      result = A * B;
      break;

    case '/':
      result = B !== 0 ? A / B : 0;
      break;

    default:
      result = A + B;
  }

  values[n.id] = result;

});

  // 🔹 Output
  logic.nodes.forEach(n => {

    if (n.type !== 'entity_output') return;

    const inputConn = logic.connections.find(c => c.to === n.id);

    if (!inputConn) return;

    const result = values[inputConn.from];

    applyEntityValueFromLogic(n.entityId,result);
  });
}

function getEntityValue(entityId) {

  const entity = getEntity(entityId);

  if (!entity) return 0;

  return Number(entity.value) || 0;
}










/**************************************************************************
 *  Schreiblogik
 * ********************************************************************* */

async function applyEntityValueFromLogic(entityId, value) {

  const entity = getEntity(entityId);

  if (!entity) {
    console.warn('Logic write: Entity nicht gefunden', entityId);
    return;
  }

  if (entity.isCalculated) {
    if (typeof writeComputedEntity !== 'function') {
      console.warn('Logic write: Writer für berechnete Entity fehlt', entityId);
      return;
    }

    writeComputedEntity(entityId, Number(value));
    return;
  }

  if (entity.type !== 'number') {
    console.log('LOGIC: skip (noch nicht unterstützt)', entity.type);
    return;
  }

  if (!entity.commandTopic) {
    console.warn('Logic write: kein commandTopic', entityId);
    return;
  }

  try {
    mqttPublish(entity.commandTopic, Number(value));
  } catch (err) {
    console.error('Logic write Fehler:', err);
  }
}






















module.exports = {
  setLogics,
  runLogicEngine,
  applyEntityValueFromLogic,
  setEntityGetter,
  setMqttPublisher,
  setComputedEntityWriter
};
