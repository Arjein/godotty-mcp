# Godotty plan (approved 2026-11-20)

## Goal

An open-source MCP server for Godot 4 that lets AI agents edit a project **and run, see, play-test
and debug it**. Differentiators: seeing/playing the running game, accurate diagnostics from Godot's
own tooling, version-correct docs, structured test results, safety, and a small tool set (~22).

## Architecture

```
AI client ──stdio/MCP──► server (Node 20+, TypeScript)
                           ├─ godot/   spawns Godot: headless runs, --doctool, test runners, LSP editor
                           └─ bridge/  TCP (JSON lines) on 127.0.0.1:<random>, token-authenticated
                                 ▲                        ▲
                     editor plugin (connects in)   runtime helper autoload (game launched by run_game)
```

- **Bridge direction:** the server listens; the plugin and the game connect. The server writes
  `res://.godot/godotty_mcp/session.json` (port, 256-bit token, protocol version); the editor plugin
  polls for it. A game launched by `run_game` receives port + token as user args
  (`-- --mcp-port=… --mcp-token=…`). Loopback only; first message must carry the token.
- **Runtime helper injection:** `run_game` registers the helper as an autoload for that launch only
  (temporary `override.cfg`, removed on exit), so it works without the addon installed in the
  project. To verify on 4.7 in M2/M5; fallback: copy to `.godot/godotty_mcp/` and pass `--script`.
- **Diagnostics:** `check_scripts` uses GDScript LSP diagnostics: the editor's LSP if open,
  otherwise an on-demand headless editor (`--headless --editor --lsp-port`), kept warm while idle.
  Fallback: per-file `--check-only`. `get_errors` uses the runtime helper's `Logger`
  (`OS.add_logger`, 4.5+) for structured file/line/message/backtrace; stderr parsing only for errors
  before the autoload loads.
- **Docs:** `godot --headless --doctool <tmp>` dumps the exact installed version's class reference
  (including GDExtensions); parsed once into a compact JSON index cached at
  `~/.cache/godotty-mcp/docs/<version-hash>/`.
- **Screenshots** need a real renderer: `run_game` is windowed by default. CI uses `xvfb-run` with
  `--rendering-driver opengl3` on Mesa llvmpipe.
- **v2 debugger:** DAP client against the editor's debug adapter (port 6006); `bridge/` and
  `godot/` leave room for it.

## Bridge protocol

Single source: `server/src/bridge/protocol.ts`, mirrored by the GDScript bridge client (TCP, one JSON
object per line).

- Handshake: `hello {protocol, role: "editor"|"runtime", addonVersion, godotVersion, token}` →
  `welcome` or `error` (with a mismatch hint).
- Requests `{id, method, params}` → `{id, result}` or `{id, error: {code, message, hint}}`.
- Events (no id): `log`, `error`, `scene_changed`.
- Major protocol mismatch is refused with "update the addon to X"; minor mismatch logs a warning.

## Tools (21 + 1 opt-in)

| Group       | Tool                  | Purpose                                                                                       |
| ----------- | --------------------- | --------------------------------------------------------------------------------------------- |
| Project     | `project_info`        | Version, main scene, autoloads, input map, enabled addons, bridge status                      |
|             | `list_files`          | Paginated project files filtered by type (scene/script/resource/asset) and glob               |
|             | `read_scene`          | Compact `.tscn` tree: name, type, script, instanced scene, non-default props; depth-limited   |
| Docs        | `godot_docs`          | Lookup/fuzzy search of class/method/property/signal/constant in the installed version         |
| Diagnostics | `check_scripts`       | Parse/type errors for one or all scripts as `{file, line, col, severity, message}`            |
|             | `get_errors`          | Runtime errors/warnings + stack traces from current/last run, deduplicated with counts        |
| Run         | `run_game`            | Start main or given scene, args, windowed/headless; returns when the helper connects          |
|             | `stop_game`           | Stop; returns exit code and an error summary                                                  |
|             | `get_output`          | Paginated logs, filter by level/regex, cursor-based "since last call"                         |
| See & play  | `screenshot`          | MCP image, configurable max size; `count` + `interval` for frame sequences                    |
|             | `send_input`          | Step sequence: action/key/mouse press/release/tap/hold with durations, waits; optional shot   |
|             | `wait`                | N frames / seconds, or until a node exists / a property matches (with timeout)                |
|             | `inspect_scene_tree`  | Live depth-limited tree; `target: game \| editor`                                             |
|             | `get_node_properties` | Live property values (all or selected); `target: game \| editor`                              |
|             | `set_node_property`   | Set live properties in the running game (not undoable; lost on stop)                          |
| Editor      | `open_scene`          | Open, or create with a root type                                                              |
|             | `add_node`            | Add node or instance a scene under a parent, with properties (undoable)                       |
|             | `remove_node`         | Remove a node (undoable)                                                                      |
|             | `update_node`         | Properties, rename, reparent, attach/detach script (undoable)                                 |
|             | `save_scene`          | Save current or named open scene                                                              |
| Tests       | `run_tests`           | Detect GUT / gdUnit4, run headless with JUnit XML; totals, per-test status, failures, timings |
| Opt-in      | `eval_gdscript`       | Registered only with `--allow-eval`; runs in game or editor                                   |

Editor tools register only while the editor bridge is connected. Runtime tools are always listed
and return "start the game with run_game first" when no game runs (tool-list refresh is unreliable
across clients).

## Milestones

1. Repo skeleton, tooling, CI, demo project, CLAUDE.md/AGENTS.md, this plan.
2. Headless core: `project_info`, `list_files`, `read_scene`, `run_game`/`stop_game`/`get_output`,
   `check_scripts`, `get_errors`. Starts with a spike verifying 4.7 CLI behavior (`--check-only`,
   headless LSP, `--doctool`, `Logger`, `override.cfg` autoloads). Adds the integration CI job
   (Linux, pinned Godot, xvfb).
3. `godot_docs` (version-correct class reference, cached).
4. `run_tests` (GUT + gdUnit4).
5. Runtime helper: screenshot, input, wait, live inspection.
6. Editor plugin + bridge: undoable scene edits.
7. Safety hardening, opt-in eval, polish of descriptions/outputs.
8. Docs, examples, release prep (npm package name, addon packaging).

Each milestone ends with lint + all tests green, a commit, and try-it instructions.
