# ADR-0002: JARVIS管理のフローティングブラウザを提供する

## Status

Accepted (2026-09-11)

関連issue: [PLT-4566](https://linear.app/issue/PLT-4566)

## Context

JARVISの音声対話からWeb上の情報を探し、ページを読み、ユーザーの明示した入力や操作まで継続して行える作業空間が必要である。外部の既定ブラウザをmacOS Accessibilityだけで操作すると、DOM上の対象特定、操作結果の確認、JARVISとの表示上の一体感に限界がある。一方、任意のWebページをJARVIS本体と同じ権限で読み込むと、外部コンテンツからローカル機能へ到達する経路が生じる。

普段使うサイトでは再ログインの負担も大きい。Chromeのログイン状態を引き継ぎたいが、Cookieは認証情報であり、AIモデル、Tachyon、ログ、画面上のスナップショットへ値を公開してはならない。Chrome固有または端末に結び付いたセッションは、Cookieを移しても再認証が必要になる場合がある。

## Decision

- macOS版に、JARVISがライフサイクルを管理する単一のフローティングブラウザを追加する。Tauriの`WebviewWindow`で外部URLを表示し、JARVIS本体の近くに配置して最前面表示を選べるようにする。ブラウザを閉じてもWebデータはJARVIS専用の永続プロファイルに保持する。
- 外部ページを読み込むWebViewにはTauri IPCとローカルcapabilityを付与しない。ページからJARVISのコマンドを呼び出す経路は作らず、JARVIS本体からRustが保持するブラウザハンドルを操作する。
- ナビゲーションは`https`を既定とし、`file`、`data`、`javascript`、Tauriのカスタムschemeを拒否する。開発時の明示操作に限りlocalhostの`http`を許可する。新規ウィンドウ、ダウンロード、ファイル選択は個別のユーザー操作として扱う。
- 音声AIへ`browser_open`、`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_scroll`、`browser_back`、`browser_forward`、`browser_close`をローカルfunction toolsとして提供する。座標ではなく、`browser_snapshot`が返す短命な参照IDで要素を指定する。参照IDはページ遷移または次のsnapshotで失効する。
- snapshotは表示中の本文と操作可能な要素を件数・深さ・文字数で制限して返す。password入力値、Cookie、Web Storage、認証header、非表示要素、script内容は返さない。ページ内の文章とツール結果は参照データとして扱い、操作指示として扱わない。
- `browser_type`は入力だけを行い送信しない。送信、購入、削除、権限変更など結果を確定する操作は、ユーザーが現在の依頼で明示した場合だけ実行する。入力または確定操作の結果が不明な場合は自動再試行せず、同じページを再度snapshotして結果を確認する。
- ChromeからのCookieインポートは、ユーザーが設定画面から開始する一回限りのローカル操作とする。Chromeプロファイルと対象ドメインを選択し、ChromeのCookie DBを読み取り専用の一時コピーから解析する。必要な復号鍵はmacOS Keychainへ明示的にアクセスし、復号したCookieはJARVISのWebView cookie storeへ直接設定する。
- Cookieの値、復号鍵、Chrome DBのコピーを永続ログ、Frontend state、AIモデル、Tachyonへ送らない。UIにはプロファイル名、ドメイン、件数、有効期限、成功・再ログイン必要の結果だけを表示する。自動同期は行わず、再インポートもユーザーが開始する。
- Cookieの削除とサイト単位のWebデータ削除をJARVISの設定から実行できるようにする。パスワード、履歴、ブックマーク、拡張機能、決済情報はインポート対象外とする。
- 初期対象はmacOS 14以降、単一ブラウザウィンドウ、単一プロファイルとする。複数タブ、ダウンロード、ブラウザ拡張、他OSは別の判断とする。

## Consequences

### Positive

- 音声対話、ページ表示、AIによる操作結果をJARVIS内の一つの体験として扱える。
- DOM由来の参照IDを使うため、外部ブラウザを座標やAccessibilityだけで操作するより対象と結果を確認しやすい。
- Chromeの選択したログイン状態を移行でき、初回利用時の再ログインを減らせる。
- 認証情報と外部コンテンツをローカルtool境界の内側に保ち、AIへ渡す情報を限定できる。

### Negative

- Chrome Cookieの暗号化方式とDB schemaの変更を追従する保守が必要である。
- macOS Keychainへのアクセス時にユーザー確認が表示される。Chromeの実行中や権限状態によってはインポートできない場合がある。
- device-bound session、passkey、クライアント証明書、partitioned cookieなどは完全に移行できず、サイトによって再ログインが必要になる。
- WKWebViewとChromeで挙動が異なるサイトがあり、拡張機能、DRM、複雑なダウンロードは初期版で扱えない。

## Alternatives Considered

### SafariまたはChromeをAccessibilityで操作する

既存ブラウザのログイン状態をそのまま使えるが、DOM要素の安定した特定、外部ページとJARVIS toolの明確な分離、フローティング表示の一体化が難しいため採用しない。対応できないサイト向けのfallbackとしては残す。

### JARVIS本体へiframeでページを埋め込む

`frame-ancestors`や`X-Frame-Options`で表示できないサイトが多く、JARVIS本体と外部コンテンツの権限境界も複雑になるため採用しない。

### Chromiumをアプリへ同梱する

Chromeとの互換性は高いが、配布サイズ、更新、脆弱性対応、署名の負担が大きい。WKWebViewで対応できない対象が明確になった時点で再評価する。

### Chromeプロファイルを継続的に共有する

同時書き込みによる破損と認証情報の意図しない同期を避けるため採用しない。ユーザーが開始するサイト単位のコピーだけを行う。

## Follow-up

- フローティング`WebviewWindow`と手動操作UIを実装し、外部ページにTauri IPCがないことを確認する。
- 参照IDベースのbrowser toolsと操作結果確認を実装する。
- Chromeプロファイル・ドメイン選択、Keychain復号、WebView cookie storeへのインポートを実装する。
- ログイン済みサイト、Cookie削除、再起動後の保持、prompt injectionを含むmacOS実機検証を行う。

## References

- [Tauri WebviewWindowBuilder](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html)
- [Tauri Webview cookie APIs](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html)
- [Apple WKHTTPCookieStore](https://developer.apple.com/documentation/webkit/wkhttpcookiestore)
- [Chromium KeychainPassword for macOS](https://chromium.googlesource.com/chromium/src/+/HEAD/components/os_crypt/common/keychain_password_mac.mm)
