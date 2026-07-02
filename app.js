const STORAGE_KEY = "mushroom-climate-dashboard-settings";
const MAX_HISTORY = 80;
const ESP32_STALE_MS = 15000;
const CALIBRATION_CHANNELS = ["air", "humidity", "substrate"];

const DEFAULT_SETTINGS = {
  source: "demo",
  mqttUrl: "",
  mqttTopic: "centralcommand/room1/sensors",
  mqttUser: "",
  mqttPassword: "",
  apiUrl: "http://192.168.1.50/api",
  irUrl: "http://192.168.13.94",
  irCommandTopic: "centralcommand/room1/ac/cmd",
  irStatusTopic: "centralcommand/room1/ac/status",
  targets: {
    air: { min: 18, max: 24 },
    humidity: { min: 85, max: 95 },
    substrate: { min: 18, max: 24 }
  },
  calibration: {
    air: 0,
    humidity: 0,
    substrate: 0
  },
  calibrationUpdatedAt: "",
  calibrationSyncPending: false,
  humidifierControl: {
    enabled: false,
    setpoint: 90,
    hysteresis: 3
  },
  humidifierControlUpdatedAt: "",
  humidifierControlSyncPending: false
};

const state = {
  settings: loadSettings(),
  mqttClient: null,
  irMqttClient: null,
  irMqttConnectPromise: null,
  timer: null,
  irTimer: null,
  irBusy: false,
  irMqttConnected: false,
  irDeviceOnline: false,
  connected: false,
  connectionText: "Starting",
  lastContactAt: null,
  lastReading: null,
  pendingCalibrationPublish: null,
  pendingHumidifierPublish: null,
  humidifierStatus: null,
  history: {
    air: [],
    humidity: [],
    substrate: []
  }
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  restorePendingCalibrationSync();
  restorePendingHumidifierSync();
  bindEvents();
  hydrateSettingsForm();
  updateTargetLabels();
  renderHumidifierControlValues();
  startDataSource();
  startIrPolling();
  window.addEventListener("resize", debounce(drawAllSparklines, 120));
  window.addEventListener("hashchange", applySharedSetup);
  window.addEventListener("pageshow", applySharedSetup);
});

function cacheElements() {
  [
    "sourceLabel",
    "connectionLabel",
    "lastUpdateLabel",
    "deviceIpLabel",
    "airValue",
    "humidityValue",
    "substrateValue",
    "airPill",
    "humidityPill",
    "substratePill",
    "airTarget",
    "humidityTarget",
    "substrateTarget",
    "settingsModal",
    "settingsForm",
    "settingsButton",
    "closeSettingsButton",
    "connectButton",
    "resetSettingsButton",
    "mqttUrlInput",
    "mqttTopicInput",
    "mqttUserInput",
    "mqttPasswordInput",
    "apiUrlInput",
    "irUrlInput",
    "irCommandTopicInput",
    "irStatusTopicInput",
    "airMinInput",
    "airMaxInput",
    "humidityMinInput",
    "humidityMaxInput",
    "substrateMinInput",
    "substrateMaxInput",
    "airCalibrationInput",
    "humidityCalibrationInput",
    "substrateCalibrationInput",
    "calibrationSyncStatus",
    "calibrationSyncTopic",
    "humidifierSettingsButton",
    "humidifierBadge",
    "humidifierRelay",
    "humidifierHumidity",
    "humidifierSetpoint",
    "humidifierHysteresis",
    "humidifierLog",
    "humidifierEnabledInput",
    "humidifierSetpointInput",
    "humidifierHysteresisInput",
    "humidifierSyncStatus",
    "humidifierConfigTopic",
    "humidifierStatusTopic",
    "irBadge",
    "irRefreshButton",
    "acTemp",
    "acPower",
    "acMode",
    "acFan",
    "acLog"
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });

  els.sparklines = {
    air: document.getElementById("airSparkline"),
    humidity: document.getElementById("humiditySparkline"),
    substrate: document.getElementById("substrateSparkline")
  };

  els.irCommandButtons = Array.from(document.querySelectorAll("[data-ir-cmd]"));
  els.settingsTabs = Array.from(document.querySelectorAll("[data-settings-tab]"));
  els.settingsPanels = Array.from(document.querySelectorAll("[data-settings-panel]"));
}

function bindEvents() {
  els.settingsButton.addEventListener("click", openSettings);
  els.humidifierSettingsButton.addEventListener("click", () => {
    openSettings();
    selectSettingsTab("humidifier");
    els.humidifierEnabledInput.focus();
  });
  els.closeSettingsButton.addEventListener("click", closeSettings);
  els.connectButton.addEventListener("click", startDataSource);
  els.irRefreshButton.addEventListener("click", loadIrStatus);
  els.irCommandButtons.forEach((button) => {
    button.addEventListener("click", () => sendIrCommand(button.dataset.irCmd));
  });
  els.settingsTabs.forEach((tab) => {
    tab.addEventListener("click", () => selectSettingsTab(tab.dataset.settingsTab));
    tab.addEventListener("keydown", handleSettingsTabKeydown);
  });

  els.resetSettingsButton.addEventListener("click", () => {
    const activeTab = els.settingsTabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    if (activeTab?.dataset.settingsTab === "calibration") {
      els.airCalibrationInput.value = "0";
      els.humidityCalibrationInput.value = "0";
      els.substrateCalibrationInput.value = "0";
      els.settingsForm.requestSubmit();
      return;
    }
    if (activeTab?.dataset.settingsTab === "humidifier") {
      els.humidifierEnabledInput.checked = DEFAULT_SETTINGS.humidifierControl.enabled;
      els.humidifierSetpointInput.value = DEFAULT_SETTINGS.humidifierControl.setpoint;
      els.humidifierHysteresisInput.value = DEFAULT_SETTINGS.humidifierControl.hysteresis;
      els.settingsForm.requestSubmit();
      return;
    }

    const previousCalibration = state.settings.calibration;
    state.settings = structuredClone(DEFAULT_SETTINGS);
    state.pendingCalibrationPublish = null;
    state.pendingHumidifierPublish = null;
    saveSettings();
    refreshCalibratedData(previousCalibration);
    hydrateSettingsForm();
    updateTargetLabels();
    startDataSource();
    startIrPolling();
  });

  els.settingsModal.addEventListener("click", (event) => {
    if (event.target === els.settingsModal) {
      closeSettings();
    }
  });

  els.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const previousSettings = state.settings;
    const nextSettings = readSettingsForm();
    const activeTab = els.settingsTabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    const calibrationChanged = !calibrationsMatch(
      previousSettings.calibration,
      nextSettings.calibration
    );
    const shouldSyncCalibration = calibrationChanged || activeTab?.dataset.settingsTab === "calibration";
    const humidifierChanged = !humidifierControlsMatch(
      previousSettings.humidifierControl,
      nextSettings.humidifierControl
    );
    const shouldSyncHumidifier = humidifierChanged || activeTab?.dataset.settingsTab === "humidifier";
    const restartDataSource = dataSourceSettingsChanged(previousSettings, nextSettings);
    const restartIr = irSettingsChanged(previousSettings, nextSettings);

    state.settings = nextSettings;
    if (calibrationChanged) {
      refreshCalibratedData(previousSettings.calibration);
    }
    if (shouldSyncCalibration) {
      queueCalibrationSync();
    }
    if (shouldSyncHumidifier) {
      queueHumidifierSync();
    }

    saveSettings();
    updateTargetLabels();
    if (state.lastReading) {
      renderReading(state.lastReading);
      drawAllSparklines();
    }
    closeSettings();

    if (restartDataSource) {
      startDataSource();
    } else {
      publishQueuedCalibration().catch(() => {});
      publishQueuedHumidifierControl().catch(() => {});
    }

    if (restartIr) {
      startIrPolling();
    }
  });
}

function loadSettings() {
  let settings = structuredClone(DEFAULT_SETTINGS);

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    settings = mergeSettings(DEFAULT_SETTINGS, stored || {});
  } catch {}

  const sharedSetup = readSharedSetup();
  if (sharedSetup) {
    settings = mergeSettings(settings, sharedSetup);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  return settings;
}

function readSharedSetup() {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const encodedSetup = new URLSearchParams(hash).get("setup");

  if (!encodedSetup) {
    return null;
  }

  // Setup details belong in the URL fragment so they are never sent to the web host.
  // Remove the fragment immediately; the imported settings remain stored on this phone.
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

  try {
    const normalized = encodedSetup.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(window.atob(padded), (character) => character.charCodeAt(0));
    const setup = JSON.parse(new TextDecoder().decode(bytes));

    if (setup.version !== 1) {
      return null;
    }

    const mqttUrl = String(setup.mqttUrl || "").trim();
    const parsedMqttUrl = new URL(mqttUrl);
    if (parsedMqttUrl.protocol !== "wss:") {
      return null;
    }

    return {
      source: "mqtt",
      mqttUrl,
      mqttTopic: String(setup.mqttTopic || DEFAULT_SETTINGS.mqttTopic).trim(),
      mqttUser: String(setup.mqttUser || ""),
      mqttPassword: String(setup.mqttPassword || ""),
      irUrl: "",
      irCommandTopic: String(
        setup.irCommandTopic || defaultIrCommandTopic(setup.mqttTopic)
      ).trim(),
      irStatusTopic: String(
        setup.irStatusTopic || defaultIrStatusTopic(setup.mqttTopic)
      ).trim()
    };
  } catch {
    return null;
  }
}

function applySharedSetup() {
  const sharedSetup = readSharedSetup();
  if (!sharedSetup) {
    return;
  }

  state.settings = mergeSettings(state.settings, sharedSetup);
  saveSettings();
  hydrateSettingsForm();
  updateTargetLabels();
  startDataSource();
  startIrPolling();
}

function mergeSettings(base, incoming) {
  const merged = structuredClone(base);
  Object.assign(merged, incoming);
  merged.targets = {
    air: { ...base.targets.air, ...(incoming.targets?.air || {}) },
    humidity: { ...base.targets.humidity, ...(incoming.targets?.humidity || {}) },
    substrate: { ...base.targets.substrate, ...(incoming.targets?.substrate || {}) }
  };
  merged.calibration = {
    ...base.calibration,
    ...(incoming.calibration || {})
  };
  merged.humidifierControl = {
    ...base.humidifierControl,
    ...(incoming.humidifierControl || {})
  };
  return merged;
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
}

function openSettings() {
  hydrateSettingsForm();
  els.settingsModal.hidden = false;
  const activePanel = els.settingsPanels.find((panel) => !panel.hidden);
  activePanel?.querySelector("input")?.focus();
}

function closeSettings() {
  els.settingsModal.hidden = true;
}

function selectSettingsTab(tabName, moveFocus = false) {
  els.settingsTabs.forEach((tab) => {
    const isSelected = tab.dataset.settingsTab === tabName;
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
    if (isSelected && moveFocus) {
      tab.focus();
    }
  });

  els.settingsPanels.forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== tabName;
  });
}

function handleSettingsTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) {
    return;
  }

  event.preventDefault();
  const currentIndex = els.settingsTabs.indexOf(event.currentTarget);
  const direction = event.key === "ArrowRight" ? 1 : -1;
  const nextIndex = (currentIndex + direction + els.settingsTabs.length) % els.settingsTabs.length;
  selectSettingsTab(els.settingsTabs[nextIndex].dataset.settingsTab, true);
}

function hydrateSettingsForm() {
  const settings = state.settings;
  const sourceInput = els.settingsForm.querySelector(`input[name="source"][value="${settings.source}"]`);
  if (sourceInput) {
    sourceInput.checked = true;
  }

  els.mqttUrlInput.value = settings.mqttUrl;
  els.mqttTopicInput.value = settings.mqttTopic;
  els.mqttUserInput.value = settings.mqttUser;
  els.mqttPasswordInput.value = settings.mqttPassword;
  els.apiUrlInput.value = settings.apiUrl;
  els.irUrlInput.value = settings.irUrl || "";
  els.irCommandTopicInput.value = settings.irCommandTopic || defaultIrCommandTopic(settings.mqttTopic);
  els.irStatusTopicInput.value = settings.irStatusTopic || defaultIrStatusTopic(settings.mqttTopic);
  els.airMinInput.value = settings.targets.air.min;
  els.airMaxInput.value = settings.targets.air.max;
  els.humidityMinInput.value = settings.targets.humidity.min;
  els.humidityMaxInput.value = settings.targets.humidity.max;
  els.substrateMinInput.value = settings.targets.substrate.min;
  els.substrateMaxInput.value = settings.targets.substrate.max;
  els.airCalibrationInput.value = settings.calibration.air;
  els.humidityCalibrationInput.value = settings.calibration.humidity;
  els.substrateCalibrationInput.value = settings.calibration.substrate;
  els.calibrationSyncTopic.textContent = calibrationTopic(settings.mqttTopic);
  els.humidifierEnabledInput.checked = Boolean(settings.humidifierControl.enabled);
  els.humidifierSetpointInput.value = settings.humidifierControl.setpoint;
  els.humidifierHysteresisInput.value = settings.humidifierControl.hysteresis;
  els.humidifierConfigTopic.textContent = humidifierConfigTopic(settings.mqttTopic);
  els.humidifierStatusTopic.textContent = humidifierStatusTopic(settings.mqttTopic);
  updateCalibrationSyncStatus();
  updateHumidifierSyncStatus();
}

function readSettingsForm() {
  const formData = new FormData(els.settingsForm);
  const settings = structuredClone(state.settings);

  settings.source = formData.get("source") || "demo";
  settings.mqttUrl = els.mqttUrlInput.value.trim();
  settings.mqttTopic = els.mqttTopicInput.value.trim() || DEFAULT_SETTINGS.mqttTopic;
  settings.mqttUser = els.mqttUserInput.value.trim();
  settings.mqttPassword = els.mqttPasswordInput.value;
  settings.apiUrl = els.apiUrlInput.value.trim() || DEFAULT_SETTINGS.apiUrl;
  settings.irUrl = normalizeDeviceUrl(els.irUrlInput.value);
  settings.irCommandTopic = els.irCommandTopicInput.value.trim() || defaultIrCommandTopic(settings.mqttTopic);
  settings.irStatusTopic = els.irStatusTopicInput.value.trim() || defaultIrStatusTopic(settings.mqttTopic);
  settings.targets.air.min = numberOrDefault(els.airMinInput.value, DEFAULT_SETTINGS.targets.air.min);
  settings.targets.air.max = numberOrDefault(els.airMaxInput.value, DEFAULT_SETTINGS.targets.air.max);
  settings.targets.humidity.min = numberOrDefault(els.humidityMinInput.value, DEFAULT_SETTINGS.targets.humidity.min);
  settings.targets.humidity.max = numberOrDefault(els.humidityMaxInput.value, DEFAULT_SETTINGS.targets.humidity.max);
  settings.targets.substrate.min = numberOrDefault(els.substrateMinInput.value, DEFAULT_SETTINGS.targets.substrate.min);
  settings.targets.substrate.max = numberOrDefault(els.substrateMaxInput.value, DEFAULT_SETTINGS.targets.substrate.max);
  settings.calibration.air = numberOrDefault(
    els.airCalibrationInput.value,
    DEFAULT_SETTINGS.calibration.air
  );
  settings.calibration.humidity = numberOrDefault(
    els.humidityCalibrationInput.value,
    DEFAULT_SETTINGS.calibration.humidity
  );
  settings.calibration.substrate = numberOrDefault(
    els.substrateCalibrationInput.value,
    DEFAULT_SETTINGS.calibration.substrate
  );
  settings.humidifierControl.enabled = els.humidifierEnabledInput.checked;
  settings.humidifierControl.setpoint = numberInRangeOrDefault(
    els.humidifierSetpointInput.value,
    0,
    100,
    DEFAULT_SETTINGS.humidifierControl.setpoint
  );
  settings.humidifierControl.hysteresis = numberInRangeOrDefault(
    els.humidifierHysteresisInput.value,
    0.5,
    20,
    DEFAULT_SETTINGS.humidifierControl.hysteresis
  );
  return settings;
}

function calibrationsMatch(first, second) {
  return CALIBRATION_CHANNELS.every(
    (channel) => Number(first?.[channel]) === Number(second?.[channel])
  );
}

function humidifierControlsMatch(first, second) {
  return Boolean(first?.enabled) === Boolean(second?.enabled) &&
    Number(first?.setpoint) === Number(second?.setpoint) &&
    Number(first?.hysteresis) === Number(second?.hysteresis);
}

function settingsChanged(previous, next, keys) {
  return keys.some((key) => previous[key] !== next[key]);
}

function dataSourceSettingsChanged(previous, next) {
  return settingsChanged(previous, next, [
    "source",
    "mqttUrl",
    "mqttTopic",
    "mqttUser",
    "mqttPassword",
    "apiUrl"
  ]);
}

function irSettingsChanged(previous, next) {
  return settingsChanged(previous, next, [
    "mqttUrl",
    "mqttUser",
    "mqttPassword",
    "irUrl",
    "irCommandTopic",
    "irStatusTopic"
  ]);
}

function startDataSource() {
  stopDataSource();
  state.connected = false;
  state.connectionText = "Connecting";
  state.lastContactAt = null;
  state.lastReading = null;
  updateSystemLabels();

  if (state.settings.source === "mqtt") {
    startMqtt();
    return;
  }

  if (state.settings.source === "api") {
    startApiPolling();
    return;
  }

  startDemo();
}

function stopDataSource() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  if (state.mqttClient) {
    state.mqttClient.end(true);
    state.mqttClient = null;
  }
}

function startIrPolling() {
  stopIrPolling();

  if (canUseIrHttp()) {
    renderIrUnavailable("Checking", "Checking AC ESP32 by local HTTP.");
    loadIrStatus();
    state.irTimer = setInterval(loadIrStatus, 10000);
    return;
  }

  if (hasIrMqttSettings()) {
    renderIrUnavailable("MQTT", "Connecting to AC ESP32 by MQTT.");
    requestIrMqttStatus();
    return;
  }

  if (state.settings.irUrl && isHttpsPageWithHttpDevice(state.settings.irUrl)) {
    renderIrUnavailable("Set MQTT", "Direct HTTP is blocked. Add AC MQTT topics in Settings.");
    return;
  }

  renderIrUnavailable("Set control", "Set AC ESP URL or AC MQTT topics in Settings.");
}

function stopIrPolling() {
  if (state.irTimer) {
    clearInterval(state.irTimer);
    state.irTimer = null;
  }

  stopIrMqtt();
}

async function loadIrStatus() {
  if (canUseIrHttp()) {
    await loadIrHttpStatus();
    return;
  }

  if (hasIrMqttSettings()) {
    await requestIrMqttStatus();
    return;
  }

  if (state.settings.irUrl && isHttpsPageWithHttpDevice(state.settings.irUrl)) {
    renderIrUnavailable("Set MQTT", "Direct HTTP is blocked. Add AC MQTT topics in Settings.");
    return;
  }

  renderIrUnavailable("Set control", "Set AC ESP URL or AC MQTT topics in Settings.");
}

async function loadIrHttpStatus() {
  try {
    setIrBadge("Checking", "warn");
    const response = await fetch(`${state.settings.irUrl}/status`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const status = normalizeIrStatus(await response.json());
    renderIrStatus(status);
    setIrBadge("Online", "ok");
  } catch (error) {
    renderIrUnavailable("Offline", readableError(error));
  }
}

async function sendIrCommand(command) {
  if (canUseIrHttp()) {
    await sendIrHttpCommand(command);
    return;
  }

  if (hasIrMqttSettings()) {
    await sendIrMqttCommand(command);
    return;
  }

  if (state.settings.irUrl && isHttpsPageWithHttpDevice(state.settings.irUrl)) {
    renderIrUnavailable("Set MQTT", "Direct HTTP is blocked. Add AC MQTT topics in Settings.");
    return;
  }

  renderIrUnavailable("Set control", "Set AC ESP URL or AC MQTT topics in Settings before sending commands.");
}

async function sendIrHttpCommand(command) {
  state.irBusy = true;
  setIrControlsEnabled(false);
  setIrBadge("Sending", "warn");
  els.acLog.textContent = `Sending ${formatCommand(command)}...`;

  try {
    const response = await fetch(`${state.settings.irUrl}/cmd?c=${encodeURIComponent(command)}`, {
      cache: "no-store"
    });
    const message = await response.text();

    if (!response.ok) {
      throw new Error(message || `HTTP ${response.status}`);
    }

    els.acLog.textContent = message || `Command sent: ${formatCommand(command)}`;
    await loadIrStatus();
  } catch (error) {
    renderIrUnavailable("Offline", readableError(error));
  } finally {
    state.irBusy = false;
    setIrControlsEnabled(true);
  }
}

async function requestIrMqttStatus() {
  try {
    setIrBadge("MQTT", "warn");
    els.acLog.textContent = "Connecting to AC ESP32 by MQTT.";
    const client = await ensureIrMqtt();
    await publishIrMqttMessage(client, "status");
    els.acLog.textContent = "Waiting for AC ESP32 MQTT status.";
  } catch (error) {
    renderIrUnavailable("MQTT offline", readableError(error));
  }
}

async function sendIrMqttCommand(command) {
  state.irBusy = true;
  setIrControlsEnabled(false);
  setIrBadge("Sending", "warn");
  els.acLog.textContent = `Publishing ${formatCommand(command)} by MQTT...`;

  try {
    const client = await ensureIrMqtt();
    await publishIrMqttMessage(client, command);
    els.acLog.textContent = `MQTT command sent: ${formatCommand(command)}`;
  } catch (error) {
    renderIrUnavailable("MQTT offline", readableError(error));
  } finally {
    state.irBusy = false;
    setIrControlsEnabled(canUseIrCommand());
  }
}

function ensureIrMqtt() {
  if (state.irMqttClient?.connected) {
    return Promise.resolve(state.irMqttClient);
  }

  if (state.irMqttConnectPromise) {
    return state.irMqttConnectPromise;
  }

  if (!hasIrMqttSettings()) {
    return Promise.reject(new Error("Missing AC MQTT settings"));
  }

  if (!window.mqtt) {
    return Promise.reject(new Error("MQTT library unavailable"));
  }

  stopIrMqtt();

  const options = {
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 3000,
    clientId: `mushroom-ac-${Math.random().toString(16).slice(2)}`
  };

  if (state.settings.mqttUser) {
    options.username = state.settings.mqttUser;
    options.password = state.settings.mqttPassword;
  }

  const client = mqtt.connect(state.settings.mqttUrl, options);
  state.irMqttClient = client;
  state.irMqttConnected = false;
  state.irDeviceOnline = false;

  client.on("connect", () => {
    state.irMqttConnected = true;
    state.irDeviceOnline = false;
    setIrBadge("MQTT", "warn");
    els.acLog.textContent = "MQTT connected. Waiting for AC ESP32.";

    if (state.settings.irStatusTopic) {
      client.subscribe(state.settings.irStatusTopic);
    }

    setIrControlsEnabled(false);
  });

  client.on("message", (topic, message) => {
    if (topic === state.settings.irStatusTopic) {
      handleIrMqttStatus(message.toString());
    }
  });

  client.on("reconnect", () => {
    state.irMqttConnected = false;
    state.irDeviceOnline = false;
    setIrBadge("MQTT", "warn");
    els.acLog.textContent = "Reconnecting to AC MQTT.";
    setIrControlsEnabled(false);
  });

  client.on("offline", () => {
    state.irMqttConnected = false;
    state.irDeviceOnline = false;
    renderIrUnavailable("MQTT offline", "MQTT broker disconnected.");
  });

  client.on("error", (error) => {
    state.irMqttConnected = false;
    state.irDeviceOnline = false;
    renderIrUnavailable("MQTT error", readableError(error));
  });

  state.irMqttConnectPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("MQTT timeout"));
    }, 9000);

    client.once("connect", () => {
      clearTimeout(timeout);
      resolve(client);
    });

    client.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  }).finally(() => {
    state.irMqttConnectPromise = null;
  });

  return state.irMqttConnectPromise;
}

function stopIrMqtt() {
  if (state.irMqttClient) {
    state.irMqttClient.end(true);
    state.irMqttClient = null;
  }

  state.irMqttConnectPromise = null;
  state.irMqttConnected = false;
  state.irDeviceOnline = false;
}

function publishIrMqttMessage(client, command) {
  return new Promise((resolve, reject) => {
    client.publish(state.settings.irCommandTopic, command, { qos: 0, retain: false }, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function handleIrMqttStatus(message) {
  const text = message.trim();

  if (text.toLowerCase() === "offline") {
    state.irDeviceOnline = false;
    renderIrUnavailable("AC offline", "AC ESP32 is offline on MQTT.");
    return;
  }

  try {
    const status = normalizeIrStatus(JSON.parse(text));
    state.irDeviceOnline = true;
    renderIrStatus(status);
    setIrBadge("MQTT online", "ok");
    els.acLog.textContent = "AC status received by MQTT.";
  } catch {
    state.irDeviceOnline = false;
    renderIrUnavailable("Bad status", "AC MQTT status was not valid JSON.");
  }
}

function normalizeIrStatus(payload) {
  const temp = firstNumber(payload.temp, payload.temperature, payload.ac_temperature);

  return {
    power: normalizePower(payload.power),
    temp,
    mode: normalizeText(payload.mode),
    fan: normalizeText(payload.fan)
  };
}

function renderIrStatus(status) {
  els.acTemp.textContent = isFiniteNumber(status.temp) ? String(status.temp) : "--";
  els.acPower.textContent = status.power;
  els.acMode.textContent = status.mode;
  els.acFan.textContent = status.fan;
  setIrControlsEnabled(canUseIrCommand() && !state.irBusy);
  updateIrSelections(status);
}

function renderIrUnavailable(label, logMessage) {
  setIrBadge(label, label === "Set URL" ? "" : "bad");
  els.acTemp.textContent = "--";
  els.acPower.textContent = "--";
  els.acMode.textContent = "--";
  els.acFan.textContent = "--";
  els.acLog.textContent = logMessage;
  setIrControlsEnabled(canUseIrCommand() && !state.irBusy);
  updateIrSelections(null);
}

function setIrBadge(text, tone) {
  els.irBadge.textContent = text;
  els.irBadge.className = `pill ${tone}`;
}

function setIrControlsEnabled(enabled) {
  els.irCommandButtons.forEach((button) => {
    button.disabled = !enabled;
  });
  els.irRefreshButton.disabled = state.irBusy || (!canUseIrHttp() && !hasIrMqttSettings());
}

function updateIrSelections(status) {
  els.irCommandButtons.forEach((button) => {
    const command = button.dataset.irCmd;
    let selected = false;

    if (status) {
      selected =
        (command === "on" && status.power === "ON") ||
        (command === "off" && status.power === "OFF") ||
        (command.startsWith("temp:") && Number(command.slice(5)) === status.temp) ||
        (command === "fan_mode" && status.mode === "fan") ||
        (["auto", "cool", "heat", "dry"].includes(command) && status.mode === command) ||
        (command.startsWith("fan_") && command.slice(4) === status.fan);
    }

    button.classList.toggle("selected", selected);
  });
}

function normalizePower(value) {
  if (value === true || value === 1 || value === "1") {
    return "ON";
  }

  if (value === false || value === 0 || value === "0") {
    return "OFF";
  }

  const text = String(value || "--").toUpperCase();
  return text === "ON" || text === "OFF" ? text : "--";
}

function normalizeText(value) {
  return String(value || "--").toLowerCase();
}

function normalizeDeviceUrl(value) {
  let url = value.trim();
  if (!url) {
    return "";
  }

  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }

  return url.replace(/\/+$/, "");
}

function defaultIrBaseTopic(mqttTopic) {
  const topic = mqttTopic || DEFAULT_SETTINGS.mqttTopic;
  if (topic.endsWith("/sensors")) {
    return topic.replace(/\/sensors$/, "/ac");
  }

  return "centralcommand/room1/ac";
}

function defaultIrCommandTopic(mqttTopic) {
  return `${defaultIrBaseTopic(mqttTopic)}/cmd`;
}

function defaultIrStatusTopic(mqttTopic) {
  return `${defaultIrBaseTopic(mqttTopic)}/status`;
}

function canUseIrHttp() {
  return Boolean(state.settings.irUrl) && !isHttpsPageWithHttpDevice(state.settings.irUrl);
}

function hasIrMqttSettings() {
  return Boolean(state.settings.mqttUrl && state.settings.irCommandTopic && state.settings.irStatusTopic);
}

function canUseIrCommand() {
  return canUseIrHttp() || (state.irMqttConnected && state.irDeviceOnline);
}

function isHttpsPageWithHttpDevice(deviceUrl) {
  try {
    return window.location.protocol === "https:" && new URL(deviceUrl).protocol === "http:";
  } catch {
    return false;
  }
}

function formatCommand(command) {
  return command.replace("temp:", "").replaceAll("_", " ");
}

function startDemo() {
  state.connected = true;
  state.connectionText = "Demo";
  applyPayload(makeDemoPayload());
  state.timer = setInterval(() => applyPayload(makeDemoPayload()), 3000);
}

function startApiPolling() {
  if (!state.settings.apiUrl) {
    state.connectionText = "Missing API URL";
    updateSystemLabels();
    return;
  }

  const poll = async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const response = await fetch(state.settings.apiUrl, {
        cache: "no-store",
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      state.connected = true;
      state.connectionText = "Online";
      state.lastContactAt = Date.now();
      applyPayload(payload);
    } catch (error) {
      state.connected = false;
      state.connectionText = esp32ConnectionError(error);
      updateSystemLabels();
    }
  };

  poll();
  state.timer = setInterval(poll, 3000);
}

function startMqtt() {
  if (!state.settings.mqttUrl) {
    state.connectionText = "Missing MQTT URL";
    updateSystemLabels();
    return;
  }

  if (!window.mqtt) {
    state.connectionText = "MQTT library unavailable";
    updateSystemLabels();
    return;
  }

  const options = {
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 3000
  };

  if (state.settings.mqttUser) {
    options.username = state.settings.mqttUser;
    options.password = state.settings.mqttPassword;
  }

  state.mqttClient = mqtt.connect(state.settings.mqttUrl, options);

  state.mqttClient.on("connect", () => {
    state.connected = false;
    state.connectionText = "Waiting for ESP32 data";
    state.lastContactAt = Date.now();
    state.mqttClient.subscribe(mqttTopics(), (error) => {
      if (error) {
        setCalibrationSyncStatus("Subscription failed", "bad");
        return;
      }

      updateCalibrationSyncStatus();
      publishQueuedCalibration().catch(() => {});
      updateHumidifierSyncStatus();
      publishQueuedHumidifierControl().catch(() => {});
    });
    updateSystemLabels();
  });

  state.mqttClient.on("message", (topic, message) => {
    if (topic === calibrationTopic()) {
      handleCalibrationMessage(message.toString());
      return;
    }
    if (topic === humidifierConfigTopic()) {
      handleHumidifierConfigMessage(message.toString());
      return;
    }
    if (topic === humidifierStatusTopic()) {
      handleHumidifierStatusMessage(message.toString());
      return;
    }

    if (topic === mqttStatusTopic()) {
      handleMqttStatus(message.toString());
      return;
    }

    if (topic !== state.settings.mqttTopic) {
      return;
    }

    try {
      state.connected = true;
      state.connectionText = "Online";
      state.lastContactAt = Date.now();
      applyPayload(JSON.parse(message.toString()));
    } catch (error) {
      state.connected = false;
      state.connectionText = "Bad JSON";
      updateSystemLabels();
    }
  });

  state.mqttClient.on("reconnect", () => {
    state.connected = false;
    state.connectionText = "Reconnecting";
    updateCalibrationSyncStatus();
    updateHumidifierSyncStatus();
    updateSystemLabels();
  });

  state.mqttClient.on("offline", () => {
    state.connected = false;
    state.connectionText = "Offline";
    updateCalibrationSyncStatus();
    updateHumidifierSyncStatus();
    updateSystemLabels();
  });

  state.mqttClient.on("error", (error) => {
    state.connected = false;
    state.connectionText = readableError(error);
    updateCalibrationSyncStatus();
    updateHumidifierSyncStatus();
    updateSystemLabels();
  });

  state.timer = setInterval(checkEsp32Freshness, 3000);
}

function applyPayload(payload) {
  const reading = normalizePayload(payload);
  const now = new Date();
  reading.receivedAt = now;
  state.lastReading = reading;
  state.lastContactAt = now.getTime();

  pushHistory("air", reading.airTemp);
  pushHistory("humidity", reading.humidity);
  pushHistory("substrate", reading.substrateTemp);

  renderReading(reading);
  if (reading.humidifierStatus) {
    state.humidifierStatus = reading.humidifierStatus;
    renderHumidifierStatus(reading.humidifierStatus);
  }
  drawAllSparklines();
}

function mqttTopics() {
  return Array.from(
    new Set([
      state.settings.mqttTopic,
      mqttStatusTopic(),
      calibrationTopic(),
      humidifierConfigTopic(),
      humidifierStatusTopic()
    ].filter(Boolean))
  );
}

function mqttStatusTopic() {
  if (!state.settings.mqttTopic || !state.settings.mqttTopic.endsWith("/sensors")) {
    return "";
  }

  return state.settings.mqttTopic.replace(/\/sensors$/, "/status");
}

function calibrationTopic(mqttTopic = state.settings.mqttTopic) {
  const topic = (mqttTopic || DEFAULT_SETTINGS.mqttTopic).replace(/\/+$/, "");
  if (topic.endsWith("/sensors")) {
    return topic.replace(/\/sensors$/, "/calibration");
  }

  return `${topic}/calibration`;
}

function humidifierBaseTopic(mqttTopic = state.settings.mqttTopic) {
  const topic = (mqttTopic || DEFAULT_SETTINGS.mqttTopic).replace(/\/+$/, "");
  if (topic.endsWith("/sensors")) {
    return topic.replace(/\/sensors$/, "/humidifier");
  }

  return `${topic}/humidifier`;
}

function humidifierConfigTopic(mqttTopic = state.settings.mqttTopic) {
  return `${humidifierBaseTopic(mqttTopic)}/config`;
}

function humidifierStatusTopic(mqttTopic = state.settings.mqttTopic) {
  return `${humidifierBaseTopic(mqttTopic)}/status`;
}

function queueCalibrationSync() {
  const updatedAt = new Date().toISOString();
  state.settings.calibrationUpdatedAt = updatedAt;
  state.settings.calibrationSyncPending = true;
  state.pendingCalibrationPublish = {
    version: 1,
    calibration: { ...state.settings.calibration },
    updatedAt
  };
  setCalibrationSyncStatus(
    state.settings.source === "mqtt" ? "Syncing" : "Select MQTT WS to sync",
    "warn"
  );
}

function restorePendingCalibrationSync() {
  if (!state.settings.calibrationSyncPending) {
    return;
  }

  state.pendingCalibrationPublish = {
    version: 1,
    calibration: { ...state.settings.calibration },
    updatedAt: state.settings.calibrationUpdatedAt || new Date().toISOString()
  };
}

function publishQueuedCalibration() {
  const pending = state.pendingCalibrationPublish;
  if (!pending || state.settings.source !== "mqtt" || !state.mqttClient?.connected) {
    updateCalibrationSyncStatus();
    return Promise.resolve(false);
  }

  setCalibrationSyncStatus("Syncing", "warn");
  return new Promise((resolve, reject) => {
    state.mqttClient.publish(
      calibrationTopic(),
      JSON.stringify(pending),
      { qos: 1, retain: true },
      (error) => {
        if (error) {
          setCalibrationSyncStatus("Sync failed", "bad");
          reject(error);
          return;
        }

        if (state.pendingCalibrationPublish === pending) {
          state.pendingCalibrationPublish = null;
          state.settings.calibrationSyncPending = false;
          saveSettings();
        }
        setCalibrationSyncStatus("Synced", "ok");
        resolve(true);
      }
    );
  });
}

function handleCalibrationMessage(message) {
  if (state.pendingCalibrationPublish) {
    return;
  }

  try {
    const payload = JSON.parse(message);
    const incoming = payload.calibration || payload;
    if (!CALIBRATION_CHANNELS.every((channel) => isFiniteNumber(incoming[channel]))) {
      throw new Error("Missing calibration value");
    }

    const previousCalibration = state.settings.calibration;
    state.settings.calibration = {
      air: Number(incoming.air),
      humidity: Number(incoming.humidity),
      substrate: Number(incoming.substrate)
    };
    state.settings.calibrationUpdatedAt = payload.updatedAt || new Date().toISOString();
    state.settings.calibrationSyncPending = false;
    saveSettings();
    refreshCalibratedData(previousCalibration);
    hydrateCalibrationInputs();
    setCalibrationSyncStatus("Synced", "ok");
  } catch {
    setCalibrationSyncStatus("Invalid shared data", "bad");
  }
}

function hydrateCalibrationInputs() {
  els.airCalibrationInput.value = state.settings.calibration.air;
  els.humidityCalibrationInput.value = state.settings.calibration.humidity;
  els.substrateCalibrationInput.value = state.settings.calibration.substrate;
}

function refreshCalibratedData(previousCalibration) {
  const readings = {
    air: { raw: "rawAirTemp", value: "airTemp" },
    humidity: { raw: "rawHumidity", value: "humidity" },
    substrate: { raw: "rawSubstrateTemp", value: "substrateTemp" }
  };

  CALIBRATION_CHANNELS.forEach((channel) => {
    const oldOffset = numberOrDefault(
      previousCalibration?.[channel],
      DEFAULT_SETTINGS.calibration[channel]
    );
    const newOffset = numberOrDefault(
      state.settings.calibration[channel],
      DEFAULT_SETTINGS.calibration[channel]
    );
    const difference = newOffset - oldOffset;
    state.history[channel].forEach((point) => {
      point.value += difference;
    });

    if (state.lastReading) {
      const fields = readings[channel];
      state.lastReading[fields.value] = applyCalibration(
        state.lastReading[fields.raw],
        channel
      );
    }
  });

  if (state.lastReading) {
    renderReading(state.lastReading);
    drawAllSparklines();
  }
}

function setCalibrationSyncStatus(text, tone = "") {
  els.calibrationSyncStatus.textContent = text;
  els.calibrationSyncStatus.className = `sync-status ${tone}`.trim();
}

function updateCalibrationSyncStatus() {
  if (state.settings.source !== "mqtt") {
    setCalibrationSyncStatus("Select MQTT WS to sync", "warn");
    return;
  }

  if (state.pendingCalibrationPublish) {
    setCalibrationSyncStatus(
      state.mqttClient?.connected ? "Syncing" : "Waiting to sync",
      "warn"
    );
    return;
  }

  setCalibrationSyncStatus(state.mqttClient?.connected ? "Connected" : "Waiting for MQTT");
}

function queueHumidifierSync() {
  const updatedAt = new Date().toISOString();
  state.settings.humidifierControlUpdatedAt = updatedAt;
  state.settings.humidifierControlSyncPending = true;
  state.pendingHumidifierPublish = {
    version: 1,
    ...state.settings.humidifierControl,
    updatedAt
  };
  setHumidifierSyncStatus(
    state.settings.source === "mqtt" ? "Syncing" : "Select MQTT WS to sync",
    "warn"
  );
}

function restorePendingHumidifierSync() {
  if (!state.settings.humidifierControlSyncPending) {
    return;
  }

  state.pendingHumidifierPublish = {
    version: 1,
    ...state.settings.humidifierControl,
    updatedAt: state.settings.humidifierControlUpdatedAt || new Date().toISOString()
  };
}

function publishQueuedHumidifierControl() {
  const pending = state.pendingHumidifierPublish;
  if (!pending || state.settings.source !== "mqtt" || !state.mqttClient?.connected) {
    updateHumidifierSyncStatus();
    return Promise.resolve(false);
  }

  setHumidifierSyncStatus("Syncing", "warn");
  return new Promise((resolve, reject) => {
    state.mqttClient.publish(
      humidifierConfigTopic(),
      JSON.stringify(pending),
      { qos: 1, retain: true },
      (error) => {
        if (error) {
          setHumidifierSyncStatus("Sync failed", "bad");
          reject(error);
          return;
        }

        if (state.pendingHumidifierPublish === pending) {
          state.pendingHumidifierPublish = null;
          state.settings.humidifierControlSyncPending = false;
          saveSettings();
        }
        setHumidifierSyncStatus("Synced", "ok");
        resolve(true);
      }
    );
  });
}

function normalizeHumidifierControl(payload) {
  const enabled = boolOrDefault(payload?.enabled, null);
  const setpoint = firstNumber(payload?.setpoint);
  const hysteresis = firstNumber(payload?.hysteresis);

  if (
    typeof enabled !== "boolean" ||
    !isFiniteNumber(setpoint) ||
    setpoint < 0 ||
    setpoint > 100 ||
    !isFiniteNumber(hysteresis) ||
    hysteresis < 0.5 ||
    hysteresis > 20
  ) {
    return null;
  }

  return { enabled, setpoint, hysteresis };
}

function handleHumidifierConfigMessage(message) {
  if (state.pendingHumidifierPublish) {
    return;
  }

  try {
    const payload = JSON.parse(message);
    const control = normalizeHumidifierControl(payload);
    if (!control) {
      throw new Error("Invalid humidifier control");
    }

    state.settings.humidifierControl = control;
    state.settings.humidifierControlUpdatedAt = payload.updatedAt || new Date().toISOString();
    state.settings.humidifierControlSyncPending = false;
    saveSettings();
    hydrateHumidifierInputs();
    renderHumidifierControlValues();
    setHumidifierSyncStatus("Synced", "ok");
  } catch {
    setHumidifierSyncStatus("Invalid shared data", "bad");
  }
}

function normalizeHumidifierStatus(payload) {
  const hasStatus = [
    "humidifier_enabled",
    "enabled",
    "humidifier_relay_on",
    "relay_on"
  ].some((key) => Object.prototype.hasOwnProperty.call(payload, key));
  if (!hasStatus) {
    return null;
  }

  const enabled = boolOrDefault(payload.humidifier_enabled ?? payload.enabled, false);
  const relayOn = boolOrDefault(payload.humidifier_relay_on ?? payload.relay_on, false);
  const sensorOnline = boolOrDefault(
    payload.humidifier_sensor_online ?? payload.sensor_online,
    isFiniteNumber(payload.humidity_control)
  );

  return {
    enabled,
    relayOn,
    sensorOnline,
    setpoint: firstNumber(payload.humidifier_setpoint, payload.setpoint),
    hysteresis: firstNumber(payload.humidifier_hysteresis, payload.hysteresis),
    humidity: firstNumber(payload.humidity_control),
    reason: normalizeText(payload.humidifier_reason ?? payload.reason)
  };
}

function handleHumidifierStatusMessage(message) {
  try {
    const status = normalizeHumidifierStatus(JSON.parse(message));
    if (!status) {
      throw new Error("Invalid humidifier status");
    }

    state.humidifierStatus = status;
    if (!state.pendingHumidifierPublish) {
      const control = normalizeHumidifierControl(status);
      if (control && !humidifierControlsMatch(state.settings.humidifierControl, control)) {
        state.settings.humidifierControl = control;
        saveSettings();
        hydrateHumidifierInputs();
      }
    }
    renderHumidifierStatus(status);
  } catch {
    setHumidifierBadge("Bad status", "bad");
    els.humidifierLog.textContent = "Humidifier MQTT status was not valid JSON.";
  }
}

function hydrateHumidifierInputs() {
  const control = state.settings.humidifierControl;
  els.humidifierEnabledInput.checked = Boolean(control.enabled);
  els.humidifierSetpointInput.value = control.setpoint;
  els.humidifierHysteresisInput.value = control.hysteresis;
}

function renderHumidifierControlValues() {
  const control = state.settings.humidifierControl;
  els.humidifierSetpoint.textContent = `${Number(control.setpoint).toFixed(1)}%`;
  els.humidifierHysteresis.textContent = `${Number(control.hysteresis).toFixed(1)}%`;
}

function renderHumidifierStatus(status) {
  renderHumidifierControlValues();
  els.humidifierRelay.textContent = status.relayOn ? "ON" : "OFF";
  els.humidifierHumidity.textContent = isFiniteNumber(status.humidity)
    ? `${Number(status.humidity).toFixed(1)}%`
    : "--";

  const reasons = {
    disabled: "Automatic humidifier control is disabled.",
    sensor_offline: "Humidity sensor is offline or stale. Relay 1 is forced OFF.",
    below_setpoint: "Humidity is below the activation threshold. Humidifier switched ON.",
    humidifying: "Humidifier is running until the setpoint is reached.",
    target_reached: "Humidity reached the setpoint. Humidifier switched OFF.",
    holding: "Humidity is inside the hysteresis band. Humidifier remains OFF."
  };

  if (!status.enabled) {
    setHumidifierBadge("Disabled", "warn");
  } else if (!status.sensorOnline) {
    setHumidifierBadge("Sensor offline", "bad");
  } else if (status.relayOn) {
    setHumidifierBadge("Humidifying", "ok");
  } else {
    setHumidifierBadge("Holding", "");
  }

  els.humidifierLog.textContent =
    reasons[status.reason] || "Humidifier controller status received.";
}

function setHumidifierBadge(text, tone = "") {
  els.humidifierBadge.textContent = text;
  els.humidifierBadge.className = `pill ${tone}`.trim();
}

function setHumidifierSyncStatus(text, tone = "") {
  els.humidifierSyncStatus.textContent = text;
  els.humidifierSyncStatus.className = `sync-status ${tone}`.trim();
}

function updateHumidifierSyncStatus() {
  if (state.settings.source !== "mqtt") {
    setHumidifierSyncStatus("Select MQTT WS to sync", "warn");
    return;
  }

  if (state.pendingHumidifierPublish) {
    setHumidifierSyncStatus(
      state.mqttClient?.connected ? "Syncing" : "Waiting to sync",
      "warn"
    );
    return;
  }

  setHumidifierSyncStatus(state.mqttClient?.connected ? "Connected" : "Waiting for MQTT");
}

function handleMqttStatus(message) {
  const status = message.trim().toLowerCase();
  state.lastContactAt = Date.now();

  if (status === "offline") {
    state.connected = false;
    state.connectionText = "ESP32 offline";
    updateSystemLabels();
    return;
  }

  if (status === "online") {
    state.connectionText = state.lastReading ? "Online" : "Waiting for ESP32 data";
    state.connected = Boolean(state.lastReading);
    updateSystemLabels();
  }
}

function checkEsp32Freshness() {
  if (state.settings.source !== "mqtt" || !state.mqttClient?.connected) {
    return;
  }

  if (state.lastContactAt && Date.now() - state.lastContactAt <= ESP32_STALE_MS) {
    return;
  }

  if (state.connectionText !== "ESP32 offline") {
    state.connected = false;
    state.connectionText = "ESP32 offline";
    updateSystemLabels();
  }
}

function normalizePayload(payload) {
  const rawAirTemp = firstNumber(
    payload.sht20_temperature,
    payload.air_temperature,
    payload.airTemp,
    payload.temperature
  );
  const rawHumidity = firstNumber(
    payload.sht20_humidity,
    payload.humidity,
    payload.relative_humidity
  );
  const rawSubstrateTemp = firstNumber(
    payload.pt100_temperature,
    payload.substrate_temperature,
    payload.substrateTemp,
    payload.probe_temperature
  );
  const airTemp = applyCalibration(rawAirTemp, "air");
  const humidity = applyCalibration(rawHumidity, "humidity");
  const substrateTemp = applyCalibration(rawSubstrateTemp, "substrate");

  return {
    airTemp,
    humidity,
    substrateTemp,
    rawAirTemp,
    rawHumidity,
    rawSubstrateTemp,
    sht20Online: boolOrDefault(payload.sht20_online, isFiniteNumber(rawAirTemp) || isFiniteNumber(rawHumidity)),
    pt100Online: boolOrDefault(payload.pt100_online, isFiniteNumber(rawSubstrateTemp)),
    mqttConnected: boolOrDefault(payload.mqtt_connected, state.settings.source === "mqtt" ? state.connected : null),
    wifiRssi: firstNumber(payload.wifi_rssi, payload.rssi),
    ip: payload.ip || payload.device_ip || "--",
    uptimeMs: firstNumber(payload.uptime_ms, payload.uptime),
    humidifierStatus: normalizeHumidifierStatus(payload),
    raw: payload
  };
}

function applyCalibration(value, channel) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const offset = numberOrDefault(
    state.settings.calibration?.[channel],
    DEFAULT_SETTINGS.calibration[channel]
  );
  return Number(value) + offset;
}

function renderReading(reading) {
  setMetric("air", reading.airTemp, 1, state.settings.targets.air);
  setMetric("humidity", reading.humidity, 1, state.settings.targets.humidity);
  setMetric("substrate", reading.substrateTemp, 1, state.settings.targets.substrate);

  updateSystemLabels();
}

function setMetric(name, value, decimals, target) {
  const valueEl = els[`${name}Value`];
  const pill = els[`${name}Pill`];
  const band = getBand(value, target);

  valueEl.textContent = isFiniteNumber(value) ? value.toFixed(decimals) : "--";
  pill.textContent = band.label;
  pill.className = `pill ${band.tone}`;
}

function updateSystemLabels() {
  const sourceNames = {
    demo: "Demo",
    mqtt: "MQTT WS",
    api: "ESP32 API"
  };

  const source = sourceNames[state.settings.source] || state.settings.source;
  els.sourceLabel.textContent = source;
  els.connectionLabel.textContent = state.connectionText;
  els.connectionLabel.className = state.settings.source === "demo" ? "warn" : state.connected ? "ok" : "bad";
  els.deviceIpLabel.textContent = state.lastReading?.ip || "--";
  els.lastUpdateLabel.textContent = state.lastReading?.receivedAt
    ? state.lastReading.receivedAt.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })
    : "--";
  els.connectButton.title = `${source}: ${state.connectionText}`;
}

function updateTargetLabels() {
  const targets = state.settings.targets;
  els.airTarget.textContent = `Target ${targets.air.min}-${targets.air.max} deg C`;
  els.humidityTarget.textContent = `Target ${targets.humidity.min}-${targets.humidity.max}%`;
  els.substrateTarget.textContent = `Target ${targets.substrate.min}-${targets.substrate.max} deg C`;
}

function getBand(value, target) {
  if (!isFiniteNumber(value)) {
    return { label: "--", tone: "" };
  }

  const warningPadding = Math.max((target.max - target.min) * 0.2, 0.5);
  if (value >= target.min && value <= target.max) {
    return { label: "In range", tone: "ok" };
  }

  if (value < target.min - warningPadding || value > target.max + warningPadding) {
    return { label: value < target.min ? "Low" : "High", tone: "bad" };
  }

  return { label: value < target.min ? "Low" : "High", tone: "warn" };
}

function pushHistory(key, value) {
  if (!isFiniteNumber(value)) {
    return;
  }

  state.history[key].push({ value, time: Date.now() });
  if (state.history[key].length > MAX_HISTORY) {
    state.history[key].shift();
  }
}

function drawAllSparklines() {
  drawSparkline("air", "#2f7068", state.settings.targets.air);
  drawSparkline("humidity", "#365f8d", state.settings.targets.humidity);
  drawSparkline("substrate", "#bf7b22", state.settings.targets.substrate);
}

function drawSparkline(key, color, target) {
  const canvas = els.sparklines[key];
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  const points = state.history[key];

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1 * dpr;
  ctx.strokeStyle = "rgba(101, 112, 107, 0.18)";

  for (let i = 1; i < 4; i += 1) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (points.length < 2) {
    return;
  }

  const values = points.map((point) => point.value);
  const minValue = Math.min(...values, target.min);
  const maxValue = Math.max(...values, target.max);
  const padding = Math.max((maxValue - minValue) * 0.18, 0.5);
  const min = minValue - padding;
  const max = maxValue + padding;
  const range = max - min || 1;
  const mapY = (value) => height - ((value - min) / range) * height;
  const targetTop = mapY(target.max);
  const targetBottom = mapY(target.min);

  ctx.fillStyle = "rgba(47, 125, 79, 0.10)";
  ctx.fillRect(0, targetTop, width, Math.max(2 * dpr, targetBottom - targetTop));

  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2 * dpr;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();

  points.forEach((point, index) => {
    const x = points.length === 1 ? width : (index / (points.length - 1)) * width;
    const y = mapY(point.value);
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();
}

function makeDemoPayload() {
  const t = Date.now() / 1000;
  const air = 21.1 + Math.sin(t / 18) * 1.25 + jitter(0.18);
  const humidity = 90 + Math.sin(t / 24 + 1.5) * 4.5 + jitter(0.45);
  const substrate = 20.7 + Math.sin(t / 30 + 0.6) * 0.85 + jitter(0.12);

  return {
    sht20_temperature: air,
    sht20_humidity: humidity,
    pt100_temperature: substrate,
    sht20_online: true,
    pt100_online: true,
    wifi_rssi: -56 + Math.sin(t / 20) * 4,
    mqtt_connected: state.settings.source === "mqtt" ? state.connected : true,
    ip: "192.168.1.50",
    uptime_ms: Date.now() % 86400000
  };
}

function jitter(amount) {
  return (Math.random() - 0.5) * amount * 2;
}

function firstNumber(...values) {
  for (const value of values) {
    if (isFiniteNumber(value)) {
      return Number(value);
    }
  }
  return null;
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function numberInRangeOrDefault(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function boolOrDefault(value, fallback) {
  if (value === true || value === "true" || value === 1 || value === "1") {
    return true;
  }

  if (value === false || value === "false" || value === 0 || value === "0") {
    return false;
  }

  return fallback;
}

function isFiniteNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function readableError(error) {
  if (error?.name === "AbortError") {
    return "Timeout";
  }

  const message = error?.message || String(error);
  return message.length > 24 ? `${message.slice(0, 24)}...` : message;
}

function esp32ConnectionError(error) {
  if (error?.name === "AbortError" || error?.name === "TypeError") {
    return "ESP32 offline";
  }

  return readableError(error);
}

function debounce(callback, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => callback(...args), wait);
  };
}
