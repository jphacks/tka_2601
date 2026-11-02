# MONBAN アプリ（Expo）

インターホン自動応答デバイスの店舗向けアプリ。予約の一覧とカレンダー、AI が受けた仮予約の承認、通知、来客の履歴、AI の受け答えの設定、動作モードの切り替えを行う。予約と通知の仕様は [docs/reservations.md](../docs/reservations.md) にある。画面は Claude Design のキャンバス（https://claude.ai/artifact/G9j5naxUGESrVJmT1pxSab ）に合わせている。裏側は [supabase/](../supabase/README.md)（PR #4）を使う。

## 構成

| パス | 内容 |
|---|---|
| `src/app/` | 画面（Expo Router）。`_layout.tsx` でログイン前・グループ未所属・所属済みの画面を分ける |
| `src/app/(tabs)/` | 下のタブ。予約（最初の画面）、来客、通知、設定 |
| `src/app/reservations/` | 予約の詳細、追加と編集、承認リスト |
| `src/app/assistant/` | 自然言語の入力と確認カード |
| `src/app/settings/` | 店舗情報、メニュー、受け答え、予約先、通知の種類、追加の指示、グループ、招待 |
| `src/components/` | ナビバー、背景のシェイプ、ボタン、確認ダイアログなどの部品 |
| `src/domain/` | 画面が使う型と、日付や営業時間などの純粋な規則 |
| `src/repositories/` | データの操作のインターフェース |
| `src/infrastructure/supabase/` | リポジトリの実装と、通信の形からドメインへの変換（`mappers.ts`） |
| `src/lib/container.ts` | どの実装を使うかを決める唯一の場所 |
| `src/lib/` | ログイン（`auth.tsx`、`authActions.ts`）、通知（`push.ts`）、タブの数字（`badges.tsx`）、表示の文言（`labels.ts`）、書式（`format.ts`） |
| `src/theme.ts` | 色。テーマ色は紺（#1F3A5F）だけ |

## 予約の読み書き

予約はどの予約先でも Edge Function「reservations」を通して読み書きする。Square の予約は読み取りだけで（`read_only`）、詳細では到着だけを記録できる。Square を予約先にしている間は予約タブの追加を出さない。アプリは予約を保存せず、画面を開くたびに読む。通知の種類の画面は `notification_kinds` の表から作るので、種類を足してもアプリの更新は要らない。

## リポジトリ層

画面と部品は `src/lib/container.ts` の `repositories` とドメインだけを読み、`src/infrastructure` と Supabase のクライアントを読み込まない（`tests/architecture.test.mjs` で確かめる）。ボイスエージェントの仕様が変わったら、`src/infrastructure/supabase/mappers.ts` を直す。知らない意図、対応、状態は、ここで `unknown` などに丸めて画面を落とさない。実装を差し替えるときは、インターフェースを実装して `container.ts` を替える。

## 予約の表示

日、週、月は [react-native-big-calendar](https://github.com/acro5piano/react-native-big-calendar) で描く（`src/components/ReservationCalendar.tsx`）。ネイティブの依存はない。予約を追加するときの日付は `@react-native-community/datetimepicker` で選ぶ。こちらはネイティブの依存なので、入れたあとは開発ビルドを作り直す。

## 自然言語の入力

入力した文は Edge Function「assistant」が読み取り、案を返す。アプリは案を確認カードに出し、店の人が「追加」か「変更」を押してから既存のリポジトリで書き込む。読み取れないときや届かないときは、入力フォームへ案内する。

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

`eas.json` の `submit.production` に `ascAppId` がないので、提出のときに聞かれる。CI で動かすなら App Store Connect のアプリの ID を入れる。

審査で見られる点は次のとおり実装している。

| 項目 | 実装 |
|---|---|
| アカウントの削除（5.1.1(v)） | 設定タブの「アカウントを削除」 |
| Sign in with Apple（4.8） | ログイン画面 |
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
- 本体をグループに結び付ける画面（Supabase の `claim_device(code)` にペアリングコードを渡す）。デザインにもアプリにもまだない

## 試験

```bash
npm test
```

純粋な処理（エラーの文、日付と営業時間の規則、未読の判定、通知の種類のまとめ）、通信の形の変換（知らない値、壊れた案）、層の依存の向きを確かめる。
