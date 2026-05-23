let connectionStart = null;
let connections = [];

export function renderLogicView(container) {
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
            <div class="logic-item" draggable="true" data-type="add">
                ➕ Add
            </div>
            <div class="logic-item" draggable="true" data-type="entity_output">
                📤 Output
            </div>
            <div class="logic-item" draggable="true" data-type="trigger">
            ⚡ Trigger
            </div>

            <div class="logic-item" draggable="true" data-type="condition">
            🔀 Condition
            </div>

            <div class="logic-item" draggable="true" data-type="action">
            ▶ Action
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

  node.className = 'logic-node';

    if (type === 'entity_input') {
    node.innerHTML = `
        <div class="node-label">📥 Input</div>
        <select class="entity-select"></select>
        <div class="node-output"></div>
    `;
    }

    else if (type === 'entity_output') {
    node.innerHTML = `
        <div class="node-label">📤 Output</div>
        <select class="entity-select"></select>
        <div class="node-input center"></div>
    `;
    }

    else if (type === 'add') {
    node.innerHTML = `
        <div class="node-input top"></div>
        <div class="node-input bottom"></div>

        <div class="node-label">+</div>

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
    toPort
    });
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


