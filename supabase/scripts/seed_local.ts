// ローカルの Supabase に、家1つ、住人1人、デバイス1台とデバイス用アカウントを入れる。
// あわせて、通知の Database Webhook が読む Vault の値をローカル用に設定する。
//
// 使い方（リポジトリの根から）:
//   supabase start   # または supabase db reset
//   deno run --allow-read --allow-run --allow-net --allow-env supabase/scripts/seed_local.ts
//
// 資格情報は supabase/.env、Webhook の合言葉は supabase/functions/.env から読む（どちらもコミットしない）。
// 何度実行しても同じ状態になる。

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  DEVICE_ID,
  HOUSEHOLD_ID,
  localStatus,
  readEnvFile,
  required,
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

const residentId = await ensureUser(
  required(seedEnv, "SEED_RESIDENT_EMAIL", "supabase/.env"),
  required(seedEnv, "SEED_RESIDENT_PASSWORD", "supabase/.env"),
);
const deviceUserId = await ensureUser(
  required(seedEnv, "SEED_DEVICE_EMAIL", "supabase/.env"),
  required(seedEnv, "SEED_DEVICE_PASSWORD", "supabase/.env"),
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
    {
      id: DEVICE_ID,
      household_id: HOUSEHOLD_ID,
      auth_user_id: deviceUserId,
      name: "玄関の親機",
      mode: "normal",
    },
    { ignoreDuplicates: true },
  ),
);

// Webhook の送り先と合言葉を Vault に入れる
const webhookSecret = required(functionsEnv, "PUSH_WEBHOOK_SECRET", "supabase/functions/.env");
if (!/^[A-Za-z0-9_-]+$/.test(webhookSecret)) {
  throw new Error("PUSH_WEBHOOK_SECRET は英数字、_、- だけにしてください");
}
await supabaseCli([
  "db",
  "query",
  "--local",
  `do $$ begin
     delete from vault.secrets where name in ('push_function_url', 'push_webhook_secret');
     perform vault.create_secret('${LOCAL_PUSH_FUNCTION_URL}', 'push_function_url');
     perform vault.create_secret('${webhookSecret}', 'push_webhook_secret');
   end $$`,
]);

console.log(`household ${HOUSEHOLD_ID}`);
console.log(`resident  ${residentId}`);
console.log(`device    ${DEVICE_ID} (auth user ${deviceUserId})`);
