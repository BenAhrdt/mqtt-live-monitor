export const DEFAULT_CONFIG = {
  layout: 'compact',
  items: []
};

const svg = (body, color = 'currentColor', bg = '#f8fafc') => `
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="--icon-bg:${bg}">
    ${body}
  </svg>
`;

export const ICONS = {
  activity: svg('<path d="M13 4l-2 5 4 3 2 6"/><path d="M9 20l2-5-3-3-3 2"/><circle cx="16" cy="3" r="1"/>', '#4f73df', '#eef3ff'),
  battery: svg('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M10 7h4"/><path d="M9 17h6"/>', '#4caf50', '#edf9ed'),
  blinds: svg('<path d="M4 5h16"/><path d="M6 9h12"/><path d="M7 13h10"/><path d="M8 17h8"/>', '#5b8def', '#eff6ff'),
  cloud: svg('<path d="M17.5 18H8a5 5 0 1 1 1.1-9.9A6 6 0 0 1 20 12.5 3.5 3.5 0 0 1 17.5 18z"/>', '#64748b', '#f1f5f9'),
  co2: svg('<path d="M17.5 17H8a5 5 0 1 1 1.2-9.8A6 6 0 0 1 20 11.8 3.5 3.5 0 0 1 17.5 17z"/><text x="7" y="15" font-size="5" fill="currentColor" stroke="none" font-family="Arial">CO2</text>', '#487844', '#eff9e9'),
  'circle-dot': svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="currentColor"/>', '#6366f1', '#eef2ff'),
  'door-open': svg('<path d="M6 21h12"/><path d="M8 21V5l8-2v18"/><path d="M11 12h.01"/>', '#a855f7', '#f5f0ff'),
  droplets: svg('<path d="M7 16a4 4 0 0 0 8 0c0-3-4-7-4-7s-4 4-4 7z"/><path d="M17 14c1.2-1.4 2-3 2-3s3 3 3 5a3 3 0 0 1-5 2.2"/>', '#0ea5e9', '#edf8ff'),
  fan: svg('<path d="M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0"/><path d="M12 10c0-4 2-7 4-7 1.5 0 2.5 1 2.5 2.5 0 2.5-3.5 4.5-6.5 4.5"/><path d="M14 13.5c3.5 2 5 4.5 4 6.3-.7 1.3-2 1.7-3.3 1-2.1-1.2-2.4-5.2-.7-7.3"/><path d="M10 13.5c-3.5 2-6.5 1.8-7.5 0C1.8 12.2 2.2 10.8 3.5 10c2.1-1.2 5.8.5 6.5 3.5"/>', '#14b8a6', '#ecfdf5'),
  gauge: svg('<path d="M5 19a8 8 0 1 1 14 0"/><path d="M12 14l4-4"/><path d="M8 19h8"/>', '#3f97cb', '#eef8ff'),
  leaf: svg('<path d="M5 21c8 0 14-6 14-14V4h-3C8 4 4 8 4 14c0 2 1 4 3 5"/><path d="M9 15c2-4 5-6 10-8"/>', '#22c55e', '#eefaf0'),
  lightbulb: svg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M8 14a6 6 0 1 1 8 0c-.8.7-1 1.5-1 2H9c0-.5-.2-1.3-1-2z"/>', '#f2a900', '#fff8db'),
  lock: svg('<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>', '#7c3aed', '#f5f0ff'),
  'panel-top': svg('<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/><path d="M12 10v9"/>', '#5b8def', '#eff6ff'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.93 19.07l1.41-1.41"/><path d="M17.66 6.34l1.41-1.41"/>', '#d9a300', '#fff8db'),
  thermometer: svg('<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>', '#ef4444', '#fff1f2'),
  timer: svg('<path d="M10 2h4"/><path d="M12 14l3-3"/><circle cx="12" cy="14" r="8"/>', '#3f97cb', '#eef8ff'),
  'toggle-left': svg('<rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="8" cy="12" r="3"/>', '#64748b', '#f1f5f9'),
  waves: svg('<path d="M3 8c2 2 4 2 6 0s4-2 6 0 4 2 6 0"/><path d="M3 13c2 2 4 2 6 0s4-2 6 0 4 2 6 0"/><path d="M3 18c2 2 4 2 6 0s4-2 6 0 4 2 6 0"/>', '#5b8def', '#eef6ff'),
  zap: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>', '#f97316', '#fff3e8')
};

export function normalizeServerUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

export async function getLocalSettings() {
  const data = await chrome.storage.local.get(['serverUrl', 'token']);
  return {
    serverUrl: normalizeServerUrl(data.serverUrl),
    token: data.token || ''
  };
}

export async function setLocalSettings(settings) {
  const next = {};

  if (settings.serverUrl !== undefined) {
    next.serverUrl = normalizeServerUrl(settings.serverUrl);
  }

  if (settings.token !== undefined) {
    next.token = settings.token || '';
  }

  await chrome.storage.local.set(next);
}

export async function apiFetch(path, options = {}) {
  const { serverUrl, token } = await getLocalSettings();

  if (!serverUrl) {
    throw new Error('Server-URL fehlt');
  }

  const res = await fetch(`${serverUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export function iconFor(name) {
  const icon = ICONS[name] || ICONS.gauge;
  const bg = icon.match(/--icon-bg:([^"]+)"/)?.[1] || '#f8fafc';
  return `<span class="icon-art" style="--icon-bg:${bg}">${icon}</span>`;
}

export function inferIconName(item = {}) {
  const text = [
    item.label,
    item.name,
    item.deviceName,
    item.sourceId,
    item.id
  ].join(' ').toLowerCase();
  const unit = String(item.unit || '').toLowerCase();
  const given = item.icon || '';

  if (text.includes('co2') || text.includes('carbon')) return 'co2';
  if (text.includes('battery') || text.includes('batterie') || text.includes('akku')) return 'battery';
  if (text.includes('intervall') || text.includes('interval') || unit === 'min') return 'timer';
  if (text.includes('pv') || text.includes('solar')) return 'sun';
  if (text.includes('leistung') || text.includes('power') || text.includes('netz') || unit === 'w' || unit === 'kw') return 'zap';
  if (text.includes('wasser') || text.includes('pool') || text.includes('water')) return 'waves';
  if (text.includes('garten') || text.includes('garden')) return 'leaf';
  if (text.includes('luftfeuchtigkeit') || text.includes('humidity') || text.includes('feuchte')) return 'droplets';
  if (text.includes('luftqualität') || text.includes('luftqualitaet') || text.includes('air quality')) return 'cloud';
  if (text.includes('temperatur') || text.includes('temperature') || unit.includes('°c')) return 'thermometer';
  if (text.includes('fenster') || text.includes('window') || text.includes('openwindow')) return 'panel-top';
  if (text.includes('tür') || text.includes('tuer') || text.includes('door')) return 'door-open';
  if (text.includes('bewegung') || text.includes('motion') || text.includes('presence')) return 'activity';

  if (unit === '%' && given === 'droplets') return 'gauge';

  return given || 'gauge';
}

export function formatValue(item) {
  if (item.displayValue) return item.displayValue;
  if (item.value === null || item.value === undefined || item.value === '') return '-';

  if (typeof item.value === 'boolean') {
    return item.value ? 'An' : 'Aus';
  }

  const numeric = Number(item.value);
  if (Number.isFinite(numeric)) {
    const text = Math.abs(numeric) >= 100
      ? numeric.toFixed(0)
      : numeric.toFixed(2).replace(/\.?0+$/, '');
    return `${text}${item.unit ? ` ${item.unit}` : ''}`;
  }

  return `${item.value}${item.unit ? ` ${item.unit}` : ''}`;
}

export function sourceBaseId(sourceId) {
  return String(sourceId || '').split('::')[0];
}

export function sourceKey(sourceId) {
  return String(sourceId || '').split('::')[1] || null;
}

export function applyEntityUpdate(item, entity) {
  const key = sourceKey(item.sourceId || item.id);
  let value = key ? entity?.[key] : entity?.value;

  if (key === 'lightState') {
    value = entity?.rawState && typeof entity.rawState === 'object' && entity.rawState.state !== undefined
      ? entity.rawState.state
      : entity?.value;
  }

  if (key === 'brightnessPercent') {
    const brightness = entity?.rawState && typeof entity.rawState === 'object'
      ? Number(entity.rawState.brightness)
      : Number.NaN;
    const scale = Number(entity?.brightnessScale || 255);
    value = Number.isFinite(brightness) && Number.isFinite(scale) && scale > 0
      ? Math.round((brightness / scale) * 100)
      : null;
  }

  return {
    ...item,
    value,
    displayValue: null,
    updatedAt: entity?.lastUpdate || new Date().toISOString()
  };
}
