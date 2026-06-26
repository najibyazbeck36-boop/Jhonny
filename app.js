const STORAGE_KEY = "mushroom-climate-dashboard-settings";
const MAX_HISTORY = 80;

const DEFAULT_SETTINGS = {
  source: "demo",
  mqttUrl: "",
  mqttTopic: "centralcommand/room1/sensors",
  mqttUser: "",
  mqttPassword: "",
  apiUrl: "http://192.168.1.50/api",
  irUrl: "",
  targets: {
    air: { min: 18, max: 24 },
    humidity: { min: 85, max: 95 },
    substrate: { min: 18, max: 24 }
  }
};

const state = {
  settings: loadSettings(),
  mqttClient: null,
  timer: null,
  irTimer: null,
  irBusy: false,
  connected: false,
  connectionText: "Starting",
  lastReading: null,
  history: {
    air: [],
    humidity: [],
    substrate: []
  }
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  hydrateSettingsForm();
  updateTargetLabels();
  startDataSource();
  startIrPolling();
  window.addEventListener("resize", debounce(drawAllSparklines, 120));
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
    "acUrlInput",
    "acConnectButton",
    "airMinInput",
    "airMaxInput",
    "humidityMinInput",
    "humidityMaxInput",
    "substrateMinInput",
    "substrateMaxInput",
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
}

function bindEvents() {
  els.settingsButton.addEventListener("click", openSettings);
  els.closeSettingsButton.addEventListener("click", closeSettings);
  els.connectButton.addEventListener("click", startDataSource);
  els.irRefreshButton.addEventListener("click", loadIrStatus);
  els.acConnectButton.addEventListener("click", () => {
    saveIrUrlFromPanel();
    loadIrStatus();
  });
  els.acUrlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveIrUrlFromPanel();
      loadIrStatus();
    }
  });
  els.irCommandButtons.forEach((button) => {
    button.addEventListener("click", () => sendIrCommand(button.dataset.irCmd));
  });

  els.resetSettingsButton.addEventListener("click", () => {
    state.settings = structuredClone(DEFAULT_SETTINGS);
    saveSettings();
    hydrateSettingsForm();
    updateTargetLabels();
    startIrPolling();
  });

  els.settingsModal.addEventListener("click", (event) => {
    if (event.target === els.settingsModal) {
      closeSettings();
    }
  });

  els.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.settings = readSettingsForm();
    saveSettings();
    updateTargetLabels();
    closeSettings();
    startDataSource();
    startIrPolling();
  });
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return mergeSettings(DEFAULT_SETTINGS, stored || {});
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function mergeSettings(base, incoming) {
  const merged = structuredClone(base);
  Object.assign(merged, incoming);
  merged.targets = {
    air: { ...base.targets.air, ...(incoming.targets?.air || {}) },
    humidity: { ...base.targets.humidity, ...(incoming.targets?.humidity || {}) },
    substrate: { ...base.targets.substrate, ...(incoming.targets?.substrate || {}) }
  };
  return merged;
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
}

function openSettings() {
  hydrateSettingsForm();
  els.settingsModal.hidden = false;
  els.mqttUrlInput.focus();
}

function closeSettings() {
  els.settingsModal.hidden = true;
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
  els.acUrlInput.value = settings.irUrl || "";
  els.airMinInput.value = settings.targets.air.min;
  els.airMaxInput.value = settings.targets.air.max;
  els.humidityMinInput.value = settings.targets.humidity.min;
  els.humidityMaxInput.value = settings.targets.humidity.max;
  els.substrateMinInput.value = settings.targets.substrate.min;
  els.substrateMaxInput.value = settings.targets.substrate.max;
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
  settings.targets.air.min = numberOrDefault(els.airMinInput.value, DEFAULT_SETTINGS.targets.air.min);
  settings.targets.air.max = numberOrDefault(els.airMaxInput.value, DEFAULT_SETTINGS.targets.air.max);
  settings.targets.humidity.min = numberOrDefault(els.humidityMinInput.value, DEFAULT_SETTINGS.targets.humidity.min);
  settings.targets.humidity.max = numberOrDefault(els.humidityMaxInput.value, DEFAULT_SETTINGS.targets.humidity.max);
  settings.targets.substrate.min = numberOrDefault(els.substrateMinInput.value, DEFAULT_SETTINGS.targets.substrate.min);
  settings.targets.substrate.max = numberOrDefault(els.substrateMaxInput.value, DEFAULT_SETTINGS.targets.substrate.max);
  return settings;
}

function startDataSource() {
  stopDataSource();
  state.connected = false;
  state.connectionText = "Connecting";
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
  mirrorIrUrlInputs();
  renderIrUnavailable("Set URL", "Enter AC ESP URL, then press Connect.");

  if (!state.settings.irUrl) {
    return;
  }

  loadIrStatus();
  state.irTimer = setInterval(loadIrStatus, 10000);
}

function stopIrPolling() {
  if (state.irTimer) {
    clearInterval(state.irTimer);
    state.irTimer = null;
  }
}

function saveIrUrlFromPanel(options = {}) {
  const nextUrl = normalizeDeviceUrl(els.acUrlInput.value);

  if (nextUrl === state.settings.irUrl) {
    mirrorIrUrlInputs();
    return Boolean(nextUrl);
  }

  state.settings.irUrl = nextUrl;
  saveSettings();
  mirrorIrUrlInputs();

  if (!options.silent) {
    stopIrPolling();
    if (nextUrl) {
      state.irTimer = setInterval(loadIrStatus, 10000);
    }
  }

  return Boolean(nextUrl);
}

function mirrorIrUrlInputs() {
  const value = state.settings.irUrl || "";
  els.acUrlInput.value = value;
  els.irUrlInput.value = value;
}

function focusAcUrlInput() {
  els.acUrlInput.focus();
  els.acUrlInput.classList.remove("attention");
  requestAnimationFrame(() => {
    els.acUrlInput.classList.add("attention");
  });
}

async function loadIrStatus() {
  saveIrUrlFromPanel({ silent: true });

  if (!state.settings.irUrl) {
    renderIrUnavailable("Set URL", "Enter AC ESP URL, then press Connect.");
    return;
  }

  if (isHttpsPageWithHttpDevice(state.settings.irUrl)) {
    renderIrUnavailable("HTTPS blocked", "Direct HTTP control is blocked from this HTTPS page.");
    return;
  }

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
  saveIrUrlFromPanel({ silent: true });

  if (!state.settings.irUrl) {
    renderIrUnavailable("Set URL", "Enter AC ESP URL before sending commands.");
    focusAcUrlInput();
    return;
  }

  if (isHttpsPageWithHttpDevice(state.settings.irUrl)) {
    renderIrUnavailable("HTTPS blocked", "Direct HTTP control is blocked from this HTTPS page.");
    return;
  }

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
  setIrControlsEnabled(Boolean(state.settings.irUrl) && !state.irBusy);
  updateIrSelections(status);
}

function renderIrUnavailable(label, logMessage) {
  setIrBadge(label, label === "Set URL" ? "" : "bad");
  els.acTemp.textContent = "--";
  els.acPower.textContent = "--";
  els.acMode.textContent = "--";
  els.acFan.textContent = "--";
  els.acLog.textContent = logMessage;
  setIrControlsEnabled(true);
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
  els.irRefreshButton.disabled = state.irBusy;
  els.acConnectButton.disabled = state.irBusy;
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
      applyPayload(payload);
    } catch (error) {
      state.connected = false;
      state.connectionText = readableError(error);
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
    state.connected = true;
    state.connectionText = "Online";
    state.mqttClient.subscribe(state.settings.mqttTopic);
    updateSystemLabels();
  });

  state.mqttClient.on("message", (topic, message) => {
    if (topic !== state.settings.mqttTopic) {
      return;
    }

    try {
      applyPayload(JSON.parse(message.toString()));
    } catch (error) {
      state.connectionText = "Bad JSON";
      updateSystemLabels();
    }
  });

  state.mqttClient.on("reconnect", () => {
    state.connected = false;
    state.connectionText = "Reconnecting";
    updateSystemLabels();
  });

  state.mqttClient.on("offline", () => {
    state.connected = false;
    state.connectionText = "Offline";
    updateSystemLabels();
  });

  state.mqttClient.on("error", (error) => {
    state.connected = false;
    state.connectionText = readableError(error);
    updateSystemLabels();
  });
}

function applyPayload(payload) {
  const reading = normalizePayload(payload);
  const now = new Date();
  reading.receivedAt = now;
  state.lastReading = reading;

  pushHistory("air", reading.airTemp);
  pushHistory("humidity", reading.humidity);
  pushHistory("substrate", reading.substrateTemp);

  renderReading(reading);
  drawAllSparklines();
}

function normalizePayload(payload) {
  const airTemp = firstNumber(
    payload.sht20_temperature,
    payload.air_temperature,
    payload.airTemp,
    payload.temperature
  );
  const humidity = firstNumber(
    payload.sht20_humidity,
    payload.humidity,
    payload.relative_humidity
  );
  const substrateTemp = firstNumber(
    payload.pt100_temperature,
    payload.substrate_temperature,
    payload.substrateTemp,
    payload.probe_temperature
  );

  return {
    airTemp,
    humidity,
    substrateTemp,
    sht20Online: boolOrDefault(payload.sht20_online, isFiniteNumber(airTemp) || isFiniteNumber(humidity)),
    pt100Online: boolOrDefault(payload.pt100_online, isFiniteNumber(substrateTemp)),
    mqttConnected: boolOrDefault(payload.mqtt_connected, state.settings.source === "mqtt" ? state.connected : null),
    wifiRssi: firstNumber(payload.wifi_rssi, payload.rssi),
    ip: payload.ip || payload.device_ip || "--",
    uptimeMs: firstNumber(payload.uptime_ms, payload.uptime),
    raw: payload
  };
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

function debounce(callback, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => callback(...args), wait);
  };
}
