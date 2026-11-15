"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, ".data");
const LATEST_FILE = path.join(DATA_DIR, "latest-reading.json");
const ALERTS_FILE = path.join(DATA_DIR, "alerts.jsonl");
const ONLINE_WINDOW_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_READINGS = 360;
const MAX_ALERTS = 80;

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || "demo-key-change-before-deployment";
const TEMP_WARNING_C = Number(process.env.TEMP_WARNING_C || 30);
const TEMP_THRESHOLD_C = Number(process.env.FIRE_TEMP_C || 35);
const SMOKE_WARNING = Number(process.env.SMOKE_WARNING_RAW || 225);
const SMOKE_THRESHOLD = Number(process.env.SMOKE_RAW_THRESHOLD || 300);

if (process.env.NODE_ENV === "production" && DEVICE_API_KEY === "demo-key-change-before-deployment") {
  throw new Error("Set a unique DEVICE_API_KEY before starting in production.");
}

fs.mkdirSync(DATA_DIR, { recursive: true });
let latest = readJsonFile(LATEST_FILE);
let readings = latest ? [latest] : [];
let alerts = readAlertLog();
let wasOnline = isDeviceOnline();
const streams = new Set();

function loadEnvFile() {
  const filename = path.join(ROOT, ".env");
  if (!fs.existsSync(filename)) return;
  for (const rawLine of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readJsonFile(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    return null;
  }
}

function readAlertLog() {
  try {
    return fs.readFileSync(ALERTS_FILE, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(-MAX_ALERTS)
      .reverse();
  } catch {
    return [];
  }
}

function writeAlerts() {
  const lines = alerts.slice(0, MAX_ALERTS).reverse().map((event) => JSON.stringify(event));
  fs.writeFileSync(ALERTS_FILE, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
}

function saveLatest(reading) {
  const temporaryFile = `${LATEST_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(reading), "utf8");
  fs.renameSync(temporaryFile, LATEST_FILE);
}

function isDeviceOnline() {
  if (!latest || !latest.receivedAt) return false;
  return Date.now() - Date.parse(latest.receivedAt) <= ONLINE_WINDOW_MS;
}

function publicState() {
  return {
    online: isDeviceOnline(),
    latest,
    thresholds: {
      temperatureWarningC: TEMP_WARNING_C,
      temperatureC: TEMP_THRESHOLD_C,
      temperatureClearC: TEMP_WARNING_C,
      smokeRawWarning: SMOKE_WARNING,
      smokeRaw: SMOKE_THRESHOLD,
      smokeRawClear: SMOKE_WARNING,
    },
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendSse(response, event, value) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function publish(event, value) {
  for (const response of streams) sendSse(response, event, value);
}

function isAuthorized(request) {
  const supplied = request.headers["x-device-key"];
  if (typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(DEVICE_API_KEY);
  const suppliedBytes = Buffer.from(supplied);
  return suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

async function readRequestJson(request) {
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of request) {
    byteCount += chunk.length;
    if (byteCount > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Expected a JSON request body.");
    error.statusCode = 400;
    throw error;
  }
}

function validateReading(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw Object.assign(new Error("Reading must be a JSON object."), { statusCode: 400 });
  }

  const temperatureC = payload.temperatureC === null ? null : Number(payload.temperatureC);
  const humidity = payload.humidity === null ? null : Number(payload.humidity);
  const smokeRaw = Number(payload.smokeRaw);
  const sensorState = Number(payload.sensorState);
  const rssi = Number(payload.rssi);
  const uptimeMs = Number(payload.uptimeMs);
  const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : "esp32-fire-01";

  if (temperatureC !== null && (!Number.isFinite(temperatureC) || temperatureC < -40 || temperatureC > 125)) {
    throw Object.assign(new Error("temperatureC must be null or between -40 and 125."), { statusCode: 400 });
  }
  if (humidity !== null && (!Number.isFinite(humidity) || humidity < 0 || humidity > 100)) {
    throw Object.assign(new Error("humidity must be null or between 0 and 100."), { statusCode: 400 });
  }
  if (!Number.isInteger(smokeRaw) || smokeRaw < 0 || smokeRaw > 4095) {
    throw Object.assign(new Error("smokeRaw must be an integer from 0 to 4095."), { statusCode: 400 });
  }
  if (!Number.isInteger(sensorState) || sensorState < 0 || sensorState > 2) {
    throw Object.assign(new Error("sensorState must be 0 (safe), 1 (warning), or 2 (fire)."), { statusCode: 400 });
  }
  if (!Number.isFinite(rssi) || rssi < -120 || rssi > 0) {
    throw Object.assign(new Error("rssi must be between -120 and 0."), { statusCode: 400 });
  }
  if (!Number.isFinite(uptimeMs) || uptimeMs < 0) {
    throw Object.assign(new Error("uptimeMs must be a non-negative number."), { statusCode: 400 });
  }
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(deviceId)) {
    throw Object.assign(new Error("deviceId may contain letters, numbers, _ and - only."), { statusCode: 400 });
  }

  return { temperatureC, humidity, smokeRaw, sensorState, rssi: Math.round(rssi), uptimeMs: Math.round(uptimeMs), deviceId };
}

function createReading(payload) {
  const receivedAt = new Date().toISOString();
  const previousFire = latest && latest.fire ? latest.fire : { active: false };
  const smokeCritical = payload.smokeRaw >= SMOKE_THRESHOLD;
  const tempCritical = payload.temperatureC !== null && payload.temperatureC >= TEMP_THRESHOLD_C;
  const smokeWarning = payload.smokeRaw >= SMOKE_WARNING;
  const tempWarning = payload.temperatureC !== null && payload.temperatureC >= TEMP_WARNING_C;
  const deviceAlarm = payload.alarmActive === true;
  const status = deviceAlarm || payload.sensorState === 2 || smokeCritical || tempCritical
    ? "FIRE"
    : payload.sensorState === 1 || smokeWarning || tempWarning
      ? "WARNING"
      : "SAFE";
  const active = status === "FIRE";
  const reasons = [];
  if (smokeCritical) reasons.push("Smoke sensor above critical threshold");
  else if (smokeWarning) reasons.push("Smoke sensor above warning threshold");
  if (tempCritical) reasons.push("Temperature above critical threshold");
  else if (tempWarning) reasons.push("Temperature above warning threshold");
  if (deviceAlarm && reasons.length === 0) reasons.push("ESP32 reports critical fire state");
  if (status === "WARNING" && reasons.length === 0) reasons.push("ESP32 reports elevated sensor readings");

  let fire = { active, reasons, eventId: null, since: null };
  let newEvent = null;
  let clearedEvent = null;
  if (active && previousFire.active) {
    fire = {
      active: true,
      reasons: reasons.length ? reasons : previousFire.reasons,
      eventId: previousFire.eventId,
      since: previousFire.since,
    };
  } else if (active) {
    const eventId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const event = {
      id: eventId,
      triggeredAt: receivedAt,
      status: "ACTIVE",
      reasons: reasons.length ? reasons : ["ESP32 reports critical fire state"],
      temperatureC: payload.temperatureC,
      smokeRaw: payload.smokeRaw,
      deviceId: payload.deviceId,
    };
    alerts.unshift(event);
    alerts = alerts.slice(0, MAX_ALERTS);
    writeAlerts();
    fire = { active: true, reasons: event.reasons, eventId, since: receivedAt };
    newEvent = event;
  } else if (previousFire.active && previousFire.eventId) {
    const resolved = alerts.find((event) => event.id === previousFire.eventId);
    if (resolved && resolved.status === "ACTIVE") {
      resolved.status = "CLEARED";
      resolved.clearedAt = receivedAt;
      writeAlerts();
      clearedEvent = resolved;
    }
  }

  const reading = {
    deviceId: payload.deviceId,
    receivedAt,
    temperatureC: payload.temperatureC,
    humidity: payload.humidity,
    smokeRaw: payload.smokeRaw,
    status,
    statusReasons: reasons,
    rssi: payload.rssi,
    uptimeMs: payload.uptimeMs,
    smokeSensorOk: payload.smokeRaw > 0,
    temperatureSensorOk: payload.temperatureC !== null,
    humiditySensorOk: payload.humidity !== null,
    fire,
  };
  latest = reading;
  readings.push(reading);
  if (readings.length > MAX_READINGS) readings = readings.slice(-MAX_READINGS);
  saveLatest(reading);
  return { reading, newEvent, clearedEvent };
}

function contentTypeFor(filename) {
  const extension = path.extname(filename).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  })[extension] || "application/octet-stream";
}

function serveStatic(request, response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    sendJson(response, 400, { error: "Invalid path." });
    return;
  }
  const filename = path.resolve(PUBLIC_DIR, `.${decodedPath}`);
  if (!filename.startsWith(`${PUBLIC_DIR}${path.sep}`) && filename !== path.join(PUBLIC_DIR, "index.html")) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }
  fs.readFile(filename, (error, contents) => {
    if (error) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypeFor(filename),
      "Cache-Control": filename.endsWith(".html") ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
    });
    response.end(contents);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { ok: true, online: isDeviceOnline(), latestAt: latest ? latest.receivedAt : null });
      return;
    }
    if (request.method === "GET" && pathname === "/api/state") {
      sendJson(response, 200, publicState());
      return;
    }
    if (request.method === "GET" && pathname === "/api/history") {
      sendJson(response, 200, { readings, alerts: alerts.slice(0, 30) });
      return;
    }
    if (request.method === "GET" && pathname === "/api/stream") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(": connected\n\n");
      streams.add(response);
      sendSse(response, "snapshot", publicState());
      response.on("close", () => streams.delete(response));
      return;
    }
    if (request.method === "POST" && pathname === "/api/readings") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "Invalid or missing X-Device-Key." });
        return;
      }
      const payload = await readRequestJson(request);
      const validated = validateReading(payload);
      const result = createReading({ ...validated, alarmActive: payload.alarmActive === true });
      sendJson(response, 201, { ok: true, receivedAt: result.reading.receivedAt, fire: result.reading.fire });
      publish("reading", result.reading);
      if (result.newEvent) publish("alarm", result.newEvent);
      if (result.clearedEvent) publish("alarm-cleared", result.clearedEvent);
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      serveStatic(request, response, pathname);
      return;
    }
    sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error("Request failed:", error.message);
    if (!response.headersSent) sendJson(response, status, { error: status === 500 ? "Internal server error." : error.message });
    else response.destroy();
  }
});

setInterval(() => {
  const online = isDeviceOnline();
  if (online !== wasOnline) {
    wasOnline = online;
    publish("device", { online, checkedAt: new Date().toISOString() });
  }
  for (const response of streams) response.write(": keep-alive\n\n");
}, 3_000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Fire detection dashboard: http://localhost:${PORT}`);
  console.log(`Device API endpoint:       http://<computer-lan-ip>:${PORT}/api/readings`);
  if (DEVICE_API_KEY === "demo-key-change-before-deployment") {
    console.warn("Using the development device key. Set a unique key in .env before deployment.");
  }
});
