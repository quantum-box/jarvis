# JARVIS

音声で対話する、Tauri 2製のデスクトップAIクライアント。Tachyon API経由でOpenAI GPT Liveに接続し、vgpuで金色の回路が重なる3Dホログラム球体を描画します。

## 起動

Node.js 22以降、Rust、macOSではXcode Command Line Toolsが必要です。

```sh
npm install
npm run tauri dev
```

ブラウザだけでUIを確認する場合は `npm run dev` を実行し、`http://127.0.0.1:1420` を開きます。

Tauri版のAPI通信には公式HTTPプラグインを使います。

## 接続設定

右上の「Tachyonにログイン」から、既存Tachyonアカウントのユーザー名・パスワードでログインします。追加認証（SMS・認証アプリ・メール）や初回パスワード変更にも対応します。ログイン後は `/v1/me` からテナント一覧を取得します。接続設定で利用するテナントを選んでください。Chatroom IDが空欄なら、この起動中の初回の会話開始時に自動作成し、アプリを終了またはログアウトするまでは同じChatroomを履歴の単位として利用します。「会話をはじめる」たびに、そのChatroom内へ新しいGPT Live sessionを作成します。テナントにはOpenAIプロバイダー設定とLive利用権限が必要です。OpenAI APIキーをクライアントへ入力する必要はありません。

「会話をはじめる」でマイクを許可すると音声対話が始まります。GPT Liveでは音声入力を使います。終了時は `session.close` の完了を待ってから、マイク、音声再生、WebRTCを解放します。旧Realtimeモデルを明示した場合のみ、従来のテキスト入力も利用できます。

既定の会話モデルは `gpt-live-1`、Responses delegationのバックエンドは `gpt-5.6-terra` です。Tachyonの `POST /v1/llms/chatrooms/{chatroom_id}/agent/live/session` が必要です。保存済みの旧既定値 `gpt-realtime` / `gpt-realtime-2` / `gpt-realtime-2.1` は読み込み時にGPT Liveへ移行します。他のモデルは保持します。対応issue: [PLT-4531](https://linear.app/issue/PLT-4531)。

- 接続先などの設定はローカルに保存します。macOS/iOSではrefresh tokenとユーザー名をOSのキーチェーンに保存し、再起動時にCognitoで更新してログイン状態を復元します。パスワード・access token・ID tokenは永続化しません。ブラウザーおよびその他のOSではセッションはメモリ内のみです。access tokenは有効期限の30秒前から必要時に更新します。ログアウト・refresh token失効時は保存情報を削除し、一時的な通信障害では保持します。ログアウト時の失効APIはbest effortです。
- 会話テキストは画面上のセッション内だけで保持します。Tachyon側の監査・履歴保存はサーバー設定に従います。
- 音声は接続中にTachyonが仲介したOpenAI GPT Liveへ送信されます。
- AIの思考中は回転と光の走査が速まり、発話中は受信音声の音量で球体の直径・発光が変わります。状態の切替は滑らかに補間します。回転は連続ノイズで不規則に加減速し、層ごとの回路密度も部分的に増減します。
- WebGPU非対応環境では代替表示に切り替わります。OSの「視差効果を減らす」設定では動きを抑えます。
- Tauri版のAPI接続先はHTTPSを使用してください。
- macOS版では、起動中の外部アプリの前面表示とショートカット送信に対応します。ローカルシェル実行、常時待受、ウェイクワードには対応していません。

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

GPT Live実装はTachyonの `POST /v1/llms/chatrooms/{chatroom_id}/agent/live/session` 契約に合わせています。明示的に選択した旧Realtimeモデルでは従来の `/agent/realtime/call` を使用します。

仕様資料: [vgpu](https://github.com/vercel-labs/vgpu)、[OpenAI GPT Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)、[GPT Live session management](https://developers.openai.com/api/docs/guides/live-conversations)。作業管理: [PLT-4531](https://linear.app/issue/PLT-4531)、ログイン [PLT-4229](https://linear.app/issue/PLT-4229)、ホログラム [PLT-4230](https://linear.app/issue/PLT-4230)。

開発用の動作プレビュー: `npm run dev` 後、`http://127.0.0.1:1420/?preview=motion` で待機・思考・発話を切り替えられます。模擬音量を使い、音声/API接続は行いません。製品ビルドにはこのプレビューは含まれません。

会話パネルは初期状態で閉じています。右上の会話ボタンで開閉でき、閉じても履歴と入力は維持されます。パネル内の×またはEscapeでも閉じられます。

球体は画面全体に固定した背景として描画し、会話パネルの開閉やレイアウトに依存せず大きく表示します。

## 音声でのウィンドウ操作

macOS版では、会話中にJARVIS内のブラウザウィンドウを音声で操作できます。

- 「ブラウザをもう1つ開いて」— 新しいウィンドウを追加
- 「今のウィンドウを左に移動して」「幅を800にして」「左右半分ずつに並べて」— 移動・サイズ変更。位置と大きさはJARVISの表示領域と最小サイズの範囲に収まります
- 「このウィンドウを最小化して」「検索のウィンドウを元に戻して」— ページを保ったまま最小化・復元
- 「ドキュメントのウィンドウに切り替えて」— タイトルやサイトで対象を選び、手前に表示

AIは最小化中も含む一覧を確認して対象を選びます。対象が曖昧な場合は、タイトルや位置などを確認します。ページのクリック・入力には従来の確認処理が適用されます。移動・サイズ変更・最小化はJARVIS内のブラウザが対象です。

### 外部アプリのウィンドウ操作とショートカット

macOS版では、起動中の外部アプリと個別ウィンドウを音声で操作できます。GPT Live・旧Realtimeの両方に対応します。

- 「Codexに切り替えて」— 起動中のCodexを前面に表示
- 「Chromeのドキュメントウィンドウを右半分に」— タイトルや位置から個別ウィンドウを選び、移動・サイズ変更
- 「Codexの設定ウィンドウを最小化して」「そのウィンドウを戻して」— 最小化・復元・前面表示
- 「CodexでCmd+1」／「Codexでコマンド1」— Codexを前面に表示してCmd+1を送信
- 「ChromeでCtrl+Tab」— ChromeへCtrl+Tabを送信

最初にJARVISの設定の「外部アプリとウィンドウ」からmacOSのアクセシビリティ設定を開き、JARVISを許可してください。許可状態は設定へ戻ったときに再確認します。反映されない場合はJARVISを再起動してください。

個別ウィンドウの操作では、直近の一覧にある対象だけを選び、タイトル、位置、フォーカス状態で区別します。対象が曖昧な場合は確認します。移動後のウィンドウは、複数ディスプレイを含めてメニューバーとDockを除いた表示領域内に収めます。

Cmd・Ctrl・Option・Shiftと、英数字、Tab、矢印などのキーを組み合わせて指定できます。英字や記号はmacOSのANSI仮想キー位置を使うため、入力配列によりアプリ側の解釈が変わる場合があります。1つのアプリ名と1つのショートカットが依頼から確認できる場合は、そのまま実行します。複数アプリや複数ショートカットを含む依頼、対象やキーを確認できない依頼では、対象とキーを表示して確認します。

Cmd+1がどのセッションやタブを選ぶかは、対象アプリの設定に従います。割り当てが不明な場合は推測せず確認します。送信完了はキーイベントを送ったことを意味し、外部アプリの表示内容や切り替え結果の確認は行いません。未起動アプリの起動、画面内容の読み取り、Cmd+TabなどmacOS全体のショートカットは対象外です。

対象は直近の一覧にあるアプリから選び、送信直前にもプロセスと前面状態を確認します。権限不足、対象の終了、前面表示の失敗、送信前の会話中断ではキーを送信しません。失敗時の自動再送は行いません。

実装資料：[Apple CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent)、[NSRunningApplicationのアクティベーション](https://developer.apple.com/documentation/appkit/nsrunningapplication/activate(options:))。

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

## Desktop self update

Tracking: [PLT-4258](https://linear.app/issue/PLT-4258).

Desktop distribution builds check for updates once at startup. Settings shows the current
version, release notes, download progress, and an explicit install button. The app never
installs automatically. Installation is blocked during a conversation; starting another
conversation is blocked while installing or waiting for restart. On macOS, choose
**再起動する** after installation, then sign in again. Closing Settings does not cancel or
lose update state. Network/signature/install errors can be retried through **更新を確認**.
Browser and mobile builds do not invoke the desktop updater.

Ordinary `npm run tauri build` and CI test bundles have no updater configuration and show
that in Settings. They do not contact a placeholder release server. The first updater-enabled
build must be installed manually; an older build without this feature cannot update itself.

### Build a signed macOS update

The release script requires Node 22+, macOS, the selected Rust target, and these environment
variables (do not commit signing keys):

- `JARVIS_UPDATE_BASE_URL`: stable HTTPS directory serving public update files, e.g.
  `https://updates.example.com/jarvis/`. No GitHub token or Tachyon login token is used.
- `JARVIS_UPDATER_PUBLIC_KEY`: contents of the `.pub` file generated by Tauri signer.
- `TAURI_SIGNING_PRIVATE_KEY`: protected signing key content or absolute file path.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: key password, when applicable.
- `JARVIS_APPLE_SIGNING_IDENTITY`: Developer ID Application identity configured by governance.
- `JARVIS_APPLE_TEAM_ID`: Apple Developer team ID used by the release identity.
- `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`: App Store Connect API key metadata and private-key file used by Tauri notarization.
- `JARVIS_RELEASE_NOTES`: optional plain text release notes.

Generate and securely back up a dedicated updater key using `npm run tauri signer generate -- -w <secure-path>`.
Keep this key stable across releases. Never commit it or put it in frontend environment variables.
Tauri's updater signature is separate from Apple Developer ID signing and notarization.
Both are mandatory for a published desktop release.

The release script explicitly uses 4 KiB macOS code-signature pages. macOS 26
Tahoe can reject larger native binaries signed with the default 16 KiB pages
even when userspace signature verification succeeds.

Increment the version consistently in `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json`, and refresh both lockfiles before building:

```sh
rustup target add aarch64-apple-darwin
npm run release:desktop -- aarch64-apple-darwin
# On an Intel macOS build runner:
rustup target add x86_64-apple-darwin
npm run release:desktop -- x86_64-apple-darwin
```

The script enables updater artifacts and embeds the public key and endpoint into that
build using a temporary Tauri config. Before copying any output, it expands the updater
archive and verifies its bundle identifier, strict deep code signature, Developer ID
authority and team, Gatekeeper notarization assessment, and stapled ticket. It fails on
missing keys, insecure URLs, mismatched versions, or any build/signing/notarization check.
Output layout:

```text
artifacts/updates/
  darwin-aarch64/
    latest.json
    0.2.0/JARVIS.app.tar.gz
    0.2.0/JARVIS.app.tar.gz.sig
  darwin-x86_64/
    latest.json
    0.2.0/JARVIS.app.tar.gz
    0.2.0/JARVIS.app.tar.gz.sig
```

`0.2.0` above is illustrative; the script uses the project version. Host the contents of
`artifacts/updates/` at `JARVIS_UPDATE_BASE_URL`, preserving directories. Upload immutable
versioned archives first and each architecture's `latest.json` last. Serve JSON with a short
cache lifetime. Both manifests use their archive's actual signature. Never overwrite archives
for an already published version. The app only accepts a newer version with a valid signature.

The **Publish signed desktop updates** workflow runs when a `package.json` version
change is merged into `main`, and can also be manually dispatched on `main`.
Merging application changes without increasing the version does not publish an update.
Dependency-only changes to `package.json` skip the release build.
It builds both macOS architectures, validates and combines their manifests, uploads a
complete draft release, and only then makes it public. Only the publish job has
`contents: write`; it uses the ephemeral `GITHUB_TOKEN`, never a persisted CLI token.
Published versions and tags pointing to a different commit are rejected. A draft for the
same commit can be retried without exposing a partial update.

For the GitHub Releases distribution, governance manages:

- `JARVIS_UPDATE_BASE_URL`: `https://github.com/quantum-box/jarvis/releases/`
- `JARVIS_UPDATER_PUBLIC_KEY`: the dedicated updater public key
- `JARVIS_APPLE_SIGNING_IDENTITY`: Developer ID Application identity
- `JARVIS_APPLE_TEAM_ID`: Apple Developer team ID
- Required secret names: `TAURI_SIGNING_PRIVATE_KEY`, `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and
  `APPLE_API_PRIVATE_KEY`. Their values are stored separately in 1Password and GitHub
  Actions Secrets, never in Terraform state. `APPLE_CERTIFICATE` is the base64-encoded
  PKCS#12 export; `APPLE_API_PRIVATE_KEY` is the PEM `.p8` content.

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional if the source key is password protected.
The updater checks `https://github.com/quantum-box/jarvis/releases/latest/download/latest.json`.
GitHub assets have flat names such as `JARVIS_0.1.1_darwin-aarch64.app.tar.gz`, while
archive URLs are pinned to `releases/download/v0.1.1/`. The generic HTTPS directory
layout above remains supported for non-GitHub hosting. Release notes are maintained in
`docs/desktop-release-notes.md`.

The workflow imports the PKCS#12 certificate into a temporary keychain and writes the
notarization key only under the runner temporary directory. It removes both after the
build. Only an archive that passes Developer ID, Gatekeeper, and staple validation reaches
the publish job. Tauri updater signatures independently verify update authenticity.

Before publishing, verify an installed older updater-enabled app against a higher signed
version, including download, install, restart, version change, and settings persistence.
Also check that an altered archive is rejected. Local controller tests exercise failure
handling but do not substitute for this real distribution test.

Reference: [Tauri updater documentation](https://v2.tauri.app/plugin/updater/).
