# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Project named **Godotty** (npm package `godotty-mcp`, addon `addons/godotty_mcp`).
- Repository skeleton: MCP server package (TypeScript, stdio), editor addon stub, demo project, CI.
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
