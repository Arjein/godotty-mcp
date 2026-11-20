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

## Test frameworks (GUT 9.7.1, gdUnit4 6.2.3)

- GUT ships one release per Godot minor (9.5.0 → 4.5, 9.6.1 → 4.6, 9.7.1 → 4.7); gdUnit4 6.2.x
  covers 4.5–4.7. Pinned with SHA-256 in `scripts/fetch-test-addons.sh`.
- Both need an imported project (global class cache). On an unimported project GUT prints
  "Some GUT class_names have not been imported" and **exits 0 without writing results** — always
  run `--headless --import` first and treat a missing results file as failure.
- GUT: `-s res://addons/gut/gut_cmdln.gd -gexit -gjunit_xml_file=<abs> -gdir=<dir>
-ginclude_subdirs | -gtest=<file> [-gunit_test_name=<substr>]`; reads `res://.gutconfig.json`
  when present. Exit 1 on failures. JUnit `classname` = script path without `res://`; failures say
  `at line N` (`-1` for unexpected engine errors, reported as failures "Unexpected Errors:");
  pending → `<skipped>`; the name filter omits non-matching tests from the XML.
- gdUnit4: `-s res://addons/gdUnit4/bin/GdUnitCmdTool.gd -a <dir|file> -c --ignoreHeadlessMode
-rd <dir>` → `<dir>/report_N/results.xml`. **Fail-fast by default: without `-c` it stops after
  the first failing test** and omits the rest (suite `tests` attribute still counts them). Exit
  100 on failures. Runtime errors → `<error type="ABORT">`; messages contain `res://file.gd:line`.
  No CLI filter by test name (only `-i` ignore lists).
- A test script with a parse error is silently skipped by both; the only trace is a
  `SCRIPT ERROR: Parse Error:` block in the run output.

## Rendering, input and frames (runtime helper)

- Screenshot = `get_viewport().get_texture().get_image()` after `await
RenderingServer.frame_post_draw`. **Headless never emits `frame_post_draw` — awaiting it hangs
  forever**; check `DisplayServer.get_name() == "headless"` first.
- `Input.parse_input_event()` events (InputEventAction, InputEventKey with physical_keycode) drive
  `is_action_pressed` and `_input` handlers, windowed or headless — but Input state updates **on
  the next frame**, not immediately. Keys trigger actions bound to them in the InputMap.
- The first `await get_tree().process_frame` can resume in the current frame; count frames with
  `Engine.get_process_frames()` instead of awaiting N times.
- Comparing values of different Variant types (e.g. `Vector3 != Vector2.ZERO`) is a runtime error
  in GDScript, not `false`; check types first.
- `JSON.parse_string()` logs an engine error on malformed input; `JSON.new().parse()` does not.
- `.tscn` writes `Transform3D(...)` basis values **row by row** (xx, xy, xz, yx, …), then origin.
