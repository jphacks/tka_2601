# PSOC Edge E84：チャイム検知・Wi-Fi・FastAPI通信

**KIT_PSE84_AI専用**の独立したModusToolboxプロジェクトです。最新の `tka_2601/Audio_Record` の基準音照合とHTTPS録音送信を移植しました。E84は検知・収音・通信を担当します。音声出力とサーボはM5Stack側の担当とし、このファームウェアには含めていません。

実装と確認範囲：

| 機能 | E84での動作 |
|---|---|
| Wi-Fi | 日本設定、2.4 GHz、認証方式自動選択またはテザリング用WPA2、DHCP、切断後の再接続 |
| FastAPI状態確認 | 既存の `GET /api/status`、Bearer認証、HTTPS/443。約60秒間隔 |
| チャイム検知 | 内蔵PDMマイク右ch（PDM0 ch3）、16 kHz・16bit・mono。既存 `original.m4a` 由来の特徴列とログメル＋DTWで照合 |
| 録音 | 検知音の約1秒前〜約1秒後、最大6秒。UART操作で5秒録音も可能 |
| 録音送信 | HTTPSでWAVをPUT。サーバーから同じイベントIDのACKが返るまで保持・再試行 |
| M5Stack Basic連携 | 同じLANのM5へトークン付きUDP通知。UARTの `t` でping/pongの往復通信を確認 |
| 音声会話 | WSSで20ms単位に送信、最大30秒／発話後の無音1.2秒で確定。返答をTCPでM5へ中継し、実再生完了後に次の録音へ |
| 通話進行 | チャイム→M5通話ボタン→挨拶→録音と再生の繰り返し→M5終了ボタン。UART `c` 開始、`q` 終了 |

2026-10-18に、3コアのビルドと実機への書き込み・照合、Wi-Fi、認証付きHTTPS状態確認、M5へのUDP ping/pong、既存サーバーからの挨拶をM5で実再生するところまで確認しました。マイクもch3へ修正後に生PCMとRMSの変化を確認しています。**訪問者の発話から返答までの連続通話は引き続き実機確認が必要**です。[導入と確認手順](docs/voice-stream.md)

## 役割と元の実装との差

- **CM33 Secure**：公式サンプルのセキュア起動。
- **CM33 Non-secure**：Wi-Fi、NTP、TLS、FastAPI、録音送信、UART、M5通知。
- **CM55**：連続PDM取得、チャイム検知、録音。通信が待機中でも取得を続けます。
- 両コアはBSPで予約済みの256 KiB共有領域を使います。録音キューは別のCM55 SoCMEM領域です。共有データの可視性を保証するため、この版ではCM55 D-cacheを無効にしています。

**送信待ちはRAMに最大5件です。電源断・リセットで消えます。** PSoC 6版の外部フラッシュ保存をそのまま使うと、E84では実行中の外部フラッシュと衝突するため、この版はフラッシュの消去・録音保存を行いません。キューが満杯なら古い未送信録音を上書きせず、新しい録音を破棄して `discarded` に計上します。チャイム検知は継続します。

音声会話はGitHub `backend/voice-agent` と同じ既存の `/api/relay`（v1）を既定で使用します。開始JSONと16kHz PCMを送り、`ready`、`agent_state`、確定文字起こしとPCMを受信します。サーバー側の更新は不要です。ローカルの拡張バックエンドを使う場合は `VOICE_RELAY_PROTOCOL=2` を明示できます。上記の6秒WAV保存・PUT送信は従来の診断用経路で、30秒の会話とは別です。通話中は従来の録音・アップロードを停止します。サーボPWMと保存した角度はM5側で管理します。[設定・反映手順](docs/voice-stream.md)

## ビルド

このMacでは必要なBSPと依存ライブラリを取得済みです。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/PSOC_Edge_E84
make -j8 build
```

統合された書き込み用ファイルは `build/app_combined.hex` です。単一コアのHEXではなく、全体をビルドしてください。ターゲット名 `APP_KIT_PSE84_AI` は、公式 `KIT_PSE84_AI` BSP 1.4.0を複製したローカルBSPです。CM55録音RAM用セクションと、共有領域の配置をリンカに追加しています。

別のPCではModusToolbox 3.9とGCC_ARM 14.2.1を用意して、先に `make getlibs` を実行します。BSPと依存バージョンはこのプロジェクト内で管理します。`bsps/` を削除・別BSPに置換するとメモリ配置も失われるため、通常のライブラリ更新とは分けてください。現在のカスタムリンカはGCC_ARM向けです。

## 接続設定

### Wi-Fi

```sh
python3 configure_wifi.py
```

SSIDとパスワードをローカルで入力します。`source/wifi_config.h` に保存されます。初期状態の資格情報は空です。未設定でもマイク取得とチャイム検知は動作し、送信待ち録音はRAMに保持します。

### スマートフォンのテザリング

1. スマートフォンのWi-Fiテザリングを有効にします。iPhoneでは「インターネット共有」の「ほかの人の接続を許可」をONにし、表示される機種では「互換性を優先」もONにします。接続が完了するまで、その設定画面を開いておきます。[Appleの接続手順](https://support.apple.com/ja-jp/119837)
2. Androidでは、アクセスポイントの設定を **2.4 GHz / WPA2-Personal（AES）** にします。項目名・設定の可否は機種によります。このテザリング用設定はWPA3専用モードには対応しません。
3. 次のコマンドで、**スマートフォン側のSSIDとパスワード**を入力して書き込みます。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/PSOC_Edge_E84
python3 configure_wifi.py --hotspot
make -j8 program
```

`--hotspot` は、暗号化方式の自動探索を省き、WPA2-AESで接続する設定を生成します。iPhoneの「互換性を優先」は2.4 GHzとWPA2を使用します。[Appleのセキュリティ説明](https://support.apple.com/ja-jp/guide/security/secfd166f620/web)

UARTに `[Wi-Fi] Hotspot mode` が出て、その後 `[OK] Wi-Fi connected + DHCP OK. IP: ...` が出ればWi-Fi接続完了です。最初に見つからないときは接続処理が失敗してから5秒待って再試行します。接続後に切れたときはWCMの自動再接続を待ち、切断が60秒続いた場合にはアプリ側からも接続をやり直します。スマートフォンの共有を再開すれば、E84をリセットせず再試行できます。切断中もCM55でのチャイム検知・録音は継続します。

FastAPIのホスト・認証・CA設定は別途必要です。スマートフォンの携帯回線から到達できるHTTPSサーバーを指定してください。M5通知も使う場合はM5を同じテザリングに接続し、割り当てられたIPで `configure_m5.py` を再設定します。端末同士の通信を制限するテザリング環境ではUDP通知は届きません。

通常のWi-Fi設定へ戻す場合は、`python3 configure_wifi.py` をオプションなしで実行して再ビルド・書き込みします。従来の設定ヘッダーも、そのまま自動探索モードで利用できます。設定変更はスクリプトの入力・確認後にだけ保存されます。

### 既存のFastAPI

**このプロジェクト直下の `PSOC_Edge_E84/.env`** に設定します。ファイルがなければ `.env.example` をコピーし、以下の2項目を入力してください。既存の `.env` は上書きしないでください。

```dotenv
DOOR_UI_HOSTNAME=door-ui.shionkk.f5.si
DOOR_API_KEY=ここにサーバー側と同じAPIキーを入力
```

ホスト名に `https://`・ポート・パスは付けません。キーは32〜511文字のBearerトークンです。入力後、次を実行します。

```sh
cd /Users/fukawanozomi/Documents/ChatGPT/jphacks/PSOC_Edge_E84
python3 -m pip install python-dotenv
python3 configure_api.py
make -j8 program
```

`configure_api.py` は実行したディレクトリにかかわらず、スクリプトと同じ場所の `.env` を読みます。別のファイルを使う場合は `--env /path/to/.env` を指定できます。親ディレクトリや別プロジェクトの設定は自動では読みません。

設定保存後は、ビルドが参照する `source/api_settings.h` の更新時刻も更新します。設定なしで一度ビルドしていた場合も、次の `make -j8 program` でAPI通信部分が再コンパイルされます。

生成先は `source/api_config.h`。`.env` はPC上でヘッダーに変換してファームウェアに組み込むため、**`.env` の編集後は上記の設定反映と再書き込みが必要**です。既定ホストは `door-ui.shionkk.f5.si`、呼び出し先は `/api/status` です。ボードではNTPでRTCを合わせてから、証明書チェーン・ホスト名・期限を検証します。状態確認用CAは `source/door_root_ca.h` にあります。

### 録音受信API

実際のFastAPI受信アプリを `tools/fastapi_receiver.py` に同梱しています。[起動・HTTPS公開・API仕様](docs/fastapi-receiver.md)に従って、受信先を用意します。公開・デプロイ自体は行っていません。

その受信先のホストを `AUDIO_UPLOAD_HOST`、受信APIと共通のトークンを `AUDIO_RECEIVER_TOKEN` 環境変数にローカルで設定し、信頼するルートCAのPEMファイルを指定します。

```sh
python3 configure_upload.py --ca /path/to/receiver-root-ca.pem
```

生成先は `source/upload_config.h`。接続はHTTPS/443固定です。FastAPIの開発用HTTPポートへ直接は接続しません。未設定では送信せず、RAMキューに保持します。

### M5Stack BasicとのWi-Fi通信

```sh
python3 configure_m5.py --prepare-receiver
```

既存のE84 Wi-Fi設定から、隣の [`M5Stack_Basic_E84_Link`](../M5Stack_Basic_E84_Link/README.md) の受信設定を生成します。M5へ書き込んで画面に出たIPを確認し、次を実行します。IPは例なので実際のM5の値に置き換えてください。

```sh
python3 configure_m5.py --host 172.20.10.4
make -j8 program
```

E84のWi-Fi接続後にUARTで `t` を押すと、M5へpingを送り、共有トークンを検証したpongが戻るか確認します。音声入力・録音の確認は不要です。成功ログは `[M5] PONG received. E84 <-> M5Stack Wi-Fi communication OK.`。M5側の画面にも受信回数を表示します。[書き込み・通信仕様・確認手順](docs/m5-link.md)を参照してください。

共有トークンは初回だけ生成し、再実行時は維持します。M5のIPだけを変更する場合はE84の再設定・再書き込みで反映します。チャイムのUDP通知自体には到達確認がなく、M5側は同じイベントIDを重複排除します。オフライン中や送信失敗したイベントは再接続後に再実行せず、録音は別に保持・再送します。

`.env`・設定用ヘッダー・`.m5-link.json` はGit対象外です。設定を変更した後は再ビルド・書き込みが必要です。これらのファイルと資格情報を含むファームウェアは共有しないでください。

## 書き込みと確認

E84の**KitProg3側USBコネクタ**をデータ通信対応ケーブルでMacにつなぎ、このプロジェクトのディレクトリで実行します。

```sh
make -j8 program
```

選択したE84の既存ファームウェアが置き換わります。M5Stackのプログラムは書き換えません。複数のKitProgが接続されているときは、対象のE84だけを接続して実行してください。

UARTは115200 baud / 8-N-1です。ポート名を確認して開きます。

```sh
ls /dev/cu.usbmodem*
screen /dev/cu.usbmodemXXXXXXXX 115200
```

起動時には `[BOOT]` で共有メモリ、CM55、タスク、Wi-Fi GPIO/SDIO、WCM、ソケットの初期化段階を表示します。`Wi-Fi driver ready` は無線ドライバーの初期化完了、`[OK] Wi-Fi connected + DHCP OK` はアクセスポイントへの接続完了です。

2026-10-17の旧版でバナー後に停止する問題は、実機の故障レジスタからWi-FiリセットGPIOの未初期化と特定しました。E84のMTB HALでは、WCMへGPIO・SDIOオブジェクトを渡す前にアプリ側で初期化する必要があります。`source/e84_wifi_hw.c` にSD Host、GPIO、割り込みの初期化を追加済みです。この修正版も再ビルド・書き込みが必要です。

起動約1秒後から基準チャイムを照合します。内蔵マイクの近くで元のインターホン音を鳴らし、`[DETECTED]` を確認します。検知後約1秒で録音がキューに入り、受信APIで保存されると `[UPLOAD] Server acknowledged` が表示されます。単にHTTP送信を開始しただけでは録音を解放しません。

| UART入力 | 動作 |
|---|---|
| `t` | M5Stack Basicとping/pongで往復通信確認。マイク入力不要 |
| `c` | 実サーバーとM5を接続して音声通話を開始（M5の保存角度で通話ボタンを操作） |
| `q` | 通話を終了し、終了ボタンを操作 |
| `r` | 5秒間録音。チャイムを鳴らさず送信確認する用途 |
| `x` | 進行中の録音を取消。送信待ちは保持 |
| `e` | 照合履歴をリセットして再待機。再学習は不要 |
| `s` | 検知数、キュー件数、破棄数、音量、距離、取り込み欠損を表示 |
| `h` / `?` | 操作説明 |

コマンドは1文字で受け付け、Enterは不要です。録音中は `r` による手動録音へ切り替わります。`state=1` が取得中、`state=2` はマイク初期化失敗または1秒以上データが届かない状態です。`pcm=min..max` は直近20msの生PCMの最小・最大値です。BSPはP8.5をPDM_CLK3へ接続しているためch3を有効にします。ch2だけを有効にしていた版では `pcm=0..0` とRMS=0が続くことを実機で確認しました。`gaps` / `drops` が増える場合は欠損した照合・録音を捨てます。基準音をテレビなどから鳴らした場合も音響上は区別できません。

## テストとソース

```sh
# FastAPIのテストも行う場合
python3 -m pip install -r tools/requirements-receiver.txt
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Python 3.11以降とclangを使用します。録音状態の統合テストは実際のDSPと基準WAVを使い、ASan/UBSan付きで実行します。元の長い録音ファイルを必要とする追加テスト1件は、そのファイルがない環境ではskipします。実機の音響・無線品質を検証するテストではありません。

最終全体確認はPython 3.12で **71件実行、70件成功・任意フィクスチャ1件skip**。テザリング設定の生成、UTF-8のSSID、従来設定との互換性、切断・復帰・再試行間隔・時計の周回も確認しています。Wi-Fiハードウェア初期化はHAL/WCMスタブを使い、GPIO・SDIOの準備、失敗時の中断、割り込みから使うオブジェクトの寿命をASan/UBSan付きで検証しています。追加のv1 transport確認は1570チェック、従来v2プロトコルは1659チェックを通過しています。このMacでは `/Library/Frameworks/Python.framework/Versions/3.12/bin/python3` にFastAPIなどのテスト依存が入っています。`make -j8 build` と `program` の終了コード0、書き込み後の照合も確認しました。

| ファイル | 内容 |
|---|---|
| `source/e84_audio_hw.c` | E84 PDM割り込み、320サンプル単位の取得キュー |
| `source/e84_audio_app.c` | 検知・録音・5件キュー・コア間受け渡し |
| `source/audio_core.c`, `audio_reference.c` | 既存の音響特徴、DTW、基準音照合 |
| `source/e84_shared.c`, `e84_shared.h` | 共有メモリ、公開順序、ACK |
| `source/e84_network.c` | Wi-Fi、API通信タスク、UART、M5送信タスク |
| `source/e84_wifi_hw.c` | Wi-Fi GPIO・SD Host・SDIO HAL、割り込み、WCM初期化 |
| `source/wifi_reconnect.c`, `wifi_settings.c` | 切断後の再試行タイミング、通常・テザリング用Wi-Fi設定 |
| `source/door_server.c`, `door_clock.c` | TLS、HTTP応答解析、WAV送信、NTP |
| `source/m5_link.c`, `m5_protocol.c` | M5へのUDPイベント通知とping/pong通信確認 |
| `tools/fastapi_receiver.py` | 認証付きWAV受信と保存後ACK |

## 出典

起動・ビルド・BSP設定はInfineon公式資料とソースを使用しています。ライセンスは `LICENSE` とBSP・ライブラリ内のライセンスを参照してください。

- [E84 HTTPS Client](https://github.com/Infineon/mtb-example-psoc-edge-wifi-https-client) — `e7ed60c5f8a02b368589711cda98eb253d53a019`
- [E84 PDM/PCM](https://github.com/Infineon/mtb-example-psoc-edge-pdm-pcm) — `e53cf64014bc5a9dde20d1aa0a3b063fea10ec15`
- [KIT_PSE84_AI BSP](https://github.com/Infineon/TARGET_KIT_PSE84_AI) — `4894dd6a1ac2cee8be0d028476da4c7e9e640431`
- [KIT_PSE84_AI公式ガイド](https://documentation.infineon.com/psocedge/docs/cci1762693051052)
