# OpenCode Location for Annotate

A small [Herdr](https://herdr.dev) plugin that opens the
[annotate](https://herdr.dev/plugins/) editor at the **current OpenCode session
directory**, instead of the pane's original working directory.

[日本語版 README はこちら](README.ja.md)

## Why

`annotate` opens its document picker at the working directory of the pane that
invoked it. That is usually correct, but an OpenCode session can move between
directories — for example after a Herdr worktree switch. The pane was created in
one directory, the session now lives in another, and `annotate` still shows the
stale one.

This plugin leaves Herdr, OpenCode, and `annotate` untouched. It only resolves
the pane's OpenCode session first, then delegates to the `annotate` plugin's own
`open` action with the correct directory.

## Requirements

- Herdr 0.9.5 or newer
- Node.js 18 or newer
- OpenCode V2 with the Herdr OpenCode integration enabled, so the pane reports
  an `agent_session` of kind `id`
- The `annotate` plugin installed and enabled, with an action named `open`
- The session directory must exist on the machine running the Herdr server. With
  `herdr --remote`, paths are resolved on the remote host, not on your local
  client.

Tested with Herdr 0.9.5, OpenCode V2, and the `annotate` plugin that provides the
`open` action.

## Install

Install from GitHub:

```sh
herdr plugin install simosako/herdr-annotate-opencode
herdr config check
herdr server reload-config
```

For development, link a checkout instead:

```sh
git clone https://github.com/simosako/herdr-annotate-opencode.git
herdr plugin link "$PWD/herdr-annotate-opencode"
```

Then bind a key to `annotate-opencode.open`. If a key is already bound to
`annotate.open`, change only its `command`:

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "annotate-opencode.open"
description = "review documents at the current OpenCode location"
```

Reload after editing the config:

```sh
herdr config check
herdr server reload-config
```

## How it works

1. Resolve the invoking pane from the Herdr context (`focused_pane_id`, or the
   `--pane` diagnostic argument).
2. Read the pane's latest state and require an exact OpenCode session ID.
3. Call `opencode api get /api/session/<id>` and read
   `data.location.directory`.
4. Verify that the session ID did not change and that the directory exists.
5. Find the enabled `annotate` plugin's `open` action, then launch it with the
   directory as an argument and `--deliver-to <pane>` so the overlay returns to
   the right pane.

On a pane whose agent is not OpenCode, the plugin reproduces the original
`annotate` behavior. On any OpenCode lookup failure it does **not** silently fall
back to the pane directory: it shows a Herdr notification and records the reason
in the plugin log.

Commands are executed with argv arrays, never through a shell, so paths with
spaces, quotes, or shell metacharacters are passed through unchanged. Error
notifications never include API responses, command arguments, or credentials.

Before opening, the plugin re-checks that the pane is still focused and still
runs the same OpenCode session. If anything moved in the meantime, it aborts and
asks you to run the action again rather than opening an overlay over the wrong
pane.

## Configuration

The plugin reads `settings.json` from its Herdr config directory. The file is
optional.

```sh
herdr plugin config-dir annotate-opencode
cp settings.example.json "$(herdr plugin config-dir annotate-opencode)/settings.json"
```

```json
{
  "opencodeApi": ["opencode", "api", "--server", "http://127.0.0.1:4096"]
}
```

`opencodeApi` is the argv prefix used to reach the OpenCode API. The default is
`["opencode", "api"]`. `opencodeApi` must be a non-empty array of strings; it is
not expanded by a shell.

Each command times out after 15 seconds. Do not store credentials in this file:
configure authentication in OpenCode itself. If the Herdr server cannot find
`opencode` on its `PATH`, use the absolute path of the executable as the first
element.

## Diagnostics

Run from inside a Herdr pane, from a checkout:

```sh
node open.mjs --dry-run
node open.mjs --dry-run --pane w1:p1
```

`--dry-run` prints what would be opened, without opening anything:

```json
{
  "paneID": "w1:p1",
  "sessionID": "ses_...",
  "directory": "/home/you/src/project-worktree",
  "mode": "opencode-session",
  "launcher": "/home/you/.local/share/herdr/plugins/.../bin/annotate"
}
```

`mode` is `opencode-session` when the directory was resolved from OpenCode, and
`original-annotate` when the pane is not OpenCode and the original `annotate`
behavior applies.

`--pane` is a diagnostic aid. Actually opening still requires that pane to be
active.

```sh
herdr plugin log list --plugin annotate-opencode
```

Exit codes: `0` success, `1` runtime failure, `2` invalid usage.

## Limitations

- The OpenCode session directory must exist on the Herdr server host. Directories
  that exist only on the OpenCode server cannot be opened.
- Herdr reports the session ID it knows about. If the integration reports a
  parent session while a child session is displayed, the parent's directory is
  opened.
- The plugin follows sessions that move (for example after a worktree switch); it
  does not create worktrees itself.
- The `annotate` lookup depends on `herdr plugin list --json` and on the shape of
  the `annotate` `open` action command. Changes in either can require a plugin
  update.
- The OpenCode V2 session API shape can change between releases; failures are
  reported instead of silently opening the wrong directory.

## Uninstall

```sh
herdr plugin uninstall simosako/herdr-annotate-opencode
```

Point your keybinding back to `annotate.open` if you changed it. Uninstalling
does not modify the `annotate` plugin, its configuration, or your OpenCode
session data.

## Development

```sh
npm test
```

This runs `node --test open.test.mjs`. The plugin has no runtime dependencies and
the tests do not require a running Herdr server. CI runs the suite on Linux and
macOS across several Node.js versions.

## License

MIT © Akira Shimosako
