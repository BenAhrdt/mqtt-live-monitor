import socket from './socket.js';
import { initSettings } from './settings.js';
import {
  escapeHtml,
  shortenMiddleSmart,
  rgbToHex,
  slugifyDashboardName,
  formatPayload,
  translateLockState,
  translateCoverState,
  translateHumidifierDeviceClass,
  translateLawnMowerActivity,
  parseMqttPayload
} from './utils.js';

import { createDashboardRenderer } from './dashboardRenderer.js';
window.showView = showView;

socket.on("connect", () => {
    // console.log("Browser Socket verbunden:", socket.id);
});
let discoveryPrefixes = [];
let friendlyNames = {
    devices: {},
    entities: {}
};
let liveMessages = [];
let liveMessageLimit = Number(localStorage.getItem('liveMessageLimit') || 2500);

const topicFilterInput = document.getElementById('liveFilterInput');
const messageTable = document.getElementById('messageTable');
const detailsTopicEl = document.getElementById('detailsTopic');
const decodedDataBoxEl = document.getElementById('decodedDataBox');
const detailsBox = document.getElementById('detailsBox');
const clearBtn = document.getElementById('clearBtn');
const pauseBtn = document.getElementById('pauseBtn');
const copyBtn = document.getElementById('copyBtn');
const liveMessageLimitInput = document.getElementById('liveMessageLimitInput');

const mqttHostInput = document.getElementById('mqttHost');
const mqttPortInput = document.getElementById('mqttPort');
const mqttTopicInput = document.getElementById('mqttTopic');
const mqttUsernameInput = document.getElementById('mqttUsername');
const mqttPasswordInput = document.getElementById('mqttPassword');
const mqttClientIdInput = document.getElementById('mqttClientId');
const configMessageEl = document.getElementById('configMessage');

const totalMessagesEl = document.getElementById('totalMessages');
const topicCountEl = document.getElementById('topicCount');
const topicBadgeEl = document.getElementById('topicBadge');
const lastMessageTimeEl = document.getElementById('lastMessageTime');
const messageCountEl = document.getElementById('messageCount');
const topicListEl = document.getElementById('topicList');
const brokerTextEl = document.getElementById('brokerText');
const topicTextEl = document.getElementById('topicText');
const statusTextEl = document.getElementById('statusText');
const connectionStateEl = document.getElementById('connectionState');
const connectionMessageEl = document.getElementById('connectionMessage');
const dashboardConnectionDot = document.getElementById('dashboardConnectionDot');

const showLiveMonitorBtn = document.getElementById('showLiveMonitorBtn');
const showHomeBtn = document.getElementById('showHomeBtn');
const liveMonitorView = document.getElementById('liveMonitorView');
const dashboardView = document.getElementById('dashboardView');
const showSettingsBtn = document.getElementById('showSettingsBtn');
const settingsView = document.getElementById('settingsView');
const appLayout = document.getElementById('appLayout');
const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
const entityFilterDropdown = document.getElementById('entityFilterDropdown');
const entityFilterBtn = document.getElementById('entityFilterBtn');
const entityFilterMenu = document.getElementById('entityFilterMenu');
const selectAllEntitiesBtn = document.getElementById('selectAllEntitiesBtn');
const deselectAllEntitiesBtn = document.getElementById('deselectAllEntitiesBtn');
const customDashboardsNav = document.getElementById('customDashboardsNav');
const customDashboardsNavList = document.getElementById('customDashboardsNavList');
const toggleCustomDashboardsBtn = document.getElementById('toggleCustomDashboardsBtn');

const dashboardEditModeBtn = document.getElementById('dashboardEditModeBtn');

const exportDashboardsBtn = document.getElementById('exportDashboardsBtn');
const importDashboardsBtn = document.getElementById('importDashboardsBtn');
const importDashboardsFile = document.getElementById('importDashboardsFile');

const entityTypesBtn = document.getElementById('entityFilterBtn');
const editDashboardBtn = document.getElementById('dashboardEditModeBtn');

let paused = false;
let totalMessages = Number(sessionStorage.getItem('totalMessages') || 0);
let selectedPayload = '';
const topics = new Map();
let dashboardDevices = [];
let currentView = 'dashboard';
let customDashboards = [];
let activeCustomDashboardId = null;
let dashboardRenderScheduled = false;
let activeEntityTypes = new Set();

let dashboardEditMode = false;

let customDashboardsMenuOpen = false;

if (toggleCustomDashboardsBtn) {
    toggleCustomDashboardsBtn.addEventListener('click', () => {
    customDashboardsMenuOpen = !customDashboardsMenuOpen;

    customDashboardsNavList.style.display = customDashboardsMenuOpen ? 'block' : 'none';
    });
}



const dashboardRenderer = createDashboardRenderer({
    getCustomDashboards: () => customDashboards,
    getDashboardDevices: () => dashboardDevices,
    getFriendlyNames: () => friendlyNames,
    getActiveCustomDashboardId: () => activeCustomDashboardId,
    getDashboardEditMode: () => dashboardEditMode,
    isEntityTypeVisible,
    getDiscoveryPrefixes: () => discoveryPrefixes,
    customDashboardsNav,
    customDashboardsNavList,
    dashboardView,
    decodedDataBoxEl,
    setupDashboardDragAndDrop,
    getDeviceDisplayName: (device) => getDeviceDisplayName(device),
    getEntityDisplayName: (entity) => getEntityDisplayName(entity),
    getLightStateValue: (value) => getLightStateValue(value),
    updateClimateSliderBubble: (input) => updateClimateSliderBubble(input),
    updateHumidifierSliderBubble: (input) => updateHumidifierSliderBubble(input)
});

liveMessageLimitInput.value = liveMessageLimit;

socket.on("debug-log", (data) => {
  console.log("[SERVER]", data.timestamp, data.message);
});

function getEntityDisplayName(entity) {
    return String(
    friendlyNames.entities[entity.id] ||
    entity.name ||
    entity.id
    );
}

function getDeviceDisplayName(device) {
    return String(
    friendlyNames.devices[device.id] ||
    device.name ||
    device.id
    );
}

function updateSensorNameShortening() {
    document.querySelectorAll('.sensor-row-line').forEach((row) => {
    const nameEl = row.querySelector('.sensor-name');
    const valueEl = row.querySelector('.sensor-value');

    if (!nameEl || !valueEl) return;

    const full = nameEl.dataset.fullname || nameEl.textContent;
    const availableWidth = row.clientWidth - valueEl.offsetWidth - 20;

    nameEl.textContent = shortenMiddleSmart(full, availableWidth);
    });
}

async function selectAllEntityTypes() {
    entityFilterMenu.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = true;
    });

    updateEntityTypeFilter();
    await saveEntityTypeFilterToBackend();
}

async function deselectAllEntityTypes() {
    entityFilterMenu.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = false;
    });

    updateEntityTypeFilter();
    await saveEntityTypeFilterToBackend();
}

selectAllEntitiesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectAllEntityTypes();
});

deselectAllEntitiesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deselectAllEntityTypes();
});

liveMessageLimitInput.addEventListener('change', () => {
    const nextLimit = Number(liveMessageLimitInput.value);

    if (!Number.isFinite(nextLimit) || nextLimit < 100) {
        liveMessageLimitInput.value = liveMessageLimit;
        return;
    }

    liveMessageLimit = nextLimit;
    localStorage.setItem('liveMessageLimit', String(liveMessageLimit));

    while (liveMessages.length > liveMessageLimit) {
        liveMessages.pop();
    }

    renderLiveMessages();
});

function applyInitialMobileSidebarState() {
    const saved = localStorage.getItem('sidebarCollapsed');
    if (saved === '1') {
        appLayout.classList.add('sidebar-collapsed');
    } else if (saved === '0') {
        appLayout.classList.remove('sidebar-collapsed');
    } else {
        // 👉 Default (z. B. mobil = collapsed)
        if (window.innerWidth < 768) {
            appLayout.classList.add('sidebar-collapsed');
        }
    }
}

function showView(viewName, options = {}) {
    currentView = viewName;

    // Aktivierungen deaktiviern
    document
    .querySelectorAll('.nav-dashboard-item, [data-view], .top-nav-btn')
    .forEach(el => el.classList.remove('active'));

    // Button ausblenden
    entityTypesBtn.classList.add('hidden');
    editDashboardBtn.classList.add('hidden');

    // Alle Views verstecken
    liveMonitorView.style.display = 'none';
    dashboardView.style.display = 'none';
    settingsView.style.display = 'none';

    showHomeBtn.classList.remove('active');
    showLiveMonitorBtn.classList.remove('active');
    showSettingsBtn.classList.remove('active');

    // 🏠 HOME
    if (viewName === 'home') {
        activeCustomDashboardId = null;

        dashboardView.style.display = 'block';
        showHomeBtn.classList.add('active');

        entityTypesBtn.classList.remove('hidden');
        document.querySelector('[data-view="home"]')?.classList.add('active');

        if (options.updateUrl !== false) {
            history.pushState(null, '', '/');
        }

        loadDashboardDevices();
        return;
    }

    // 📊 CUSTOM DASHBOARD
    if (viewName === 'dashboard') {
        if (options.customDashboardId !== undefined) {
            activeCustomDashboardId = options.customDashboardId;
        }

        editDashboardBtn.classList.remove('hidden');

        dashboardView.style.display = 'block';

        // 👉 Sidebar Active setzen
        document.querySelector(
        `.nav-dashboard-item[data-dashboard-id="${activeCustomDashboardId}"]`
        )?.classList.add('active');

        if (activeCustomDashboardId) {
            if (options.updateUrl !== false) {
                history.pushState(
                    null,
                    '',
                    `/dashboard/custom/${encodeURIComponent(activeCustomDashboardId)}`
                );
            }
        }

        loadDashboardDevices();
        return;
    }

    // 📡 LIVE
    if (viewName === 'live') {
        liveMonitorView.style.display = 'block';
        showLiveMonitorBtn.classList.add('active');

        if (options.updateUrl !== false) {
            history.pushState(null, '', '/live');
        }

        return;
    }

    // ⚙️ SETTINGS
    if (viewName === 'settings') {
        settingsView.style.display = 'block';
        showSettingsBtn.classList.add('active');

        if (options.updateUrl !== false) {
            history.pushState(null, '', '/settings');
        }
        ensureDevicesInitialized();
        return;
    }
}

function ensureDevicesInitialized() {
    dashboardRenderer.renderCustomDashboards();
}

function getLightStateValue(value) {
    if (value === null || value === undefined) {
    return false;
    }

    if (typeof value === 'boolean') {
    return value;
    }

    if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    return normalized === 'ON' || normalized === 'TRUE' || normalized === '1';
    }

    if (typeof value === 'object') {
    const state = value.state;

    if (typeof state === 'boolean') {
        return state;
    }

    if (typeof state === 'string') {
        const normalized = state.trim().toUpperCase();
        return normalized === 'ON' || normalized === 'TRUE' || normalized === '1';
    }

    if (typeof state === 'number') {
        return state === 1;
    }
    }

    return false;
}

function handleHumidifierSliderStart(input) {
    const wrap = input.closest('.humidifier-slider-wrap');
    const bubble = wrap?.querySelector('.humidifier-slider-bubble');
    if (!bubble) return;

    bubble.classList.remove('hidden');
    updateHumidifierSliderBubble(input);
}

function handleHumidifierSliderInput(input) {
    updateHumidifierSliderBubble(input);
}

function handleHumidifierSliderEnd(input) {
    const wrap = input.closest('.humidifier-slider-wrap');
    const bubble = wrap?.querySelector('.humidifier-slider-bubble');
    if (!bubble) return;

    setTimeout(() => {
    bubble.classList.add('hidden');
    }, 300);
}

function updateHumidifierSliderBubble(input) {
    const wrap = input.closest('.humidifier-slider-wrap');
    const bubble = wrap?.querySelector('.humidifier-slider-bubble');
    if (!bubble) return;

    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    const percent = ((value - min) / (max - min)) * 100;

    bubble.textContent = `${value.toFixed(0)} %`;
    bubble.style.left = `${percent}%`;
}

function handleClimateSliderStart(input) {
    const wrap = input.closest('.climate-inline-slider-wrap');
    const bubble = wrap?.querySelector('.climate-slider-bubble');
    if (!bubble) return;

    bubble.classList.remove('hidden');
    updateClimateSliderBubble(input);
}

function handleClimateSliderInput(input) {
    updateClimateSliderBubble(input);
}

function handleClimateSliderEnd(input) {
    const wrap = input.closest('.climate-inline-slider-wrap');
    const bubble = wrap?.querySelector('.climate-slider-bubble');
    if (!bubble) return;

    setTimeout(() => {
    bubble.classList.add('hidden');
    }, 300);
}

function updateClimateSliderBubble(input) {
    const wrap = input.closest('.climate-inline-slider-wrap');
    const bubble = wrap?.querySelector('.climate-slider-bubble');
    if (!bubble) return;

    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);

    const percent = ((value - min) / (max - min)) * 100;

    bubble.textContent = `${value.toFixed(1)} °C`;
    bubble.style.left = `${percent}%`;
}

function scheduleDashboardRender() {
    if (dashboardRenderScheduled) return;

    dashboardRenderScheduled = true;

    requestAnimationFrame(() => {
    dashboardRenderScheduled = false;
    dashboardRenderer.renderDashboard();
    });
}

function isEntityTypeVisible(entityType) {
    return activeEntityTypes.has(entityType);
}

function updateEntityTypeFilter() {
    const checkedValues = Array.from(
    entityFilterMenu.querySelectorAll('input[type="checkbox"]:checked')
    ).map((input) => input.value);

    activeEntityTypes = new Set(checkedValues);
    dashboardRenderer.renderDashboard();
}

async function saveEntityTypeFilterToBackend() {
    try {
    const enabledEntityTypes = Array.from(
        entityFilterMenu.querySelectorAll('input[type="checkbox"]:checked')
    ).map((input) => input.value);

    await fetch('/api/entity-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledEntityTypes })
    });
    } catch (err) {
    console.error('Fehler beim Speichern des Entitätstyps:', err);
    }
}

function applyEntityTypeSelectionToUi(enabledTypes) {
    const enabledSet = new Set(Array.isArray(enabledTypes) ? enabledTypes : []);

    entityFilterMenu.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = enabledSet.has(input.value);
    });

    activeEntityTypes = enabledSet;
}

async function toggleSwitch(entityId, isOn) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) return;

    const payload = isOn
    ? parseMqttPayload(entity.payloadOn ?? 'ON')
    : parseMqttPayload(entity.payloadOff ?? 'OFF');

    try {
    await publishMqttCommand(entity.commandTopic, payload);
    } catch (err) {
    console.error('Switch Fehler:', err);
    }
}

async function pressButtonEntity(entityId) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) return;

    let payload = entity.payloadPress ?? 'PRESS';

    if (payload === 'true') payload = true;
    if (payload === 'false') payload = false;

    try {
    await publishMqttCommand(entity.commandTopic, payload);
    } catch (err) {
    console.error('Button Fehler:', err);
    }
}

async function setNumberEntity(entityId, value) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) return;

    try {
    await publishMqttCommand(entity.commandTopic, Number(value));
    } catch (err) {
    console.error('Number Fehler:', err);
    }
}

async function setTextEntity(entityId, value) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) return;

    try {
    await publishMqttCommand(entity.commandTopic, String(value));
    } catch (err) {
    console.error('Text Fehler:', err);
    }
}

function findEntityById(id) {
    for (const device of devices) {
    for (const entity of device.entities) {
        if (entity.id === id) return entity;
    }
    }
    return null;
}

function getCustomDashboardIdFromUrl() {
    const match = window.location.pathname.match(/^\/dashboard\/custom\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}

function exportCustomDashboards() {
    const data = {
        exportedAt: new Date().toISOString(),
        customDashboards,
        friendlyNames
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json'
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = `mqtt-live-monitor-dashboards-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();

    URL.revokeObjectURL(url);
}

async function importCustomDashboardsFromFile(file) {
    if (!file) return;

    const text = await file.text();
    const data = JSON.parse(text);

    const importedDashboards = Array.isArray(data)
        ? data
        : data.customDashboards;

    const importedFriendlyNames = data.friendlyNames || {
        devices: {},
        entities: {}
    };

    if (!Array.isArray(importedDashboards)) {
        alert('Ungültige Dashboard-Datei');
        return;
    }

    if (!confirm('Dashboard-Konfiguration importieren und mit bestehender Konfiguration zusammenführen?')) {
        return;
    }

    const dashboardMap = new Map(
        customDashboards.map(dashboard => [dashboard.id, dashboard])
    );

    importedDashboards.forEach((importedDashboard) => {
        const id = String(importedDashboard.id || '').trim();
        const name = String(importedDashboard.name || '').trim();

        if (!id || !name) return;

        const existingDashboard = dashboardMap.get(id);

        if (!existingDashboard) {
            dashboardMap.set(id, {
                id,
                name,
                devices: Array.isArray(importedDashboard.devices)
                    ? importedDashboard.devices
                    : []
            });
            return;
        }

        existingDashboard.name = name;

        if (!Array.isArray(existingDashboard.devices)) {
            existingDashboard.devices = [];
        }

        const deviceMap = new Map(
            existingDashboard.devices.map(device => [device.deviceId, device])
        );

        (importedDashboard.devices || []).forEach((importedDevice) => {
            const deviceId = String(importedDevice.deviceId || '').trim();
            if (!deviceId) return;

            const importedEntityIds = Array.isArray(importedDevice.entityIds)
                ? importedDevice.entityIds.map(id => String(id).trim()).filter(Boolean)
                : [];

            const existingDevice = deviceMap.get(deviceId);

            if (!existingDevice) {
                deviceMap.set(deviceId, {
                    deviceId,
                    entityIds: importedEntityIds
                });
                return;
            }

            const mergedEntityIds = new Set([
                ...(existingDevice.entityIds || []),
                ...importedEntityIds
            ]);

            existingDevice.entityIds = Array.from(mergedEntityIds);
        });

        existingDashboard.devices = Array.from(deviceMap.values());
    });

    customDashboards = Array.from(dashboardMap.values());

    friendlyNames = {
        devices: {
            ...(friendlyNames.devices || {}),
            ...(importedFriendlyNames.devices || {})
        },
        entities: {
            ...(friendlyNames.entities || {}),
            ...(importedFriendlyNames.entities || {})
        }
    };

    dashboardRenderer.renderCustomDashboards();
    dashboardRenderer.renderCustomDashboardsNav();

    await saveCustomDashboards();
    await saveFriendlyNames();

    alert('Dashboards und Friendly Names importiert');
}

function addAllDevicesToCustomDashboard(dashboardId) {
    const dashboard = customDashboards.find(d => d.id === dashboardId);
    if (!dashboard) return;

    if (!Array.isArray(dashboard.devices)) {
    dashboard.devices = [];
    }

    const existingIds = new Set(dashboard.devices.map(d => d.deviceId));

    [...dashboardDevices]
    .sort((a, b) => {
        const nameA = getDeviceDisplayName(a).toLowerCase();
        const nameB = getDeviceDisplayName(b).toLowerCase();

        return nameA.localeCompare(nameB, 'de');
    })
    .forEach((device) => {
    if (existingIds.has(device.id)) return;

    dashboard.devices.push({
        deviceId: device.id,
        entityIds: device.entities?.map(entity => entity.id) || []
    });
    });

    dashboardRenderer.renderCustomDashboards();
    saveCustomDashboards();
}

function removeAllDevicesFromCustomDashboard(dashboardId) {
    const dashboard = customDashboards.find(d => d.id === dashboardId);
    if (!dashboard) return;

    if (!confirm('Wirklich alle Geräte aus diesem Dashboard entfernen?')) {
    return;
    }

    dashboard.devices = [];

    dashboardRenderer.renderCustomDashboards();
    saveCustomDashboards();
}

async function saveCustomDashboards() {
    try {
    const res = await fetch('/api/custom-dashboards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customDashboards })
    });

    if (!res.ok) {
        console.error('Dashboard speichern fehlgeschlagen');
    }
    } catch (err) {
    console.error('Dashboard speichern fehlgeschlagen:', err);
    }
}

async function saveFriendlyNames() {
    try {
    await fetch('/api/friendly-names', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendlyNames })
    });
    } catch (err) {
    console.error('FriendlyNames speichern fehlgeschlagen:', err);
    }
}

async function renameDevice(deviceId) {
    const device = dashboardDevices.find(d => d.id === deviceId);
    if (!device) return;

    const current = getDeviceDisplayName(device);

    const newName = prompt('Neuer Gerätename:', current);
    if (newName === null) return;

    const trimmed = newName.trim();

    if (!trimmed) {
    delete friendlyNames.devices[deviceId];
    } else {
    friendlyNames.devices[deviceId] = trimmed;
    }

    await saveFriendlyNames();

    dashboardRenderer.renderDashboard();
    dashboardRenderer.renderCustomDashboards();
}

async function renameEntity(entityId) {
    const entity = findDashboardEntityById(entityId);
    if (!entity) return;

    const current = getEntityDisplayName(entity);

    const newName = prompt('Neuer Entitätsname:', current);
    if (newName === null) return;

    const trimmed = newName.trim();

    if (!trimmed) {
    delete friendlyNames.entities[entityId];
    } else {
    friendlyNames.entities[entityId] = trimmed;
    }

    await saveFriendlyNames();

    dashboardRenderer.renderDashboard();
    dashboardRenderer.renderCustomDashboards();
}

function addCustomDashboard() {
    const input = document.getElementById('newDashboardNameInput');
    const name = input.value.trim();

    if (!name) return;

    const id = slugifyDashboardName(name);

    if (!id) return;

    if (customDashboards.some(d => d.id === id)) {
    alert('Dashboard existiert bereits');
    return;
    }

    customDashboards.push({
    id,
    name,
    devices: []
    });

    input.value = '';
    dashboardRenderer.renderCustomDashboards();
    dashboardRenderer.renderCustomDashboardsNav();
    saveCustomDashboards();
}

function removeCustomDashboard(index) {
    customDashboards.splice(index, 1);
    dashboardRenderer.renderCustomDashboards();
    dashboardRenderer.renderCustomDashboardsNav();
    saveCustomDashboards();
}

function renameDashboard(dashboardId) {
    const dashboard = customDashboards.find(d => d.id === dashboardId);
    if (!dashboard) return;

    const newNameRaw = prompt('Dashboard umbenennen:', dashboard.name);
    if (newNameRaw === null) return;

    const newName = newNameRaw.trim();
    if (!newName) return;

    // 👉 doppelte Namen verhindern
    const nameExists = customDashboards.some(
        d => d.name.toLowerCase() === newName.toLowerCase() && d.id !== dashboardId
    );

    if (nameExists) {
        alert('Ein Dashboard mit diesem Namen existiert bereits');
        return;
    }

    // 👉 neue ID generieren (slug)
    const newId = slugifyDashboardName(newName);

    // 👉 ID Konflikt verhindern
    const idExists = customDashboards.some(
        d => d.id === newId && d.id !== dashboardId
    );

    if (idExists) {
        alert('Interner Fehler: ID bereits vergeben');
        return;
    }

    dashboard.name = newName;
    dashboard.id = newId;

    // 👉 aktives Dashboard updaten
    if (activeCustomDashboardId === dashboardId) {
        activeCustomDashboardId = newId;
    }

    saveCustomDashboards();

    dashboardRenderer.renderCustomDashboards();
    dashboardRenderer.renderCustomDashboardsNav();
    dashboardRenderer.renderDashboard();
}

function duplicateDashboard(dashboardId) {
    const original = customDashboards.find(d => d.id === dashboardId);
    if (!original) return;

    let baseName = original.name + ' Kopie';
    let counter = 1;
    let newName = baseName;

    // 👉 eindeutigen Namen erzeugen
    while (customDashboards.some(d => d.name === newName)) {
        counter++;
        newName = `${baseName} (${counter})`;
    }

    const newId = slugifyDashboardName(newName);

    const copy = {
        id: newId,
        name: newName,
        devices: JSON.parse(JSON.stringify(original.devices || []))
    };

    customDashboards.push(copy);

    saveCustomDashboards();

    dashboardRenderer.renderCustomDashboards();
    dashboardRenderer.renderCustomDashboardsNav();

}

let draggedDashboardDeviceId = null;

function setupDashboardDragAndDrop() {
    if (!activeCustomDashboardId || !dashboardEditMode) return;

    const cards = document.querySelectorAll('.dashboard-device-card');
    const handles = document.querySelectorAll('.drag-handle[draggable="true"]');

    handles.forEach((handle) => {
    handle.addEventListener('dragstart', (e) => {
        draggedDashboardDeviceId = handle.dataset.deviceId;

        const card = handle.closest('.dashboard-device-card');
        card?.classList.add('dragging');

        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedDashboardDeviceId);
    });

    handle.addEventListener('dragend', () => {
        document.querySelectorAll('.dashboard-device-card.dragging')
        .forEach(card => card.classList.remove('dragging'));

        document.querySelectorAll('.dashboard-device-card.drag-over')
        .forEach(card => card.classList.remove('drag-over'));

        draggedDashboardDeviceId = null;
    });
    });

    cards.forEach((card) => {
    card.addEventListener('dragover', (e) => {
        e.preventDefault();

        if (!draggedDashboardDeviceId) return;

        card.classList.add('drag-over');
        e.dataTransfer.dropEffect = 'move';
    });

    card.addEventListener('dragleave', () => {
        card.classList.remove('drag-over');
    });

    card.addEventListener('drop', (e) => {
        e.preventDefault();

        const targetDeviceId = card.dataset.deviceId;

        document.querySelectorAll('.dashboard-device-card.drag-over')
        .forEach(card => card.classList.remove('drag-over'));

        if (!draggedDashboardDeviceId || draggedDashboardDeviceId === targetDeviceId) return;

        moveCustomDashboardDevice(draggedDashboardDeviceId, targetDeviceId);
    });
    });
}

function moveCustomDashboardDevice(draggedId, targetId) {
    const dashboard = customDashboards.find(d => d.id === activeCustomDashboardId);
    if (!dashboard) return;

    const fromIndex = dashboard.devices.findIndex(d => d.deviceId === draggedId);
    const toIndex = dashboard.devices.findIndex(d => d.deviceId === targetId);

    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;

    const [moved] = dashboard.devices.splice(fromIndex, 1);
    dashboard.devices.splice(toIndex, 0, moved);

    dashboardRenderer.renderDashboard();
    saveCustomDashboards();
}

function addDeviceToCustomDashboard(dashboardId) {
    const dashboard = customDashboards.find(d => d.id === dashboardId);
    if (!dashboard) return;

    const select = document.getElementById(`deviceSelect-${dashboardId}`);
    const deviceId = select?.value;

    if (!deviceId) return;

    if (!Array.isArray(dashboard.devices)) {
    dashboard.devices = [];
    }

    if (dashboard.devices.some(d => d.deviceId === deviceId)) {
    return;
    }

    const device = dashboardDevices.find(d => d.id === deviceId);

    dashboard.devices.push({
    deviceId,
    entityIds: device?.entities?.map(entity => entity.id) || []
    });

    dashboardRenderer.renderCustomDashboards();
    saveCustomDashboards();
}

function removeDeviceFromCustomDashboard(dashboardId, deviceId) {
    const dashboard = customDashboards.find(d => d.id === dashboardId);
    if (!dashboard) return;

    dashboard.devices = (dashboard.devices || []).filter(d => d.deviceId !== deviceId);

    dashboardRenderer.renderCustomDashboards();
    saveCustomDashboards();
}

function toggleDashboardEntity(dashboardId, deviceId, entityId, enabled) {
    const dashboard = customDashboards.find(d => d.id === dashboardId);
    if (!dashboard) return;

    const device = dashboard.devices.find(d => d.deviceId === deviceId);
    if (!device) return;

    if (enabled) {
    if (!device.entityIds.includes(entityId)) {
        device.entityIds.push(entityId);
    }
    } else {
    device.entityIds = device.entityIds.filter(id => id !== entityId);
    }

    saveCustomDashboards();
}

async function loadDashboardDevices() {
    try {
    const response = await fetch('/api/devices');
    const data = await response.json();
    dashboardDevices = Array.isArray(data) ? data : [];
    dashboardRenderer.renderDashboard();
    } catch (error) {
    console.error('Fehler beim Laden von /api/devices:', error);
    }
}

function updateDashboardEntity(update) {
    if (activeCustomDashboardId) {
    const customDashboard = customDashboards.find(d => d.id === activeCustomDashboardId);

    const isInCustomDashboard = customDashboard?.devices?.some(device =>
        device.deviceId === update.deviceId &&
        device.entityIds.includes(update.entityId)
    );

    if (!isInCustomDashboard) {
        return;
    }
    }

    let found = false;

    dashboardDevices = dashboardDevices.map((device) => {
    if (device.id !== update.deviceId) {
        return device;
    }

    const updatedEntities = (device.entities || []).map((entity) => {
        if (entity.id !== update.entityId) {
        return entity;
        }

        found = true;

        return {
        ...entity,
        ...update.entity,
        value: update.entity.value,
        rawState: update.entity.rawState,
        lastUpdate: update.entity.lastUpdate
        };
    });

    return {
        ...device,
        entities: updatedEntities
    };
    });

    if (found && currentView === 'dashboard') {
    updateSingleEntity(update);
    }
}

function updateSingleEntity(update) {
    const oldEl = document.getElementById(`entity-${update.entityId}`);

    if (!oldEl) {
        scheduleDashboardRender();
        return;
    }

    const entity = update.entity;
    let html = '';

    if (entity.type === 'climate') html = dashboardRenderer.renderClimateEntity(entity);
    else if (entity.type === 'light') html = dashboardRenderer.renderLightEntity(entity);
    else if (entity.type === 'cover') html = dashboardRenderer.renderCoverEntity(entity);
    else if (entity.type === 'lock') html = dashboardRenderer.renderLockEntity(entity);
    else if (entity.type === 'humidifier') html = dashboardRenderer.renderHumidifierEntity(entity);
    else if (entity.type === 'lawn_mower') html = dashboardRenderer.renderLawnMowerEntity(entity);
    else if (entity.type === 'sensor') html = dashboardRenderer.renderSensorEntity(entity);
    else if (entity.type === 'binary_sensor') html = dashboardRenderer.renderBinarySensorEntity(entity);
    else if (entity.type === 'switch') html = dashboardRenderer.renderSwitchEntity(entity);
    else if (entity.type === 'button') html = dashboardRenderer.renderButtonEntity(entity);
    else if (entity.type === 'number') html = dashboardRenderer.renderNumberEntity(entity);
    else if (entity.type === 'text') html = dashboardRenderer.renderTextEntity(entity);
    else {
        scheduleDashboardRender();
        return;
    }

    oldEl.outerHTML = html;
}

async function publishMqttCommand(topic, payloadObject) {
    try {
    const payload =
        typeof payloadObject === 'string' || typeof payloadObject === 'number'
        ? String(payloadObject)
        : JSON.stringify(payloadObject);

    const response = await fetch('/api/mqtt/publish', {
        method: 'POST',
        headers: {
        'Content-Type': 'application/json'
        },
        body: JSON.stringify({
        topic,
        payload
        })
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
        console.error('MQTT publish fehlgeschlagen:', result.error || result);
    }
    } catch (error) {
    console.error('Fehler beim MQTT publish:', error);
    }
}

function findDashboardEntityById(entityId) {
    for (const device of dashboardDevices) {
    const entity = (device.entities || []).find(e => e.id === entityId);
    if (entity) {
        return entity;
    }
    }
    return null;
}

async function toggleLightEntity(entityId, isChecked) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) return;

    const newState = isChecked ? 'ON' : 'OFF';

    try {
    await publishMqttCommand(entity.commandTopic, {
        state: newState
    });
    } catch (error) {
    console.error('Fehler beim Schalten:', error);
    }
}

async function setLightBrightness(entityId, brightness) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) return;

    try {
    await publishMqttCommand(entity.commandTopic, {
        state: 'ON',
        brightness: Number(brightness)
    });
    } catch (error) {
    console.error('Fehler beim Setzen der Helligkeit:', error);
    }
}

async function setLightEffect(entityId, effect) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) return;

    try {
    const payload = effect
        ? { state: 'ON', effect }
        : { state: 'ON', effect: null };

    await publishMqttCommand(entity.commandTopic, payload);
    } catch (error) {
    console.error('Fehler beim Setzen des Effekts:', error);
    }
}

async function setLightColor(entityId, hexColor) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) return;

    const hex = String(hexColor || '').replace('#', '');
    if (hex.length !== 6) return;

    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);

    try {
    await publishMqttCommand(entity.commandTopic, {
        state: 'ON',
        color: { r, g, b }
    });
    } catch (error) {
    console.error('Fehler beim Setzen der Farbe:', error);
    }
}

async function setClimateMode(entityId, mode) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.modeCommandTopic) return;

    try {
    await publishMqttCommand(entity.modeCommandTopic, mode);
    } catch (error) {
    console.error('Fehler beim Setzen des Climate-Modus:', error);
    }
}

async function setClimateTargetTemperature(entityId, temperature) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.temperatureCommandTopic) return;

    try {
    await publishMqttCommand(entity.temperatureCommandTopic, Number(temperature));
    } catch (error) {
    console.error('Fehler beim Setzen der Solltemperatur:', error);
    }
}

async function setLightColorTemp(entityId, kelvin) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) return;

    try {
    await publishMqttCommand(entity.commandTopic, {
        state: 'ON',
        color_temp: Number(kelvin)
    });
    } catch (error) {
    console.error('Fehler beim Setzen der Farbtemperatur:', error);
    }
}

async function setHumidifierState(entityId, isOn) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) return;

    const payload = isOn
    ? (entity.payloadOn ?? 'ON')
    : (entity.payloadOff ?? 'OFF');

    try {
    await publishMqttCommand(entity.commandTopic, payload);
    } catch (error) {
    console.error('Fehler beim Setzen des Humidifier-Status:', error);
    }
}

async function setHumidifierTargetHumidity(entityId, humidity) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.targetHumidityCommandTopic) return;

    try {
    await publishMqttCommand(entity.targetHumidityCommandTopic, Number(humidity));
    } catch (error) {
    console.error('Fehler beim Setzen der Sollfeuchte:', error);
    }
}

async function adjustHumidifierTargetHumidity(entityId, delta) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.targetHumidityCommandTopic) return;

    const current = Number(entity.targetHumidity ?? entity.minHumidity ?? 40);
    const min = Number(entity.minHumidity ?? 30);
    const max = Number(entity.maxHumidity ?? 80);

    let next = current + Number(delta);
    next = Math.max(min, Math.min(max, next));
    next = Math.round(next);

    try {
    await publishMqttCommand(entity.targetHumidityCommandTopic, next);
    } catch (error) {
    console.error('Fehler beim Anpassen der Sollfeuchte:', error);
    }
}

async function promptHumidifierTargetHumidity(entityId) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.targetHumidityCommandTopic) return;

    const current = Number(entity.targetHumidity ?? entity.minHumidity ?? 40);
    const min = Number(entity.minHumidity ?? 30);
    const max = Number(entity.maxHumidity ?? 80);

    const input = window.prompt(
    `Sollfeuchte eingeben (${min} bis ${max} %):`,
    current.toFixed(0)
    );

    if (input === null) return;

    let next = Number(String(input).replace(',', '.'));
    if (Number.isNaN(next)) return;

    next = Math.max(min, Math.min(max, next));
    next = Math.round(next);

    try {
    await publishMqttCommand(entity.targetHumidityCommandTopic, next);
    } catch (error) {
    console.error('Fehler beim direkten Setzen der Sollfeuchte:', error);
    }
}

async function adjustClimateTargetTemperature(entityId, delta) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.temperatureCommandTopic) return;

    const current = Number(entity.targetTemperature ?? entity.minTemp ?? 20);
    const min = Number(entity.minTemp ?? 6);
    const max = Number(entity.maxTemp ?? 30);
    const step = Number(entity.tempStep ?? 0.1);

    let next = current + Number(delta);
    next = Math.max(min, Math.min(max, next));
    next = Math.round(next / step) * step;

    try {
    await publishMqttCommand(entity.temperatureCommandTopic, next);
    } catch (error) {
    console.error('Fehler beim Anpassen der Solltemperatur:', error);
    }
}

async function sendCoverCommand(entityId, action) {
    console.log("sendCoverCommand", entityId, action);

    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) {
    console.warn("Kein commandTopic gefunden", entity);
    return;
    }

    let payload = '';

    if (action === 'OPEN') {
    payload = entity.payloadOpen || 'OPEN';
    } else if (action === 'CLOSE') {
    payload = entity.payloadClose || 'CLOSE';
    } else if (action === 'STOP') {
    payload = entity.payloadStop || 'STOP';
    } else {
    return;
    }

    console.log("Sende:", entity.commandTopic, payload);

    try {
    await publishMqttCommand(entity.commandTopic, payload);
    } catch (error) {
    console.error('Fehler beim Senden:', error);
    }
}

async function sendLockCommand(entityId, action) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.commandTopic) return;

    let payload = '';

    if (action === 'OPEN') {
    payload = entity.payloadOpen || 'OPEN';
    } else if (action === 'LOCK') {
    payload = entity.payloadLock || 'LOCK';
    } else if (action === 'UNLOCK') {
    payload = entity.payloadUnlock || 'UNLOCK';
    } else {
    return;
    }

    try {
    await publishMqttCommand(entity.commandTopic, payload);
    } catch (error) {
    console.error('Fehler beim Senden des Lock-Befehls:', error);
    }
}

async function sendLawnMowerCommand(entityId, action) {
    const entity = findDashboardEntityById(entityId);
    if (!entity) return;

    let topic = '';
    let payload = '';

    if (action === 'start_mowing') {
    topic = entity.startMowingCommandTopic;
    payload = 'start_mowing';
    } else if (action === 'pause') {
    topic = entity.pauseCommandTopic;
    payload = 'pause';
    } else if (action === 'dock') {
    topic = entity.dockCommandTopic;
    payload = 'dock';
    } else {
    return;
    }

    if (!topic) return;

    try {
    await publishMqttCommand(topic, payload);
    } catch (error) {
    console.error('Fehler beim Senden des Lawn-Mower-Befehls:', error);
    }
}

async function promptClimateTargetTemperature(entityId) {
    const entity = findDashboardEntityById(entityId);
    if (!entity || !entity.temperatureCommandTopic) return;

    const current = Number(entity.targetTemperature ?? entity.minTemp ?? 20);
    const min = Number(entity.minTemp ?? 6);
    const max = Number(entity.maxTemp ?? 30);
    const step = Number(entity.tempStep ?? 0.1);

    const input = window.prompt(
    `Solltemperatur eingeben (${min} bis ${max} °C):`,
    current.toFixed(1)
    );

    if (input === null) return;

    let next = Number(String(input).replace(',', '.'));
    if (Number.isNaN(next)) return;

    next = Math.max(min, Math.min(max, next));
    next = Math.round(next / step) * step;

    try {
    await publishMqttCommand(entity.temperatureCommandTopic, next);
    } catch (error) {
    console.error('Fehler beim direkten Setzen der Solltemperatur:', error);
    }
}

socket.on("entity-update", (data) => {
    const exists = findDashboardEntityById(data.entityId);

    if (!exists) {
    // neues Gerät oder neue Entity → komplett neu laden
    loadDashboardDevices();
    return;
    }

    updateDashboardEntity(data);
});

function updateTopicList() {
    const filter = topicFilterInput.value.trim().toLowerCase();
    const entries = [...topics.entries()]
    .filter(([topic]) => topic.toLowerCase().includes(filter))
    .sort((a, b) => b[1].count - a[1].count);

    topicCountEl.textContent = topics.size;
    topicBadgeEl.textContent = entries.length;

    if (entries.length === 0) {
    topicListEl.className = 'topic-list empty-state';
    topicListEl.textContent = 'Keine passenden Topics';
    return;
    }

    topicListEl.className = 'topic-list';
    topicListEl.innerHTML = entries.map(([topic, info]) => `
    <div class="topic-item">
        <div class="topic-name">${escapeHtml(topic)}</div>
        <div class="topic-meta">
        <span>${info.count} Msg</span>
        <span>${info.lastTime}</span>
        </div>
    </div>
    `).join('');
}

function renderLiveMessages() {
    messageTable.innerHTML = '';

    const filter = topicFilterInput.value.trim().toLowerCase();

    liveMessages
        .filter(msg => msg.topic.toLowerCase().includes(filter))
        .slice(0, 100)
        .forEach(addMessageRow);

    if (!messageTable.children.length) {
        messageTable.innerHTML = `
            <tr>
                <td colspan="3" class="empty-cell">Keine passenden Nachrichten</td>
            </tr>
        `;
    }
}

function addMessageRow(data) {
    const filter = topicFilterInput.value.trim().toLowerCase();
    if (filter && !data.topic.toLowerCase().includes(filter)) {
    return;
    }

    const formattedPayload = formatPayload(data.payload);
    const shortPayload = formattedPayload.length > 140
    ? formattedPayload.slice(0, 140) + ' ...'
    : formattedPayload;

    const emptyRow = messageTable.querySelector('.empty-cell');
    if (emptyRow) {
    messageTable.innerHTML = '';
    }

    const tr = document.createElement('tr');
    tr.className = 'message-row';
    tr.innerHTML = `
    <td>${new Date(data.timestamp).toLocaleTimeString()}</td>
    <td class="topic-cell">${escapeHtml(data.topic)}</td>
    <td>
        <code>${escapeHtml(shortPayload)}</code>
        ${data.retain ? '<span class="badge">retained</span>' : ''}
    </td>
    `;

    tr.addEventListener('click', () => {
    selectedPayload = formattedPayload;
    detailsBox.textContent = formattedPayload;
    detailsTopicEl.textContent = data.topic;

    document.getElementById('detailsTime').textContent =
        new Date(data.timestamp).toLocaleString();

    let parsed;
    try {
        parsed = JSON.parse(data.payload);
    } catch {
        parsed = null;
    }

    const deviceName = parsed?.deviceInfo?.deviceName;
    const deviceRow = document.getElementById('deviceRow');

    if (deviceName) {
        document.getElementById('detailsDevice').textContent = deviceName;
        deviceRow.style.display = 'block';
    } else {
        deviceRow.style.display = 'none';
    }

    const devEui = parsed?.deviceInfo?.devEui;
    const devEuiField = document.getElementById('devEuiField');
    const devEuiRow = document.getElementById('devEuiRow');

    if (devEui) {
        document.getElementById('detailsDevEui').textContent = devEui;
        devEuiField.style.display = 'block';
        devEuiRow.style.display = 'flex';
    } else {
        devEuiField.style.display = 'none';
        devEuiRow.style.display = 'none';
    }

    const rssi = parsed?.rxInfo?.[0]?.rssi;
    const rssiField = document.getElementById('rssiField');
    const rssiRow = document.getElementById('rssiRow');
    const rssiEl = document.getElementById('detailsRssi');

    if (rssi !== undefined) {
        rssiEl.textContent = `${rssi} dBm`;
        rssiField.style.display = 'block';
        rssiRow.style.display = 'flex';

        if (rssi > -70) {
        rssiEl.style.color = '#4ade80';
        } else if (rssi > -90) {
        rssiEl.style.color = '#facc15';
        } else {
        rssiEl.style.color = '#f87171';
        }
    } else {
        rssiField.style.display = 'none';
        rssiRow.style.display = 'none';
    }

    dashboardRenderer.renderDecodedData(formattedPayload);

    document.querySelectorAll('.message-row').forEach(row => row.classList.remove('selected'));
    tr.classList.add('selected');
    });

    messageTable.prepend(tr);

    while (messageTable.children.length > 100) {
    messageTable.removeChild(messageTable.lastChild);
    }

    // tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadVersion() {
    try {
    const res = await fetch('/api/version');
    const data = await res.json();

    const versionEl = document.getElementById('appVersion');
    if (versionEl && data.version) {
        versionEl.textContent = `v${data.version}`;
    }
    } catch (err) {
    console.error("Version konnte nicht geladen werden", err);
    }
}

async function checkForUpdates() {
    try {
    const res = await fetch('/api/update/check');
    const data = await res.json();

    const btn = document.getElementById('updateBtn');

    if (data.updateAvailable && btn.classList.contains('hidden')) {
        btn.classList.remove('hidden');
        btn.textContent = `update verfügbar ${data.latest}`;

        btn.onclick = async () => {
        if (!confirm(`Update auf ${data.latest} starten?`)) return;

        btn.textContent = 'Update läuft...';

        await fetch('/api/update/run', { method: 'POST' });

        btn.textContent = 'Neustart...';

        setTimeout(() => {
            window.location.reload();
        }, 6000);
        };
    }
    } catch (err) {
    console.error('Update-Check fehlgeschlagen', err);
    }
}

async function loadConfig() {
    const res = await fetch('/api/config');
    const config = await res.json();

    mqttHostInput.value = config.host || '';
    mqttPortInput.value = config.port || 1883;
    mqttTopicInput.value = config.topic || '#';
    mqttUsernameInput.value = '';
    mqttPasswordInput.value = '';
    mqttUsernameInput.placeholder = config.authConfigured ? 'gespeichert' : 'optional';
    mqttPasswordInput.placeholder = config.authConfigured ? 'gespeichert' : 'optional';
    mqttClientIdInput.value = config.clientId || '';
    discoveryPrefixes = config.discoveryViaPrefixes || [];
    customDashboards = config.customDashboards || [];
    friendlyNames = config.friendlyNames || {
    devices: {},
    entities: {}
    };
    dashboardRenderer.renderCustomDashboards();
    dashboardRenderer.renderCustomDashboardsNav();
    dashboardRenderer.renderDiscoveryPrefixes();
    applyEntityTypeSelectionToUi(
    config.enabledEntityTypes || ['light', 'climate', 'cover', 'lock', 'humidifier', 'lawn_mower', 'sensor', 'binary_sensor', 'switch', 'button', 'number', 'text']
    );

    const urlEntityTypes = getEntityTypesFromUrl();

    if (urlEntityTypes) {
        applyEntityTypeSelectionToUi(urlEntityTypes);
    }

    brokerTextEl.textContent = `${config.host}:${config.port}`;
    topicTextEl.textContent = config.topic;
}

function handleDashboardSliderStart(input) {
    const wrap = input.closest('.dashboard-slider-wrap');
    const bubble = wrap?.querySelector('.dashboard-slider-bubble');
    if (!bubble) return;

    bubble.classList.remove('hidden');
    updateDashboardSliderBubble(input);
}

function handleDashboardSliderInput(input) {
    updateDashboardSliderBubble(input);
}

function handleDashboardSliderEnd(input) {
    const wrap = input.closest('.dashboard-slider-wrap');
    const bubble = wrap?.querySelector('.dashboard-slider-bubble');
    if (!bubble) return;

    setTimeout(() => bubble.classList.add('hidden'), 300);
}

function updateDashboardSliderBubble(input) {
    const wrap = input.closest('.dashboard-slider-wrap');
    const bubble = wrap?.querySelector('.dashboard-slider-bubble');
    if (!bubble) return;

    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    const unit = input.dataset.unit || '';

    const percent = ((value - min) / (max - min)) * 100;

    bubble.textContent = `${value}${unit ? ' ' + unit : ''}`;
    bubble.style.left = `${percent}%`;
}

function getEntityTypesFromUrl() {
    const path = window.location.pathname;

    if (path.startsWith('/dashboard/custom/')) {
        return null;
    }

    const match = path.match(/^\/dashboard\/(.+)$/);
    if (!match) return null;

    return match[1]
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
}

showLiveMonitorBtn.addEventListener('click', () => {
    showView('live');
});

exportDashboardsBtn.addEventListener('click', exportCustomDashboards);

importDashboardsBtn.addEventListener('click', () => {
    importDashboardsFile.click();
});

importDashboardsFile.addEventListener('change', async () => {
    try {
    await importCustomDashboardsFromFile(importDashboardsFile.files[0]);
    } catch (err) {
    alert('Import fehlgeschlagen');
    console.error(err);
    } finally {
    importDashboardsFile.value = '';
    }
});

showHomeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showView('home');
});

showSettingsBtn.addEventListener('click', () => {
    showView('settings');
});

sidebarToggleBtn.addEventListener('click', () => {
    appLayout.classList.toggle('sidebar-collapsed');

    const isCollapsed = appLayout.classList.contains('sidebar-collapsed');

    localStorage.setItem('sidebarCollapsed', isCollapsed ? '1' : '0');
});

entityFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    entityFilterDropdown.classList.toggle('open');
});

// Clickhandler
document.addEventListener('click', async (e) => {

    // 🔥 1. TABS (Home + Custom Dashboards)
    const tab = e.target.closest('.dashboard-tab');
    if (tab) {
        e.preventDefault();

        // 👉 Home Tab
        if (tab.dataset.view === 'home') {
            showView('home');
            return;
        }

        // 👉 Custom Dashboard Tab
        const id = tab.dataset.dashboardId;
        if (id) {
            showView('dashboard', {
                customDashboardId: id
            });
            return;
        }
    }

    // 🔥 2. DASHBOARD Navigation (Sidebar + Öffnen)
    const dashboardBtn = e.target.closest(
        '.nav-dashboard-item, .open-dashboard-btn'
    );

    if (dashboardBtn) {
        e.preventDefault();

        const id = dashboardBtn.dataset.dashboardId;

        if (id) {
            showView('dashboard', {
                customDashboardId: id
            });
        }

        return;
    }

    // 🔥 3. RENAME DEVICE  ← HIER!
    const renameDeviceBtn = e.target.closest('.action-rename-device');
    if (renameDeviceBtn) {
        const deviceId = renameDeviceBtn.dataset.deviceId;

        renameDevice(deviceId);
        return;
    }

    // 🔥 4. RENAME ENTITY
    const renameEntityBtn = e.target.closest('.action-rename-entity');
    if (renameEntityBtn) {
        const entityId = renameEntityBtn.dataset.entityId;

        renameEntity(entityId);
        return;
    }

    // 🔥 3. EFFECT OPTION (Dropdown Auswahl)
    const option = e.target.closest('.effect-option');
    if (option) {
        const dropdown = option.closest('.effect-dropdown');
        const entityId = dropdown.dataset.entity;
        const value = option.dataset.value;

        const selectedText = dropdown.querySelector('.effect-selected-text');
        if (selectedText) {
            selectedText.textContent = option.textContent.trim();
        }

        dropdown.classList.remove('open');

        document.querySelectorAll('.effect-option.active')
            .forEach(el => el.classList.remove('active'));
        option.classList.add('active');

        await setLightEffect(entityId, value);
        return;
    }

    // 🔥 4. Dropdown öffnen
    const selected = e.target.closest('.effect-selected');
    if (selected) {
        const dropdown = selected.closest('.effect-dropdown');
        const isOpen = dropdown.classList.contains('open');

        document.querySelectorAll('.effect-dropdown.open')
            .forEach(d => d.classList.remove('open'));

        if (!isOpen) {
            dropdown.classList.add('open');
        }

        return;
    }

    // 🔥 5. Entity Filter Dropdown schließen
    if (!e.target.closest('.entity-filter-dropdown')) {
        entityFilterDropdown.classList.remove('open');
    }

    // 🔥 6. Alle offenen Effekt-Dropdowns schließen
    document.querySelectorAll('.effect-dropdown.open')
        .forEach(d => d.classList.remove('open'));
});

dashboardEditModeBtn.addEventListener('click', () => {
    dashboardEditMode = !dashboardEditMode;

    dashboardEditModeBtn.textContent = dashboardEditMode
    ? 'Fertig'
    : 'Bearbeiten';

    dashboardRenderer.renderDashboard();
});

document.getElementById('addDashboardBtn')
    .addEventListener('click', addCustomDashboard);

document.getElementById('newDashboardNameInput')
    .addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCustomDashboard();
    });

entityFilterMenu.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', async () => {
    updateEntityTypeFilter();
    await saveEntityTypeFilterToBackend();
    });
});

socket.on('mqtt-message', (data) => {
    liveMessages.unshift(data);

    while (liveMessages.length > liveMessageLimit) {
        liveMessages.pop();
    }

    if (paused) return;

    totalMessages += 1;
    messageCountEl.textContent = totalMessages;
    sessionStorage.setItem('totalMessages', String(totalMessages));

    lastMessageTimeEl.textContent = new Date(data.timestamp).toLocaleTimeString();

    const existing = topics.get(data.topic) || { count: 0, lastTime: '-' };
    topics.set(data.topic, {
        count: existing.count + 1,
        lastTime: new Date(data.timestamp).toLocaleTimeString()
    });

    if (currentView === 'live') {
        totalMessagesEl.textContent = totalMessages;
        updateTopicList();
        renderLiveMessages();
    }
});

socket.on('mqtt-status', (status) => {
    brokerTextEl.textContent = `${status.host}:${status.port}`;
    topicTextEl.textContent = status.topic;
    connectionMessageEl.textContent = status.message || '-';

    if (status.connected) {
    statusTextEl.textContent = 'Verbunden';
    statusTextEl.className = 'status connected';
    connectionStateEl.textContent = 'Verbunden';
    dashboardConnectionDot.classList.remove('disconnected');
    dashboardConnectionDot.classList.add('connected');
    dashboardConnectionDot.title = 'Verbunden';
    configMessageEl.textContent = 'Verbunden';
    } else {
    statusTextEl.textContent = 'Getrennt';
    statusTextEl.className = 'status disconnected';
    connectionStateEl.textContent = 'Getrennt';
    dashboardConnectionDot.classList.remove('connected');
    dashboardConnectionDot.classList.add('disconnected');
    dashboardConnectionDot.title = 'Getrennt';
    }
});

reconnectBtn.addEventListener('click', async () => {
    totalMessages = 0;
    sessionStorage.setItem('totalMessages', '0');
    messageCountEl.textContent = '0';
    totalMessagesEl.textContent = '0';

    reconnectBtn.disabled = true;
    reconnectBtn.textContent = 'Reconnect...';

    try {
        await fetch('/api/reconnect', { method: 'POST' });

        reconnectBtn.textContent = 'Gestartet';

        setTimeout(() => {
            reconnectBtn.textContent = 'Reconnect';
            reconnectBtn.disabled = false;
        }, 1500);
    } catch (err) {
        console.error('Reconnect fehlgeschlagen:', err);
        reconnectBtn.textContent = 'Fehler';

        setTimeout(() => {
            reconnectBtn.textContent = 'Reconnect';
            reconnectBtn.disabled = false;
        }, 2000);
    }
});

pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Fortsetzen' : 'Pause';

    if (!paused) {
        updateTopicList();
        renderLiveMessages();
    }
});

topicFilterInput.addEventListener('input', () => {
    updateTopicList();
    renderLiveMessages();
});

clearBtn.addEventListener('click', () => {
    liveMessages = [];
    topics.clear();
    
    messageTable.innerHTML = `
    <tr>
        <td colspan="3" class="empty-cell">Noch keine Nachrichten</td>
    </tr>
    `;
    detailsBox.textContent = 'Klicke auf eine Nachricht, um Details zu sehen.';
    detailsTopicEl.textContent = '-';
    decodedDataBoxEl.className = 'decoded-data-empty';
    decodedDataBoxEl.textContent = 'Keine decodierten Daten vorhanden.';
    selectedPayload = '';
});

copyBtn.addEventListener('click', async () => {
    if (!selectedPayload) return;
    await navigator.clipboard.writeText(selectedPayload);
    copyBtn.textContent = 'Kopiert';
    setTimeout(() => copyBtn.textContent = 'Kopieren', 1200);
});

window.addEventListener('resize', applyInitialMobileSidebarState);

// Einstellungen
/************************************************************
 * **********************************************************
 * *********************************************************/
async function saveDiscoveryPrefixes() {
    await fetch('/api/discovery-prefixes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discoveryViaPrefixes: discoveryPrefixes })
    });
}

function addPrefix() {
    const input = document.getElementById('newDiscoveryPrefixInput');
    const value = input.value.trim();

    if (!value) return;

    if (discoveryPrefixes.some(p => p.value.toLowerCase() === value.toLowerCase())) {
    alert('Prefix existiert bereits');
    return;
    }

    discoveryPrefixes.push({ value, enabled: true });
    input.value = '';

    dashboardRenderer.renderDiscoveryPrefixes();
    saveDiscoveryPrefixes();
}

function togglePrefix(index) {
    discoveryPrefixes[index].enabled = !discoveryPrefixes[index].enabled;
    dashboardRenderer.renderDiscoveryPrefixes();
    saveDiscoveryPrefixes();
}

function removePrefix(index) {
    discoveryPrefixes.splice(index, 1);
    dashboardRenderer.renderDiscoveryPrefixes();
    saveDiscoveryPrefixes();
}

document.getElementById('addDiscoveryPrefixBtn')
    .addEventListener('click', addPrefix);

document.getElementById('newDiscoveryPrefixInput')
    .addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addPrefix();
    });

/************************************************************
 * **********************************************************
 * *********************************************************/

initSettings({
  mqttHostInput,
  mqttPortInput,
  mqttTopicInput,
  mqttUsernameInput,
  mqttPasswordInput,
  mqttClientIdInput,
  entityFilterMenu,
  configMessageEl,
  brokerTextEl,
  topicTextEl,
  getDiscoveryPrefixes: () => discoveryPrefixes,
  getCurrentView: () => currentView,
  loadDashboardDevices
});

window.removeCustomDashboard = removeCustomDashboard;
window.addDeviceToCustomDashboard = addDeviceToCustomDashboard;
window.addAllDevicesToCustomDashboard = addAllDevicesToCustomDashboard;
window.removeAllDevicesFromCustomDashboard = removeAllDevicesFromCustomDashboard;
window.removeDeviceFromCustomDashboard = removeDeviceFromCustomDashboard;
window.toggleDashboardEntity = toggleDashboardEntity;

window.togglePrefix = togglePrefix;
window.removePrefix = removePrefix;

window.handleDashboardSliderInput = handleDashboardSliderInput;
window.handleDashboardSliderStart = handleDashboardSliderStart;
window.handleDashboardSliderEnd = handleDashboardSliderEnd;

window.setClimateTargetTemperature = setClimateTargetTemperature;
window.adjustClimateTargetTemperature = adjustClimateTargetTemperature;
window.promptClimateTargetTemperature = promptClimateTargetTemperature;
window.setClimateMode = setClimateMode;

window.toggleLightEntity = toggleLightEntity;
window.setLightBrightness = setLightBrightness;
window.setLightColor = setLightColor;
window.setLightColorTemp = setLightColorTemp;

window.setHumidifierState = setHumidifierState;
window.setHumidifierTargetHumidity = setHumidifierTargetHumidity;
window.adjustHumidifierTargetHumidity = adjustHumidifierTargetHumidity;
window.promptHumidifierTargetHumidity = promptHumidifierTargetHumidity;

window.sendCoverCommand = sendCoverCommand;
window.sendLockCommand = sendLockCommand;
window.sendLawnMowerCommand = sendLawnMowerCommand;

window.toggleSwitch = toggleSwitch;
window.pressButtonEntity = pressButtonEntity;
window.setNumberEntity = setNumberEntity;
window.setTextEntity = setTextEntity;

const customId = getCustomDashboardIdFromUrl();

// 4️⃣ starten
init();

setInterval(checkForUpdates, 60_000);

window.addEventListener('popstate', () => {
    const customId = getCustomDashboardIdFromUrl();

    if (customId) {
        showView('dashboard', {
            customDashboardId: customId,
            updateUrl: false
        });
    } else {
        showView('home', {
            updateUrl: false
        });
    }
});

function getViewFromUrl() {
    const url = window.location.pathname;
    switch (url) {
        case '/live':
            return 'live';
        case '/settings':
            return 'settings';
        default:
        return 'home';
    }
}

const loginBtn = document.getElementById("loginBtn");
const modal = document.getElementById("loginModal");

const createBlock = document.getElementById("loginCreateBlock");
const existingBlock = document.getElementById("loginExistingBlock");
const title = document.getElementById("loginTitle");
const errorBox = document.getElementById("loginError");

loginBtn.addEventListener("click", () => {
  const isLoggedIn = localStorage.getItem("isLoggedIn");

  // 🔐 bereits eingeloggt → Logout fragen
  if (isLoggedIn) {
    const confirmLogout = confirm("Möchtest du dich ausloggen?");
    
    if (confirmLogout) {
      setLoggedIn(false);
    }

    return;
  }

  // 🔑 nicht eingeloggt → Login öffnen
  openLoginModal();
});

document.getElementById("closeLoginModal").onclick = () => {
  modal.classList.add("hidden");
};

async function openLoginModal() {
    errorBox.textContent = "";

    const res = await fetch("/api/admin/exists");
    const data = await res.json();

    modal.classList.remove("hidden");

    if (!data.exists) {
        title.textContent = "Admin erstellen";
        createBlock.classList.remove("hidden");
        existingBlock.classList.add("hidden");
    } else {
        title.textContent = "Login";
        createBlock.classList.add("hidden");
        existingBlock.classList.remove("hidden");
    }
}

function updateAuthUI(isLoggedIn, adminExists) {
    const settingsBtn = document.getElementById("openSettingsBtn");
    const editBtn = document.getElementById("dashboardEditModeBtn");
    const sidebar = document.querySelector(".sidebar");
    const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');

    if (adminExists && !isLoggedIn) {
        settingsBtn?.classList.add("hidden-auth");
        editBtn?.classList.add("hidden-auth");
        //sidebar?.classList.add("hidden-auth");
        //sidebarToggleBtn?.classList.add("hidden-auth");
        appLayout.classList.add("no-sidebar");
    } else {
        settingsBtn?.classList.remove("hidden-auth");
        editBtn?.classList.remove("hidden-auth");
        //sidebar?.classList.remove("hidden-auth");
        //sidebarToggleBtn?.classList.remove("hidden-auth");
        appLayout.classList.remove("no-sidebar");
    }
}

document.getElementById("createAdminBtn").onclick = async () => {
    const p1 = document.getElementById("newPassword1").value;
    const p2 = document.getElementById("newPassword2").value;

    if (!p1 || !p2) {
        return errorBox.textContent = "Bitte beide Felder ausfüllen";
    }

    if (p1 !== p2) {
        return errorBox.textContent = "Passwörter stimmen nicht überein";
    }

    const res = await fetch("/api/admin/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: p1 })
    });
    const data = await res.json();

    if (!res.ok) {
    return errorBox.textContent = data.error || "Fehler";
    }

    modal.classList.add("hidden");
    setLoggedIn(true);
};

document.getElementById("loginSubmitBtn").onclick = async () => {
  const passwordInput = document.getElementById("loginPassword"); // 👈 NEU
  const input = passwordInput.value;

  try { // 👈 NEU
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ password: input })
    });

    const data = await res.json();

    if (!res.ok) { // 👈 NEU
      errorBox.textContent = data.error || "Falsches Passwort";
      passwordInput.value = ""; // 👈 NEU
      return; // 👈 NEU
    }

    // Erfolg
    modal.classList.add("hidden");
    setLoggedIn(true);
    passwordInput.value = ""; // 👈 NEU

  } catch (err) { // 👈 NEU
    errorBox.textContent = "Netzwerkfehler";
  }
};

function setLoggedIn(state) {
    if (state) {
        loginBtn.classList.add("logged-in");
        loginBtn.title = "Logout";

        localStorage.setItem("isLoggedIn", "true");
    } else {
        loginBtn.classList.remove("logged-in");
        loginBtn.title = "Login";

        localStorage.removeItem("isLoggedIn");
    }

    updateAuthUI(state, true);
}

// beim Laden prüfen
if (localStorage.getItem("isLoggedIn")) {
  setLoggedIn(true);
}

loginBtn.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    console.log("erfolgreicht gelöscht");
    const confirmReset = confirm("Admin wirklich komplett zurücksetzen?");
    if (!confirmReset) return;

    try {
        const res = await fetch("/api/admin/reset", {
            method: "POST"
        });

        const data = await res.json();

        if (data.success) {
            localStorage.removeItem("isLoggedIn");
            loginBtn.classList.remove("logged-in");
            loginBtn.title = "Login";

            alert("Admin + Login zurückgesetzt");
        } else {
            alert(data.error || "Fehler beim Reset");
        }
    } catch (err) {
        console.error(err);
        alert("Serverfehler beim Reset");
    }
});

async function init() {
    // 1️⃣ Daten laden (WICHTIG!)
    await loadConfig();

    // 2️⃣ Danach View anzeigen
    if (customId) {
        showView('dashboard', {
            customDashboardId: customId,
            updateUrl: false
        });
    } else {
        showView(getViewFromUrl(), {
            updateUrl: false
        });
    }

    // 3️⃣ Rest
    loadVersion();
    checkForUpdates();
    applyInitialMobileSidebarState();
    messageCountEl.textContent = totalMessages;
    totalMessagesEl.textContent = totalMessages;

    const res = await fetch("/api/admin/exists");
    const data = await res.json();

    const isLoggedIn = localStorage.getItem("isLoggedIn") === "true";

    updateAuthUI(isLoggedIn, data.exists);

    document.addEventListener('click', (e) => {

        const settingsBtn = e.target.closest('#openSettingsBtn');
        if (settingsBtn) {
            showView('settings');
            return;
        }

        const renameBtn = e.target.closest('.action-rename-dashboard');
        if (renameBtn) {
            renameDashboard(renameBtn.dataset.dashboardId);
            return;
        }

        const duplicateBtn = e.target.closest('.action-duplicate-dashboard');
        if (duplicateBtn) {
            duplicateDashboard(duplicateBtn.dataset.dashboardId);
            return;
        }
    });

}