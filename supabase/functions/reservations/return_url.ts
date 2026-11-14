// OAuth の同意のあとに戻す先（Google と Square で共通）。
// 転送先を広げるとオープンリダイレクトになるので、アプリのスキームと、許した Web のオリジンに限る。
// 戻り先に付く code は、始めた本人の JWT がないと完了できない（oauth_pending.ts）。
const APP_SCHEME = "tka2601://";
// 開発中の Web 版（expo start --web）。http を許すのはこの名前だけ
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// シークレット APP_WEB_ORIGINS（カンマ区切り、例: https://monban.vercel.app）
export function webOriginsFromEnv(): string[] {
  return (Deno.env.get("APP_WEB_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin !== "");
}

export function isAllowedReturnUrl(url: unknown, webOrigins: readonly string[] = []): url is string {
  if (typeof url !== "string" || /[\s\\]/.test(url)) return false;
  if (url.startsWith(APP_SCHEME)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname)) return true;
  return parsed.protocol === "https:" && webOrigins.includes(parsed.origin);
}
