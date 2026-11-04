# プッシャー割り当ての実装・検証記録

Issue [#39](https://github.com/jphacks/tka_2601/issues/39)の実装記録。DB/APIは[#40](https://github.com/jphacks/tka_2601/issues/40)、XIAOは[#41](https://github.com/jphacks/tka_2601/issues/41)、アプリは[#42](https://github.com/jphacks/tka_2601/issues/42)に対応する。基準はmain`419bf5f`、作業ブランチは`codex/pusher-assignment`。

## 実装した経路

スマホで通話用の使用個数1/2と機能を一括保存し、XIAOが待機中に取得・永続保存・読戻し・有効化を行って結果を報告する。クラウド保存と本体反映を分けて表示する。1個共有、2個別、役割の入れ替えに対応する。3番の解錠は既存のUSB操作として保持する。

共有押下を中断した場合や、途中で電源が落ちた場合には、自動で追加押下しない。未完了記録を保持し、操作者による親機の待機確認を必要とする。USBの`@confirm`と調整画面の確認操作は押下を伴わない。

対象はXIAO＋自作基板。基板到着までは購入済み部品で実装を進める。旧E84＋M5は対象外。

## 実行した検証

| 検証 | 結果と範囲 |
|---|---|
| XIAOホスト回帰 | ASan/UBSan付きで成功。既存の音声・通信・サーボ・調整UIを含む。[ログ](pusher-assignment/host.log) |
| ESP32-S3通常ビルド | 成功。ユーザーの私有設定ヘッダーを検証用のコピーへ持ち込まない。[ログ](pusher-assignment/build.log) |
| QEMU | 実機用バイナリを起動して成功。1個共有、未使用出力の拒否、再送、設定復元、共有動作中の電源断、起動後の抑止、明示解除、物理2共有、2個逆割り当てを確認。[ログ](pusher-assignment/qemu.log) |
| ホストでの会話処理 | 既存サーバーと実際の通話制御コードの回帰5件成功。音声AIと物理I/Oは既存テストの模擬境界であり、実際の会話品質や押下の証拠にはしない。[ログ](pusher-assignment/host-conversation.log) |
| 設定API単体 | Denoの25件、型検査、lint成功。認証後の本体ID、設定形式、適用報告、専用の小さい応答を確認。[ログ](pusher-assignment/device-api.log) |
| 実ローカルDB | 全5スイート263項目成功。追加50項目でRLS・CAS・版・ACKを検証。独立した接続からの同時保存は1件成功、1件競合。security advisorsの指摘なし。[ログ](pusher-assignment/database.log) |
| 実HTTP・認証・DB | production handlerと既存ローカルAuth/JWT/Data API/DBで25項目成功。共有・入替の保存から取得・ACK・読戻しまで確認。[ログ](pusher-assignment/http-local.log) |
| 実ブラウザー | Chromiumで調整画面、実際のホスト制御コード、編集・取消、チャイム登録、通話開始・停止、狭い画面の回帰が成功。物理I/Oと音声AIは既存ベンチの模擬境界。[ログ](pusher-assignment/browser.log) |
| モバイル | 既存を含む63テスト、型検査、変更ファイルのlint成功。Web向けの実バンドルも成功。全体lintには変更外の既存エラー2件・警告2件が残る。[テストログ](pusher-assignment/mobile.log) |

QEMUにWi-Fiや実際のI2S音声はない。CPU・フラッシュ・PSRAM・LEDCの検証を、サーボの接続や親機の通話成立の証拠にはしない。アプリから実際のXIAOへのインターネット経由の反映、実サーボ、親機との組み合わせは未確認。本番デプロイとマージも未実施。

## 再現手順

実装ブランチのリポジトリ直下で実行する。

```sh
bash firmware/xiao/run.sh test
bash firmware/xiao/run.sh build
bash firmware/xiao/run.sh qemu
bash firmware/xiao/run.sh e2e
```

QEMUとPython依存が既にあれば、`XIAO_QEMU`・`XIAO_E2E_PYTHON`でその実行ファイルを指定して再利用できる。実際の接続先や秘密ヘッダーはホスト・QEMU・会話回帰へコピーしない。

実HTTP確認は既存ローカルSupabaseを起動した環境で行う。

```sh
SUPABASE_TELEMETRY_DISABLED=1 deno run --frozen --cached-only \
  --config supabase/functions/device/deno.json --allow-read --allow-env \
  --allow-run=supabase,docker --allow-net=127.0.0.1,localhost \
  supabase/tests/pusher_http_local.ts
```

既存コンテナを再利用し、resetや複製は行わない。テストの一時ユーザー・世帯・本体とHTTPサーバーは終了処理で削除・停止し、残留がないことも確認した。

## 接続設定と導入

XIAOの`.env`へ既存の`DOOR_DEVICE_KEY`に加え、`SUPABASE_URL`と`SUPABASE_PUBLISHABLE_KEY`を設定する。Supabase接続先の信頼するルートCAを指定して、次を実行する。秘密値は表示しない。

```sh
cd firmware/xiao
python3 configure_api.py
python3 configure_device.py --ca /path/to/trusted-root-ca.pem
bash run.sh build
```

`device_config.h`はGit対象外。ユーザー設定の生成・実機書き込みは今回実施していない。サーバー追加契約、XIAO、アプリの順に導入し、アプリで反映完了を確認してから取り付けを変更する。

## 判断と残る検証

独立レビューで、有効な店舗メニューが多い場合に総合設定応答が4KiBを超えることを再現した。そのためXIAOには`GET /device/pusher-settings`で希望設定だけを返す。実DBへメニュー100件を登録し、総合応答が4KiB超でも専用応答が512bytes未満になることを確認した。既存APIの互換性は維持する。

購入済み部品で、共有ボタンの開始・終話、手動操作、親機の自動終了、取消・電源断後の復旧を確認する必要がある。自作基板の到着後は電源・ピン対応・取り付け方向も再確認する。これらが済むまでは、対応親機での実機動作完了とはしない。

独立レビューで見つかった保存領域破損時の報告漏れも修正した。実設定を読めない場合は、適用した版・設定を推測せずnullとし、保存障害と要確認状態を報告する。2つの保存スロットを破損させた再起動から、状態だけのPUTと無出力を追加の統合テストで確認した。
