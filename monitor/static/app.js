"use strict";

// This page only displays evidence received from the board over USB. It does not
// contact Door API itself or turn historical results into a fresh health check.
const byId = (id) => document.getElementById(id);
const timeFormat = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const dateTimeFormat = new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
let snapshot = null;
let lastReceivedAt = 0;
let serverOffset = 0;
let backendFailed = false;
let paused = false;
let shownLogSignature = "";
let shownLatestLogId = null;
let polling = false;

function setText(id, value) { byId(id).textContent = value; }
function epochNow() { return Date.now() / 1000 + serverOffset; }
function validTime(value) { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function formatTime(value) { return validTime(value) ? timeFormat.format(new Date(value * 1000)) : "—"; }
function formatDateTime(value) { return validTime(value) ? dateTimeFormat.format(new Date(value * 1000)) : "—"; }
function age(value) {
  if (!validTime(value)) return "未確認";
  const elapsed = Math.max(0, Math.floor(epochNow() - value));
  if (elapsed < 2) return "たった今";
  if (elapsed < 60) return `${elapsed}秒前`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}分前`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}時間前`;
  return `${Math.floor(elapsed / 86400)}日前`;
}
function tone(element, name) {
  element.classList.remove("success", "warning", "error", "neutral");
  element.classList.add(name);
}
function badge(id, label, name = "neutral") {
  setText(id, label);
  tone(byId(id), name);
}
function dot(id, name) {
  byId(id).className = `status-dot dot-${name}`;
}
function summary(title, description, name, icon) {
  setText("connection-title", title);
  setText("connection-description", description);
  tone(byId("summary-icon"), name);
  byId("summary-icon-use").setAttribute("href", `#i-${icon}`);
}
function isBackendLive() { return !!snapshot && !backendFailed && Date.now() - lastReceivedAt < 5000; }
function isRecent(time, seconds) { return validTime(time) && epochNow() - time <= seconds; }
function shortMessage(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.length > 180 ? `${value.slice(0, 177)}…` : value;
}
function bodyObject(body) {
  if (body && typeof body === "object") return body;
  if (typeof body === "string") {
    try { const parsed = JSON.parse(body); return parsed && typeof parsed === "object" ? parsed : null; }
    catch { return null; }
  }
  return null;
}

function renderEndpoint(key, id, backendLive, serialConnected, freshnessSeconds) {
  const endpoint = snapshot?.server?.endpoints?.[key] || {};
  const checked = validTime(endpoint.checked_at);
  const telemetryFresh = backendLive && serialConnected && isRecent(snapshot?.serial?.last_line_at, snapshot?.thresholds?.telemetry_stale_seconds || 35) && !["disconnected", "error", "stale"].includes(snapshot?.wifi?.state);
  const fresh = telemetryFresh && isRecent(endpoint.checked_at, freshnessSeconds);
  const code = endpoint.status;
  const hasCode = Number.isInteger(code);
  badge(`${id}-code`, hasCode ? `HTTP ${code}` : (endpoint.error ? "応答エラー" : "未確認"), hasCode && fresh ? (code >= 200 && code < 300 && !endpoint.error ? "success" : "error") : (endpoint.error && fresh ? "error" : "neutral"));
  setText(`${id}-time`, checked ? `最終応答 ${formatDateTime(endpoint.checked_at)}` : "応答待ち");
  setText(`${id}-freshness`, checked ? (fresh ? age(endpoint.checked_at) : `過去の結果 · ${age(endpoint.checked_at)}`) : "");
  byId(`${id}-freshness`).classList.toggle("old-result", checked && !fresh);
  if (endpoint.error) {
    setText(`${id}-body`, shortMessage(endpoint.error, "応答を取得できませんでした。"));
  } else if (hasCode && key === "/health") {
    const body = bodyObject(endpoint.body);
    if (body && typeof body.status === "string") setText(`${id}-body`, `status: ${body.status}`);
    else if (endpoint.body) setText(`${id}-body`, shortMessage(typeof endpoint.body === "string" ? endpoint.body : JSON.stringify(endpoint.body), "応答を受信しました。"));
    else setText(`${id}-body`, "応答を受信しました。");
  } else if (hasCode) {
    setText(`${id}-body`, code === 200 ? "音声サービスの状態を受信しました。" : "サーバーからエラー応答が返されました。");
  } else {
    setText(`${id}-body`, key === "/health" ? "サーバーの稼働状態を確認します。" : "音声認識・音声合成などの状態を取得します。");
  }
}

function renderModels(backendLive, serialConnected, freshnessSeconds) {
  const endpoint = snapshot?.server?.endpoints?.["/v1/status"] || {};
  const fresh = backendLive && serialConnected && snapshot?.server?.state === "ok" && isRecent(snapshot?.serial?.last_line_at, snapshot?.thresholds?.telemetry_stale_seconds || 35) && endpoint.status === 200 && isRecent(endpoint.checked_at, freshnessSeconds) && !endpoint.error;
  const models = snapshot?.models || {};
  const hasModels = [models.asr?.model, models.tts?.model, models.llm?.model].some((model) => typeof model === "string" && model.length > 0);
  badge("models-badge", hasModels ? (fresh ? "取得済み" : "前回の応答") : "未取得", fresh && hasModels ? "success" : "neutral");
  for (const kind of ["asr", "tts"]) {
    const model = models[kind] || {};
    setText(`${kind}-model`, typeof model.model === "string" && model.model ? model.model : "—");
    const known = typeof model.ready === "boolean";
    const label = known ? (model.ready ? "準備完了" : "準備中") : "未確認";
    badge(`${kind}-ready`, known && !fresh ? `前回: ${label}` : label, known && fresh ? (model.ready ? "success" : "warning") : "neutral");
  }
  setText("tts-voice", typeof models.tts?.voice === "string" && models.tts.voice ? `voice: ${models.tts.voice}` : "");
  setText("llm-model", typeof models.llm?.model === "string" && models.llm.model ? models.llm.model : "—");
  setText("models-note", validTime(endpoint.checked_at) ? `${formatDateTime(endpoint.checked_at)} の /v1/status 応答。会話モデルの稼働判定は含まれません。` : "/v1/status の最終応答に基づきます。");
}

function renderLogs() {
  const logs = Array.isArray(snapshot?.logs) ? snapshot.logs.slice(-400) : [];
  setText("log-count", logs.length);
  byId("download-button").disabled = logs.length === 0;
  if (paused) {
    const unseen = shownLatestLogId === null ? logs.length : logs.filter((entry) => entry.id > shownLatestLogId).length;
    setText("logs-subtitle", unseen ? `表示を一時停止中 · 新しいログ ${unseen}件` : "表示を一時停止中 · 受信は継続しています");
    return;
  }
  setText("logs-subtitle", "基板からのシリアル出力");
  const signature = `${logs.length}:${logs[0]?.id ?? ""}:${logs.at(-1)?.id ?? ""}`;
  if (signature === shownLogSignature) return;
  const viewport = byId("log-viewport");
  const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 70;
  const initial = shownLatestLogId === null;
  const fragment = document.createDocumentFragment();
  for (const entry of logs) {
    const row = document.createElement("div");
    row.className = "log-line";
    const level = ["success", "warning", "error"].includes(entry.level) ? entry.level : "info";
    row.dataset.level = level;
    const timestamp = document.createElement("time");
    timestamp.className = "log-time";
    timestamp.textContent = formatTime(entry.timestamp);
    if (validTime(entry.timestamp)) timestamp.dateTime = new Date(entry.timestamp * 1000).toISOString();
    const indicator = document.createElement("span");
    indicator.className = `status-dot dot-${level === "info" ? "neutral" : level}`;
    indicator.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "log-text";
    text.textContent = typeof entry.text === "string" ? entry.text : "";
    row.append(timestamp, indicator, text);
    fragment.append(row);
  }
  byId("log-lines").replaceChildren(fragment);
  byId("log-empty").hidden = logs.length > 0;
  if (atBottom || initial) viewport.scrollTop = viewport.scrollHeight;
  shownLogSignature = signature;
  shownLatestLogId = logs.at(-1)?.id ?? null;
}

function render() {
  const backendLive = isBackendLive();
  const serial = snapshot?.serial || {};
  const wifi = snapshot?.wifi || {};
  const server = snapshot?.server || {};
  const clock = snapshot?.clock || {};
  const serialConnected = !!serial.connected;
  const telemetrySeconds = snapshot?.thresholds?.telemetry_stale_seconds || 35;
  const serverSeconds = snapshot?.thresholds?.server_stale_seconds || 150;
  const wifiFresh = backendLive && serialConnected && wifi.state === "connected" && isRecent(wifi.last_seen_at, telemetrySeconds);
  const serverFresh = backendLive && serialConnected && server.state === "ok" && isRecent(server.last_check_at, serverSeconds);
  const receiving = backendLive && serialConnected && isRecent(serial.last_line_at, telemetrySeconds);
  const monitoringUnavailable = backendFailed || (!!snapshot && !backendLive);

  setText("feed-label", backendLive ? "監視中" : (monitoringUnavailable ? "監視が停止" : "接続中"));
  tone(byId("feed-badge"), backendLive ? "success" : (monitoringUnavailable ? "warning" : "neutral"));
  byId("monitor-warning").hidden = !monitoringUnavailable;
  setText("monitor-warning-text", "このMacの監視サービスに接続できません。表示中の値は最終受信時点の情報です。");
  setText("last-updated", snapshot ? `画面の最終更新 ${timeFormat.format(new Date(lastReceivedAt))}` : "監視サービスに接続中");
  setText("last-check-time", formatTime(server.last_check_at));
  setText("last-check-age", validTime(server.last_check_at) ? (serverFresh ? age(server.last_check_at) : `前回の確認 · ${age(server.last_check_at)}`) : "まだ確認していません");

  if (monitoringUnavailable) summary("監視サービスとの接続が停止", "通信状況の更新を再開できるまで、過去の結果を表示します。", "warning", "alert");
  else if (!snapshot) summary("ログを待っています", "監視サービスに接続しています。", "neutral", "plug");
  else if (!serialConnected) summary("USB接続を待っています", shortMessage(serial.error, "基板をこのMacに接続すると、監視を開始します。"), "neutral", "plug");
  else if (!validTime(serial.last_line_at)) summary("基板からのログを待機中", "USBを検出しました。次の状態通知から表示を更新します。", "neutral", "chip");
  else if (["error", "disconnected"].includes(wifi.state)) summary("Wi-Fiが接続されていません", "基板からの再接続通知を待っています。", "error", "wifi");
  else if (clock.state === "error") summary("時刻同期を確認してください", shortMessage(clock.error, "証明書の検証に必要な時刻を取得できていません。"), "warning", "clock");
  else if (server.checking || server.state === "checking") summary("サーバーの応答を確認中", "基板がDoor APIにHTTPSリクエストを送信しています。", "neutral", "cloud");
  else if (server.state === "error") summary("サーバー通信でエラー", shortMessage(server.error, "次の確認で再試行します。詳細はイベントログをご覧ください。"), "error", "alert");
  else if (wifiFresh && serverFresh) summary("通信は正常です", "Wi-Fi接続と、Door APIからのHTTPS応答を確認しました。", "success", "check");
  else if (wifi.state === "stale" || server.state === "stale" || !receiving) summary("最新の状態通知を待っています", "前回の結果を表示中です。受信が再開すると自動で更新します。", "warning", "clock");
  else if (wifiFresh) summary("Wi-Fiに接続しました", "IPアドレスを取得済みです。サーバーの応答を待っています。", "neutral", "wifi");
  else summary("Wi-Fi接続を確認中", "基板からの接続・IPアドレス取得の通知を待っています。", "neutral", "wifi");

  badge("board-badge", backendLive ? (serialConnected ? (receiving ? "受信中" : "USB接続済み") : "未接続") : "未確認", receiving ? "success" : "neutral");
  setText("board-detail", serial.port ? String(serial.port) : "USB接続を待っています");
  setText("board-received", validTime(serial.last_line_at) ? `最終受信 ${age(serial.last_line_at)}` : "ログの受信を待機");
  dot("board-dot", receiving ? "success" : "neutral");
  byId("board-node").classList.toggle("active", receiving);

  let wifiLabel = "未確認", wifiTone = "neutral";
  if (wifiFresh) { wifiLabel = "接続済み"; wifiTone = "success"; }
  else if (backendLive && serialConnected && wifi.state === "connecting") wifiLabel = "接続中";
  else if (backendLive && serialConnected && ["error", "disconnected"].includes(wifi.state)) { wifiLabel = "未接続"; wifiTone = "error"; }
  else if (wifi.ip) { wifiLabel = "前回の状態"; wifiTone = "warning"; }
  badge("wifi-badge", wifiLabel, wifiTone);
  setText("wifi-detail", wifi.ip ? `${wifiFresh ? "" : "前回: "}${wifi.ip}` : "IPアドレス未取得");
  setText("wifi-foot", validTime(wifi.last_seen_at) ? `状態通知 ${age(wifi.last_seen_at)}` : "基板からの状態通知を待機");
  dot("wifi-dot", wifiTone);
  byId("wifi-node").classList.toggle("active", wifiFresh);
  byId("wifi-link").classList.toggle("active", wifiFresh);

  let serverLabel = "未確認", serverTone = "neutral";
  if (serverFresh) { serverLabel = "応答あり"; serverTone = "success"; }
  else if (backendLive && serialConnected && (server.checking || server.state === "checking")) serverLabel = "確認中";
  else if (backendLive && serialConnected && server.state === "error") { serverLabel = "通信エラー"; serverTone = "error"; }
  else if (validTime(server.last_check_at)) { serverLabel = "前回の状態"; serverTone = "warning"; }
  badge("server-badge", serverLabel, serverTone);
  setText("server-foot", validTime(server.last_success_at) ? `最終成功 ${age(server.last_success_at)}` : "HTTPS応答を待機");
  dot("server-dot", serverTone);
  byId("server-node").classList.toggle("active", serverFresh);
  byId("server-link").classList.toggle("active", wifiFresh && serverFresh);

  setText("signal-value", typeof wifi.rssi === "number" ? `${wifi.rssi} dBm` : "—");
  setText("signal-detail", typeof wifi.channel === "number" ? `CH ${wifi.channel} · 起動時の測定` : "測定待ち");
  const clockKnown = validTime(clock.synced_at);
  const clockCurrent = backendLive && serialConnected && clock.state === "synced";
  setText("clock-value", clockCurrent ? "同期済み" : (clock.state === "error" && backendLive ? "同期エラー" : (clockKnown ? "前回: 同期済み" : (clock.state === "syncing" ? "同期中" : "未確認"))));
  setText("clock-detail", clockKnown ? `${formatTime(clock.synced_at)} に同期` : "HTTPSの証明書検証に使用");
  renderEndpoint("/health", "health", backendLive, serialConnected, serverSeconds);
  renderEndpoint("/v1/status", "status", backendLive, serialConnected, serverSeconds);
  renderModels(backendLive, serialConnected, serverSeconds);
  renderLogs();
  dot("log-stream-dot", receiving ? "success" : (monitoringUnavailable ? "warning" : "neutral"));
  setText("log-stream-status", monitoringUnavailable ? "監視サービスに再接続中" : (receiving ? "受信中" : (serialConnected ? "次のログを待機" : "USB接続待ち")));
}

async function poll() {
  if (polling) return;
  polling = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch("/api/state", { signal: controller.signal, cache: "no-store", credentials: "same-origin", headers: { "Accept": "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (!next || typeof next !== "object" || !next.serial || !next.wifi || !next.server || !Array.isArray(next.logs)) throw new Error("Invalid monitoring state");
    snapshot = next;
    lastReceivedAt = Date.now();
    if (validTime(next.server_now)) serverOffset = next.server_now - lastReceivedAt / 1000;
    backendFailed = false;
  } catch {
    backendFailed = true;
  } finally {
    clearTimeout(timeout);
    polling = false;
    render();
  }
}

byId("pause-button").addEventListener("click", () => {
  paused = !paused;
  byId("pause-button").setAttribute("aria-pressed", String(paused));
  setText("pause-label", paused ? "表示を再開" : "表示を一時停止");
  byId("pause-icon").setAttribute("href", paused ? "#i-play" : "#i-pause");
  renderLogs();
});
byId("download-button").addEventListener("click", () => {
  const logs = Array.isArray(snapshot?.logs) ? snapshot.logs : [];
  if (!logs.length) return;
  const content = logs.map((entry) => `${validTime(entry.timestamp) ? new Date(entry.timestamp * 1000).toISOString() : "unknown"} [${entry.level || "info"}] ${entry.text || ""}`).join("\n") + "\n";
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `door-monitor-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
render();
poll();
setInterval(poll, 1000);
