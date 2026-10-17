// ローカルの Supabase で、アプリと本体と同じ経路を通す試験。
//   住人のアプリ: Auth でログインし、Data API で読む・モードを変える・消す
//   本体（PSoC 6）: Edge Function「device」にデバイス鍵を付けて書く・モードを読む
//   通知: Webhook から Edge Function「push」、Expo まで
// 権限の細かい組み合わせは tests/database/history_access.test.sql（pgTAP）で見る。
//
// 使い方（リポジトリの根から。先に supabase start と scripts/seed_local.ts を済ませる）:
//   deno run --allow-read --allow-run --allow-net --allow-env supabase/tests/e2e_local.ts
//
// 試験で作った来客、トークン、2台目のデバイスは最後に消す。Expo には実在しないトークンで送るため、
// Expo からは DeviceNotRegistered の ticket が返るのが正しい。

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  DEVICE_ID,
  localStatus,
  readEnvFile,
  sha256Hex,
  supabaseCli,
  supabaseDir,
} from "../scripts/local.ts";

const FAKE_PUSH_TOKEN = "ExponentPushToken[e2e-local-test-0000000]";
// 2台目のデバイス（H2 用）。試験の間だけ作る
const OTHER_HOUSEHOLD_ID = "eeeeeeee-0000-4000-8000-0000000000e2";
const OTHER_DEVICE_ID = "eeeeeeee-0000-4000-8000-0000000000d2";
const OTHER_DEVICE_KEY = `dk_e2e_${crypto.randomUUID()}`;

async function sql<T>(query: string): Promise<T[]> {
  const out = await supabaseCli(["db", "query", "--local", "-o", "json", query]);
  // 行を返さない文（insert など）は JSON を出さない
  const start = out.indexOf("{");
  return start < 0 ? [] : JSON.parse(out.slice(start)).rows as T[];
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "ok    " : "NG    "} ${name}${ok || detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
}

const seedEnv = readEnvFile(`${supabaseDir}.env`);
const status = await localStatus();
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const anon = createClient(status.API_URL, status.PUBLISHABLE_KEY, options);
const admin = createClient(status.API_URL, status.SECRET_KEY, options);
const resident = createClient(status.API_URL, status.PUBLISHABLE_KEY, options);
{
  const { error } = await resident.auth.signInWithPassword({
    email: seedEnv.SEED_RESIDENT_EMAIL,
    password: seedEnv.SEED_RESIDENT_PASSWORD,
  });
  if (error) throw error;
}
const residentId = (await resident.auth.getUser()).data.user!.id;

// 本体（PSoC）の役。fetch で device 関数を呼ぶ
async function device(
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
  key = seedEnv.SEED_DEVICE_KEY,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const res = await fetch(`${status.API_URL}/functions/v1/device${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const visitId = crypto.randomUUID();
const missedId = crypto.randomUUID();
const recoveredId = crypto.randomUUID();
const concurrentId = crypto.randomUUID();
const startedAt = new Date().toISOString();
const createdVisits = [visitId, missedId, recoveredId, concurrentId];
// グループとペアリングの試験で作るアカウントとグループ
const tempUserIds: string[] = [];
let tempHouseholdId: string | null = null;

try {
  // H1: ログインしていない利用者は読めない ----------------------------------
  for (const table of ["visits", "visit_messages", "households", "devices", "device_keys"]) {
    const { data, error } = await anon.from(table).select("*");
    check(`H1 anon は ${table} を読めない`, (data === null || data.length === 0) && error?.code === "42501", {
      data,
      error,
    });
  }
  const residentKeys = await resident.from("device_keys").select("*");
  check("住人はデバイス鍵を読めない", residentKeys.error?.code === "42501", residentKeys);

  // 通知の送り先を登録する（住人のアプリの役）
  const token = await resident.from("push_tokens").upsert({ user_id: residentId, token: FAKE_PUSH_TOKEN, platform: "ios" });
  check("住人は自分のトークンを upsert できる", !token.error, token.error);

  // デバイス鍵の確認とモードの読み取り ------------------------------------------
  check("鍵なしは 401", (await device("GET", "/mode", undefined, "")).status === 401);
  check("知らない鍵は 401", (await device("GET", "/mode", undefined, "dk_unknown")).status === 401);
  await admin.from("devices").update({ last_seen_at: null }).eq("id", DEVICE_ID);
  const mode = await device("GET", "/mode");
  check("正しい鍵でモードを読める", mode.status === 200 && typeof mode.json.mode === "string", mode);
  const seen = await admin.from("devices").select("last_seen_at").eq("id", DEVICE_ID).single();
  check("モードを読むと last_seen_at が入る", seen.data?.last_seen_at !== null, seen);

  // H4: (1) 作成、(2) 通話中、(3) 終話と発話を、それぞれ3回送る ----------------------
  const messages = [
    { seq: 1, speaker: "canned", text: "はい、どちら様でしょうか。", spoken_at: startedAt },
    { seq: 2, speaker: "visitor", text: "ヤマト運輸です。お荷物のお届けに参りましたが、クール便のため置き配ができません。", spoken_at: startedAt },
    { seq: 3, speaker: "ai", text: "恐れ入りますが、不在票を入れていただけますか。失礼いたします。", spoken_at: startedAt },
  ];
  const steps: [string, Record<string, unknown>][] = [
    ["(1) 作成", { chimed_at: startedAt, mode: "away", status: "ringing" }],
    ["(2) 通話中", { status: "in_call", answered_at: startedAt }],
    ["(3) 終話と発話", {
      status: "ended",
      ended_at: new Date().toISOString(),
      end_reason: "closing",
      intent: "delivery",
      company: "ヤマト運輸",
      outcome: "delivery_slip",
      messages,
    }],
  ];
  for (const [name, body] of steps) {
    for (let i = 1; i <= 3; i++) {
      const res = await device("PUT", `/visits/${visitId}`, body);
      check(`H4 ${name}（${i}回目）`, res.status === 200 && res.json.status === body.status, res);
    }
  }
  const visits = await resident.from("visits").select("status, company").eq("id", visitId);
  check("H4 住人から見て来客は1件", visits.data?.length === 1 && visits.data[0].status === "ended", visits);
  const msgs = await resident.from("visit_messages").select("seq").eq("visit_id", visitId);
  check("H4 住人から見て発話は3件", msgs.data?.length === 3, msgs);

  // 同じ来客の作成が重なっても、どれも成功して1件になる（PR #4 のレビュー）
  const concurrent = await Promise.all(Array.from({ length: 6 }, () =>
    device("PUT", `/visits/${concurrentId}`, { chimed_at: startedAt, mode: "normal", status: "ringing" })
  ));
  check("同じ来客の作成を6つ同時に送っても、すべて 200", concurrent.every((r) => r.status === 200), concurrent.map((r) => r.status));
  const concurrentRows = await admin.from("visits").select("id").eq("id", concurrentId);
  check("同時に送っても来客は1件", concurrentRows.data?.length === 1, concurrentRows);

  const stale = await device("PUT", `/visits/${visitId}`, { status: "ringing", chimed_at: startedAt, mode: "away" });
  check("遅れて届いた古い送信は状態を戻さない", stale.status === 200 && stale.json.status === "ended" && stale.json.applied === false, stale);

  // H2: 他のデバイスの鍵では、この来客を書けない ----------------------------------
  await admin.from("households").insert({ id: OTHER_HOUSEHOLD_ID, name: "e2e の家 B" });
  await admin.from("devices").insert({ id: OTHER_DEVICE_ID, household_id: OTHER_HOUSEHOLD_ID, name: "e2e の親機 B", mode: "normal" });
  await sql(`insert into public.device_keys (key_hash, device_id) values ('${await sha256Hex(OTHER_DEVICE_KEY)}', '${OTHER_DEVICE_ID}')`);
  const other = await device("PUT", `/visits/${visitId}`, { status: "ended", outcome: "declined" }, OTHER_DEVICE_KEY);
  check("H2 デバイス B の鍵ではデバイス A の来客を書けない（403）", other.status === 403, other);

  // 入力の誤り
  const bad = await device("PUT", `/visits/${crypto.randomUUID()}`, { status: "ringing", mode: "sleep", chimed_at: startedAt });
  check("知らないモードは 400", bad.status === 400, bad);

  // 応答しなかった来客と、回線断からの回復（終話済みの来客が初めて届く）
  check("応答しなかった来客の作成", (await device("PUT", `/visits/${missedId}`, { chimed_at: startedAt, mode: "normal", status: "ringing" })).status === 200);
  check("応答しなかった来客を missed にする", (await device("PUT", `/visits/${missedId}`, { status: "missed", end_reason: "resident" })).status === 200);
  const recovered = await device("PUT", `/visits/${recoveredId}`, {
    chimed_at: startedAt,
    mode: "omakase",
    status: "ended",
    end_reason: "closing",
    intent: "sales",
    outcome: "declined",
    messages: [{ seq: 1, speaker: "visitor", text: "新聞のご案内です。", spoken_at: startedAt }],
  });
  check("終話済みの来客が初めて届く", recovered.status === 200, recovered);

  // 通知: Webhook → Edge Function「push」 → Expo -------------------------------
  // 来客の作成（ringing）3回、終話への更新1回、終話済みの来客の作成1回で、計5回呼ばれる
  type HttpResponse = { status_code: number | null; content: string | null; error_msg: string | null };
  let responses: HttpResponse[] = [];
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    responses = await sql<HttpResponse>(
      `select status_code, content, error_msg from net._http_response where created > '${startedAt}' order by id`,
    );
    if (responses.length >= 5 && responses.every((r) => r.status_code !== null || r.error_msg)) break;
  }
  const bodies = responses.map((r) => JSON.parse(r.content ?? "null"));
  check("Webhook は5回呼ばれ、push は毎回 200 を返す", responses.length === 5 && responses.every((r) => r.status_code === 200), responses);
  check(
    "Expo から毎回 ticket が返る",
    bodies.every((b) => b?.sent === 1 && b.tickets?.length === 1 && b.tickets[0].details?.error === "DeviceNotRegistered"),
    bodies.map((b) => b?.tickets),
  );
  const notices = bodies.map((b) => b?.notice);
  console.log("       通知の文面:", JSON.stringify(notices));
  check("来客時の通知が3回", notices.filter((n) => n?.kind === "chime").length === 3, notices);
  check(
    "対応後の通知に意図、会社名、対応、発話の抜粋が載る",
    notices.some((n) =>
      n?.kind === "ended" && n.title === "宅配（ヤマト運輸）" &&
      n.body.startsWith("不在票をお願いしました。再配達の手配をしてください\n「ヤマト運輸です。")
    ),
    notices,
  );
  check(
    "終話済みで初めて届いた来客には対応後の通知だけを送る",
    notices.some((n) => n?.kind === "ended" && n.title === "営業・勧誘" && n.body === "お断りしました\n「新聞のご案内です。」"),
    notices,
  );

  // モード: 住人が変えると、本体が次に読んだときに変わっている ---------------------------
  const before = (await device("GET", "/mode")).json.mode as string;
  const next = before === "omakase" ? "normal" : "omakase";
  const changed = await resident.from("devices").update({ mode: next }).eq("id", DEVICE_ID).select("mode");
  check("住人はモードを変えられる", changed.data?.length === 1, changed);
  check("本体は変わったモードを読める", (await device("GET", "/mode")).json.mode === next);
  await resident.from("devices").update({ mode: before }).eq("id", DEVICE_ID);

  // 設定と自動の外出 -----------------------------------------------------------
  const settings = await device("GET", "/settings");
  check(
    "本体は設定をまとめて読める",
    settings.status === 200 && settings.json.paired === true && typeof settings.json.away_leave_at_door === "boolean" &&
      typeof settings.json.auto_away === "boolean" && typeof settings.json.extra_instructions === "string",
    settings,
  );
  const saved = await resident.from("devices").update({
    away_leave_at_door: true,
    auto_away: true,
    extra_instructions: "犬がいるので、ゆっくり話してください",
  }).eq("id", DEVICE_ID).select("id");
  check("住人は設定を変えられる", saved.data?.length === 1, saved);
  const changedSettings = (await device("GET", "/settings")).json;
  check(
    "本体は住人が変えた設定を読める",
    changedSettings.away_leave_at_door === true && changedSettings.auto_away === true &&
      changedSettings.extra_instructions === "犬がいるので、ゆっくり話してください",
    changedSettings,
  );
  await resident.from("devices").update({ away_leave_at_door: false, auto_away: false, extra_instructions: "" })
    .eq("id", DEVICE_ID);
  const state = await device("PUT", "/state", { auto_away_active: true });
  check("本体は自動の外出の状態を書ける", state.status === 200 && state.json.auto_away_active === true, state);
  const shown = await resident.from("devices").select("auto_away_active").eq("id", DEVICE_ID).single();
  check("住人は自動の外出の状態を読める", shown.data?.auto_away_active === true, shown);
  check("自動の外出の状態が真偽値でなければ 400", (await device("PUT", "/state", { auto_away_active: "yes" })).status === 400);
  await device("PUT", "/state", { auto_away_active: false });
  const notAllowed = await resident.from("devices").update({ auto_away_active: true }).eq("id", DEVICE_ID);
  check("住人は自動の外出の状態を書けない", notAllowed.error?.code === "42501", notAllowed);

  // グループの作成と招待（新しいアカウント2つ） --------------------------------------
  async function newUser(email: string, metadata: Record<string, string>) {
    const password = crypto.randomUUID();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: metadata });
    if (error) throw error;
    tempUserIds.push(data.user.id);
    const client = createClient(status.API_URL, status.PUBLISHABLE_KEY, options);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
    return client;
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await newUser(`e2e-owner-${suffix}@example.com`, { full_name: "e2e 太郎" });
  const joiner = await newUser(`e2e-joiner-${suffix}@example.com`, { name: "e2e Hanako" });

  const created = await owner.rpc("create_household", { name: "e2e の家" });
  check("アプリからグループを作れる", typeof created.data === "string", created);
  tempHouseholdId = created.data as string;
  const again = await owner.rpc("create_household", { name: "e2e の家 2" });
  check("2つ目のグループは作れない（23505）", again.error?.code === "23505", again);
  const invite = await owner.rpc("get_or_create_household_invite");
  check("招待トークンを受け取れる", typeof invite.data === "string" && invite.data.length === 48, invite);
  const preview = await joiner.rpc("get_household_invite", { token: invite.data });
  check(
    "招待を受けた人はグループ名と招待した人の名前を読める",
    preview.data?.[0]?.household_name === "e2e の家" && preview.data?.[0]?.inviter_name === "e2e 太郎",
    preview,
  );
  const wrongInvite = await joiner.rpc("get_household_invite", { token: "wrong" });
  check("違う招待トークンは PT404 と理由を JSON で返す", wrongInvite.error?.code === "PT404" && wrongInvite.error.message === "招待が見つかりません", wrongInvite);
  const accepted = await joiner.rpc("accept_household_invite", { token: invite.data });
  check("招待でグループに入れる", accepted.data === tempHouseholdId, accepted);
  const profiles = await owner.rpc("household_member_profiles");
  check(
    "メンバーの名前とメールを読める",
    JSON.stringify(profiles.data?.map((p: { full_name: string; role: string }) => [p.full_name, p.role])) ===
      JSON.stringify([["e2e 太郎", "owner"], ["e2e Hanako", "member"]]),
    profiles,
  );
  const anonProfiles = await anon.rpc("household_member_profiles");
  check("anon はメンバーの一覧を読めない", anonProfiles.error !== null, anonProfiles);

  // ペアリング: 管理者が登録した本体を、アプリでコードを入れて結び付ける -----------------------
  const pairKey = `dk_e2e_${crypto.randomUUID()}`;
  const [registered] = await sql<{ device_id: string; pairing_code: string }>(
    `select * from private.register_device('e2e の親機', '${await sha256Hex(pairKey)}')`,
  );
  const unpaired = await device("GET", "/settings", undefined, pairKey);
  check("結び付く前の本体は paired が false", unpaired.status === 200 && unpaired.json.paired === false, unpaired);
  const early = await device("PUT", `/visits/${crypto.randomUUID()}`, { chimed_at: startedAt, mode: "normal", status: "ringing" }, pairKey);
  check("結び付く前の本体は来客を書けない（409）", early.status === 409, early);
  const wrongCode = await joiner.rpc("claim_device", { code: "ZZZZZZZZ" });
  check("違うペアリングコードは PT404", wrongCode.error?.code === "PT404", wrongCode);
  const claimed = await joiner.rpc("claim_device", { code: registered.pairing_code.toLowerCase() });
  check("メンバーはペアリングコードで本体を結び付けられる", claimed.data === registered.device_id, claimed);
  const pairedVisit = crypto.randomUUID();
  const written = await device("PUT", `/visits/${pairedVisit}`, {
    chimed_at: startedAt,
    mode: "normal",
    status: "ended",
    intent: "acquaintance",
    outcome: "escalated",
    end_reason: "closing",
  }, pairKey);
  check("結び付けた本体は来客を書ける（知人）", written.status === 200, written);
  const ownerVisits = await owner.from("visits").select("intent").eq("id", pairedVisit);
  check("グループのメンバーは結び付けた本体の来客を読める", ownerVisits.data?.[0]?.intent === "acquaintance", ownerVisits);
  const residentVisits = await resident.from("visits").select("id").eq("id", pairedVisit);
  check("ほかのグループの住人は読めない", residentVisits.data?.length === 0, residentVisits);

  // H3b: 住人は1件ずつ消せる ---------------------------------------------------
  const both = await resident.from("visits").delete().in("id", [visitId, missedId]).select("id");
  check("H3b 住人は2件をまとめて消せない", both.error?.code === "42501", both);
  const one = await resident.from("visits").delete().eq("id", visitId).select("id");
  check("H3b 住人は1件を消せる", one.data?.length === 1, one);
  const left = await admin.from("visit_messages").select("seq").eq("visit_id", visitId);
  check("H3b 消した来客の発話も消える", left.data?.length === 0, left);
} finally {
  await admin.from("visits").delete().in("id", createdVisits);
  await admin.from("households").delete().eq("id", OTHER_HOUSEHOLD_ID);
  await admin.from("push_tokens").delete().eq("token", FAKE_PUSH_TOKEN);
  // グループを消すと、結び付けた本体、その鍵、来客も消える
  if (tempHouseholdId) await admin.from("households").delete().eq("id", tempHouseholdId);
  for (const id of tempUserIds) await admin.auth.admin.deleteUser(id);
  await resident.auth.signOut();
}

console.log(failures === 0 ? "\nすべて通りました" : `\n${failures} 件が失敗しました`);
Deno.exit(failures === 0 ? 0 : 1);
