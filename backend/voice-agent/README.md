# 玄関AI 音声バックエンド

日本語の来訪者と音声で会話する、玄関・店舗受付用のバックエンドです。LiveKit AgentsがWebRTC音声、発話ターン、AI発話中の割り込みを管理します。PSoC 6はWSS `/api/relay` でPCM音声を送り、中継がLiveKitルームへ入ります。

このサービスは会話だけを扱います。インターホン、鍵、宅配ボックス、カメラなどの機器は操作しません。受信音声や会話内容をディスクへ保存しません。ログには会話本文やトークンを出力しません。

## Supabaseとの役割分担

アカウント、家・店舗（`households`）、メンバーと招待、端末のペアリング、店舗設定（`shop_profiles` / `shop_services`）、予約（`reservations`）、Googleカレンダー・Squareの連携、通知、来客履歴は、すべてSupabase（プロジェクト `bqdvxzvezecunnkbcyoy`）で管理します。アプリはSupabase Authでログインし、RLSとEdge Function（`account`、`reservations`、`calendar-sync`、`assistant`）を直接呼びます。このバックエンドはログイン、OAuth callback、データベースを持ちません。

バックエンドがSupabaseを呼ぶのは、Edge Function `device` をデバイス鍵で呼ぶときだけです。公開APIキーを`apikey`ヘッダー、PSoC 6が開始JSONで送る`device_key`を`Authorization: Bearer`に付けます。secret/service-role keyは使いません。

| 呼び出し | 用途 |
|---|---|
| `GET /functions/v1/device/settings` | 家の設定（置き配、追加の指示）と、店舗なら`shop`（店名、挨拶、営業時間、メニュー、予約先） |
| `GET /functions/v1/device/reservations?from=&to=` | 店舗受付で当日の予約を読む（GoogleカレンダーやSquareの予約はSupabase側で同期済み） |
| `POST /functions/v1/device/reservations/{id}/arrive` | 来店を記録する。Supabaseが店舗メンバーへ通知する |
| `PUT /functions/v1/device/visits/{visit_id}` | 会話の終了時に来客履歴と文字起こしを保存する |

端末の設定に`shop`があれば店舗受付エージェント、なければ玄関エージェントで応対します。未ペアリングの診断端末（`device_key`なし）は玄関エージェントです。

Googleカレンダーの連携は、アプリからSupabaseのEdge Function `reservations`（`/google/start`、`/google/callback`）で行います。Supabaseのシークレット`GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`、`CALENDAR_TOKEN_KEY`、`RESERVATIONS_PUBLIC_URL`を設定し、Google Cloudの承認済みリダイレクトURIに`https://bqdvxzvezecunnkbcyoy.supabase.co/functions/v1/reservations/google/callback`を登録してください。

## 構成

- `monban_backend.api`: `/api/status`、開発用の`/api/connect`と`/api/tts-check`、PSoC 6用のWSS `/api/relay`を提供するFastAPIサーバー
- `monban_backend.agent`: LiveKitワーカーの起動入口（実装は`voice.agent`）
- `monban_backend.config`: 環境変数から組み立てる設定
- `monban_backend.core`: 共通基盤
  - `core.http_limits`: APIの要求本文サイズと同時処理・待機数の上限
  - `core.services`: 上流サービスの準備確認とLiveKitエージェントの起動
  - `core.warmup`: ASR・LLM・TTSの先読み
  - `core.house_rules`: 動作モードと家の設定から組み立てる住人ルール
- `monban_backend.voice`: 音声会話
  - `voice.agent`: 玄関エージェント（`DoorAgent`）と店舗受付エージェント（`ReceptionAgent`）
  - `voice.speech_tts`: speech.cppのストリーミングPCM/SSE接続
  - `voice.visit_policy`: 来訪目的と会話状態に基づく応答制約
- `monban_backend.relay`: PSoC 6の代わりにLiveKitルームへ入る中継（v1）と、端末が発話区間を制御する中継（v2）
- `monban_backend.reception`: 予約照合、来店記録、当日予約の短期キャッシュ、受付の応答方針
  - `reception.service`: 店舗1件分の受付（`ReceptionDesk`）。予約はSupabaseから読む
  - `reception.cache`: 当日予約の短期キャッシュ（同時取得の共有・無効化）
- `monban_backend.persistence`: SupabaseのEdge Function `device`の呼び出し
  - `persistence.device_api`: 家・店舗の設定、予約、来店記録
  - `persistence.supabase_history`: 来客履歴の保存
- `compose.yaml`: ローカル開発用LiveKit Server
- `scripts/psoc_sim.py`: PSoC 6の代わりに`/api/relay`へつなぐ確認用クライアント
- `scripts/fake_models.py`: labpcのモデルの代わりに決まった応答を返す確認用のASR、LLM、TTS
- `deploy/nginx/monban.conf`: TLS終端、API/WebSocket中継、レート制限のNginx設定例
- `deploy/waf/modsecurity-monban.conf`: WebSocketを考慮したModSecurity/CRS設定例

## 必要なサービス

- Python 3.11〜3.13、uv
- 64-bit Raspberry Pi OS または macOS 上の Docker
- Pi内のLiveKit（AgentとWSSリレー間のプライベート接続）
- Modal の v20 LLM、Kotoba-Whisper ASR、Irodori TTS エンドポイント
- Supabaseプロジェクト（URLと公開APIキー）

モデル API は bearer token で保護し、LLM は OpenAI-compatible chat completions、STT は `/v1/audio/transcriptions`、TTS は `/v1/audio/speech` を提供します。TTS は Irodori-TTS-v4.1-Small-MF を speech.cpp で配信し、SSE PCM を返します。詳しい Modal 構築手順は `deploy/modal/README.md` を参照してください。

## 本番デプロイ（Raspberry Pi）

本番はRaspberry Pi上のDocker Composeで、API、Agent、LiveKitを起動します。Piの既設 `raspberrypi` Cloudflare Tunnel が `monban-api.shionkk.f5.si` → `http://127.0.0.1:8093` を公開し、ルーターの受信ポートは開けません。デプロイ作業はTailscale経由でPiに入って行います。`/docs` はCloudflare Accessで保護してください。

```bash
cp .env.production.example .env.production
chmod 600 .env.production
# .env.productionを編集し、認証情報・モデル接続先・Supabaseの公開APIキーを実値にする
docker compose --env-file .env.production -f compose.production.yaml -f compose.production.livekit.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml -f compose.production.livekit.yaml up -d --build
docker compose --env-file .env.production -f compose.production.yaml -f compose.production.livekit.yaml ps
```

以前のPostgreSQL（`db`）コンテナとボリュームはもう使いません。移行後に不要と確認できたら、Pi上で`docker compose ... down --remove-orphans`を実行して止めてください。ボリュームの削除は、残すデータがないことを確かめてから行います。

一般インターネットの音声は、Cloudflare Tunnelで公開したAPIの`wss://.../api/relay`でPCMを中継します。Pi内のrelayがLiveKitへ参加し、Agentとの音声をPCMで返します。`/api/connect`のLiveKit WebRTCを直接使うクライアントには別途ICE用UDP/TCP経路が必要なため、本番の`/api/connect`は409を返します。

`.env.production` には別々のランダムな API/Modal/LiveKit token を設定し、ファイル権限を制限してください。`DOOR_INFERENCE_ON_DEMAND=1` により API status は Modal を probe せず、GPU を起動しません。Agent は通話セッション開始時にモデルを先行起動します。API/workerは非root・読み取り専用ルートファイルシステムで起動し、APIはヘルスチェック、ログはサイズローテーションを有効にしています。`DOOR_ALLOWED_HOSTS`には公開ホスト名とローカルヘルスチェック用の`127.0.0.1,localhost`を含めます。

### V20 モデルについて

今確認できた labpc の Ollama タグは `monban-reception-v20-e4b-qlora-q4km:20261109` です。Modal にはこのバージョンを別環境へ複製して候補として配信します。過去の edge 採用基準を通過したモデルとして扱わず、現在の Agent tool 経路で failure と edge のシナリオを確認してから使ってください。labpc 側の Ollama model は変更しません。

## ローカルでの起動

```bash
cp .env.example .env
python -c "from pathlib import Path; import secrets; p=Path('.env'); s=p.read_text(encoding='utf-8'); p.write_text(s.replace('DOOR_API_KEY=', 'DOOR_API_KEY='+secrets.token_hex(32), 1), encoding='utf-8')"
uv sync --extra test
docker compose up -d
uv run python -m monban_backend.agent start
```

別のターミナルでAPIを起動します。

```bash
uv run uvicorn monban_backend.api:app --host 127.0.0.1 --port 8093
```

会話を試すだけなら、`.env` のASR/LLM/TTS接続先を偽モデルに向け、`uv run python -m scripts.fake_models --port 18100`を起動できます。この場合の返答音はテスト音で、実際の音声品質は評価できません。

APIサーバーとエージェントワーカーは別プロセスです。両方を起動してください。APIはReactやHTMLを配信せず、`/`ではサービス情報のJSONを返します。すべての `/api/*` はBearer認証が必要です。

開発用LiveKitの公開ポートはホストのループバックだけにバインドされます。`.env` はGit管理外です。開発用のLiveKit `devkey` / `secret` はローカル開発に限って使います。

## API

### `GET /api/status`

認証済みクライアントへ各サービスの準備状況を返します。`ready`はLiveKit、ASR、TTS、LLMがすべて利用可能な場合に`true`です。モデル名とTTSの声も含まれます。

### `POST /api/connect`

開発用です（本番は409）。リクエスト本文は省略できます。住人ルールを指定する場合:

```json
{"house_rules":"宅配ボックスを優先してください。"}
```

デバイス鍵を渡すと、`/api/relay`と同じくSupabaseからその端末の設定を読みます。店舗の端末なら店舗受付エージェント、家の端末なら`mode`に応じた住人ルールで応対します。

```json
{"device_key":"<デバイス鍵>","mode":"away"}
```

Bearer認証が必要です。成功時は`url`、`token`、`room`を返します。LiveKitのAPI秘密鍵はブラウザーへ渡しません。LiveKitルームへのdispatchに失敗した場合は`503`を返します。

### `POST /api/tts-check?scenario=thanks`

Bearer認証が必要です。`thanks`または`compound`の固定文を合成し、`audio/wav`を返します。音声はメモリ上で組み立て、キャッシュしません。TTS応答は既定で5 MiB、API全体は1分あたり120要求、API処理は同時に4件までです。処理枠が埋まると最大8件を最大2秒だけ待機させ、待機枠満杯または期限超過は`503`と`Retry-After`で返します。上限値は環境変数で調整できます。

### `WebSocket /api/relay`

WSS経由の音声中継です。Cloudflare Tunnelで公開したAPIホストからも接続できます。中継が端末の代わりにLiveKitルームへ入り、PCM音声を音声トラックとして流し、エージェントの声と文字起こしを端末へ返します。接続時に`Authorization: Bearer <DOOR_API_KEY>`を付けてください。キーが違う場合は1008で閉じます。ブラウザー標準の`WebSocket` APIは任意のAuthorizationヘッダーを設定できないため、ブラウザー用には短期トークン発行を行うクライアントAPIが別途必要です。

| 向き | 種類 | 内容 |
|---|---|---|
| デバイス → 中継 | テキスト | 最初の1通。5秒以内に`{"type":"start","visit_id":"<uuid>","mode":"normal\|omakase\|away","device_key":"<デバイス鍵>"}`を送ります。未ペアリング診断では`device_key`を省略でき、その場合は住人設定の取得と履歴保存を行いません |
| PSoC 6 → 中継 | バイナリ | マイクのPCM。16 kHz・16bit LE・モノラルで、20 ms（640 B）ずつ送ります。1通は100 ms以下です |
| PSoC 6 → 中継 | テキスト | `{"type":"end"}`。中継はルームを抜け、1000で閉じます |
| 中継 → PSoC 6 | テキスト | `{"type":"ready"}`。端末の設定を読み、ルームに入り、エージェントを呼んだ後に送ります |
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

#### 住人ルールの組み立て

中継は会話の開始時に一度だけ、Supabaseの公開APIキーを`apikey`ヘッダーに、`device_key`を`Authorization: Bearer`ヘッダーに付けてEdge Function（`GET {DOOR_SUPABASE_URL}/functions/v1/device/settings`）から家の設定を読みます。返事は`{"contract_version": 1, "paired": true, "mode": "normal", "away_leave_at_door": false, "auto_away": false, "extra_instructions": "", "shop": null, "pusher_settings": null}`の形で、使うのは`away_leave_at_door`、`extra_instructions`、`shop`です。`shop`があれば店舗受付エージェントを呼び、`shop`の店名・営業時間・挨拶を受付の案内に使います。モードは返事の`mode`ではなく、PSoC 6が開始のJSONで送った`mode`を使います。中継は設定と`mode`から住人ルールを組み立て、`/api/connect`の`house_rules`と同じ扱いで会話エージェントへ渡します。

- 基本の規則は`docs/spec.md` 5.6のものです。規則2は、`normal`と`omakase`では置き配を、`away`では不在票を頼む文です。
- `mode`が`away`で`away_leave_at_door`が`true`のときは、規則2を「置き配の指定があればその場所に置き、なければ不在票」の文に替えます。ほかのモードでは`away_leave_at_door`を使いません。
- `extra_instructions`（AIへの追加の指示）は、「1〜8とぶつかるときは1〜8を守る」という前置きを付けて規則の後ろに足します。全体が`DOOR_MAX_HOUSE_RULES_CHARS`（既定800字）を超える場合は、追加の指示の末尾を切ります。規則が最も長い`away`の置き配ありでは、追加の指示に使えるのは350字です。Supabaseの`devices.extra_instructions`も350字までに制限しているため、既定の設定では切られません。
- URLまたは公開APIキーが未設定、`DOOR_HOUSE_SETTINGS_TIMEOUT_SECONDS`以内に応答しない、200以外、返答形式が違う場合は、設定なしの規則で会話を続けます。

会話が`ready`になった後、終了時に確定した訪問者・AIの文字起こしを1回だけSupabaseの`PUT /functions/v1/device/visits/{visit_id}`へ保存します。公開APIキーは`apikey`ヘッダー、開始JSONの`device_key`は`Authorization`ヘッダーに使います。secret/service-role keyは使いません。保存に失敗しても会話には影響しません。音声は保存しません。書き込みのタイムアウトは`DOOR_VISIT_WRITE_TIMEOUT_SECONDS`（既定3秒）です。

## 応答の速さ

訪問者の発話終了から返答音声の再生開始までを短くするため、次を行う（`docs/spec.md` 2.2 の目標は3秒以内）。

- `DOOR_WARMUP=1` のとき、会話 Agent がセッション開始時に ASR・LLM・TTS を並列に先読みする。API プロセス起動時には呼ばないため、on-demand GPU は利用前に起動しない。
- 受付セッションでは、挨拶と並行してSupabaseから当日の予約を取得し、確定した発話の照合をキャッシュ済みデータで行う（`monban_backend.reception.service`）。同時取得は1回にまとめ、失敗時は古いデータを使わない。来店を記録する直前には予約を読み直す。
- 受付の遅延を比較できるよう、ログに`calendar fetched duration_ms`、`turn_to_match_ms`、`turn_to_first_audio_ms`を出す。予約名や認証情報は出さない。
- 挨拶（玄関は「はい、どちら様でしょうか」、店舗は`shop.greeting`）は`session.say`で固定再生し、LLMの往復をなくす。
- Modal の GPU endpoints は会話中の短い間隔では warm に保たれ、一定時間無通信の後に scale-to-zero する。`max_tokens`で返答を短く保ち、`timeout`で固まった呼び出しを打ち切る。

## 設定

`.env.example`を`.env`へコピーし、上のコマンドでランダムな32-byte `DOOR_API_KEY` を生成してください。`.env`を共有したり、キーをソースやブラウザーコードに埋め込んだりしないでください。LiveKit、Ollama、ASR、TTSのURLとモデル名も環境に合わせます。主な設定:

- `LIVEKIT_URL` / `LIVEKIT_WS_URL`: サーバーAPI用URLとブラウザーから到達するWebSocket URL
- `DOOR_PUBLIC_API_HOSTNAME`: 本番 API の公開ホスト名。`DOOR_ALLOWED_HOSTS`にも含めます。
- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`: LiveKit認証情報
- `DOOR_API_KEY`: アプリAPIのBearerキー。32-byte以上が必要で、未設定なら起動しません。
- `DOOR_ENV`: `development`または`production`。productionでは開発用LiveKit資格情報を拒否します。LiveKit APIはHTTPS、loopback、または明示的に許可したTailscale IPに限定し、ブラウザー用URLはWSSを要求します。
- `DOOR_LIVEKIT_TRUSTED_HTTP_HOSTS`: 本番LiveKit APIが同一Tailnet内にある場合だけ、許可するTailscale IPを列挙します。HTTPのまま使う場合は、Tailscale ACLで接続端末を制限してください。
- `DOOR_MAX_TTS_RESPONSE_BYTES` / `DOOR_API_REQUESTS_PER_MINUTE` / `DOOR_MAX_CONCURRENT_REQUESTS` / `DOOR_MAX_QUEUED_REQUESTS` / `DOOR_QUEUE_WAIT_SECONDS`: 音声サイズ、API要求数、同時処理数、待機数、待機時間の上限
- `DOOR_OLLAMA_BASE_URL` / `DOOR_LLM_MODEL` / `DOOR_LLM_API_KEY`: LLM endpoint とモデル ID、bearer token
- `DOOR_ASR_API_KEY` / `DOOR_TTS_API_KEY`: Modal ASR/TTS endpoint 用 bearer token
- `DOOR_LLM_MAX_TOKENS` / `DOOR_LLM_TIMEOUT_SECONDS`: 返答の最大トークン数（既定96）と応答待ち時間
- `DOOR_INFERENCE_ON_DEMAND`: `1` の場合、`/api/status` はモデル endpoints に問い合わせず、アイドル時の GPU 起動を避ける
- `DOOR_WARMUP` / `DOOR_WARMUP_TIMEOUT_SECONDS`: LiveKit session 開始時に ASR・LLM・TTS を先読みするか（既定`1`）、先読み待ち時間（既定90秒）
- `DOOR_CALENDAR_CACHE_SECONDS`: 受付で当日の予約を再利用する秒数（既定30秒）。短くするとキャンセルなどの反映が早まり、長くするとSupabaseへの問い合わせを減らせる
- `DOOR_RESERVATION_TIMEOUT_SECONDS`: 予約の読み取りと来店記録を待つ時間（既定5秒）
- `DOOR_ASR_BASE_URL` / `DOOR_ASR_API_MODEL`: ASR接続先とモデルID
- `DOOR_TTS_BASE_URL` / `DOOR_TTS_API_MODEL`: TTS接続先とモデルID
- `DOOR_TTS_VOICE` / `DOOR_TTS_SAMPLE_RATE`: 合成音声の声とPCMサンプルレート
- `DOOR_HOUSE_RULES`: セッションに初期適用する住人ルール
- `DOOR_TURN_DETECTOR`: `vad`が既定値。`mini`はLiveKitの追加モデル条件を確認したうえで明示的に選択
- `DOOR_SUPABASE_URL` / `DOOR_SUPABASE_ANON_KEY`: SupabaseのプロジェクトURLと公開APIキー。`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_PUBLISHABLE_KEY`も読み取ります。URLとキーの両方が設定されているときだけEdge Functionを呼び出します。productionではURLにHTTPSが必要です。`service_role` / secret keyは設定しないでください。
- `DOOR_HOUSE_SETTINGS_TIMEOUT_SECONDS`: 家の設定を待つ時間。既定は1.5秒
- `DOOR_RELAY_LIVEKIT_URL`: 中継が入るLiveKitのURL。既定は`LIVEKIT_URL`の`http`を`ws`に替えたものです。
- `DOOR_MAX_RELAY_SESSIONS` / `DOOR_RELAY_START_TIMEOUT_SECONDS` / `DOOR_RELAY_MAX_SESSION_SECONDS`: 同時に中継する会話の数、開始のJSONを待つ時間、1回の会話の上限時間

開発用の`devkey` / `secret`を公開ネットワークで使わないでください。APIとモデルサービスは信頼されたネットワーク内に限定してください。

### Production

本番では`DOOR_ENV=production`にし、`DOOR_API_KEY`とLiveKitのキー/秘密鍵をSecret Managerまたはデプロイ環境のシークレット機能から注入してください。APIキーとLiveKit秘密鍵は別々のランダム値にし、キーは定期ローテーションします。本番のLiveKitサーバーは開発モードを使わず、`LIVEKIT_WS_URL=wss://...`を設定してください。LiveKit APIがHTTPSを提供するなら`LIVEKIT_URL=https://...`を使います。同一のTailnetでのみ到達できるLiveKit APIをHTTPで使う場合は、そのIPを`DOOR_LIVEKIT_TRUSTED_HTTP_HOSTS`に明示し、Tailnet ACLで接続端末を制限します。OpenAPIは`/openapi.json`、Swagger UIは`/docs`、ReDocは`/redoc`で表示します。仕様書にAPI操作のBearer認証を記載し、実際のAPI要求にも引き続きAPIキーを必須にします。

FastAPIはループバックにバインドし、TLS終端、アクセス制御、ホスト許可リスト、要求本文サイズ制限、分散レート制限を備えた信頼済みリバースプロキシ経由だけで公開してください。Uvicornのproxy headersは実際のプロキシIPだけを信頼するよう設定します。例の`127.0.0.1`は同じホスト上のプロキシの場合です。APIは非同期I/Oで同時接続を処理し、アプリ内の同時処理枠と短い有界待ち行列で上流サービスへの負荷を平準化します。枠を超えた要求は無制限にメモリへ積まず、再試行可能な`503`で戻します。Uvicornにも接続数とOS待ち行列の上限を設定します。複数ワーカーや複数インスタンスでは、アプリ内の要求数・同時数・待機数制限はプロセスごとに適用されるため、プロキシ側にも共有レート制限と同時要求制限を設定してください。最初は1ワーカーで運用し、負荷試験で上流モデルとLiveKitの余力を確認してからワーカー数を増やします。APIキーをブラウザーのコードに埋め込まないでください。

本番プロキシが同じホストのループバックで待ち受ける場合のAPI起動例:

```powershell
$env:DOOR_ENV = "production"
uv run uvicorn monban_backend.api:app --host 127.0.0.1 --port 8093 --workers 1 --limit-concurrency 64 --backlog 128 --timeout-keep-alive 5 --timeout-graceful-shutdown 30 --proxy-headers --forwarded-allow-ips=127.0.0.1
```

`DOOR_ALLOWED_HOSTS`には公開する正確なホスト名を列挙してください。リバースプロキシでは要求本文を16 KiB以下に制限し、APIキー単位のレート制限と同時要求制限を設定します。アプリ内の要求数・容量制限は単一プロセス用の追加防御で、分散制限の代替ではありません。`--limit-concurrency`を増やす場合は、API側の同時処理数と上流サービスの処理能力に合わせてください。

NginxのTLS終端・WebSocket中継・レート制限の設定例は`deploy/nginx/monban.conf`、ModSecurity/CRSの例は`deploy/waf/modsecurity-monban.conf`にあります。クエリ文字列をログへ出さない設定と、`X-Forwarded-Proto`をFastAPIへ渡す設定を含みます。WebRTC音声はNginxを通らないため、LiveKitのUDPポートまたはTURN経路を別途開放してください。

## WebRTCネットワーク

クライアントは HTTPS API と LiveKit Cloud の `wss://` URL を使います。WebRTC 音声メディアは API Tunnel ではなく LiveKit Cloud/TURN 経由で流れます。

## 確認

```powershell
uv run pytest
```

テストは会話ルール、サービス準備状態、接続失敗時の応答、WAVプレビュー形式、中継の受け口、住人ルールの組み立て、端末設定と店舗情報の読み込み、予約照合と来店記録を確認します。中継と受付の試験では、LiveKitとSupabaseの代わりにモックを使います。実機のマイク・スピーカーを通した遅延と割り込み、およびlabpcとブラウザー間のICE到達性は、対象ネットワーク上で別途確認してください。

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
DOOR_ASR_BASE_URL=http://127.0.0.1:18100 DOOR_TTS_BASE_URL=http://127.0.0.1:18100 DOOR_OLLAMA_BASE_URL=http://127.0.0.1:18100 uv run python -m monban_backend.agent dev
uv run uvicorn monban_backend.api:app --host 127.0.0.1 --port 8093
uv run python -m scripts.psoc_sim --url ws://127.0.0.1:8093/api/relay visitor.wav
```
