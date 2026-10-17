# 住人アプリ（Expo）

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

`.env` を書き換えたら Metro を起動し直す。

## 外部の設定

| 対象 | 設定 |
|---|---|
| Supabase の Auth > URL Configuration | Redirect URLs に `tka2601://**` を足す（Google のログインから戻るため） |
| Supabase の Auth > Providers > Apple | 有効にし、Client IDs にバンドル ID（`com.jphacks.tka2601`）を入れる |
| Supabase の Auth > Providers > Google | Google Cloud の Web 用 OAuth クライアントの ID とシークレットを入れる。Google 側の承認済みリダイレクト URI は `https://<ref>.supabase.co/auth/v1/callback` |
| Supabase の Auth > Providers > Email | メールの確認を有効にするなら、無料プランでは独自の SMTP が要る |
| Apple Developer | バンドル ID の App ID を作り、Sign in with Apple と Push Notifications を有効にする |
| EAS | プロジェクト ID（`886e1515-…`）は `app.json` の `extra.eas.projectId` に入れてある。通知を送るには `npx eas-cli@latest credentials` で APNs のキーを登録する |

## 決まっていないこと

- アプリ名（画面には `[アプリ名]` と出している）とバンドル ID（仮に `com.jphacks.tka2601`）
- 本体をグループに結び付ける画面（Supabase の `claim_device(code)` にペアリングコードを渡す）。デザインにもアプリにもまだない
