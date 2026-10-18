# 玄関AI 音声バックエンド

日本語の来訪者と音声で会話する、ローカル推論向けバックエンドです。LiveKit AgentsがWebRTC音声、発話ターン、AI発話中の割り込みを管理します。APIサーバーはLiveKitの接続トークンを発行し、OllamaとローカルASR/TTSサービスはホスト内から呼び出します。

このサービスは会話だけを扱います。インターホン、鍵、宅配ボックス、カメラなどの機器は操作しません。受信音声や会話内容をディスクへ保存しません。ログには会話本文やトークンを出力しません。

## 構成

- `door_backend.api`: `/api/status`、`/api/connect`、`/api/tts-check`、PSoC 6用の`/api/relay`を提供するFastAPIサーバー
- `door_backend.relay`: PSoC 6の代わりにLiveKitルームへ入る中継と、Supabaseからの家の設定の読み込み
- `door_backend.house_rules`: 動作モードと家の設定から組み立てる住人ルール
- `door_backend.web_ui`: 同じAPIオリジンから使えるマイク通話画面
- `door_backend.agent`: LiveKitルームごとの音声エージェント
- `door_backend.speech_tts`: speech.cppのストリーミングPCM/SSE接続
- `door_backend.visit_policy`: 来訪目的と会話状態に基づく応答制約
- `compose.yaml`: ローカル開発用LiveKit Server
- `scripts/psoc_sim.py`: PSoC 6の代わりに`/api/relay`へつなぐ確認用クライアント
- `scripts/fake_models.py`: labpcのモデルの代わりに決まった応答を返す確認用のASR、LLM、TTS

## 必要なサービス

- Python 3.11〜3.13、uv
- Docker DesktopとLiveKit Server
- Ollamaで稼働するGemma 4モデル
- OpenAI互換のKotoba-Whisper ASRエンドポイント
- OpenAI互換のspeech.cpp TTSエンドポイント

ASRとTTSは`/v1/models`を、Ollamaは`/api/tags`を提供する必要があります。TTSは`POST /v1/audio/speech`に対して、SSEの`speech.audio.delta`イベントを返すストリーミング形式、または`audio/pcm`を返す形式に対応します。PCMはモノラル16-bitで、サンプルレートは設定値と一致させてください。

## labpc Windowsでの起動

PowerShellでこのディレクトリを開きます。

```powershell
Copy-Item .env.example .env
python -c "from pathlib import Path; import secrets; p=Path('.env'); s=p.read_text(encoding='utf-8'); p.write_text(s.replace('DOOR_API_KEY=', 'DOOR_API_KEY='+secrets.token_hex(32), 1), encoding='utf-8')"
uv sync --extra test
docker compose up -d
uv run python -m door_backend.agent start
```

別のPowerShellでAPIを起動します。

```powershell
uv run uvicorn door_backend.api:app --host 127.0.0.1 --port 8093
```

APIサーバーとエージェントワーカーは別プロセスです。両方を起動してください。WebUIを開き、`.env` の `DOOR_API_KEY` を認証欄へ入力します。キーはブラウザーのメモリだけに保持し、HTMLやJavaScript、URL、ログには保存しません。API状態確認も含め、すべての `/api/*` はBearer認証が必要です。

### CIとlabpcへの自動反映

`.github/workflows/voice-agent-backend.yml` は対象ブランチへのpushとPull Requestでバックエンドのテストを実行します。labpcの `Door Voice Backend Auto Update` タスクは5分ごとにGitHubを確認し、対象PRが開いている間はその作業ブランチを、マージ後はリポジトリの既定ブランチを追跡します。`backend-tests` が成功したコミットだけを取得します。ローカルの`.env`を保ったままAPIとAgentを入れ替えて再起動し、更新失敗時は直前の配置に戻します。

labpcにはGitHub Actionsの秘密情報やSSHキーを登録せず、公開GitHub APIからソースを取得します。labpcでこのバックエンドのディレクトリを開き、初回だけ次を実行してください。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install-auto-update.ps1
```

更新スクリプトは`deploy/windows/auto-update.ps1`です。デプロイ状態とエラーは `C:\Users\stu23-oba-shion\door-voice-deploy.log` に残り、音声や会話本文は記録しません。

WebUI (`http://localhost:8093/`またはデプロイ先) では、認証後に「管理者設定」パネルが現れます。通常・おまかせ・外出中のモード、外出中の置き配許可、追加指示（350字まで）を設定し、「設定を保存」でこのブラウザーに保存できます。設定は次のWeb UI通話から適用され、この Web UI の通話に限られます。住人APIキーで保護され、家全体の Supabase 設定は変更しません。「適用される住人ルールを確認」で通話前に内容を確認できます。`DOOR_ENV=development`かつSupabaseのURLと公開APIキー設定時のみ、任意の「このテスト会話の履歴をSupabaseに保存」欄が表示されます。チェックを入れ、テスト用デバイス鍵を入力して通話を終了したときだけ文字起こしを保存します。対応する住人宅に実データが追加されるため、テスト用の鍵を使ってください。

開発用LiveKitの公開ポートはホストのループバックだけにバインドされます。`.env` はGit管理外です。開発用のLiveKit `devkey` / `secret` はローカル開発に限って使います。

## API

### `GET /api/status`

認証済みクライアントへ各サービスの準備状況を返します。`ready`はLiveKit、ASR、TTS、LLMがすべて利用可能な場合に`true`です。モデル名とTTSの声も含まれます。

### `POST /api/connect`

リクエスト本文は省略できます。住人ルールを指定する場合:

```json
{"house_rules":"宅配ボックスを優先してください。"}
```

Bearer認証が必要です。成功時は`url`、`token`、`room`を返します。LiveKitのAPI秘密鍵はブラウザーへ渡しません。LiveKitルームへのdispatchに失敗した場合は`503`を返します。

### `POST /api/tts-check?scenario=thanks`

Bearer認証が必要です。`thanks`または`compound`の固定文を合成し、`audio/wav`を返します。音声はメモリ上で組み立て、キャッシュしません。TTS応答は既定で5 MiB、API全体は1分あたり120要求、API処理は同時に4件までです。処理枠が埋まると最大8件を最大2秒だけ待機させ、待機枠満杯または期限超過は`503`と`Retry-After`で返します。上限値は環境変数で調整できます。

### `WebSocket /api/relay`

PSoC用の中継です。接続時に`Authorization: Bearer <DOOR_API_KEY>`を付けてください。キーが違う場合は1008で閉じます。productionではWSSを使います。開始JSONの`protocol_version`で方式を選び、省略時は従来のv1です。

#### v1: 従来のLiveKitルーム中継

中継がPSoC 6の代わりにLiveKitルームへ入り、PSoC 6の音を音声トラックとして流し、エージェントの声と文字起こしをPSoC 6へ返します（`docs/spec.md` 5.4）。既存クライアントと`scripts/psoc_sim.py`の動作は変わりません。

| 向き | 種類 | 内容 |
|---|---|---|
| PSoC 6 → 中継 | テキスト | 最初の1通。5秒以内に`{"type":"start","visit_id":"<uuid>","mode":"normal\|omakase\|away","device_key":"<デバイス鍵>"}`を送ります |
| PSoC 6 → 中継 | バイナリ | マイクのPCM。16 kHz・16bit LE・モノラルで、20 ms（640 B）ずつ送ります。1通は100 ms以下です |
| PSoC 6 → 中継 | テキスト | `{"type":"end"}`。中継はルームを抜け、1000で閉じます |
| 中継 → PSoC 6 | テキスト | `{"type":"ready"}`。家の設定を読み、ルームに入り、エージェントを呼んだ後に送ります |
| 中継 → PSoC 6 | バイナリ | エージェントの声。PSoC 6が送る音と同じ形式のPCMを20 ms（640 B）ずつ送ります |
| 中継 → PSoC 6 | テキスト | `{"type":"transcript","speaker":"visitor\|ai","text":"..."}`。確定した文字起こしだけを送ります。`speaker`はSupabaseの`visit_messages.speaker`と同じ値です |
| 中継 → PSoC 6 | テキスト | `{"type":"agent_state","state":"speaking\|listening\|thinking"}`。エージェントの状態が変わるたびに送ります |
| 中継 → PSoC 6 | テキスト | `{"type":"error","code":"...","message":"..."}`。送った後に閉じます |

| `code` | 閉じるときのコード | 起きる場面 |
|---|---|---|
| `start_timeout`、`invalid_start` | 1008 | 開始のJSONが5秒以内に届かない、または形が違う（`mode`が無い・不正など） |
| `invalid_audio`、`invalid_message` | 1008 | 音のバイト数が0か奇数、または100 ms（3200 B）を超える。テキストがJSONのオブジェクトでない |
| `time_limit` | 1008 | 1回の会話が`DOOR_RELAY_MAX_SESSION_SECONDS`（既定120秒）を過ぎた |
| `agent_unavailable` | 1011 | LiveKitに入れない、またはエージェントを呼べない |
| `livekit_disconnected` | 1011 | 会話中にLiveKitから切れた |
| `busy` | 1013 | 同時に中継できる会話（`DOOR_MAX_RELAY_SESSIONS`、既定4）またはAPIの要求数の上限に達した |

エージェントが話していない間、LiveKitの音声トラックには無音が流れています。中継はこの無音をPSoC 6へ送りません。PSoC 6は再生中にマイクの音を送らないため（`docs/spec.md` 3.7）、無音が届き続けると訪問者の声を送れなくなるためです。

#### v2: E84が発話を区切り、M5の再生完了を待つ

同じ`/api/relay`に次の開始JSONを5秒以内に送ります。`visit_id`は通話ごとに新しいUUID、`mode`は`normal`・`omakase`・`away`、`device_key`は住人設定・訪問履歴用のASCII可視文字1〜512字です。`device_key`とAPI認証用の`DOOR_API_KEY`は別の鍵です。

```json
{"type":"start","protocol_version":2,"visit_id":"123e4567-e89b-42d3-a456-426614174000","mode":"omakase","device_key":"<デバイス鍵>"}
```

v2はAPIプロセス内で既存`DoorAgent`とLiveKit Agents SDKの`AgentSession`を使います。発話確定後に既存STTクライアントで認識し、既存の会話ルール・LLM・TTSへ渡します。v2自体はRTCルームへ参加せず、サーバーVADによる二重の発話分割を行いません。ブラウザーとv1のLiveKitルーム経路は維持します。

制御はWebSocketのテキストJSON、音声はヘッダーなしのバイナリPCMです。JSONとPCMは同じソケット上の順番で処理します。`turn_id`と`output_id`は0から始まり、0が冒頭挨拶、1以降が来訪者への返答です。

| 向き | メッセージ | 条件・動作 |
|---|---|---|
| サーバー → E84 | `{"type":"ready","protocol_version":2}` | 設定取得とAgentSession準備完了。まだ挨拶しません。E84はv2を確認してからM5に通話ボタン操作を依頼します |
| E84 → サーバー | `{"type":"call_started","turn_id":0}` | M5の通話ボタン操作完了後。ここから挨拶と通話時間の計測を開始します |
| サーバー → E84 | `{"type":"output_start","turn_id":0,"output_id":0}` | この後に返答PCMを送ります。E84はM5へ転送し、録音を停止したままにします |
| サーバー → E84 | PCMバイナリ | 16kHz・PCM16LE・mono、通常640B/20ms。最後のフレームだけ2〜640Bの偶数長を許容します |
| E84 → サーバー | `{"type":"audio_ack","turn_id":0,"output_id":0,"frames":10}` | M5が受け入れた累計フレーム数。実再生完了ではありません。未ACK音声は最大10フレームです |
| サーバー → E84 | `{"type":"output_end","turn_id":0,"output_id":0,"frames":10,"samples":3200,"end_call":false}` | 応答全体の送信終了。全フレーム数と実サンプル数を確認します |
| E84 → サーバー | `{"type":"playback_done","turn_id":0,"output_id":0,"frames":10,"samples":3200}` | M5の音声キュー・スピーカー再生・DMA排出が完了してから送ります。受信するまで次の録音を許可しません |
| サーバー → E84 | `{"type":"listen","turn_id":1}` | 次の録音を許可。E84はM5再生完了から250msの残響待ちも行います |
| E84 → サーバー | `{"type":"input_start","turn_id":1}` | マイクの発声待機を開始。最初のPCMを最大60秒待ちます |
| E84 → サーバー | PCMバイナリ | 同じ16kHz・PCM16LE・mono、必ず640B/20ms。発声を検出するまで送りません |
| E84 → サーバー | `{"type":"input_end","turn_id":1,"frames":100,"samples":32000,"reason":"silence"}` | 無音1.2秒で確定。30秒到達時は`reason:"max_duration"`、`frames:1500`、`samples:480000`。受信済みの総量を検証してからASRを始めます |
| サーバー → E84 | `{"type":"no_reply","turn_id":1}` | 認識結果が空、または会話ルールが返答を保留した場合。音声を作らず次の`listen`へ進みます |
| サーバー → E84 | `{"type":"call_end","turn_id":1,"reason":"completed"}` | 最後の返答をM5が再生し終えてから送信。E84がM5へ終了ボタン操作を依頼します |
| E84 → サーバー | `{"type":"call_ended","turn_id":1}` | M5の終了操作完了後。サーバーは1000で閉じ、訪問履歴を保存します |

表のフレーム数は例です。ACKと再生完了には実際に受け取った数を使い、ターン番号・出力番号・総量が一致しない通知は拒否します。`output_end`の`end_call:true`は最後の返答を示しますが、終了ボタンを押すのは`playback_done`後の`call_end`を受けてからです。サーボ完了通知はPWM操作完了であり、物理ボタンが押せたことをセンサーで検証するものではありません。

録音の1.2秒判定はE84が行います。30秒には先行バッファと末尾無音を含み、サーバーの入力バッファは最大960,000Bです。入力途中の切断やサイズ不一致ではASRを実行しません。応答待ち・M5再生中は入力PCMを受け付けません。`input_start`を受けただけで録音30秒の時計を始めず、最初のPCMから35秒の転送猶予と、以後の5秒無進捗期限を設けます。

`{"type":"ping","turn_id":1,"seq":7}`には同じ番号の`pong`を返します。モデル処理・再生待ち中も有効です。`cancel`または`end`は通話全体の中断で、録音1回の確定には使いません。異常時は`error`の後に閉じ、E84/M5は再生を止めて終了操作へ進みます。通話上限は既存の`DOOR_RELAY_MAX_SESSION_SECONDS`（既定120秒）、来訪者の発話は最大20ターン、返答1回は最大60秒です。

v2の文字起こしはサーバーの訪問履歴に保存し、E84へ`transcript`は送りません。TTSは既存の品質調整のため返答全体の生成を待ちます。PCMの転送とM5の再生は逐次ですが、TTSの生成途中から再生が始まる仕様ではありません。

端末の設定・ビルド・実機確認は[E84の音声会話手順](../../PSOC_Edge_E84/docs/voice-stream.md)を参照してください。E84はv2対応サーバーを必要とし、URLだけを変更した旧サーバーでは通話を開始しません。

#### 住人ルールの組み立て

中継は会話の開始時に一度だけ、公開APIキーを`apikey`ヘッダーに、`device_key`を`Authorization: Bearer`ヘッダーに付けてSupabaseのEdge Function（`GET {DOOR_SUPABASE_URL}/functions/v1/device/settings`）から家の設定を読みます。返事は`{"paired": true, "mode": "normal", "away_leave_at_door": false, "auto_away": false, "extra_instructions": ""}`の形で（`supabase/README.md`の「本体が使う API」）、中継が使うのは`away_leave_at_door`と`extra_instructions`だけです。モードは返事の`mode`ではなく、PSoC 6が開始のJSONで送った`mode`を使います。中継は設定と`mode`から住人ルールを組み立て、`/api/connect`の`house_rules`と同じ扱いで会話エージェントへ渡します。

- 基本の規則は`docs/spec.md` 5.6のものです。規則2は、`normal`と`omakase`では置き配を、`away`では不在票を頼む文です。
- `mode`が`away`で`away_leave_at_door`が`true`のときは、規則2を「置き配の指定があればその場所に置き、なければ不在票」の文に替えます。ほかのモードでは`away_leave_at_door`を使いません。
- `extra_instructions`（AIへの追加の指示）は、「1〜8とぶつかるときは1〜8を守る」という前置きを付けて規則の後ろに足します。全体が`DOOR_MAX_HOUSE_RULES_CHARS`（既定800字）を超える場合は、追加の指示の末尾を切ります。規則が最も長い`away`の置き配ありでは、追加の指示に使えるのは350字です。Supabaseの`devices.extra_instructions`も350字までに制限しているため、既定の設定では切られません。
- URLまたは公開APIキーが未設定、`DOOR_HOUSE_SETTINGS_TIMEOUT_SECONDS`以内に応答しない、200以外、返答形式が違う場合は、設定なしの規則で会話を続けます。

v1は`ready`、v2は`call_started`まで到達した会話について、終了時に確定した訪問者・AIの文字起こしを1回だけSupabaseの`PUT /functions/v1/device/visits/{visit_id}`へ保存します。公開APIキーは`apikey`ヘッダー、開始JSONの`device_key`は`Authorization`ヘッダーに使います。secret/service-role keyは使いません。保存に失敗しても会話には影響しません。音声は保存しません。書き込みのタイムアウトは`DOOR_VISIT_WRITE_TIMEOUT_SECONDS`（既定3秒）です。

## 応答の速さ

訪問者の発話終了から返答音声の再生開始までを短くするため、次を行う（`docs/spec.md` 2.2 の目標は3秒以内）。

- 起動時にASR・LLM・TTSへ短い先読み要求を送り、モデルをメモリに載せる（`door_backend.warmup`）。APIサーバーは起動時、会話エージェントは会話の開始時に、挨拶の再生と並行して先読みする。これがないと、挨拶の後の最初の発話（「こんにちは、宅配便です」）でWhisperのモデル読み込みとOllamaの再読み込みを待つ。
- 挨拶「はい、どちら様でしょうか」は`session.say`で固定再生し、LLMの往復をなくす。
- LLMの`keep_alive`でOllamaのモデルを保持し、会話の合間の再読み込みを防ぐ。`max_tokens`で返答を短く保ち、`timeout`で固まった呼び出しを打ち切る。

## 設定

`.env.example`を`.env`へコピーし、上のコマンドでランダムな32-byte `DOOR_API_KEY` を生成してください。`.env`を共有したり、キーをソースやブラウザーコードに埋め込んだりしないでください。LiveKit、Ollama、ASR、TTSのURLとモデル名も環境に合わせます。主な設定:

- `LIVEKIT_URL` / `LIVEKIT_WS_URL`: サーバーAPI用URLとブラウザーから到達するWebSocket URL
- `DOOR_UI_HOSTNAME`: 音声通話画面を表示するホスト名
- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`: LiveKit認証情報
- `DOOR_API_KEY`: アプリAPIのBearerキー。32-byte以上が必要で、未設定なら起動しません。
- `DOOR_ENV`: `development`または`production`。productionでは開発用LiveKit資格情報を拒否します。LiveKit APIはHTTPS、loopback、または明示的に許可したTailscale IPに限定し、ブラウザー用URLはWSSを要求します。
- `DOOR_LIVEKIT_TRUSTED_HTTP_HOSTS`: 本番LiveKit APIが同一Tailnet内にある場合だけ、許可するTailscale IPを列挙します。HTTPのまま使う場合は、Tailscale ACLで接続端末を制限してください。
- `DOOR_MAX_TTS_RESPONSE_BYTES` / `DOOR_API_REQUESTS_PER_MINUTE` / `DOOR_MAX_CONCURRENT_REQUESTS` / `DOOR_MAX_QUEUED_REQUESTS` / `DOOR_QUEUE_WAIT_SECONDS`: 音声サイズ、API要求数、同時処理数、待機数、待機時間の上限
- `DOOR_OLLAMA_BASE_URL` / `DOOR_LLM_MODEL`: Ollama接続先とLLMモデル
- `DOOR_LLM_TIMEOUT_SECONDS` / `DOOR_LLM_MAX_TOKENS`: ローカル推論の待ち時間と返答上限（既定値: 30秒 / 96トークン）
- `DOOR_LLM_KEEP_ALIVE`: OllamaのLLMモデルを常駐させる時間（既定値: `30m`）
- `DOOR_WARMUP` / `DOOR_WARMUP_TIMEOUT_SECONDS`: 起動時のASR・LLM・TTS先読みの有効化とタイムアウト
- `DOOR_ASR_BASE_URL` / `DOOR_ASR_API_MODEL`: ASR接続先とモデルID
- `DOOR_TTS_BASE_URL` / `DOOR_TTS_API_MODEL`: TTS接続先とモデルID
- `DOOR_TTS_VOICE` / `DOOR_TTS_SAMPLE_RATE`: 合成音声の声とPCMサンプルレート
- `DOOR_HOUSE_RULES`: セッションに初期適用する住人ルール
- `DOOR_TURN_DETECTOR`: `vad`が既定値。`mini`はLiveKitの追加モデル条件を確認したうえで明示的に選択
- `DOOR_SUPABASE_URL` / `DOOR_SUPABASE_ANON_KEY`: SupabaseのプロジェクトURLと公開APIキー。`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_PUBLISHABLE_KEY`も読み取ります。URLとキーの両方が設定されているときだけEdge Functionを呼び出します。productionではHTTPSが必要です。`service_role` / secret keyは設定しないでください。
- `DOOR_HOUSE_SETTINGS_TIMEOUT_SECONDS`: 家の設定を待つ時間。既定は1.5秒
- `DOOR_RELAY_LIVEKIT_URL`: 中継が入るLiveKitのURL。既定は`LIVEKIT_URL`の`http`を`ws`に替えたものです。
- `DOOR_MAX_RELAY_SESSIONS` / `DOOR_RELAY_START_TIMEOUT_SECONDS` / `DOOR_RELAY_MAX_SESSION_SECONDS`: 同時に中継する会話の数、開始のJSONを待つ時間、1回の会話の上限時間

開発用の`devkey` / `secret`を公開ネットワークで使わないでください。APIとモデルサービスは信頼されたネットワーク内に限定してください。

### Production

本番では`DOOR_ENV=production`にし、`DOOR_API_KEY`とLiveKitのキー/秘密鍵をSecret Managerまたはデプロイ環境のシークレット機能から注入してください。APIキーとLiveKit秘密鍵は別々のランダム値にし、キーは定期ローテーションします。本番のLiveKitサーバーは開発モードを使わず、`LIVEKIT_WS_URL=wss://...`を設定してください。LiveKit APIがHTTPSを提供するなら`LIVEKIT_URL=https://...`を使います。同一のTailnetでのみ到達できるLiveKit APIをHTTPで使う場合は、そのIPを`DOOR_LIVEKIT_TRUSTED_HTTP_HOSTS`に明示し、Tailnet ACLで接続端末を制限します。OpenAPIは`/openapi.json`、Swagger UIは`/docs`、ReDocは`/redoc`で表示します。仕様書にAPI操作のBearer認証を記載し、実際のAPI要求にも引き続きAPIキーを必須にします。

FastAPIはループバックにバインドし、TLS終端、アクセス制御、ホスト許可リスト、要求本文サイズ制限、分散レート制限を備えた信頼済みリバースプロキシ経由だけで公開してください。Uvicornのproxy headersは実際のプロキシIPだけを信頼するよう設定します。例の`127.0.0.1`は同じホスト上のプロキシの場合です。APIは非同期I/Oで同時接続を処理し、アプリ内の同時処理枠と短い有界待ち行列で上流サービスへの負荷を平準化します。枠を超えた要求は無制限にメモリへ積まず、再試行可能な`503`で戻します。Uvicornにも接続数とOS待ち行列の上限を設定します。複数ワーカーや複数インスタンスでは、アプリ内の要求数・同時数・待機数制限はプロセスごとに適用されるため、プロキシ側にも共有レート制限と同時要求制限を設定してください。最初は1ワーカーで運用し、負荷試験で上流モデルとLiveKitの余力を確認してからワーカー数を増やします。APIキーはWebUIで利用者が入力し、セッションストレージやローカルストレージには保存しません。ブラウザーを使う利用者にはVPNまたは認証付きアクセスプロキシも要求してください。

本番プロキシが同じホストのループバックで待ち受ける場合のAPI起動例:

```powershell
$env:DOOR_ENV = "production"
uv run uvicorn door_backend.api:app --host 127.0.0.1 --port 8093 --workers 1 --limit-concurrency 64 --backlog 128 --timeout-keep-alive 5 --timeout-graceful-shutdown 30 --proxy-headers --forwarded-allow-ips=127.0.0.1
```

`DOOR_ALLOWED_HOSTS`には公開する正確なホスト名を列挙してください。リバースプロキシでは要求本文を16 KiB以下に制限し、APIキー単位のレート制限と同時要求制限を設定します。アプリ内の要求数・容量制限は単一プロセス用の追加防御で、分散制限の代替ではありません。`--limit-concurrency`を増やす場合は、API側の同時処理数と上流サービスの処理能力に合わせてください。

## WebRTCネットワーク

WebUIは`DOOR_UI_HOSTNAME`のホストで配信され、APIリクエストは同一オリジンで処理されます。`LIVEKIT_WS_URL`にはブラウザーから到達できる`wss://` URLを設定してください。LiveKitはWebSocketでシグナリングし、音声メディアはWebRTC/ICEで送るため、ブラウザーとlabpc間でICE用UDP/TCPまたは到達可能なTURN/TLS経路も必要です。HTTPSページやTCP SSH転送だけでは音声経路を確保できません。

## 確認

```powershell
uv run pytest
```

テストは会話ルール、サービス準備状態、接続失敗時の応答、WAVプレビュー形式、中継の受け口、住人ルールの組み立て、家の設定の読み込みを確認します。中継の試験では、LiveKitとSupabaseの代わりにモックを使います。実機のマイク・スピーカーを通した遅延と割り込み、およびlabpcとブラウザー間のICE到達性は、対象ネットワーク上で別途確認してください。

### PSoC 6なしで中継を確かめる

`scripts/psoc_sim.py`は、PSoC 6と同じ手順で`/api/relay`につなぎ、WAVファイルを訪問者の声として送ります。PSoC 6と同じく、エージェントの声の再生中と再生後0.5秒はマイクの音を送りません。受け取った声はWAVに保存し、文字起こし、`ready`までの時間、訪問者の発話の送信終了から返答の音が届くまでの時間を表示します。WAVは16 kHz・16bit・モノラルにしてください。

```bash
ffmpeg -i visitor.m4a -ar 16000 -ac 1 -sample_fmt s16 visitor.wav
DOOR_DEVICE_KEY=<デバイス鍵> uv run python -m scripts.psoc_sim --url wss://<会話サーバー>/api/relay --mode omakase visitor.wav
```

`DOOR_API_KEY`は環境変数か`.env`から読みます。`DOOR_DEVICE_KEY`を省くと仮の鍵を送るため、家の設定は読めず、設定なしの規則で会話します。WAVを複数渡すと、エージェントが話し終えるたびに順に送ります。エージェントが「失礼いたします」と言った後は、残りのWAVを送らずに終話します。

### labpcのモデルなしで確かめる

`scripts/fake_models.py`は、ASR、LLM、TTSの代わりに決まった応答を返します。TTSは言葉を読み上げず、文の長さに合わせた長さの音を返します。中継、LiveKit、会話エージェントのつながりは確かめられますが、会話の質は確かめられません。それぞれ別の端末で起動します。

```bash
docker compose up -d
uv run python -m scripts.fake_models --port 18100
DOOR_ASR_BASE_URL=http://127.0.0.1:18100 DOOR_TTS_BASE_URL=http://127.0.0.1:18100 DOOR_OLLAMA_BASE_URL=http://127.0.0.1:18100 uv run python -m door_backend.agent dev
uv run uvicorn door_backend.api:app --host 127.0.0.1 --port 8093
uv run python -m scripts.psoc_sim --url ws://127.0.0.1:8093/api/relay visitor.wav
```

### WebUIから音声エージェントを通しで試す

開発用LiveKitと偽モデルを起動し、WebUIのマイクからブラウザー→FastAPI→LiveKit→エージェント→ASR/LLM/TTSの経路を試せます。偽モデルは固定の文字起こしと応答を返すため、マイク音声の認識精度や会話品質の評価には使えません。

1. `.env`を開発設定にし、LiveKitを起動します。

   ```bash
   docker compose up -d
   ```

2. 別のターミナルで偽モデルを起動します。

   ```bash
   uv run python -m scripts.fake_models --port 18100
   ```

3. `DOOR_ASR_BASE_URL`、`DOOR_TTS_BASE_URL`、`DOOR_OLLAMA_BASE_URL`をすべて`http://127.0.0.1:18100`に設定して、エージェントとAPIを別のターミナルで起動します。

   ```bash
   DOOR_ASR_BASE_URL=http://127.0.0.1:18100 DOOR_TTS_BASE_URL=http://127.0.0.1:18100 DOOR_OLLAMA_BASE_URL=http://127.0.0.1:18100 uv run python -m door_backend.agent dev
   ```

   ```bash
   DOOR_ASR_BASE_URL=http://127.0.0.1:18100 DOOR_TTS_BASE_URL=http://127.0.0.1:18100 DOOR_OLLAMA_BASE_URL=http://127.0.0.1:18100 uv run uvicorn door_backend.api:app --host 127.0.0.1 --port 8093
   ```

4. `http://localhost:8093/`を開いてAPIキーで認証し、モードを選んで通話します。初回はブラウザーのマイク使用を許可してください。

このWebRTCテスト画面の会話は保存されません。Supabaseの来客履歴保存はPSoC経由の`/api/relay`で別途確認してください。


### WebUIのテスト環境

`DOOR_ENV=development`のとき、WebUIから通常・おまかせ・外出モードを選び、置き配設定と最大350字の追加指示を変えて会話できます。設定はサーバー側で規則に変換し、会話へ渡します。画面には規則のプレビューとサービス状態を表示します。

Supabase履歴保存は任意です。開発環境で`DOOR_SUPABASE_URL`を設定し、画面で保存を明示的に選んだ場合だけ、入力したテスト用デバイス鍵で履歴を書き込みます。保存を選ばなければSupabaseへ書き込みません。`DOOR_VISIT_WRITE_TIMEOUT_SECONDS`は履歴書き込みの上限時間です。
