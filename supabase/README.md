# 会話履歴の裏側（Supabase）

来客の記録と会話の文字を保存し、店の予約を読み書きして、アプリへ通知するための Supabase のプロジェクト。設計は [docs/history.md](../docs/history.md) と [docs/reservations.md](../docs/reservations.md) に従う。アプリ（React Native）と本体（PSoC 6）のコードは、ここには含まない。

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
| `migrations/20261017073719_extra_instructions_limit.sql` | AI への追加の指示を 350 字までにする |
| `migrations/20261102000000_shop_reservations.sql` | 店舗の設定とメニュー、予約帳、Google カレンダーの接続、通知の種類と記録、本体の死活通信、pg_cron の追加 |
| `functions/device/` | 本体と中継が来客と予約を書き、設定を読むための Edge Function |
| `functions/push/` | 来客の通知を作って端末に送り、送信待ちを再送する Edge Function |
| `functions/reservations/` | アプリが予約と予約先を読み書きし、Google カレンダーと Square に接続する Edge Function。Square の Webhook も受ける |
| `functions/calendar-sync/` | pg_cron が1分ごとに呼び、Google カレンダーの差分を読んで通知する Edge Function |
| `functions/assistant/` | 自然言語の入力を変更の案にする Edge Function。書き込みはしない |
| `functions/device/contract.ts` | 本体と中継（ボイスエージェント）に渡す形。仕様が変わったらここを直す |
| `functions/_shared/assistant/` | 解析器の入口（`IntentParser`）、Ollama の実装、解析結果を案に変換する処理 |
| `functions/_shared/` | 予約先の共通の入口と実装（予約帳、Google カレンダー、Square）、通知の配信、Expo への送信、更新トークンの暗号化 |
| `scripts/seed_local.ts` | ローカルのシード（グループ1つ、住人1人、本体1台とデバイス鍵）と Vault の設定 |
| `tests/database/*.test.sql` | 権限、本体の書き込み、グループ、通知の送信待ち、店舗の設定と通知の種類の試験（pgTAP） |
| `tests/e2e_local.ts` | Auth、Data API、Edge Function、Webhook、pg_cron の再送、Expo、予約を通す結合試験 |
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
- 設定（外出時に置き配を頼む、だれもいないとき外出にする、AI への追加の指示）は `devices` に持ち、グループで共有する。追加の指示は 350 字までにした。house_rules は全体で 800 字以内で、基本の規則が最も長いモード（外出・置き配あり）では、追加の指示に使えるのが 350 字になるためである。
- 応答しなかったチャイム（停止モード、住人が近づいた、15 秒経過）は、`status` を `missed` にして締める。
- 住人は自分のグループの来客を1件ずつ消せる。1回の DELETE で2件以上を消そうとすると、トリガーが拒否する。来客を消すと発話も消える。

### 通知

- 通知の種類は `notification_kinds` の行で決まる（[docs/reservations.md 4章](../docs/reservations.md#4-通知)）。種類を足すときは、マイグレーションで1行足し、Edge Function で文面を作る。
- 通知はすべて `notifications` に残る。同じ出来事は `(household_id, dedupe_key)` で1回だけ作る。来客を消すと、その来客の通知も消える。
- 操作した本人（`actor_user_id`）と、その種類をオフにした人（`notification_preferences`）には送らない。
- 来客時（来客の作成）と対応後（終話への更新）の2回送る。`missed` には対応後の通知を送らない。Expo の優先度はどの種類も `high` にする。
- 対応後の通知には、意図、会社名、対応に加え、訪問者の最初の発話の先頭 40 字を載せる。
- 終話済みの来客が初めて届いたとき（回線断からの回復）は、対応後の通知だけを送る。
- 通知は端末ごとに `push_deliveries` へ送信待ちとして入れてから送る。文面は `notifications` にあり、送り直しでも作り直さない。Expo の一時的な失敗（ネットワーク、429、5xx）は関数の中で間を空けて3回まで試し、それでも届かなければ送信待ちに残す。pg_cron が1分ごとに送り直す。受け付けられた端末には二度と送らない。通知を作ってから 10 分たつと送り直しをやめる。
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

ペアリングコードの小文字、空白、ハイフンは無視する。ほかに、次を Data API で直接行える。

- `visits` と `visit_messages` の読み取り、`visits` の1件ずつの削除
- `devices` の `mode`、`away_leave_at_door`、`auto_away`、`extra_instructions` の更新。`extra_instructions` が 350 字を超えると `23514`（400）になる
- `push_tokens` の登録・更新・削除
- `households.name`（店名）の更新
- `shop_profiles` の読み取りと、予約先（`reservation_provider`）以外の更新
- `shop_services` の読み書き
- `notification_kinds` と `notifications` の読み取り
- 自分の `notification_preferences` と `notification_read_states` の読み書き

通知の `data` には、`kind` と `notification_id` に加えて、来客の通知なら `visit_id`、予約の通知なら `reservation_id` が入る。

## アプリが使う Edge Function「reservations」

`Authorization: Bearer <ログインの JWT>` を付けて呼ぶ。ログインしていなければ 401、グループに入っていなければ 403 を返す。予約はどの予約先でも同じ形（[docs/reservations.md 3.1](../docs/reservations.md#31-アプリが使う-edge-functionreservations)）で返す。

| 要求 | 本文または引数 | 返事 |
|---|---|---|
| `GET /reservations?from=&to=` | ISO 8601 の期間。`status` で絞り込める。付けなければキャンセルを除く | `{"provider": "monban", "reservations": [...]}` |
| `POST /reservations` | `customer_name`、`starts_at`、`ends_at` は必須。`customer_phone`、`service_name`、`note` | 201 `{"reservation": {...}}`。確定で作る |
| `GET /reservations/<id>` | なし | `{"reservation": {...}}`。なければ 404 |
| `PATCH /reservations/<id>` | 上の項目の一部。`null` で消せる | `{"reservation": {...}}` |
| `POST /reservations/<id>/approve` | なし | `{"reservation": {...}}`。仮予約でなければ 409 |
| `POST /reservations/<id>/cancel` | なし | `{"reservation": {...}}` |
| `POST /reservations/<id>/arrive` | なし | `{"reservation": {...}}`。2回目は時刻を変えない |
| `GET /reservations/provider` | なし | `{"provider": "...", "capabilities": {"create"}, "google": {"connected", "account_email", "calendar_id", "calendar_name", "status", "last_error"}, "square": {"connected", "merchant_name", "status", "last_error"}}` |
| `PUT /reservations/provider` | `{"provider": "monban" \| "google_calendar" \| "square" \| "hotpepper"}` | 同上。Google は接続とカレンダーの選択が済むまで 409（`google_not_connected`）、Square は接続が済むまで 409（`square_not_connected`） |
| `POST /reservations/google/start` | `{"return_url": "tka2601://..."}` | `{"url": "..."}`。設定がなければ 503（`google_not_configured`） |
| `GET /reservations/google/callback` | Google が呼ぶ | トークンを暗号化して保留にし、`return_url?google=pending&code=...`（`cancelled`、`error`）へ転送する |
| `POST /reservations/google/complete` | `{"code": "..."}` | 始めた本人なら接続を確定し、`provider` の GET と同じ形を返す。他人は 403（`oauth_user_mismatch`）、期限切れや不明は 404（`oauth_code_invalid`） |
| `GET /reservations/google/calendars` | なし | `{"calendars": [{"id", "name", "primary"}]}`。書き込めるものだけ |
| `PUT /reservations/google/calendar` | `{"calendar_id": "..."}` | `GET /reservations/provider` と同じ。予約先は変えない |
| `DELETE /reservations/google` | なし | 同上。接続を消し、予約先を予約帳に戻す |
| `POST /reservations/square/start` | `{"return_url": "tka2601://..."}` | `{"url": "<Square の同意画面>"}`。設定がなければ 503（`square_not_configured`） |
| `GET /reservations/square/callback` | Square が呼ぶ | トークンを暗号化して保留にし、`return_url?square=pending&code=...`（`cancelled`、`error`）へ転送する |
| `POST /reservations/square/complete` | `{"code": "..."}` | Google と同じ。別の店で使われているアカウントは 409（`square_merchant_in_use`） |
| `DELETE /reservations/square` | なし | `GET /reservations/provider` と同じ。接続を消し、予約先が Square なら予約帳に戻す |
| `POST /reservations/square/webhook` | Square が呼ぶ。署名が違えば 403 | 予約の変化を通知する |

失敗は `{"error": "理由", "code": "..."}` で返す。`code` はアプリが分岐に使うものだけに付ける。Google に届かないときは 502 で `google_unavailable`、接続し直しが要るときは 502 で `google_reauth_required` を返す。

Google カレンダーに接続する手順は、`google/start` の URL を開き、`google=pending&code=...` で戻ってきたら `google/complete` に `code` を送り、`google/calendars` から選んで `google/calendar` に送り、`provider` を `google_calendar` にする。Square は `square/start` の URL を開き、`square=pending&code=...` で戻ってきたら `square/complete` に `code` を送り、`provider` を `square` にする。コールバックには JWT がなく同意した人が分からないので、完了で始めた本人かを確かめてから接続にする。

Square の予約は読み取りだけで、`read_only` が `true` になる。変更、承認、キャンセルと、アプリからの追加は 409（`provider_read_only`）を返す。到着の記録だけはできる。ログインが無効になると 502（`square_reauth_required`）、一時的な失敗は 502（`square_unavailable`）を返す。

## アプリが使う Edge Function「assistant」

自然言語の入力を変更の案にする（[docs/reservations.md](../docs/reservations.md) 8章）。ログインの JWT を付けて呼ぶ。**書き込みはしない。** アプリは確認カードで承認されてから、`POST /reservations`、`PATCH /reservations/<id>`、`shop_profiles.business_hours` の更新で書き込む。文には顧客名が入るので、DB にもログにも残さない。

```
POST /functions/v1/assistant/parse
{"text": "木曜の14時に田中さん、ジェルネイルで"}   （200 字まで）
→ {"proposal": {"type": "add_reservation", ...}}
```

| `type` | 項目（どれにも `warnings: string[]` がある） |
|---|---|
| `add_reservation` | `customer_name`、`customer_phone`、`service_name`、`starts_at`、`ends_at`、`note` |
| `update_reservation` | `reservation_id`、`customer_name`、`service_name`、`before`・`after`（`starts_at`、`ends_at`） |
| `set_business_hours` | `day`（日曜が 0）、`before`・`after`（`closed`、`open`、`close`。`open` と `close` は未設定なら null） |
| `unknown` | `reason`（画面に出せる文） |

解析器に届かないとき、設定がないときは 503（`assistant_unavailable`）を返す。アプリは入力フォームへ案内する。

### 解析器

| シークレット | 内容 |
|---|---|
| `ASSISTANT_LLM_BASE_URL` | Ollama の URL。なければ 503 |
| `ASSISTANT_LLM_MODEL` | モデル名。既定は `gemma4:latest` |
| `ASSISTANT_LLM_API_KEY` | 接続先が認証を求めるときの Bearer トークン（任意） |
| `ASSISTANT_LLM_TIMEOUT_MS` | 待つ時間。既定は 20000 |

- 解析器を替えるときは `functions/_shared/assistant/intent_parser.ts` の `IntentParser` を実装し、`factory.ts` に分岐を足す。
- ローカルでは Mac の Ollama に向けられる。`supabase/functions/.env` に `ASSISTANT_LLM_BASE_URL=http://host.docker.internal:11434` と入手済みのモデル名を書き、`supabase stop` と `supabase start` をやり直す。
- **本番の経路は未解決である。** labpc の Ollama は `127.0.0.1` で動いており、クラウドの Edge Function から届かない。HTTPS の逆プロキシと認証を置くか、会話サーバーの API に解析の入口を足すかを、会話サーバーの仕様と一緒に決める。後者なら `IntentParser` の実装を足すだけで済む。
- LLM の読み取りは信用しない。`resolve.ts` が型と範囲を確かめ、文とも突き合わせる。文に書かれた曜日や「明日」と日付が合わなければ案を出さない。文に長さが書かれていなければ LLM の所要時間を使わない。LLM が落としたメニュー名と時刻は文から拾う。

## 本体が使う API

本体と中継は次を呼ぶ。どれも `Authorization: Bearer <デバイス鍵>` を付ける。鍵がないか知らない鍵なら 401 を返す。

| 要求 | 本文 | 返事 |
|---|---|---|
| `GET /functions/v1/device/settings`（`/mode` も同じ） | なし | `{"contract_version": 1, "paired": true, "mode": "normal", "away_leave_at_door": false, "auto_away": false, "extra_instructions": "", "shop": {...}}` |
| `PUT /functions/v1/device/state` | `{"auto_away_active": true}` | `{"auto_away_active": true}` |
| `PUT /functions/v1/device/visits/<来客 id>` | `chimed_at`、`mode`、`status`、`answered_at`、`ended_at`、`end_reason`、`intent`、`company`、`outcome`、`messages`（任意） | `{"id": "...", "status": "ended", "applied": true}` |

| `PUT /functions/v1/device/heartbeat` | なし | `{"last_heartbeat_at": "..."}` |
| `GET /functions/v1/device/reservations?from=&to=` | なし | `{"provider": "monban", "reservations": [...]}` |
| `POST /functions/v1/device/reservations` | `customer_name`、`starts_at`、`ends_at` は必須。`customer_phone`、`service_name`、`note`、`visit_id` | 201 `{"reservation": {...}}` |
| `POST /functions/v1/device/reservations/<予約 id>/arrive` | なし | `{"reservation": {...}}` |

- `paired` が `false` の本体は、まだグループに結び付いていない。この間の来客の PUT と予約の要求は 409 を返す。
- `shop` は店名、業種、口調、あいさつ、営業時間、メニュー、予約なしの来客への対応、予約先を持つ。読めなければ `null` で、他の項目はそのまま返す。Google は呼ばない。
- AI が作る予約は、送った内容によらず必ず仮予約になる。仮予約を含む既存の予約と時間が重なれば 409（`reservation_overlap`）を返す。`visit_id` がこの店の来客でなければ結び付けず、予約は受ける。
- 接続切れの通知（15 分）は、`heartbeat` を一度でも送った本体だけが対象になる。
- 来客 id は本体が作る uuid。同じ id で何度送っても、同時に送っても、来客は1件になる。
- 来客を作るときは `chimed_at`、`mode`、`status` が要る。更新では `status` だけが要り、送らなかった項目は今の値が残る。
- `messages` は `[{"seq": 1, "speaker": "visitor", "text": "...", "spoken_at": "..."}]` の形。同じ `seq` は足さない。
- `applied` は、送った内容を来客に反映したかを示す。古い送信だと `false` になる。
- 値の誤りは 400、他の本体の来客への書き込みは 403 を返す。

会話サーバーの中継（labpc）は、会話の始めに PSoC から受け取ったデバイス鍵で `GET /functions/v1/device/settings` を一度呼び、`extra_instructions` と `away_leave_at_door` を会話エージェントに渡す。中継には secret key を置かない。`extra_instructions` は 350 字までなので、基本の規則と合わせても 800 字に収まる。

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

`supabase/.env` の住人のパスワードとデバイス鍵（`echo "dk_$(openssl rand -hex 32)"` など）、`supabase/functions/.env` の `PUSH_WEBHOOK_SECRET`（`openssl rand -hex 32` など）を埋める。Google カレンダーの項目は空のままでも動き、接続の要求だけが 503 になる。Edge Function は起動時に `functions/.env` を読むため、書き換えたら `supabase stop` と `supabase start` をやり直す。

```bash
supabase start
```

```bash
deno run --allow-read --allow-run --allow-net --allow-env supabase/scripts/seed_local.ts
```

シードの本体は、グループに結び付けた状態で入る。`supabase db reset` をするとアカウントと鍵も消えるため、シードを流し直す。

### デモデータ

既存のアカウントのグループに、ネイルサロンを想定した店舗の設定、メニュー、今日を基準にした予約、来客と会話、通知を入れる。決まった id で書くので、何度実行しても増えず、日付が今日を基準に更新される。店名、業種、受け答え、営業時間は上書きし、予約先は予約帳に戻す。

```bash
deno run --allow-read --allow-run --allow-net --allow-env supabase/scripts/seed_demo.ts resident@example.com
```

メールアドレスを省くと `supabase/.env` の `SEED_RESIDENT_EMAIL` を使う。既定ではローカルに入れる。クラウドに入れるときだけ `DEMO_SUPABASE_URL` と `DEMO_SUPABASE_SECRET_KEY` を渡す。来客を初めて入れると Webhook が動き、そのアカウントの端末に通知が届く。

## 試験

| 試験 | 実行 | 内容 |
|---|---|---|
| pgTAP（199 件） | `supabase test db` | H1、H2、H3、H3b、H4、デバイス鍵の保護、状態の後戻りの防止、Webhook の送信待ち、グループと招待、メンバーの名前、設定、ペアリング、通知の送信待ちと再送、店舗の設定とメニューの権限、予約帳と接続（Square を含む）を直接読めないこと、通知のオンオフと操作した本人の除外、接続切れ、差分を読む呼び出し |
| 結合（130 件） | `deno run --allow-read --allow-run --allow-net --allow-env supabase/tests/e2e_local.ts` | Data API での H1 と H3b、device での H2 と H4（同時の作成を含む）、グループの作成から招待での参加まで、ペアリング、設定、Webhook から Expo までと通知の文面、pg_cron の再送、予約帳の操作と通知、AI の仮予約と重なりの拒否、予約先の切り替え、Square の未設定と未接続、assistant の認証と入力の検証と「書き込まない」こと |
| Edge Function（170 件） | `deno test --allow-env supabase/functions/` | 通知の条件と文面、Expo の試し直し、予定と予約の変換、差分の分類とまとめ通知、410 の扱い、自分の書き込みの除外、OAuth、更新トークンの暗号化、予約先の振り分け、device の経路、Square（状態の対応、ページングと期間の分割、顧客とメニュー、読み取り専用、合流、署名、Webhook、トークンの更新）、自然言語の入力（案への変換、文との突き合わせ、Ollama の成功と失敗、未設定の 503） |

結合試験は、シードを入れたローカルで流す。Expo には実在しないトークンで送るため、Expo から `DeviceNotRegistered` の ticket が返れば正しい。マイグレーションを変えたら `supabase db advisors --local` も通す。

実際の Google カレンダーとの通信は、OAuth クライアントが要るためどの試験も通らない。Google の応答はユニット試験の偽物で確かめている。

## クラウド

| 項目 | 値 |
|---|---|
| 組織 | AttackOnRasshiine（Free プラン） |
| プロジェクト | `tka_2601`（ref `bqdvxzvezecunnkbcyoy`、リージョン `ap-northeast-1`） |
| URL | https://bqdvxzvezecunnkbcyoy.supabase.co |
| 入っているもの | マイグレーション7つ（`20261102000000_shop_reservations.sql` は未適用）、pg_cron の `push-retry`、Edge Function「device」と「push」（「reservations」と「calendar-sync」は未配備）、Edge のシークレット `PUSH_WEBHOOK_SECRET`、Vault の `push_function_url` と `push_webhook_secret` |
| 入っていないもの | シード（グループ、住人、本体、デバイス鍵）。`EXPO_ACCESS_TOKEN` は設定しない（下を参照） |
| 通知を送る Expo のプロジェクト | `@atsushihosaka/jphacks2026`（アプリの `extra.eas.projectId`） |

アプリは publishable key（`sb_publishable_...`）を使う。secret key はダッシュボードの API Keys にあり、リポジトリにも本体にも入れない。Free プランのプロジェクトは、1週間使われないと一時停止する。

マイグレーションの適用と関数の配備は、`supabase link --project-ref bqdvxzvezecunnkbcyoy` のあと次で行う。

```bash
supabase db push
```

```bash
supabase functions deploy push device reservations calendar-sync
```

Google カレンダーに接続するには、次の4つを `supabase secrets set` で1つずつ設定する。値の意味は `functions/.env.example` にある。`RESERVATIONS_PUBLIC_URL` は `https://bqdvxzvezecunnkbcyoy.supabase.co/functions/v1/reservations` で、Google Cloud の OAuth クライアントの承認済みのリダイレクト URI に、この URL の末尾に `/google/callback` を付けたものを登録する。

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `RESERVATIONS_PUBLIC_URL`
- `CALENDAR_TOKEN_KEY`（`openssl rand -base64 32`。変えると保存済みの更新トークンを読めなくなり、接続し直しになる）

Webhook の合言葉はクラウド専用の値で、Edge のシークレットと Vault の両方に入れてある。変えるときは、`supabase secrets set PUSH_WEBHOOK_SECRET=...` と、Vault の `push_webhook_secret` の書き換えを両方行う。

Expo の通知の Enhanced Security は有効にしないため、`EXPO_ACCESS_TOKEN` は設定せず、トークンなしで送る（2026-10-17 にユーザーが決定）。後で有効にするときは、https://expo.dev/settings/access-tokens でトークンを作り、`supabase/functions/.env` の `EXPO_ACCESS_TOKEN` に書いてから、その1つだけを設定する。`--env-file` でファイルごと入れると、クラウドの `PUSH_WEBHOOK_SECRET` がローカルの値で上書きされ、通知が届かなくなる。

```bash
supabase secrets set --project-ref bqdvxzvezecunnkbcyoy "EXPO_ACCESS_TOKEN=$(grep '^EXPO_ACCESS_TOKEN=' supabase/functions/.env | cut -d= -f2-)"
```

Square に接続するには、先に Square Developer Console でアプリを作る。アカウントとアプリの作成は無料で、Sandbox なら実際の店舗がなくても試せる。

1. Developer Console でアプリを作り、上部で Sandbox を選ぶ。
2. OAuth の Redirect URL に `https://bqdvxzvezecunnkbcyoy.supabase.co/functions/v1/reservations/square/callback` を登録する（HTTPS 必須）。
3. Webhooks で通知先に `https://bqdvxzvezecunnkbcyoy.supabase.co/functions/v1/reservations/square/webhook` を登録し、`booking.created` と `booking.updated` を選ぶ。
4. Application ID、Application secret、Webhook の署名鍵を `SQUARE_APPLICATION_ID`、`SQUARE_APPLICATION_SECRET`、`SQUARE_WEBHOOK_SIGNATURE_KEY` に、`SQUARE_ENVIRONMENT` に `sandbox` を設定する。`RESERVATIONS_PUBLIC_URL` と `CALENDAR_TOKEN_KEY` は Google と共用する。Square の Sandbox では、同意の画面を開く前に Developer Console からテスト用の店舗のダッシュボードを開いておく。

本番では Production のアプリに切り替え、`SQUARE_ENVIRONMENT` を `production` にする。

本体を登録するときは、手元でデバイス鍵を作って SHA-256 を計算し、ダッシュボードの SQL Editor で `private.register_device` を呼ぶ。鍵そのものは SQL に書かず、本体にだけ書き込む。返ってきたペアリングコードを住人に伝え、アプリで入れてもらう。

```bash
printf '%s' "$DEVICE_KEY" | shasum -a 256
```

```sql
select * from private.register_device('玄関の親機', '<SHA-256 の 16 進>');
```
