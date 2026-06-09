import {
  DEFAULT_CONFIG,
  apiFetch,
  formatValue,
  getLocalSettings,
  getServerVersion,
  iconFor,
  inferIconName,
  setLocalSettings
} from './shared.js';

const serverUrlInput = document.getElementById('serverUrl');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const reloadBtn = document.getElementById('reloadBtn');
const loginState = document.getElementById('loginState');
const versionBadge = document.getElementById('versionBadge');
const sourcesEl = document.getElementById('sources');
const selectedItemsEl = document.getElementById('selectedItems');
const searchInput = document.getElementById('search');
const layoutButtons = Array.from(document.querySelectorAll('[data-layout]'));

let sources = [];
let config = { ...DEFAULT_CONFIG };
let saveTimer = null;
let saveSequence = 0;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setState(text) {
  loginState.textContent = text;
}

function sourceById(sourceId) {
  return sources.find(source => source.id === sourceId);
}

function isSelected(sourceId) {
  return config.items.some(item => item.sourceId === sourceId);
}

function syncLayoutButtons() {
  layoutButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === config.layout);
  });
}

function renderSources() {
  const term = searchInput.value.trim().toLowerCase();
  const filtered = sources.filter(source => {
    if (!term) return true;

    const haystack = [
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

    return haystack.includes(term);
  });

  sourcesEl.innerHTML = filtered.map(source => `
    <label class="source-row">
      <input type="checkbox" value="${escapeHtml(source.id)}" ${isSelected(source.id) ? 'checked' : ''}>
      <span class="source-icon">${iconFor(inferIconName(source))}</span>
      <span class="source-main">
        <strong>${escapeHtml(source.label)}</strong>
        <small>${escapeHtml(formatValue(source))}</small>
      </span>
    </label>
  `).join('');
}

function renderSelectedItems() {
  if (!config.items.length) {
    selectedItemsEl.innerHTML = '<div class="empty-state compact">Noch keine Werte ausgewaehlt.</div>';
    return;
  }

  selectedItemsEl.innerHTML = config.items.map((item, index) => {
    const source = sourceById(item.sourceId);
    const fallbackLabel = source?.name || source?.label || item.sourceId;
    const iconName = inferIconName({ ...source, ...item, label: item.label || fallbackLabel });

    return `
      <div class="selected-row" data-source-id="${escapeHtml(item.sourceId)}">
        <span class="source-icon">${iconFor(iconName)}</span>
        <label>
          Anzeigename
          <input class="label-input" value="${escapeHtml(item.label || fallbackLabel)}">
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

function renderAll() {
  syncLayoutButtons();
  renderSources();
  renderSelectedItems();
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
  await setLocalSettings({
    serverUrl,
    username,
    token: data.token
  });

  passwordInput.value = '';
  await loadData();
}

async function loadData() {
  const me = await apiFetch('/api/extension/me');
  const sourceResponse = await apiFetch('/api/extension/sources');
  const configResponse = await apiFetch('/api/extension/config');

  sources = sourceResponse.sources || [];
  config = configResponse.config || { ...DEFAULT_CONFIG };
  setState(`Angemeldet als ${me.user.username}`);
  renderAll();
}

async function loadVersion() {
  const serverVersion = await getServerVersion().catch(() => '');
  versionBadge.textContent = serverVersion ? `MQTT ${serverVersion}` : 'MQTT Version nicht geladen';
}

function collectConfigFromInputs() {
  config.items = config.items.map((item, index) => {
    const row = Array.from(selectedItemsEl.querySelectorAll('.selected-row'))
      .find(element => element.dataset.sourceId === item.sourceId);
    const input = row?.querySelector('.label-input');
    const source = sourceById(item.sourceId);

    return {
      sourceId: item.sourceId,
      label: input?.value.trim() || source?.name || source?.label || item.sourceId,
      icon: inferIconName({ ...source, ...item, label: input?.value.trim() || source?.name || source?.label || item.sourceId }),
      order: index + 1
    };
  });
}

async function saveConfig({ render = false } = {}) {
  collectConfigFromInputs();
  const sequence = ++saveSequence;
  setState('Speichere...');

  const response = await apiFetch('/api/extension/config', {
    method: 'POST',
    body: JSON.stringify(config)
  });

  if (sequence !== saveSequence) return;

  config = response.config;
  setState('Automatisch gespeichert');

  if (render) {
    renderAll();
  }
}

function scheduleSave({ render = false } = {}) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await saveConfig({ render });
    } catch (err) {
      setState(err.message);
    }
  }, 350);
}

sourcesEl.addEventListener('change', event => {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;

  if (input.checked) {
    const source = sourceById(input.value);
    config.items.push({
      sourceId: input.value,
      label: source?.name || source?.label || input.value,
      icon: inferIconName(source),
      order: config.items.length + 1
    });
  } else {
    config.items = config.items.filter(item => item.sourceId !== input.value);
  }

  renderAll();
  scheduleSave();
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
  scheduleSave();
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
    syncLayoutButtons();
    scheduleSave();
  });
});

loginBtn.addEventListener('click', async () => {
  try {
    setState('Verbinde...');
    await login();
  } catch (err) {
    setState(err.message);
  }
});

reloadBtn.addEventListener('click', async () => {
  try {
    await setLocalSettings({ serverUrl: serverUrlInput.value });
    await loadData();
  } catch (err) {
    setState(err.message);
  }
});

searchInput.addEventListener('input', renderSources);

async function init() {
  const settings = await getLocalSettings();
  serverUrlInput.value = settings.serverUrl || '';
  usernameInput.value = settings.username || '';
  await loadVersion();

  if (settings.serverUrl) {
    try {
      await loadData();
    } catch {
      setState('Bitte anmelden');
    }
  }
}

init();
