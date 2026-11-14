# E84とM5Stack BasicのWi-Fi通信

E84とM5Stack Basicを同じ2.4 GHz Wi-Fiに接続し、UDPで通信します。E84のUARTから `t` を押すと、M5に共有トークン付きのpingを送り、同じID・トークンのpongが戻ることを確認します。マイク入力・録音・チャイム検知の確認は不要です。

M5側の受信ファームウェアは、隣の [`M5Stack_Basic_E84_Link`](../../M5Stack_Basic_E84_Link/README.md) にあります。画面にIPアドレスと受信回数を表示します。音声再生とサーボ制御は後から追加する範囲です。

## 1. M5側の設定を準備する

E84で接続できているWi-Fi設定を使います。iPhoneの場合は「ほかの人の接続を許可」「互換性を優先」を有効にし、接続が完了するまでインターネット共有の設定画面を開いておきます。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/PSOC_Edge_E84
python3 configure_m5.py --prepare-receiver
```

Python標準ライブラリだけで動きます。`source/wifi_config.h` のSSIDとパスワードを読み、M5側の `link_config.h` を生成します。Wi-Fi設定がまだなければ、先に `python3 configure_wifi.py --hotspot` を実行してください。

初回だけランダムな32バイトの共有トークンを生成し、`.m5-link.json` に保存します。この段階ではM5のIPアドレスは不要です。再実行しても既存トークン・UDPポートを引き継ぎ、資格情報は画面へ表示しません。APIキーをM5へコピーする必要はありません。

## 2. M5Stack Basicに書き込んでIPを確認する

M5Stack BasicをUSBで接続し、Arduino IDEなどで対象ポートを確認します。以下の `/dev/cu.usbserial-...` は実際のM5のポートに置き換えてください。E84のUSBポートとは異なります。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/M5Stack_Basic_E84_Link
bash run.sh upload /dev/cu.usbserial-...
```

M5の既存プログラムがこの受信プログラムに置き換わります。起動後、画面に `Wi-Fi: Connected`、`IP: ...`、`UDP: 8768 Ready` が出るまで待ちます。`IP` の値を次の手順で使います。M5のAボタン、または115200 baudのシリアルで `s` を押すと状態を確認できます。

## 3. E84へM5のIPを設定する

次の `172.20.10.4` は例です。**M5の画面に表示されたIP** に置き換えます。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/PSOC_Edge_E84
python3 configure_m5.py --host 172.20.10.4
make -j8 program
```

既存の共有トークンを使って `source/m5_config.h` を生成し、`source/m5_settings.h` の更新時刻を更新します。設定前にビルドしていた場合も、次のビルドでE84の送信先が反映されます。IPだけを変更した場合はM5の再書き込みは不要です。

`--port 8768` でUDPポートを指定できます。指定を省略すると既存値を維持し、初回は8768を使います。`--token-file /path/to/token.txt` は明示的にトークンを変更するときだけ使用します。ポート・トークン・Wi-Fi設定を変えた場合は両方のボードに再書き込みしてください。

## 4. 音声を使わず往復通信を確認する

E84のWi-Fi接続後、既に開いているE84の `screen` 画面で **`t`** を押します。Enterは不要です。

```text
[M5] Testing 172.20.10.4:8768; waiting for authenticated pong...
[M5] PONG received. E84 <-> M5Stack Wi-Fi communication OK.
```

同時にM5画面の `Ping` が増え、`Ping received / Pong sent` と表示されれば往復通信の確認完了です。M5のシリアルには `[LINK] Ping received; pong sent. peer=...` と出ます。pingは再試行を含め最大3回送信しますが、同じIDはM5の受信回数に重複計上しません。`t` は録音・チャイム通知・音声再生・サーボ動作を開始しません。

応答がない場合は、M5画面の最新IP、両方が同じWi-Fiへ接続されていること、両方へ同じ設定を書き込んだことを確認します。テザリングの再開などでM5のIPが変わったら、手順3を実行します。アクセスポイントが端末間通信を制限している場合は届かないため、端末間通信を許可した2.4 GHzルーターでも確認してください。

## 設定ファイルとPC受信

`.m5-link.json`、E84の `source/m5_config.h`、M5の `link_config.h` はGit対象外、権限は `0600` で保存します。設定変更は保存後の再ビルド・書き込みで反映されます。これらのファイルと資格情報を含むファームウェアは共有しないでください。Wi-Fiヘッダーは `configure_wifi.py` が生成する固定桁の8進数エスケープだけを解釈し、Cコードやマクロを実行しません。

PCでチャイム通知形式を確認する場合は、従来どおりPCのLANアドレスを `--host` へ指定して `python3 tools/m5_listener.py` を実行できます。このリスナーはチャイム用で、M5のping/pong確認の代わりにはなりません。M5受信設定を作成していない場合、`--host` によるPC用設定にWi-Fiヘッダーは不要です。PCのファイアウォールでは指定UDPポートのLAN受信を許可します。

## プロトコルv1

UTF-8 JSON 1個をUDPデータグラム1個にします。改行は付けません。共有トークンは64文字の小文字16進数、イベントIDは32文字の小文字16進数です。

```json
{"v":1,"type":"ping","event_id":"0123456789abcdef0123456789abcdef","token":"<64文字の共有トークン>"}
{"v":1,"type":"pong","event_id":"0123456789abcdef0123456789abcdef","token":"<64文字の共有トークン>"}
{"v":1,"type":"chime","event_id":"0123456789abcdef0123456789abcdef","score":0.18000,"token":"<64文字の共有トークン>"}
```

pingへの応答は上のキー順・空白なしの形式を使います。E84は送信先IP・UDPポート・イベントID・トークンが一致するpongのみ受け付けます。最大1500 msの間に500 ms間隔で3回試行し、専用M5通信タスクで待つため、API通信やコンソール操作を止めません。

チャイム検知時の `chime` は既存どおり同じ内容を3回送ります。`event_id` は録音アップロードと共通、`score` は有限のDTW距離です。M5はトークンを検証し、同じIDの受信を重複排除して画面の `Chime` に計上します。M5の重複排除は最大64件・10分、PCリスナーは最大1024件・10分です。チャイムへのACKはなく、`Submitted` はネットワーク処理へ渡せた数です。Wi-Fi切断中や送信失敗時のイベントを後から再送することはありません。録音の送信待ちは別に保持します。

宛先はプライベートIPv4の同じサブネット内にある別端末です。インターネットのIP、DNS名、マルチキャスト、`.0` / `.255`、E84自身、実際のサブネットのブロードキャスト宛先は受け付けません。UDPのトークンは暗号化されないため、信頼できるLANでの試作用です。

## ホストテスト

```sh
python3 -m unittest discover -s tests -p 'test_m5*.py' -v
```

宛先・トークン検証、2段階設定でのトークン維持、UTF-8と記号の入ったSSID、0600の権限、不正設定時の既存ファイル保持、初回設定後に古いビルドが再利用されないための更新処理を確認します。Cコンパイラがある場合は、生成ヘッダーをコンパイルしてSSID・パスワードのバイト列も確認します。

## 実機での確認結果（2026-10-17）

E84とM5Stack Basicの両方へ書き込み、iPhoneテザリング上で往復通信を確認しました。確認時のIPはE84が `172.20.10.3`、M5が `172.20.10.2`、UDPポートは8768です。DHCPで変わる可能性があるため、再設定にはその時点のM5画面のIPを使います。

E84の `t` 入力に対して、M5の `[LINK] Ping received; pong sent.` とE84の `[M5] PONG received. E84 <-> M5Stack Wi-Fi communication OK.` を確認しました。M5の状態は `ping=1 chime=0 duplicate=1 rejected=0` で、同じpingの再送を重複計上していません。音声とサーボの動作確認は行っていません。

関連するPythonテスト24件、M5側のASan/UBSan付きプロトコル・相互運用テスト295チェックが成功しています。E84のビルド・書き込み検証と、M5Core向けの設定済みArduinoビルド・書き込み検証も成功しています。
