# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-20

### Added

- `pause_game` and `step_game`: freeze the running game between agent calls and advance exact
  physics frames. While paused, `send_input`, `wait` and `press_control` run the game for their
  own duration and pause it again. `run_game paused=true` starts frozen.
- `list_controls` and `press_control`: find visible UI controls and click, focus or accept one by
  its text or node path, with a warning when a button did not emit `pressed`.
- `send_input observe`: watch node properties during a batch and get every change with its time
  and step.
- Zero-argument getters (`is_open()`, `state_machine:current_name()`; `is_`/`has_`/`can_`/`get_`
  only) in `get_node_properties`, `wait` and `observe`.
- `install_addon` tool; `run_tests fixed_fps`; `check_scripts exclude_codes`, with repeated warning
  codes grouped per file.

### Changed

- Object values show what they are: nodes as `<Class /path script.gd>`, other objects as
  `<Class script.gd>`, instead of `<Node>` / `<RefCounted>`.
- `inspect_scene_tree` rounds positions to 3 decimals (`pos=(0, 0.001, 6.899)`).
- Screenshots default to `max_size` 640 (was 960).

### Fixed

- `send_input` holds no longer end early when the game window gains or loses focus (Godot releases
  all pressed input then; holds now press again).
- The server no longer exits when the project folder has no `project.godot` yet (clients only saw
  "Connection closed"). Project tools return `NOT_FOUND` until it exists and then work without a
  restart; `godot_docs` works throughout.
- `project_info` no longer claims the editor addon "arrives in a later version"; it says whether
  the plugin is connected, enabled, installed, or how to install it.

## [0.1.1] - 2026-11-20

### Added

- Godotty logo and banner (`docs/media/`) and a README header with badges.

## [0.1.0] - 2026-11-20

First public release.

### Fixed

- A game or headless editor no longer keeps running after the MCP server is killed hard (SIGKILL):
  a small guard process stops it (macOS, Linux). Run info now shows Godot's own pid.

### Added

- Project named **Godotty** (npm package `godotty-mcp`, addon `addons/godotty_mcp`).
- `godotty-mcp install-addon` copies the editor plugin into a project; the npm package ships the
  addon, and `scripts/package-addon.sh` builds the addon zip for releases.
- README (quick start for Claude Code, Claude Desktop, Cursor; tool reference; safety;
  troubleshooting), CONTRIBUTING, docs/ARCHITECTURE.md, docs/RELEASING.md, issue/PR templates.
- Repository skeleton: MCP server package (TypeScript, stdio), editor addon stub, demo project, CI.
- `eval_gdscript` (opt-in via `--allow-eval`): run GDScript in the game or editor, with parse and
  runtime errors reported by line. Godot refuses eval unless the server enabled it.
- Security hardening after an independent review; see docs/SECURITY.md (safety model and limits).
- Godot editor plugin (`addons/godotty_mcp`) and editor tools: `open_scene` (or create),
  `add_node` (class or scene instance), `remove_node`, `update_node` (properties, rename, reparent,
  script), `save_scene` — each one undoable step in the editor. `inspect_scene_tree` and
  `get_node_properties` take `target: editor` to see the edited scene, unsaved changes included.
- See and play the running game: `screenshot` (images, frame sequences), `send_input` (actions,
  keys, mouse, holds, waits; optional screenshot after), `wait` (frames, seconds, or a node/property
  condition), `inspect_scene_tree`, `get_node_properties`, `set_node_property` — over a
  token-authenticated loopback bridge to the runtime helper. Headless runs refuse screenshots
  instead of hanging.
- `run_tests`: GUT and gdUnit4 (auto-detected), headless with JUnit results — totals, failures with
  file:line, skipped tests, warnings for tests that never reported, and test scripts that failed
  to load (which both frameworks skip silently).
- `godot_docs`: class reference of the installed Godot version — exact signatures from the local
  binary, descriptions from the matching engine release (cached, `--offline` supported), class
  overviews, members via inheritance, enums, ranked search.
- Tools: `project_info`, `list_files`, `read_scene`, `check_scripts` (Godot language server,
  headless fallback), `run_game`, `stop_game`, `get_output`, `get_errors` (structured errors with
  backtraces via the runtime helper's Logger).
- Runtime helper autoload, injected per launch without modifying the project.
- Integration tests against real Godot; CI integration job for Godot 4.5.2 and 4.7.2.
- Server core: config (`--project`, `--godot`, `--allow-eval`), project-root path sandbox,
  pagination/truncation helpers, tool registry with actionable error results.

[Unreleased]: https://github.com/Arjein/godotty-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Arjein/godotty-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Arjein/godotty-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Arjein/godotty-mcp/releases/tag/v0.1.0
