// App Store の審査用のアカウントを作り、デモデータを入れる（docs/testflight.md）。
// お店と本体の行も作る。本体の鍵は作らないので、この本体からは接続できない。
//
// 使い方（リポジトリの根から）:
//   deno run --allow-read --allow-run --allow-net --allow-env supabase/scripts/create_review_account.ts [--cloud]
//
// 既定ではローカルに作る。--cloud でクラウドに作る。鍵は Supabase CLI のログインから読む。
// パスワードは初めて作るときに1回だけ表示する。すでにあるアカウントのパスワードは変えず、デモデータの日付だけを更新する。

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { localStatus, required, supabaseCli } from "./local.ts";

const EMAIL = "appreview@example.com";
const SHOP_NAME = "ネイルサロン〇〇";
const CLOUD_REF = "bqdvxzvezecunnkbcyoy";

async function connection(): Promise<{ url: string; secret: string; publishable: string }> {
  if (!Deno.args.includes("--cloud")) {
    const status = await localStatus();
    return {
      url: required(status, "API_URL", "supabase status"),
      secret: required(status, "SECRET_KEY", "supabase status"),
      publishable: required(status, "PUBLISHABLE_KEY", "supabase status"),
    };
  }
  const output = await supabaseCli(["projects", "api-keys", "--reveal", "--project-ref", CLOUD_REF, "-o", "json"]);
  const keys = JSON.parse(output) as { type: string; api_key: string }[];
  const keyOf = (type: string) => {
    const key = keys.find((k) => k.type === type)?.api_key;
    if (!key) throw new Error(`${type} の鍵を読めません`);
    return key;
  };
  return { url: `https://${CLOUD_REF}.supabase.co`, secret: keyOf("secret"), publishable: keyOf("publishable") };
}

const { url, secret, publishable } = await connection();
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, secret, options);

const { data: users, error: usersError } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (usersError) throw usersError;
let user = users.users.find((u) => u.email === EMAIL);

console.log(`メール: ${EMAIL}`);
if (!user) {
  const password = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  const { data, error } = await admin.auth.admin.createUser({
    email: EMAIL,
    password,
    email_confirm: true,
    user_metadata: { full_name: "App Review" },
  });
  if (error) throw error;
  user = data.user;
  // このあとで失敗しても分かるよう、作ったらすぐ表示する
  console.log(`パスワード: ${password}`);

  // お店はアプリと同じ入口で作る
  const member = createClient(url, publishable, options);
  const { error: signInError } = await member.auth.signInWithPassword({ email: EMAIL, password });
  if (signInError) throw signInError;
  const { error: householdError } = await member.rpc("create_household", { name: SHOP_NAME });
  if (householdError) throw householdError;
}

const { data: membership, error: membershipError } = await admin.from("household_members")
  .select("household_id").eq("user_id", user.id).single();
if (membershipError) throw membershipError;

// デモデータの来客は本体に結び付くので、本体がないと入らない
const { data: device, error: deviceError } = await admin.from("devices")
  .select("id").eq("household_id", membership.household_id).limit(1).maybeSingle();
if (deviceError) throw deviceError;
if (!device) {
  const { error } = await admin.from("devices").insert({ household_id: membership.household_id, name: "デモの本体" });
  if (error) throw error;
}

const seed = await new Deno.Command("deno", {
  args: [
    "run",
    "--allow-read",
    "--allow-run",
    "--allow-net",
    "--allow-env",
    new URL("./seed_demo.ts", import.meta.url).pathname,
    EMAIL,
  ],
  env: { DEMO_SUPABASE_URL: url, DEMO_SUPABASE_SECRET_KEY: secret },
  stdout: "null",
}).spawn().status;
if (!seed.success) throw new Error("デモデータを入れられませんでした");

console.log("デモデータを入れました");
