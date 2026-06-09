import {
  apiFetch,
  applyEntityUpdate,
  formatValue,
  getLocalSettings,
  iconFor,
  inferIconName,
  sourceBaseId
} from './shared.js';

const content = document.getElementById('content');
const statusText = document.getElementById('statusText');
const liveDot = document.getElementById('liveDot');
const updatedText = document.getElementById('updatedText');
const openOptionsBtn = document.getElementById('openOptions');

let currentItems = [];
let currentLayout = 'compact';
let socket = null;

openOptionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

function setStatus(text, state = 'muted') {
  statusText.textContent = text;
  liveDot.className = `dot ${state}`;
}

function renderItems(layout = 'compact') {
  if (!currentItems.length) {
    content.innerHTML = `
      <div class="empty-state">
        <strong>Keine Schnellansicht eingerichtet</strong>
        <span>Oeffne die Einstellungen und waehle Werte aus.</span>
      </div>
    `;
    return;
  }

  content.className = `content ${layout}`;
  content.innerHTML = currentItems
    .map(item => `
      <div class="quick-row">
        <span class="quick-icon">${iconFor(inferIconName(item))}</span>
        <span class="quick-label">${escapeHtml(item.label || item.name)}</span>
        <strong class="quick-value">${escapeHtml(formatValue(item))}</strong>
      </div>
    `)
    .join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function loadSnapshot() {
  const snapshot = await apiFetch('/api/extension/snapshot');
  currentItems = snapshot.items || [];
  currentLayout = snapshot.layout || 'compact';
  renderItems(currentLayout);
  updatedText.textContent = 'Aktualisiert gerade eben';
}

async function connectSocket() {
  const { serverUrl, token } = await getLocalSettings();
  if (!serverUrl || typeof io !== 'function') return;

  socket?.disconnect();
  socket = io(serverUrl, {
    auth: token ? { token } : {},
    withCredentials: true,
    transports: ['websocket', 'polling']
  });

  socket.on('connect', () => setStatus('Live', 'ok'));
  socket.on('disconnect', () => setStatus('Getrennt', 'muted'));
  socket.on('connect_error', () => setStatus('Socket blockiert', 'warn'));
  socket.on('entity-update', data => {
    let changed = false;

    currentItems = currentItems.map(item => {
      if (sourceBaseId(item.sourceId || item.id) !== data.entityId) return item;
      changed = true;
      return applyEntityUpdate(item, data.entity);
    });

    if (changed) {
      renderItems(currentLayout);
      updatedText.textContent = 'Live aktualisiert';
    }
  });
}

async function init() {
  try {
    setStatus('Verbinde...', 'warn');
    await loadSnapshot();
    await connectSocket();
  } catch (err) {
    setStatus('Nicht verbunden', 'warn');
    content.innerHTML = `
      <div class="empty-state">
        <strong>${escapeHtml(err.message)}</strong>
        <span>Pruefe Server-URL und Login in den Einstellungen.</span>
      </div>
    `;
  }
}

init();
