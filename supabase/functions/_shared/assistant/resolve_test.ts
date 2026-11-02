import { assertEquals } from "jsr:@std/assert@1.0.19";
import type { Reservation, ReservationProvider, ReservationRange } from "../reservation.ts";
import { buildContext, type BusinessHour, type ParsedIntent } from "./intent_parser.ts";
import type { AddReservationProposal, SetBusinessHoursProposal, UpdateReservationProposal } from "./proposal.ts";
import { resolveIntent } from "./resolve.ts";

// 2026-11-02（月）13:20 東京
const NOW = new Date("2026-11-02T04:20:00.000Z");
const SERVICES = [
  { name: "ジェルネイル", duration_minutes: 90 },
  { name: "ネイルケア", duration_minutes: 45 },
  { name: "ハンドケア", duration_minutes: 30 },
];
const HOURS: BusinessHour[] = [
  { day: 1, closed: false, open: "10:00", close: "19:00" },
  { day: 2, closed: true, open: "10:00", close: "19:00" },
  { day: 3, closed: false, open: "10:00", close: "19:00" },
];

function reservation(overrides: Partial<Reservation>): Reservation {
  return {
    id: "r1",
    customer_name: "田中",
    customer_phone: null,
    service_name: "ジェルネイル",
    starts_at: "2026-11-02T05:00:00.000Z", // 14:00
    ends_at: "2026-11-02T06:30:00.000Z", // 15:30
    status: "confirmed",
    source: "app",
    note: null,
    arrived_at: null,
    visit_id: null,
    read_only: false,
    ...overrides,
  };
}

function provider(reservations: Reservation[] = [], kind: ReservationProvider["kind"] = "monban") {
  const ranges: ReservationRange[] = [];
  const fake = {
    kind,
    list(range: ReservationRange) {
      ranges.push(range);
      const from = Date.parse(range.from);
      const to = Date.parse(range.to);
      return Promise.resolve(reservations.filter((r) => Date.parse(r.starts_at) < to && Date.parse(r.ends_at) > from));
    },
  } as unknown as ReservationProvider;
  return { provider: fake, ranges };
}

// 既定の文には長さの指定だけを入れ、日付の突き合わせが働かないようにする
function resolve(intent: ParsedIntent, reservations: Reservation[] = [], kind: ReservationProvider["kind"] = "monban", text = "30分") {
  return resolveIntent({
    text,
    intent,
    context: buildContext(NOW, SERVICES, HOURS),
    provider: provider(reservations, kind).provider,
    now: NOW,
  });
}

const reasonOf = async (intent: ParsedIntent, reservations: Reservation[] = [], kind: ReservationProvider["kind"] = "monban") => {
  const proposal = await resolve(intent, reservations, kind);
  return proposal.type === "unknown" ? proposal.reason : `not unknown: ${proposal.type}`;
};

Deno.test("buildContext は東京の今日と2週間分の日付の表を作る", () => {
  // UTC では 11月1日でも東京は 11月2日
  const context = buildContext(new Date("2026-11-01T20:00:00.000Z"), [], []);
  assertEquals([context.today, context.today_weekday], ["2026-11-02", "月"]);
  assertEquals(context.calendar.length, 14);
  assertEquals(context.calendar[3], { date: "2026-11-05", weekday: "木" });
});

Deno.test("知らない action と型の違う action は unknown", async () => {
  for (const action of ["unknown", "delete", 1, null, undefined]) {
    assertEquals(await resolve({ action }), { type: "unknown", reason: "読み取れませんでした", warnings: [] });
  }
});

Deno.test("追加: メニューが一致すれば所要時間を使い、敬称を外す", async () => {
  const proposal = await resolve({
    action: "add",
    customer_name: "田中さん",
    date: "2026-11-05",
    start_time: "14:00",
    service_name: "ジェルネイル",
    customer_phone: "090-0000-0000",
    note: " 初めて ",
  }) as AddReservationProposal;
  assertEquals(proposal, {
    type: "add_reservation",
    customer_name: "田中",
    customer_phone: "090-0000-0000",
    service_name: "ジェルネイル",
    starts_at: "2026-11-05T05:00:00.000Z",
    ends_at: "2026-11-05T06:30:00.000Z",
    note: "初めて",
    warnings: [],
  });
});

Deno.test("追加: メニューの照合", async () => {
  const add = (service_name: unknown) =>
    resolve({ action: "add", customer_name: "田中", date: "2026-11-05", start_time: "14:00", service_name }) as Promise<AddReservationProposal>;
  // 部分一致が1つなら採る。全角や空白も同じものとして扱う
  assertEquals((await add("ジェル")).service_name, "ジェルネイル");
  assertEquals((await add("ネイル ケア")).service_name, "ネイルケア");
  // 複数に一致したり一致しなかったりしたら 60 分で、書かれた名前を残す
  const ambiguous = await add("ケア");
  assertEquals([ambiguous.service_name, ambiguous.ends_at], ["ケア", "2026-11-05T06:00:00.000Z"]);
  const none = await add("まつげパーマ");
  assertEquals([none.service_name, none.ends_at], ["まつげパーマ", "2026-11-05T06:00:00.000Z"]);
  const missing = await add(null);
  assertEquals([missing.service_name, missing.ends_at], [null, "2026-11-05T06:00:00.000Z"]);
});

Deno.test("追加: 終了は終了時刻、所要時間、メニューの順で決める", async () => {
  const add = (extra: Partial<ParsedIntent>) =>
    resolve({ action: "add", customer_name: "田中", date: "2026-11-05", start_time: "14:00", service_name: "ジェルネイル", ...extra }) as Promise<AddReservationProposal>;
  assertEquals((await add({ end_time: "14:30" })).ends_at, "2026-11-05T05:30:00.000Z");
  assertEquals((await add({ duration_minutes: 30 })).ends_at, "2026-11-05T05:30:00.000Z");
  // 開始より前の終了時刻、範囲外や型の違う所要時間は無視する
  assertEquals((await add({ end_time: "13:00" })).ends_at, "2026-11-05T06:30:00.000Z");
  for (const duration_minutes of [1, 721, 30.5, "30"]) {
    assertEquals((await add({ duration_minutes })).ends_at, "2026-11-05T06:30:00.000Z");
  }
});

Deno.test("追加: 名前と日時が読めなければ unknown", async () => {
  const base = { action: "add", customer_name: "田中", date: "2026-11-05", start_time: "14:00" };
  for (const customer_name of ["", "さん", null, 1, "あ".repeat(61)]) {
    assertEquals(await reasonOf({ ...base, customer_name }), "お客様の名前を読み取れませんでした");
  }
  for (const date of ["2026-02-30", "11月5日", null, 20261105]) {
    assertEquals(await reasonOf({ ...base, date }), "日時を読み取れませんでした");
  }
  for (const start_time of ["25:00", "14時", null]) {
    assertEquals(await reasonOf({ ...base, start_time }), "日時を読み取れませんでした");
  }
});

Deno.test("追加: 過去の日時は unknown", async () => {
  assertEquals(
    await reasonOf({ action: "add", customer_name: "田中", date: "2026-11-02", start_time: "13:20" }),
    "過去の日時は指定できません",
  );
});

Deno.test("追加: 不正な電話番号やメモは捨てる", async () => {
  const proposal = await resolve({
    action: "add",
    customer_name: "田中",
    date: "2026-11-05",
    start_time: "14:00",
    customer_phone: "電話なし",
    note: "あ".repeat(501),
  }) as AddReservationProposal;
  assertEquals([proposal.customer_phone, proposal.note], [null, null]);
});

Deno.test("追加: 重なりと定休日を warnings で返す", async () => {
  const yamamoto = reservation({ id: "r2", customer_name: "山本", starts_at: "2026-11-02T07:30:00.000Z", ends_at: "2026-11-02T08:30:00.000Z" });
  const external = reservation({ id: "r3", customer_name: "歯医者", source: "external", starts_at: "2026-11-02T07:00:00.000Z", ends_at: "2026-11-02T07:30:00.000Z" });
  const overlap = await resolve(
    { action: "add", customer_name: "田中", date: "2026-11-02", start_time: "16:00", duration_minutes: 60 },
    [external, yamamoto],
  );
  assertEquals(overlap.warnings, ["16:00〜の歯医者と重なります", "16:30〜の山本様と重なります"]);

  // 火曜は定休日
  const closed = await resolve({ action: "add", customer_name: "田中", date: "2026-11-03", start_time: "14:00" });
  assertEquals(closed.warnings, ["11月3日（火）は定休日です"]);
});

Deno.test("追加: Square は予約先で追加してもらう", async () => {
  assertEquals(
    await reasonOf({ action: "add", customer_name: "田中", date: "2026-11-05", start_time: "14:00" }, [], "square"),
    "Square 予約の予約は Square で追加してください",
  );
});

Deno.test("変更: 名前と日付で予約を探し、長さを保って動かす", async () => {
  const proposal = await resolve(
    { action: "update", customer_name: "田中さん", target_date: "2026-11-02", start_time: "15:30" },
    [reservation({})],
  ) as UpdateReservationProposal;
  assertEquals(proposal, {
    type: "update_reservation",
    reservation_id: "r1",
    customer_name: "田中",
    service_name: "ジェルネイル",
    before: { starts_at: "2026-11-02T05:00:00.000Z", ends_at: "2026-11-02T06:30:00.000Z" },
    after: { starts_at: "2026-11-02T06:30:00.000Z", ends_at: "2026-11-02T08:00:00.000Z" },
    warnings: [],
  });
});

Deno.test("変更: 日付だけ、時刻だけ、長さだけの変更", async () => {
  const update = (extra: Partial<ParsedIntent>) =>
    resolve({ action: "update", customer_name: "田中", ...extra }, [reservation({})]) as Promise<UpdateReservationProposal>;
  // 日付を書かなければ向こう 30 日から探し、時刻を保つ
  assertEquals((await update({ date: "2026-11-05" })).after, {
    starts_at: "2026-11-05T05:00:00.000Z",
    ends_at: "2026-11-05T06:30:00.000Z",
  });
  assertEquals((await update({ duration_minutes: 60 })).after, {
    starts_at: "2026-11-02T05:00:00.000Z",
    ends_at: "2026-11-02T06:00:00.000Z",
  });
  assertEquals((await update({ end_time: "16:00" })).after.ends_at, "2026-11-02T07:00:00.000Z");
});

Deno.test("変更: 探す期間は日付で決まる", async () => {
  const dated = provider([]);
  await resolveIntent({
    text: "",
    intent: { action: "update", customer_name: "田中", target_date: "2026-11-05", start_time: "15:00" },
    context: buildContext(NOW, [], []),
    provider: dated.provider,
    now: NOW,
  });
  assertEquals(dated.ranges[0], { from: "2026-11-04T15:00:00.000Z", to: "2026-11-05T15:00:00.000Z" });

  const undated = provider([]);
  await resolveIntent({
    text: "",
    intent: { action: "update", customer_name: "田中", start_time: "15:00" },
    context: buildContext(NOW, [], []),
    provider: undated.provider,
    now: NOW,
  });
  assertEquals(undated.ranges[0], { from: NOW.toISOString(), to: "2026-12-02T04:20:00.000Z" });
});

Deno.test("変更: 見つからない、複数ある、読み取り専用は unknown", async () => {
  const intent = { action: "update", customer_name: "田中", start_time: "15:00" };
  assertEquals(await reasonOf(intent), "田中様の予約が見つかりませんでした");
  assertEquals(await reasonOf(intent, [reservation({ customer_name: "山本" })]), "田中様の予約が見つかりませんでした");
  assertEquals(
    await reasonOf(intent, [reservation({}), reservation({ id: "r2", starts_at: "2026-11-05T05:00:00.000Z", ends_at: "2026-11-05T06:00:00.000Z" })]),
    "田中様の予約が2件あります。日付も書いてください",
  );
  assertEquals(await reasonOf(intent, [reservation({ read_only: true })]), "この予約は予約先で変更してください");
});

Deno.test("変更: 読めない値、変更なし、過去は unknown", async () => {
  const one = [reservation({})];
  assertEquals(await reasonOf({ action: "update", start_time: "15:00" }, one), "お客様の名前を読み取れませんでした");
  assertEquals(await reasonOf({ action: "update", customer_name: "田中", target_date: "明日", start_time: "15:00" }, one), "予約の日付を読み取れませんでした");
  assertEquals(await reasonOf({ action: "update", customer_name: "田中" }, one), "変更後の日時を読み取れませんでした");
  assertEquals(await reasonOf({ action: "update", customer_name: "田中", date: "不明", start_time: "不明" }, one), "変更後の日時を読み取れませんでした");
  assertEquals(await reasonOf({ action: "update", customer_name: "田中", start_time: "14:00" }, one), "今の予約と同じ日時です");
  assertEquals(await reasonOf({ action: "update", customer_name: "田中", start_time: "10:00" }, one), "過去の日時は指定できません");
});

Deno.test("変更: 自分は重なりから外し、ほかの予約との重なりと定休日を知らせる", async () => {
  const yamamoto = reservation({ id: "r2", customer_name: "山本", starts_at: "2026-11-02T07:30:00.000Z", ends_at: "2026-11-02T08:30:00.000Z" });
  const proposal = await resolve(
    { action: "update", customer_name: "田中", target_date: "2026-11-02", start_time: "15:30" },
    [reservation({}), yamamoto],
  );
  assertEquals(proposal.warnings, ["16:30〜の山本様と重なります"]);

  const closed = await resolve({ action: "update", customer_name: "田中", date: "2026-11-03" }, [reservation({})]);
  assertEquals(closed.warnings, ["11月3日（火）は定休日です"]);
});

Deno.test("営業時間: 定休日にすると、向こう 30 日に残る予約を日付ごとに知らせる", async () => {
  const proposal = await resolve(
    { action: "set_hours", weekday: 3, closed: true },
    [
      reservation({ id: "a", starts_at: "2026-11-04T02:00:00.000Z", ends_at: "2026-11-04T03:00:00.000Z" }),
      reservation({ id: "b", starts_at: "2026-11-04T06:00:00.000Z", ends_at: "2026-11-04T07:00:00.000Z" }),
      reservation({ id: "c", starts_at: "2026-11-11T06:00:00.000Z", ends_at: "2026-11-11T07:00:00.000Z" }),
      // 木曜の予約は関係ない
      reservation({ id: "d", starts_at: "2026-11-05T06:00:00.000Z", ends_at: "2026-11-05T07:00:00.000Z" }),
    ],
  ) as SetBusinessHoursProposal;
  assertEquals(proposal, {
    type: "set_business_hours",
    day: 3,
    before: { closed: false, open: "10:00", close: "19:00" },
    after: { closed: true, open: "10:00", close: "19:00" },
    warnings: ["11月4日（水）の予約 2件は残ります", "11月11日（水）の予約 1件は残ります"],
  });
});

Deno.test("営業時間: 時刻の変更では、外れる予約だけを知らせる", async () => {
  const proposal = await resolve(
    { action: "set_hours", weekday: 3, shop_open: "12:00", shop_close: "18:00" },
    [
      // 11:00〜12:00 は外れる
      reservation({ id: "a", starts_at: "2026-11-04T02:00:00.000Z", ends_at: "2026-11-04T03:00:00.000Z" }),
      // 15:00〜16:00 は収まる
      reservation({ id: "b", starts_at: "2026-11-04T06:00:00.000Z", ends_at: "2026-11-04T07:00:00.000Z" }),
    ],
  ) as SetBusinessHoursProposal;
  assertEquals(proposal.after, { closed: false, open: "12:00", close: "18:00" });
  assertEquals(proposal.warnings, ["11月4日（水）の予約 1件は残ります"]);
});

Deno.test("営業時間: 片方の時刻だけの変更と、定休日から営業への変更", async () => {
  const later = await resolve({ action: "set_hours", weekday: 1, shop_close: "20:00" }) as SetBusinessHoursProposal;
  assertEquals(later.after, { closed: false, open: "10:00", close: "20:00" });

  const reopened = await resolve({ action: "set_hours", weekday: 2, closed: false }) as SetBusinessHoursProposal;
  assertEquals(reopened.after, { closed: false, open: "10:00", close: "19:00" });
});

Deno.test("営業時間: 読めない値、未設定で時刻なし、前後の逆転、変更なしは unknown", async () => {
  for (const weekday of [7, -1, 1.5, "水", null]) {
    assertEquals(await reasonOf({ action: "set_hours", weekday, closed: true }), "曜日を読み取れませんでした");
  }
  // 木曜の営業時間は未設定
  assertEquals(await reasonOf({ action: "set_hours", weekday: 4 }), "開店と閉店の時刻を読み取れませんでした");
  assertEquals(await reasonOf({ action: "set_hours", weekday: 1, shop_open: "朝" }), "開店と閉店の時刻を読み取れませんでした");
  assertEquals(await reasonOf({ action: "set_hours", weekday: 1, shop_open: "20:00" }), "閉店は開店より後にしてください");
  assertEquals(await reasonOf({ action: "set_hours", weekday: 2, closed: true }), "今の営業時間と同じです");
  assertEquals(await reasonOf({ action: "set_hours", weekday: 1, shop_open: "10:00" }), "今の営業時間と同じです");
});

Deno.test("営業時間: 未設定の曜日を定休日にできる", async () => {
  const proposal = await resolve({ action: "set_hours", weekday: 4, closed: true }) as SetBusinessHoursProposal;
  assertEquals(proposal.before, { closed: false, open: null, close: null });
  assertEquals(proposal.after, { closed: true, open: null, close: null });
});

Deno.test("文との突き合わせ: 長さが書かれていなければ LLM の所要時間を使わない", async () => {
  const add = await resolve(
    { action: "add", customer_name: "田中", date: "2026-11-05", start_time: "14:00", duration_minutes: 30, service_name: "ジェルネイル" },
    [],
    "monban",
    "木曜の14時に田中さん、ジェルネイルで",
  ) as AddReservationProposal;
  assertEquals(add.ends_at, "2026-11-05T06:30:00.000Z");

  // 変更でも、書かれていない長さで予約を伸び縮みさせない
  const update = await resolve(
    { action: "update", customer_name: "田中", start_time: "15:30", duration_minutes: 30 },
    [reservation({})],
    "monban",
    "田中さんの予約、15時半にずらして",
  ) as UpdateReservationProposal;
  assertEquals(update.after.ends_at, "2026-11-02T08:00:00.000Z");
});

Deno.test("文との突き合わせ: LLM が落としたメニュー名を文から拾う", async () => {
  const add = (text: string) =>
    resolve({ action: "add", customer_name: "田中", date: "2026-11-05", start_time: "14:00" }, [], "monban", text) as Promise<AddReservationProposal>;
  const found = await add("木曜の14時に田中さん、ジェルネイルで");
  assertEquals([found.service_name, found.ends_at], ["ジェルネイル", "2026-11-05T06:30:00.000Z"]);
  // 2つ書かれていれば決められない
  assertEquals((await add("木曜の14時に田中さん、ジェルネイルとネイルケア")).service_name, null);
});

Deno.test("文との突き合わせ: 書かれた曜日や「明日」と日付が合わなければ案を出さない", async () => {
  const mismatch = "日付を読み取れませんでした。11月9日のように書いてください";
  const add = (date: string, text: string) =>
    resolve({ action: "add", customer_name: "田中", date, start_time: "14:00" }, [], "monban", text);

  // 2026-11-14 は土曜
  const wrong = await add("2026-11-14", "田中さん、来週月曜の午後3時");
  assertEquals(wrong.type === "unknown" && wrong.reason, mismatch);
  assertEquals((await add("2026-11-09", "田中さん、来週月曜の午後3時")).type, "add_reservation");

  const tomorrowWrong = await add("2026-11-05", "明日の14時に田中さん");
  assertEquals(tomorrowWrong.type === "unknown" && tomorrowWrong.reason, mismatch);
  assertEquals((await add("2026-11-03", "明日の14時に田中さん")).type, "add_reservation");
  assertEquals((await add("2026-11-04", "明後日の14時に田中さん")).type, "add_reservation");
  // 曜日も「明日」もなければ確かめない
  assertEquals((await add("2026-11-14", "11月14日の14時に田中さん")).type, "add_reservation");

  // 変更は、今の日付と変更後の日付の両方を確かめる
  const one = [reservation({})];
  const moved = await resolve(
    { action: "update", customer_name: "田中", target_date: "2026-11-02", date: "2026-11-06" },
    one,
    "monban",
    "田中さんの今日の予約を金曜にして",
  );
  assertEquals(moved.type, "update_reservation");
  const wrongTarget = await resolve({ action: "update", customer_name: "田中", target_date: "2026-11-05", start_time: "15:00" }, one, "monban", "今日の田中さん");
  assertEquals(wrongTarget.type === "unknown" && wrongTarget.reason, mismatch);
  const wrongDate = await resolve({ action: "update", customer_name: "田中", date: "2026-11-07" }, one, "monban", "田中さんを金曜にして");
  assertEquals(wrongDate.type === "unknown" && wrongDate.reason, mismatch);
});

Deno.test("文との突き合わせ: LLM が落とした時刻を文から拾う", async () => {
  const add = (text: string) =>
    resolve({ action: "add", customer_name: "田中", date: "2026-11-05" }, [], "monban", text) as Promise<AddReservationProposal>;
  // 追加は最初の時刻が開始
  assertEquals((await add("田中さん、14時から15時半まで")).starts_at, "2026-11-05T05:00:00.000Z");
  assertEquals((await add("田中さん、午後3時に")).starts_at, "2026-11-05T06:00:00.000Z");
  assertEquals((await add("田中さん、15:30に")).starts_at, "2026-11-05T06:30:00.000Z");
  assertEquals((await add("田中さん、１４時３０分に")).starts_at, "2026-11-05T05:30:00.000Z");
  const none = await resolve({ action: "add", customer_name: "田中", date: "2026-11-05" }, [], "monban", "田中さん、夕方に");
  assertEquals(none.type === "unknown" && none.reason, "日時を読み取れませんでした");
  const invalid = await resolve({ action: "add", customer_name: "田中", date: "2026-11-05" }, [], "monban", "田中さん、25時に");
  assertEquals(invalid.type === "unknown" && invalid.reason, "日時を読み取れませんでした");

  // 変更は最後の時刻が変更後
  const update = await resolve(
    { action: "update", customer_name: "田中", target_date: "2026-11-02" },
    [reservation({})],
    "monban",
    "今日の14時の田中さんの予約、15時半にずらして",
  ) as UpdateReservationProposal;
  assertEquals(update.after.starts_at, "2026-11-02T06:30:00.000Z");
});
