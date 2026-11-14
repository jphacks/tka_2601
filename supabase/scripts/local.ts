// seed_local.ts と tests/e2e_local.ts が使う、ローカル環境の共通部分

// シードの家とデバイスの ID（本体の設定で使う）
export const HOUSEHOLD_ID = "7d0c1f3e-2b8a-4c55-9a51-1f0e6b2d4a10";
export const DEVICE_ID = "3b9e5a27-8c4d-4f1e-b6a2-5d7c9e0f1a23";

// supabase/ の絶対パス（末尾に / が付く）
export const supabaseDir = new URL("..", import.meta.url).pathname;

export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

export function readEnvFile(path: string): Record<string, string> {
  return parseEnv(Deno.readTextFileSync(path));
}

export function required(env: Record<string, string>, key: string, source: string): string {
  const value = env[key];
  if (!value) throw new Error(`${source} に ${key} がありません`);
  return value;
}

export async function supabaseCli(args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("supabase", {
    args,
    cwd: `${supabaseDir}..`,
  }).output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout);
}

// デバイス鍵の SHA-256（16 進）。Edge Function「device」と同じ計算
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// supabase status の API_URL、PUBLISHABLE_KEY、SECRET_KEY など
export async function localStatus(): Promise<Record<string, string>> {
  return parseEnv(await supabaseCli(["status", "-o", "env"]));
}
