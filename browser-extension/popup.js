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
  normalizeServerUrl,
  normalizeBooleanValue,
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
const chartEntitySelect = document.getElementById('chartEntitySelect');
const chartRangeSelect = document.getElementById('chartRangeSelect');
const chartMetric = document.getElementById('chartMetric');
const chartSummary = document.getElementById('chartSummary');
const chartPanel = document.getElementById('chartPanel');
const chartCanvas = document.getElementById('historyChart');
const chartEmpty = document.getElementById('chartEmpty');

let currentItems = [];
let currentLayout = 'compact';
let sources = [];
let config = { ...DEFAULT_CONFIG };
let socket = null;
let saveTimer = null;
let saveSequence = 0;
let currentUser = '';
let draggedSourceId = null;
let historyChart = null;
let currentChartSourceId = '';
let currentChartHours = 24;
let chartReloadTimer = null;
let chartPointerActive = false;
let chartReloadPending = false;
let chartInteractionHoldUntil = 0;
let mqttConnected = null;
let mqttSnapshotTimer = null;

const CHART_RELOAD_DELAY_MS = 2500;
const CHART_INTERACTION_IDLE_MS = 7000;
const DISPLAY_MODE_KEY = 'displayMode';

openSidePanelBtn?.addEventListener('click', async () => {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    const isSidePanel = document.body.classList.contains('side-panel');

    if (isSidePanel) {
      await chrome.storage.local.set({ [DISPLAY_MODE_KEY]: 'popup' });
      await chrome.action.setPopup({ popup: 'popup.html' });
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

      if (chrome.sidePanel?.close) {
        await chrome.sidePanel.close({ windowId: currentWindow.id });
      } else {
        setStatus('Gelöst – dieses Panel bitte einmal über × schließen', 'warn');
      }
      return;
    }

    if (!chrome.sidePanel?.open) throw new Error('Side Panel nicht verfügbar');
    const persistMode = Promise.all([
      chrome.storage.local.set({ [DISPLAY_MODE_KEY]: 'sidePanel' }),
      chrome.action.setPopup({ popup: '' }),
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    ]);
    await chrome.sidePanel.open({ windowId: currentWindow.id });
    await persistMode;
    window.close();
  } catch (err) {
    setStatus(err?.message || 'Side Panel nicht verfügbar', 'warn');
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

function formatNumber(value, unit = '') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';

  const text = Math.abs(numeric) >= 100
    ? numeric.toFixed(0)
    : numeric.toFixed(2).replace(/\.?0+$/, '');

  return `${text}${unit ? ` ${unit}` : ''}`;
}

function formatDuration(seconds) {
  const duration = Math.max(0, Math.floor(seconds));
  if (duration < 60) return `${duration} Sek`;
  if (duration < 3600) return `${Math.floor(duration / 60)} Min`;

  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  return minutes ? `${hours} Std ${minutes} Min` : `${hours} Std`;
}

function formatChartTick(timestamp, hours = currentChartHours) {
  const date = new Date(Number(timestamp) * 1000);

  if (hours > 48) {
    return date.toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit'
    });
  }

  return date.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function setStatus(text, state = 'muted') {
  statusText.textContent = text;
  liveDot.className = `dot ${state}`;
}

function networkErrorMessage(err) {
  const message = String(err?.message || err || '');
  if (message.toLowerCase().includes('failed to fetch')) {
    return 'Server nicht erreichbar. Pruefe URL, HTTPS/Zertifikat und ob der Live-Server von Chrome erreichbar ist.';
  }

  return message || 'Verbindung fehlgeschlagen';
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

async function switchTab(tabId) {
  tabButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
  tabPanels.forEach(panel => panel.classList.toggle('active', panel.id === tabId));

  if (tabId !== 'editTab') {
    pickerPanel.classList.add('hidden');
  }

  if (tabId === 'chartTab') {
    await loadSelectedChart();
    setTimeout(() => historyChart?.resize(), 0);
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
    .map(item => {
      const chartEnabled = !!getChartItem(item.sourceId || item.id);
      const controlHtml = renderItemControl(item);

      return `
        <div
          class="quick-row ${chartEnabled ? 'clickable-chart' : ''} ${controlHtml ? 'has-control' : ''}"
          data-source-id="${escapeHtml(item.sourceId || item.id)}">

          <span class="quick-icon ${hasOpenStateBadge(item) ? 'has-alert-badge' : ''}">
            ${iconFor(inferStateIconName(item))}
          </span>

          <span class="quick-label">${escapeHtml(item.label || item.name)}</span>

          <strong class="quick-value">${escapeHtml(formatValue(item))}</strong>

          ${controlHtml}
        </div>
      `;
    })
    .join('');
}

function renderItemControl(item = {}) {
  const control = item.control;
  if (!control) return '';

  const sourceId = escapeHtml(item.sourceId || item.id);

  if (control.type === 'toggle') {
    const checked = normalizeBooleanValue(item.value) === true;
    return `
      <label class="quick-control quick-toggle" title="Schalten">
        <input type="checkbox" data-command-source="${sourceId}" data-command-action="${escapeHtml(control.action || 'set')}" ${checked ? 'checked' : ''}>
        <span></span>
      </label>
    `;
  }

  if (control.type === 'number') {
    const value = item.value === null || item.value === undefined || item.value === ''
      ? ''
      : String(item.value);
    const min = control.min === null || control.min === undefined ? '' : ` min="${escapeHtml(control.min)}"`;
    const max = control.max === null || control.max === undefined ? '' : ` max="${escapeHtml(control.max)}"`;
    const step = control.step === null || control.step === undefined ? '' : ` step="${escapeHtml(control.step)}"`;

    return `
      <form class="quick-control quick-number" data-command-source="${sourceId}" data-command-action="${escapeHtml(control.action || 'set')}">
        <input type="number" value="${escapeHtml(value)}"${min}${max}${step} aria-label="Wert">
        <button type="submit">OK</button>
      </form>
    `;
  }

  if (control.type === 'text') {
    const value = item.value === null || item.value === undefined ? '' : String(item.value);
    return `
      <form class="quick-control quick-text" data-command-source="${sourceId}" data-command-action="${escapeHtml(control.action || 'set')}">
        <input value="${escapeHtml(value)}" aria-label="Text">
        <button type="submit">OK</button>
      </form>
    `;
  }

  if (control.type === 'select') {
    const options = Array.isArray(control.options) ? control.options : [];
    if (!options.length) return '';

    const currentValue = String(item.value ?? '');
    return `
      <label class="quick-control quick-select">
        <select data-command-source="${sourceId}" data-command-action="${escapeHtml(control.action || 'set')}">
          ${options.map(option => {
            const value = String(option);
            return `
              <option value="${escapeHtml(value)}" ${value === currentValue ? 'selected' : ''}>
                ${escapeHtml(value)}
              </option>
            `;
          }).join('')}
        </select>
      </label>
    `;
  }

  if (control.type === 'buttons') {
    const actions = Array.isArray(control.actions) ? control.actions.filter(Boolean) : [];
    if (!actions.length) return '';

    return `
      <div class="quick-control quick-actions">
        ${actions.map(action => `
          <button type="button" data-command-source="${sourceId}" data-command-action="${escapeHtml(action)}">
            ${escapeHtml(commandLabel(action))}
          </button>
        `).join('')}
      </div>
    `;
  }

  if (control.type === 'button') {
    return `
      <button class="quick-control quick-button" type="button" data-command-source="${sourceId}" data-command-action="${escapeHtml(control.action || 'press')}">
        Ausloesen
      </button>
    `;
  }

  return '';
}

function commandLabel(action) {
  const labels = {
    OPEN: 'Auf',
    CLOSE: 'Zu',
    STOP: 'Stop',
    LOCK: 'Lock',
    UNLOCK: 'Unlock',
    start_mowing: 'Start',
    pause: 'Pause',
    dock: 'Dock'
  };

  return labels[action] || action;
}

async function sendExtensionCommand(sourceId, action = 'set', value = null) {
  await apiFetch('/api/extension/command', {
    method: 'POST',
    body: JSON.stringify({ sourceId, action, value })
  });

  setStatus('Befehl gesendet', 'ok');
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
  renderChartOptions();
}

function getChartItems() {
  const configuredLabels = new Map(
    config.items.map(item => [item.sourceId, item.label])
  );

  return sources
    .filter(item => item.historyEnabled && ['numeric', 'boolean'].includes(item.type))
    .map(item => ({
      ...item,
      label: configuredLabels.get(item.id) || item.label || item.name,
      sourceId: item.id
    }));
}

function getChartItem(sourceId = currentChartSourceId) {
  return getChartItems().find(item => item.sourceId === sourceId);
}

function renderChartOptions() {
  if (!chartEntitySelect) return;

  const chartItems = getChartItems();

  if (!chartItems.length) {
    chartEntitySelect.innerHTML = '<option value="">Keine History-Werte konfiguriert</option>';
    currentChartSourceId = '';
    setChartEmpty('Aktiviere History fuer einen numerischen oder boolschen Wert im Monitor.');
    return;
  }

  if (!currentChartSourceId || !chartItems.some(item => item.sourceId === currentChartSourceId)) {
    currentChartSourceId = chartItems[0].sourceId;
  }

  chartEntitySelect.innerHTML = chartItems.map(item => `
    <option value="${escapeHtml(item.sourceId)}" ${item.sourceId === currentChartSourceId ? 'selected' : ''}>
      ${escapeHtml(item.label || item.name || item.sourceId)}
    </option>
  `).join('');
}

function setChartEmpty(message) {
  chartMetric.textContent = '-';
  chartSummary.textContent = message;
  chartEmpty.textContent = message;
  chartEmpty.classList.remove('hidden');

  if (historyChart) {
    historyChart.destroy();
    historyChart = null;
  }
}

function setChartLoading(item) {
  chartMetric.textContent = item ? formatValue(item) : '-';
  chartSummary.textContent = 'Lade Verlauf...';
  chartEmpty.classList.add('hidden');
}

function updateChartLiveValue(sourceId) {
  if (!currentChartSourceId || sourceBaseId(currentChartSourceId) !== sourceBaseId(sourceId)) return;
  if (!document.getElementById('chartTab')?.classList.contains('active')) return;

  const item = getChartItem();
  if (!item) return;

  chartMetric.textContent = formatValue(item);
}

function buildNumericChartRows(rows) {
  return rows
    .map(row => ({
      x: Number(row.t),
      y: Number(row.avg),
      min: Number(row.min),
      max: Number(row.max)
    }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function isEnergyItem(item = {}) {
  const deviceClass = String(item.deviceClass || '').toLowerCase();
  const stateClass = String(item.stateClass || '').toLowerCase();
  const unit = String(item.unit || '').trim().toLowerCase().replace(/\s+/g, '');

  return deviceClass === 'energy'
    || ['wh', 'kwh', 'mwh'].includes(unit)
    || (stateClass === 'total_increasing' && ['wh', 'kwh', 'mwh'].includes(unit));
}

function buildEnergyChartRows(rows, key = 'positive_change') {
  return rows
    .map(row => ({
      x: Number(row.t),
      y: Number(row[key]) || 0
    }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function buildBooleanChartRows(rows, item) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (currentChartHours * 60 * 60);
  const points = [];

  if (!rows.length) {
    return points;
  }

  rows.forEach(row => {
    const value = normalizeBooleanValue(row.value);
    const timestamp = Math.max(windowStart, Number(row.t));
    if (value === null || !Number.isFinite(timestamp)) return;

    const last = points[points.length - 1];
    if (last && last.x === timestamp) {
      last.value = value;
      last.y = value ? 1 : 0;
      return;
    }

    points.push({
      x: timestamp,
      y: value ? 1 : 0,
      value
    });
  });

  const liveValue = normalizeBooleanValue(item?.value);
  if (liveValue !== null) {
    const last = points[points.length - 1];
    if (!last || last.value !== liveValue) {
      points.push({ x: now, y: liveValue ? 1 : 0, value: liveValue });
    } else if (last.x > now) {
      last.x = now;
    }
  }

  return points;
}

function numericSummary(points, item) {
  const values = points.map(point => point.y);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;

  chartMetric.textContent = formatValue(item);
  chartSummary.textContent = `Min ${formatNumber(min, item.unit)} | Mittel ${formatNumber(avg, item.unit)} | Max ${formatNumber(max, item.unit)}`;
}

function booleanSummary(points, item) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (currentChartHours * 60 * 60);
  const stats = {
    true: { count: 0, duration: 0 },
    false: { count: 0, duration: 0 }
  };

  points.forEach((point, index) => {
    const start = Math.max(point.x, windowStart);
    const end = Math.min(points[index + 1]?.x ?? now, now);
    if (end < windowStart || start > now) return;

    const key = point.value ? 'true' : 'false';
    stats[key].count += 1;
    stats[key].duration += Math.max(0, end - start);
  });

  chartMetric.textContent = formatValue(item);
  chartSummary.textContent =
    `An/Offen ${stats.true.count}x | ${formatDuration(stats.true.duration)} | Aus/Geschlossen ${stats.false.count}x | ${formatDuration(stats.false.duration)}`;
}

function energySummary(rows, item) {
  const positive = rows.reduce((sum, row) => sum + (Number(row.positive_change) || 0), 0);
  const negative = rows.reduce((sum, row) => sum + (Number(row.negative_change) || 0), 0);

  chartMetric.textContent = formatValue(item);
  chartSummary.textContent = negative > 0
    ? `Positiv ${formatNumber(positive, item.unit)} | Negativ ${formatNumber(negative, item.unit)}`
    : `Verbrauch ${formatNumber(positive, item.unit)}`;
}

function createBooleanBackgroundPlugin(points) {
  return {
    id: 'extensionBooleanBackground',
    beforeDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !points.length) return;

      ctx.save();
      points.forEach((point, index) => {
        const startX = scales.x.getPixelForValue(point.x);
        const endX = points[index + 1]
          ? scales.x.getPixelForValue(points[index + 1].x)
          : chartArea.right;

        ctx.fillStyle = point.value
          ? 'rgba(34, 197, 94, 0.72)'
          : 'rgba(239, 68, 68, 0.72)';
        ctx.fillRect(startX, chartArea.top, endX - startX, chartArea.bottom - chartArea.top);
      });
      ctx.restore();
    }
  };
}

function renderEnergyChart(rows, item) {
  const positivePoints = buildEnergyChartRows(rows, 'positive_change');
  const negativePoints = buildEnergyChartRows(rows, 'negative_change');
  const hasPositive = positivePoints.some(point => point.y > 0);
  const hasNegative = negativePoints.some(point => point.y > 0);

  if (!hasPositive && !hasNegative) {
    setChartEmpty('Noch keine Energie-Verlaufsdaten vorhanden.');
    return;
  }

  energySummary(rows, item);
  chartEmpty.classList.add('hidden');
  historyChart?.destroy();
  historyChart = new window.Chart(chartCanvas, {
    type: 'bar',
    data: {
      datasets: [
        {
          label: item.label || item.name || 'Energie',
          data: positivePoints,
          backgroundColor: 'rgba(37, 99, 235, 0.48)',
          borderColor: '#2563eb',
          borderWidth: 1
        },
        ...(hasNegative ? [{
          label: 'Negativ',
          data: negativePoints,
          backgroundColor: 'rgba(239, 68, 68, 0.42)',
          borderColor: '#ef4444',
          borderWidth: 1
        }] : [])
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: {
        mode: 'index',
        axis: 'x',
        intersect: false
      },
      plugins: {
        legend: { display: hasNegative },
        tooltip: {
          displayColors: true,
          callbacks: {
            title: ctx => new Date(ctx[0].parsed.x * 1000).toLocaleString('de-DE'),
            label: ctx => {
              const value = Number(ctx.parsed.y);
              if (!Number.isFinite(value) || value <= 0) return null;
              return `${ctx.dataset.label}: ${formatNumber(value, item.unit)}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          grid: { display: false },
          ticks: {
            maxTicksLimit: 6,
            callback: value => formatChartTick(value)
          }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(148, 163, 184, 0.18)' },
          ticks: {
            maxTicksLimit: 5,
            callback: value => formatNumber(value, item.unit)
          }
        }
      }
    }
  });
}

function renderNumericChart(rows, item) {
  const points = buildNumericChartRows(rows);
  if (!points.length) {
    setChartEmpty('Noch keine numerischen Verlaufsdaten vorhanden.');
    return;
  }

  numericSummary(points, item);
  chartEmpty.classList.add('hidden');
  historyChart?.destroy();
  historyChart = new window.Chart(chartCanvas, {
    type: 'line',
    data: {
      datasets: [{
        label: item.label || item.name || 'Wert',
        data: points,
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37, 99, 235, 0.12)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.28,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: {
        mode: 'index',
        axis: 'x',
        intersect: false
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: ctx => new Date(ctx[0].parsed.x * 1000).toLocaleString('de-DE'),
            label: ctx => `${item.label || item.name || 'Wert'}: ${formatNumber(ctx.parsed.y, item.unit)}`
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          grid: { display: false },
          ticks: {
            maxTicksLimit: 6,
            callback: value => formatChartTick(value)
          }
        },
        y: {
          grid: { color: 'rgba(148, 163, 184, 0.18)' },
          ticks: {
            maxTicksLimit: 5,
            callback: value => formatNumber(value, item.unit)
          }
        }
      }
    }
  });
}

function renderBooleanChart(rows, item) {
  const points = buildBooleanChartRows(rows, item);
  if (!points.length) {
    setChartEmpty('Noch keine boolschen Verlaufsdaten vorhanden.');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (currentChartHours * 60 * 60);

  booleanSummary(points, item);
  chartEmpty.classList.add('hidden');
  historyChart?.destroy();
  historyChart = new window.Chart(chartCanvas, {
    type: 'line',
    plugins: [createBooleanBackgroundPlugin(points)],
    data: {
      datasets: [{
        label: 'Status',
        data: points.map(point => ({ x: point.x, y: point.y })),
        borderColor: 'transparent',
        pointRadius: 0,
        stepped: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: ctx => new Date(ctx[0].parsed.x * 1000).toLocaleString('de-DE'),
            label: ctx => {
              const point = points[ctx.dataIndex];
              const end = points[ctx.dataIndex + 1]?.x ?? now;
              return [
                `Status: ${point.value ? 'true' : 'false'}`,
                `Von: ${new Date(point.x * 1000).toLocaleString('de-DE')}`,
                `Bis: ${new Date(end * 1000).toLocaleString('de-DE')}`,
                `Dauer: ${formatDuration(end - point.x)}`
              ];
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: windowStart,
          max: now,
          grid: { display: false },
          ticks: {
            maxTicksLimit: 6,
            callback: value => formatChartTick(value)
          }
        },
        y: {
          min: 0,
          max: 1,
          grid: { display: false },
          ticks: {
            stepSize: 1,
            callback: value => value === 1 ? 'true' : 'false'
          }
        }
      }
    }
  });
}

function historyAggregationSeconds() {
  const item = getChartItem();
  const bucketSeconds = Number(item?.historyBucketSeconds);
  const entityBucketSeconds = Number.isFinite(bucketSeconds) && bucketSeconds > 0
    ? bucketSeconds
    : 5 * 60;

  if (isEnergyItem(item)) {
    let desiredAggregation = 24 * 60 * 60;

    if (currentChartHours <= 3) {
      desiredAggregation = 5 * 60;
    } else if (currentChartHours <= 24) {
      desiredAggregation = 15 * 60;
    } else if (currentChartHours <= 24 * 7) {
      desiredAggregation = 60 * 60;
    }

    return Math.max(desiredAggregation, entityBucketSeconds);
  }

  return entityBucketSeconds;
}

async function loadSelectedChart() {
  if (!chartCanvas || !window.Chart) return;

  renderChartOptions();
  const item = getChartItem();

  if (!item) {
    setChartEmpty('Aktiviere History fuer einen numerischen oder boolschen Wert im Monitor.');
    return;
  }

  setChartLoading(item);

  try {
    const path = `/api/extension/history?sourceId=${encodeURIComponent(item.sourceId)}&hours=${currentChartHours}&aggregation=${historyAggregationSeconds()}`;
    const rows = await apiFetch(path);

    if (item.type === 'boolean') {
      renderBooleanChart(rows, item);
    } else if (isEnergyItem(item)) {
      renderEnergyChart(rows, item);
    } else {
      renderNumericChart(rows, item);
    }
  } catch (err) {
    setChartEmpty(networkErrorMessage(err) || 'Chart konnte nicht geladen werden.');
  }
}

function scheduleChartReload(sourceId) {
  if (!currentChartSourceId || sourceBaseId(currentChartSourceId) !== sourceBaseId(sourceId)) return;
  if (!document.getElementById('chartTab')?.classList.contains('active')) return;

  chartReloadPending = true;

  clearTimeout(chartReloadTimer);
  const interactionWait = Math.max(0, chartInteractionHoldUntil - Date.now());
  const delay = chartPointerActive
    ? CHART_INTERACTION_IDLE_MS
    : Math.max(CHART_RELOAD_DELAY_MS, interactionWait);

  chartReloadTimer = setTimeout(() => {
    chartReloadTimer = null;
    if (chartPointerActive || Date.now() < chartInteractionHoldUntil) {
      scheduleChartReload(currentChartSourceId);
      return;
    }

    chartReloadPending = false;
    loadSelectedChart().catch(() => {});
  }, delay);
}

function markChartInteraction() {
  chartInteractionHoldUntil = Date.now() + CHART_INTERACTION_IDLE_MS;

  if (!chartReloadPending || chartReloadTimer) return;
  scheduleChartReload(currentChartSourceId);
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
  const serverUrl = normalizeServerUrl(serverUrlInput.value);
  const username = usernameInput.value.trim();
  serverUrlInput.value = serverUrl;
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
  socket.on('mqtt-status', status => {
    const connected = status?.connected === true;
    setStatus(connected ? 'Live' : 'MQTT getrennt', connected ? 'ok' : 'warn');

    if (mqttConnected === connected) return;
    mqttConnected = connected;

    clearTimeout(mqttSnapshotTimer);
    loadSnapshot()
      .then(renderAll)
      .catch(() => {});

    // Direkt nach dem Subscribe koennen retained Discovery-Nachrichten noch
    // unterwegs sein. Ein zweiter Snapshot bringt dann Metadaten und Controls
    // der wieder verfuegbaren Entities zurueck.
    if (connected) {
      mqttSnapshotTimer = setTimeout(() => {
        loadSnapshot()
          .then(renderAll)
          .catch(() => {});
      }, 1000);
    }
  });
  socket.on('entity-update', data => {
    let changed = false;

    sources = sources.map(source => {
      if (sourceBaseId(source.id) !== data.entityId) return source;
      return applyEntityUpdate(source, data.entity);
    });

    currentItems = currentItems.map(item => {
      if (sourceBaseId(item.sourceId || item.id) !== data.entityId) return item;
      changed = true;
      return applyEntityUpdate(item, data.entity);
    });

    if (changed) {
      renderItems(currentLayout);
    }

    updateChartLiveValue(data.entityId);
    scheduleChartReload(data.entityId);
  });
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab).catch(err => setStatus(err.message, 'warn'));
  });
});

chartEntitySelect?.addEventListener('change', () => {
  currentChartSourceId = chartEntitySelect.value;
  loadSelectedChart().catch(err => setChartEmpty(err.message));
});

function syncChartRangeControls() {
  if (chartRangeSelect) {
    const hasOption = Array.from(chartRangeSelect.options)
      .some(option => Number(option.value) === currentChartHours);

    chartRangeSelect.value = hasOption ? String(currentChartHours) : '24';
  }
}

chartRangeSelect?.addEventListener('change', () => {
  currentChartHours = Number(chartRangeSelect.value) || 24;
  syncChartRangeControls();
  loadSelectedChart().catch(err => setChartEmpty(networkErrorMessage(err)));
});

chartPanel?.addEventListener('pointerenter', () => {
  chartPointerActive = true;
  markChartInteraction();

  if (chartReloadTimer) {
    clearTimeout(chartReloadTimer);
    chartReloadTimer = null;
    chartReloadPending = true;
  }
});

chartPanel?.addEventListener('pointermove', markChartInteraction);
chartPanel?.addEventListener('touchstart', markChartInteraction, { passive: true });
chartPanel?.addEventListener('wheel', markChartInteraction, { passive: true });

chartPanel?.addEventListener('pointerleave', () => {
  chartPointerActive = false;
  markChartInteraction();

  if (!chartReloadPending) return;
  scheduleChartReload(currentChartSourceId);
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
    setStatus(networkErrorMessage(err), 'warn');
  }
});

reloadBtn.addEventListener('click', async () => {
  try {
    const serverUrl = normalizeServerUrl(serverUrlInput.value);
    serverUrlInput.value = serverUrl;
    await setLocalSettings({ serverUrl, username: usernameInput.value.trim() });
    await loadData();
  } catch (err) {
    setStatus(networkErrorMessage(err), 'warn');
  }
});

content.addEventListener('click', async (event) => {
  const commandButton = event.target.closest('button[data-command-source]');
  if (commandButton) {
    event.preventDefault();
    event.stopPropagation();

    try {
      await sendExtensionCommand(
        commandButton.dataset.commandSource,
        commandButton.dataset.commandAction || 'set',
        true
      );
    } catch (err) {
      setStatus(networkErrorMessage(err), 'warn');
    }

    return;
  }

  if (event.target.closest('.quick-control')) return;

  const row = event.target.closest('.quick-row');
  if (!row) return;

  const sourceId = row.dataset.sourceId;
  if (!sourceId) return;

  const chartItem = getChartItem(sourceId);

  if (!chartItem) {
    return;
  }

  currentChartSourceId = sourceId;

  try {
    await switchTab('chartTab');
  } catch (err) {
    setStatus(err.message || 'Chart konnte nicht geladen werden', 'warn');
  }
});

content.addEventListener('change', async (event) => {
  const input = event.target.closest('.quick-toggle input[data-command-source]');
  const select = event.target.closest('.quick-select select[data-command-source]');
  const control = input || select;
  if (!control) return;

  try {
    await sendExtensionCommand(
      control.dataset.commandSource,
      control.dataset.commandAction || 'set',
      input ? input.checked : control.value
    );
  } catch (err) {
    if (input) input.checked = !input.checked;
    setStatus(networkErrorMessage(err), 'warn');
  }
});

content.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-command-source]');
  if (!form) return;

  event.preventDefault();

  const input = form.querySelector('input');
  const source = sourceById(form.dataset.commandSource) ||
    currentItems.find(item => (item.sourceId || item.id) === form.dataset.commandSource);
  const value = source?.control?.type === 'number'
    ? Number(input?.value)
    : input?.value;

  try {
    await sendExtensionCommand(
      form.dataset.commandSource,
      form.dataset.commandAction || 'set',
      value
    );
  } catch (err) {
    setStatus(networkErrorMessage(err), 'warn');
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
        <strong>${escapeHtml(networkErrorMessage(err))}</strong>
        <span>Pruefe Server-URL und Login in den Einstellungen.</span>
      </div>
    `;
    switchTab('settingsTab');
  }
}

init();
