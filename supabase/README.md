# 会話履歴の裏側（Supabase）

来客の記録と会話の文字を保存し、住人のアプリへ通知するための Supabase のプロジェクト。設計は [docs/history.md](../docs/history.md) に従う。アプリ（React Native）と本体（音声ブリッジ）の書き込みのコードは、ここには含まない。

## ファイル

| パス | 内容 |
|---|---|
| `migrations/20261017061926_history_schema.sql` | 6つのテーブル、所属判定の関数（`private` スキーマ）、トリガー、権限、RLS、Realtime |
| `migrations/20261017061928_visit_push_webhook.sql` | 来客の作成と終話への更新を Edge Function に渡す Database Webhook |
| `functions/push/` | Expo の通知サービスで住人の端末に通知を送る Edge Function |
| `scripts/seed_local.ts` | ローカルのシード（家1つ、住人1人、デバイス1台とデバイス用アカウント）と Vault の設定 |
| `tests/database/history_access.test.sql` | 権限の試験（pgTAP） |
| `tests/e2e_local.ts` | Auth、Data API、Realtime、Webhook、Edge Function を通す結合試験 |
| `.env.example`、`functions/.env.example` | 資格情報とシークレットのひな形。値を入れた `.env` はコミットしない |

## 設計書に加えて決めたこと

実装にあたり 2026 年 10 月 17 日に決めた。history.md にはまだ反映していない。

### 列の値

| 列 | 値 |
|---|---|
| `devices.mode`、`visits.mode` | `normal`（通常）、`omakase`（おまかせ）、`away`（外出）、`off`（停止） |
| `visits.status` | `ringing`（呼び出し中）、`in_call`（通話中）、`ended`（終話）、`missed`（応答しなかった） |
| `visits.intent` | `delivery`、`sales`、`service`、`emergency`、`unknown`（spec.md 6.4） |
| `visits.outcome` | `leave_at_door`（置き配）、`delivery_slip`（不在票）、`declined`（断った）、`callback`（改めて連絡するよう依頼）、`escalated`（家の者に連絡すると伝えた）、`none`（なし） |
| `visits.end_reason` | 終話: `closing`（「失礼いたします」）、`silence`（無音 8 秒）、`time_limit`（上限時間）、`fallback`（サーバーに届かず定型音声）、`safe`（異常）。応答しなかった来客: `mode_off`（停止モード）、`resident`（住人が近づいた）、`no_answer`（15 秒経過） |
| `visit_messages.speaker` | `visitor`（訪問者）、`ai`（AI）、`canned`（定型音声） |
| `household_members.role` | `owner`、`member` |
| `push_tokens.platform` | `ios`、`android` |

どの列も check 制約で値を固定している。値を足すときはマイグレーションを足す。

### 振る舞い

- 応答しなかったチャイム（停止モード、住人が近づいた、15 秒経過）は、`status` を `missed` にして締める。対応後の通知は送らない。
- 住人は自分の家の来客を1件ずつ消せる。1回の DELETE で2件以上を消そうとすると、トリガーが拒否する。来客を消すと発話も消える。
- 本体は、自分のデバイスの来客の発話を読める（history.md 7.1 からの変更）。送り直しに使う `ON CONFLICT (visit_id, seq) DO NOTHING` は読み取りの権限を求め、新しい行に読み取りのポリシーもかかるためである。
- `devices.last_seen_at` は、本体が `visits` か `visit_messages` を書くたびにトリガーが更新する。本体に `devices` の更新は許していない。
- 対応後の通知には、意図、会社名、対応に加え、訪問者の最初の発話の先頭 40 字を載せる。
- H5（回線断からの回復）は、本体の実装と一緒に試す。

### 実装で選んだこと

- Webhook は、ダッシュボードで作る Database Webhook（`supabase_functions.http_request`）と同じ形の本文を、`pg_net` で送るトリガーとしてマイグレーションに書いた。送り先の URL と合言葉は Vault から読むため、同じマイグレーションをローカルとクラウドで使える。Vault に値がなければ通知を送らず、本体の書き込みは止めない。
- Edge Function は `verify_jwt` を切り、`x-webhook-secret` ヘッダーの合言葉で Webhook からの呼び出しかを確かめる。secret key を DB に置かないためである。
- `visits` は `(device_id, household_id)` で `devices` を、`visit_messages` は `(visit_id, household_id)` で `visits` を参照する。家の食い違いを外部キーで防ぐ。
- `visits` の `id`、`household_id`、`device_id`、`created_at` は更新で変えられない。同じ値での上書き（upsert の送り直し）は通る。
- `push_tokens` の主キーは `(user_id, token)` とした。upsert には読み取りも要るため、住人は自分のトークンを読める。デバイス用アカウントはトークンを登録できない。
- デバイス用アカウントを消すとデバイスの行が参照するため、先にデバイスを外す（`devices.auth_user_id` は削除を拒む外部キー）。

## 本体が書き込むときの形

本体はデバイス用アカウントで `signInWithPassword` し、publishable key で Data API を呼ぶ。secret key は本体に置かない。

| 書き込み | 形 |
|---|---|
| 来客の作成と更新 | `visits` に upsert（merge-duplicates）。`id` は本体が作る uuid |
| 発話の追加 | `visit_messages` に upsert（`ignoreDuplicates: true`）。まとめて送ってよい |
| モードの受け取り | Realtime の `postgres_changes` で `devices` の自分の行の UPDATE を購読する。`system` の「Subscribed to PostgreSQL」が届いてから変更を受け取れる |

```ts
await supabase.from("visits").upsert(visit);
await supabase.from("visit_messages").upsert(messages, { ignoreDuplicates: true });
```

## ローカルで動かす

Supabase CLI 2.109.1 と Docker、Deno を使う。ほかのプロジェクトとぶつからないよう、ポートは 56420〜56429 にしている（API は http://127.0.0.1:56421）。リポジトリの根で次を実行する。

```bash
cp supabase/.env.example supabase/.env
```

```bash
cp supabase/functions/.env.example supabase/functions/.env
```

`supabase/.env` の2つのパスワードと、`supabase/functions/.env` の `PUSH_WEBHOOK_SECRET`（`openssl rand -hex 32` など）を埋める。Edge Function は起動時に `functions/.env` を読むため、書き換えたら `supabase stop` と `supabase start` をやり直す。

```bash
supabase start
```

```bash
deno run --allow-read --allow-run --allow-net --allow-env supabase/scripts/seed_local.ts
```

`supabase db reset` をするとアカウントも消えるため、シードを流し直す。

## 試験

| 試験 | 実行 | 内容 |
|---|---|---|
| 権限（pgTAP、54 件） | `supabase test db` | H1、H2、H3、H3b、H4 と、モード変更、トークン登録、`last_seen_at` |
| 結合（22 件） | `deno run --allow-read --allow-run --allow-net --allow-env supabase/tests/e2e_local.ts` | Data API での H1（anon）、H4、H3b、Webhook から Expo まで、Realtime でのモードの受け取り |
| 通知の文面（5 件） | `deno test supabase/functions/push/message_test.ts` | 通知を送る条件と文面 |

結合試験は、シードを入れたローカルで流す。Expo には実在しないトークンで送るため、Expo から `DeviceNotRegistered` の ticket が返れば正しい。マイグレーションを変えたら `supabase db advisors --local` も通す。

## クラウド

| 項目 | 値 |
|---|---|
| 組織 | AttackOnRasshiine（Free プラン） |
| プロジェクト | `tka_2601`（ref `bqdvxzvezecunnkbcyoy`、リージョン `ap-northeast-1`） |
| URL | https://bqdvxzvezecunnkbcyoy.supabase.co |
| 入っているもの | マイグレーション2つ、Edge Function `push`、Edge のシークレット `PUSH_WEBHOOK_SECRET`、Vault の `push_function_url` と `push_webhook_secret` |
| 入っていないもの | シード（家、住人、デバイス） |

アプリと本体は publishable key（`sb_publishable_...`）を使う。secret key はダッシュボードの API Keys にあり、リポジトリには入れない。Free プランのプロジェクトは、1週間使われないと一時停止する。

マイグレーションの適用と関数の配備は、`supabase link --project-ref bqdvxzvezecunnkbcyoy` のあと次で行う。

```bash
supabase db push
```

```bash
supabase functions deploy push
```

Webhook の合言葉はクラウド専用の値で、Edge のシークレットと Vault の両方に入れてある。変えるときは、`supabase secrets set PUSH_WEBHOOK_SECRET=...` と、Vault の `push_webhook_secret` の書き換えを両方行う。
