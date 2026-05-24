let connectionStart = null;
let connections = [];

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

      if (el) {
        el.textContent = from._value.toFixed(2);
      }
      const select = to.querySelector('.entity-select');
      const entityId = select?.value;

      if (entityId && value !== undefined) {
        writeEntityValue(entityId, value);
      }
    }

  });

}

function writeEntityValue(entityId, value) {

  const entity = getWritableEntities().find(e => e.id === entityId);

  if (!entity) return;

  // 🔥 Nur schreiben wenn Wert sich ändert
  if (Math.abs(Number(entity.value) - value) < 0.001) return;

  setNumberEntity(entityId, value);
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
      if (entity.type === 'number') {
        list.push({
          id: entity.id,
          name: baseName,
          device: deviceName,
          unit: entity.unit || '',
          action: 'setValue'
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
}

let availableDevices = [];

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
            <button id="saveLogicBtn">💾 Speichern</button>
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
    
  document.getElementById('saveLogicBtn')?.addEventListener('click', async () => {

    const data = exportLogic();

    console.log('LOGIC:', data);

    await fetch('/api/logics', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

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

    const node = createLogicNode(draggedType, e.offsetX, e.offsetY);
    canvas.appendChild(node);
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

    const options = entities.map(e =>
      `<option value="${e.id}">
        ${e.device} → ${e.name} (${e.value} ${e.unit})
      </option>`
    ).join('');

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

      const options = entities.map(e =>
        `<option value="${e.id}">
          ${e.device} → ${e.name}
        </option>`
      ).join('');

      node.innerHTML = `
        <div class="node-input center"></div>

        <div class="node-label">Ausgang</div>

        <select class="entity-select">
          <option value="">-- wählen --</option>
          ${options}
        </select>
        
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
            createConnection(connectionStart.port, input);

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

  return node;
}

function makeNodeDraggable(node) {
  let offsetX = 0;
  let offsetY = 0;
  let isDragging = false;

  node.addEventListener('mousedown', (e) => {
    isDragging = true;

    offsetX = e.offsetX;
    offsetY = e.offsetY;

    node.style.zIndex = 1000; // nach vorne
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const canvas = document.getElementById('logicCanvas');
    const rect = canvas.getBoundingClientRect();

    node.style.left = (e.clientX - rect.left - offsetX) + 'px';
    node.style.top = (e.clientY - rect.top - offsetY) + 'px';
    connections.forEach(conn => {
        updateLinePosition(conn.line, conn.fromPort, conn.toPort);
        });
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    node.style.zIndex = '';
  });
}

function createConnection(fromPort, toPort) {
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
      x: parseInt(node.style.left),
      y: parseInt(node.style.top)
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
}

import socket from '../socket.js';
socket.on('entity-update', (data) => {

  document.querySelectorAll('.logic-node').forEach(node => {

    if (node.dataset.type !== 'entity_input') return;

    const select = node.querySelector('.entity-select');
    if (!select) return;

    if (select.value !== data.entityId) return;

    const val = Number(data.entity?.value ?? data.entity?.state ?? 0);

    node._value = val;

    const el = node.querySelector('.node-result');
    if (el) {
      el.textContent = val.toFixed(2);
    }
  });
});