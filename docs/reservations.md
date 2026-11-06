# 店舗向けの予約と通知 仕様

MONBAN を、個人経営のネイルサロン、マッサージ店、貸し会議室で運営する塾などに提供するときの、スマホアプリと Supabase の仕様をまとめる。デバイス全体の仕様は [spec.md](spec.md)、来客の記録は [history.md](history.md) にある。

## 1. 前提

| 項目 | 決定 |
|---|---|
| アプリを使う人 | 客ではなく店の人 |
| プラン | 個人向けと法人向けを分けない。家庭で使う場合も同じ機能にする |
| テナント | 会社やチームの単位は作らない。既存のグループ（`households`）を1店舗として扱う |
| 店名 | `households.name` |
| 予約の枠 | 1店舗につき1つ。スタッフ別や部屋別の枠は持たない |

## 2. 予約先

店が設定で予約先を1つ選ぶ（`shop_profiles.reservation_provider`）。アプリとボイスエージェントは予約先を意識せず、Edge Function を通して読み書きする。

| 予約先 | 値 | 予約の置き場所 | 読み取り | 追加と変更 |
|---|---|---|---|---|
| MONBAN の予約帳 | `monban` | `reservations` | DB | DB |
| Google カレンダー | `google_calendar` | Google カレンダー | 毎回 API で読む | API で書く |
| Square 予約 | `square` | Square。AI の仮予約だけ `reservations` | 毎回 API で読む | アプリからは変更できない。店が Square で行う |
| ホットペッパービューティー | `hotpepper` | `reservations` | DB（店の手入力） | DB。SALON BOARD には店が手で入れる |

- Google カレンダーの予約は Supabase に写さない。Supabase に置くのは更新トークン（暗号化）と差分の目印（`sync_token`）だけである。
- ホットペッパービューティーには、予約を読み書きする公開 API が見つからなかった。そのため AI は SALON BOARD の予約を見られない。店が仮予約を確かめて承認することで二重予約を防ぐ。
- 予約帳とホットペッパーは同じ `reservations` を使う。予約先を切り替えても予約は消えない。予約帳と Google カレンダーや Square の間で予約は移さない。
- Square は読み取りだけで使う。無料プランの店も接続できるようにするためである（店側の予約の書き込みには有料プランが要る）。Square の予約は `read_only` が `true` で、アプリでは到着の記録だけができる。到着の時刻は `reservation_external_states` に持つ。
- Google カレンダーに別のアカウントで接続し直すと、選んだカレンダーと差分の起点は消える。予約先が `google_calendar` だったときは `monban` に戻す。カレンダーを選ぶまで Google は予約先にできないためである（返事の `provider` で分かる）。同じアカウントなら、カレンダーと予約先をそのまま残す。
- Google カレンダーでは、選んだカレンダーの時刻付きの予定をすべて予約として扱う。終日の予定は出さない。
- Google カレンダーや Square に接続できないあいだは、予約の一覧を表示できない。写しを持たないためである。

### 2.1 予約の状態

| 状態 | 値 | 予約帳 | Google カレンダー | Square |
|---|---|---|---|---|
| 仮予約 | `pending` | `status` | 予定の `status` が `tentative` | `PENDING` |
| 確定 | `confirmed` | `status` | 予定の `status` が `confirmed` | `ACCEPTED` |
| キャンセル | `cancelled` | `status` | 予定の `status` が `cancelled` | `CANCELLED_BY_CUSTOMER`、`CANCELLED_BY_SELLER`、`DECLINED`、`NO_SHOW` |

到着の時刻（`arrived_at`）、顧客名、電話番号、メニュー、受付元は、Google カレンダーでは予定の `extendedProperties.private` に `monban_` で始まるキーで入れる。Google カレンダーで直接作られた予定は、件名を顧客名、説明をメモとして読み、受付元を `external` にする。

### 2.2 仮予約の承認

AI がインターホンで受けた予約は、必ず仮予約（`pending`）で入る。アプリは予約タブの一覧で、次の予約の下に、今日から 90 日先までの仮予約を開始の早い順にカードで並べる。店はカードか予約の詳細で確定するか断る。カードに出した仮予約は、日付の見出しの下には出さない。予約先がホットペッパーのときは SALON BOARD に、Square のときは Square に入力してから承認する。Square では AI の仮予約を `reservations` に置いて一覧に合わせる。承認したあとも、同じ開始時刻の Square の予約（キャンセルを含む）が読めるまでは、確定として一覧と重なりの判定に残す。店が Square への入力を忘れても予約が消えないようにするためである。この予約は受付元が `ai`、`read_only` が `false` で、不要ならアプリでキャンセルできる。店が Square に別の時刻で入れると、キャンセルするまで両方が出る。Square で `PENDING` の予約もカードに出るが、読み取りだけなのでアプリに承認とお断りのボタンは出さず、承認は Square で行う。AI が受ける時点で、仮予約を含む既存の予約と時間が重なれば `409` を返して受け付けない。アプリの手入力では重なりを止めない。

予約帳とホットペッパーでは、店ごとに1件ずつ処理する関数（`reservation_create_if_free`）で重なりを確かめるので、同じ枠に AI の仮予約が同時に来ても1件しか入らない。Google カレンダーと Square には同時の書き込みを止める手段がないため、確かめてから書くまでの間に入った予約は防げない。この重なりは仮予約のカードで店が確かめる。

## 3. API

### 3.1 アプリが使う Edge Function「reservations」

`Authorization: Bearer <ログインの JWT>` を付ける。グループのメンバーでなければ `403` を返す。

| 要求 | 本文または引数 | 返事 |
|---|---|---|
| `GET /reservations?from=&to=` | ISO 8601 の期間（`status` を付けると絞り込む） | `{"provider": "...", "reservations": [Reservation]}` |
| `POST /reservations` | `customer_name`、`customer_phone`、`service_name`、`starts_at`、`ends_at`、`note`、任意の `idempotency_key` | `201` と `{"reservation": Reservation}`（確定で作る）。同じキーの予約があれば `200` で既存を返し、通知しない |
| `GET /reservations/<id>` | なし | `{"reservation": Reservation}` |
| `PATCH /reservations/<id>` | 上と同じ項目の一部、任意の `expected_starts_at`、`expected_ends_at` | `{"reservation": Reservation}`。今の予約の時刻と違えば `409`（`reservation_changed`）で変更しない |
| `POST /reservations/<id>/approve` | なし | 確定にする |
| `POST /reservations/<id>/cancel` | なし | キャンセルにする |
| `POST /reservations/<id>/arrive` | なし | 到着を記録する |
| `GET /reservations/provider` | なし | `{"provider": "...", "capabilities": {"create"}, "google": {"connected", "account_email", "calendar_id", "calendar_name", "status", "last_error"}, "square": {"connected", "merchant_name", "status", "last_error"}}` |
| `PUT /reservations/provider` | `{"provider": "..."}` | 同上。Google は接続とカレンダーの選択が、Square は接続が済んでいなければ `409` |
| `POST /reservations/google/start` | `{"return_url": "..."}` | `{"url": "<Google の同意画面>"}` |
| `GET /reservations/google/callback` | Google が呼ぶ（JWT なし、使い切りの `state`） | トークンを暗号化して保留にし、`return_url?google=pending&code=<使い切りの値>` へ転送する。断られたら `cancelled`、失敗したら `error` |
| `POST /reservations/google/complete` | `{"code": "..."}` | 接続を確定する。返事は `GET /reservations/provider` と同じ形。接続を始めた本人でなければ `403`（`oauth_user_mismatch`）で保留を消す。期限切れや不明な値は `404`（`oauth_code_invalid`） |
| `GET /reservations/google/calendars` | なし | `{"calendars": [{"id", "name", "primary"}]}` |
| `PUT /reservations/google/calendar` | `{"calendar_id": "..."}` | 選んだカレンダーの差分の起点を取り直す |
| `DELETE /reservations/google` | なし | 接続を消す。予約先は `monban` に戻す |
| `POST /reservations/square/start` | `{"return_url": "..."}` | `{"url": "<Square の同意画面>"}` |
| `GET /reservations/square/callback` | Square が呼ぶ（JWT なし、使い切りの `state`） | トークンを暗号化して保留にし、`return_url?square=pending&code=<使い切りの値>` へ転送する。断られたら `cancelled`、失敗したら `error` |
| `POST /reservations/square/complete` | `{"code": "..."}` | Google と同じ。Square のアカウントが別の店で使われていれば `409`（`square_merchant_in_use`） |
| `DELETE /reservations/square` | なし | 接続を消す。予約先が `square` なら `monban` に戻す |
| `POST /reservations/square/webhook` | Square が呼ぶ（JWT なし、署名を確かめる） | 予約の変化を通知する |

コールバックには JWT がなく、誰が同意したかが分からない。同意の URL を他人に開かせて、他人の予約を自分のグループへ結び付ける攻撃を防ぐため、トークンを保留にしてから本人を確かめる。保留は使い切りで、10 分で無効になる。

日時は `Z` か `+09:00` の付いた ISO 8601 で送る。オフセットのない日時は `400` を返す。

`idempotency_key` は英数字とハイフンの 8〜64 字で、形が違えば `400` を返す。キーは店ごとに一意である。アプリは入力画面ごとに1つ作り、送り直しでは同じキーを使う。Google カレンダーでは予定の id をキーの SHA-256 から決める。予定の id は base32hex（`a`〜`v` と `0`〜`9`）で 5〜1024 字という決まりがあり、16 進はこれに収まる。Google が `409` を返したら既存の予定を読んで返す。Google は id の重複を作成時に必ず検出するとは保証していない。

`expected_starts_at` と `expected_ends_at` には、変更する人が見ていた時刻を送る。Google カレンダーでは読んだ予定の etag を `If-Match` に付けて書くので、読んでから書くまでに別の変更が入っても `reservation_changed` になる。表では時刻を更新の条件に入れる。

`Reservation` は次の形で、どの予約先でも同じである。

```json
{
  "id": "予約帳は uuid、Google は予定の id",
  "customer_name": "田中",
  "customer_phone": null,
  "service_name": "ジェルネイル",
  "starts_at": "2026-11-02T05:00:00.000Z",
  "ends_at": "2026-11-02T06:30:00.000Z",
  "status": "pending",
  "source": "ai",
  "note": null,
  "arrived_at": null,
  "visit_id": null,
  "read_only": false
}
```

`id` は予約帳なら uuid、Google なら予定の id、Square なら `square:` で始まる。`source` は `app`、`ai`、`external`（Google カレンダーや Square で作られた予約）のどれかである。`read_only` が `true` の予約の変更、承認、キャンセルは `409`（`provider_read_only`）を返す。Square を予約先にしている店がアプリから予約を足しても同じである。

### 3.2 本体と中継が使う Edge Function「device」

既存の API に次を足す。ボイスエージェント側はまだ呼んでいない。

| 要求 | 内容 |
|---|---|
| `GET /device/settings` | 既存の項目に `contract_version`（形を壊す変更で上げる）と `shop`（店名、業種、口調、あいさつ、営業時間、メニュー、予約なしの来客への対応、予約先）を足す |
| `GET /device/reservations?from=&to=` | 3.1 の形から `customer_phone` と `note` を除いて予約を返す。期間は 31 日まで（超えると `400`） |
| `POST /device/reservations` | 仮予約を作る。`customer_name`、`starts_at`、`ends_at` が要る。時間が重なれば `409`（Square の予約と仮予約の両方を見る） |
| `POST /device/reservations/<id>/arrive` | 到着を記録し、店に通知する |
| `PUT /device/heartbeat` | 本体の死活通信。接続切れの検知に使う |

### 3.3 アカウントの削除（Edge Function「account」）

`DELETE /functions/v1/account` は JWT の本人を削除し、`{"deleted": true}` を返す。App Store の審査（5.1.1(v)）で求められる機能で、グループに入っていない人も消せる。途中で失敗したら `500` を返す。アカウントの削除を最後に行うので、ログインしたままやり直せる。

- 残りのメンバーがいなければ、グループごと消す。予約、来客、接続、通知、本体、本体の鍵、店舗の設定は cascade で消える。本体を使い続けるには、管理者が登録し直す。
- 残りのメンバーがいれば、本人だけが抜ける。グループ、予約、本体は残る。本人がつないだ Google カレンダーと Square の接続は本人の外部アカウントなので取り消し、予約先を予約帳に戻す。ほかの人がつないだ接続は残す。
- 接続の取り消しは Google と Square に届かなくても続ける。
- 本人の `push_tokens` と、そのトークンの送信待ちを消す。通知の `actor_user_id`、接続の `connected_by`、招待の `created_by` は `null` になる。

## 4. 通知

通知の種類は `notification_kinds` の行で決まる。

| 種類 | 値 | 契機 |
|---|---|---|
| 来客 | `chime` | チャイムの検知 |
| 来客への対応の結果 | `ended` | 終話 |
| 仮予約 | `reservation_pending` | AI が仮予約を受けた、Google で仮の予定が入った |
| 予約の追加 | `reservation_created` | 予約の追加 |
| 予約の変更 | `reservation_updated` | 日時などの変更、仮予約の承認 |
| 予約のキャンセル | `reservation_cancelled` | キャンセル、Google での予定の削除、Square でのキャンセル |
| 予約のお客様の到着 | `reservation_arrived` | AI やアプリが到着を記録した |
| 本体の接続切れ | `device_offline` | 死活通信が 15 分途絶えた |
| 予約先との接続エラー | `calendar_sync_failed` | Google カレンダーの差分を読めなくなった、Square のログインが無効になった |

- 種類を足すときは、マイグレーションで `notification_kinds` に1行足し、Edge Function で文面を作る。オンオフの画面は表から作るので、アプリの更新は要らない。
- 通知はすべて `notifications` に残り、アプリの通知の一覧で見られる。来客を消すと、その来客の通知も消える。
- プッシュ通知は `push_deliveries` に端末ごとの送信待ちとして入れてから送る。操作した本人と、その種類をオフにした人には送らない。
- 同じ出来事は `dedupe_key` で1回だけ通知する。
- 既読は人ごとに「どこまで読んだか」の時刻で持つ。

### 4.1 Google カレンダーの変更を知る方法

pg_cron が1分ごとに Edge Function「calendar-sync」を呼び、`syncToken` で差分だけを読む。通知は最大で1分ほど遅れる。

- 接続直後とカレンダーの変更直後は起点を取るだけで、通知しない。
- 差分が 410 を返したら起点を取り直し、その回は通知しない。
- MONBAN は Google に書く前に、書き込みの id を `calendar_own_writes` に記録し、予定の `extendedProperties.private.monban_write` に入れる。差分で読んだ予定の `monban_write` が記録にあれば通知せず、記録を消す。Google への書き込みが返事を待っている間に差分を読んでも通知しない。
- 記録を消すので、そのあと店が Google で同じ予定を変えると、印が残っていても通知する。MONBAN の書き込みと店の変更が同じ回の差分に入ると、まとめて通知しない。
- 削除された予定が id しか返さないときは、予定の id で記録を探す。
- 接続ごとに `sync_lease_until` の権利を条件付きの更新で取る（`calendar_sync_acquire`）。取れない接続はその回は読まない。取れたら最新の目印を読み直し、終わったら解放する。解放できなくても権利は5分で切れる。
- 1回の差分が 10 件を超えたら（繰り返しの予定の変更など）、1件にまとめて通知する。
- 削除された予定に時刻がなければ、終日かどうか分からないので、キャンセルにせず「予約先の予定が削除されました」と通知する。
- 通知の記録と送信待ちは1つのトランザクションで作る。失敗したら目印を進めず、次の回に読み直す。同じ変更は `dedupe_key` で二重にならず、足りない送信待ちだけが入る。
- 読めなくなったら接続を `error` にして1回だけ通知し、読めるようになったら `active` に戻す。

### 4.2 Square の変更を知る方法

Square の Webhook（`booking.created`、`booking.updated`）で知る。差分を読む処理と違い、遅れはほとんどない。

- 署名（`x-square-hmacsha256-signature`）を確かめ、違えば `403` を返す。
- `merchant_id` から店を引き、予約先が Square の店にだけ通知する。
- 作成は `PENDING` なら仮予約、それ以外は予約の追加として通知する。更新はキャンセル系の状態ならキャンセル、それ以外は変更として通知する。
- 同じ予約の同じ版（`square:<id>:<version>`）は1回だけ通知する。
- 顧客名を読めなくても、「お客様」として通知する。

### 4.3 本体の接続切れ

XIAOのファームは、通信できる間 60 秒ごとに `PUT /device/heartbeat` を送る（実機では未確認）。一度も呼んでいない本体は判定の対象にせず、通知しない。

## 5. 受け答えの設定

アプリの設定で次を決める。`GET /device/settings` の `shop` で中継に渡す。

| 項目 | 列 | 値 |
|---|---|---|
| 業種 | `business_type` | ネイルサロン、マッサージ店、学習塾、その他 |
| 口調 | `tone` | とても丁寧（既定）、丁寧、親しみやすい |
| 最初のあいさつ | `greeting` | 80 字まで。空なら既定の文 |
| 営業時間 | `business_hours` | 曜日ごとの開店、閉店、定休日 |
| メニュー | `shop_services` | 名前、所要時間、料金 |
| 予約なしの来客への対応 | `walk_in_policy` | 仮予約を受ける（既定）、店に連絡する、お断りする |
| 追加の指示 | `devices.extra_instructions` | 350 字まで（既存） |

### 5.1 ボイスエージェント側に求めること

アプリと Supabase の更新だけでは、会話は変わらない。中継が次を実装して初めて設定が会話に効く。

- `shop` を読み、`house_rules` を店舗向けに組み立てる。今の規則（[spec.md 5.6](spec.md#56-house_rules)）は住宅向けで、「留守と言わない」「資料はポストに」など店舗に合わない。800 字の上限も見直す。
- 予約の確認では、訪問者に名前を尋ねて照合する。**予約者の名前や時間を AI から読み上げない。** インターホンは屋外から誰でも話しかけられるためである。
- `GET /device/reservations` の項目のうち、顧客名とメニューは Google カレンダーの件名や Square の入力など、外部の人が書けることがある。**会話の LLM のプロンプトに指示として入れない。** 照合は中継の処理で行い、LLM には結果（見つかった、見つからない）だけを渡す。電話番号とメモはこの API で返さない。
- 予約なしの来客には `walk_in_policy` に従う。仮予約を受けたら「確定はお店からご連絡します」と伝え、確定したとは言わない。
- 予約の読み書きが失敗しても会話を止めず、店から連絡すると伝える。

## 6. 権限

| 対象 | メンバー（アプリ） | 本体・中継（Edge Function 経由） |
|---|---|---|
| `shop_profiles` | 読む。予約先以外の項目を変える | 読む |
| `shop_services` | 読み書きする | 読む |
| `reservations` | Edge Function を通して読み書きする | 読む、仮予約を作る、到着を記録する |
| `calendar_connections` ほか | 権限なし。接続の状態は Edge Function が返す | なし |
| `notification_kinds` | 読む | なし |
| `notifications` | 自分のグループの通知を読む | なし |
| `notification_preferences`、`notification_read_states` | 自分の行を読み書きする | なし |

## 7. 決めていないこと

| 項目 | 論点 |
|---|---|
| 顧客情報の保存期間 | 予約帳の顧客名と電話番号、通知の文面の保存期間。今は自動では消さない。個人情報保護法の観点で決める |
| Google の審査 | `calendar.events` はセンシティブなスコープで、審査前は新規ユーザーが 100 人までに制限される。OAuth の同意画面が Testing の状態だと、更新トークンが 7 日で切れ、店は 7 日ごとに接続し直すことになる。店舗に広げる前に審査を受ける |
| 枠の複数化 | 複数のスタッフや部屋を持つ店が出てきたら、重なりの判定を見直す |
| 塾の定期の授業 | Google カレンダーの繰り返しの予定は扱える。予約帳に繰り返しの入力はない |
| ホットペッパーの予約の取り込み | 今は手入力だけである。SALON BOARD の CSV の取り込みは、実物の形式を確かめてから決める |

## 8. 自然言語の入力

店の人が予約タブの入力欄に書いた文を読み取り、変更の案を確認カードで見せる。**読み取っただけでは保存しない。** 店の人が確認カードで承認してから、既存の API で書き込む。

| 入力できること | 例 | 案の種類 |
|---|---|---|
| 予約の追加 | 木曜の14時に田中さん、ジェルネイルで | `add_reservation` |
| 予約の変更 | 田中さんの今日の予約、15時半にずらして | `update_reservation` |
| 営業時間の変更 | 水曜も定休日にして | `set_business_hours` |

質問への回答と AI の口調の変更は、今は扱わない。読み取れないときは `unknown` を返し、アプリは入力フォームへ案内する。

`POST /assistant/parse` は `{"text": "..."}`（200 字まで）を受け、`{"proposal": {...}}` を返す。案の形は `type` で分かれる。どの案にも `warnings: string[]` がある。

| `type` | 項目 |
|---|---|
| `add_reservation` | `customer_name`、`customer_phone`、`service_name`、`starts_at`、`ends_at`、`note` |
| `update_reservation` | `reservation_id`、`customer_name`、`service_name`、`before`、`after`（どちらも `starts_at`、`ends_at`） |
| `set_business_hours` | `day`（日曜が 0）、`before`、`after`（どちらも `closed`、`open`、`close`） |
| `unknown` | `reason`（画面に出せる文） |

アプリは確認後に `POST /reservations`、`PATCH /reservations/<id>`、`shop_profiles.business_hours` の該当する曜日の更新で書き込む。

- 解析は Edge Function「assistant」が受ける。アプリから labpc を直接呼ばない。文は DB にもログにも残さない。
- 解析器は `IntentParser` という差し替え可能な入口の裏に置く。今の実装は Ollama（labpc の Gemma を想定）で、外部のクラウド AI は使わない。接続先は `ASSISTANT_LLM_BASE_URL` と `ASSISTANT_LLM_MODEL` で決める。
- LLM の出力は信用しない。形を検証し、日時は「今日」を基準に決定的に確かめ、重なりや定休日の警告はサーバーの処理で作る。
- 読み取りを文と突き合わせる。文に書かれた曜日や「明日」と日付が合わなければ案を出さない。文に長さが書かれていなければ LLM の所要時間を使わない。LLM が落としたメニュー名と時刻は文から拾う。
- 変更の対象の予約は、LLM が返した名前と日付で予約先から探す。見つからないときや複数あるときは、書き込まずに案内する。
- labpc に届かないときは `503`（`assistant_unavailable`）を返す。アプリは入力フォームへ案内する。

**未解決:** labpc の Ollama は `127.0.0.1` で動いており、クラウドの Edge Function から届かない。公開の経路（HTTPS の逆プロキシと認証、または会話サーバーの API への追加）は、会話サーバーの仕様と一緒に決める。

## 9. 構成（リポジトリ層）

ボイスエージェントの仕様が固まっていないため、外部との境界を差し替えられるようにする。

| 場所 | 層 | 役割 |
|---|---|---|
| `mobile/src/domain` | ドメイン | 画面が使う型と、純粋な規則 |
| `mobile/src/repositories` | リポジトリの入口 | 画面が使う操作のインターフェース |
| `mobile/src/infrastructure` | 実装 | Supabase への読み書きと、通信の形からドメインへの変換 |
| `mobile/src/lib/container.ts` | 組み立て | どの実装を使うかを決める唯一の場所 |
| `supabase/functions/_shared/reservation.ts` | 予約先の入口 | `ReservationProvider`。予約先を足すときはここを実装する |
| `supabase/functions/_shared/assistant` | 解析の入口 | `IntentParser`。解析器を替えるときはここを実装する |
| `supabase/functions/device/contract.ts` | ボイスエージェントとの契約 | 本体と中継に渡す形。形が変わったらここを直す |

- 画面は `src/infrastructure` と Supabase のクライアントを直接読み込まない。試験で確かめる。
- ボイスエージェントが書く値（意図、対応など）に知らない値が来ても、変換の層で `unknown` などに丸め、画面を落とさない。

## 10. 予約 SaaS の調査（2026 年 11 月 2 日）

個人経営の店でよく比較に挙がるサービスと、MONBAN から連携できるかを調べた。利用シェアの数字は見つからなかった。「よく挙がる」は比較記事（[IT トレンド](https://it-trend.jp/reservation/article/409-5092)、[Salowin](https://salowin.jp/note/archives/6051) など）の掲載状況であり、提携記事を含む可能性がある。

| サービス | 位置づけ | 公開 API | ログイン | 無料で使える範囲 | 判定 |
|---|---|---|---|---|---|
| Square 予約 | 店舗向け。比較記事によく挙がる | [あり](https://developer.squareup.com/docs/bookings-api/what-it-is) | OAuth | 予約の読み取りは無料プランでも可。店側の予約の書き込みは有料プラン | **実装する** |
| Google カレンダー | 汎用 | あり | OAuth | 無料。審査前は新規 100 ユーザーまで | 実装済み |
| STORES 予約 | 店舗向け。比較記事によく挙がる | [あり（予約と顧客の参照）](https://www.st.inc/news/2021-02-19-reserve-api) | API キー。問い合わせて仕様書を受け取る形で、OAuth は確認できなかった | 未確認 | 仕様書を入手してから判断する |
| Airリザーブ | 店舗向け。比較記事によく挙がる | 見つからなかった | － | － | 連携しない |
| RESERVA | 店舗向け。比較記事によく挙がる | 見つからなかった | － | － | 連携しない |
| SALON BOARD | ホットペッパーの掲載と一体 | [公開されていないとの説明が複数ある](https://salon-douki.com/2123)。[リクルートの Web サービスのページ](https://webservice.recruit.co.jp/)にも載っていない。リクルートが明言した文書は見つからなかった | － | － | 手入力とアプリでの承認 |
| TimeRex | 日本の日程調整ツール。店舗向けではない | [あり。API は無料](https://developers.timerex.net/api) | OAuth（無料登録） | API は無料 | 予約の読み取りの範囲が未確認 |
| Calendly | 海外の日程調整ツール | [あり](https://developer.calendly.com/api-docs) | OAuth、個人トークン | [予約の作成は有料プラン](https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-event-invitee.md) | 日本の個人店での利用が確認できない |
| Cal.com | オープンソースの日程調整ツール | [あり](https://cal.com/docs/api-reference/v2/introduction) | OAuth、API キー | [無料プランの一覧に API の記載がない](https://cal.com/pricing)。自前で動かせば無料とする記事がある | 日本の個人店での利用が確認できない |

- 登録なしで店の予約を読める API はない。店の顧客情報を読むので、どのサービスにも認証が要る。登録の手間が最も小さいのは、審査なしで無料の開発者アカウントと試験環境を使える Square である。
- SALON BOARD を画面から自動で読む方法（スクレイピング）は、利用規約に触れる可能性があり、画面の変更で動かなくなるため採らない。
- SALON BOARD の予約通知メールを転送してもらい、解析して取り込む方法は、[DOUKI](https://salon-douki.com/2123) が使っている。店舗向けの連携の候補になるが、メールの受信の仕組みと実物のメールが要る。
