# E84 録音を受け取る FastAPI

`tools/fastapi_receiver.py` は E84 の WAV アップロード契約に対応する独立した受信アプリです。既存の会話バックエンドは変更しません。受信した WAV とメタデータを永続保存してから ID を ACK として返し、同じ ID の再送は重複保存しません。音声認識、LLM、M5 の機器制御は実行しません。

## 起動

```sh
python3 -m pip install -r tools/requirements-receiver.txt
# AUDIO_RECEIVER_TOKEN をローカルの環境変数または起動サービスの秘密設定へ入れる
python3 -m uvicorn tools.fastapi_receiver:create_app --factory \
  --host 127.0.0.1 --port 8770 --workers 1 --limit-concurrency 16 --no-access-log
```

- `AUDIO_RECEIVER_TOKEN`: 32〜511文字の Bearer トークン。ボードの `AUDIO_UPLOAD_TOKEN` と一致させます。未設定なら起動しません。
- `AUDIO_RECEIVER_DIRECTORY`: 保存先。既定は作業ディレクトリの `recordings` です。
- `PUT /v1/doorbell/recordings/{event_id}`: `Authorization: Bearer ...`、`Content-Type: audio/wav`、単一 `Content-Length`。音声は16kHz・16bit・mono PCM の標準44バイトヘッダー付き WAV、最大6秒。
- `X-Audio-Match-Score`: 有限の DTW 距離、手動録音なら `-1`。`X-Audio-Model-Version`: `1`。
- 永続保存後は `201`、同じ音声の再送は `200`、本文はどちらも `{event_id}\n`。同じ ID で異なる音声は `409`。
- `GET /api/status`: 同じ Bearer トークンで受信サービスの稼働状態を返します。この応答の `ready` は会話 AI の状態ではありません。

ボードは **HTTPS/443** で送信するため、このローカル HTTP ポートへ直接は接続しません。サーバーの HTTPS リバースプロキシで上記パスを転送し、ボードの `source/upload_config.h` にそのホストと証明書の信頼済みルート CA を設定してください。ボードの状態確認もこのアプリへ向ける場合は、`DOOR_API_HOST` と `DOOR_API_KEY` も受信アプリのホスト・トークンに合わせます。

このサーバーは1トークン・1デバイスの保存領域用です。スレッド内の排他制御を使うため **1ワーカー** で起動します。複数デバイスの所有者分離や複数ワーカー、保存容量・保持期間の管理が必要な場合は、既存サーバーの認証と永続ストレージへ組み込んでください。同時処理は4件まで、本文の受信待ちは10秒までで、上限や保存失敗の場合は ACK を返しません。

## 検証

```sh
python3 -m unittest discover -s tests -p 'test_fastapi_receiver.py' -v
```

認証、正常保存・再送・ID競合、WAVとHTTPヘッダーの検証、保存失敗時のACK抑止を、FastAPI の実際のルーティングを通して確認します。
