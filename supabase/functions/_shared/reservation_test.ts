// deno test supabase/functions/_shared/
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.19";
import { parseNewReservation, parseRange, parseReservationPatch, ProviderError } from "./reservation.ts";
import { reservationNotice, reservationTime } from "./reservation_notice.ts";
import { decryptToken, encryptToken } from "./token_crypto.ts";

const origin = { status: "pending", source: "ai" } as const;
const valid = { customer_name: " 田中 ", starts_at: "2026-11-02T14:00:00+09:00", ends_at: "2026-11-02T15:00:00+09:00" };

Deno.test("新しい予約の入力を整え、受付元と状態は呼ぶ側が決める", () => {
  assertEquals(parseNewReservation({ ...valid, status: "confirmed", source: "app", note: " " }, origin), {
    customer_name: "田中",
    customer_phone: null,
    service_name: null,
    starts_at: "2026-11-02T05:00:00.000Z",
    ends_at: "2026-11-02T06:00:00.000Z",
    note: null,
    status: "pending",
    source: "ai",
    visit_id: null,
  });
});

Deno.test("オフセットのない日時は受け付けない", () => {
  for (const value of ["2026-11-05T14:00:00", "2026-11-05", "2026-11-05 14:00:00", "明日"]) {
    assertThrows(() => parseNewReservation({ ...valid, starts_at: value }, origin), ProviderError, "Z か +09:00");
  }
  assertEquals(parseNewReservation({ ...valid, starts_at: "2026-11-02T04:00:00Z" }, origin).starts_at, "2026-11-02T04:00:00.000Z");
  assertEquals(parseNewReservation({ ...valid, starts_at: "2026-11-02T04:00:00.000z" }, origin).starts_at, "2026-11-02T04:00:00.000Z");
  assertEquals(parseNewReservation({ ...valid, starts_at: "2026-11-02T13:00:00+09:00" }, origin).starts_at, "2026-11-02T04:00:00.000Z");
});

Deno.test("入力の誤りは 400", () => {
  for (
    const body of [
      { ...valid, customer_name: " " },
      { ...valid, customer_name: "あ".repeat(61) },
      { ...valid, starts_at: "明日" },
      { ...valid, ends_at: valid.starts_at },
      { ...valid, customer_phone: 90 },
      { ...valid, note: "あ".repeat(501) },
    ]
  ) {
    const error = assertThrows(() => parseNewReservation(body, origin), ProviderError);
    assertEquals(error.status, 400);
  }
  assertEquals(assertThrows(() => parseReservationPatch({ ignored: 1 }), ProviderError).status, 400);
});

Deno.test("変更は送られた項目だけを読み、null で消せる", () => {
  assertEquals(parseReservationPatch({ note: null, ignored: 1 }), { note: null });
});

Deno.test("期間は from と to が要り、status は決まった値だけ", () => {
  const params = (values: Record<string, string>) => new URLSearchParams(values);
  const range = { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" };
  assertEquals(parseRange(params({ ...range, status: "pending" })).status, "pending");
  const bads: Record<string, string>[] = [{}, { from: range.from }, { from: range.to, to: range.from }, { ...range, status: "x" }];
  for (const bad of bads) {
    assertEquals(assertThrows(() => parseRange(params(bad)), ProviderError).status, 400);
  }
});

Deno.test("通知の文面は東京の時刻で、Google の件名には様を付けない", () => {
  assertEquals(reservationTime("2026-11-02T05:00:00.000Z"), "11月2日（月）14:00");
  const reservation = {
    id: "r1",
    customer_name: "田中",
    customer_phone: null,
    service_name: "ジェルネイル",
    starts_at: "2026-11-02T05:00:00.000Z",
    ends_at: "2026-11-02T06:00:00.000Z",
    status: "pending" as const,
    source: "ai" as const,
    note: null,
    arrived_at: null,
    visit_id: null,
    read_only: false,
  };
  const notice = reservationNotice("h1", "reservation_pending", reservation, "key", { actorUserId: "u1" });
  assertEquals(notice, {
    household_id: "h1",
    kind: "reservation_pending",
    title: "仮予約が入りました",
    body: "11月2日（月）14:00\n田中様　ジェルネイル",
    data: { reservation_id: "r1" },
    dedupe_key: "key",
    actor_user_id: "u1",
  });
  const external = { ...reservation, source: "external" as const, service_name: null };
  assertEquals(reservationNotice("h1", "reservation_created", external, "key").body, "11月2日（月）14:00\n田中");
});

Deno.test("更新トークンは暗号化して元に戻せ、鍵が違えば読めない", async () => {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const other = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const encrypted = await encryptToken("refresh-token", key);
  assertEquals(encrypted.includes("refresh-token"), false);
  assertEquals(await decryptToken(encrypted, key), "refresh-token");
  await assertRejects(() => decryptToken(encrypted, other));
  await assertRejects(() => encryptToken("x", btoa("short")));
});
