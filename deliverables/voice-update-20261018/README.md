# 音声認識・宅配会話の更新（2026-10-18）

この更新はサーバーへ未適用です。このMacのWeb UIとM5のテスト機能は更新済みです。

## 修正内容

- 「じゃあ置いておきました」「置いてきました」「入れておきました」を設置完了として扱い、写真確認へ進めます。用件や置き場所を聞き直す返答を抑止します。
- 「まだ置いていません」、これから行う操作、質問、後からの訂正を完了と誤判定しません。
- 実際に出た認識結果「荷物を売ってきました」「通っておきました」は、宅配の置き場所を案内済みの場合に完了したか確認し、「はい」で次へ進みます。認識結果を黙って書き換えません。
- AgentからKotobaへ日本語の宅配用語ヒントを送信し、ASRで実際にWhisperのprompt_idsへ渡します。ヒントは200文字・223トークン以内です。前の認識文は再入力しません。
- Kotobaの探索候補を1から3へ変更します。認識改善と引き換えにGPU処理時間が増える可能性があります。サーバー適用後に実測してください。遅ければASR起動環境で `KOTOBA_BEAMS=1` に戻せます（1～5）。

## 対象ファイル

`updated/backend/voice-agent/door_backend/agent.py` と `visit_policy.py` はGitHub `jphacks/tka_2601` の取得版を基準にした更新です。WebRTC・中継プロトコルや既存の接続設定は変更しません。

`updated/asr/kotoba_server.py` と **新規** `kotoba_decoding.py` は、現在のKotoba ASRスクリプトと同じフォルダへ配置します。ASRはバックエンドとは別プロセスです。

`.env`、認証キー、実際の会話履歴、録音、モデル本体は含めていません。

## Windows / PowerShellでの適用

1. ZIPをサーバーで展開します。以下の3つのパスを実際の配置に合わせてください。Backendは `door_backend` フォルダを含む場所、Asrは **稼働中プロセスが使っている** `kotoba_server.py` の場所です。

```powershell
$Package = "C:\path\voice-update-20261018"
$Backend = "C:\path\door-voice-backend"
$Asr = "C:\path\door-prototype\livekit-poc"
python "$Package\apply_update.py" --backend "$Backend" --asr "$Asr"
```

既知の更新前ファイルとの一致、全配置先、Python構文を読み取り専用で確認します。未確認の変更があればファイルを書かず停止します。その場合は `update.patch` と既存の変更を見比べてマージしてください。パッチ内の `asr/` は実際のASRフォルダへ読み替えます。

2. 会話が終わった状態で、現在使っている起動方法から **Door AgentワーカーとKotoba ASRだけ** 停止します。タスク・サービスで起動している場合は、そこで停止してください。自動再起動があれば更新中の再起動を止めてください。API・LiveKit・TTSを止める必要はありません。

3. 次を実行します。元ファイルをBackend直下の `voice-update-backup-日時` にバックアップしてから4ファイルを配置します。

```powershell
python "$Package\apply_update.py" --backend "$Backend" --asr "$Asr" --apply
```

4. 既存の依存環境でテストします。新しいモデルのダウンロードは不要です。下記はバックエンドがuv管理の場合です。

```powershell
Set-Location $Backend
$env:PYTHONPATH = $Backend
uv run --extra test python -m pytest -q "$Package\tests"
```

5. **いつもの起動方法**でKotoba ASR、Door Agentを再起動します。手動起動する構成では、ASRは従来のCUDA用Pythonで `kotoba_server.py`、AgentはBackendで `uv run python -m door_backend.agent start` です。サービス管理中のプロセスを二重起動しないでください。既存の `.env` をそのまま使用します。

```powershell
Invoke-RestMethod http://127.0.0.1:18095/health
```

`ready: true` とAgentのLiveKit登録完了を確認します。ASRの初回起動はGPUの初期化待ちがあります。

## 実機での確認

MacのWeb UI `http://127.0.0.1:8767/` を開き、調整中なら保存または取消でチャイム待機へ戻します。チャイム後、「宅配便です」→「じゃあ置いておきました」→「写真も撮りました」の順に話してください。Web UIの来訪者（認識結果）とAIの返答を見て、置き場所を繰り返さず、写真確認・終話へ進むことを確認します。

認識結果そのもの、返答までの時間、否定の「まだ置いていません」も確認してください。CUDA実機での認識率・遅延の比較はこのMacでは未実施です。

## 元へ戻す

同じ2プロセスを停止してから、適用時に表示されたバックアップフォルダを指定して実行します。

```powershell
$Backup = "C:\path\door-voice-backend\voice-update-backup-日時"
Get-Content "$Backup\restore.json" -Raw | ConvertFrom-Json | ForEach-Object {
    Copy-Item -LiteralPath $_.backup -Destination $_.target -Force
}
```

従来の起動方法で再起動します。新規helperファイルは旧ASRから参照されないため、そのまま置いて構いません。

## ローカルでの検証

- 更新用ファイルそのものに対する会話ルール・ASRヒント・適用ツールのテスト：36件成功。
- Mac側Web UI：履歴の保存/復元、API、操作コマンド、入力制限を検証。
- M5：押下・復帰・中止・二重操作拒否・未保存設定のテスト・NVS維持をホストテストで検証し、USB書き込み済み。

WhisperのAPI仕様：[Transformers Whisper](https://huggingface.co/docs/transformers/model_doc/whisper)、使用モデル：[Kotoba Whisper v2.1](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.1)。
