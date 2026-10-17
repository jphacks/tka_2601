# M5Stack BasicとPSOC Edge E84のWi-Fi通信

E84から届く音声を順次再生し、通話・終了ボタン用サーボを動かすM5Stack Basic用Arduinoファームウェアです。従来のUDP ping/chime表示も残しているため、音声入力なしでWi-Fi通信だけを確認できます。API接続と録音はE84が担当します。

## 設定と書き込み

まずE84で接続できているWi-Fi設定から、M5の設定を作成します。Pythonの追加パッケージは不要です。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/PSOC_Edge_E84
python3 configure_m5.py --prepare-receiver
```

このディレクトリに `link_config.h` が生成されます。SSID・パスワードと、E84と共有するランダムなトークンを含みます。Git対象外で、コマンドの出力には資格情報を表示しません。M5へAPIキーを設定する必要はありません。

M5Stack BasicをUSB接続し、Arduino IDEなどでポート名を確認します。次の `/dev/cu.usbserial-...` を実際のM5のポート名に置き換えてください。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/M5Stack_Basic_E84_Link
bash run.sh build
bash run.sh upload /dev/cu.usbserial-...
```

`upload` はビルドも行います。書き込むとM5の既存プログラムが置き換わります。このMacのArduino IDE付属CLI、ボード **M5Core**（`m5stack:esp32:m5stack_core`）、M5Unified/M5GFXを使います。Arduino IDEで同名の `.ino` を開いて書き込むこともできます。設定ヘッダーを初めて作成した場合も反映されるよう、`run.sh` はクリーンビルドします。

M5画面で `Wi-Fi: Connected`、`IP: ...`、`UDP: 8768 Ready`、`TCP: 8769 Ready` を確認します。TCPポートは設定したUDPポート+1です（UDPは1024〜65534）。表示されたIPをE84へ設定します。以下の `172.20.10.4` は例です。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/PSOC_Edge_E84
python3 configure_m5.py --host 172.20.10.4
make -j8 program
```

共有トークンは最初に作成した値を引き継ぎます。IPだけの変更ならM5の再書き込みは不要です。UDPポート・トークン・Wi-Fi設定を変更した場合は、両方へ再書き込みします。詳細は [E84側の設定手順](../PSOC_Edge_E84/docs/m5-link.md) を参照してください。

## 通信確認

E84がWi-Fiへ接続した後、E84のUART画面で `t` を押します。Enterは不要です。次のログが出ればE84からM5への送信と返信の両方を確認できています。

```text
[M5] PONG received. E84 <-> M5Stack Wi-Fi communication OK.
```

M5画面の `Ping` が増えて `Ping received / Pong sent` と表示されます。`Chime` はチャイム通知の受信回数です。重複したIDは受信回数へ追加せず、pingの再試行には返信します。UDPのping/chimeだけでは音声やサーボは動かしません。

M5のAボタン、またはM5の115200 baudシリアルで `s` / `h` を押すと接続状態を表示します。通信が切れた場合は自動再接続し、IP変更時にはUDPの待ち受けを再開します。M5のIPが変わったらE84側の `--host` を設定し直してください。

iPhoneではE84と同じインターネット共有へ接続し、「互換性を優先」を有効にします。端末間通信が制限されたネットワークでは応答が届かないため、その場合は端末間通信を許可した2.4 GHzルーターで確認します。

## 音声ストリーミング

E84がTCPに接続し、ペアリングトークンで認証してから通話を開始します。音声はPCM16LE、16kHz、モノラル、最大20ms/640バイトのフレームです。詳細は [共通プロトコル](../PSOC_Edge_E84/docs/voice-stream-protocol.md) を参照してください。

- 64フレーム（最大1.28秒、約40KiB）を上限に保持し、満杯ならTCP読み込みを止めます。受信してキューに入った音声だけをACKします。
- 10フレーム（通常200ms）を蓄えてからスピーカーへ渡します。短い返答は `OUTPUT_END` 到着時に再生します。
- `OUTPUT_END` が届き、全PCMの再生要求が終了し、192kHz/8×256サンプルのDAC出力に対して30msの排出待ちを終えて初めて `PLAYBACK_DONE` を返します。音声生成の終了、無音、受信中断だけでは完了扱いにしません。
- PCMバッファは非同期スピーカータスクが参照し終えるまで再利用しません。音声中は画面描画を控えます。
- 最大3000フレーム（20msフレームなら60秒）の返答を受け付けます。音声受信が15秒止まった場合、途中パケット/返信送信/再生が5秒進まない場合、接続が180秒無活動の場合はエラーとして切断します。
- 切断・キャンセル時はスピーカータスクとI2Sを停止してからバッファを解放します。E84は再生完了通知がない限り次の録音へ進めません。

## サーボ配線のサンプル設定

サーボ2台で別々のボタンを押す初期設定です。通話操作を受信するまでPWMを出さないので、起動だけでサーボは動きません。

| 対象 | M5Stack Basic側 |
| --- | --- |
| 通話ボタン用サーボの信号 | GPIO26 |
| 終了ボタン用サーボの信号 | GPIO17 |
| サーボGND | 外部電源GNDとM5のGNDを共通接続 |
| サーボ電源 | サーボ仕様に適した外部5V電源 |

GPIO25は内蔵スピーカーが使うため割り当てません。[M5公式Basicピン配置](https://m5stack.oss-cn-shenzhen.aliyuncs.com/resource/docs/static/pdf/static/en/core/BASIC%20v2.6.pdf)で、GPIO26とGPIO17の端子位置を確認できます。ここでのGPIO17割り当ては **Basic** 向けです。Fireなどの別機種へそのまま適用しないでください。

`servo_config.example.h` が標準設定です。サンプルは50Hz、待機0°→押下45°を500ms保持→待機0°へ500ms戻してPWMを停止します。角度は1000〜2000µsを0〜180°へ割り当てた指示値であり、実際の回転角はサーボによって異なります。ホーンを外した状態で確認してから、ボタンへの当たり方に合わせて調整してください。

設定を変えるときは、次のファイルを作って編集し、再ビルドします。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/M5Stack_Basic_E84_Link
cp servo_config.example.h servo_config.h
```

`M5_SERVO_CALL_PIN` / `M5_SERVO_END_PIN`、角度、パルス範囲、待機時間を変更できます。使える信号GPIOは16/17/26です。同一ピンを両方へ指定すれば、同じボタンを押すサーボ1台にもできます。`servo_config.h` はGit対象外です。

サーボを接続する前に通話・音声だけを試す場合は、`servo_config.h` を **`M5_SERVO_ENABLED 0`、`M5_SERVO_MANUAL_TEST 1`** にします。通話ボタンを人が押してからM5のAを押すと開始完了、終了ボタンを人が押してからM5のCを押すと終了完了を返します。確認を60秒以内に行わなければ中断します。両方0では `servo_disabled` エラーを返し、押していないボタンを完了扱いにはしません。

同じ通話内の操作再送ではサーボを重ねて動かしません。切断後に同じ通話IDで再接続する要求も直近64件について拒否します（RAM記録なので再起動で消えます。E84は通話IDを再利用しません）。実サーボモードで通話押下後に通信が切れた場合は、音声を停止し、サーボを待機位置へ戻してから終了ボタンを一度押します。これはPWM動作完了の確認で、実際にインターフォンが通話状態になったかを検出するセンサーはありません。

接続が生きている状態で `CANCEL` が届いた場合は、音声を停止してから終了ボタンを操作し、`CALL_ENDED` を返すまでTCPを保持します。通話ボタンをまだ操作していない場合はサーボを動かさず完了を返します。押下途中なら待機位置へ戻してから終了操作へ移ります。手動テスト中のキャンセルは、終了ボタンを人が押してM5のCで確認する必要があります。

## 検証

```sh
bash tests/run.sh
bash run.sh build
```

ホストテストは旧UDPとの互換性、破損/重複PCM、音声の順序、キュー満杯時の受信停止、短い音声、終了通知と30ms待ち、サーボ再送、切断時停止を検証します。ASan/UBSanを有効にしています。音量・残響・実サーボの角度・実機連続通話は配線後に確認してください。

## ファイル

- `M5Stack_Basic_E84_Link.ino`：Wi-Fi接続・再接続、UDP待ち受け、画面表示。
- `link_protocol.cpp` / `link_protocol.h`：受信データの検証、トークン照合、重複排除、pong生成。
- `stream_protocol.cpp` / `stream_protocol.h`：DVS1フレーム、通話状態、PCMキュー、通話ID重複防止。
- `stream_receiver.cpp` / `stream_receiver.h`：TCP受信、スピーカー再生、完了通知、サーボ動作。
- `servo_config.example.h`：GPIO26/17のサンプル配線、サーボ設定、手動テストモード。
- `link_config.h`：ローカル専用のSSID・パスワード・ポート・トークン。E84の設定スクリプトから生成します。
- `run.sh`：M5Core向けビルド・書き込み。

UDP/TCPの共有トークンは平文で送信するため、信頼できるLANで使用します。資格情報を含む設定ファイルやビルド済みファームウェアは共有しないでください。
