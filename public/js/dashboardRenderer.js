import {
  escapeHtml,
  shortenMiddleSmart,
  rgbToHex,
  translateLockState,
  translateCoverState,
  translateHumidifierDeviceClass,
  translateLawnMowerActivity
} from './utils.js';

export function createDashboardRenderer(deps) {
  const {
    getCustomDashboards,
    getDashboardDevices,
    getFriendlyNames,
    getActiveCustomDashboardId,
    getDashboardEditMode,
    isEntityTypeVisible,
    getDiscoveryPrefixes,
    customDashboardsNav,
    customDashboardsNavList,
    dashboardView,
    decodedDataBoxEl,
    setupDashboardDragAndDrop,
    getDeviceDisplayName,
    getEntityDisplayName,
    getLightStateValue,
    updateClimateSliderBubble,
    updateHumidifierSliderBubble,
    moveDevice
  } = deps;

    function setupSettingsDragAndDrop(container, dashboardId) {
        let draggedId = null;

        const cards = container.querySelectorAll('.custom-dashboard-device-card');

        cards.forEach((card) => {

            card.addEventListener('dragstart', (e) => {
                draggedId = card.dataset.deviceId;
                card.classList.add('dragging');

                e.dataTransfer.effectAllowed = 'move';
            });

            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
                draggedId = null;

                document.querySelectorAll('.custom-dashboard-device-card')
                    .forEach(c => c.classList.remove('drag-over'));
            });

            card.addEventListener('dragover', (e) => {
                e.preventDefault();

                if (!draggedId) return;

                card.classList.add('drag-over');
            });

            card.addEventListener('dragleave', () => {
                card.classList.remove('drag-over');
            });

            card.addEventListener('drop', (e) => {
                e.preventDefault();

                const targetId = card.dataset.deviceId;

                document.querySelectorAll('.custom-dashboard-device-card')
                    .forEach(c => c.classList.remove('drag-over'));

                if (!draggedId || draggedId === targetId) return;

                // 👉 nutzt DEINE bestehende Funktion
                moveDevice(draggedId, targetId, dashboardId);
            });
        });
    }

    function renderRenameEntityButton(entityId) {
        const activeCustomDashboardId = getActiveCustomDashboardId();
        const dashboardEditMode = getDashboardEditMode();

        if (!activeCustomDashboardId || !dashboardEditMode) {
            return '';
        }

        return `
        <button
            type="button"
            class="btn secondary small-btn rename-btn action-rename-entity"
            data-entity-id="${escapeHtml(entityId)}"
            title="Entität umbenennen"
        >
            ✏️
        </button>
        `;
    }

    function renderDashboardDeviceSelector(dashboard, openDeviceKeys = new Set()) {
        const dashboardDevices = getDashboardDevices();
        const friendlyNames = getFriendlyNames();
        if (!dashboardDevices || !dashboardDevices.length) {
        return '<div class="muted">Keine Geräte verfügbar</div>';
        }

        const selectedDeviceIds = new Set((dashboard.devices || []).map(d => d.deviceId));

        const availableDevices = dashboardDevices
        .filter(device => !selectedDeviceIds.has(device.id))
        .sort((a, b) => {
            const nameA = getDeviceDisplayName(a).toLowerCase();
            const nameB = getDeviceDisplayName(b).toLowerCase();
            return nameA.localeCompare(nameB, 'de');
        });

        return `
        <div class="custom-dashboard-add-device">
            <select id="deviceSelect-${dashboard.id}">
            <option value="">Gerät auswählen...</option>
                ${availableDevices.map(device => {
                    const friendly = friendlyNames.devices[device.id];
                    const original = device.name || device.id;

                    const label = friendly && friendly !== original
                        ? `${friendly} (${original})`
                        : original;

                    return `
                        <option value="${escapeHtml(device.id)}">
                            ${escapeHtml(label)}
                        </option>
                    `;
                }).join('')}
            </select>

            <button class="btn primary" onclick="addDeviceToCustomDashboard('${dashboard.id}')">
            Gerät hinzufügen
            </button>
            <button class="btn secondary" onclick="addAllDevicesToCustomDashboard('${dashboard.id}')">
            Alle hinzufügen
            </button>
            <button class="btn danger" onclick="removeAllDevicesFromCustomDashboard('${dashboard.id}')">
            Alle entfernen
            </button>
        </div>

        <div class="custom-dashboard-device-list">
            ${(dashboard.devices || []).map(deviceConfig => {
            const device = dashboardDevices.find(d => d.id === deviceConfig.deviceId);

            if (!device) {
                return `
                <div class="custom-dashboard-device-card">
                    <div class="muted">Gerät nicht gefunden: ${escapeHtml(deviceConfig.deviceId)}</div>
                </div>
                `;
            }

            return renderCustomDashboardDeviceCard(dashboard, device, openDeviceKeys);
            }).join('')}
        </div>
        `;
    }

    function renderSensorEntity(entity) {
        return `
        <div class="dashboard-entity-row-block sensor-entity-block" id="entity-${entity.id}">
            <div class="sensor-row-line">
            <div class="sensor-name-wrap">
                <span class="sensor-name" title="${escapeHtml(getEntityDisplayName(entity))}">
                ${escapeHtml(shortenMiddleSmart(getEntityDisplayName(entity), 200))}
                </span>

                ${renderRenameEntityButton(entity.id)}
            </div>

            <strong class="sensor-value">
                ${escapeHtml(formatSensorValue(entity))}
            </strong>
            </div>
        </div>
        `;
    }

    function renderBinarySensorEntity(entity) {
        const isOn = Boolean(entity.value);
        const cls = String(entity.deviceClass || '').toLowerCase();

        let text = '';
        let colorClass = '';

        if (['door', 'window', 'opening', 'garage_door'].includes(cls)) {
        text = isOn ? 'Offen' : 'Geschlossen';
        colorClass = isOn ? 'danger' : 'ok';
        }
        else if (['motion', 'presence'].includes(cls)) {
        text = isOn ? 'Bewegung erkannt' : 'Keine Bewegung';
        colorClass = isOn ? 'danger' : 'ok';
        }
        else if (cls === 'lock') {
        text = isOn ? 'Verriegelt' : 'Entriegelt';
        colorClass = isOn ? 'ok' : 'danger';
        }
        else if (['smoke', 'moisture'].includes(cls)) {
        text = isOn ? 'Alarm' : 'OK';
        colorClass = isOn ? 'danger' : 'ok';
        }
        else {
        text = isOn ? 'An' : 'Aus';
        colorClass = isOn ? 'danger' : 'ok';
        }

        return `
        <div class="dashboard-entity-row-block binary-sensor-entity-block" id="entity-${entity.id}">
            <div class="sensor-row-line">
            <div class="sensor-name-wrap">
                <span class="sensor-name">
                    ${escapeHtml(getEntityDisplayName(entity))}
                </span>
                ${renderRenameEntityButton(entity.id)}
            </div>

            <strong class="sensor-value ${colorClass}">
                ${text}
            </strong>
            </div>
        </div>
        `;
    }

    function renderSwitchEntity(entity) {
        const isOn = Boolean(entity.value);

        return `
        <div class="dashboard-entity-row-block switch-entity-block" id="entity-${entity.id}">
            <div class="sensor-row-line">
                <div class="sensor-name-wrap">
                    <span class="sensor-name">
                        ${escapeHtml(getEntityDisplayName(entity))}
                    </span>
                    ${renderRenameEntityButton(entity.id)}
                </div>

                <label class="switch">
                    <input 
                    type="checkbox" 
                    ${isOn ? 'checked' : ''}
                    onchange="toggleSwitch('${entity.id}', this.checked)"
                    >
                    <span class="slider"></span>
                </label>
            </div>
        </div>
        `;
    }

    function renderButtonEntity(entity) {
        return `
        <div class="dashboard-entity-row-block button-entity-block" id="entity-${entity.id}">
            <div class="sensor-row-line">

                <div class="sensor-name-group">
                    <span class="sensor-name">
                        ${escapeHtml(getEntityDisplayName(entity))}
                    </span>

                    ${renderRenameEntityButton(entity.id)}
                </div>

                <button class="lock-action-btn button-inline-action"
                    onclick="pressButtonEntity('${entity.id}', this)">
                    Ausführen
                </button>

            </div>
        </div>
        `;
    }

    function renderNumberEntity(entity) {
        const rawValue = entity.value ?? '';
        const value = rawValue === '' || rawValue === null ? '' : Number(rawValue);
        const hasMinMax = entity.min !== null && entity.min !== undefined &&
                        entity.max !== null && entity.max !== undefined;

        const min = Number(entity.min);
        const max = Number(entity.max);
        const step = Number(entity.step ?? 1);
        const unit = entity.unit || '';

        return `
        <div class="dashboard-entity-row-block number-entity-block" id="entity-${entity.id}">
            <div class="dashboard-control-row">
            <span class="dashboard-label">
                ${escapeHtml(getEntityDisplayName(entity))}
                ${renderRenameEntityButton(entity.id)}
            </span>
            <div class="number-control">
                ${hasMinMax ? `
                <div class="dashboard-slider-wrap">
                    <div class="dashboard-slider-bubble hidden"></div>
                    <div class="slider-minmax">
                    <span>${min}</span>
                    <span>${max}</span>
                    </div>
                    <input
                    type="range"
                    min="${min}"
                    max="${max}"
                    step="${step}"
                    value="${value === '' ? min : value}"
                    data-unit="${escapeHtml(unit)}"
                    class="dashboard-range"
                    oninput="handleDashboardSliderInput(this); this.closest('.number-control').querySelector('.number-input').value = this.value"
                    onmousedown="handleDashboardSliderStart(this)"
                    onmouseup="handleDashboardSliderEnd(this)"
                    ontouchstart="handleDashboardSliderStart(this)"
                    ontouchend="handleDashboardSliderEnd(this)"
                    onchange="setNumberEntity('${entity.id}', this.value)"
                    >
                </div>
                ` : ''}

                <input
                type="number"
                class="number-input"
                ${hasMinMax ? `min="${min}" max="${max}"` : ''}
                step="${step}"
                value="${value}"
                onchange="setNumberEntity('${entity.id}', this.value)"
                >

                ${unit ? `<span class="number-unit">${escapeHtml(unit)}</span>` : ''}
            </div>
            </div>
        </div>
        `;
    }

    function renderTextEntity(entity) {
        return `
        <div class="dashboard-entity-row-block text-entity-block" id="entity-${entity.id}">
            <div class="dashboard-control-row">
            <span class="dashboard-label">
                ${escapeHtml(getEntityDisplayName(entity))}
                ${renderRenameEntityButton(entity.id)}
            </span>

            <div class="text-control">
                <input
                type="text"
                class="text-input"
                value="${escapeHtml(entity.value ?? '')}"
                onchange="setTextEntity('${entity.id}', this.value)"
                >
            </div>
            </div>
        </div>
        `;
    }

    function renderClimateEntity(entity) {
        const modes = Array.isArray(entity.modes) ? entity.modes : [];
        const currentMode = entity.mode || 'off';
        const currentTemp = Number(entity.currentTemperature ?? 0);
        const targetTemp = Number(entity.targetTemperature ?? entity.minTemp ?? 20);
        const minTemp = Number(entity.minTemp ?? 6);
        const maxTemp = Number(entity.maxTemp ?? 30);
        const tempStep = Number(entity.tempStep ?? 0.1);

        return `
        <div class="dashboard-entity-row-block climate-entity-block" id="entity-${entity.id}">
            <div class="dashboard-entity-title">
                ${escapeHtml(getEntityDisplayName(entity))}
                ${renderRenameEntityButton(entity.id)}
            </div>

            <div class="climate-current-line">
            Isttemperatur <strong>${currentTemp.toFixed(1)} °C</strong>
            </div>

            <div class="climate-target-panel">
            <div class="climate-target-label">Solltemperatur</div>

            <button
                type="button"
                class="climate-target-value-btn"
                onclick="promptClimateTargetTemperature('${entity.id}')"
                title="Solltemperatur direkt eingeben"
            >
                <span class="climate-target-value">${targetTemp.toFixed(1)} °C</span>
            </button>

            <div class="dashboard-slider-wrap">
                <div class="dashboard-slider-bubble hidden"></div>
                <div class="slider-minmax">
                <span>${minTemp}</span>
                <span>${maxTemp}</span>
                </div>
                <input
                type="range"
                min="${minTemp}"
                max="${maxTemp}"
                step="${tempStep}"
                value="${targetTemp}"
                class="dashboard-range climate-temp-range"
                oninput="handleDashboardSliderInput(this)"
                onmousedown="handleDashboardSliderStart(this)"
                onmouseup="handleDashboardSliderEnd(this)"
                ontouchstart="handleDashboardSliderStart(this)"
                ontouchend="handleDashboardSliderEnd(this)"
                onchange="setClimateTargetTemperature('${entity.id}', this.value)"
                >
            </div>

            <div class="climate-adjust-row">
                <button
                class="climate-adjust-btn"
                onclick="adjustClimateTargetTemperature('${entity.id}', -${tempStep})"
                type="button"
                >
                −
                </button>

                <button
                class="climate-adjust-btn"
                onclick="adjustClimateTargetTemperature('${entity.id}', ${tempStep})"
                type="button"
                >
                +
                </button>
            </div>
            </div>

            <div class="climate-mode-row">
            ${modes.map((modeName) => `
                <button
                type="button"
                class="climate-mode-btn ${currentMode === modeName ? 'active' : ''}"
                onclick="setClimateMode('${entity.id}', '${escapeHtml(modeName)}')"
                >
                ${escapeHtml(modeName)}
                </button>
            `).join('')}
            </div>
        </div>
        `;
    }

    function renderDiscoveryPrefixes() {
        const discoveryPrefixes = getDiscoveryPrefixes();
        const list = document.getElementById('discoveryPrefixList');
        if (!list) return;

        list.innerHTML = '';

        discoveryPrefixes.forEach((p, index) => {
        const row = document.createElement('div');
        row.className = 'prefix-row';

        row.innerHTML = `
            <span>${p.value}</span>

            <div class="prefix-actions">
            <button class="btn secondary" onclick="togglePrefix(${index})">
                ${p.enabled ? 'Aktiv' : 'Inaktiv'}
            </button>

            <button class="btn danger" onclick="removePrefix(${index})">
                Entfernen
            </button>
            </div>
        `;

        list.appendChild(row);
        });
    }

    function renderLightEntity(entity) {
        const isOn = getLightStateValue(entity.value);
        const brightness = entity.value?.brightness ?? 0;
        const brightnessMax = entity.brightnessScale || 255;
        const hasBrightness = Boolean(entity.brightness);
        const currentEffect = entity.value?.effect || '';
        const effectList = Array.isArray(entity.effectList)
        ? entity.effectList
            .map((effectName) => String(effectName || '').trim())
            .filter((effectName) => effectName !== '' && effectName.toLowerCase() !== 'kein effekt')
        : [];
        const hasEffects = effectList.length > 0;

        const supportedColorModes = Array.isArray(entity.supportedColorModes)
        ? entity.supportedColorModes
        : [];
        const hasRgbColor = supportedColorModes.includes('rgb');
        const hasColorTemp = supportedColorModes.includes('color_temp');

        const currentColor = entity.value?.color || {};
        const currentHexColor = rgbToHex(
        currentColor.r ?? 255,
        currentColor.g ?? 255,
        currentColor.b ?? 255
        );

        const currentColorTemp = Number(entity.value?.color_temp ?? 3223);
        const minColorTemp = 2000;
        const maxColorTemp = 6535;

        return `
        <div class="dashboard-entity-row-block" id="entity-${entity.id}">
            <div class="dashboard-entity-title">
                ${escapeHtml(getEntityDisplayName(entity))}
                ${renderRenameEntityButton(entity.id)}
            </div>

            <div class="dashboard-control-row">
            <span class="dashboard-label">Aus / An</span>
            <label class="switch">
                <input
                type="checkbox"
                ${isOn ? 'checked' : ''}
                onchange="toggleLightEntity('${entity.id}', this.checked)"
                >
                <span class="slider"></span>
            </label>
            </div>

            ${hasBrightness ? `
            <div class="dashboard-control-row">
                <span class="dashboard-label">Helligkeit</span>

                <div class="dashboard-slider-wrap">
                <div class="dashboard-slider-bubble hidden"></div>
                <div class="slider-minmax">
                    <span>0</span>
                    <span>${brightnessMax}</span>
                </div>
                <input
                    type="range"
                    min="0"
                    max="${brightnessMax}"
                    value="${brightness}"
                    data-unit=""
                    class="dashboard-range"
                    oninput="handleDashboardSliderInput(this)"
                    onmousedown="handleDashboardSliderStart(this)"
                    onmouseup="handleDashboardSliderEnd(this)"
                    ontouchstart="handleDashboardSliderStart(this)"
                    ontouchend="handleDashboardSliderEnd(this)"
                    onchange="setLightBrightness('${entity.id}', this.value)"
                >
                </div>
            </div>
            ` : ''}

            ${hasRgbColor ? `
            <div class="dashboard-control-row color-row">
                <span class="dashboard-label">Farbe</span>
                <input
                type="color"
                class="dashboard-color-input"
                value="${currentHexColor}"
                onchange="setLightColor('${entity.id}', this.value)"
                >
            </div>
            ` : ''}

            ${hasColorTemp ? `
            <div class="dashboard-control-row">
                <span class="dashboard-label">Farbtemp</span>

                <div class="color-temp-wrap">
                <div class="dashboard-slider-wrap">
                    <div class="dashboard-slider-bubble hidden"></div>
                    <div class="slider-minmax">
                    <span>${minColorTemp}</span>
                    <span>${maxColorTemp}</span>
                    </div>
                    <input
                    type="range"
                    min="${minColorTemp}"
                    max="${maxColorTemp}"
                    value="${currentColorTemp}"
                    data-unit="K"
                    class="dashboard-range dashboard-color-temp-range"
                    oninput="handleDashboardSliderInput(this)"
                    onmousedown="handleDashboardSliderStart(this)"
                    onmouseup="handleDashboardSliderEnd(this)"
                    ontouchstart="handleDashboardSliderStart(this)"
                    ontouchend="handleDashboardSliderEnd(this)"
                    onchange="setLightColorTemp('${entity.id}', this.value)"
                    >
                </div>

                <span class="color-temp-value">${currentColorTemp} K</span>
                </div>
            </div>
            ` : ''}

            ${hasEffects ? `
            <div class="dashboard-control-row effect-row">
                <span class="dashboard-label">Effekt</span>
                <div class="effect-dropdown" data-entity="${entity.id}">
                <div class="effect-selected">
                    <span class="effect-selected-text">${escapeHtml(currentEffect || 'Kein Effekt')}</span>
                </div>

                <div class="effect-options">
                    <div class="effect-option ${currentEffect === '' ? 'active' : ''}" data-value="">
                    Kein Effekt
                    </div>
                    ${effectList.map((effectName) => `
                    <div
                        class="effect-option ${currentEffect === effectName ? 'active' : ''}"
                        data-value="${escapeHtml(effectName)}"
                    >
                        ${escapeHtml(effectName)}
                    </div>
                    `).join('')}
                </div>
                </div>
            </div>
            ` : ''}
        </div>
        `;
    }

    function renderCoverEntity(entity) {
        const position = Number(entity.position ?? 0);
        const rawState = String(entity.state || '').toUpperCase();
        const stateText = translateCoverState(rawState);
        const isGarage = entity.deviceClass === 'garage';

        const stateClass =
        rawState === 'OPEN' ? 'open' :
        rawState === 'CLOSED' ? 'closed' : '';

        return `
        <div class="dashboard-entity-row-block cover-entity-block" id="entity-${entity.id}">
            <<div class="dashboard-entity-title">
                ${escapeHtml(getEntityDisplayName(entity))}
                ${renderRenameEntityButton(entity.id)}
            </div>

            <div class="cover-status-line">
            Status
            <strong class="${stateClass}">
                ${escapeHtml(stateText)}
            </strong>
            </div>

            <div class="cover-buttons-row">
            <button
                type="button"
                class="cover-action-btn"
                onclick="sendCoverCommand('${entity.id}', 'OPEN')"
            >
                ${isGarage ? 'Öffnen' : 'Auf'}
            </button>

            <button
                type="button"
                class="cover-action-btn secondary"
                onclick="sendCoverCommand('${entity.id}', 'STOP')"
            >
                Stop
            </button>

            <button
                type="button"
                class="cover-action-btn"
                onclick="sendCoverCommand('${entity.id}', 'CLOSE')"
            >
                ${isGarage ? 'Schließen' : 'Zu'}
            </button>
            </div>

            <div class="dashboard-control-row">
            <span class="dashboard-label">Position</span>
            <div class="color-temp-wrap">
                <div class="slider-minmax">
                <span>0</span>
                <span>100</span>
                </div>
                <input
                type="range"
                min="0"
                max="100"
                step="1"
                value="${position}"
                class="dashboard-range cover-position-range"
                disabled
                >
                <span class="color-temp-value">${position} %</span>
            </div>
            </div>
        </div>
        `;
    }

    function renderLockEntity(entity) {
        const rawStateText = String(entity.state || '-').toUpperCase();
        const stateText = translateLockState(rawStateText);

        const isUnlocked = rawStateText === 'UNLOCKED';
        const isLocked = rawStateText === 'LOCKED';

        return `
        <div class="dashboard-entity-row-block lock-entity-block" id="entity-${entity.id}">
            <div class="dashboard-entity-title">
                ${escapeHtml(getEntityDisplayName(entity))}
                ${renderRenameEntityButton(entity.id)}
            </div>

            <div class="lock-status-line">
            Status
            <strong class="${isUnlocked ? 'lock-unlocked' : isLocked ? 'lock-locked' : ''}">
                ${escapeHtml(stateText)}
            </strong>
            </div>

            <div class="lock-buttons-row">
            <button
                type="button"
                class="lock-action-btn"
                onclick="sendLockCommand('${entity.id}', 'OPEN')"
            >
                Öffnen
            </button>

            <button
                type="button"
                class="lock-action-btn ${isLocked ? 'disabled-like' : ''}"
                onclick="sendLockCommand('${entity.id}', 'LOCK')"
            >
                Abschließen
            </button>

            <button
                type="button"
                class="lock-action-btn ${isUnlocked ? 'disabled-like' : ''}"
                onclick="sendLockCommand('${entity.id}', 'UNLOCK')"
            >
                Aufschließen
            </button>
            </div>
        </div>
        `;
    }

    function renderHumidifierEntity(entity) {
        const isOn = String(entity.state) === String(entity.stateOn);
        const currentHumidity = Number(entity.currentHumidity ?? 0);
        const targetHumidity = Number(entity.targetHumidity ?? entity.minHumidity ?? 40);
        const minHumidity = Number(entity.minHumidity ?? 30);
        const maxHumidity = Number(entity.maxHumidity ?? 80);
        const deviceTypeLabel = translateHumidifierDeviceClass(entity.deviceClass);

        return `
        <div class="dashboard-entity-row-block humidifier-entity-block" id="entity-${entity.id}">
            <div class="dashboard-entity-title">
                ${escapeHtml(getEntityDisplayName(entity))}
                ${renderRenameEntityButton(entity.id)}
            </div>

            <div class="dashboard-control-row">
            <span class="dashboard-label">An / Aus</span>
            <label class="switch">
                <input
                type="checkbox"
                ${isOn ? 'checked' : ''}
                onchange="setHumidifierState('${entity.id}', this.checked)"
                >
                <span class="slider"></span>
            </label>
            </div>

            <div class="climate-current-line">
            Istfeuchte <strong>${currentHumidity.toFixed(1)} %</strong>
            </div>

            <div class="climate-target-panel">
            <div class="climate-target-label">${escapeHtml(deviceTypeLabel)} Sollwert</div>

            <button
                type="button"
                class="climate-target-value-btn"
                onclick="promptHumidifierTargetHumidity('${entity.id}')"
                title="Sollfeuchte direkt eingeben"
            >
                <span class="climate-target-value">${targetHumidity.toFixed(0)} %</span>
            </button>

            <div class="dashboard-slider-wrap">
                <div class="dashboard-slider-bubble hidden"></div>
                <div class="slider-minmax">
                <span>${minHumidity}</span>
                <span>${maxHumidity}</span>
                </div>
                <input
                type="range"
                min="${minHumidity}"
                max="${maxHumidity}"
                step="1"
                value="${targetHumidity}"
                class="dashboard-range humidifier-range"
                oninput="handleDashboardSliderInput(this)"
                onmousedown="handleDashboardSliderStart(this)"
                onmouseup="handleDashboardSliderEnd(this)"
                ontouchstart="handleDashboardSliderStart(this)"
                ontouchend="handleDashboardSliderEnd(this)"
                onchange="setHumidifierTargetHumidity('${entity.id}', this.value)"
                >
            </div>
            <div class="climate-adjust-row">
                <button
                class="climate-adjust-btn"
                onclick="adjustHumidifierTargetHumidity('${entity.id}', -1)"
                type="button"
                >
                −
                </button>

                <button
                class="climate-adjust-btn"
                onclick="adjustHumidifierTargetHumidity('${entity.id}', 1)"
                type="button"
                >
                +
                </button>
            </div>
            </div>
        </div>
        `;
    }

    function renderLawnMowerEntity(entity) {
        const rawActivity = String(entity.activity || '-').toLowerCase();
        const activityText = translateLawnMowerActivity(rawActivity);

        const activityClass =
        rawActivity === 'mowing' ? 'mower-mowing' :
        rawActivity === 'paused' ? 'mower-paused' :
        rawActivity === 'docked' ? 'mower-docked' : '';

        const startClass = rawActivity === 'mowing' ? 'disabled-like' : '';
        const pauseClass = (rawActivity === 'paused' || rawActivity === 'docked') ? 'disabled-like' : '';
        const dockClass = rawActivity === 'docked' ? 'disabled-like' : '';

        return `
        <div class="dashboard-entity-row-block lawn-mower-entity-block" id="entity-${entity.id}">
            <div class="dashboard-entity-title">
                ${escapeHtml(getEntityDisplayName(entity))}
                ${renderRenameEntityButton(entity.id)}
            </div>

            <div class="lawn-mower-status-line">
            Status
            <strong class="${activityClass}">
                ${escapeHtml(activityText)}
            </strong>
            </div>

            <div class="lawn-mower-buttons-row">
            <button
                type="button"
                class="lawn-mower-action-btn ${startClass}"
                onclick="sendLawnMowerCommand('${entity.id}', 'start_mowing')"
            >
                Start
            </button>

            <button
                type="button"
                class="lawn-mower-action-btn ${pauseClass}"
                onclick="sendLawnMowerCommand('${entity.id}', 'pause')"
            >
                Pause
            </button>

            <button
                type="button"
                class="lawn-mower-action-btn ${dockClass}"
                onclick="sendLawnMowerCommand('${entity.id}', 'dock')"
            >
                Andocken
            </button>
            </div>
        </div>
        `;
    }

    function getDeviceIcons(device) {
        const entities = device.entities || [];

        if (entities.some(e => e.type === 'climate')) return '🌡️';

        const garageCover = entities.find(e => e.type === 'cover' && e.deviceClass === 'garage');
        if (garageCover) return '🚗';

        const cover = entities.find(e => e.type === 'cover');
        if (cover) {
        switch ((cover.deviceClass || '').toLowerCase()) {
            case 'door': return '🚪';
            case 'window': return '🪟';
            case 'shutter': return '🧱';
            case 'blind': return '🪄';
            case 'curtain': return '🧵';
            case 'gate': return '⛩️';
            default: return '🚪';
        }
        }

        if (entities.some(e => e.type === 'light')) return '💡';
        if (entities.some(e => e.type === 'lock')) return '🔒';
        if (entities.some(e => e.type === 'humidifier')) return '💧';
        if (entities.some(e => e.type === 'lawn_mower')) return '🤖';

        const binarySensors = entities.filter(e => e.type === 'binary_sensor');

        if (binarySensors.length) {
        if (binarySensors.some(e => ['door', 'opening'].includes((e.deviceClass || '').toLowerCase()))) return '🚪';
        if (binarySensors.some(e => (e.deviceClass || '').toLowerCase() === 'window')) return '🪟';
        if (binarySensors.some(e => (e.deviceClass || '').toLowerCase() === 'garage_door')) return '🚗';
        if (binarySensors.some(e => (e.deviceClass || '').toLowerCase() === 'motion')) return '🏃';
        if (binarySensors.some(e => (e.deviceClass || '').toLowerCase() === 'presence')) return '👤';
        if (binarySensors.some(e => (e.deviceClass || '').toLowerCase() === 'lock')) return '🔒';
        if (binarySensors.some(e => (e.deviceClass || '').toLowerCase() === 'smoke')) return '💨';
        if (binarySensors.some(e => (e.deviceClass || '').toLowerCase() === 'moisture')) return '💧';

        return '📟';
        }

        const sensors = entities.filter(e => e.type === 'sensor');

        if (sensors.length) {
        if (sensors.some(e => (e.deviceClass || '').toLowerCase() === 'temperature')) return '🌡️';
        if (sensors.some(e => (e.deviceClass || '').toLowerCase() === 'humidity')) return '💧';
        if (sensors.some(e => (e.deviceClass || '').toLowerCase() === 'battery')) return '🔋';
        if (sensors.some(e => (e.deviceClass || '').toLowerCase() === 'voltage')) return '🔋';
        if (sensors.some(e => (e.deviceClass || '').toLowerCase() === 'power')) return '⚡';
        if (sensors.some(e => (e.deviceClass || '').toLowerCase() === 'energy')) return '⚡';
        if (sensors.some(e => (e.deviceClass || '').toLowerCase() === 'illuminance')) return '☀️';
        if (sensors.some(e => (e.deviceClass || '').toLowerCase() === 'precipitation')) return '🌧️';
        if (sensors.some(e => (e.deviceClass || '').toLowerCase() === 'weight')) return '⚖️';

        return '📊';
        }

        return '📦';
    }

    function getViaDeviceClass(viaDevice) {
        const value = String(viaDevice || '').toLowerCase();

        if (value.startsWith('zigbee')) {
        return 'via-zigbee';
        }

        if (value.startsWith('lorawan')) {
        return 'via-lorawan';
        }

        return 'via-default';
    }

    function formatSensorValue(entity) {
        const value = entity.value ?? '-';
        const unit = entity.unit || '';

        if (value === '-' || value === null || value === undefined) {
        return '-';
        }

        const numericValue = Number(value);
        const hasSuggestedPrecision =
        entity.suggestedDisplayPrecision !== null &&
        entity.suggestedDisplayPrecision !== undefined &&
        entity.suggestedDisplayPrecision !== '';

        let displayValue = String(value);

        if (!Number.isNaN(numericValue)) {
        if (hasSuggestedPrecision) {
            displayValue = numericValue.toFixed(Number(entity.suggestedDisplayPrecision));
        } else {
            displayValue = numericValue.toFixed(3);
        }

        displayValue = displayValue
            .replace(/\.?0+$/, '');
        }

        return `${displayValue}${unit ? ' ' + unit : ''}`;
    }

    function renderDecodedData(payload) {
        const decodedCardEl = document.getElementById('decodedCard');
        const rawMessageCardEl = document.getElementById('rawMessageCard');

        let parsed;

        try {
        parsed = JSON.parse(payload);
        } catch {
        decodedCardEl.style.display = 'none';
        rawMessageCardEl.classList.add('full-width-card');
        return;
        }

        if (!parsed.object || Object.keys(parsed.object).length === 0) {
        decodedCardEl.style.display = 'none';
        rawMessageCardEl.classList.add('full-width-card');
        return;
        }

        decodedCardEl.style.display = 'block';
        rawMessageCardEl.classList.remove('full-width-card');

        const entries = Object.entries(parsed.object)
        .sort(([a], [b]) => a.localeCompare(b));

        decodedDataBoxEl.className = 'decoded-data';
        decodedDataBoxEl.innerHTML = entries.map(([key, value]) => `
        <div class="decoded-row">
            <div class="decoded-key">${key}</div>
            <div class="decoded-value">${value}</div>
        </div>
        `).join('');
    }

    function renderCustomDashboards() {
        const customDashboards = getCustomDashboards();
        const list = document.getElementById('customDashboardList');
        if (!list) return;

        const openDashboardIds = new Set(
        Array.from(list.querySelectorAll('.dashboard-config-block[open]'))
            .map(el => el.dataset.dashboardId)
            .filter(Boolean)
        );
        const openDeviceKeys = new Set(
        Array.from(list.querySelectorAll('.custom-dashboard-device-card[open]'))
            .map(el => el.dataset.deviceKey)
            .filter(Boolean)
        );

        list.innerHTML = '';

        if (!customDashboards.length) {
        list.innerHTML = '<div class="empty-state">Noch keine Dashboards angelegt</div>';
        return;
        }

        customDashboards.forEach((dashboard, index) => {
        const row = document.createElement('div');
        row.className = 'prefix-row';

        const isOpen = openDashboardIds.has(dashboard.id);

        row.innerHTML = `
            <details class="dashboard-config-block" data-dashboard-id="${escapeHtml(dashboard.id)}" ${isOpen ? 'open' : ''}>
            <summary class="dashboard-config-header">
                <div>
                <strong>${escapeHtml(dashboard.name)}</strong><br>
                <small class="muted">/dashboard/custom/${escapeHtml(dashboard.id)}</small>
                </div>

                <div class="prefix-actions">
                    <button 
                        class="btn secondary open-dashboard-btn"
                        data-dashboard-id="${escapeHtml(dashboard.id)}"
                    >
                        Öffnen
                    </button>

                    <button 
                        class="btn secondary action-rename-dashboard"
                        data-dashboard-id="${escapeHtml(dashboard.id)}"
                    >
                        ✏️
                    </button>

                    <button 
                        class="btn secondary action-duplicate-dashboard"
                        data-dashboard-id="${escapeHtml(dashboard.id)}"
                    >
                        📄
                    </button>

                    <button class="btn danger" onclick="event.preventDefault(); removeCustomDashboard(${index})">
                        Entfernen
                    </button>
                </div>
            </summary>

            <div class="dashboard-device-selector" id="devices-${escapeHtml(dashboard.id)}">
                ${renderDashboardDeviceSelector(dashboard, openDeviceKeys)}
            </div>
            </details>
        `;

        list.appendChild(row);
        const container = row.querySelector('.dashboard-device-selector');
        setupSettingsDragAndDrop(container, dashboard.id);
        });
    }

    function renderCustomDashboardDeviceCard(dashboard, device, openDeviceKeys = new Set()) {
        const deviceKey = `${dashboard.id}::${device.id}`;
        const isOpen = openDeviceKeys.has(deviceKey);
        const safeDashboardId = escapeHtml(dashboard.id);
        const safeDeviceId = escapeHtml(device.id);

        return `
            <details 
                class="custom-dashboard-device-card" 
                data-device-key="${escapeHtml(deviceKey)}"
                data-device-id="${safeDeviceId}"
                ${isOpen ? 'open' : ''}
                draggable="true"
            >
                <summary class="custom-device-summary">
                    <div class="custom-device-left">
                        <div class="custom-device-name-wrap">
                            <strong>${escapeHtml(getDeviceDisplayName(device))}</strong>

                            <button
                                type="button"
                                class="btn secondary small-btn rename-btn action-rename-device"
                                data-device-id="${safeDeviceId}"
                                title="Gerät umbenennen"
                            >
                                ✏️
                            </button>
                        </div>

                        <small class="muted">${escapeHtml(device.id)}</small>
                    </div>

                    <button
                        type="button"
                        class="btn danger small-btn"
                        onclick="event.preventDefault(); removeDeviceFromCustomDashboard('${safeDashboardId}', '${safeDeviceId}')"
                    >
                        Entfernen
                    </button>
                </summary>

                <div class="custom-dashboard-entities">
                    ${renderEntitySelector(dashboard, device)}
                </div>
            </details>
        `;
    }

    function renderCustomDashboardsNav() {
        const customDashboards = getCustomDashboards();
        const activeCustomDashboardId = getActiveCustomDashboardId();
        if (!customDashboardsNav || !customDashboardsNavList) return;

        if (!customDashboards.length) {
        customDashboardsNav.classList.add('hidden');
        customDashboardsNavList.innerHTML = '';
        return;
        }

        customDashboardsNav.classList.remove('hidden');

        customDashboardsNavList.innerHTML = customDashboards.map((dashboard) => {
        const isActive = activeCustomDashboardId === dashboard.id;

        return `
            <button
                type="button"
                class="nav-dashboard-item ${isActive ? 'active' : ''}"
                data-dashboard-id="${escapeHtml(dashboard.id)}"
            >
                ${escapeHtml(dashboard.name)}
            </button>
        `;
        }).join('');
    }

    function renderEntitySelector(dashboard, device) {
        const dashboardDevice = dashboard.devices.find(d => d.deviceId === device.id);
        const selectedEntities = dashboardDevice?.entityIds || [];

        if (!device.entities || !device.entities.length) {
        return '<div class="muted">Keine Entitäten vorhanden</div>';
        }

        return (device.entities || []).map(entity => {
        const checked = selectedEntities.includes(entity.id);

        return `
            <label class="custom-entity-checkbox">
            <input type="checkbox"
                ${checked ? 'checked' : ''}
                onchange="toggleDashboardEntity('${escapeHtml(dashboard.id)}', '${escapeHtml(device.id)}', '${escapeHtml(entity.id)}', this.checked)"
            >

            <span class="custom-entity-name-wrap">
                <span>${escapeHtml(getEntityDisplayName(entity))}</span>

            <button
                type="button"
                class="btn secondary small-btn rename-btn action-rename-entity"
                data-entity-id="${escapeHtml(entity.id)}"
                title="Entität umbenennen"
            >
                ✏️
            </button>
            </span>

            <small>${escapeHtml(entity.type)}</small>
            </label>
        `;
        }).join('');
    }

    function renderDashboardTabs() {
        const container = document.getElementById('dashboardTabs');
        if (!container) return;

        const customDashboards = getCustomDashboards();
        const activeId = getActiveCustomDashboardId();

        const isHomeActive = window.location.pathname === '/';
        const isLoggedIn = localStorage.getItem("isLoggedIn") === "true";

        let html = '';

        if (isLoggedIn) {
            html += `
                <button
                    class="dashboard-tab ${isHomeActive ? 'active' : ''}"
                    data-view="home"
                >
                    Home
                </button>
            `;
        }

        html += customDashboards.map(d => `
            <button
                class="dashboard-tab ${activeId === d.id ? 'active' : ''}"
                data-dashboard-id="${escapeHtml(d.id)}"
            >
                ${escapeHtml(d.name)}
            </button>
        `).join('');

        container.innerHTML = html;
    }

    function renderDashboard() {
        renderDashboardTabs();
        const customDashboards = getCustomDashboards();
        const dashboardDevices = getDashboardDevices();
        const friendlyNames = getFriendlyNames();
        const activeCustomDashboardId = getActiveCustomDashboardId();
        const dashboardEditMode = getDashboardEditMode();
        const dashboardGrid = document.getElementById('dashboardGrid');
        if (!dashboardGrid) return;

        if (!dashboardDevices.length) {
        dashboardGrid.innerHTML = '<div class="empty-cell">Noch keine Geräte erkannt</div>';
        return;
        }
        let devicesToRender = dashboardDevices;

        if (activeCustomDashboardId) {
        const customDashboard = customDashboards.find(d => d.id === activeCustomDashboardId);

        if (!customDashboard) {
            dashboardGrid.innerHTML = '<div class="empty-cell">Custom Dashboard nicht gefunden</div>';
            return;
        }

        devicesToRender = (customDashboard.devices || [])
        .map((dashboardDevice) => {
            const device = dashboardDevices.find(d => d.id === dashboardDevice.deviceId);

            if (!device) {
            return null;
            }

            return {
            ...device,
            entities: (device.entities || []).filter(entity =>
                dashboardDevice.entityIds.includes(entity.id)
            )
            };
        })
        .filter(Boolean);
        }
        let sortedDevices = [...devicesToRender];

        if (!activeCustomDashboardId) {
        sortedDevices = sortedDevices.sort((a, b) => {
            const nameA = getDeviceDisplayName(a).toLowerCase();
            const nameB = getDeviceDisplayName(b).toLowerCase();

            return nameA.localeCompare(nameB, 'de');
        });
        }

        dashboardGrid.innerHTML = sortedDevices.map((device) => {
        const visibleEntities = activeCustomDashboardId
            ? (device.entities || [])
            : (device.entities || []).filter((entity) =>
                isEntityTypeVisible(entity.type)
            );

        if (!visibleEntities.length) {
            return '';
        }

        const entitiesHtml = visibleEntities.map((entity) => {
            switch (entity.type) {
                case 'light':
                    return renderLightEntity(entity);

                case 'climate':
                    return renderClimateEntity(entity);

                case 'cover':
                    return renderCoverEntity(entity);

                case 'lock':
                    return renderLockEntity(entity);

                case 'humidifier':
                    return renderHumidifierEntity(entity);

                case 'lawn_mower':
                    return renderLawnMowerEntity(entity);

                case 'sensor':
                    return renderSensorEntity(entity);

                case 'binary_sensor':
                    return renderBinarySensorEntity(entity);

                case 'switch':
                    return renderSwitchEntity(entity);

                case 'button':
                    return renderButtonEntity(entity);

                case 'number':
                    return renderNumberEntity(entity);

                case 'text':
                    return renderTextEntity(entity);

                default:
                    console.warn('Unbekannter Entity-Typ:', entity.type, entity);
                    return '';
            }
        }).join('');

        const viaClass = getViaDeviceClass(device.viaDevice);
        const via = String(device.viaDevice || '').toLowerCase();
        const isZigbee = via.includes('zigbee');

        return `
            <div
            class="dashboard-device-card ${viaClass}"
            id="device-${device.id}"
            data-device-id="${escapeHtml(device.id)}"
            draggable="false"
            >
            <div class="dashboard-device-header">
                ${activeCustomDashboardId && dashboardEditMode ? `<div class="drag-handle" draggable="true" data-device-id="${escapeHtml(device.id)}" title="Verschieben">☰</div>` : ''}
                <div class="dashboard-device-icon">
                ${getDeviceIcons(device)}
                </div>

                <div class="dashboard-device-header-text">
                <div class="dashboard-device-name">
                    ${escapeHtml(
                    friendlyNames.devices[device.id] ||
                    device.name ||
                    device.id
                    )}
                </div>
                <div class="dashboard-device-subtitle">
                    Entitäten: ${escapeHtml(device.entityCount || 0)}
                </div>
                </div>

                ${activeCustomDashboardId && dashboardEditMode ? `
                <button
                    class="btn secondary small-btn action-rename-device"
                    data-device-id="${device.id}"
                    title="Umbenennen"
                >
                    ✏️
                </button>
                ` : ''}

                ${isZigbee ? `
                <div class="zigbee-badge">
                    <img src="/icons/Zigbee2MqttLogo.png" alt="Zigbee2MQTT">
                </div>
                ` : ''}
            </div>

            <div class="dashboard-device-body">
                ${entitiesHtml || '<div class="muted">Keine Entitäten</div>'}
            </div>
            </div>
        `;
        }).join('');

        dashboardGrid.querySelectorAll('.climate-temp-range').forEach((slider) => {
        updateClimateSliderBubble(slider);
        });

        dashboardGrid.querySelectorAll('.humidifier-range').forEach((slider) => {
        updateHumidifierSliderBubble(slider);
        });

        setupDashboardDragAndDrop();
    }

    return {
        renderDashboardDeviceSelector,
        renderSensorEntity,
        renderBinarySensorEntity,
        renderSwitchEntity,
        renderButtonEntity,
        renderNumberEntity,
        renderTextEntity,
        renderClimateEntity,
        renderDiscoveryPrefixes,
        renderLightEntity,
        renderCoverEntity,
        renderLockEntity,
        renderHumidifierEntity,
        renderLawnMowerEntity,
        getDeviceIcons,
        getViaDeviceClass,
        formatSensorValue,
        renderDecodedData,
        renderCustomDashboards,
        renderCustomDashboardDeviceCard,
        renderCustomDashboardsNav,
        renderEntitySelector,
        renderDashboard,
        renderDashboardTabs
    };
}