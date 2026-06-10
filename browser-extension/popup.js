import {
  DEFAULT_CONFIG,
  apiFetch,
  applyEntityUpdate,
  formatValue,
  getLocalSettings,
  getServerVersion,
  hasOpenStateBadge,
  iconFor,
  inferIconName,
  inferStateIconName,
  setLocalSettings,
  sourceBaseId
} from './shared.js';

const content = document.getElementById('content');
const statusText = document.getElementById('statusText');
const liveDot = document.getElementById('liveDot');
const openSidePanelBtn = document.getElementById('openSidePanel');
const versionBadge = document.getElementById('versionBadge');
const userAvatar = document.getElementById('userAvatar');
const addItemBtn = document.getElementById('addItemBtn');
const pickerPanel = document.getElementById('pickerPanel');
const entitySearch = document.getElementById('entitySearch');
const entityResults = document.getElementById('entityResults');
const serverUrlInput = document.getElementById('serverUrl');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const reloadBtn = document.getElementById('reloadBtn');
const selectedItemsEl = document.getElementById('selectedItems');
const layoutButtons = Array.from(document.querySelectorAll('[data-layout]'));
const tabButtons = Array.from(document.querySelectorAll('[data-tab]'));
const tabPanels = Array.from(document.querySelectorAll('.tab-panel'));

let currentItems = [];
let currentLayout = 'compact';
let sources = [];
let config = { ...DEFAULT_CONFIG };
let socket = null;
let saveTimer = null;
let saveSequence = 0;
let currentUser = '';
let draggedSourceId = null;

openSidePanelBtn?.addEventListener('click', async () => {
  try {
    if (!chrome.sidePanel?.open) return;
    const currentWindow = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: currentWindow.id });
    window.close();
  } catch {
    setStatus('Side Panel nicht verfuegbar', 'warn');
  }
});

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setStatus(text, state = 'muted') {
  statusText.textContent = text;
  liveDot.className = `dot ${state}`;
}

function setAvatar(name = '') {
  const text = String(name || '').trim();
  userAvatar.textContent = text ? text.slice(0, 1).toUpperCase() : '?';
  userAvatar.title = text || 'Nicht angemeldet';
}

function sourceById(sourceId) {
  return sources.find(source => source.id === sourceId);
}

function isSelected(sourceId) {
  return config.items.some(item => item.sourceId === sourceId);
}

function switchTab(tabId) {
  tabButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
  tabPanels.forEach(panel => panel.classList.toggle('active', panel.id === tabId));

  if (tabId !== 'editTab') {
    pickerPanel.classList.add('hidden');
  }
}

function syncLayoutButtons() {
  layoutButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === config.layout);
  });
}

function applyLayoutClass(layout) {
  document.body.classList.toggle('compact-layout', layout === 'compact');
  document.body.classList.toggle('tile-layout', layout === 'tiles');
  document.body.classList.toggle('list-layout', layout === 'list');
}

function renderItems(layout = 'compact') {
  content.className = `content ${layout}`;

  if (!currentItems.length) {
    content.innerHTML = `
      <div class="empty-state">
        <strong>Keine Schnellansicht eingerichtet</strong>
        <span>Wechsle zu Bearbeiten und fuege Entities hinzu.</span>
      </div>
    `;
    return;
  }

  content.innerHTML = currentItems
    .map(item => `
      <div class="quick-row">
        <span class="quick-icon ${hasOpenStateBadge(item) ? 'has-alert-badge' : ''}">${iconFor(inferStateIconName(item))}</span>
        <span class="quick-label">${escapeHtml(item.label || item.name)}</span>
        <strong class="quick-value">${escapeHtml(formatValue(item))}</strong>
      </div>
    `)
    .join('');
}

function renderSelectedItems() {
  if (!config.items.length) {
    selectedItemsEl.innerHTML = '<div class="empty-state compact">Noch keine Werte ausgewaehlt.</div>';
    return;
  }

  selectedItemsEl.innerHTML = config.items.map((item, index) => {
    const source = sourceById(item.sourceId);
    const fallbackLabel = source?.name || source?.label || item.sourceId;
    const label = item.label || fallbackLabel;
    const iconName = inferIconName({ ...source, ...item, label });

    return `
      <div class="selected-row" data-source-id="${escapeHtml(item.sourceId)}" draggable="true">
        <span class="source-icon">${iconFor(iconName)}</span>
        <label>
          Anzeigename
          <input class="label-input" value="${escapeHtml(label)}">
        </label>
        <div class="selected-actions">
          <button class="move-up" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="move-down" ${index === config.items.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="remove">Entfernen</button>
        </div>
      </div>
    `;
  }).join('');
}

function sourceSearchText(source) {
  return [
    source.searchText,
    source.label,
    source.name,
    source.deviceName,
    source.originalDeviceName,
    source.originalEntityName,
    source.type,
    source.unit,
    source.id,
    source.entityId,
    source.deviceId
  ].join(' ').toLowerCase();
}

function renderEntityResults() {
  const term = entitySearch.value.trim().toLowerCase();
  const filtered = sources
    .filter(source => !isSelected(source.id))
    .filter(source => !term || sourceSearchText(source).includes(term))
    .slice(0, 80);

  if (!filtered.length) {
    entityResults.innerHTML = '<div class="empty-state compact">Keine passende Entity gefunden.</div>';
    return;
  }

  entityResults.innerHTML = filtered.map(source => `
    <button class="entity-result" type="button" data-source-id="${escapeHtml(source.id)}">
      <span class="source-icon">${iconFor(inferIconName(source))}</span>
      <span>
        <strong>${escapeHtml(source.label)}</strong>
        <small>${escapeHtml(formatValue(source))}</small>
      </span>
    </button>
  `).join('');
}

function renderAll() {
  syncLayoutButtons();
  renderItems(currentLayout);
  renderSelectedItems();
  renderEntityResults();
}

function collectConfigFromInputs() {
  config.items = config.items.map((item, index) => {
    const row = Array.from(selectedItemsEl.querySelectorAll('.selected-row'))
      .find(element => element.dataset.sourceId === item.sourceId);
    const input = row?.querySelector('.label-input');
    const source = sourceById(item.sourceId);
    const label = input?.value.trim() || source?.name || source?.label || item.sourceId;

    return {
      sourceId: item.sourceId,
      label,
      icon: inferIconName({ ...source, ...item, label }),
      order: index + 1
    };
  });
}

async function saveConfig({ render = false } = {}) {
  collectConfigFromInputs();
  const sequence = ++saveSequence;
  setStatus('Speichere...', 'warn');

  const response = await apiFetch('/api/extension/config', {
    method: 'POST',
    body: JSON.stringify(config)
  });

  if (sequence !== saveSequence) return;

  config = response.config;
  currentLayout = config.layout || 'compact';
  applyLayoutClass(currentLayout);
  setStatus('Live', 'ok');

  if (render) {
    await loadSnapshot();
    renderAll();
  }
}

function scheduleSave({ render = false } = {}) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await saveConfig({ render });
    } catch (err) {
      setStatus(err.message, 'warn');
    }
  }, 350);
}

async function login() {
  const serverUrl = serverUrlInput.value;
  const username = usernameInput.value.trim();
  await setLocalSettings({ serverUrl, username });

  const authRes = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/auth/enabled`);
  const authInfo = await authRes.json().catch(() => ({ enabled: true }));

  if (!authInfo.enabled) {
    await setLocalSettings({ serverUrl, token: '' });
    passwordInput.value = '';
    await loadData();
    return;
  }

  const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/extension/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: passwordInput.value
    })
  });

  if (!res.ok) {
    throw new Error('Login fehlgeschlagen');
  }

  const data = await res.json();
  await setLocalSettings({ serverUrl, username, token: data.token });
  passwordInput.value = '';
  await loadData();
}

async function loadSnapshot() {
  const snapshot = await apiFetch('/api/extension/snapshot');
  currentItems = snapshot.items || [];
  currentLayout = snapshot.layout || config.layout || 'compact';
  applyLayoutClass(currentLayout);
  renderItems(currentLayout);
}

async function loadData() {
  const me = await apiFetch('/api/extension/me');
  const sourceResponse = await apiFetch('/api/extension/sources');
  const configResponse = await apiFetch('/api/extension/config');

  currentUser = me.user.username;
  sources = sourceResponse.sources || [];
  config = configResponse.config || { ...DEFAULT_CONFIG };
  currentLayout = config.layout || 'compact';
  setAvatar(currentUser);
  setStatus('Live', 'ok');
  await loadVersion();
  await loadSnapshot();
  renderAll();
  await connectSocket();
}

async function loadVersion() {
  const serverVersion = await getServerVersion().catch(() => '');
  versionBadge.textContent = serverVersion ? `MQTT ${serverVersion}` : '';
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
    }
  });
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

addItemBtn.addEventListener('click', () => {
  pickerPanel.classList.toggle('hidden');
  if (!pickerPanel.classList.contains('hidden')) {
    entitySearch.focus();
    renderEntityResults();
  }
});

entitySearch.addEventListener('input', renderEntityResults);

entityResults.addEventListener('click', event => {
  const result = event.target.closest('.entity-result');
  if (!result) return;

  const source = sourceById(result.dataset.sourceId);
  if (!source || isSelected(source.id)) return;

  config.items.push({
    sourceId: source.id,
    label: source.name || source.label || source.id,
    icon: inferIconName(source),
    order: config.items.length + 1
  });

  pickerPanel.classList.add('hidden');
  entitySearch.value = '';
  renderAll();
  scheduleSave({ render: true });
});

selectedItemsEl.addEventListener('dragstart', event => {
  const row = event.target.closest('.selected-row');
  if (!row) return;

  draggedSourceId = row.dataset.sourceId;
  row.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedSourceId);
});

selectedItemsEl.addEventListener('dragend', event => {
  event.target.closest('.selected-row')?.classList.remove('dragging');
  draggedSourceId = null;
});

selectedItemsEl.addEventListener('dragover', event => {
  const row = event.target.closest('.selected-row');
  if (!row || !draggedSourceId || row.dataset.sourceId === draggedSourceId) return;

  event.preventDefault();
  row.classList.add('drag-over');
});

selectedItemsEl.addEventListener('dragleave', event => {
  event.target.closest('.selected-row')?.classList.remove('drag-over');
});

selectedItemsEl.addEventListener('drop', event => {
  const row = event.target.closest('.selected-row');
  if (!row || !draggedSourceId || row.dataset.sourceId === draggedSourceId) return;

  event.preventDefault();
  row.classList.remove('drag-over');

  const fromIndex = config.items.findIndex(item => item.sourceId === draggedSourceId);
  const toIndex = config.items.findIndex(item => item.sourceId === row.dataset.sourceId);
  if (fromIndex < 0 || toIndex < 0) return;

  const [moved] = config.items.splice(fromIndex, 1);
  config.items.splice(toIndex, 0, moved);
  renderAll();
  scheduleSave({ render: true });
});

selectedItemsEl.addEventListener('click', event => {
  if (event.target.closest('input, label')) return;

  const row = event.target.closest('.selected-row');
  if (!row) return;

  const index = config.items.findIndex(item => item.sourceId === row.dataset.sourceId);
  if (index < 0) return;

  if (event.target.closest('.remove')) {
    config.items.splice(index, 1);
  } else if (event.target.closest('.move-up') && index > 0) {
    [config.items[index - 1], config.items[index]] = [config.items[index], config.items[index - 1]];
  } else if (event.target.closest('.move-down') && index < config.items.length - 1) {
    [config.items[index + 1], config.items[index]] = [config.items[index], config.items[index + 1]];
  }

  renderAll();
  scheduleSave({ render: true });
});

selectedItemsEl.addEventListener('input', event => {
  const input = event.target.closest('.label-input');
  if (!input) return;

  const row = input.closest('.selected-row');
  const item = config.items.find(entry => entry.sourceId === row?.dataset.sourceId);
  if (!item) return;

  item.label = input.value;
  scheduleSave();
});

layoutButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    config.layout = btn.dataset.layout;
    currentLayout = config.layout;
    applyLayoutClass(currentLayout);
    syncLayoutButtons();
    renderItems(currentLayout);
    scheduleSave();
  });
});

loginBtn.addEventListener('click', async () => {
  try {
    setStatus('Verbinde...', 'warn');
    await login();
    switchTab('viewTab');
  } catch (err) {
    setStatus(err.message, 'warn');
  }
});

reloadBtn.addEventListener('click', async () => {
  try {
    await setLocalSettings({ serverUrl: serverUrlInput.value, username: usernameInput.value.trim() });
    await loadData();
  } catch (err) {
    setStatus(err.message, 'warn');
  }
});

async function init() {
  const settings = await getLocalSettings();
  serverUrlInput.value = settings.serverUrl || '';
  usernameInput.value = settings.username || '';
  setAvatar(settings.username);
  setStatus('Verbinde...', 'warn');
  await loadVersion();

  if (!settings.serverUrl) {
    setStatus('Bitte anmelden', 'warn');
    switchTab('settingsTab');
    return;
  }

  try {
    await loadData();
  } catch (err) {
    setStatus('Bitte anmelden', 'warn');
    content.innerHTML = `
      <div class="empty-state">
        <strong>${escapeHtml(err.message)}</strong>
        <span>Pruefe Server-URL und Login in den Einstellungen.</span>
      </div>
    `;
    switchTab('settingsTab');
  }
}

init();
