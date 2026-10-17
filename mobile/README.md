# MONBAN 住人アプリ（Expo）

インターホン自動応答デバイスの住人向けアプリ。来客の履歴、即時通知、動作モードの切り替えを行う。画面は Claude Design のキャンバス（https://claude.ai/artifact/G9j5naxUGESrVJmT1pxSab ）に合わせている。裏側は [supabase/](../supabase/README.md)（PR #4）を使う。

## 構成

| パス | 内容 |
|---|---|
| `src/app/` | 画面（Expo Router）。`_layout.tsx` でログイン前・グループ未所属・所属済みの画面を分ける |
| `src/components/` | ナビバー、背景のシェイプ、ボタン、確認ダイアログなどの部品 |
| `src/lib/` | Supabase の読み書き（`api.ts`）、ログイン（`authActions.ts`）、通知（`push.ts`）、表示の文言（`labels.ts`） |
| `src/theme.ts` | 色。テーマ色は紺（#1F3A5F）だけ |

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

## 外部の設定

| 対象 | 設定 |
|---|---|
| Supabase の Auth > URL Configuration | Redirect URLs に `tka2601://**` を足す（Google のログインから戻るため） |
| Supabase の Auth > Providers > Apple | 有効にし、Client IDs にバンドル ID（`com.jphacks.tka2601`）を入れる |
| Supabase の Auth > Providers > Google | Google Cloud の Web 用 OAuth クライアントの ID とシークレットを入れる。Google 側の承認済みリダイレクト URI は `https://<ref>.supabase.co/auth/v1/callback` |
| Supabase の Auth > Providers > Email | メールの確認を有効にするなら、無料プランでは独自の SMTP が要る |
| Apple Developer | バンドル ID の App ID を作り、Sign in with Apple と Push Notifications を有効にする |
| EAS | プロジェクトは `@atsushihosaka/jphacks2026`（ID `886e1515-…`）。`app.json` の slug、owner、`extra.eas.projectId` を合わせてある。通知を送るには `npx eas-cli@latest credentials` で APNs のキーを登録する |

## 決まっていないこと

- バンドル ID（仮に `com.jphacks.tka2601`）と招待リンクのスキーム（`tka2601`）を MONBAN に合わせるか
- 本体をグループに結び付ける画面（Supabase の `claim_device(code)` にペアリングコードを渡す）。デザインにもアプリにもまだない
