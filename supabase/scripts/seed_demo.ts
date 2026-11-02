// 既存のアカウントのグループに、ネイルサロンを想定したデモデータを入れる。
// 店舗の設定、メニュー、今日を基準にした予約、来客と会話、通知が入る。
// 決まった id で書くので、何度実行しても増えず、日付だけが今日を基準に更新される。
//
// 使い方（リポジトリの根から）:
//   deno run --allow-read --allow-run --allow-net --allow-env supabase/scripts/seed_demo.ts [メールアドレス]
//
// メールアドレスを省くと supabase/.env の SEED_RESIDENT_EMAIL を使う。
// アカウントはグループに入っている必要がある。店名、業種、受け答え、営業時間は上書きし、予約先は予約帳に戻す。
//
// 既定ではローカルに入れる。クラウドに入れるときだけ、DEMO_SUPABASE_URL と DEMO_SUPABASE_SECRET_KEY を渡す。
// 来客を初めて入れると Webhook が動き、そのアカウントの端末に通知が届く。

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { localStatus, readEnvFile, required, supabaseDir } from "./local.ts";

const remoteUrl = Deno.env.get("DEMO_SUPABASE_URL");
const remoteKey = Deno.env.get("DEMO_SUPABASE_SECRET_KEY");
if (Boolean(remoteUrl) !== Boolean(remoteKey)) {
  throw new Error("DEMO_SUPABASE_URL と DEMO_SUPABASE_SECRET_KEY は両方渡してください");
}
const status = remoteUrl ? {} : await localStatus();
const url = remoteUrl ?? required(status, "API_URL", "supabase status");
const key = remoteKey ?? required(status, "SECRET_KEY", "supabase status");
const email = Deno.args[0] ?? required(readEnvFile(`${supabaseDir}.env`), "SEED_RESIDENT_EMAIL", "supabase/.env");

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function check<T>(promise: PromiseLike<{ error: unknown; data: T }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

// 決まった id。予約、メニュー、来客で範囲を分ける
const demoId = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const { data: users, error: usersError } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (usersError) throw usersError;
const user = users.users.find((u) => u.email === email);
if (!user) throw new Error(`${email} のアカウントがありません`);

const membership = await check(
  admin.from("household_members").select("household_id").eq("user_id", user.id).maybeSingle(),
);
if (!membership) throw new Error(`${email} はグループに入っていません`);
const householdId = membership.household_id as string;

const device = await check(
  admin.from("devices").select("id").eq("household_id", householdId).order("created_at").limit(1).maybeSingle(),
);

// 東京の今日を基準にする
const TOKYO_MS = 9 * 60 * 60 * 1000;
const tokyoNow = new Date(Date.now() + TOKYO_MS);
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function dateAfter(days: number): Date {
  return new Date(Date.UTC(tokyoNow.getUTCFullYear(), tokyoNow.getUTCMonth(), tokyoNow.getUTCDate() + days));
}

// days 日後の minutes 分（0 時から）を UTC の ISO 文字列にする
function at(days: number, minutes: number): string {
  return new Date(dateAfter(days).getTime() + minutes * 60_000 - TOKYO_MS).toISOString();
}

function dayLabel(days: number): string {
  const date = dateAfter(days);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日（${WEEKDAYS[date.getUTCDay()]}）`;
}

const hhmm = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;

// 2日後を定休日にする。予約はその日を避けて入れるので、定休日の表示も確かめられる
const closedDay = dateAfter(2).getUTCDay();

await check(admin.from("households").update({ name: "ネイルサロン〇〇" }).eq("id", householdId));
await check(
  admin.from("shop_profiles").update({
    business_type: "nail_salon",
    tone: "very_polite",
    greeting: "はい、ネイルサロン〇〇でございます。",
    walk_in_policy: "take_reservation",
    reservation_provider: "monban",
    business_hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
      day,
      closed: day === closedDay,
      open: "10:00",
      close: day === 5 || day === 6 ? "20:00" : "19:00",
    })),
  }).eq("household_id", householdId),
);

const services = [
  { name: "ジェルネイル", duration_minutes: 90, price_yen: 8000 },
  { name: "ネイルケア", duration_minutes: 60, price_yen: 4500 },
  { name: "ネイルオフ", duration_minutes: 60, price_yen: null },
];
await check(
  admin.from("shop_services").upsert(
    services.map((service, index) => ({
      id: demoId(100 + index),
      household_id: householdId,
      sort_order: index,
      ...service,
    })),
  ),
);

// 来客。予約が来客を参照するので先に入れる。device がないグループでは入れない
const VISIT_INQUIRY = demoId(201);
const visits = device
  ? [
    {
      id: demoId(200),
      days: 0,
      minute: 9 * 60 + 48,
      intent: "sales",
      company: null,
      outcome: "declined",
      messages: [
        ["ai", "はい、ネイルサロン〇〇でございます。"],
        ["visitor", "近くで工事をしておりまして、ご挨拶に伺いました。"],
        ["ai", "恐れ入りますが、ただいま対応いたしかねます。資料がございましたらポストにお願いいたします。失礼いたします。"],
      ],
    },
    {
      id: VISIT_INQUIRY,
      days: 0,
      minute: 11 * 60 + 42,
      intent: "unknown",
      company: null,
      outcome: "none",
      messages: [
        ["ai", "はい、ネイルサロン〇〇でございます。"],
        ["visitor", "予約していないんですが、明日の午後は空いていますか。"],
        ["ai", "恐れ入ります。お名前とご希望の日時をお伺いしてもよろしいでしょうか。確定はお店よりご連絡いたします。"],
        ["visitor", "中村です。明日の15時でお願いします。"],
        ["ai", "かしこまりました。お店よりご連絡いたします。失礼いたします。"],
      ],
    },
    {
      id: demoId(202),
      days: -1,
      minute: 14 * 60 + 32,
      intent: "delivery",
      company: "ヤマト運輸",
      outcome: "leave_at_door",
      messages: [
        ["ai", "はい、ネイルサロン〇〇でございます。"],
        ["visitor", "ヤマト運輸です。お荷物のお届けです。"],
        ["ai", "恐れ入りますが、玄関の前に置いていただけますか。失礼いたします。"],
      ],
    },
  ]
  : [];

for (const visit of visits) {
  const start = at(visit.days, visit.minute);
  const answered = new Date(Date.parse(start) + 2_000).toISOString();
  const ended = new Date(Date.parse(start) + 40_000).toISOString();
  await check(
    admin.from("visits").upsert({
      id: visit.id,
      household_id: householdId,
      device_id: device!.id,
      mode: "omakase",
      chimed_at: start,
      answered_at: answered,
      ended_at: ended,
      status: "ended",
      intent: visit.intent,
      company: visit.company,
      outcome: visit.outcome,
      end_reason: "closing",
    }),
  );
  await check(
    admin.from("visit_messages").upsert(
      visit.messages.map(([speaker, text], index) => ({
        visit_id: visit.id,
        household_id: householdId,
        seq: index + 1,
        speaker,
        text,
        spoken_at: new Date(Date.parse(answered) + index * 8_000).toISOString(),
      })),
      { ignoreDuplicates: true },
    ),
  );
}

// 今日の次の予約は、いつ実行しても未来になるように今の時刻から決める
const nowMinutes = tokyoNow.getUTCHours() * 60 + tokyoNow.getUTCMinutes();
const nextStart = Math.min(Math.ceil(nowMinutes / 30) * 30 + 30, 21 * 60);
const arrivedStart = Math.max(nextStart - 180, 0);

type DemoReservation = {
  days: number;
  start: number;
  minutes: number;
  name: string;
  service: string;
  status?: "pending" | "confirmed" | "cancelled";
  source?: "app" | "ai";
  phone?: string;
  note?: string;
  arrived?: boolean;
  visitId?: string;
};

const reservations: DemoReservation[] = [
  { days: 0, start: arrivedStart, minutes: 60, name: "佐藤", service: "ネイルケア", phone: "090-0000-0001", arrived: true },
  { days: 0, start: nextStart, minutes: 90, name: "田中", service: "ジェルネイル", phone: "090-0000-0002" },
  { days: 0, start: nextStart + 120, minutes: 60, name: "山本", service: "ネイルオフ" },
  { days: 1, start: 11 * 60, minutes: 60, name: "加藤", service: "ネイルケア", phone: "090-0000-0003" },
  {
    days: 1,
    start: 15 * 60,
    minutes: 90,
    name: "中村",
    service: "ジェルネイル",
    status: "pending",
    source: "ai",
    phone: "090-0000-0004",
    note: "初めての来店",
    visitId: device ? VISIT_INQUIRY : undefined,
  },
  { days: 3, start: 11 * 60, minutes: 60, name: "高橋", service: "ネイルケア", status: "pending", source: "ai" },
  { days: 3, start: 14 * 60, minutes: 90, name: "小林", service: "ジェルネイル", phone: "090-0000-0005" },
  { days: 3, start: 17 * 60, minutes: 60, name: "林", service: "ネイルケア", status: "cancelled" },
  // 1日に4件入れ、月の表示の「+2」を確かめる
  { days: 4, start: 10 * 60, minutes: 90, name: "吉田", service: "ジェルネイル" },
  { days: 4, start: 12 * 60, minutes: 60, name: "伊藤", service: "ネイルオフ" },
  { days: 4, start: 14 * 60, minutes: 90, name: "渡辺", service: "ジェルネイル" },
  { days: 4, start: 16 * 60, minutes: 60, name: "松本", service: "ネイルケア" },
  { days: 6, start: 15 * 60, minutes: 90, name: "井上", service: "ジェルネイル" },
];

const reservationId = (index: number) => demoId(300 + index);
await check(
  admin.from("reservations").upsert(
    reservations.map((r, index) => ({
      id: reservationId(index),
      household_id: householdId,
      customer_name: r.name,
      customer_phone: r.phone ?? null,
      service_name: r.service,
      starts_at: at(r.days, r.start),
      ends_at: at(r.days, r.start + r.minutes),
      status: r.status ?? "confirmed",
      source: r.source ?? "app",
      note: r.note ?? null,
      arrived_at: r.arrived ? at(r.days, r.start - 4) : null,
      visit_id: r.visitId ?? null,
    })),
  ),
);

// 通知の一覧に種類が並ぶように入れる。プッシュは送らない
function reservationNotification(kind: string, title: string, index: number, minutesAgo: number) {
  const r = reservations[index];
  return {
    household_id: householdId,
    kind,
    title,
    body: `${dayLabel(r.days)}${hhmm(r.start)}\n${r.name}様　${r.service}`,
    data: { reservation_id: reservationId(index) },
    dedupe_key: `demo:${kind}:${index}`,
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

const notifications = [
  reservationNotification("reservation_arrived", "予約のお客様が到着しました", 0, 150),
  reservationNotification("reservation_pending", "仮予約が入りました", 4, 180),
  reservationNotification("reservation_pending", "仮予約が入りました", 5, 240),
  reservationNotification("reservation_created", "予約が入りました", 8, 60 * 24),
  reservationNotification("reservation_cancelled", "予約がキャンセルされました", 7, 60 * 26),
];
await check(
  admin.from("notifications").delete().eq("household_id", householdId).like("dedupe_key", "demo:%"),
);
await check(admin.from("notifications").insert(notifications));

console.log(`入れた先    ${url}`);
console.log(`アカウント  ${email}`);
console.log(`メニュー    ${services.length} 件`);
console.log(`予約        ${reservations.length} 件（仮予約 2 件、到着済み 1 件、キャンセル 1 件）`);
console.log(`来客        ${visits.length} 件${device ? "" : "（本体がないグループなので入れていません）"}`);
console.log(`通知        ${notifications.length} 件（来客の通知は別に Webhook が作ります）`);
console.log(`定休日      ${WEEKDAYS[closedDay]}曜日`);
