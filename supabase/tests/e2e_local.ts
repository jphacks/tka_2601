// ローカルの Supabase で、アプリと本体と同じ経路（Auth、Data API、Realtime、Webhook、Edge Function）を通す試験。
// 権限の細かい組み合わせは tests/database/history_access.test.sql（pgTAP）で見る。
//
// 使い方（リポジトリの根から。先に supabase start と scripts/seed_local.ts を済ませる）:
//   deno run --allow-read --allow-run --allow-net --allow-env supabase/tests/e2e_local.ts
//
// 試験で作った来客とトークンは最後に消す。Expo には実在しないトークンで送るため、
// Expo からは DeviceNotRegistered などの失敗の ticket が返るのが正しい。

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  DEVICE_ID,
  HOUSEHOLD_ID,
  localStatus,
  readEnvFile,
  supabaseCli,
  supabaseDir,
} from "../scripts/local.ts";

const FAKE_PUSH_TOKEN = "ExponentPushToken[e2e-local-test-0000000]";

async function sql<T>(query: string): Promise<T[]> {
  const out = await supabaseCli(["db", "query", "--local", "-o", "json", query]);
  return JSON.parse(out.slice(out.indexOf("{"))).rows as T[];
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "ok    " : "NG    "} ${name}${ok || detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
}

const seedEnv = readEnvFile(`${supabaseDir}.env`);
const status = await localStatus();
const url = status.API_URL;
const options = { auth: { persistSession: false, autoRefreshToken: false } };

async function signIn(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(url, status.PUBLISHABLE_KEY, options);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

const anon = createClient(url, status.PUBLISHABLE_KEY, options);
const admin = createClient(url, status.SECRET_KEY, options);
const device = await signIn(seedEnv.SEED_DEVICE_EMAIL, seedEnv.SEED_DEVICE_PASSWORD);
const resident = await signIn(seedEnv.SEED_RESIDENT_EMAIL, seedEnv.SEED_RESIDENT_PASSWORD);
const residentId = (await resident.auth.getUser()).data.user!.id;

const visitId = crypto.randomUUID();
const missedId = crypto.randomUUID();
const startedAt = new Date().toISOString();

try {
  // H1: ログインしていない利用者は読めない ----------------------------------
  for (const table of ["visits", "visit_messages", "households", "devices"]) {
    const { data, error } = await anon.from(table).select("*");
    check(`H1 anon は ${table} を読めない`, (data === null || data.length === 0) && error?.code === "42501", {
      data,
      error,
    });
  }

  // 通知の送り先を登録する（住人のアプリの役）
  const { error: tokenError } = await resident.from("push_tokens").upsert({
    user_id: residentId,
    token: FAKE_PUSH_TOKEN,
    platform: "ios",
  });
  check("住人は自分のトークンを upsert できる", !tokenError, tokenError);

  // H4: 本体が同じ来客と発話を3回送る -----------------------------------------
  const visit = {
    id: visitId,
    household_id: HOUSEHOLD_ID,
    device_id: DEVICE_ID,
    mode: "away",
    chimed_at: startedAt,
    status: "ringing",
  };
  const messages = [
    { visit_id: visitId, household_id: HOUSEHOLD_ID, seq: 1, speaker: "canned", text: "はい、どちら様でしょうか。", spoken_at: startedAt },
    { visit_id: visitId, household_id: HOUSEHOLD_ID, seq: 2, speaker: "visitor", text: "ヤマト運輸です。お荷物のお届けに参りましたが、クール便のため置き配ができません。", spoken_at: startedAt },
    { visit_id: visitId, household_id: HOUSEHOLD_ID, seq: 3, speaker: "ai", text: "恐れ入りますが、不在票を入れていただけますか。失礼いたします。", spoken_at: startedAt },
  ];
  for (let i = 1; i <= 3; i++) {
    const v = await device.from("visits").upsert(visit);
    check(`H4 本体が来客を送る（${i}回目、merge-duplicates）`, !v.error, v.error);
    const m = await device.from("visit_messages").upsert(messages, { ignoreDuplicates: true });
    check(`H4 本体が発話3件をまとめて送る（${i}回目、ignore-duplicates）`, !m.error, m.error);
  }
  const visits = await resident.from("visits").select("id").eq("id", visitId);
  check("H4 住人から見て来客は1件", visits.data?.length === 1, visits);
  const msgs = await resident.from("visit_messages").select("seq").eq("visit_id", visitId).order("seq");
  check("H4 住人から見て発話は3件", msgs.data?.length === 3, msgs);

  // 終話にする。応答しなかった来客も1件作る
  const ended = await device.from("visits").update({
    status: "ended",
    answered_at: startedAt,
    ended_at: new Date().toISOString(),
    intent: "delivery",
    company: "ヤマト運輸",
    outcome: "delivery_slip",
    end_reason: "closing",
  }).eq("id", visitId).select("id");
  check("本体は来客を終話に更新できる", ended.data?.length === 1, ended);
  const missed = await device.from("visits").insert({
    ...visit,
    id: missedId,
    mode: "normal",
  });
  check("本体は応答しなかった来客を作れる", !missed.error, missed.error);
  const missedUpdate = await device.from("visits").update({ status: "missed", end_reason: "resident" })
    .eq("id", missedId).select("id");
  check("本体は来客を missed に更新できる", missedUpdate.data?.length === 1, missedUpdate);

  // 通知: Webhook → Edge Function → Expo -------------------------------------
  // 来客2件の作成と1件の終話で、Webhook は3回呼ばれる（missed への更新では呼ばれない）
  type HttpResponse = { status_code: number | null; content: string | null; error_msg: string | null };
  let responses: HttpResponse[] = [];
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    responses = await sql<HttpResponse>(
      `select status_code, content, error_msg from net._http_response where created > '${startedAt}' order by id`,
    );
    if (responses.length >= 3 && responses.every((r) => r.status_code !== null || r.error_msg)) break;
  }
  check("Webhook は来客の作成2回と終話1回の計3回呼ばれる", responses.length === 3, responses);
  const bodies = responses.map((r) => {
    try {
      return JSON.parse(r.content ?? "null");
    } catch {
      return r.content;
    }
  });
  check(
    "Edge Function は3回とも 200 を返し、Expo から ticket を受け取る",
    responses.every((r) => r.status_code === 200) && bodies.every((b) => b?.sent === 1 && b.tickets?.length === 1),
    bodies,
  );
  console.log("       Expo の ticket:", JSON.stringify(bodies.map((b) => b?.tickets?.[0])));

  // Realtime: 住人がモードを変えると本体に届く（7.2） ----------------------------
  const { data: before } = await device.from("devices").select("mode").eq("id", DEVICE_ID).single();
  const nextMode = before?.mode === "omakase" ? "normal" : "omakase";
  const received = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime の変更が 10 秒以内に届かない")), 10000);
    device.channel("device-mode")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "devices", filter: `id=eq.${DEVICE_ID}` },
        (payload) => {
          if (payload.new.mode !== before?.mode) {
            clearTimeout(timer);
            resolve(payload.new.mode as string);
          }
        },
      )
      // SUBSCRIBED の時点では変更の受け取りがまだ始まっていない。この通知を待ってから変える
      .on("system", {}, async (payload) => {
        if (payload.extension === "postgres_changes" && payload.status === "ok") {
          const { error } = await resident.from("devices").update({ mode: nextMode }).eq("id", DEVICE_ID);
          if (error) reject(error);
        }
      })
      .subscribe();
  });
  try {
    check("住人がモードを変えると、本体に Realtime で届く", (await received) === nextMode);
  } catch (e) {
    check("住人がモードを変えると、本体に Realtime で届く", false, String(e));
  } finally {
    await device.removeAllChannels();
    await resident.from("devices").update({ mode: before?.mode }).eq("id", DEVICE_ID);
  }

  // H3b: 住人は1件ずつ消せる ---------------------------------------------------
  const both = await resident.from("visits").delete().in("id", [visitId, missedId]).select("id");
  check("H3b 住人は2件をまとめて消せない", both.error?.code === "42501", both);
  const one = await resident.from("visits").delete().eq("id", visitId).select("id");
  check("H3b 住人は1件を消せる", one.data?.length === 1, one);
  const left = await admin.from("visit_messages").select("seq").eq("visit_id", visitId);
  check("H3b 消した来客の発話も消える", left.data?.length === 0, left);
} finally {
  await admin.from("visits").delete().in("id", [visitId, missedId]);
  await admin.from("push_tokens").delete().eq("token", FAKE_PUSH_TOKEN);
  await Promise.all([device.auth.signOut(), resident.auth.signOut()]);
}

console.log(failures === 0 ? "\nすべて通りました" : `\n${failures} 件が失敗しました`);
Deno.exit(failures === 0 ? 0 : 1);
