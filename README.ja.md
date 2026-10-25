# OpenCode Location for Annotate

[English README](README.md)

Herdr のプラグインです。`annotate` のドキュメントピッカーを、ペインの元の作業
ディレクトリではなく、**OpenCode セッションの現在のディレクトリ**で開きます。

## なぜ必要か

`annotate` は、呼び出したペインの作業ディレクトリでピッカーを開きます。通常は
それで正しく動きますが、OpenCode のセッションはディレクトリを移動できます。
たとえば Herdr の worktree 切り替えの後では、ペインは元のディレクトリに作成され
たまま、セッションだけが新しい worktree に移っています。この状態で `annotate`
を開くと、古いディレクトリが表示されます。

このプラグインは Herdr・OpenCode・`annotate` のいずれも変更しません。先にペイン
の OpenCode セッションを解決し、正しいディレクトリを添えて `annotate` プラグイン
自身の `open` アクションに処理を渡します。

## 要件

- Herdr 0.9.5 以降
- Node.js 18 以降
- OpenCode V2 と、Herdr の OpenCode integration（ペインが kind `id` の
  `agent_session` を報告できること）
- `annotate` プラグインがインストール済み・有効で、`open` アクションを持つこと
- セッションディレクトリが、Herdr サーバーを実行しているマシン上に存在すること。
  `herdr --remote` を使う場合、パスはローカル端末ではなくリモート側で解決されます。

動作確認は Herdr 0.9.5、OpenCode V2、`open` アクションを持つ `annotate` プラグ
インの組み合わせで行っています。

## インストール

GitHub からインストールする場合:

```sh
herdr plugin install simosako/herdr-annotate-opencode
herdr config check
herdr server reload-config
```

開発時はチェックアウトをリンクします:

```sh
git clone https://github.com/simosako/herdr-annotate-opencode.git
herdr plugin link "$PWD/herdr-annotate-opencode"
```

次に、キーを `annotate-opencode.open` に割り当てます。すでに `annotate.open` に
キーを割り当てている場合は、その `command` だけを変更します。

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
5. 有効な `annotate` プラグインの `open` アクションを見つけ、ディレクトリと
   `--deliver-to <pane>` を添えて起動します。オーバーレイは正しいペインに戻ります。

OpenCode 以外のエージェントのペインでは、元の `annotate` の動作をそのまま再現
します。OpenCode の情報取得に失敗した場合は、ペインのディレクトリへ黙って
フォールバックせず、Herdr の通知とプラグインログに理由を出します。

コマンドはシェルを介さず argv 配列で実行するため、空白・引用符・シェルの
メタ文字を含むパスもそのまま1つの引数として渡されます。エラー通知に API
レスポンス、コマンド引数、認証情報を含めることはありません。

起動の直前に、ペインがまだフォーカスされていて同じ OpenCode セッションのままか
を再確認します。変化していた場合は、誤ったペインにオーバーレイを開かず中止し、
再実行を求めます。

## 設定

プラグインは Herdr の設定ディレクトリにある `settings.json` を読みます。この
ファイルは任意です。

```sh
herdr plugin config-dir annotate-opencode
cp settings.example.json "$(herdr plugin config-dir annotate-opencode)/settings.json"
```

```json
{
  "opencodeApi": ["opencode", "api", "--server", "http://127.0.0.1:4096"]
}
```

`opencodeApi` は OpenCode API に到達するための argv プレフィックスです。既定値は
`["opencode", "api"]` です。空でない文字列の配列で指定し、シェル展開は行われ
ません。

各コマンドは 15 秒でタイムアウトします。認証情報はこのファイルに書かず、
OpenCode 側で設定してください。Herdr サーバーから `opencode` が見つからない
場合は、先頭要素に実行ファイルの絶対パスを指定します。

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
  "launcher": "/home/you/.local/share/herdr/plugins/.../bin/annotate"
}
```

`mode` は、OpenCode からディレクトリを解決した場合は `opencode-session`、
OpenCode 以外のペインで元の `annotate` 動作になる場合は
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
- セッションの移動（worktree 切り替えなど）には追従しますが、worktree 自体の
  作成は行いません。
- `annotate` の解決は `herdr plugin list --json` の出力と、`annotate` の `open`
  アクションのコマンド形式に依存します。どちらかが変わった場合は更新が必要に
  なることがあります。
- OpenCode V2 のセッション API はリリース間で形が変わる可能性があります。失敗
  時は、誤ったディレクトリを黙って開くのではなくエラーとして報告します。

## アンインストール

```sh
herdr plugin uninstall simosako/herdr-annotate-opencode
```

キー割り当てを変更した場合は `annotate.open` に戻してください。アンインストール
しても `annotate` プラグイン、その設定、OpenCode のセッションデータは変更され
ません。

## 開発

```sh
npm test
```

`node --test open.test.mjs` を実行します。実行時の依存はなく、テストに Herdr
サーバーは不要です。CI では Linux と macOS の複数の Node.js バージョンでテスト
します。

## ライセンス

MIT © Akira Shimosako
