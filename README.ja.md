# OpenCode Location for Annotate

[English README](README.md)

[Herdr Annotate](https://github.com/plannotator/herdr-annotate) を補完する
Herdr プラグインです。Herdr Annotate のドキュメントレビューを、ペインの元の作業
ディレクトリではなく、**OpenCode セッションの現在のディレクトリ**で開きます。

## なぜ必要か

[Herdr Annotate](https://github.com/plannotator/herdr-annotate)（プラグイン ID
`annotate`）は、ターミナル上のテキストへのコメントや、ドキュメント・エージェント
応答のレビューを行う Herdr プラグインです。そのドキュメントレビューは
[plannotator-tui](https://github.com/plannotator/plannotator-tui) が担っており、
呼び出したペインの作業ディレクトリでピッカーを開きます。通常はそれで正しく動き
ますが、OpenCode のセッションはディレクトリを移動できます。たとえば OpenCode
の worktree 機能でセッションを新しい worktree へ移した後では、ペインは元の
ディレクトリに作成されたままなのに、Herdr Annotate は移動前のディレクトリを
表示します。

このプラグインは Herdr・OpenCode・Herdr Annotate のいずれも変更しません。先に
ペインの OpenCode セッションを解決し、正しいディレクトリを添えて、Herdr Annotate
が登録している `open` アクションに処理を渡します。

## Herdr Annotate との関係

本プラグインは補完用であり、フォークでも代替でもありません。レビュー UI を同梱
せず、Herdr Annotate も変更しません。インストール済みの `annotate` プラグインを
`herdr plugin list --json` で調べ、その `open` アクションを呼び出します。

- Herdr Annotate: https://github.com/plannotator/herdr-annotate
- レビュー UI: https://github.com/plannotator/plannotator-tui

先に Herdr Annotate を **Full** インストールで導入してください。Herdr Annotate の
Lite 版はターミナル注釈のみで `open` アクションを持たないため、本プラグインとは
組み合わせられません。

将来 Herdr Annotate 自身が OpenCode のセッションを解決するようになれば、本
プラグインは不要になります。

## 要件

- Herdr 0.9.5 以降
- Node.js 18 以降
- [Herdr Annotate](https://github.com/plannotator/herdr-annotate) が **Full**
  インストールで導入済み・有効で、`annotate` プラグインが `open` アクションを
  提供していること
- OpenCode V2 と、Herdr の OpenCode integration（ペインが kind `id` の
  `agent_session` を報告できること）
- セッションディレクトリが、Herdr サーバーを実行しているマシン上に存在すること。
  `herdr --remote` を使う場合、パスはローカル端末ではなくリモート側で解決されます。

ここで使う `open` アクションは、Herdr Annotate 0.9.x が提供するもの
（`plannotator-tui herdr open`）です。

## インストール

まだの場合は、先に [Herdr Annotate](https://github.com/plannotator/herdr-annotate)
をインストールします。

```sh
herdr plugin install plannotator/herdr-annotate
```

続いて本プラグインをインストールします。

```sh
herdr plugin install simosako/herdr-annotate-opencode
```

開発時はチェックアウトをリンクします:

```sh
git clone https://github.com/simosako/herdr-annotate-opencode.git
herdr plugin link "$PWD/herdr-annotate-opencode"
```

次に、キーを `annotate-opencode.open` に割り当てます。Herdr Annotate の Full
インストールは、ドキュメントレビューに `prefix+o` を `annotate.open` として割り
当てています。そのキーを維持する場合は、`command` だけを変更します。

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "annotate-opencode.open"
description = "review documents at the current OpenCode location"
```

設定を変更したら再読み込みします。

```sh
herdr config check
herdr server reload-config
```

## 動作

1. Herdr の呼び出しコンテキスト（`focused_pane_id`、または診断用の `--pane`
   引数）から対象ペインを特定します。
2. ペインの最新情報を読み、OpenCode の正確なセッション ID を要求します。
3. `opencode api get /api/session/<id>` を呼び、`data.location.directory` を
   読みます。
4. セッション ID が変わっていないことと、ディレクトリが存在することを確認します。
5. 有効な [Herdr Annotate](https://github.com/plannotator/herdr-annotate) の
   `open` アクションを見つけ、ディレクトリと `--deliver-to <pane>` を添えて
   起動します。オーバーレイは正しいペインに戻ります。

OpenCode 以外のエージェントのペインでは、Herdr Annotate 本来の動作をそのまま
再現します。OpenCode の情報取得に失敗した場合は、ペインのディレクトリへ黙って
フォールバックせず、Herdr の通知とプラグインログに理由を出します。

コマンドはシェルを介さず argv 配列で実行するため、空白・引用符・シェルの
メタ文字を含むパスもそのまま1つの引数として渡されます。エラー通知に API
レスポンス、コマンド引数、認証情報を含めることはありません。

起動の直前に、ペインがまだフォーカスされていて同じ OpenCode セッションのままか
を再確認します。変化していた場合は、誤ったペインにオーバーレイを開かず中止し、
再実行を求めます。

## 設定

多くの環境では設定は不要です。`settings.json` が無い場合、プラグインは
`opencode api` を実行し、ローカルで動いている OpenCode の background service に
接続します。

### `settings.json` が必要になるのはどんなときか

既定の方法で足りない場合だけ、このファイルを作成します。代表的なケースは次の
3つです。

- **Herdr サーバーから `opencode` が見つからない**: systemd や GUI から起動した
  サーバーでは、mise/asdf の shim や独自の `PATH` が引き継がれないことがあります。
  先頭要素に実行ファイルの絶対パスを指定します。
- **セッションが別の OpenCode サーバー上にある**: `--server` で共有サービスや
  別ホスト・別ポートの OpenCode に接続している場合は、同じサーバーを指定します。
  指定しないとローカルの background service を参照するため、セッションが
  見つかりません。
- **ラッパー経由で OpenCode に到達したい**: SSH トンネルを張るスクリプト、環境
  変数を設定するランチャー、コンテナのエントリポイントなどを先頭要素にできます。

`--standalone` は指定しないでください。プライベートサーバーを起動するため、
実行中のセッションが存在せず、取得は必ず失敗します。

### 設定方法

```sh
herdr plugin config-dir annotate-opencode
cp settings.example.json "$(herdr plugin config-dir annotate-opencode)/settings.json"
```

コピーしたファイルを編集します。既定値は次のとおりです。

```json
{
  "opencodeApi": ["opencode", "api"]
}
```

実行ファイルのパスを指定する例:

```json
{
  "opencodeApi": ["/home/you/.local/share/mise/shims/opencode", "api"]
}
```

別の OpenCode サーバーを指定する例:

```json
{
  "opencodeApi": ["opencode", "api", "--server", "http://127.0.0.1:4096"]
}
```

`opencodeApi` は OpenCode API に到達するための argv プレフィックスです。空でない
文字列の配列で指定し、シェル展開は行われません。

各コマンドは 15 秒でタイムアウトします。認証情報はこのファイルに書かず、
OpenCode 側で設定してください。`settings.json` を削除すると既定値に戻ります。

## 診断

Herdr のペイン内で、チェックアウトから実行します。

```sh
node open.mjs --dry-run
node open.mjs --dry-run --pane w1:p1
```

`--dry-run` は何も開かずに、開く予定の内容を表示します。

```json
{
  "paneID": "w1:p1",
  "sessionID": "ses_...",
  "directory": "/home/you/src/project-worktree",
  "mode": "opencode-session",
  "launcher": "/home/you/.local/share/herdr/plugins/.../bin/plannotator-tui.exe"
}
```

`mode` は、OpenCode からディレクトリを解決した場合は `opencode-session`、
OpenCode 以外のペインで Herdr Annotate 本来の動作になる場合は
`original-annotate` です。

`--pane` は診断用です。実際に開く場合は、そのペインがアクティブである必要が
あります。

```sh
herdr plugin log list --plugin annotate-opencode
```

終了コードは、成功が `0`、実行時エラーが `1`、使用方法の誤りが `2` です。

## 制約

- OpenCode のセッションディレクトリは、Herdr サーバーを実行しているマシン上に
  存在する必要があります。OpenCode 側のサーバーにしか存在しないディレクトリは
  開けません。
- Herdr が報告するセッション ID を使用します。子セッション表示中に integration
  が親セッションの ID を報告する場合は、親のディレクトリを開きます。
- セッションの移動（OpenCode がセッションを worktree へ移した場合など）には
  追従しますが、worktree 自体の作成は行いません。
- [Herdr Annotate](https://github.com/plannotator/herdr-annotate) の解決は
  `herdr plugin list --json` の出力と、その `open` アクションのコマンド形式に
  依存します。どちらかが変わった場合は更新が必要になることがあります。
- OpenCode V2 のセッション API はリリース間で形が変わる可能性があります。失敗
  時は、誤ったディレクトリを黙って開くのではなくエラーとして報告します。

## アンインストール

```sh
herdr plugin uninstall simosako/herdr-annotate-opencode
```

キー割り当てを変更した場合は `annotate.open` に戻してください。アンインストール
しても Herdr Annotate、その設定、OpenCode のセッションデータは変更されません。

## 開発

```sh
npm test
```

`node --test open.test.mjs` を実行します。実行時の依存はなく、テストに Herdr
サーバーは不要です。CI では Linux と macOS の複数の Node.js バージョンでテスト
します。

## ライセンス

MIT © Akira Shimosako
