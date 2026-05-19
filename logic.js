let logicStore = [];
const values = {};
const units = {};

const fs = require('fs');
const path = require('path');

const LOGIC_FILE = path.join(__dirname, 'data', 'logics.json');

function setLogicStore(newStore) {
    logicStore = newStore || [];
    saveLogicStore();
}

function getLogicStore() {
    return logicStore;
}

function loadLogicStore() {
    try {
        const raw = fs.readFileSync(LOGIC_FILE, 'utf-8');
        const parsed = JSON.parse(raw);

        // 🔥 HIER IST DER FIX
        logicStore = Array.isArray(parsed)
            ? parsed
            : parsed.logics || [];

        console.log("📂 Logiken geladen:", logicStore.length);

    } catch (err) {
        console.warn("⚠️ Keine Logiken gefunden, starte leer");
        logicStore = [];
    }
}

function saveLogicStore() {
    fs.writeFileSync(LOGIC_FILE, JSON.stringify(logicStore, null, 2));
    console.log("💾 Logiken gespeichert");
}

// Entitätswert aus dem combinedStore holen
function getEntityData(entityId, combinedStore) {

    for (const device of Object.values(combinedStore)) {
        const entity = device.entities?.[entityId];

        if (entity) {
            const value = Number(entity.value);

            return {
                value: isNaN(value) ? 0 : value,
                unit: entity.unit || ''
            };
        }
    }

    return { value: 0, unit: '' };
}

// Logik Entität updaten
function updateLogicalEntity(entityId, value, unit, combinedStore, io) {

  for (const device of Object.values(combinedStore)) {

    if (!device.isLogical) continue;

    const entity = device.entities?.[entityId];
    if (!entity) continue;

    //console.log("Update Logical Entity:", entityId, value, unit);

    entity.value = value;
    entity.rawState = value;
    entity.unit = unit;
    entity.lastUpdate = new Date().toISOString();

    io.emit("entity-update", {
      deviceId: device.id,
      entityId: entityId,
      entity,
    });

    return;
  }

  console.warn("Logical Entity nicht gefunden:", entityId);
}

function handleLogicUpdate(triggerEntityId, combinedStore, io) {

    logicStore.forEach(logic => {

        if (!logic.targetEntityId) return;

        const usesEntity = Object.values(logic.operands)
            .includes(triggerEntityId);

        if (!usesEntity) return;

        const values = {};

        Object.entries(logic.operands).forEach(([key, entityId]) => {
            const data = getEntityData(entityId, combinedStore);
            values[key] = data.value;
            units[key] = data.unit;
        });
        
        const result = evaluateLogic(logic, values);

        const unit = resolveUnit(logic, units);
        updateLogicalEntity(logic.targetEntityId, result, unit, combinedStore, io);
    });
}

function resolveUnit(logic, units) {

    const A = units.A;
    const B = units.B;

    switch (logic.operation) {

        case 'add':
        case 'sub':
            if (A === B) return A;
            return A || B;

        case 'mul':
            return `${A || ''}*${B || ''}`;

        case 'div':
            return `${A || ''}/${B || ''}`;

        default:
            return A || B;
    }
}

function evaluateLogic(logic, values) {

    const A = Number(values.A) || 0;
    const B = Number(values.B) || 0;

    switch (logic.operation) {
        case "add": return A + B;
        case "sub": return A - B;
        case "mul": return A * B;
        case "div": return B !== 0 ? A / B : 0;
        default: return 0;
    }
}

module.exports = {
    handleLogicUpdate,
    setLogicStore,
    getLogicStore,
    loadLogicStore
};