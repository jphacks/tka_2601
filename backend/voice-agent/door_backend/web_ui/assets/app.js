const $ = (id) => document.getElementById(id);
const ui = {
  overall: $("overall"), overallText: $("overall").querySelector("span"),
  callState: $("call-state"), notice: $("notice"), messages: $("messages"), empty: $("empty"),
  connect: $("connect"), disconnect: $("disconnect"), rules: $("house-rules"), authenticate: $("authenticate"),
  remoteAudio: $("remote-audio"), testPanel: $("test-panel"), houseRulesPanel: $("house-rules-panel"),
  mode: $("test-mode"), awayLeaveAtDoor: $("away-leave-at-door"), extraInstructions: $("extra-instructions"),
  rulesPreview: $("rules-preview"), historyTest: $("history-test"), saveTestHistory: $("save-test-history"),
  deviceKey: $("test-device-key"),
};

let livekit = null;
let room = null;
let microphone = null;
let apiKey = "";
let transcriptEntries = new Map();
let messageNodes = new Map();
let testVisit = null;

function setNotice(message, error = false) {
  ui.notice.textContent = message;
  ui.notice.classList.toggle("error", error);
}

function setOverall(ready) {
  ui.overall.className = `status ${ready ? "ready" : "error"}`;
  ui.overallText.textContent = ready ? "利用できます" : "一部停止中";
}

async function refreshStatus() {
  if (!apiKey) {
    setOverall(false);
    setNotice("居住者 API キーを入力して認証してください。", true);
    return;
  }
  try {
    const response = await apiFetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`状態確認に失敗しました (${response.status})`);
    const data = await response.json();
    setOverall(Boolean(data.ready));
    configureTestPanel(data);
  } catch (error) {
    setOverall(false);
    setNotice(error.message || "サービス状態を確認できません。", true);
  }
}

function configureTestPanel(status) {
  const enabled = Boolean(status.admin_settings_available || status.test_environment);
  ui.testPanel.hidden = !enabled;
  ui.houseRulesPanel.hidden = enabled;
  ui.historyTest.hidden = !(status.test_environment && status.history_write_available);
  if (enabled) {
    restoreAdminSettings();
    previewTestRules();
  }
}

const ADMIN_SETTINGS_KEY = "door-admin-call-settings-v1";
function restoreAdminSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(ADMIN_SETTINGS_KEY) || "null");
    if (!saved || !["normal", "omakase", "away"].includes(saved.mode)) return;
    ui.mode.value = saved.mode;
    ui.awayLeaveAtDoor.checked = saved.away_leave_at_door === true;
    ui.extraInstructions.value = typeof saved.extra_instructions === "string"
      ? saved.extra_instructions.slice(0, 350)
      : "";
  } catch {
    localStorage.removeItem(ADMIN_SETTINGS_KEY);
  }
}
function saveAdminSettings() {
  localStorage.setItem(ADMIN_SETTINGS_KEY, JSON.stringify(testSettings()));
  previewTestRules();
  setNotice("管理者設定をこのブラウザーに保存しました。次の通話から適用します。");
}

function testSettings() {
  return {
    mode: ui.mode.value,
    away_leave_at_door: ui.awayLeaveAtDoor.checked,
    extra_instructions: ui.extraInstructions.value,
  };
}

let previewTimer = null;
function previewTestRules() {
  if (!apiKey || ui.testPanel.hidden) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const response = await apiFetch("/api/test/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testSettings()),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "ルールを確認できません。");
      ui.rulesPreview.textContent = data.house_rules;
    } catch (error) {
      ui.rulesPreview.textContent = error.message || "ルールを確認できません。";
    }
  }, 180);
}

function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${apiKey}`);
  return fetch(url, { ...options, headers, cache: options.cache || "no-store" }).then((response) => {
    if (response.status === 401) {
      apiKey = "";
      $("auth-form").hidden = false;
      ui.connect.disabled = true;
      ui.testPanel.hidden = true;
      ui.houseRulesPanel.hidden = false;
    }
    return response;
  });
}

$("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const candidate = $("api-key").value;
  ui.authenticate.disabled = true;
  try {
    const response = await fetch("/api/status", {
      headers: { Authorization: `Bearer ${candidate}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(response.status === 401 ? "API キーが正しくありません。" : "認証できませんでした。");
    apiKey = candidate;
    $("api-key").value = "";
    $("auth-form").hidden = true;
    ui.connect.disabled = false;
    const data = await response.json();
    setOverall(Boolean(data.ready));
    configureTestPanel(data);
    setNotice(data.ready ? "認証しました。通話を開始できます。" : "認証しました。一部サービスが停止中です。", !data.ready);
  } catch (error) {
    apiKey = "";
    $("api-key").value = "";
    setNotice(error.message || "認証できませんでした。", true);
  } finally {
    ui.authenticate.disabled = false;
  }
});

function resetConversation() {
  transcriptEntries = new Map();
  messageNodes = new Map();
  ui.messages.replaceChildren();
  ui.messages.append(ui.empty);
  ui.empty.hidden = false;
}

function showTranscript(update) {
  const previous = transcriptEntries.get(update.key);
  if (previous?.isFinal && !update.isFinal) return;
  if (update.complete && !update.text.trim()) {
    messageNodes.get(update.key)?.article.remove();
    messageNodes.delete(update.key);
    transcriptEntries.delete(update.key);
    ui.empty.hidden = messageNodes.size > 0;
    return;
  }
  if (!update.text.trim()) return;

  const entry = {
    ...previous,
    ...update,
    spokenAt: update.isFinal ? previous?.spokenAt || new Date().toISOString() : previous?.spokenAt,
  };
  transcriptEntries.set(update.key, entry);
  let message = messageNodes.get(update.key);
  if (!message) {
    ui.empty.hidden = true;
    const article = document.createElement("article");
    article.className = `message ${update.visitor ? "visitor" : "agent"}`;
    const label = document.createElement("span");
    label.className = "speaker";
    label.textContent = update.visitor ? "来訪者" : "玄関AI";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    article.append(label, bubble);
    ui.messages.append(article);
    message = { article, bubble };
    messageNodes.set(update.key, message);
  }

  message.bubble.textContent = entry.text;
  message.article.classList.toggle("interim", !entry.isFinal);
  while (messageNodes.size > 200) {
    const oldestKey = messageNodes.keys().next().value;
    messageNodes.get(oldestKey)?.article.remove();
    messageNodes.delete(oldestKey);
    transcriptEntries.delete(oldestKey);
  }
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function playRemoteTrack(track) {
  const element = track.attach();
  element.autoplay = true;
  element.playsInline = true;
  ui.remoteAudio.append(element);
  element.play().catch(() => setNotice("応答音声を再生するには、ページ上で再生を許可してください。", true));
}

async function endCall() {
  ui.disconnect.disabled = true;
  ui.connect.disabled = true;
  try {
    microphone?.stop();
    microphone = null;
    if (room) await room.disconnect();
    if (testVisit?.answered_at && ui.saveTestHistory.checked) {
      await saveTestVisit();
    }
  } finally {
    room = null;
    ui.remoteAudio.replaceChildren();
    ui.callState.textContent = "未接続";
    ui.connect.disabled = false;
    ui.disconnect.disabled = true;
    ui.rules.disabled = false;
    for (const field of [ui.mode, ui.awayLeaveAtDoor, ui.extraInstructions]) field.disabled = false;
    ui.saveTestHistory.disabled = false;
    ui.deviceKey.disabled = !ui.saveTestHistory.checked;
    ui.deviceKey.value = "";
    testVisit = null;
  }
}

async function saveTestVisit() {
  const messages = [...transcriptEntries.values()]
    .filter((entry) => entry.isFinal && entry.text.trim() && entry.spokenAt)
    .map((entry) => ({
      speaker: entry.visitor ? "visitor" : "ai",
      text: entry.text.trim(),
      spoken_at: entry.spokenAt,
    }));
  try {
    const response = await apiFetch("/api/test/visits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...testVisit,
        device_key: ui.deviceKey.value.trim(),
        messages,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "履歴を保存できませんでした。");
    setNotice("会話履歴をSupabaseに保存しました。");
  } catch (error) {
    setNotice(error.message || "履歴を保存できませんでした。", true);
  }
}

ui.connect.addEventListener("click", async () => {
  ui.connect.disabled = true;
  ui.rules.disabled = true;
  ui.saveTestHistory.disabled = true;
  for (const field of [ui.mode, ui.awayLeaveAtDoor, ui.extraInstructions]) field.disabled = true;
  resetConversation();
  testVisit = ui.testPanel.hidden ? null : {
    visit_id: crypto.randomUUID(),
    mode: ui.mode.value,
    chimed_at: new Date().toISOString(),
    answered_at: null,
  };
  if (ui.saveTestHistory.checked && !ui.deviceKey.value.trim()) {
    setNotice("履歴保存を選んだ場合はテスト用デバイス鍵を入力してください。", true);
    ui.connect.disabled = false;
    ui.rules.disabled = false;
    ui.saveTestHistory.disabled = false;
    for (const field of [ui.mode, ui.awayLeaveAtDoor, ui.extraInstructions]) field.disabled = false;
    testVisit = null;
    return;
  }
  setNotice("接続しています…");
  try {
    if (!livekit) livekit = await import("https://esm.sh/livekit-client@2");
    const { Room, RoomEvent, Track, createLocalAudioTrack } = livekit;
    const payload = ui.testPanel.hidden
      ? { house_rules: ui.rules.value }
      : testSettings();
    const response = await apiFetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || `接続情報を取得できません (${response.status})`);
    }
    const config = await response.json();
    const livekitUrl = new URL(config.url);
    const localDevelopmentSocket = !ui.testPanel.hidden
      && livekitUrl.protocol === "ws:"
      && ["localhost", "127.0.0.1", "::1"].includes(livekitUrl.hostname);
    if (livekitUrl.protocol !== "wss:" && !localDevelopmentSocket) {
      throw new Error("LiveKitの接続先がWSSではありません。");
    }

    room = new Room({ adaptiveStream: true, dynacast: true });
    const candidate = room;
    // ハンドラーは接続前に登録。接続直後のAI挨拶も取りこぼさない。
    room.registerTextStreamHandler("lk.transcription", async (reader, participant) => {
      const attributes = reader.info?.attributes || {};
      const identity = typeof participant === "string" ? participant : participant?.identity;
      const trackId = attributes["lk.transcribed_track_id"] || "";
      const segmentId = attributes["lk.segment_id"] || reader.info?.id || `${Date.now()}-${Math.random()}`;
      const key = `${identity || "unknown"}:${trackId}:${segmentId}`;
      const visitor = identity === room.localParticipant.identity;
      const isFinal = () => reader.info?.attributes?.["lk.transcription_final"] === "true";
      let text = "";
      try {
        for await (const chunk of reader) {
          if (room !== candidate) return;
          text += chunk;
          if (attributes["lk.transcribed_track_id"]) {
            showTranscript({ key, text, visitor, isFinal: isFinal(), complete: false });
          }
        }
        if (room === candidate && attributes["lk.transcribed_track_id"]) {
          showTranscript({ key, text, visitor, isFinal: isFinal(), complete: isFinal() });
        }
      } catch (error) {
        if (room === candidate && attributes["lk.transcribed_track_id"]) {
          showTranscript({ key, text, visitor, isFinal: isFinal(), complete: true });
        }
        console.warn("文字起こしを受信できませんでした。", error);
      }
    });
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) playRemoteTrack(track);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((node) => node.remove()));
    room.on(RoomEvent.Reconnecting, () => {
      ui.callState.textContent = "再接続中";
      setNotice("接続が不安定です。再接続しています…");
    });
    room.on(RoomEvent.Reconnected, () => {
      ui.callState.textContent = "接続中";
      setNotice("接続中です。話しかけてください。応答中も割り込めます。");
    });
    room.on(RoomEvent.Disconnected, () => {
      if (!room) return;
      ui.callState.textContent = "切断";
      setNotice("通話が切断されました。もう一度接続してください。", true);
    });

    await room.connect(config.url, config.token);
    ui.callState.textContent = "接続中";
    setNotice("接続中です。話しかけてください。応答中も割り込めます。");
    microphone = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    await room.localParticipant.publishTrack(microphone);
    if (testVisit) testVisit.answered_at = new Date().toISOString();
    ui.disconnect.disabled = false;
  } catch (error) {
    await endCall();
    setNotice(error.message || "通話を開始できませんでした。", true);
  } finally {
    if (!room) ui.connect.disabled = false;
  }
});

ui.disconnect.addEventListener("click", endCall);
for (const field of [ui.mode, ui.awayLeaveAtDoor, ui.extraInstructions]) {
  field.addEventListener("input", previewTestRules);
  field.addEventListener("change", previewTestRules);
}
$("save-admin-settings").addEventListener("click", saveAdminSettings);
$("reset-admin-settings").addEventListener("click", () => {
  localStorage.removeItem(ADMIN_SETTINGS_KEY);
  ui.mode.value = "normal";
  ui.awayLeaveAtDoor.checked = false;
  ui.extraInstructions.value = "";
  previewTestRules();
  setNotice("管理者設定を初期状態に戻しました。");
});
ui.saveTestHistory.addEventListener("change", () => {
  ui.deviceKey.disabled = !ui.saveTestHistory.checked;
});
refreshStatus();
