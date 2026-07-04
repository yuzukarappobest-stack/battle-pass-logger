"use strict";

const OFFICIAL_SP_SCALE = 7_500_000;
const MIN_PERIOD_VALUE = 250;
const MAX_PERIOD_VALUE = 10_000;
const ANOMALY_POWER_JUMP = 3000;

const state = {
  device: null,
  server: null,
  notifyCharacteristic: null,
  wakeLock: null,
  logs: [],
  results: [],
  powerValues: [],
  anomalyFlags: [],
  bestPower: null,
  measurementLauncher: null,
  battlePassValue: null,
  previousBattlePassValue: null,
};

const els = {
  connectButton: document.querySelector("#connectButton"),
  disconnectButton: document.querySelector("#disconnectButton"),
  clearButton: document.querySelector("#clearButton"),
  csvButton: document.querySelector("#csvButton"),
  serviceUuid: document.querySelector("#serviceUuid"),
  notifyUuid: document.querySelector("#notifyUuid"),
  pairingHint: document.querySelector("#pairingHint"),
  launcherSelect: document.querySelector("#launcherSelect"),
  statusText: document.querySelector("#statusText"),
  deviceName: document.querySelector("#deviceName"),
  connectionState: document.querySelector("#connectionState"),
  wakeLockState: document.querySelector("#wakeLockState"),
  shootPower: document.querySelector("#shootPower"),
  realRpm: document.querySelector("#realRpm"),
  resultRows: document.querySelector("#resultRows"),
  powerRows: document.querySelector("#powerRows"),
  logRows: document.querySelector("#logRows"),
  powerGraph: document.querySelector("#powerGraph"),
  winderDistribution: document.querySelector("#winderDistribution"),
  stringDistribution: document.querySelector("#stringDistribution"),
};

els.connectButton.addEventListener("click", connect);
els.disconnectButton.addEventListener("click", disconnect);
els.clearButton.addEventListener("click", clearMeasurement);
els.csvButton.addEventListener("click", saveCsv);
els.launcherSelect.addEventListener("change", updateRealRpm);
window.addEventListener("resize", drawAll);
document.addEventListener("visibilitychange", handleVisibilityChange);
document.addEventListener("pointerdown", requestWakeLock, { once: true });
document.addEventListener("keydown", requestWakeLock, { once: true });

initWakeLock();
render();

async function connect() {
  if (!navigator.bluetooth) {
    setStatus("このブラウザは Web Bluetooth に対応していません。Android Chrome または対応した Chrome 系ブラウザで開いてください。");
    return;
  }

  const serviceUuid = els.serviceUuid.value.trim();
  const notifyUuid = els.notifyUuid.value.trim();
  if (!serviceUuid || !notifyUuid) {
    setStatus("Service UUID と Notify UUID を入力してください。");
    return;
  }

  try {
    await requestWakeLock();
    setConnection("スキャン中...");
    const options = els.pairingHint.checked
      ? {
          filters: [{ namePrefix: "BEYBLADE" }],
          optionalServices: [serviceUuid],
        }
      : {
          acceptAllDevices: true,
          optionalServices: [serviceUuid],
        };

    const device = await navigator.bluetooth.requestDevice(options);
    state.device = device;
    device.addEventListener("gattserverdisconnected", handleDisconnected);
    els.deviceName.textContent = device.name || "(no name)";

    setConnection("接続中...");
    state.server = await device.gatt.connect();
    const service = await state.server.getPrimaryService(serviceUuid);
    state.notifyCharacteristic = await service.getCharacteristic(notifyUuid);
    await state.notifyCharacteristic.startNotifications();
    state.notifyCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);

    setConnection("接続済み");
    setStatus("接続済み。シュートしてデータを待っています。");
  } catch (error) {
    console.error(error);
    setConnection("未接続");
    setStatus(`接続失敗: ${error.message}`);
  }
}

async function disconnect() {
  try {
    if (state.notifyCharacteristic) {
      state.notifyCharacteristic.removeEventListener("characteristicvaluechanged", handleNotification);
      try {
        await state.notifyCharacteristic.stopNotifications();
      } catch (_) {
        // Already stopped.
      }
    }
    if (state.device?.gatt?.connected) {
      state.device.gatt.disconnect();
    }
  } finally {
    handleDisconnected();
  }
}

function initWakeLock() {
  if (!("wakeLock" in navigator)) {
    setWakeLockState("非対応");
    return;
  }
  setWakeLockState("待機中");
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    setWakeLockState("非対応");
    return;
  }
  if (document.visibilityState !== "visible") {
    return;
  }
  if (state.wakeLock) {
    setWakeLockState("抑止中");
    return;
  }

  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", handleWakeLockReleased);
    setWakeLockState("抑止中");
  } catch (error) {
    console.error(error);
    setWakeLockState("取得失敗");
  }
}

function handleWakeLockReleased() {
  state.wakeLock = null;
  setWakeLockState(document.visibilityState === "visible" ? "解除済み" : "一時解除");
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible") {
    requestWakeLock();
  }
}

function handleDisconnected() {
  state.server = null;
  state.notifyCharacteristic = null;
  setConnection("未接続");
}

function handleNotification(event) {
  const bytes = new Uint8Array(event.target.value.buffer);
  appendPacket("NOTIFY", bytes);
}

function appendPacket(kind, bytes) {
  if (isBeySetNotification(kind, bytes)) {
    saveCurrentResult();
    resetMeasurement();
    setStatus("ベイセット通知を検知しました。計測をリセットしました。");
    return;
  }

  if (isShootDetailStart(kind, bytes) && hasMeasurementData()) {
    saveCurrentResult();
    resetMeasurement();
    setStatus("新しいシュートを検知しました。前回の計測を保存してリセットしました。");
  }

  const decoded = decodePayload(kind, bytes);
  const measurement = extractBattlePassMeasurement(kind, bytes);
  if (measurement) {
    state.battlePassValue = measurement.current;
    state.previousBattlePassValue = measurement.previous;
  }

  state.logs.push({
    time: timestamp(),
    kind,
    hex: formatHex(bytes),
    decoded: decoded.note,
  });
  trimArray(state.logs, 250);

  if (decoded.powers.length) {
    if (!state.measurementLauncher) {
      state.measurementLauncher = els.launcherSelect.value;
    }

    for (const power of decoded.powers) {
      const anomaly = isAnomalyPower(power);
      state.powerValues.push(power);
      state.anomalyFlags.push(anomaly);
    }

    const normalPowers = normalPowerValuesInRange(4, 15, state.measurementLauncher);
    const currentPower = normalPowers.length ? Math.max(...normalPowers) : null;
    if (currentPower !== null && (state.bestPower === null || currentPower > state.bestPower)) {
      state.bestPower = currentPower;
    }
  }

  render();
}

function decodePayload(kind, bytes) {
  if (!["READ", "NOTIFY", "WRITE"].includes(kind) || bytes.length !== 17) {
    return { note: "", powers: [], rpmCandidates: [] };
  }

  const packetId = bytes[0];
  const values = le16Values(bytes);
  const packetName = `0x${packetId.toString(16).toUpperCase().padStart(2, "0")}`;
  const valueText = values.join(",");

  if (packetId >= 0xb0 && packetId <= 0xb5) {
    const candidates = values.filter((value) => value >= 1000 && value <= 25000);
    return {
      note: `シュート詳細 ${packetName} LE16=[${valueText}] RPM候補=[${candidates.join(",")}]`,
      powers: [],
      rpmCandidates: candidates,
    };
  }

  if (packetId === 0xb6) {
    const candidates = values.slice(0, 2).filter((value) => value >= 1000 && value <= 25000);
    return {
      note: `シュート終了 ${packetName} LE16=[${valueText}] RPM候補=[${candidates.join(",")}]`,
      powers: [],
      rpmCandidates: candidates,
    };
  }

  if (packetId === 0xb7) {
    return { note: `シュート終了 ${packetName} LE16=[${valueText}]`, powers: [], rpmCandidates: [] };
  }

  if (packetId >= 0x70 && packetId <= 0x73) {
    const periods = values.filter((value) => value >= MIN_PERIOD_VALUE && value <= MAX_PERIOD_VALUE);
    const powers = periods.map((value) => Math.round(OFFICIAL_SP_SCALE / value));
    const note = `回転推定 ${packetName} 周期値候補=[${periods.join(",")}] 推定SP=[${powers.join(",")}]`;
    return { note, powers, rpmCandidates: [] };
  }

  if (packetId === 0xa0) {
    return { note: `状態通知 0xA0 LE16=[${valueText}]`, powers: [], rpmCandidates: [] };
  }

  return { note: `通知 ${packetName} LE16=[${valueText}]`, powers: [], rpmCandidates: [] };
}

function extractBattlePassMeasurement(kind, bytes) {
  if (!["READ", "NOTIFY", "WRITE"].includes(kind) || bytes.length !== 17 || bytes[0] !== 0xb6) {
    return null;
  }
  const values = le16Values(bytes);
  const previous = values[0] >= 1000 && values[0] <= 25000 ? values[0] : null;
  for (const current of [values[1], values[3]]) {
    if (current >= 1000 && current <= 25000) {
      return { current, previous };
    }
  }
  return null;
}

function isBeySetNotification(kind, bytes) {
  return kind === "NOTIFY" && bytes.length === 17 && bytes[0] === 0xa0 && bytes[3] === 0x04;
}

function isShootDetailStart(kind, bytes) {
  return kind === "NOTIFY" && bytes.length === 17 && bytes[0] === 0xb0;
}

function le16Values(bytes) {
  const values = [];
  for (let i = 1; i < bytes.length; i += 2) {
    values.push(bytes[i] + (bytes[i + 1] << 8));
  }
  return values;
}

function isAnomalyPower(power) {
  if (!state.powerValues.length) return false;
  const launcherKey = currentLauncherKey();
  const previousPower = state.powerValues[state.powerValues.length - 1];
  const isEarlyWinderDecrease = launcherKey === "winder" && state.powerValues.length < 5 && power < previousPower;
  if (isEarlyWinderDecrease) return false;
  const referencePower = previousNormalRawPowerBefore(state.powerValues.length);
  if (referencePower === null) return false;
  return Math.abs(power - referencePower) >= ANOMALY_POWER_JUMP;
}

function currentLauncherKey(launcher = null) {
  return launcher || state.measurementLauncher || els.launcherSelect.value;
}

function measurementStartOffset(launcherKey = currentLauncherKey()) {
  if (launcherKey !== "winder") return 0;

  let startOffset = 0;
  const scanLimit = Math.min(5, state.powerValues.length);
  for (let offset = 1; offset < scanLimit; offset += 1) {
    const previousPower = normalRawPowerAt(offset - 1);
    const power = normalRawPowerAt(offset);
    if (previousPower !== null && power !== null && power < previousPower) {
      startOffset = offset;
    }
  }
  return startOffset;
}

function normalRawPowerAt(offset) {
  if (offset < 0 || offset >= state.powerValues.length) return null;
  if (state.anomalyFlags[offset]) return null;
  return state.powerValues[offset];
}

function previousNormalRawPowerBefore(offset, minOffset = 0) {
  for (let previousOffset = offset - 1; previousOffset >= minOffset; previousOffset -= 1) {
    const power = normalRawPowerAt(previousOffset);
    if (power !== null) return power;
  }
  return null;
}

function powerAtRotation(index, launcher = null, fallbackOnAnomaly = false) {
  const launcherKey = currentLauncherKey(launcher);
  const startOffset = measurementStartOffset(launcherKey);
  const offset = startOffset + index - 1;
  const power = normalRawPowerAt(offset);
  if (power !== null) return power;

  if (fallbackOnAnomaly && offset >= startOffset && state.anomalyFlags[offset]) {
    return previousNormalRawPowerBefore(offset, startOffset);
  }
  return null;
}

function normalPowerValuesInRange(startIndex, endIndex, launcher = null) {
  const values = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const power = powerAtRotation(index, launcher);
    if (power !== null) values.push(power);
  }
  return values;
}

function normalPowerAt(index, launcher = null) {
  return powerAtRotation(index, launcher);
}

function calculateRealRpm(launcher = null) {
  if (!state.powerValues.length) return null;
  const launcherKey = currentLauncherKey(launcher);

  if (launcherKey === "winder") {
    const candidates = [powerAtRotation(8, launcherKey, true), powerAtRotation(9, launcherKey, true)].filter(
      (power) => power !== null,
    );
    const basePower = candidates.length ? Math.max(...candidates) : null;
    if (basePower === null) return null;
    return { value: Math.round(basePower), label: "ワインダー", basePower };
  }

  let basePower = powerAtRotation(11, launcherKey, true);
  if (basePower === null) basePower = powerAtRotation(10, launcherKey, true);
  if (basePower === null) return null;
  return { value: Math.round(basePower * 0.95), label: "ストリング", basePower };
}

function saveCurrentResult() {
  if (!state.powerValues.length || state.bestPower === null) return;
  const launcherKey = state.measurementLauncher || els.launcherSelect.value;
  const realRpm = calculateRealRpm(launcherKey);
  if (!realRpm) return;

  state.results.unshift({
    time: timestamp(),
    launcherKey,
    launcherLabel: realRpm.label,
    maxPower: state.bestPower,
    realRpm: realRpm.value,
  });
  trimArray(state.results, 100);
}

function resetMeasurement() {
  state.logs = [];
  state.powerValues = [];
  state.anomalyFlags = [];
  state.bestPower = null;
  state.measurementLauncher = null;
  state.battlePassValue = null;
  state.previousBattlePassValue = null;
  render();
}

function clearMeasurement() {
  resetMeasurement();
  state.results = [];
  render();
}

function hasMeasurementData() {
  return Boolean(state.powerValues.length || state.bestPower !== null || state.battlePassValue !== null);
}

function updateRealRpm() {
  renderScores();
}

function render() {
  renderScores();
  renderResults();
  renderPowerRows();
  renderLogs();
  drawAll();
}

function renderScores() {
  els.shootPower.textContent = state.bestPower ?? "-";
  const realRpm = calculateRealRpm();
  els.realRpm.textContent = realRpm ? `${realRpm.value} rpm (${realRpm.label})` : "-";
}

function renderResults() {
  els.resultRows.innerHTML = state.results
    .map(
      (row) => `<tr><td>${escapeHtml(row.time)}</td><td>${escapeHtml(row.launcherLabel)}</td><td>${row.maxPower}</td><td>${row.realRpm}</td></tr>`,
    )
    .join("");
}

function renderPowerRows() {
  els.powerRows.innerHTML = state.powerValues
    .map((power, index) => {
      const anomaly = state.anomalyFlags[index];
      const text = anomaly ? `${power} ※異常値` : String(power);
      return `<tr><td>${index + 1}回転目</td><td class="${anomaly ? "anomaly" : ""}">${text}</td></tr>`;
    })
    .join("");
}

function renderLogs() {
  els.logRows.innerHTML = state.logs
    .slice(-80)
    .reverse()
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.time)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(row.hex)}</td><td>${escapeHtml(row.decoded)}</td></tr>`,
    )
    .join("");
}

function drawAll() {
  drawPowerGraph();
  drawDistributionGraph(els.winderDistribution, "winder");
  drawDistributionGraph(els.stringDistribution, "string");
}

function drawPowerGraph() {
  const canvas = els.powerGraph;
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  const left = 48;
  const right = 16;
  const top = 24;
  const bottom = 30;
  const graphWidth = width - left - right;
  const graphHeight = height - top - bottom;
  const values = state.powerValues.slice(0, 20);

  if (!values.length) {
    drawCenteredText(ctx, width, height, "1-20回転目のデータ待ち");
    return;
  }

  const maxValue = Math.max(...values);
  const yMax = Math.max(1000, Math.ceil(maxValue / 1000) * 1000);
  drawAxes(ctx, left, top, graphWidth, graphHeight, [0, yMax / 4, yMax / 2, (yMax * 3) / 4, yMax], yMax, 0);

  const points = values.map((value, offset) => {
    const index = offset + 1;
    return {
      index,
      value,
      x: left + (offset / 19) * graphWidth,
      y: top + graphHeight - (value / yMax) * graphHeight,
    };
  });

  ctx.strokeStyle = "#d0262f";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((point, offset) => {
    if (offset === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();

  const normalPoints = points.filter((point) => point.index >= 4 && point.index <= 15 && !state.anomalyFlags[point.index - 1]);
  const maxPoint = normalPoints.length
    ? normalPoints.reduce((best, point) => (point.value > best.value ? point : best), normalPoints[0])
    : points.reduce((best, point) => (point.value > best.value ? point : best), points[0]);

  for (const point of points) {
    const anomaly = state.anomalyFlags[point.index - 1];
    const reference = [8, 9, 11, 12].includes(point.index);
    const isMax = point.index === maxPoint.index;
    ctx.fillStyle = anomaly ? "#9e9e9e" : isMax ? "#f2b705" : "#1769aa";
    circle(ctx, point.x, point.y, isMax || reference ? 4 : 3);
    if (reference || isMax) {
      ctx.fillStyle = "#111827";
      ctx.font = "12px system-ui";
      ctx.fillText(`${point.index}:${point.value}${anomaly ? "*" : ""}`, point.x + 5, point.y - 5);
    }
  }

  ctx.fillStyle = "#111827";
  ctx.font = "bold 13px system-ui";
  ctx.fillText(`最大 ${maxPoint.value} (${maxPoint.index}回転目)`, left, 16);
}

function drawDistributionGraph(canvas, launcherKey) {
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  const values = state.results.filter((row) => row.launcherKey === launcherKey).map((row) => row.realRpm);
  if (!values.length) {
    drawCenteredText(ctx, width, height, "データ待ち");
    return;
  }

  const left = 48;
  const right = 12;
  const top = 24;
  const bottom = 26;
  const graphWidth = width - left - right;
  const graphHeight = height - top - bottom;
  const axisMin = 5000;
  const axisMax = 20000;

  drawAxes(ctx, left, top, graphWidth, graphHeight, [5000, 10000, 15000, 20000], axisMax, axisMin);

  const shown = values.slice(-20);
  const gap = 3;
  const barWidth = Math.max(4, (graphWidth - gap * (shown.length - 1)) / shown.length);
  ctx.fillStyle = launcherKey === "winder" ? "#1769aa" : "#d0262f";

  shown.forEach((value, offset) => {
    const x0 = left + offset * (barWidth + gap);
    const clamped = Math.min(Math.max(value, axisMin), axisMax);
    const y0 = top + graphHeight - ((clamped - axisMin) / (axisMax - axisMin)) * graphHeight;
    ctx.fillRect(x0, y0, barWidth, top + graphHeight - y0);
  });

  const max = Math.max(...values);
  const avg = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  ctx.fillStyle = "#111827";
  ctx.font = "bold 13px system-ui";
  ctx.fillText(`最大 ${max} rpm / 平均 ${avg} rpm`, left, 16);
}

function drawAxes(ctx, left, top, graphWidth, graphHeight, ticks, axisMax, axisMin) {
  ctx.strokeStyle = "#cfd6df";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, top + graphHeight);
  ctx.lineTo(left + graphWidth, top + graphHeight);
  ctx.stroke();

  ctx.font = "11px system-ui";
  ctx.fillStyle = "#475467";
  ctx.strokeStyle = "#e5e7eb";
  for (const tick of ticks) {
    const y = top + graphHeight - ((tick - axisMin) / (axisMax - axisMin)) * graphHeight;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + graphWidth, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(tick)), 4, y + 4);
  }
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas.getContext("2d");
}

function drawCenteredText(ctx, width, height, text) {
  ctx.fillStyle = "#667085";
  ctx.font = "14px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(text, width / 2, height / 2);
  ctx.textAlign = "left";
}

function circle(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function saveCsv() {
  const rows = [["time", "launcher", "sp", "real_rpm"]];
  for (const result of state.results) {
    rows.push([result.time, result.launcherLabel, result.maxPower, result.realRpm]);
  }
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `battle-pass-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function formatHex(bytes) {
  return Array.from(bytes)
    .map((value) => value.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

function timestamp() {
  return new Date().toLocaleTimeString("ja-JP", { hour12: false });
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function setConnection(text) {
  els.connectionState.textContent = text;
  els.statusText.textContent = `接続状態: ${text}`;
}

function setWakeLockState(text) {
  els.wakeLockState.textContent = text;
}

function trimArray(array, maxLength) {
  while (array.length > maxLength) array.shift();
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
