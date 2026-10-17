# 会話履歴の裏側（Supabase）

来客の記録と会話の文字を保存し、住人のアプリへ通知するための Supabase のプロジェクト。設計は [docs/history.md](../docs/history.md) に従う。アプリ（React Native）と本体（PSoC 6）のコードは、ここには含まない。

本体は Supabase にログインしない。Edge Function「device」にデバイス鍵を付けて HTTPS で送り、Edge Function が鍵を確かめてから secret key で書き込む。住人はアプリでログインし、RLS で自分の家の記録だけを読む。

## ファイル

| パス | 内容 |
|---|---|
| `migrations/20261017061926_history_schema.sql` | 7つのテーブル、所属判定の関数（`private` スキーマ）、トリガー、権限、RLS |
| `migrations/20261017061928_visit_push_webhook.sql` | 来客の作成と終話への更新を Edge Function「push」に渡す Database Webhook |
| `migrations/20261017065239_device_api.sql` | Edge Function「device」が呼ぶ、鍵の確認と来客の書き込みの関数 |
| `functions/device/` | 本体が来客を書き込み、モードを読むための Edge Function |
| `functions/push/` | Expo の通知サービスで住人の端末に通知を送る Edge Function |
| `scripts/seed_local.ts` | ローカルのシード（家1つ、住人1人、デバイス1台とデバイス鍵）と Vault の設定 |
| `tests/database/history_access.test.sql` | 権限と本体の書き込みの試験（pgTAP） |
| `tests/e2e_local.ts` | Auth、Data API、2つの Edge Function、Webhook、Expo を通す結合試験 |
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

### 本体（PSoC 6）

- 本体はデバイス鍵で Edge Function「device」を呼ぶ。鍵は 32 バイトの乱数で、DB には SHA-256 だけを `device_keys` に保存する。`device_keys` はどのロールにも権限を与えず、`device_authenticate` 関数だけが読む。
- 本体が書くのは、チャイム検知時の来客の作成、状態の更新（通話中、終話など）、終話後にまとめて送る会話の文字と対応結果の3つ。どれも同じ PUT で送る。
- 1回の PUT は1つのトランザクションで処理し、発話を入れてから状態を変える。対応後の通知に発話の抜粋を載せるためである。
- 状態は `ringing` → `in_call` → `ended` / `missed` の順にしか進めない。遅れて届いた古い送信は来客の行を変えず、発話だけを足す。
- `devices.last_seen_at` は、本体が正しい鍵で Edge Function を呼ぶたびに更新する（モードの読み取りを含む）。
- 本体はモードを Edge Function で読むため、`devices` は Realtime の対象にしていない。

### 住人と通知

- 応答しなかったチャイム（停止モード、住人が近づいた、15 秒経過）は、`status` を `missed` にして締める。対応後の通知は送らない。
- 住人は自分の家の来客を1件ずつ消せる。1回の DELETE で2件以上を消そうとすると、トリガーが拒否する。来客を消すと発話も消える。
- 通知は来客時（来客の作成）と対応後（終話への更新）の2回送る。対応後の通知には、意図、会社名、対応に加え、訪問者の最初の発話の先頭 40 字を載せる。
- 終話済みの来客が初めて届いたとき（回線断からの回復）は、対応後の通知だけを送る。
- H5（回線断からの回復）の試験は、本体の実装と一緒に行う。

### 実装で選んだこと

- Webhook は、ダッシュボードで作る Database Webhook（`supabase_functions.http_request`）と同じ形の本文を、`pg_net` で送るトリガーとしてマイグレーションに書いた。送り先の URL と合言葉は Vault から読むため、同じマイグレーションをローカルとクラウドで使える。Vault に値がなければ通知を送らず、書き込みは止めない。
- 2つの Edge Function は `verify_jwt` を切っている。「push」は `x-webhook-secret` ヘッダーの合言葉、「device」はデバイス鍵で呼び出し元を確かめる。
- `visits` は `(device_id, household_id)` で `devices` を、`visit_messages` は `(visit_id, household_id)` で `visits` を参照する。家の食い違いを外部キーで防ぐ。
- `visits` の `id`、`household_id`、`device_id`、`created_at` は更新で変えられない。
- `push_tokens` の主キーは `(user_id, token)` とした。upsert には読み取りも要るため、住人は自分のトークンを読める。どの家にも属さないアカウントはトークンを登録できない。

## 本体が使う API

本体は次の2つを呼ぶ。どちらも `Authorization: Bearer <デバイス鍵>` を付ける。鍵がないか知らない鍵なら 401 を返す。

| 要求 | 本文 | 返事 |
|---|---|---|
| `GET /functions/v1/device/mode` | なし | `{"mode": "normal"}` |
| `PUT /functions/v1/device/visits/<来客 id>` | `chimed_at`、`mode`、`status`、`answered_at`、`ended_at`、`end_reason`、`intent`、`company`、`outcome`、`messages`（任意） | `{"id": "...", "status": "ended", "applied": true}` |

- 来客 id は本体が作る uuid。同じ id で何度送っても来客は1件になる。
- 来客を作るときは `chimed_at`、`mode`、`status` が要る。更新では `status` だけが要り、送らなかった項目は今の値が残る。
- `messages` は `[{"seq": 1, "speaker": "visitor", "text": "...", "spoken_at": "..."}]` の形。同じ `seq` は足さない。
- `applied` は、送った内容を来客に反映したかを示す。古い送信だと `false` になる。
- 値の誤りは 400、他のデバイスの来客への書き込みは 403 を返す。

```bash
curl -X PUT "$SUPABASE_URL/functions/v1/device/visits/$VISIT_ID" -H "Authorization: Bearer $DEVICE_KEY" -H "Content-Type: application/json" -d '{"chimed_at": "2026-10-17T10:00:00+09:00", "mode": "normal", "status": "ringing"}'
```

## ローカルで動かす

Supabase CLI 2.109.1 と Docker、Deno を使う。ほかのプロジェクトとぶつからないよう、ポートは 56420〜56429 にしている（API は http://127.0.0.1:56421）。リポジトリの根で次を実行する。

```bash
cp supabase/.env.example supabase/.env
```

```bash
cp supabase/functions/.env.example supabase/functions/.env
```

`supabase/.env` の住人のパスワードとデバイス鍵（`echo "dk_$(openssl rand -hex 32)"` など）、`supabase/functions/.env` の `PUSH_WEBHOOK_SECRET`（`openssl rand -hex 32` など）を埋める。Edge Function は起動時に `functions/.env` を読むため、書き換えたら `supabase stop` と `supabase start` をやり直す。

```bash
supabase start
```

```bash
deno run --allow-read --allow-run --allow-net --allow-env supabase/scripts/seed_local.ts
```

`supabase db reset` をするとアカウントと鍵も消えるため、シードを流し直す。

## 試験

| 試験 | 実行 | 内容 |
|---|---|---|
| 権限と本体の書き込み（pgTAP、65 件） | `supabase test db` | H1、H2、H3、H3b、H4、デバイス鍵の保護、状態の後戻りの防止、Webhook の送信待ち、トークン登録 |
| 結合（38 件） | `deno run --allow-read --allow-run --allow-net --allow-env supabase/tests/e2e_local.ts` | Data API での H1（anon）と H3b、device での H2 と H4、Webhook から Expo までと通知の文面、モードの変更と読み取り |
| 通知の文面（6 件） | `deno test supabase/functions/push/message_test.ts` | 通知を送る条件と文面 |

結合試験は、シードを入れたローカルで流す。Expo には実在しないトークンで送るため、Expo から `DeviceNotRegistered` の ticket が返れば正しい。マイグレーションを変えたら `supabase db advisors --local` も通す。指摘は、権限を与えない `device_keys` の「RLS はあるがポリシーがない」（INFO）だけになる。

## クラウド

| 項目 | 値 |
|---|---|
| 組織 | AttackOnRasshiine（Free プラン） |
| プロジェクト | `tka_2601`（ref `bqdvxzvezecunnkbcyoy`、リージョン `ap-northeast-1`） |
| URL | https://bqdvxzvezecunnkbcyoy.supabase.co |
| 入っているもの | マイグレーション3つ、Edge Function「device」と「push」、Edge のシークレット `PUSH_WEBHOOK_SECRET`、Vault の `push_function_url` と `push_webhook_secret` |
| 入っていないもの | シード（家、住人、デバイス、デバイス鍵）、`EXPO_ACCESS_TOKEN` |

アプリは publishable key（`sb_publishable_...`）を使う。secret key はダッシュボードの API Keys にあり、リポジトリにも本体にも入れない。Free プランのプロジェクトは、1週間使われないと一時停止する。

マイグレーションの適用と関数の配備は、`supabase link --project-ref bqdvxzvezecunnkbcyoy` のあと次で行う。

```bash
supabase db push
```

```bash
supabase functions deploy push device
```

Webhook の合言葉はクラウド専用の値で、Edge のシークレットと Vault の両方に入れてある。変えるときは、`supabase secrets set PUSH_WEBHOOK_SECRET=...` と、Vault の `push_webhook_secret` の書き換えを両方行う。

Expo のアクセストークンは https://expo.dev/settings/access-tokens で作り、`supabase/functions/.env` の `EXPO_ACCESS_TOKEN` に書いてから、その1つだけを設定する。`--env-file` でファイルごと入れると、クラウドの `PUSH_WEBHOOK_SECRET` がローカルの値で上書きされ、通知が届かなくなる。

```bash
supabase secrets set --project-ref bqdvxzvezecunnkbcyoy "EXPO_ACCESS_TOKEN=$(grep '^EXPO_ACCESS_TOKEN=' supabase/functions/.env | cut -d= -f2-)"
```

クラウドに家とデバイスを登録するときは、ダッシュボードの SQL Editor で行を入れる。デバイス鍵は手元で SHA-256 を計算し、その値だけを入れる。鍵そのものは SQL に書かず、本体にだけ書き込む。

```bash
printf '%s' "$DEVICE_KEY" | shasum -a 256
```

```sql
insert into public.device_keys (key_hash, device_id) values ('<SHA-256 の 16 進>', '<devices.id>');
```
