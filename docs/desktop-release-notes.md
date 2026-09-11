JARVIS 0.1.4です。

- 音声セッションをTachyonのGPT Live 1 APIへ移行しました。
- 深い推論はGPT-5.6 Terraへ委譲しながら、低遅延の自然な音声会話を利用できます。
- GPT Live固有の接続開始、字幕、ミュート、終了イベントへ対応しました。

- 起動時に更新を確認し、設定画面から署名付きアップデートを適用できます。
- 会話中は更新せず、更新後は「再起動する」で新しいバージョンに切り替えます。
- 初回のみ、ご利用のMacに合うアーカイブを展開してJARVIS.appをインストールしてください。
  Apple Siliconは `darwin-aarch64`、Intel Macは `darwin-x86_64` を選択します。

更新ファイルにはTauri updaterの署名を付与しています。Apple Developer IDによる署名・公証はまだ行っていません。
