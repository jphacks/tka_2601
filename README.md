# MONBAN

今あるインターホンに後付けする来客対応AI。

## 製品概要

MONBANは、今あるインターホンに後付けし、不在時の来客対応を任せられるAIデバイスです。住人に代わってAIが訪問者と会話し、来客をスマホにすぐ通知します。外出先でも、会話の内容や対応結果を確認できます。

# この2日間でつくったもの

設計から始めて、筐体、音声対話システム、スマホアプリをつくり、実際に動く試作機まで仕上げました。既存のインターホンを外側から操作する機構と、来客の話を聞いて返すAIを組み合わせています。

### 筐体：CAD設計から部品調達、組み立てまで

インターホンのボタンを押すための機構と、基板を収める筐体をCADで設計しました。3Dプリンターで出力できるように部品を分け、ボタンの位置に合わせて押し込み部分やサーボの取り付け位置を調整しています。

電子回路も、Infineonの基板の仕様を調べるところから始めました。必要な部品を秋月電子で調達し、配線と組み立てを進め、実際にインターホンを操作するところまで動かしています。この2日間で、CAD上の設計を、手に取って動かせる試作機にしました。

<!-- 写真：CADでの設計、3Dプリントした部品、配線、組み立てた試作機 -->

<img width="3360" height="2100" alt="image" src="https://github.com/user-attachments/assets/75ae23cf-cfe3-4f85-aa74-4bfeb87bf410" />


### ボイスエージェント：聞く、考える、話す仕組みを実装

音声を文字にするSTT、返答を考えるローカルLLM、返答を声にするTTSを組み合わせ、来客と会話するシステムを設計・実装しました。音声認識にはKotoba-Whisper、返答の生成にはOllamaで動かすGemma 4、音声合成にはIrodori-TTSを使っています。各モデルは自分たちのサーバーで動かします。

会話の制御にはLiveKit Agentsを採用しました。Silero VADで人が話し始めたことを検出し、ブラウザーでの通話では、AIが話している途中でも割り込めるようにしています。相手の発話を受けて返答するところまで、一連の音声対話として実装しています。

<!-- 画像・動画：音声対話の流れ、実際の会話、割り込みの様子 -->

### スマホアプリ：外出先でも来客をすぐに把握

ExpoとReact Nativeでスマホアプリを開発し、Supabaseにつなぎました。来客をプッシュ通知で知らせ、外出先でも会話の内容や対応結果を確認できます。動作モードやAIへの指示もアプリから設定できます。

家族で使うための招待機能も実装しました。不在時のAI応答と、スマホでの状況確認をつなぐアプリです。

<!-- 画像：来客一覧、会話の詳細、動作モード・AIへの指示の設定 -->

<img width="400" alt="image" src="https://github.com/user-attachments/assets/0c5175a3-7c73-4a9d-9987-b232c3dcf7b7" />

<img width="400" alt="Screenshot iPhone 17 2026-10-18 at 12 19 38" src="https://github.com/user-attachments/assets/6ae8c03c-a449-4384-a043-dade78ac8b9d" />

<img width="400" alt="image" src="https://github.com/user-attachments/assets/9aa2fd7a-6a1e-476e-8796-81a05ca6e8ad" />



# 競合との違い

MONBANの特長は、既存の室内親機への後付けで、不在時の来客との対話まで任せられることです。

| 競合 | 来客への対応方法 | MONBANとの違い |
|---|---|---|
| SwitchBot（[ボット](https://www.switchbot.jp/products/switchbot-bot)・[ドアホン](https://www.switchbot.jp/products/switchbot-smart-video-doorbell)） | ボットは物理ボタンを押し、ドアホンは[登録音声で自動応答](https://support.switch-bot.com/hc/ja/articles/31601503495319)する。 | MONBANは既存親機を操作し、訪問者の返答に合わせた対話まで自動で行う。 |
| [Alexa+ Greetings](https://www.aboutamazon.com/news/devices/alexa-ring-doorbell-ai-greetings)（比較機種：[Ring Wired Doorbell 4K Pro](https://ring.com/products/wired-doorbell-pro)） | [有線給電の屋外ドアベルを設置](https://ring.com/gb/en/support/articles/2guno/installing-wired-doorbell-4k-pro-hardwired)し、AIが会話する。 | MONBANは屋外機器の交換や既存配線の変更をせず、室内への後付けでAI応答を追加する。 |
| [SwannShield](https://us.swann.com/pages/swannshield) | [対応する専用ドアベル](https://support.swann.com/hc/en-us/articles/41122689903385-SwannShield-Concierge-How-It-Works)でAIが会話する。 | MONBANは室内親機を使うため、集合住宅の共用玄関に別のドアベルを追加しない構成。 |

競合の記載は2026年10月18日時点の公式情報に基づきます。MONBANの対応機種は今後広げていきます。

# 実際の動作

以下は、各場面での応答例です。

### パターン1：配達

配達員には、まず宅配ボックスへの配達を案内します。

> 「宅配ボックスに入れていただけますか。」

宅配ボックスがない場合は、AIでは対面で受け取れないことを伝え、再配達をお願いします。

> 「私はAIのため、対面で荷物を受け取ることができません。再配達をお願いします。」

<!-- 動画：配達 -->

### パターン2：集金

NHKの集金を名乗る訪問者には、AIでは支払いができないことを伝えます。

> 「家主に代わってAIが応対しています。この場ではお支払いできません。」

<!-- 動画：集金 -->

### パターン3：営業

試供品や無料体験などの営業には、住人の方針に沿って断ります。

> 「申し訳ありませんが、営業のご案内はお断りしています。」

<!-- 動画：営業 -->

### パターン4：予想外の届け物

「干していた服が落ちていたので届けに来ました」という来訪にも、用件を聞いて置き場所を案内します。

> 「届けてくださってありがとうございます。玄関の前に置いていただけますか。」

決まった訪問理由だけでなく、予想外の用件にも相手の話に合わせて返答します。

<!-- 動画：落ちていた服の届け物 -->

# 技術スタック

<!-- 技術スタック図をここに追加 -->

<img width="741" height="417" alt="image" src="https://github.com/user-attachments/assets/302b0e18-ff96-4eab-9c55-f6bd7681c5fa" />

