# Verified Godot behavior

Facts checked against a real Godot 4.7.2 run (2026-11-20). Re-verify when bumping the pinned
version; the integration suite (`npm run test:integration`) exercises most of them.

## CLI

- `godot --version` prints e.g. `4.7.2.stable.official.ed1daf0bf` (patch omitted for `.0`
  releases: `4.5.stable...`).
- `--check-only --script res://x.gd` **exits 0 even when the script has errors**. Errors are on
  stderr as `SCRIPT ERROR: Parse Error: <msg>` + `at: GDScript::reload (res://x.gd:<line>)`. No
  columns, no warnings.
- A game run also exits 0 after script errors; judge runs by captured errors, never exit codes.
- `--doctool <dir>` (≈1 s, 1,076 classes) writes `doc/classes/*.xml`,
  `modules/*/doc_classes/*.xml` and `platform/*/doc_classes/*.xml` with exact signatures but
  **empty descriptions** — description text lives only in the engine source tree's XML.
- `godot --path <root> res://scene.tscn` runs that scene instead of the main scene.

## GDScript language server

- `godot --headless --editor --path <root> --lsp-port <port>` serves LSP in ≈2 s on an already
  imported project.
- Before answering `initialize`, Godot sends `gdscript_client/changeWorkspace {path}` with the
  project it has open — used to check the editor's LSP serves _this_ project.
- `textDocument/didOpen` triggers `publishDiagnostics` for that file: 0-based lines/columns,
  severity 1 = error, 2 = warning (e.g. `(UNUSED_VARIABLE): ...`).
- Also sends `gdscript/capabilities` (native class list) — ignore it.

## Runtime errors

- `Logger` (4.5+): `_log_error(function, file, line, code, rationale, editor_notify, error_type,
script_backtraces: Array[ScriptBacktrace])`, `_log_message(message, error)`;
  `ErrorType`: 0 error, 1 warning, 2 script, 3 shader. Register with `OS.add_logger`.
- For `push_error`/`push_warning`, `file`/`line` point at engine C++
  (`core/variant/variant_utility.cpp`); the script location is backtrace frame 0.
- Script runtime errors (e.g. null method call) report the script file/line directly, with
  `code` = the message.
- Every logged error is _also_ printed to stderr, so stderr and Logger records overlap.

## Autoload injection

- An `override.cfg` in the project root with `[autoload] Name="*res://path.gd"` adds an autoload
  at startup; the script may live under `res://.godot/`.
- ConfigFile merges repeated sections, so appending our `[autoload]` keeps a user's
  `override.cfg` settings.
- The editor also reads `override.cfg` at startup, so it must exist only while a launch starts.
