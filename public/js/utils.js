export function escapeHtml(text) {
    return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function shortenMiddleSmart(text, maxWidthPx) {
    if (!text) return '';

    const str = String(text);
    const maxChars = Math.max(12, Math.floor(maxWidthPx / 7));

    if (str.length <= maxChars) return str;

    const available = maxChars - 3;
    const startLength = Math.ceil(available / 2);
    const endLength = Math.floor(available / 2);

    return `${str.slice(0, startLength)}...${str.slice(-endLength)}`;
}

export function rgbToHex(r, g, b) {
    const toHex = (value) => {
    const safe = Math.max(0, Math.min(255, Number(value) || 0));
    return safe.toString(16).padStart(2, '0');
    };

    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function slugifyDashboardName(name) {
    return String(name || '')
    .trim()
    .toLowerCase()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function formatPayload(payload) {
    try {
    const parsed = JSON.parse(payload);
    return JSON.stringify(parsed, null, 2);
    } catch {
    return payload;
    }
}

export function translateLockState(state) {
    const raw = String(state || '').toUpperCase();

    const map = {
    LOCKED: 'Verriegelt',
    UNLOCKED: 'Entriegelt',
    LOCKING: 'Verriegelt gerade',
    UNLOCKING: 'Entriegelt gerade',
    OPENING: 'Öffnet',
    CLOSING: 'Schließt',
    UNLATCHED: 'Offen',
    UNLATCHING: 'Öffnet gerade',
    JAMMED: 'Blockiert',
    BLOCKED: 'Blockiert',
    MOTOR_BLOCKED: 'Motor blockiert',
    CALIBRATION: 'Kalibrierung',
    ERROR: 'Fehler',
    LOCK_N_GO: 'Lock’n’Go',
    LOCK_N_GO_WITH_UNLATCH: 'Lock’n’Go mit Öffnen',
    UNKNOWN: 'Unbekannt'
    };

    return map[raw] || raw;
}

export function translateCoverState(state) {
    const raw = String(state || '').toUpperCase();

    const map = {
    OPEN: 'Offen',
    CLOSED: 'Geschlossen',
    OPENING: 'Öffnet',
    CLOSING: 'Schließt',
    STOPPED: 'Gestoppt'
    };

    return map[raw] || raw;
}

export function translateHumidifierDeviceClass(deviceClass) {
    const raw = String(deviceClass || '').toLowerCase();

    if (raw === 'humidifier') return 'Luftbefeuchter';
    if (raw === 'dehumidifier') return 'Luftentfeuchter';

    return 'Feuchteregelung';
}

export function translateLawnMowerActivity(activity) {
    const raw = String(activity || '').toLowerCase();

    const map = {
    mowing: 'Mäht',
    paused: 'Pausiert',
    docked: 'In Station'
    };

    return map[raw] || raw;
}

export function parseMqttPayload(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
}
