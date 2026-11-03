// Webhook と pg_cron の合言葉を確かめる（PUSH_WEBHOOK_SECRET）
export function hasWebhookSecret(req: Request, expected = Deno.env.get("PUSH_WEBHOOK_SECRET")): boolean {
  const actual = req.headers.get("x-webhook-secret");
  if (!expected || !actual) return false;
  return constantTimeEqual(actual, expected);
}

export function constantTimeEqual(actual: string, expected: string): boolean {
  const a = new TextEncoder().encode(actual);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
