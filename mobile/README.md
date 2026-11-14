# MONBAN アプリ（Expo）

インターホン自動応答デバイスの店舗向けアプリ。予約の一覧とカレンダー、AI が受けた仮予約の承認、通知、来客の履歴、AI の受け答えの設定、動作モードの切り替えを行う。予約と通知の仕様は [docs/reservations.md](../docs/reservations.md) にある。画面は Claude Design のキャンバス（https://claude.ai/artifact/G9j5naxUGESrVJmT1pxSab ）に合わせている。裏側は [supabase/](../supabase/README.md)（PR #4）を使う。

## 構成

| パス | 内容 |
|---|---|
| `src/app/` | 画面（Expo Router）。`_layout.tsx` でログイン前・グループ未所属・所属済みの画面を分ける |
| `src/app/(tabs)/` | 下のタブ。予約（最初の画面）、来客、通知、設定 |
| `src/app/onboarding/` | 本体のないお店の初回の案内（案内、登録コード、チャイムの登録） |
| `src/app/reservations/` | 予約の詳細、追加と編集 |
| `src/app/assistant/` | 自然言語の入力と確認カード |
| `src/app/settings/` | 店舗情報、メニュー、受け答え、予約先、通知の種類、追加の指示、グループ、招待 |
| `src/components/` | ナビバー、背景のシェイプ、ボタン、OS のシンボルを出す `Icon` などの部品 |
| `src/domain/` | 画面が使う型と、日付や営業時間などの純粋な規則 |
| `src/repositories/` | データの操作のインターフェース |
| `src/infrastructure/supabase/` | リポジトリの実装と、通信の形からドメインへの変換（`mappers.ts`） |
| `src/lib/container.ts` | どの実装を使うかを決める唯一の場所 |
| `src/lib/` | ログイン（`auth.tsx`、`authActions.ts`）、通知（`push.ts`）、タブの数字（`badges.tsx`）、表示の文言（`labels.ts`）、書式（`format.ts`）、アイコンの名前（`symbols.ts`）、確認ダイアログ（`confirm.ts`） |
| `src/theme.ts` | 色。テーマ色は紺（#1F3A5F）だけ |

## 予約の読み書き

予約はどの予約先でも Edge Function「reservations」を通して読み書きする。Square の予約は読み取りだけで（`read_only`）、詳細では到着だけを記録できる。Square を予約先にしている間は予約タブの追加を出さない。アプリは予約を保存せず、画面を開くたびに読む。通知の種類の画面は `notification_kinds` の表から作るので、種類を足してもアプリの更新は要らない。

## リポジトリ層

画面と部品は `src/lib/container.ts` の `repositories` とドメインだけを読み、`src/infrastructure` と Supabase のクライアントを読み込まない（`tests/architecture.test.mjs` で確かめる）。ボイスエージェントの仕様が変わったら、`src/infrastructure/supabase/mappers.ts` を直す。知らない意図、対応、状態は、ここで `unknown` などに丸めて画面を落とさない。実装を差し替えるときは、インターフェースを実装して `container.ts` を替える。

## 予約の表示

日、週、月は [react-native-big-calendar](https://github.com/acro5piano/react-native-big-calendar) で描く（`src/components/ReservationCalendar.tsx`）。ネイティブの依存はない。予約を追加するときの日付は `@react-native-community/datetimepicker` で選ぶ。こちらはネイティブの依存なので、入れたあとは開発ビルドを作り直す。

## 自然言語の入力

入力した文は Edge Function「assistant」が読み取り、案を返す。アプリは案を確認カードに出し、店の人が「追加」か「変更」を押してから既存のリポジトリで書き込む。読み取れないときや届かないときは、入力フォームへ案内する。

## 本体とチャイムの登録（初回の案内）

お店に入っていて本体のないユーザーには、最初に案内（`src/app/onboarding/`）が出る。流れは、案内、登録コードの入力（`claim_device`）、本体の接続待ち、静かにする、鳴らす、確認、完了である。「あとで」を押すとアプリへ進み、お店ごとに端末（AsyncStorage）へ覚えて、次の起動からは案内を出さない。本体が登録されたら、その記憶は消す。入口は設定の「本体」にも残る。本体を読めなかったとき（通信の失敗）は、本体なしとは区別して、案内へ移さない。本体があれば、チャイムが未登録でも案内は強制しない。

| パス | 内容 |
|---|---|
| `src/lib/deviceGate.tsx` | お店の本体の有無と、案内を出すかの判断。案内を始めたら、本体を登録した後も終えるまで案内の画面に留める |
| `src/lib/useDeviceClaim.ts` | ペアリングコードの登録。設定の画面と案内の画面が共有する。結果が分からないときは、コードを送り直さず本体の確認だけを再試行する |
| `src/domain/chime.ts` | チャイム登録の画面の状態を決める規則（純粋な関数）。試験は `tests/chime.test.mjs` |
| `src/lib/useChimeEnrollment.ts` | 本体の接続待ち、依頼、進捗の読み直し（1.5 秒）、取り消し。画面が見えているあいだだけ読む |
| `src/components/ChimeEnrollmentFlow.tsx` | 接続待ちから失敗までの画面。案内（`onboarding/chime`）と設定（`settings/chime`）が共有する |

チャイム登録は、アプリが `request_chime_enrollment(device_id, 'start')` で依頼を出し、本体が `device_chime_enrollment` の `handled_seq` と `phase` で進捗を返す（契約は [supabase/README.md](../supabase/README.md) の「チャイム登録」）。アプリは `handled_seq` が依頼の連番と等しいときだけ `phase` を進捗として読む。本体が依頼を 20 秒拾わない、報告が 30 秒進まない（静音の測定、解析、保存）、音を 60 秒待っても鳴らされない、のどれかで終え、本体へ取り消しを送る。登録できたかは、設定の「チャイムを登録し直す」の右に、登録済み、未登録、状態不明で出す。

## 動かす

Xcode と CocoaPods が要る。Expo Go では動かない（開発ビルドを使う）。

```bash
cp .env.example .env
```

`.env` の `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` に publishable key（`sb_publishable_...`）を入れる。secret key は入れない。

```bash
npm install
```

```bash
npx expo run:ios
```

`.env` を書き換えたら Metro を起動し直す。開発ビルド（expo-dev-client）なので、起動時に開発サーバーを選ぶ画面が出ることがある。

## テスト用アカウント

クラウドの Supabase（`tka_2601`）に、テスト用のアカウント `ymt@example.com` がある（メール確認済み）。パスワードはリポジトリに書かず、チーム内で共有する。

## Web 版

同じコードを `react-native-web` で動かす。出力は 1 枚の `index.html` と JS（`app.json` の `web.output` が `single`）で、動的な道筋（`/visits/<id>` など）は `vercel.json` の rewrite で `index.html` に寄せる。

```bash
npx expo start --web
```

```bash
npx expo export --platform web
```

Web で動かないものは、`.web.ts(x)` の別ファイルに分けてある。

| ネイティブ | Web |
|---|---|
| プッシュ通知（`expo-notifications`） | 使わない。タブが見えているあいだ 30 秒ごと、またはタブに戻ったときに読み直し、新しい通知を右上に 10 秒出す。新着があれば開いている画面も読み直す（`components/NotificationToast.web.tsx`） |
| OS のアラート（`Alert.alert`） | ブラウザの `alert` と `confirm`（`lib/webPolyfills.web.ts`） |
| タブバー（`NativeTabs`） | 左のナビ（狭い幅では下）。`components/WebShell.web.tsx` |
| SF Symbols | Material Symbols のフォント（`components/Icon.web.tsx`） |
| 分割ボタンと日付のカレンダー | 同じ形の描画と、ブラウザの日付の入力 |
| 招待リンクを送る | リンクをコピーする |
| 予約先（Google カレンダー、Square）への接続 | ポップアップではなく同じタブで同意画面へ移り、戻ってきた URL の `code` で接続を完了する（`lib/oauthSession.web.ts`）。本番の Web のオリジンを Supabase のシークレット `APP_WEB_ORIGINS` に入れる。`localhost` は設定なしで使える |
| Apple と Google のログイン | `EXPO_PUBLIC_FEATURE_SOCIAL_LOGIN` を 1 にしない。Web 用の戻り先を用意していない |

### Vercel に出す

Vercel のプロジェクトの Root Directory を `mobile` にする。ビルドは `vercel.json` に書いてある。環境変数に `EXPO_PUBLIC_SUPABASE_URL` と `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` を入れる（ビルド時に埋め込まれる）。

本番は `monban-web`（https://monban-web.vercel.app ）。GitHub からの自動デプロイはつながっていないので、main を更新したら、プロジェクトの権限を持つ人が Vercel のダッシュボードの Redeploy か、`mobile` で `npx vercel --prod` を実行して出す。

予約先（Google カレンダー、Square）への接続は、同意のあと Web 版のオリジンへ戻ってくる。戻ってよいオリジンは Supabase のシークレット `APP_WEB_ORIGINS` で決まる（[supabase/functions/.env.example](../supabase/functions/.env.example)）。今は `https://monban-web.vercel.app` だけを許している。独自ドメインなど別の URL で出すときは、そのオリジンを足してから出す。プレビューの URL からは接続できない。

```bash
npx supabase secrets set APP_WEB_ORIGINS=https://monban-web.vercel.app,https://<別のオリジン> --project-ref <ref>
```

出したあとは、設定 → 連携 → Google カレンダーで「Google でログイン」を押す。同じタブで Google の同意画面に移り、許可すると戻ってきて「接続済み」になれば通っている。

## EAS のビルド

`eas.json` のプロファイルは次の4つ。どれも Expo へのログイン（`npx eas-cli@latest login`）が要る。

| プロファイル | 用途 |
|---|---|
| `development` | 実機用の開発ビルド。端末を `npx eas-cli@latest device:create` で登録してから作る |
| `development-simulator` | シミュレータ用の開発ビルド |
| `preview` | 実機に配る確認用のビルド（Metro なしで動く） |
| `production` | App Store 向け。ビルド番号は EAS が上げる |

`.env` は EAS に送られないので、Supabase の URL と publishable key は EAS の環境変数（development、preview、production）に入れる。

```bash
npx eas-cli@latest build --profile development-simulator --platform ios
```

## TestFlight まで

配布は `production` のプロファイルで行う。チームは 93LJ9T3CBB、バンドル ID は `com.atsushihosaka.monban` である。

ビルドの前に次を済ませる。

1. クラウドの Supabase に、このアプリが使うマイグレーションと Edge Function を適用する（`supabase/README.md`）。アカウントの削除は `DELETE functions/v1/account`、予約の二重防止は `POST /reservations` の `idempotency_key` と `PATCH` の `expected_starts_at`、`expected_ends_at` を使うので、これらが入っている必要がある。
2. EAS の `production` 環境に、`EXPO_PUBLIC_SUPABASE_URL` と `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` を入れる。`.env` は Git の対象外で EAS へ上がらない。
3. 下の「外部の設定」の Supabase の Auth と Apple Developer の項目を済ませる。
4. App Store Connect でアプリを作る。外部テストをするなら、プライバシーポリシーの URL、ベータ版の説明、審査用のアカウントも用意する。内部テストには審査がない。

```bash
npx eas-cli@latest build --platform ios --profile production
```

```bash
npx eas-cli@latest submit --platform ios --profile production --latest
```

App Store Connect のアプリの ID は `eas.json` の `submit.production.ios.ascAppId` に入っている。

Google カレンダーの連携画面は既定で表示する。ホットペッパービューティーは既定で非表示にする。`eas.json` の `production.env` でも、それぞれ `1` と `0` に固定している。その他の機能は、次の環境変数が `1` のときだけ画面に出す。

| 環境変数 | 機能 | 有効にする前に要ること |
|---|---|---|
| `EXPO_PUBLIC_FEATURE_ASSISTANT` | 自然言語の入力 | Edge Function「assistant」から Ollama に届く経路 |
| `EXPO_PUBLIC_FEATURE_GOOGLE_CALENDAR` | Google カレンダーの連携画面。`0` で非表示 | 接続にはサーバー側の OAuth 設定が必要 |
| `EXPO_PUBLIC_FEATURE_HOTPEPPER` | ホットペッパービューティー。`1` で再表示 | 現在は無効 |
| `EXPO_PUBLIC_FEATURE_EXTERNAL_PROVIDERS` | Square | OAuth のクライアントとシークレット |
| `EXPO_PUBLIC_FEATURE_RECEPTION` | 受付の案内文と、受付での Google カレンダーの照合 | Edge Function「door」のシークレット（`DOOR_API_BASE_URL`、`DOOR_API_KEY`、`DOOR_ALLOWED_HOUSEHOLD_IDS`） |
| `EXPO_PUBLIC_FEATURE_SOCIAL_LOGIN` | Apple と Google のログイン | Supabase の Auth の設定と、削除時の Apple のトークンの失効 |

審査で見られる点は次のとおり実装している。

| 項目 | 実装 |
|---|---|
| アカウントの削除（5.1.1(v)） | 設定タブの「アカウントを削除」 |
| ログイン（4.8） | 今はメールだけ。Apple と Google は `EXPO_PUBLIC_FEATURE_SOCIAL_LOGIN` で隠している |
| プライバシーポリシー（5.1.1(i)） | ログイン画面と設定タブのリンク。外部テストの手順は [docs/testflight.md](../docs/testflight.md) |
| 権限の文言 | カメラは招待の QR コードの読み取りだけに使う。マイクの権限は持たない |
| 暗号の申告 | `ITSAppUsesNonExemptEncryption` は false |

通知の受信は TestFlight のビルドで確かめる。シミュレーターでは本番の APNs に届かない。

## 外部の設定

| 対象 | 設定 |
|---|---|
| Supabase の Auth > URL Configuration | Redirect URLs に `tka2601://**` を足す（Google のログインから戻るため） |
| Supabase の Auth > Providers > Apple | 有効にし、Client IDs にバンドル ID（`com.atsushihosaka.monban`）を入れる |
| Supabase の Auth > Providers > Google | Google Cloud の Web 用 OAuth クライアントの ID とシークレットを入れる。Google 側の承認済みリダイレクト URI は `https://<ref>.supabase.co/auth/v1/callback` |
| Supabase の Auth > Providers > Email | メールの確認を有効にするなら、無料プランでは独自の SMTP が要る |
| Apple Developer | バンドル ID の App ID を作り、Sign in with Apple と Push Notifications を有効にする |
| Google Cloud のカレンダーの OAuth クライアント | 予約先の Google カレンダーに接続するために要る。設定は `supabase/README.md` にある |
| Square Developer Console のアプリ | 予約先の Square 予約にログインするために要る。Redirect URL に `<公開 URL>/square/callback`（HTTPS 必須）、Webhook に `<公開 URL>/square/webhook`（`booking.created`、`booking.updated`）を登録する。設定は `supabase/README.md` にある |
| EAS | プロジェクトは `@atsushihosaka/jphacks2026`（ID `886e1515-…`）。`app.json` の slug、owner、`extra.eas.projectId` を合わせてある。通知を送るには `npx eas-cli@latest credentials` で APNs のキーを登録する |

## 決まっていないこと

- 招待リンクのスキーム（`tka2601`）と Android のパッケージ名（`com.jphacks.tka2601`）を MONBAN に合わせるか
- 本体の Wi-Fi の設定をアプリから行う画面（BLE と Wi-Fi の設定。Issue #64）。今の初回の案内は、本体がクラウドに通信できる前提で、接続を待つだけである

## 試験

```bash
npm test
```

純粋な処理（エラーの文、日付と営業時間の規則、未読の判定、通知の種類のまとめ）、通信の形の変換（知らない値、壊れた案）、層の依存の向きを確かめる。
