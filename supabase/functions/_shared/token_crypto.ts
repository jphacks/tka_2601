// Google の更新トークンを AES-GCM で暗号化する。鍵は 32 バイトの base64（openssl rand -base64 32）
const VERSION = "v1";

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = fromBase64(keyBase64);
  if (raw.length !== 32) throw new Error("CALENDAR_TOKEN_KEY は 32 バイトの base64 にしてください");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(plain: string, keyBase64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await importKey(keyBase64),
    new TextEncoder().encode(plain),
  );
  return [VERSION, toBase64(iv), toBase64(new Uint8Array(data))].join(".");
}

export async function decryptToken(encrypted: string, keyBase64: string): Promise<string> {
  const [version, iv, data] = encrypted.split(".");
  if (version !== VERSION || !iv || !data) throw new Error("暗号文の形が違います");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    await importKey(keyBase64),
    fromBase64(data),
  );
  return new TextDecoder().decode(plain);
}
