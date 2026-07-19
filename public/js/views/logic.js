let connectionStart = null;
let connections = [];
let logicSaveQueue = Promise.resolve();

function setLogicSaveStatus(text, state = '') {
  const status = document.getElementById('logicSaveStatus');
  if (!status) return;

  status.textContent = text;
  status.dataset.state = state;
}

function persistLogic() {
  const data = exportLogic();

  logicSaveQueue = logicSaveQueue
    .catch(() => {})
    .then(async () => {
      setLogicSaveStatus('Speichert…', 'saving');

      try {
        const response = await fetch('/api/logics', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(data)
        });

        if (!response.ok) {
          throw new Error('Logik konnte nicht gespeichert werden');
        }

        setLogicSaveStatus('✓ Automatisch gespeichert', 'saved');
      } catch (error) {
        setLogicSaveStatus('Speichern fehlgeschlagen', 'error');
        throw error;
      }
    });

  return logicSaveQueue;
}

function resetNodeState() {
  document.querySelectorAll('.logic-node').forEach(node => {
    node._inputs = [];
    node._value = undefined;
  });
}

function getInputValue(node) {
  const select = node.querySelector('.entity-select');
  if (!select) return 0;

  const entityId = select.value;

  const entity = getNumericEntities().find(e => e.id === entityId);

  return entity ? Number(entity.value) : 0;
}

function getEntityById(entityId) {
  return getNumericEntities().find(e => e.id === entityId);
}

function updateLiveValues() {
  document.querySelectorAll('.logic-node').forEach(node => {

    if (node.dataset.type !== 'entity_input') return;

    const select = node.querySelector('.entity-select');
    const display = node.querySelector('.node-live-value');

    if (!select || !display) return;

    const entity = getEntityById(select.value);

    if (!entity) {
      display.textContent = '-';
      return;
    }

    display.textContent = `${entity.value} ${entity.unit || ''}`;
  });
}

function calculateOperator(node) {
  const inputs = node._inputs || [];

  const op = node.querySelector('.operator-select')?.value;

  if (inputs.length < 2) return 0;

  const A = inputs[0];
  const B = inputs[1];

  switch (op) {
    case '+': return A + B;
    case '-': return A - B;
    case '*': return A * B;
    case '/': return B !== 0 ? A / B : 0;
    default: return 0;
  }
}

function calculateFlow() {

  resetNodeState();

  // 🔹 1. Inputs setzen
  document.querySelectorAll('.logic-node').forEach(node => {

    if (node.dataset.type === 'entity_input') {
      node._value = getInputValue(node);
    }

  });

  // 🔹 2. Verbindungen durchlaufen (Input → Operator)
  connections.forEach(conn => {

    const from = conn.fromNode;
    const to = conn.toNode;

    if (from._value === undefined) return;

    if (!to._inputs) to._inputs = [];

    to._inputs.push(from._value);
  });

  // 🔹 3. Operator berechnen
  document.querySelectorAll('.logic-node').forEach(node => {

    if (node.dataset.type === 'operator') {
      node._value = calculateOperator(node);
    }

  });

  // 🔹 4. Operator → Output
  connections.forEach(conn => {

    const from = conn.fromNode;
    const to = conn.toNode;

    if (from._value === undefined) return;

    if (to.dataset.type === 'entity_output') {
      const el = to.querySelector('.node-result');

      const value = from._value;
      const select = to.querySelector('.entity-select');
      const entityId = select?.value;
      const entity = findAvailableLogicEntity(entityId);
      const unit = entity?.unit || '';

      if (el) {
        el.textContent = `${Number(value).toFixed(2)}${unit ? ` ${unit}` : ''}`;
      }
    }

  });

}

function getNumericEntities() {
  const list = [];

  availableDevices.forEach(device => {

    (device.entities || []).forEach(entity => {

      const deviceName = device.name || device.id;
      const baseName = entity.name || entity.id;

      // 🔹 SENSOR / NUMBER (einfach)
      if (['sensor', 'number'].includes(entity.type)) {
        const value = Number(entity.value);

        if (!isNaN(value)) {
          list.push({
            id: entity.id,
            name: baseName,
            device: deviceName,
            value,
            unit: entity.unit || '',
            source: 'value'
          });
        }
      }

      // 🔹 CLIMATE
      if (entity.type === 'climate') {
        if (entity.currentTemperature != null) {
          list.push({
            id: entity.id + '_currentTemp',
            name: baseName + ' (Ist)',
            device: deviceName,
            value: Number(entity.currentTemperature),
            unit: '°C',
            source: 'currentTemperature'
          });
        }

        if (entity.targetTemperature != null) {
          list.push({
            id: entity.id + '_targetTemp',
            name: baseName + ' (Soll)',
            device: deviceName,
            value: Number(entity.targetTemperature),
            unit: '°C',
            source: 'targetTemperature'
          });
        }
      }

      // 🔹 LIGHT (Helligkeit)
      if (entity.type === 'light') {
        if (entity.rawState?.brightness != null) {
          list.push({
            id: entity.id + '_brightness',
            name: baseName + ' (Helligkeit)',
            device: deviceName,
            value: Number(entity.rawState.brightness),
            unit: '',
            source: 'brightness'
          });
        }
      }

      // 🔹 COVER (Position)
      if (entity.type === 'cover') {
        if (entity.position != null) {
          list.push({
            id: entity.id + '_position',
            name: baseName + ' (Position)',
            device: deviceName,
            value: Number(entity.position),
            unit: '%',
            source: 'position'
          });
        }
      }

      // 🔹 HUMIDIFIER
      if (entity.type === 'humidifier') {
        if (entity.currentHumidity != null) {
          list.push({
            id: entity.id + '_currentHumidity',
            name: baseName + ' (Ist)',
            device: deviceName,
            value: Number(entity.currentHumidity),
            unit: '%',
            source: 'currentHumidity'
          });
        }

        if (entity.targetHumidity != null) {
          list.push({
            id: entity.id + '_targetHumidity',
            name: baseName + ' (Soll)',
            device: deviceName,
            value: Number(entity.targetHumidity),
            unit: '%',
            source: 'targetHumidity'
          });
        }
      }

    });

  });

  return list.sort((a, b) => {
    const nameA = `${a.device} ${a.name}`.toLowerCase();
    const nameB = `${b.device} ${b.name}`.toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

function getWritableEntities() {
  const list = [];

  (availableDevices || []).forEach(device => {

    (device.entities || []).forEach(entity => {

      const deviceName = device.name || device.id;
      const baseName = entity.name || entity.id;

      // 🔹 NUMBER
      if (entity.type === 'number' || entity.isCalculated) {
        list.push({
          id: entity.id,
          name: baseName,
          device: deviceName,
          unit: entity.unit || '',
          action: entity.isCalculated ? 'calculated' : 'setValue'
        });
      }

      // 🔹 LIGHT → brightness
      if (entity.type === 'light') {
        if (entity.rawState?.brightness != null) {
          list.push({
            id: entity.id + '_brightness',
            name: baseName + ' (Helligkeit)',
            device: deviceName,
            unit: '',
            action: 'brightness'
          });
        }
      }

      // 🔹 CLIMATE → target
      if (entity.type === 'climate') {
        if (entity.targetTemperature != null) {
          list.push({
            id: entity.id + '_targetTemp',
            name: baseName + ' (Soll)',
            device: deviceName,
            unit: '°C',
            action: 'targetTemperature'
          });
        }
      }

      // 🔹 COVER → position
      if (entity.type === 'cover') {
        if (entity.position != null) {
          list.push({
            id: entity.id + '_position',
            name: baseName + ' (Position)',
            device: deviceName,
            unit: '%',
            action: 'position'
          });
        }
      }

      // 🔹 HUMIDIFIER
      if (entity.type === 'humidifier') {
        if (entity.targetHumidity != null) {
          list.push({
            id: entity.id + '_targetHumidity',
            name: baseName + ' (Soll)',
            device: deviceName,
            unit: '%',
            action: 'targetHumidity'
          });
        }
      }

    });

  });

return list.sort((a, b) => {
  const nameA = `${a.device} ${a.name}`.toLowerCase();
  const nameB = `${b.device} ${b.name}`.toLowerCase();
  return nameA.localeCompare(nameB);
});
}

export function updateLogicView() {
  updateLiveValues();
  calculateFlow();
  updateCalculatedEntityEditButtons();
}

let availableDevices = [];

function escapeLogicHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function openCalculatedEntityDialog(options = {}) {
  return new Promise(resolve => {
    const isEditing = Boolean(options.entity);
    const entity = options.entity || {};
    const overlay = document.createElement('div');
    overlay.className = 'logic-dialog-backdrop';
    overlay.innerHTML = `
      <form class="logic-dialog">
        <h3>${isEditing ? 'Berechnete Entity bearbeiten' : 'Berechnete Entity anlegen'}</h3>
        <label>
          Name
          <input name="name" maxlength="120" required placeholder="z. B. PV Gesamt"
                 value="${escapeLogicHtml(entity.name || '')}">
        </label>
        <label>
          Einheit
          <input name="unit" maxlength="24" placeholder="z. B. W, kWh oder %"
                 value="${escapeLogicHtml(entity.unit || '')}">
        </label>
        <p class="logic-dialog-hint">
          Die Entity erscheint unter dem Gerät „Berechnete Werte“ und kann
          anschließend einem Dashboard sowie der History hinzugefügt werden.
        </p>
        <div class="logic-dialog-actions">
          <button type="button" class="btn secondary logic-dialog-cancel">Abbrechen</button>
          <button type="submit" class="btn primary">${isEditing ? 'Speichern' : 'Anlegen'}</button>
        </div>
      </form>
    `;

    const close = result => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('.logic-dialog-cancel')
      ?.addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) close(null);
    });
    overlay.querySelector('form')?.addEventListener('submit', event => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const name = String(formData.get('name') || '').trim();
      if (!name) return;
      close({
        name,
        unit: String(formData.get('unit') || '').trim()
      });
    });

    document.body.appendChild(overlay);
    overlay.querySelector('input[name="name"]')?.focus();
  });
}

function upsertAvailableLogicDevice(device) {
  const index = availableDevices.findIndex(item => item.id === device.id);
  if (index >= 0) {
    availableDevices[index] = device;
  } else {
    availableDevices.push(device);
  }
}

function findAvailableLogicEntity(entityId) {
  for (const device of availableDevices) {
    const entity = (device.entities || []).find(item => item.id === entityId);
    if (entity) return entity;
  }
  return null;
}

function updateCalculatedEntityEditButtons() {
  document.querySelectorAll('.logic-node[data-type="entity_output"]').forEach(node => {
    const entityId = node.querySelector('.entity-select')?.value;
    const entity = findAvailableLogicEntity(entityId);
    node.querySelector('.logic-edit-entity')
      ?.classList.toggle('hidden', !entity?.isCalculated);
  });
}

function renderLogicEntityOptions(entities, includeValue = false) {
  return entities.map(entity => `
    <option value="${escapeLogicHtml(entity.id)}">
      ${escapeLogicHtml(entity.device)} → ${escapeLogicHtml(entity.name)}
      ${includeValue ? `(${escapeLogicHtml(entity.value)} ${escapeLogicHtml(entity.unit)})` : ''}
    </option>
  `).join('');
}

function refreshLogicEntitySelects() {
  document.querySelectorAll('.logic-node').forEach(node => {
    const select = node.querySelector('.entity-select');
    if (!select) return;
    const currentValue = select.value;
    const isInput = node.dataset.type === 'entity_input';
    const entities = isInput ? getNumericEntities() : getWritableEntities();

    select.innerHTML = `
      <option value="">-- wählen --</option>
      ${renderLogicEntityOptions(entities, isInput)}
    `;
    select.value = currentValue;
  });
  updateCalculatedEntityEditButtons();
}

async function createCalculatedEntityForNode(node) {
  const input = await openCalculatedEntityDialog();
  if (!input) return;

  const response = await fetch('/api/calculated-entities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Berechnete Entity konnte nicht angelegt werden');
  }

  upsertAvailableLogicDevice(data.device);
  refreshLogicEntitySelects();

  const select = node.querySelector('.entity-select');
  if (select) select.value = data.entity.id;
  updateCalculatedEntityEditButtons();
  await persistLogic();
}

async function editCalculatedEntityForNode(node) {
  const select = node.querySelector('.entity-select');
  const entity = findAvailableLogicEntity(select?.value);
  if (!entity?.isCalculated) return;

  const input = await openCalculatedEntityDialog({ entity });
  if (!input) return;

  const response = await fetch(
    `/api/calculated-entities/${encodeURIComponent(entity.id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    }
  );
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Berechnete Entity konnte nicht geändert werden');
  }

  upsertAvailableLogicDevice(data.device);
  refreshLogicEntitySelects();
  if (select) select.value = data.entity.id;
  updateCalculatedEntityEditButtons();
}

export function renderLogicView(container, devices){
  availableDevices = devices || [];
  container.innerHTML = `
    <div class="logic-builder">

      <div class="logic-toolbar">
        <h2>Logik Editor</h2>
      </div>

      <div class="logic-body">

        <!-- 🔹 Toolbox -->
        <div class="logic-toolbox">
            <div class="logic-item" draggable="true" data-type="entity_input">
                📥 Input
            </div>
            <div class="logic-item" draggable="true" data-type="operator">
                ⚙️ Operator
            </div>
            <div class="logic-item" draggable="true" data-type="entity_output">
                📤 Output
            </div>
            <div id="logicSaveStatus" class="logic-save-status" data-state="saved">
                ✓ Automatisches Speichern
            </div>
        </div>

        <!-- 🔹 Canvas -->
        <div id="logicCanvas" class="logic-canvas">
            <svg id="logicConnections" class="logic-connections"></svg>
        </div>

      </div>
    </div>
  `;

  initLogicDragAndDrop();
  
  fetch('/api/logics')
    .then(res => res.json())
    .then(data => {
      importLogic(data);
    });
}

function initLogicDragAndDrop() {
  let draggedType = null;

  document.querySelectorAll('.logic-item').forEach(item => {
    item.addEventListener('dragstart', () => {
      draggedType = item.dataset.type;
    });
  });

  const canvas = document.getElementById('logicCanvas');

  canvas.addEventListener('dragover', e => {
    e.preventDefault();
  });

  canvas.addEventListener('drop', e => {
    e.preventDefault();

    if (!draggedType) return;

    const canvasRect = canvas.getBoundingClientRect();
    const node = createLogicNode(
      draggedType,
      e.clientX - canvasRect.left,
      e.clientY - canvasRect.top
    );
    canvas.appendChild(node);
    draggedType = null;

    persistLogic().catch(error => {
      console.error('Neues Element konnte nicht gespeichert werden:', error);
    });
  });
}


function createLogicNode(type, x, y) {
  const node = document.createElement('div');

  const id = 'node_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  node.dataset.id = id;
  node.dataset.type = type;

  node.className = 'logic-node';

  if (type === 'entity_input') {

    const entities = getNumericEntities();

    const options = renderLogicEntityOptions(entities, true);

    node.innerHTML = `
      <div class="node-label">Eingang</div>

      <select class="entity-select">
        <option value="">-- wählen --</option>
        ${options}
      </select>

      <div class="node-live-value">-</div>

      <div class="node-output"></div>
    `;

    node.querySelector('.entity-select')?.addEventListener('change', () => {
      updateLiveValues();
      calculateFlow();
    });

    setTimeout(updateLiveValues, 0);
  }

    else if (type === 'entity_output') {

      const entities = getWritableEntities();

      const options = renderLogicEntityOptions(entities);

      node.innerHTML = `
        <div class="node-input center"></div>

        <div class="node-label">Ausgang</div>

        <select class="entity-select">
          <option value="">-- wählen --</option>
          ${options}
        </select>

        <div class="logic-entity-actions">
          <button type="button" class="logic-create-entity">
            + Neue Entity
          </button>
          <button type="button" class="logic-edit-entity hidden">
            Bearbeiten
          </button>
        </div>
        
        <div class="node-result">0</div>
      `;
    }

    else if (type === 'operator') {
      node.innerHTML = `
        <div class="node-input top"></div>
        <div class="node-input bottom"></div>

        <div class="node-label">Operator</div>

        <select class="operator-select">
          <option value="+">+</option>
          <option value="-">−</option>
          <option value="*">×</option>
          <option value="/">÷</option>
        </select>

        <div class="node-output"></div>
      `;
    }

    else {
    node.innerHTML = `
        <div class="node-label">${type}</div>
        <div class="node-output"></div>
    `;
    }

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'logic-node-delete';
  deleteButton.title = 'Element löschen';
  deleteButton.setAttribute('aria-label', 'Element löschen');
  deleteButton.textContent = '×';
  node.appendChild(deleteButton);

  deleteButton.addEventListener('click', () => {
    const attachedConnections = connections.filter(connection =>
      connection.fromNode === node || connection.toNode === node
    );
    const connectionText = attachedConnections.length
      ? ` und ${attachedConnections.length} Verbindung(en)`
      : '';

    if (!confirm(`Dieses Element${connectionText} löschen?`)) return;

    attachedConnections.forEach(connection => connection.line.remove());
    connections = connections.filter(connection =>
      connection.fromNode !== node && connection.toNode !== node
    );
    node.remove();
    calculateFlow();
    persistLogic().catch(error => {
      console.error('Element konnte nicht gelöscht werden:', error);
    });
  });

  node.querySelector('.logic-create-entity')?.addEventListener('click', () => {
    createCalculatedEntityForNode(node).catch(error => {
      console.error(error);
      alert(error.message);
    });
  });

  node.querySelector('.logic-edit-entity')?.addEventListener('click', () => {
    editCalculatedEntityForNode(node).catch(error => {
      console.error(error);
      alert(error.message);
    });
  });

  node.style.left = x + 'px';
  node.style.top = y + 'px';
  node.style.position = 'absolute';

    const inputs = node.querySelectorAll('.node-input');

    if(inputs) {
        inputs.forEach(input => {
            input.addEventListener('mousedown', (e) => {
            e.stopPropagation();

            if (!connectionStart) return;

            if (connectionStart.node === node) {
            console.log('❌ gleiche Node verboten');
            return;
            }
            createConnection(connectionStart.port, input, { persist: true });

            connectionStart = null;

            document.body.classList.remove('connecting');
            });
        });
    }
    const output = node.querySelector('.node-output');

    if (output) {
        output.addEventListener('mousedown', (e) => {
            e.stopPropagation();

            connectionStart = {
                node: node,
                port: output
            };
            document.body.classList.add('connecting');
        });
    }

  makeNodeDraggable(node); // falls du das hast

  node.querySelectorAll('select').forEach(select => {
    select.addEventListener('change', () => {
      updateCalculatedEntityEditButtons();
      persistLogic().catch(error => {
        console.error('Logik-Auswahl konnte nicht gespeichert werden:', error);
      });
    });
  });

  return node;
}

function makeNodeDraggable(node) {
  let offsetX = 0;
  let offsetY = 0;
  let isDragging = false;
  let hasMoved = false;

  node.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('select, input, button, .node-input, .node-output')) {
      return;
    }

    const nodeRect = node.getBoundingClientRect();

    isDragging = true;
    hasMoved = false;
    offsetX = e.clientX - nodeRect.left;
    offsetY = e.clientY - nodeRect.top;

    node.style.zIndex = 1000; // nach vorne
    node.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const canvas = document.getElementById('logicCanvas');
    const rect = canvas.getBoundingClientRect();
    const maxX = Math.max(0, canvas.clientWidth - node.offsetWidth);
    const maxY = Math.max(0, canvas.clientHeight - node.offsetHeight);
    const x = Math.min(maxX, Math.max(0, e.clientX - rect.left - offsetX));
    const y = Math.min(maxY, Math.max(0, e.clientY - rect.top - offsetY));

    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
    hasMoved = true;
    connections.forEach(conn => {
        updateLinePosition(conn.line, conn.fromPort, conn.toPort);
        });
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    node.style.zIndex = '';
    node.classList.remove('dragging');

    if (hasMoved) {
      persistLogic().catch(error => {
        console.error('Position konnte nicht gespeichert werden:', error);
      });
    }
  });
}

function createConnection(fromPort, toPort, options = {}) {
  const svg = document.getElementById('logicConnections');

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.classList.add('logic-line');

  updateLinePosition(line, fromPort, toPort);

    svg.appendChild(line);

    // 🔥 Rechtsklick zum Löschen
    line.addEventListener('contextmenu', (e) => {
    e.preventDefault();

    svg.removeChild(line);

    // auch aus array entfernen
    connections = connections.filter(c => c.line !== line);

    persistLogic().catch(error => {
      console.error('Gelöschte Verbindung konnte nicht gespeichert werden:', error);
    });
    });

  connections.push({
    line,
    fromPort,
    toPort,
    fromNode: fromPort.closest('.logic-node'),
    toNode: toPort.closest('.logic-node'),

    fromIndex: getPortIndex(fromPort),
    toIndex: getPortIndex(toPort)
  });

  if (options.persist) {
    persistLogic().catch(error => {
      console.error('Verbindung konnte nicht gespeichert werden:', error);
    });
  }
}

function getPortIndex(port) {
  const parent = port.parentElement;
  const ports = Array.from(parent.querySelectorAll(
    port.classList.contains('node-input') ? '.node-input' : '.node-output'
  ));

  return ports.indexOf(port);
}

function updateLinePosition(line, fromPort, toPort) {
  const canvas = document.getElementById('logicCanvas');
  const canvasRect = canvas.getBoundingClientRect();

  const fromRect = fromPort.getBoundingClientRect();
  const toRect = toPort.getBoundingClientRect();

  const x1 = fromRect.left + fromRect.width / 2 - canvasRect.left;
  const y1 = fromRect.top + fromRect.height / 2 - canvasRect.top;

  const x2 = toRect.left + toRect.width / 2 - canvasRect.left;
  const y2 = toRect.top + toRect.height / 2 - canvasRect.top;

  const path = `
    M ${x1} ${y1}
    C ${x1 + 60} ${y1},
      ${x2 - 60} ${y2},
      ${x2} ${y2}
  `;

  line.setAttribute('d', path);
}


export function exportLogic() {

  const nodes = [];

  document.querySelectorAll('.logic-node').forEach(node => {

    const type = node.dataset.type;

    const base = {
      id: node.dataset.id,
      type,
      x: Math.round(Number.parseFloat(node.style.left) || 0),
      y: Math.round(Number.parseFloat(node.style.top) || 0)
    };

    // 🔹 Input
    if (type === 'entity_input') {
      base.entityId = node.querySelector('.entity-select')?.value || null;
    }

    // 🔹 Output
    if (type === 'entity_output') {
      base.entityId = node.querySelector('.entity-select')?.value || null;
    }

    // 🔹 Operator
    if (type === 'operator') {
      base.operation = node.querySelector('.operator-select')?.value;
    }

    nodes.push(base);
  });

  const conns = connections.map(c => ({
    from: c.fromNode.dataset.id,
    to: c.toNode.dataset.id,
    fromIndex: c.fromIndex,
    toIndex: c.toIndex
  }));

  return {
    nodes,
    connections: conns
  };
}

export function importLogic(data) {

  const canvas = document.getElementById('logicCanvas');

  canvas.innerHTML = `<svg id="logicConnections" class="logic-connections"></svg>`;

  connections = [];

  const nodeMap = {};

  // 🔹 Nodes erstellen
  data.nodes.forEach(n => {

    const node = createLogicNode(n.type, n.x, n.y);

    node.dataset.id = n.id;

    // Werte setzen
    if (n.type === 'entity_input' || n.type === 'entity_output') {
      const select = node.querySelector('.entity-select');
      if (select) select.value = n.entityId;
    }

    if (n.type === 'operator') {
      const select = node.querySelector('.operator-select');
      if (select) select.value = n.operation;
    }

    canvas.appendChild(node);
    nodeMap[n.id] = node;
  });

  // 🔹 Connections erstellen
  data.connections.forEach(c => {

    const fromNode = nodeMap[c.from];
    const toNode = nodeMap[c.to];

    const fromPorts = fromNode.querySelectorAll('.node-output');
    const toPorts = toNode.querySelectorAll('.node-input');

    const fromPort = fromPorts[c.fromIndex || 0];
    const toPort = toPorts[c.toIndex || 0];

    createConnection(fromPort, toPort);
  });

  updateLiveValues();
  calculateFlow();
  updateCalculatedEntityEditButtons();
}

import socket from '../socket.js';
socket.on('entity-update', (data) => {
  const entity = findAvailableLogicEntity(data.entityId);
  if (entity && data.entity) {
    Object.assign(entity, data.entity);
  }

  updateLiveValues();
  calculateFlow();

  document.querySelectorAll('.logic-node[data-type="entity_output"]')
    .forEach(node => {
      const select = node.querySelector('.entity-select');
      if (select?.value !== data.entityId) return;

      const value = Number(data.entity?.value ?? data.entity?.state);
      if (!Number.isFinite(value)) return;

      const unit = data.entity?.unit || entity?.unit || '';
      const display = node.querySelector('.node-result');
      if (display) {
        display.textContent = `${value.toFixed(2)}${unit ? ` ${unit}` : ''}`;
      }
    });
});
