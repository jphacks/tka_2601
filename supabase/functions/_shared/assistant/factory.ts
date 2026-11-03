// 環境変数から解析器を選ぶ。解析器を足すときはここに分岐を足す
import type { IntentParser } from "./intent_parser.ts";
import { OllamaIntentParser } from "./ollama_parser.ts";

const DEFAULT_MODEL = "gemma4:latest";

type Env = { get(key: string): string | undefined };

// 設定がなければ null。呼ぶ側が 503 にする
export function intentParserFromEnv(env: Env = Deno.env, doFetch: typeof fetch = fetch): IntentParser | null {
  const baseUrl = env.get("ASSISTANT_LLM_BASE_URL");
  if (!baseUrl) return null;
  const timeout = Number(env.get("ASSISTANT_LLM_TIMEOUT_MS"));
  return new OllamaIntentParser({
    baseUrl,
    model: env.get("ASSISTANT_LLM_MODEL") || DEFAULT_MODEL,
    apiKey: env.get("ASSISTANT_LLM_API_KEY") || undefined,
    timeoutMs: timeout > 0 ? timeout : undefined,
  }, doFetch);
}
