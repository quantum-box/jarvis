# JARVIS

音声で対話する、Tauri 2製のデスクトップAIクライアント。Tachyon API経由でOpenAI Realtimeに接続し、vgpuで金色の回路が重なる3Dホログラム球体を描画します。

## 起動

Node.js 22以降、Rust、macOSではXcode Command Line Toolsが必要です。

```sh
npm install
npm run tauri dev
```

ブラウザだけでUIを確認する場合は `npm run dev` を実行し、`http://127.0.0.1:1420` を開きます。

Tauri版のAPI通信には公式HTTPプラグインを使います。ブラウザ版で実際に接続する場合は、TachyonのCORS設定で `x-realtime-call-id` と `x-realtime-sideband` を公開する必要があります。

## 接続設定

右上の「Tachyonにログイン」から、既存Tachyonアカウントのユーザー名・パスワードでログインします。追加認証（SMS・認証アプリ・メール）や初回パスワード変更にも対応します。ログイン後は `/v1/me` からテナント一覧を取得します。接続設定で利用するテナントを選んでください。Chatroom IDは空欄なら会話開始時に自動作成します。テナントにはOpenAIプロバイダーの設定とRealtime利用権限が必要です。OpenAI APIキーをクライアントへ入力する必要はありません。

「会話をはじめる」でマイクを許可すると音声対話が始まります。接続後はテキスト入力もできます。終了でマイク、音声再生、WebRTCを解放します。

既定の会話モデルは `gpt-realtime-2.1` です。[Tachyon PR #9325](https://github.com/quantum-box/tachyon-apps/pull/9325) を含むAPIが必要です。保存済みの旧既定値 `gpt-realtime` / `gpt-realtime-2` は読み込み時に2.1へ移行します。他のモデルは保持し、更新後に接続設定から手動でモデルを保存した場合は、その選択を次回以降も使います。対応issue: [PLT-4245](https://linear.app/issue/PLT-4245)。

- 接続先などの設定はローカルに保存します。パスワード・トークンは保存しません。再起動後は再ログインします。access tokenは有効期限の30秒前から必要時に更新します。ログアウトで音声接続と認証情報を破棄し、このセッションのrefresh tokenを失効させます（失効APIはbest effort）。
- 会話テキストは画面上のセッション内だけで保持します。Tachyon側の監査・履歴保存はサーバー設定に従います。
- 音声は接続中にTachyonが仲介したOpenAI Realtimeへ送信されます。
- AIの思考中は回転と光の走査が速まり、発話中は受信音声の音量で球体の直径・発光が変わります。状態の切替は滑らかに補間します。回転は連続ノイズで不規則に加減速し、層ごとの回路密度も部分的に増減します。
- WebGPU非対応環境では代替表示に切り替わります。OSの「視差効果を減らす」設定では動きを抑えます。
- Tauri版のAPI接続先はHTTPSを使用してください。
- OS操作やローカルシェル実行、常時待受、ウェイクワードには対応していません。

## 認証設定

[本番Platform UI](https://platform-ui.txcloud.app/) の公開Cognito client設定を既定値として使用します（2026-09-05確認）。別環境では `.env.example` を参考に `VITE_COGNITO_REGION` / `VITE_COGNITO_CLIENT_ID` をビルド時に指定するか、ログイン前の接続設定から変更できます。client IDは公開設定で、client secretは使いません。APIのBearerにはCognito access tokenを使い、ID tokenは送信しません。

新規登録・パスワード再設定・MFAセットアップはTachyon側で行ってください。既存アカウントへのログインだけを行い、自動サインアップはしません。

## 開発・検証

```sh
npm test
npm run build
npm run tauri build
```

`.app` だけを生成する場合は `npm run tauri build -- --debug --bundles app` を使います。

Realtime実装は既存Tachyonの `POST /v1/llms/chatrooms/{chatroom_id}/agent/realtime/call` 契約に合わせています。

仕様資料: [vgpu](https://github.com/vercel-labs/vgpu)、[OpenAI Realtime calls](https://developers.openai.com/api/reference/typescript/resources/realtime/subresources/calls/methods/create)。作業管理: [PLT-4214](https://linear.app/issue/PLT-4214)、ログイン [PLT-4229](https://linear.app/issue/PLT-4229)、ホログラム [PLT-4230](https://linear.app/issue/PLT-4230)。

開発用の動作プレビュー: `npm run dev` 後、`http://127.0.0.1:1420/?preview=motion` で待機・思考・発話を切り替えられます。模擬音量を使い、音声/API接続は行いません。製品ビルドにはこのプレビューは含まれません。

会話パネルは初期状態で閉じています。右上の会話ボタンで開閉でき、閉じても履歴と入力は維持されます。パネル内の×またはEscapeでも閉じられます。

球体は画面全体に固定した背景として描画し、会話パネルの開閉やレイアウトに依存せず大きく表示します。

## CI

PR・mainへのpush・手動実行で、以下を検証します。

- Node.js 22 / 24: 型チェック、ユニットテスト、フロントエンドビルド
- Rust: rustfmt、Clippy（警告をエラー扱い）、テスト
- macOS 15: Apple Silicon / Intelそれぞれでリリースビルドし、`.app` のInfo.plistとCPUアーキテクチャを確認
- GitHub Actions: actionlintによるworkflow検証
- npm / Cargo: 既知の脆弱性を監査（毎週月曜にも実行）。npmはhigh以上、Cargoは既知の脆弱性を失敗扱い

`CI passed` は全ビルド・品質チェックの成功を集約します。依存監査は `npm audit` / `Cargo audit` として独立して表示します。Dependabotはnpm・Cargo・GitHub Actionsの更新PRを毎週作成します。

macOSの検証用アプリはActionsのartifactから3日間ダウンロードできます。Developer ID署名・公証済みの配布版ではありません。マイク・WebGPU描画・認証済み音声対話は手動検証が必要です。全ジョブは標準GitHub-hosted runnerを使用します。

## モバイルビルド

`Mobile CI` はiOS Simulator（ARM64）の署名なしdebugアプリと、Android（ARM64）のdebug APKをPR・mainへのpush・手動実行で生成します。iOSはマイク利用説明とSimulator向けバイナリ、Androidはマイク権限・CPUアーキテクチャ・debug署名も確認します。両方の成功を `Mobile CI passed` に集約し、検証用artifactは3日間保存します。

ローカルでは[Tauriのモバイル開発環境](https://v2.tauri.app/start/prerequisites/)を用意したうえで、対象の初期化コマンドを実行してください。

```sh
# macOS + Xcode + XcodeGen + iOS Rust target
npm run mobile:ios:init
npm run tauri ios build -- --debug --target aarch64-sim --no-sign --archive-only --ci -- --locked

# Java 17 + Android SDK/NDK + Android Rust target
# ANDROID_HOME / NDK_HOMEを設定してから実行
npm run mobile:android:init
npm run tauri android build -- --debug --target aarch64 --apk --ci -- --locked
```

`src-tauri/gen/apple` / `android` はロック済みTauri CLIで再生成するためGit管理対象外です。Androidのマイク権限追加は `scripts/prepare-android.py`、iOSのマイク利用説明は `Info.plist` と `tauri.ios.conf.json` で管理します。生成ディレクトリを直接編集してもCIには反映されません。

ビルド成功はモバイルの動作保証ではありません。画面サイズ対応・マイク許可・音声入出力・認証・WebGPU描画は実機未検証です。iOS artifactはSimulator専用で、iPhoneへのインストールやApp Store配布には使えません。Androidはdebug署名の検証用APKで、Google Play配布版ではありません。

## ライセンス

[MIT License](LICENSE) — Copyright (c) 2026 Quantum Box.

依存ライブラリやフォントには、それぞれのライセンスが適用されます。TachyonやOpenAIなどの外部サービスの利用には、各サービスのアカウント・権限・利用条件が別途必要です。
