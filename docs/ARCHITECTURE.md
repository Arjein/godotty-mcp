# Architecture

Godotty has three parts in one repository:

```
 MCP client (Claude Code, …)
        │ stdio (MCP)
        ▼
 ┌──────────────────────────── server/ (Node, TypeScript) ────────────────────────────┐
 │ tools/        one file per tool group; zod schemas; compact text output              │
 │ godot/        Godot executable, parsers (.tscn, project.godot), game runs, LSP,      │
 │               docs, test runner                                                      │
 │ bridge/       loopback TCP server, protocol, peer clients                            │
 │ util/         errors, path sandbox, pagination, state dir, literal guard             │
 └───────┬─────────────────────────────┬───────────────────────────────┬──────────────┘
         │ spawns                      │ TCP 127.0.0.1 (JSON lines)    │ spawns
         ▼                             ▼                               ▼
  headless tools               ┌──────────────┐  ┌─────────────────┐   game process
  (--doctool, --import,        │ editor plugin │  │ runtime helper  │◄─ (autoload injected
   LSP editor, GUT/gdUnit4)    │ (your editor) │  │ (in the game)   │    for this run only)
                               └──────────────┘  └─────────────────┘
                                 addon/addons/godotty_mcp/
```

- **Server** (`server/src`): an MCP server over stdio built on the official SDK. `services.ts`
  wires long-lived services (Godot executable, game manager, script checker, docs store, test
  runner, bridge clients); `tools/` turns them into MCP tools.
- **Editor plugin** (`addon/addons/godotty_mcp/plugin.gd` + `editor/`): runs in the user's Godot
  editor, finds the server through `res://.godot/godotty_mcp/session.json` and performs undoable
  edits.
- **Runtime helper** (`addon/addons/godotty_mcp/runtime/`): injected into games started by
  `run_game` through a temporary `override.cfg` autoload (the user's project is not modified). It
  captures errors through Godot's Logger API and serves screenshots, input, waits and live
  inspection.

Facts about Godot that this design depends on (exit codes, the LSP handshake, Logger, rendering
in headless mode, …) are collected in [agents/godot-behavior.md](agents/godot-behavior.md).

## Key flows

**Headless work without the editor.** `project_info`, `read_scene` and `list_files` parse files
directly (`godot/variant.ts`, `section-file.ts`, `scene-file.ts`). `check_scripts` talks to
Godot's GDScript language server: the open editor's if it has this project, otherwise a headless
editor it starts and keeps warm, otherwise per-file `--check-only`. `godot_docs` takes signatures
from `godot --doctool` (cached per Godot build) and descriptions from the engine source at the
matching tag. `run_tests` imports the project and runs GUT/gdUnit4 with JUnit output.

**Running and playing.** `run_game` copies the runtime helper into `.godot/godotty_mcp/runtime/`,
writes a temporary `override.cfg` that adds it as an autoload, launches Godot with the bridge port
(argument) and the runtime token (environment variable), waits for the helper's "ready" record,
then restores `override.cfg`. Errors arrive as JSON lines in an events file; screenshots, input
and inspection go over the bridge.

**Editing.** The plugin connects as the "editor" peer. Each edit command validates everything,
then records one `EditorUndoRedoManager` action.

## Bridge protocol

Defined in `server/src/bridge/protocol.ts` (the single source; the GDScript client mirrors it).
TCP on `127.0.0.1`, one JSON object per line.

1. Godot sends `{"type":"hello","role":"runtime"|"editor","protocol":1,"token":…,"nonce":…}`.
2. The server checks the role's token and the protocol version, then answers
   `{"type":"welcome","protocol":1,"proof":HMAC-SHA256(token, nonce)}` or `{"type":"rejected"}`.
   Godot ignores all requests until the proof matches.
3. The server sends `{"id":N,"method":…,"params":{…}}`; Godot answers `{"id":N,"result":…}` or
   `{"id":N,"error":{"code":…,"message":…}}`. Answers may arrive out of order.

Runtime methods: `screenshot`, `input`, `wait`, `tree`, `get_props`, `set_props`, `eval`. Editor
methods: `open_scene`, `add_node`, `remove_node`, `update_node`, `save_scene`, `tree`,
`get_props`, `undo`, `redo`, `eval`. Bump `PROTOCOL_VERSION` (both sides) on any incompatible
change; mismatches are rejected with an explanation.

## Adding a tool

1. **Decide where it lives.** Pure file/headless work belongs in `server/src/godot/`; something
   that needs the running game or the editor needs a bridge method.
2. **Bridge method (if needed).** Add params/result types to `protocol.ts` (`RuntimeMethods` or
   `EditorMethods`), then implement `_cmd_<method>` in `godotty_commands.gd` (game) or
   `godotty_editor_commands.gd` (editor; add it to `EDITOR_METHODS`). Return `_ok(...)` or
   `_error(CODE, message)`; map new error codes to hints in `bridge/peer-client.ts`.
3. **The tool.** In `server/src/tools/<group>.ts`, export `defineTool({...})` with:
   - a precise description (what, when to use it, what it returns),
   - a strict zod input schema with bounds (`max`, `min`) on every field,
   - paths resolved through `ctx.sandbox`, value literals checked with `assertSafeLiterals`,
   - a compact text result; paginate lists (`util/paginate.ts`), truncate long text,
   - expected failures thrown as `ToolError(code, message, hint)`.
     Register it in `server/src/tools/index.ts`.
4. **Tests.** Unit-test the logic and the tool through `test/helpers/tool-client.ts` (fake Godot
   via `fake-godot.ts`, fake Godot peers via `fake-runtime.ts`); add GUT tests for new GDScript in
   `addon/tests/`; add an integration test against real Godot in `server/test/integration/`.
5. **Docs.** Add the tool to the README table and the CHANGELOG.

Keep the tool count small: prefer extending an existing tool with a parameter over a new tool,
and measure the cost of the tool list (`tools/list` size) when adding schemas.
