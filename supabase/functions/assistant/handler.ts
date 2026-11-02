// 自然言語の入力を案に変える（docs/reservations.md 8章）。書き込みはしない。
// 文には顧客名が入るので、DB にもログにも残さない
import { buildContext, type BusinessHour, type IntentParser, type ShopService } from "../_shared/assistant/intent_parser.ts";
import { resolveIntent } from "../_shared/assistant/resolve.ts";
import { readJsonObject, reservationErrorResponse } from "../_shared/errors.ts";
import type { Member } from "../_shared/member_auth.ts";
import { ProviderError, type ReservationProvider } from "../_shared/reservation.ts";

const MAX_TEXT = 200;

export type AssistantDeps = {
  authenticate(req: Request): Promise<Member | "forbidden" | null>;
  // 解析器の設定がなければ null
  parser: IntentParser | null;
  providerFor(householdId: string): Promise<ReservationProvider>;
  shopFor(householdId: string): Promise<{ services: ShopService[]; hours: BusinessHour[] }>;
  now?: () => Date;
};

export async function handleAssistantRequest(req: Request, deps: AssistantDeps): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/^(?:\/functions\/v1)?\/assistant/, "").replace(/\/$/, "");
  try {
    if (path !== "/parse") return Response.json({ error: "not found" }, { status: 404 });
    if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
    const member = await deps.authenticate(req);
    if (member === null) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (member === "forbidden") return Response.json({ error: "グループに入っていません" }, { status: 403 });

    const text = parseText((await readJsonObject(req)).text);
    if (!deps.parser) {
      throw new ProviderError(503, "文を読み取れませんでした。入力フォームから入力してください", "assistant_unavailable");
    }
    const now = deps.now?.() ?? new Date();
    const { services, hours } = await deps.shopFor(member.householdId);
    const context = buildContext(now, services, hours);
    const intent = await deps.parser.parse(text, context);
    const provider = await deps.providerFor(member.householdId);
    return Response.json({ proposal: await resolveIntent({ text, intent, context, provider, now }) });
  } catch (e) {
    return reservationErrorResponse(e);
  }
}

function parseText(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new ProviderError(400, "text を入れてください");
  if (Array.from(text).length > MAX_TEXT) throw new ProviderError(400, `text は ${MAX_TEXT} 字までにしてください`);
  return text;
}
