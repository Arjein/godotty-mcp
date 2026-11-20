# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/Arjein/godotty-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Arjein/godotty-mcp/releases/tag/v0.1.0
