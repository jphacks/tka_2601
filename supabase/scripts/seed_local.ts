// ローカルの Supabase に、家1つ、住人1人、デバイス1台とそのデバイス鍵を入れる。
// あわせて、通知の Database Webhook が読む Vault の値をローカル用に設定する。
//
// 使い方（リポジトリの根から）:
//   supabase start   # または supabase db reset
//   deno run --allow-read --allow-run --allow-net --allow-env supabase/scripts/seed_local.ts
//
// 住人の資格情報とデバイス鍵は supabase/.env、Webhook の合言葉は supabase/functions/.env から読む
// （どちらもコミットしない）。DB にはデバイス鍵の SHA-256 だけを入れる。何度実行しても同じ状態になる。

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  DEVICE_ID,
  HOUSEHOLD_ID,
  localStatus,
  readEnvFile,
  required,
  sha256Hex,
  supabaseCli,
  supabaseDir,
} from "./local.ts";

// ローカルの DB コンテナから、同じ Docker ネットワークの API ゲートウェイに届く URL
const LOCAL_PUSH_FUNCTION_URL = "http://kong:8000/functions/v1/push";

const seedEnv = readEnvFile(`${supabaseDir}.env`);
const functionsEnv = readEnvFile(`${supabaseDir}functions/.env`);
const status = await localStatus();

const admin = createClient(
  required(status, "API_URL", "supabase status"),
  required(status, "SECRET_KEY", "supabase status"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// メールで探し、なければ作る。あればパスワードを .env に合わせる
async function ensureUser(email: string, password: string): Promise<string> {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const existing = data.users.find((u) => u.email === email);
  if (existing) {
    const { error: updateError } = await admin.auth.admin.updateUserById(existing.id, { password });
    if (updateError) throw updateError;
    return existing.id;
  }
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) throw createError;
  return created.user.id;
}

async function check<T>(promise: PromiseLike<{ error: unknown; data: T }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

// SQL の文字列に埋め込む値は英数字、_、-、:、/、. に限る
function sqlSafe(value: string, name: string): string {
  if (!/^[A-Za-z0-9_\-:/.]+$/.test(value)) {
    throw new Error(`${name} は英数字、_、-、:、/、. だけにしてください`);
  }
  return value;
}

const residentId = await ensureUser(
  required(seedEnv, "SEED_RESIDENT_EMAIL", "supabase/.env"),
  required(seedEnv, "SEED_RESIDENT_PASSWORD", "supabase/.env"),
);

await check(admin.from("households").upsert({ id: HOUSEHOLD_ID, name: "テストの家" }));
await check(
  admin.from("household_members").upsert({
    household_id: HOUSEHOLD_ID,
    user_id: residentId,
    role: "owner",
  }),
);
// mode は既存の値を残すため、新しく作るときだけ入れる
await check(
  admin.from("devices").upsert(
    { id: DEVICE_ID, household_id: HOUSEHOLD_ID, name: "玄関の親機", mode: "normal" },
    { ignoreDuplicates: true },
  ),
);

// device_keys と Vault はどのロールにも Data API の権限がないため、SQL で入れる
const deviceKey = required(seedEnv, "SEED_DEVICE_KEY", "supabase/.env");
if (deviceKey.length < 32) throw new Error("SEED_DEVICE_KEY は 32 文字以上にしてください");
const keyHash = await sha256Hex(deviceKey);
const webhookSecret = sqlSafe(
  required(functionsEnv, "PUSH_WEBHOOK_SECRET", "supabase/functions/.env"),
  "PUSH_WEBHOOK_SECRET",
);
await supabaseCli([
  "db",
  "query",
  "--local",
  `do $$ begin
     delete from public.device_keys where device_id = '${DEVICE_ID}';
     insert into public.device_keys (key_hash, device_id) values ('${keyHash}', '${DEVICE_ID}');
     delete from vault.secrets where name in ('push_function_url', 'push_webhook_secret');
     perform vault.create_secret('${LOCAL_PUSH_FUNCTION_URL}', 'push_function_url');
     perform vault.create_secret('${webhookSecret}', 'push_webhook_secret');
   end $$`,
]);

console.log(`household ${HOUSEHOLD_ID}`);
console.log(`resident  ${residentId}`);
console.log(`device    ${DEVICE_ID}`);
