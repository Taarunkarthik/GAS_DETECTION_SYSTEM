"use strict";

const API_BASE = String(window.EMBERWATCH_API_BASE || "").replace(/\/+$/, "");
const apiUrl = (path) => `${API_BASE}${path}`;
const $ = (selector) => document.querySelector(selector);
const chartCanvas = $("#trendChart");
const chartEmpty = $("#chartEmpty");
const history = [];
let latestReading = null;
let activeModalId = null;
let previousAlarmActive = false;
let browserAlertsEnabled = false;
let audioContext = null;
let alarmInterval = null;
let currentThresholds = { temperatureWarningC: 30, temperatureC: 35, smokeRawWarning: 225, smokeRaw: 300 };

function localTime(value) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function relativeTime(value) {
  if (!value) return "--";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 3) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function greeting() {
  const hour = new Date().getHours();
  $("#greetingTime").textContent = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  $("#todayLabel").textContent = new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
}

function formatTemperature(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "--" : Number(value).toFixed(1);
}

function updateConnection(backendOnline, deviceOnline, isAlert = false, isWarning = false) {
  const pill = $("#connectionPill");
  pill.classList.toggle("is-offline", !backendOnline || !deviceOnline);
  pill.classList.toggle("is-alert", Boolean(isAlert));
  pill.classList.toggle("is-warning", Boolean(isWarning) && !isAlert && backendOnline && deviceOnline);
  $("#connectionText").textContent = isAlert
    ? "Fire alert"
    : !backendOnline
        ? "Backend offline"
        : !deviceOnline
          ? "Device offline"
          : isWarning
            ? "Sensor warning"
            : "ESP32 online";
}

function setHero(state, online) {
  const current = state && state.latest;
  const active = Boolean(current && current.fire && current.fire.active);
  const warning = Boolean(current && current.status === "WARNING");
  document.body.classList.toggle("alarm-on", active);
  document.body.classList.toggle("warning-on", warning && !active);
  document.body.classList.toggle("device-online", online);
  updateConnection(true, online, active, warning);

  if (!current) {
    $("#heroOverline").textContent = "SYSTEM STANDING BY";
    $("#heroTitle").innerHTML = "Your watch starts<br>when your device connects.";
    $("#heroDescription").textContent = "Bring your ESP32 online to stream live sensor readings to this dashboard.";
    $("#visualCaption").textContent = "SENSORS ON STANDBY";
    $("#lastUpdated").textContent = online ? "Waiting for the first reading" : "Waiting for your ESP32";
    $("#deviceState").textContent = "Not connected";
    $("#deviceCaption").textContent = "Waiting for first heartbeat";
    $("#deviceStatusDot").className = "device-status-dot";
    $("#deviceProgress").className = "";
    $("#wifiValue").textContent = "-- dBm";
    $("#heartbeatValue").textContent = "--";
    $("#humidityValue").textContent = "--%";
    $("#temperatureValue").textContent = "--";
    $("#smokeValue").textContent = "--";
    $("#temperatureValueDetail").textContent = "--";
    $("#smokeValueDetail").textContent = "--";
    $("#temperatureState").textContent = "Awaiting reading";
    $("#smokeState").textContent = "Awaiting reading";
    $("#temperatureState").className = "sensor-state state-muted";
    $("#smokeState").className = "sensor-state state-muted";
    $("#temperatureStateDetail").textContent = "Awaiting reading";
    $("#smokeStateDetail").textContent = "Awaiting reading";
    $("#temperatureStateDetail").className = "sensor-state state-muted";
    $("#smokeStateDetail").className = "sensor-state state-muted";
    document.querySelectorAll(".scale-fill").forEach((marker) => {
      marker.style.left = "4px";
      marker.classList.remove("warning", "critical");
    });
    maybeResolveAlert(false, null);
    return;
  }

  const temperatureWarning = current.temperatureC !== null && current.temperatureC >= currentThresholds.temperatureWarningC;
  const temperatureCritical = current.temperatureC !== null && current.temperatureC >= currentThresholds.temperatureC;
  const smokeWarning = current.smokeRaw >= currentThresholds.smokeRawWarning;
  const smokeCritical = current.smokeRaw >= currentThresholds.smokeRaw;
  const receivedAt = current.receivedAt;
  $("#heroOverline").textContent = active ? "CRITICAL FIRE CONDITION" : warning ? "ELEVATED READINGS" : online ? "SYSTEM PROTECTED" : "DEVICE SIGNAL LOST";
  $("#heroTitle").innerHTML = active
    ? "Fire signature<br>detected."
    : warning
      ? "Elevated readings<br>need attention."
      : online
        ? "Everything looks<br>clear."
        : "Your monitor has<br>gone offline.";
  $("#heroDescription").textContent = active
    ? "A critical sensor threshold was crossed. Check the area and respond safely."
    : warning
      ? "A sensor crossed its warning threshold. Check the temperature and smoke readings."
      : online
        ? "Your ESP32 is checking for abnormal smoke and temperature levels."
        : "The last sensor reading is stale. Check the ESP32 power and Wi-Fi connection.";
  $("#visualCaption").textContent = active ? "CRITICAL ALERT ACTIVE" : warning ? "WARNING · CHECK SENSORS" : online ? "SENSORS STREAMING" : "SIGNAL INTERRUPTED";
  $("#lastUpdated").textContent = `Updated ${relativeTime(receivedAt)}`;
  $("#deviceState").textContent = online ? (active ? "Fire alert" : warning ? "Warning" : "Connected") : "Signal lost";
  $("#deviceCaption").textContent = `${current.deviceId || "ESP32 fire monitor"} · heartbeat ${online ? "healthy" : "stale"}`;
  $("#deviceStatusDot").className = `device-status-dot ${online ? "online" : "warning"}`;
  $("#deviceProgress").className = online ? "online" : "";
  $("#wifiValue").textContent = `${current.rssi} dBm`;
  $("#heartbeatValue").textContent = relativeTime(receivedAt);
  $("#humidityValue").textContent = current.humidity === null || current.humidity === undefined ? "--%" : `${Number(current.humidity).toFixed(1)}%`;
  $("#temperatureValue").textContent = formatTemperature(current.temperatureC);
  $("#smokeValue").textContent = Number(current.smokeRaw).toLocaleString();
  $("#temperatureValueDetail").textContent = formatTemperature(current.temperatureC);
  $("#smokeValueDetail").textContent = Number(current.smokeRaw).toLocaleString();

  const markerValue = Number(current.temperatureC);
  const markerPercent = Number.isFinite(markerValue) ? Math.max(2, Math.min(98, markerValue / 60 * 100)) : 2;
  document.querySelectorAll(".scale-fill").forEach((temperatureMarker) => {
    temperatureMarker.style.left = String(markerPercent) + "%";
    temperatureMarker.classList.toggle("warning", temperatureWarning && !temperatureCritical);
    temperatureMarker.classList.toggle("critical", temperatureCritical);
  });

  const tempState = $("#temperatureState");
  tempState.textContent = current.temperatureC === null ? "Sensor unavailable" : temperatureCritical ? "Critical" : temperatureWarning ? "Warning" : "Within range";
  const temperatureStateClass = current.temperatureC === null ? "state-muted" : temperatureCritical ? "state-alert" : temperatureWarning ? "state-warning" : "state-normal";
  tempState.className = `sensor-state ${temperatureStateClass}`;
  $("#temperatureStateDetail").textContent = tempState.textContent;
  $("#temperatureStateDetail").className = `sensor-state ${temperatureStateClass}`;
  const smokeState = $("#smokeState");
  smokeState.textContent = !current.smokeSensorOk ? "Check sensor input" : smokeCritical ? "Critical" : smokeWarning ? "Warning" : "Within range";
  const smokeStateClass = !current.smokeSensorOk ? "state-muted" : smokeCritical ? "state-alert" : smokeWarning ? "state-warning" : "state-normal";
  smokeState.className = `sensor-state ${smokeStateClass}`;
  $("#smokeStateDetail").textContent = smokeState.textContent;
  $("#smokeStateDetail").className = `sensor-state ${smokeStateClass}`;

  if (active) {
    const fire = current.fire;
    if (fire.eventId) {
      const event = { id: fire.eventId, triggeredAt: fire.since || receivedAt, reasons: fire.reasons, temperatureC: current.temperatureC, smokeRaw: current.smokeRaw };
      if (sessionStorage.getItem("emberwatch-acknowledged") !== fire.eventId && activeModalId !== fire.eventId) openAlert(event, current);
      else updateAlertReadings(event, current);
    }
  }
  maybeResolveAlert(active, current);
}

function pushHistory(reading) {
  if (!reading || !reading.receivedAt) return;
  const last = history[history.length - 1];
  if (last && last.receivedAt === reading.receivedAt && last.deviceId === reading.deviceId) return;
  history.push(reading);
  if (history.length > 360) history.splice(0, history.length - 360);
  drawChart();
}

function applyState(state) {
  if (!state) return;
  if (state.thresholds) {
    currentThresholds = state.thresholds;
    $("#temperatureLimit").textContent = `${state.thresholds.temperatureWarningC}° / ${state.thresholds.temperatureC}°C`;
    $("#smokeLimit").textContent = `${Number(state.thresholds.smokeRawWarning).toLocaleString()} / ${Number(state.thresholds.smokeRaw).toLocaleString()}`;
    $("#temperatureLimitDetail").textContent = `${state.thresholds.temperatureWarningC}° / ${state.thresholds.temperatureC}°C`;
    $("#smokeLimitDetail").textContent = `${Number(state.thresholds.smokeRawWarning).toLocaleString()} / ${Number(state.thresholds.smokeRaw).toLocaleString()}`;
    $("#thresholdSummary").textContent = `Warn ${state.thresholds.temperatureWarningC}°C / fire ${state.thresholds.temperatureC}°C · smoke ${Number(state.thresholds.smokeRawWarning).toLocaleString()} / ${Number(state.thresholds.smokeRaw).toLocaleString()} ADC`;
  }
  if (state.latest) {
    latestReading = state.latest;
    pushHistory(state.latest);
  }
  const online = Boolean(state.online && state.latest && Date.now() - Date.parse(state.latest.receivedAt) <= 10_000);
  setHero(state, online);
}

function applyReading(reading) {
  if (!reading) return;
  const previousStatus = latestReading ? latestReading.status : "SAFE";
  latestReading = reading;
  pushHistory(reading);
  const online = Date.now() - Date.parse(reading.receivedAt) <= 10_000;
  const previous = previousAlarmActive;
  previousAlarmActive = Boolean(reading.fire && reading.fire.active);
  setHero({ latest: reading }, online);
  if (previous && !previousAlarmActive) {
    stopAlarmSound();
    showToast(reading.status === "WARNING" ? "Critical fire reading cleared; warning conditions remain." : "Sensor readings are back within the safe range.");
  } else if (reading.status === "WARNING" && previousStatus !== "WARNING") {
    showToast("Warning threshold crossed. Check the sensor readings.");
  } else if (previousStatus === "WARNING" && reading.status === "SAFE") {
    showToast("Warning readings returned to the safe range.");
  }
}

function applyHistory(data) {
  if (Array.isArray(data.readings)) {
    for (const reading of data.readings) pushHistory(reading);
  }
  renderEvents(Array.isArray(data.alerts) ? data.alerts : []);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function renderEvents(events) {
  const container = $("#eventList");
  $("#eventCount").textContent = String(events.length);
  if (!events.length) {
    container.innerHTML = '<div class="activity-empty"><span class="empty-check">✓</span><div><strong>All quiet here</strong><small>No alerts have been recorded.</small></div></div>';
    return;
  }
  container.innerHTML = events.slice(0, 30).map((event) => {
    const cleared = event.status === "CLEARED";
    const time = event.clearedAt || event.triggeredAt;
    const reasons = Array.isArray(event.reasons) ? event.reasons.join(" · ") : "Sensor alert";
    return `<div class="event-item"><span class="event-icon ${cleared ? "cleared" : "alert"}">${cleared ? '<svg viewBox="0 0 20 20" fill="none"><path d="m4.5 10 3.5 3.5 7.5-7.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<svg viewBox="0 0 20 20" fill="none"><path d="M10 2.5 18 17H2l8-14.5Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M10 7v4m0 2.5v.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'}</span><span class="event-copy"><strong>${cleared ? "Alert cleared" : "Fire condition detected"}</strong><small>${escapeHtml(reasons)}${event.temperatureC === null ? "" : ` · ${escapeHtml(Number(event.temperatureC).toFixed(1))}°C`}</small></span><time class="event-time" datetime="${escapeHtml(time || "")}">${localTime(time)}</time></div>`;
  }).join("");
}

function showToast(message, alert = false) {
  const toast = document.createElement("div");
  toast.className = `toast${alert ? " alert" : ""}`;
  toast.textContent = message;
  $("#toastRegion").append(toast);
  window.setTimeout(() => toast.remove(), 4400);
}

function openAlert(event, reading) {
  activeModalId = event.id;
  $("#alertTitle").textContent = "Fire condition detected";
  $("#alertBody").textContent = "Your sensor readings crossed the configured alert threshold. Check the area and respond safely.";
  $("#modalKicker").textContent = "IMMEDIATE ATTENTION";
  $("#acknowledgeAlert").innerHTML = 'Acknowledge alert <span>→</span>';
  $("#alertBackdrop").classList.add("visible");
  $("#alertBackdrop").setAttribute("aria-hidden", "false");
  $("#acknowledgeAlert").focus();
  updateAlertReadings(event, reading);
  if (browserAlertsEnabled) startAlarmSound();
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification("Emberwatch · Fire condition", { body: (event.reasons || []).join(" · ") || "Sensor threshold crossed" }); } catch { /* Browser notification may be unavailable in an installed context. */ }
  }
}

function updateAlertReadings(event, reading) {
  $("#modalTemperature").textContent = `${formatTemperature(reading.temperatureC)} °C`;
  $("#modalSmoke").textContent = `${Number(reading.smokeRaw).toLocaleString()} ADC`;
  $("#modalTime").textContent = localTime(event.triggeredAt);
  $("#modalReasons").innerHTML = (event.reasons || []).map((reason) => `<span class="reason-tag">${escapeHtml(reason)}</span>`).join("");
}

function maybeResolveAlert(active, reading) {
  if (active || !activeModalId || !reading) return;
  const backdrop = $("#alertBackdrop");
  if (!backdrop.classList.contains("visible")) return;
  if (reading.status === "WARNING") {
    $("#modalKicker").textContent = "FIRE LEVEL CLEARED";
    $("#alertTitle").textContent = "Warning conditions remain";
    $("#alertBody").textContent = "Critical thresholds are no longer crossed, but one or more readings are still above the warning level.";
    $("#modalReasons").innerHTML = '<span class="reason-tag">Warning state remains active</span>';
  } else {
    $("#modalKicker").textContent = "CONDITION CLEARED";
    $("#alertTitle").textContent = "Readings are back in range";
    $("#alertBody").textContent = "The current readings are below the warning thresholds. Keep monitoring the area.";
    $("#modalReasons").innerHTML = '<span class="reason-tag">Temperature and smoke levels cleared</span>';
  }
  $("#acknowledgeAlert").innerHTML = 'Close alert <span>→</span>';
  stopAlarmSound();
}

function closeAlert() {
  if (activeModalId) sessionStorage.setItem("emberwatch-acknowledged", activeModalId);
  $("#alertBackdrop").classList.remove("visible");
  $("#alertBackdrop").setAttribute("aria-hidden", "true");
  stopAlarmSound();
}

function playBeep() {
  if (!audioContext || audioContext.state !== "running") return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(780, audioContext.currentTime);
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.07, audioContext.currentTime + .025);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + .22);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + .23);
}

function startAlarmSound() {
  if (!browserAlertsEnabled || alarmInterval) return;
  playBeep();
  alarmInterval = window.setInterval(playBeep, 1250);
}

function stopAlarmSound() {
  if (alarmInterval) window.clearInterval(alarmInterval);
  alarmInterval = null;
}

async function enableBrowserAlerts() {
  browserAlertsEnabled = true;
  if (window.AudioContext || window.webkitAudioContext) {
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    audioContext ||= new AudioContextType();
    try { await audioContext.resume(); } catch { /* Sound remains optional when browser audio is blocked. */ }
  }
  let permission = "unsupported";
  if ("Notification" in window) {
    try { permission = await Notification.requestPermission(); } catch { permission = "denied"; }
  }
  const buttonText = permission === "granted" ? "Alerts enabled" : "Sound alerts enabled";
  $("#alertsButtonText").textContent = buttonText;
  $("#enableAlerts").title = permission === "granted" ? "Browser alerts and sound are enabled" : "Sound alerts are enabled for this tab";
  showToast(permission === "granted" ? "Browser notifications and sound alerts are enabled." : "Sound alerts are enabled for this tab. Allow browser notifications in your browser settings for desktop alerts.");
  if (latestReading && latestReading.fire && latestReading.fire.active) startAlarmSound();
}

function drawChart() {
  const rect = chartCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  chartCanvas.width = Math.round(rect.width * ratio);
  chartCanvas.height = Math.round(rect.height * ratio);
  const context = chartCanvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = rect.width;
  const height = rect.height;
  context.clearRect(0, 0, width, height);
  chartEmpty.classList.toggle("hidden", history.length > 0);
  $("#chartCount").textContent = `${history.length} sample${history.length === 1 ? "" : "s"}`;
  if (!history.length) {
    $("#chartStart").textContent = "--:--";
    $("#chartEnd").textContent = "--:--";
    return;
  }

  const inset = { left: 31, right: 29, top: 11, bottom: 13 };
  const plotWidth = width - inset.left - inset.right;
  const plotHeight = height - inset.top - inset.bottom;
  const top = inset.top;
  const bottom = top + plotHeight;
  const x = (index) => inset.left + (history.length === 1 ? plotWidth : (index / (history.length - 1)) * plotWidth);
  const tempY = (value) => bottom - (Math.max(0, Math.min(80, value)) / 80) * plotHeight;
  const smokeY = (value) => bottom - (Math.max(0, Math.min(100, value)) / 100) * plotHeight;

  context.lineWidth = 1;
  context.font = '8px "IBM Plex Mono", Consolas, monospace';
  context.textBaseline = "middle";
  for (let step = 0; step <= 4; step += 1) {
    const y = top + (step / 4) * plotHeight;
    const tempLabel = String(80 - step * 20);
    const smokeLabel = String(100 - step * 25);
    context.strokeStyle = "rgba(60, 54, 44, .13)";
    context.setLineDash(step === 4 ? [] : [2, 5]);
    context.beginPath();
    context.moveTo(inset.left, y);
    context.lineTo(width - inset.right, y);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "#8a8377";
    context.textAlign = "right";
    context.fillText(tempLabel, inset.left - 8, y);
    context.textAlign = "left";
    context.fillText(smokeLabel, width - inset.right + 7, y);
  }
  for (let step = 0; step <= 4; step += 1) {
    const px = inset.left + (step / 4) * plotWidth;
    context.strokeStyle = "rgba(60, 54, 44, .08)";
    context.setLineDash([2, 6]);
    context.beginPath();
    context.moveTo(px, top);
    context.lineTo(px, bottom);
    context.stroke();
  }
  context.setLineDash([]);

  const temperatures = history.filter((reading) => Number.isFinite(reading.temperatureC));
  if (temperatures.length) {
    const points = temperatures.map((reading) => ({ x: x(history.indexOf(reading)), y: tempY(reading.temperatureC) }));
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
    const gradient = context.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, "rgba(217, 93, 62, .19)");
    gradient.addColorStop(1, "rgba(217, 93, 62, 0)");
    context.lineTo(points[points.length - 1].x, bottom);
    context.lineTo(points[0].x, bottom);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();
    context.beginPath();
    points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
    context.lineWidth = 1.8;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.strokeStyle = "#d95d3e";
    context.shadowColor = "rgba(217, 93, 62, .25)";
    context.shadowBlur = 6;
    context.stroke();
    context.shadowBlur = 0;
  }

  if (history.length > 1) {
    context.beginPath();
    history.forEach((reading, index) => {
      const pointX = x(index);
      const pointY = smokeY((reading.smokeRaw / 4095) * 100);
      if (index === 0) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    });
    context.lineWidth = 1.5;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.strokeStyle = "#208779";
    context.shadowColor = "rgba(32, 135, 121, .22)";
    context.shadowBlur = 5;
    context.stroke();
    context.shadowBlur = 0;
  }
  const first = history[0].receivedAt;
  const last = history[history.length - 1].receivedAt;
  $("#chartStart").textContent = localTime(first);
  $("#chartEnd").textContent = localTime(last);
}

async function loadInitialData() {
  try {
    const [stateResponse, historyResponse] = await Promise.all([fetch(apiUrl("/api/state"), { cache: "no-store" }), fetch(apiUrl("/api/history"), { cache: "no-store" })]);
    if (!stateResponse.ok || !historyResponse.ok) throw new Error("Dashboard API unavailable");
    const state = await stateResponse.json();
    const log = await historyResponse.json();
    applyHistory(log);
    applyState(state);
    previousAlarmActive = Boolean(state.latest && state.latest.fire && state.latest.fire.active);
    updateConnection(true, state.online, previousAlarmActive, Boolean(state.latest && state.latest.status === "WARNING"));
  } catch {
    updateConnection(false, false);
    showToast("The dashboard could not reach its API. Check the backend URL and CORS settings.");
  }
}

function startPolling() {
  loadInitialData();
  const intervalMs = Math.max(1500, Number(window.EMBERWATCH_POLL_INTERVAL_MS) || 2500);
  window.setInterval(async () => {
    try {
      const [stateResponse, historyResponse] = await Promise.all([
        fetch(apiUrl("/api/state"), { cache: "no-store" }),
        fetch(apiUrl("/api/history"), { cache: "no-store" }),
      ]);
      if (!stateResponse.ok || !historyResponse.ok) throw new Error("Dashboard API unavailable");
      const [state, log] = await Promise.all([stateResponse.json(), historyResponse.json()]);
      applyHistory(log);
      applyState(state);
      previousAlarmActive = Boolean(state.latest && state.latest.fire && state.latest.fire.active);
      updateConnection(true, state.online, previousAlarmActive, Boolean(state.latest && state.latest.status === "WARNING"));
    } catch {
      updateConnection(false, false);
    }
  }, intervalMs);
}

function connectLiveStream() {
  const source = new EventSource(apiUrl("/api/stream"));
  source.addEventListener("snapshot", (message) => {
    try {
      applyState(JSON.parse(message.data));
      previousAlarmActive = Boolean(latestReading && latestReading.fire && latestReading.fire.active);
    } catch { /* Ignore malformed frames and let the next snapshot recover state. */ }
  });
  source.addEventListener("reading", (message) => {
    try { applyReading(JSON.parse(message.data)); } catch { /* Ignore malformed frames. */ }
  });
  source.addEventListener("device", (message) => {
    try {
      const device = JSON.parse(message.data);
      updateConnection(true, device.online, Boolean(latestReading && latestReading.fire && latestReading.fire.active), Boolean(latestReading && latestReading.status === "WARNING"));
    } catch { /* Ignore malformed frames. */ }
  });
  source.addEventListener("alarm", () => {
    fetch(apiUrl("/api/history"), { cache: "no-store" }).then((response) => response.json()).then(applyHistory).catch(() => {});
  });
  source.addEventListener("alarm-cleared", () => {
    fetch(apiUrl("/api/history"), { cache: "no-store" }).then((response) => response.json()).then(applyHistory).catch(() => {});
  });
  source.onerror = () => updateConnection(false, false, Boolean(latestReading && latestReading.fire && latestReading.fire.active), Boolean(latestReading && latestReading.status === "WARNING"));
}

function showScreen(name, updateUrl = true) {
  const allowedScreens = new Set(["overview", "sensors", "activity", "device", "guide"]);
  const screenName = allowedScreens.has(name) ? name : "overview";
  const targetScreen = document.querySelector(`[data-screen="${screenName}"]`);
  if (!targetScreen) return;
  const alreadyActive = targetScreen.classList.contains("is-active");

  document.querySelectorAll(".screen-view").forEach((screen) => {
    const active = screen === targetScreen;
    screen.hidden = !active;
    screen.classList.toggle("is-active", active);
  });

  document.querySelectorAll("[data-screen-target]").forEach((control) => {
    if (!control.classList.contains("rail-link")) return;
    const active = control.dataset.screenTarget === screenName;
    control.classList.toggle("active", active);
    if (active) control.setAttribute("aria-current", "page");
    else control.removeAttribute("aria-current");
  });

  if (updateUrl && !alreadyActive) window.history.pushState({ screen: screenName }, "", `#${screenName}`);
  if (!alreadyActive) {
    window.scrollTo(0, 0);
    targetScreen.focus({ preventScroll: true });
  }
  if (screenName === "activity") drawChart();
}

document.querySelectorAll("[data-screen-target]").forEach((control) => {
  control.addEventListener("click", (event) => {
    event.preventDefault();
    showScreen(control.dataset.screenTarget);
  });
});

window.addEventListener("popstate", () => showScreen(window.location.hash.slice(1), false));

$("#acknowledgeAlert").addEventListener("click", closeAlert);
$("#enableAlerts").addEventListener("click", enableBrowserAlerts);
$("#enableAlertsSecondary").addEventListener("click", enableBrowserAlerts);
window.addEventListener("resize", drawChart);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#alertBackdrop").classList.contains("visible")) closeAlert();
});
window.addEventListener("focus", () => { if (latestReading) drawChart(); });

greeting();
showScreen(window.location.hash.slice(1), false);
if (window.EMBERWATCH_POLLING) {
  startPolling();
} else {
  loadInitialData();
  connectLiveStream();
}
window.setInterval(() => {
  if (!latestReading) return;
  const online = Date.now() - Date.parse(latestReading.receivedAt) <= 10_000;
  setHero({ latest: latestReading }, online);
  $("#heartbeatValue").textContent = relativeTime(latestReading.receivedAt);
  $("#lastUpdated").textContent = `Updated ${relativeTime(latestReading.receivedAt)}`;
}, 2500);
