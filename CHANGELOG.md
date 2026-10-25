# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-25

### Added

- Initial public release as the Herdr plugin `annotate-opencode`.
- Open the `annotate` editor at the current OpenCode session directory instead of
  the invoking pane's working directory.
- Delegate to the installed `annotate` plugin's `open` action, preserving its
  placement and remote/mirror invocation context.
- Keep the original `annotate` behavior on panes whose agent is not OpenCode.
- Configurable OpenCode API command through `settings.json` (`opencodeApi`).
- Re-check the focused pane and OpenCode session immediately before opening.
- `--dry-run` and `--pane` diagnostics, and `--help`.
- Stable error codes with English messages; notifications omit API responses,
  command arguments, and credentials.
- Test suite with no runtime dependencies, and CI for Linux and macOS.

[0.1.0]: https://github.com/simosako/herdr-annotate-opencode/releases/tag/v0.1.0
