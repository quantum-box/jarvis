# ADR-0003: macOS正式配布にDeveloper ID署名と公証を必須化する

## Status

Accepted (2026-09-11)

関連issue: [PLT-4574](https://linear.app/issue/PLT-4574)

## Context

JARVISのmacOS更新アーカイブにはTauri updater署名を付与していたが、Appleのコード署名と公証は行っていなかった。v0.1.4の公開アーカイブは、実行ファイルにlinker由来のad-hoc署名がある一方で`.app` bundle全体の署名が成立しておらず、`codesign --verify --deep --strict`に失敗した。この配布物をインストールした実機では、`navigator.mediaDevices.getUserMedia`を含むWebRTC接続開始処理が完了せず、画面が無期限に「接続しています」となった。

同じv0.1.4のコードと設定を変更せず、展開した`.app` bundle全体をad-hoc再署名した比較試験では、マイク取得、Tachyonの`POST /agent/live/session`、WebRTC接続が完了した。Tachyon APIの障害ではなく、macOS配布物の署名同一性と、クライアントに起動期限がないことが障害を長期化させた。

Tauri updater署名はダウンロードした更新アーカイブの完全性を確認するものであり、macOSのコード署名、Gatekeeper評価、公証を代替しない。社外配布するデスクトップアプリとして、これらを別々のリリースゲートにする必要がある。

## Decision

- GitHub Releasesで公開するmacOS版JARVISは、`Developer ID Application`証明書で`.app` bundle全体を署名し、Appleのnotarizationを完了してticketをstapleする。
- Tauri updater署名とAppleコード署名を独立した資格情報、処理、検証結果として扱う。名称とドキュメントでも両者を区別する。
- Apple署名証明書、証明書パスワード、notarization資格情報の値は、1Passwordを正本としてGitHub Actions Secretsへ登録する。Terraform state、Git、ログ、artifactへ秘密値を保存しない。
- GitHub Actions Secretsの必要な名前と用途は`quantum-box/governance`のpolicy inventoryに記録する。値の登録はTerraformの外で承認済み運用として行う。
- Release workflowは、公開予定の各architectureの更新アーカイブを展開し、少なくとも次を確認してからreleaseを公開する。
  - `codesign --verify --deep --strict`
  - `CFBundleIdentifier`と署名identity/teamの一致
  - `spctl --assess --type execute`
  - notarization ticketのstaple検証
  - `NSMicrophoneUsageDescription`の存在
  - Tauri updater署名とmanifest/archive対応の検証
- arm64とx86_64のどちらか一方でも署名・公証・artifact検証に失敗した場合、GitHub Releaseを公開しない。
- ad-hoc署名はローカル診断または明示した緊急用検証artifactに限定し、正式な`latest` releaseには使用しない。
- Realtime接続開始のマイク取得、SDP生成、Tachyon API、WebRTC、GPT Live session開始に個別の期限と安全な診断コードを設ける。token、SDP、音声、秘密情報は診断ログへ含めない。
- v0.1.4の修復版は新しいv0.1.5として公開する。公開済みv0.1.4 artifactを同じversionのまま差し替えない。

## Consequences

### Positive

- macOSが安定したアプリidentityでJARVISを評価でき、マイク権限、Keychain、WebViewの動作を正式配布物で検証できる。
- updater署名が成功していても壊れた`.app`を公開する経路をCIで遮断できる。
- 接続が停止した場合に、ユーザーと運用者がAPI障害、マイク許可、WebRTCのどこで失敗したかを区別できる。

### Negative

- Apple Developer Program、Developer ID証明書、notarization資格情報の発行と更新管理が必要になる。
- CIでKeychain import、notarization、staplingを行うため、release時間と外部サービス依存が増える。
- 証明書またはAPI keyの期限切れ・失効時はreleaseが停止する。

### Neutral

- Tachyon APIのLive session契約とOpenAI provider実装は変更しない。
- 開発用debug buildとブラウザUIテストは正式配布の証拠にしない。
- iOS、Android、Mac App Store配布はこの判断の対象外とする。

## Alternatives Considered

### ad-hoc署名だけで正式配布する

bundle全体をad-hoc署名すれば今回の実機停止は回避できるが、配布者identityとAppleの公証を証明できず、Gatekeeperでユーザー操作を要求する。恒久的な社外配布方式としては採用しない。

### Tauri updater署名だけを継続する

更新アーカイブの改ざん検出には有効だが、macOSが評価する`.app`の署名とは独立しており、今回の障害を防止できないため採用しない。

### 公開後に実機で問題を検出する

壊れたartifactを既存ユーザーへ配布してからしか検出できない。公開前に機械検査できる署名・公証条件はCIでfail closedにする。

## Follow-up

- governanceへApple署名・公証に必要なActions secret名と用途を追加する。
- JARVIS release workflowへ証明書import、Developer ID署名、notarization、stapling、公開artifact検証を追加する。
- Realtime接続へ段階別タイムアウトとテストを追加する。
- v0.1.5を公開し、v0.1.4からのself-update、設定・ログイン保持、マイク入力、GPT Live接続、音声出力、終了時のマイク解放を実機で確認する。

## References

- [Tauri macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri Updater](https://v2.tauri.app/plugin/updater/)
- [Apple Developer ID](https://developer.apple.com/developer-id/)
- [Apple Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- `scripts/desktop-release.mjs`
- `.github/workflows/desktop-release.yml`
- `src/lib/realtime.ts`
