# CY8CPROTO-062-4343W Wi-Fi・Door API接続テスト

Wi-Fi接続、DHCPによるIPv4アドレス取得、玄関AIサーバーへのHTTPS通信を確認するプロジェクトです。
成功するとUARTに `[OK] Wi-Fi connected + DHCP OK. IP: ...` が10秒ごとに表示され、ユーザーLEDが点灯します。
続いて時刻を同期し、`https://door-api.shionkk.f5.si` の `/health` と `/v1/status` をGETします。
HTTPS通信も成功すると `[SERVER] HTTPS health and status checks passed.` と表示されます。
LEDはWi-Fiの状態を示します。サーバーとの通信結果はUARTで確認してください。
音声送受信、AI会話セッションの開始、iPhoneへの通知はまだ実装していません。

2026年10月17日、実機からiPhoneのテザリング経由で両APIへのHTTPS通信に成功しました。
`/health` はHTTP 200・`{"status":"ok"}`、`/v1/status` はHTTP 200・ASR/TTSともに `ready:true` を確認しました。
実測ログは `server-serial.log`、確認履歴は `connection-check.log` に保存しています。

## サーバー通信

- 接続先: [Door API](https://door-api.shionkk.f5.si/)、[公開APIドキュメント](https://door-api.shionkk.f5.si/docs)
- `GET /health`: HTTP 200と `{"status":"ok"}` の応答を検証します。
- `GET /v1/status`: HTTPステータスとモデルの準備状態を含むJSONを表示します。`ready:false` は通信失敗ではなく、そのモデルが未準備という意味です。
- この2つのGETはAPIキー不要です。会話を作成するPOSTは実行しません。
- 接続先は `source/door_server.c` に設定しています。
- 起動後のWi-Fi接続時に実行し、結果にかかわらず完了から約60秒後に再確認します。Wi-Fi切断後の再接続時にも再確認します。
- 通信成功後の `Last HTTPS health/status check: passed` は前回の検査結果です。新しい検査結果は `Check complete` で確認できます。

TLSはGoogle Trust ServicesのGTS Root R4を用いて、証明書チェーン・ホスト名・有効期間を検証します。
起動時に `time.google.com`、失敗時は `time.cloudflare.com` のNTP（UDP/123）でRTCを合わせます。
有効な時刻を取得できなければHTTPS処理は開始しません。NTP自体は暗号化・認証されないため、製品化時の時刻保護は別途検討が必要です。
CA更新が必要になった場合は `source/door_root_ca.h` を更新します。
HTTPの送受信タイムアウトは各10秒、TCP/TLS接続完了後の要求・応答処理は合計30秒です。DNS・TCP接続時間はライブラリ側の制御です。

## ブラウザで通信状態を監視する

基板をMacのUSBにつないだ状態で、次のコマンドを実行します。MacのPython 3標準ライブラリだけで動作します。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/WiFi_Connect
python3 monitor/monitor.py
```

ブラウザで [通信モニター](http://127.0.0.1:8766/) を開きます。起動したターミナルは開いたままにします。終了は `Ctrl+C` です。

- USB接続、Wi-Fi・IPアドレス、各APIのHTTP応答、最後の確認時刻、ASR/TTSの準備状態、実機ログを表示します。
- 表示は約1秒ごとに更新します。基板のWi-Fi状態は通常10秒ごと、APIへの実際の通信は確認完了から約60秒ごとです。
- 画面を開いた直後は次の実機ログを待ちます。新しいAPI応答が届くまでは成功と表示しません。起動時の電波強度・時刻同期ログも見たい場合は基板のRESETボタンを押してください。
- USB切断やログの停止、ブラウザから監視プロセスへの接続断は、過去の成功と区別して表示します。
- この画面はMacがUSBから読み取った基板の状態を表示します。遠隔のiPhoneから見るための公開監視サービスは含みません。

シリアルポートが複数ある場合は `--serial /dev/cu.usbmodemXXXXX` で指定します。ポート番号は `--port 8767` のように変更できます。
`screen` など別のソフトで同じシリアルポートを開いている場合は終了してから起動してください。

主なファイルは `monitor/monitor.py`（ログ受信・状態解析・HTTPサーバー）と `monitor/static/`（ブラウザ画面）です。

監視処理のテストは `python3 -m unittest discover -s monitor -p 'test_*.py' -v` で実行できます。
テストはUSBポートを開かず、接続断・古い応答・再起動・不正な応答の扱いなどを確認します。

## 準備

- 2.4 GHzの家庭用Wi-Fi。暗号化方式はWCMが自動判定します。まずはWPA2-Personal（AES）またはWPA2/WPA3混在モードで確認してください。5 GHzのみ、企業用認証やWebログインが必要なネットワークは、このテストの対象外です。
- 基板の **J8（KitProg3側）** とMacをデータ通信対応USBケーブルで接続します。
- ModusToolbox Programmerが接続中なら `Disconnect` し、終了します。
- 無線の国設定は日本です。

### iPhoneのテザリングを使う場合

1. iPhoneの「設定 → インターネット共有」を開きます。
2. 「ほかの人の接続を許可」をオンにします。
3. 「互換性を優先」が表示される機種では、これもオンにします。
4. その画面を開いたまま、基板のRESETボタンを押して接続を確認します。

「互換性を優先」は2.4 GHz・WPA2-Personalに切り替える設定です。
基板が起動時に判定した認証方式を更新できるよう、iPhone側の設定変更後は基板をリセットしてください。
[Appleの設定手順](https://support.apple.com/ja-jp/119837)・[互換性モードの仕様](https://support.apple.com/ja-jp/guide/security/secfd166f620/web)

## 設定・書き込み

Macのターミナル、またはVS Codeのターミナルで実行します。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/WiFi_Connect
python3 configure_wifi.py
make -j8 program
```

設定時にWi-Fi名とパスワードを入力します。パスワードは画面に表示されません。
設定は `source/wifi_config.h` に保存され、Gitの対象から除外されます。チャットへの貼り付けは不要です。
このファイルと、パスワードを含む書き込み用バイナリは共有しないでください。
初期状態は未設定です。設定を変更した場合は、もう一度 `make -j8 program` を実行します。

## 接続結果を読む

UARTは **115200 bps / 8 data bits / parity none / 1 stop bit / flow control none** です。
Macでは、次のコマンドで接続できます（KitProg3のシリアルポートが1個の場合）。

```sh
screen /dev/cu.usbmodem* 115200
```

画面が空でも最大10秒待つか、基板のRESETボタンを押してください。
成功時の表示例です。実際のIPアドレスはルーターが割り当てます。

```text
[Wi-Fi] Connecting (attempt 1, 2.4 GHz / security auto-detect)...
[OK] Wi-Fi connected + DHCP OK. IP: 192.168.1.123
[SERVER] /health HTTP 200; body (15 bytes): {"status":"ok"}
[SERVER] HTTPS health and status checks passed.
```

終了するときは `Ctrl+A` を押して離し、`K`、`y` の順に押します。
ポートが複数ある場合は `ls /dev/cu.usbmodem*` で確認し、上記の `*` をKitProg3の実際のポート名に置き換えてください。

## 接続に失敗する場合

- `[SETUP]`：`python3 configure_wifi.py` で設定し、再度書き込みます。
- 起動時の `[SCAN] Configured network found` に接続先のチャンネル、電波強度、暗号化方式が表示されます。Wi-Fi名やパスワードは表示しません。
- `Connect failed: 0x...`：SSIDとパスワード、ルーターの認証・接続制限の設定を確認します。5秒後に自動再試行します。
- `0x020003ee` は認証未完了（WHD_NOT_AUTHENTICATED）です。パスワード誤りとは断定せず、スキャン結果とルーター設定を確認します。
- LED消灯、`[WAIT]`：接続が切れたかIPアドレス取得待ちです。初回成功後の再接続はWCMが処理します。
- 書き込み時にKitProg3を開けない：Programmerや別のデバッグ接続を終了してください。
- シリアルポートが出ない：J8を使っているか、ケーブルが充電専用でないか確認します。
- `[TIME]`で失敗：インターネット接続とDNS、UDP/123の通信可否を確認します。
- `[SERVER]`のTLS接続失敗：RTCのUTC時刻、インターネット接続、CA証明書を確認します。証明書検証を無効にして回避しないでください。
- HTTP 401/403/5xx：接続先のアクセス制限やサーバー状態を確認します。

この基板のユーザーボタンはWi-Fiのhost wakeとピンを共有するため、このテストでは使用しません。

## 元のサンプル

[Infineon Wi-Fi Scan](https://github.com/Infineon/mtb-example-wifi-scan)から作成しました。
依存ライブラリ・FreeRTOS設定・BSPを利用し、アプリケーションを接続テストに変更しています。
元の説明は `README.upstream.md`、ライセンスは `LICENSE` にあります。
接続APIは [Wi-Fi Connection Manager](https://infineon.github.io/wifi-connection-manager/api_reference_manual/html/group__group__wcm__functions.html) を使っています。
