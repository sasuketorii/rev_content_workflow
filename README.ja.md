# Rev Content Workflow

Rev Contentは、メディアURLを再開可能なNotebookLM文字起こしジョブへ変換します。
固定commitのRevMagicとcustom NotebookLM MCPをビルドし、Codex/Claude Codeへ
登録し、処理状態をuser-localのSQLiteへ保存します。

## 必要環境

- arm64/x86_64のmacOSまたはLinux
- Node.js 22.13以上、npm、Git
- Rust/Cargo 1.86.0以上
- FFmpeg、yt-dlp
- Codex CLIまたはClaude Code CLI

## 導入

```sh
./install.sh --dry-run
./install.sh
rev-content setup --client auto
rev-content auth
rev-content doctor --json
rev-content run 'https://example.com/media'
```

`auth`だけが対話操作を要求し、見えるブラウザで本人がGoogle認証します。
資格情報を設定ファイルやチャットへ入力しないでください。

`setup`のclientは`auto`、`codex`、`claude`、`both`です。公式CLIでMCPを
登録します。変更前に全clientの実command・args・envを比較し、不一致の同名登録は
競合として停止して上書きしません。

## 操作

```text
rev-content status [JOB]
rev-content resume JOB
rev-content upgrade --check                 # metadata表示のみ
rev-content uninstall [--purge --yes]
rev-content service install|remove|status   # Linuxのみ
```

既存engineのSQLite WAL、lease、effect journal、永続backoff、外部effect照合、
export receiptをそのまま再利用しています。停止してもジョブは失われません。
NotebookLMのsource readyは文字起こし完全性の証明ではありません。独立検証できない
exportは、完全と誤報告せずcaveat付きで終了します。
readiness pollingはbackoff、poll回数、開始時刻をDBへ保存し、
`readiness.maxAttempts`または`readiness.maxElapsedSeconds`で
`NEEDS_ATTENTION`へ停止します。無期限pollや遅延を理由にした再uploadはしません。
MCP通信にもprocess単位のhard deadlineとstderr上限があります。

## 保存場所と削除

設定・状態・依存build・音声・browser profile・transcriptはLinuxではXDG、
macOSではApplication Support配下のuser-local領域へ保存します。repoやreleaseへは
含めません。`uninstall`はreceipt所有のLinux timerを停止し、receiptと一致する
Codex/Claude MCP登録を削除してからlauncherとcurrent pointerを外して状態を
保全します。変更済み・所有不明の登録やunitはfail closedです。
`--purge --yes`だけがconfig、profile、DB、音声、transcript、install済みreleaseを
削除します。

`upgrade --check`はinstall済みreceiptと同梱upstream lockを表示するだけで、
remote照会も更新も実行せず、更新が利用可能とは主張しません。
更新は検証済みreleaseの`install.sh`を再実行し、verified stageからatomic replace
します。

macOSのlaunchdは導入・再開しません。Linuxのsystemd user templateは任意で、
自動enableしません。`service remove`はunit削除前にtimerをdisable/stopします。

## 検証と由来

`upstream.lock.json`にsource URL、full commit pin、lock SHA-256、適用対象だけの
patch contract、tool schema、licenseを記録しています。RevMagicは公開
`revmagic-runtime`のroot workspaceをpatchなしで検証・buildします。
`distribution-manifest.json`がrelease allowlistです。
releaseはsource manifest、CycloneDX SBOM、basenameだけを記録したchecksumを生成し、
archive展開後に全fileを再検査します。git `HEAD`が存在する場合はallowlistの全byteが
HEADと一致しなければ生成しません。

```sh
npm ci
npm run check
npm run release:verify
npm run sbom -- release/rev-content-workflow.cdx.json
npm run release:archive
```

workflow、NotebookLM変更、無変更の公開RevMagic runtimeはMITです。
`LICENSE`と`LICENSES/`を参照してください。

Ubuntu外部gateは`.github/workflows/linux-external-gate.yml`です。Linux release前に
clean fixture setup、restart永続性、systemd lifecycle contractを必須確認します。
このmacOS作業環境では実行していません。
