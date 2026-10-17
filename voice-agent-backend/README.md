# 玄関AI 音声バックエンド

日本語の来訪者と音声で会話する、ローカル推論向けバックエンドです。LiveKit AgentsがWebRTC音声、発話ターン、AI発話中の割り込みを管理します。APIサーバーはLiveKitの接続トークンを発行し、OllamaとローカルASR/TTSサービスはホスト内から呼び出します。

このサービスは会話だけを扱います。インターホン、鍵、宅配ボックス、カメラなどの機器は操作しません。受信音声や会話内容をディスクへ保存しません。ログには会話本文やトークンを出力しません。

## 構成

- `door_backend.api`: `/api/status`、`/api/connect`、`/api/tts-check`を提供するFastAPIサーバー
- `door_backend.web_ui`: 同じAPIオリジンから使えるマイク通話画面
- `door_backend.agent`: LiveKitルームごとの音声エージェント
- `door_backend.speech_tts`: speech.cppのストリーミングPCM/SSE接続
- `door_backend.visit_policy`: 来訪目的と会話状態に基づく応答制約
- `compose.yaml`: ローカル開発用LiveKit Server

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
- `DOOR_LLM_TIMEOUT_SECONDS` / `DOOR_LLM_MAX_TOKENS`: ローカル推論の待ち時間と返答上限（既定値: 120秒 / 96トークン）
- `DOOR_ASR_BASE_URL` / `DOOR_ASR_API_MODEL`: ASR接続先とモデルID
- `DOOR_TTS_BASE_URL` / `DOOR_TTS_API_MODEL`: TTS接続先とモデルID
- `DOOR_TTS_VOICE` / `DOOR_TTS_SAMPLE_RATE`: 合成音声の声とPCMサンプルレート
- `DOOR_HOUSE_RULES`: セッションに初期適用する住人ルール
- `DOOR_TURN_DETECTOR`: `vad`が既定値。`mini`はLiveKitの追加モデル条件を確認したうえで明示的に選択

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

テストは会話ルール、サービス準備状態、接続失敗時の応答、WAVプレビュー形式を確認します。実機のマイク・スピーカーを通した遅延と割り込み、およびlabpcとブラウザー間のICE到達性は、対象ネットワーク上で別途確認してください。
