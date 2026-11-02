# TestFlight の外部テスト

外部テスターへの配布に必要な作業と、App Store Connect に入れる文面をまとめる。ビルドとアップロードの手順は [mobile/README.md](../mobile/README.md) にある。

## 状態

| 項目 | 値 |
|---|---|
| App Store Connect のアプリ | ID `6829702081`、バンドル ID `com.atsushihosaka.monban` |
| 公開するプライバシーポリシー | https://jphacks.github.io/tka_2601/privacy.html（原稿は [privacy.html](privacy.html)） |
| 外部テストで隠す機能 | Apple と Google のログイン、Google カレンダーと Square、自然言語の入力 |

隠す機能は `EXPO_PUBLIC_FEATURE_*` で切り替える（[mobile/README.md](../mobile/README.md)）。

## 配布までの手順

1. 原稿を変えたら、`gh-pages` ブランチの `privacy.html` も同じ内容に更新する。GitHub Pages はこのブランチから公開している。
2. リポジトリの根で `deno run --allow-read --allow-run --allow-net --allow-env supabase/scripts/create_review_account.ts --cloud` を実行する。審査用のアカウント、お店、本体の行、デモデータができる。パスワードは初回に1回だけ表示される。
3. EAS で production のビルドを作り、App Store Connect に上げる。
4. TestFlight の Test Information に下の文面を入れる。
5. 外部グループを作ってビルドを追加し、審査に出す。

## App Store Connect の文面

### Beta App Description

MONBAN は、個人経営のネイルサロンやマッサージ店、塾など小規模なお店のためのアプリです。インターホンに取り付ける本体が来客に応対し、その記録と予約をアプリで確かめられます。

このベータ版は本体がなくても、予約の管理を試せます。

### What to Test

- 予約の追加、変更、キャンセル
- 一覧、日、週、月の表示の切り替え
- 仮予約の確定とお断り
- メニュー、営業時間、受け答えの設定
- 通知の種類ごとのオンオフ

### Review Notes

```text
MONBAN is an app for small shops (nail salons, massage shops, cram schools).
A hardware unit attached to the shop's intercom answers visitors with AI and
records the visits and reservations. This app shows them to the shop owner.

The review team does not need the hardware. The demo account in the sign-in
information already has sample reservations, visit records and notifications,
so every screen has data. The app is available in Japanese only.

How to review:
1. Log in with the demo account.
2. Reservations tab: tap "+" to add one. Switch list, day, week and month views.
   Under the next reservation, approve or decline the framed pending reservation.
3. Visits and Notifications tabs: open an item to see the sample data.
4. Settings tab: change the shop settings. The privacy policy and account
   deletion are also here.

Visitor handling requires the hardware, so it cannot be tested without it.
Account deletion is in the Settings tab. It removes the demo account and its
sample data, so please test it last.
```

### Sign-In Information

ユーザー名は `appreview@example.com` で、パスワードは `create_review_account.ts` が初回に表示したものを使う。

審査用のアカウントのパスワードは、App Store Connect の Sign-In Information の欄にだけ入れる。このリポジトリには書かない。審査が長引いて日付が古くなったら、同じコマンドをもう一度実行する。パスワードは変わらず、デモデータの日付だけが今日を基準に更新される。審査でアカウントが削除されていたら、同じコマンドで新しいパスワードのアカウントができる。

## 外部テストのあとで残すこと

- 新しいアカウントの登録には確認メールが要る。テスターが自分で登録できるようにするには、独自の SMTP を設定する。それまでは審査用のアカウントで試してもらう。
- 機能を有効にするときは、プライバシーポリシーの第 1 節と第 3 節に、送る先と情報を足す。自然言語の入力、Google カレンダー、Square がこれに当たる。
- Apple のログインを有効にするときは、アカウントの削除でトークンを失効させる処理を先に作る。
- 本体をお店に結び付ける画面（`claim_device`）はまだない。テスターが本体を使うには、この画面が要る。
