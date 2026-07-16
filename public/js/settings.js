export function initSettings(deps) {
  const {
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
    getDiscoveryPrefixes,
    getCurrentView,
    loadDashboardDevices
  } = deps;

  const saveConfigBtn = document.getElementById('saveConfigBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');

  async function saveConfig() {
    const payload = {
      host: mqttHostInput.value.trim(),
      port: Number(mqttPortInput.value),
      topic: mqttTopicInput.value.trim(),
      username: mqttUsernameInput.value.trim(),
      password: mqttPasswordInput.value,
      clientId: mqttClientIdInput.value.trim(),
      discoveryViaPrefixes: getDiscoveryPrefixes(),
      enabledEntityTypes: Array.from(
        entityFilterMenu.querySelectorAll('input[type="checkbox"]:checked')
      ).map((input) => input.value),
      auth: window.config.auth,
      history: window.config.history
    };

    configMessageEl.textContent = 'Speichere...';

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const result = await res.json();

      if (!res.ok) {
        configMessageEl.textContent = result.error || 'Fehler beim Speichern';
        return;
      }

      brokerTextEl.textContent = `${result.config.host}:${result.config.port}`;
      topicTextEl.textContent = result.config.topic;

      mqttUsernameInput.value = '';
      mqttPasswordInput.value = '';
      mqttUsernameInput.placeholder = result.config.mqttUsernameConfigured
        ? 'MQTT-Benutzername gespeichert'
        : 'optional';
      mqttPasswordInput.placeholder = result.config.mqttPasswordConfigured
        ? 'MQTT-Passwort gespeichert'
        : 'optional';

      configMessageEl.textContent = result.reconnected
        ? 'Konfiguration gespeichert, verbinde neu...'
        : 'Konfiguration gespeichert';

      if (getCurrentView() === 'dashboard') {
        setTimeout(() => {
          loadDashboardDevices();
        }, 1000);
      }
    } catch (error) {
      console.error('MQTT-Konfiguration konnte nicht gespeichert werden:', error);
      configMessageEl.textContent = 'Server nicht erreichbar';
    }
  }

  async function disconnectBroker() {
    configMessageEl.textContent = 'Trenne...';

    try {
      const res = await fetch('/api/disconnect', {
        method: 'POST'
      });

      const result = await res.json();

      if (!res.ok || !result.success) {
        configMessageEl.textContent = result.error || 'Fehler beim Trennen';
        return;
      }

      configMessageEl.textContent = 'MQTT-Verbindung getrennt';
    } catch (error) {
      console.error('MQTT-Verbindung konnte nicht getrennt werden:', error);
      configMessageEl.textContent = 'Server nicht erreichbar';
    }
  }

  saveConfigBtn?.addEventListener('click', saveConfig);
  disconnectBtn?.addEventListener('click', disconnectBroker);

  document.addEventListener('change', (e) => {

    if (!e.target.classList.contains('prefix-toggle')) return;

    const index = Number(e.target.dataset.index);

    window.togglePrefix(index);
  });

}
