# 会話履歴の裏側（Supabase）

来客の記録と会話の文字を保存し、住人のアプリへ通知するための Supabase のプロジェクト。設計は [docs/history.md](../docs/history.md) に従う。アプリ（React Native）と本体（PSoC 6）のコードは、ここには含まない。

本体は Supabase にログインしない。Edge Function「device」にデバイス鍵を付けて HTTPS で送り、Edge Function が鍵を確かめてから secret key で書き込む。住人はアプリでログインし、RLS で自分のグループ（`households`）の記録だけを読む。

## ファイル

| パス | 内容 |
|---|---|
| `migrations/20261017061926_history_schema.sql` | 基本のテーブル、所属判定の関数（`private` スキーマ）、トリガー、権限、RLS |
| `migrations/20261017061928_visit_push_webhook.sql` | 来客の作成と終話への更新を Edge Function「push」に渡す Database Webhook |
| `migrations/20261017065239_device_api.sql` | Edge Function「device」が呼ぶ、鍵の確認と来客の書き込みの関数 |
| `migrations/20261017070548_app_groups_and_settings.sql` | アプリのための追加（知人、グループと招待、メンバーの名前、設定、本体のペアリング） |
| `migrations/20261017071512_review_fixes.sql` | 同じ来客の同時の書き込みを1つずつ処理する。入口の関数の権限をそろえる |
| `migrations/20261017072020_push_retry.sql` | 通知の送信待ちと、pg_cron による再送 |
| `functions/device/` | 本体が来客を書き込み、設定を読むための Edge Function |
| `functions/push/` | Expo の通知サービスで住人の端末に通知を送る Edge Function |
| `scripts/seed_local.ts` | ローカルのシード（グループ1つ、住人1人、本体1台とデバイス鍵）と Vault の設定 |
| `tests/database/*.test.sql` | 権限、本体の書き込み、グループ、通知の送信待ちの試験（pgTAP） |
| `tests/e2e_local.ts` | Auth、Data API、2つの Edge Function、Webhook、pg_cron の再送、Expo を通す結合試験 |
| `.env.example`、`functions/.env.example` | 資格情報とシークレットのひな形。値を入れた `.env` はコミットしない |

## 設計書に加えて決めたこと

実装にあたり 2026 年 10 月 17 日に決めた。history.md にはまだ反映していない。

### 列の値

| 列 | 値 |
|---|---|
| `devices.mode`、`visits.mode` | `normal`（通常）、`omakase`（おまかせ）、`away`（外出）、`off`（停止） |
| `visits.status` | `ringing`（呼び出し中）、`in_call`（通話中）、`ended`（終話）、`missed`（応答しなかった） |
| `visits.intent` | `delivery`、`sales`、`service`、`emergency`、`acquaintance`（知人）、`unknown` |
| `visits.outcome` | `leave_at_door`（置き配）、`delivery_slip`（不在票）、`declined`（断った）、`callback`（改めて連絡するよう依頼）、`escalated`（家の者に連絡すると伝えた）、`none`（なし） |
| `visits.end_reason` | 終話: `closing`（「失礼いたします」）、`silence`（無音 8 秒）、`time_limit`（上限時間）、`fallback`（サーバーに届かず定型音声）、`safe`（異常）。応答しなかった来客: `mode_off`（停止モード）、`resident`（住人が近づいた）、`no_answer`（15 秒経過） |
| `visit_messages.speaker` | `visitor`（訪問者）、`ai`（AI）、`canned`（定型音声） |
| `household_members.role` | `owner`（グループを作った人）、`member`（招待で入った人）。権限はどちらも同じ |
| `push_tokens.platform` | `ios`、`android` |

どの列も check 制約で値を固定している。値を足すときはマイグレーションを足す。

### 本体（PSoC 6）

- 本体はデバイス鍵で Edge Function「device」を呼ぶ。鍵は 32 バイトの乱数で、DB には SHA-256 だけを `device_keys` に保存する。`device_keys` はどのロールにも権限を与えず、`device_authenticate` 関数だけが読む。
- 本体が書くのは、チャイム検知時の来客の作成、状態の更新（通話中、終話など）、終話後にまとめて送る会話の文字と対応結果の3つ。どれも同じ PUT で送る。
- 1回の PUT は1つのトランザクションで処理し、発話を入れてから状態を変える。対応後の通知に発話の抜粋を載せるためである。同じ来客の PUT が重なっても、来客 id ごとのロックで1つずつ処理する。
- 状態は `ringing` → `in_call` → `ended` / `missed` の順にしか進めない。遅れて届いた古い送信は来客の行を変えず、発話だけを足す。
- `devices.last_seen_at` は、本体が正しい鍵で Edge Function を呼ぶたびに更新する（設定の読み取りを含む）。
- 本体は設定を Edge Function で読むため、`devices` は Realtime の対象にしていない。
- 管理者が本体を登録するとペアリングコードができる。住人がアプリでコードを入れると、本体がそのグループに結び付く。結び付く前の本体は来客を書けない。
- 「だれもいないとき外出にする」で本体が自動的に外出にしたときは、本体が `devices.auto_away_active` を書く。`devices.mode` は住人が選んだまま残る。

### 住人とグループ

- グループはアプリから作り、招待で入る。1人が入れるグループは1つだけで、`household_members.user_id` を一意にして DB でも守る。
- 招待トークンはグループごとに1つで、有効期限はなく、同じトークンを何度でも使える。作り直しとグループからの脱退は作っていない。
- メンバーの権限は全員同じで、モードと設定はだれでも変えられる。
- メンバーの名前は `auth.users` の `raw_user_meta_data` の `full_name`、なければ `name`（Apple や Google）を使う。表示に使うだけで、権限の判定には使わない。
- 設定（外出時に置き配を頼む、だれもいないとき外出にする、AI への追加の指示）は `devices` に持ち、グループで共有する。追加の指示の上限の字数は、house_rules の基本の規則の字数が決まってから足す。
- 応答しなかったチャイム（停止モード、住人が近づいた、15 秒経過）は、`status` を `missed` にして締める。
- 住人は自分のグループの来客を1件ずつ消せる。1回の DELETE で2件以上を消そうとすると、トリガーが拒否する。来客を消すと発話も消える。

### 通知

- 来客時（来客の作成）と対応後（終話への更新）の2回送る。`missed` には対応後の通知を送らない。どちらも Expo の優先度を `high` にする。
- 対応後の通知には、意図、会社名、対応に加え、訪問者の最初の発話の先頭 40 字を載せる。
- 終話済みの来客が初めて届いたとき（回線断からの回復）は、対応後の通知だけを送る。
- 通知は端末ごとに `push_deliveries` へ送信待ちとして入れてから送る。Expo の一時的な失敗（ネットワーク、429、5xx）は関数の中で間を空けて3回まで試し、それでも届かなければ送信待ちに残す。pg_cron が1分ごとに送り直す。受け付けられた端末には二度と送らない。通知を作ってから 10 分たつと送り直しをやめる。
- H5（回線断からの回復）の試験は、本体の実装と一緒に行う。

### 実装で選んだこと

- Webhook は、ダッシュボードで作る Database Webhook（`supabase_functions.http_request`）と同じ形の本文を、`pg_net` で送るトリガーとしてマイグレーションに書いた。送り先の URL と合言葉は Vault から読むため、同じマイグレーションをローカルとクラウドで使える。Vault に値がなければ通知を送らず、書き込みは止めない。
- 2つの Edge Function は `verify_jwt` を切っている。「push」は `x-webhook-secret` ヘッダーの合言葉、「device」はデバイス鍵で呼び出し元を確かめる。
- 住人が呼ぶ関数は、public に security invoker の入口を置き、中身は Data API に公開しない `private` の security definer 関数にした。
- `visits` は `(device_id, household_id)` で `devices` を、`visit_messages` は `(visit_id, household_id)` で `visits` を参照する。家の食い違いを外部キーで防ぐ。
- `visits` の `id`、`household_id`、`device_id`、`created_at` は更新で変えられない。
- `push_tokens` の主キーは `(user_id, token)` とした。upsert には読み取りも要るため、住人は自分のトークンを読める。どのグループにも属さないアカウントはトークンを登録できない。
- エラーは、Data API が HTTP の番号と JSON の理由をそのまま返す SQLSTATE にした（`PT403`、`PT404`、`PT409` は PostgREST の独自コード）。`P0002` などは 500 になり、理由も隠れるためである。

## アプリが使う関数

アプリは supabase-js の `rpc` で呼ぶ。どれもログインした住人だけが呼べる。

| 関数 | 返すもの | エラー |
|---|---|---|
| `create_household(name)` | グループの id | 名前が空なら `22023`（400）、すでにグループに入っていれば `23505`（409） |
| `get_or_create_household_invite()` | 招待トークン（48 桁の 16 進） | グループに入っていなければ `PT403` |
| `get_household_invite(token)` | `household_name`、`inviter_name` | トークンが違えば `PT404` |
| `accept_household_invite(token)` | グループの id | トークンが違えば `PT404`、すでにグループに入っていれば `23505` |
| `household_member_profiles()` | `user_id`、`full_name`、`email`、`role`、`joined_at`（入った順） | グループに入っていなければ `PT403` |
| `claim_device(code)` | 本体の id | グループに入っていなければ `PT403`、コードが違えば `PT404` |

ペアリングコードの小文字、空白、ハイフンは無視する。ほかに、`visits` と `visit_messages` の読み取り、`visits` の1件ずつの削除、`devices` の `mode`、`away_leave_at_door`、`auto_away`、`extra_instructions` の更新、`push_tokens` の登録・更新・削除を Data API で直接行える。通知の `data` には `visit_id` と `kind`（`chime` か `ended`）が入る。

## 本体が使う API

本体は次の3つを呼ぶ。どれも `Authorization: Bearer <デバイス鍵>` を付ける。鍵がないか知らない鍵なら 401 を返す。

| 要求 | 本文 | 返事 |
|---|---|---|
| `GET /functions/v1/device/settings`（`/mode` も同じ） | なし | `{"paired": true, "mode": "normal", "away_leave_at_door": false, "auto_away": false, "extra_instructions": ""}` |
| `PUT /functions/v1/device/state` | `{"auto_away_active": true}` | `{"auto_away_active": true}` |
| `PUT /functions/v1/device/visits/<来客 id>` | `chimed_at`、`mode`、`status`、`answered_at`、`ended_at`、`end_reason`、`intent`、`company`、`outcome`、`messages`（任意） | `{"id": "...", "status": "ended", "applied": true}` |

- `paired` が `false` の本体は、まだグループに結び付いていない。この間の PUT は 409 を返す。
- 来客 id は本体が作る uuid。同じ id で何度送っても、同時に送っても、来客は1件になる。
- 来客を作るときは `chimed_at`、`mode`、`status` が要る。更新では `status` だけが要り、送らなかった項目は今の値が残る。
- `messages` は `[{"seq": 1, "speaker": "visitor", "text": "...", "spoken_at": "..."}]` の形。同じ `seq` は足さない。
- `applied` は、送った内容を来客に反映したかを示す。古い送信だと `false` になる。
- 値の誤りは 400、他の本体の来客への書き込みは 403 を返す。

会話サーバーの中継（labpc）は、会話の始めに PSoC から受け取ったデバイス鍵で `GET /functions/v1/device/settings` を一度呼び、`extra_instructions` と `away_leave_at_door` を会話エージェントに渡す。中継には secret key を置かない。`extra_instructions` には字数の制約がまだないため、house_rules 全体が 800 字を超えないよう中継が切る。

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

シードの本体は、グループに結び付けた状態で入る。`supabase db reset` をするとアカウントと鍵も消えるため、シードを流し直す。

## 試験

| 試験 | 実行 | 内容 |
|---|---|---|
| pgTAP（126 件） | `supabase test db` | H1、H2、H3、H3b、H4、デバイス鍵の保護、状態の後戻りの防止、Webhook の送信待ち、グループと招待、メンバーの名前、設定、ペアリング、通知の送信待ちと再送 |
| 結合（65 件） | `deno run --allow-read --allow-run --allow-net --allow-env supabase/tests/e2e_local.ts` | Data API での H1 と H3b、device での H2 と H4（同時の作成を含む）、グループの作成から招待での参加まで、ペアリング、設定、Webhook から Expo までと通知の文面、pg_cron の再送 |
| Edge Function（14 件） | `deno test supabase/functions/push/` | 通知を送る条件と文面、優先度、Expo の一時的な失敗の試し直し |

結合試験は、シードを入れたローカルで流す。Expo には実在しないトークンで送るため、Expo から `DeviceNotRegistered` の ticket が返れば正しい。マイグレーションを変えたら `supabase db advisors --local` も通す。指摘は、権限を与えない4つの表（`device_keys`、`device_pairing_codes`、`household_invites`、`push_deliveries`）の「RLS はあるがポリシーがない」（INFO）だけになる。

## クラウド

| 項目 | 値 |
|---|---|
| 組織 | AttackOnRasshiine（Free プラン） |
| プロジェクト | `tka_2601`（ref `bqdvxzvezecunnkbcyoy`、リージョン `ap-northeast-1`） |
| URL | https://bqdvxzvezecunnkbcyoy.supabase.co |
| 入っているもの | マイグレーション6つ、pg_cron の `push-retry`、Edge Function「device」と「push」、Edge のシークレット `PUSH_WEBHOOK_SECRET`、Vault の `push_function_url` と `push_webhook_secret` |
| 入っていないもの | シード（グループ、住人、本体、デバイス鍵）、`EXPO_ACCESS_TOKEN` |

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

本体を登録するときは、手元でデバイス鍵を作って SHA-256 を計算し、ダッシュボードの SQL Editor で `private.register_device` を呼ぶ。鍵そのものは SQL に書かず、本体にだけ書き込む。返ってきたペアリングコードを住人に伝え、アプリで入れてもらう。

```bash
printf '%s' "$DEVICE_KEY" | shasum -a 256
```

```sql
select * from private.register_device('玄関の親機', '<SHA-256 の 16 進>');
```
