# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Project named **Godotty** (npm package `godotty-mcp`, addon `addons/godotty_mcp`).
- Repository skeleton: MCP server package (TypeScript, stdio), editor addon stub, demo project, CI.
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
