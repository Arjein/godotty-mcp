# Decisions

- [2026-11-20] Name: **Godotty**. npm package and CLI `godotty-mcp`; addon folder
  `addons/godotty_mcp` (plugin name "Godotty"); suggested GitHub repo `godotty-mcp`. The `-mcp`
  suffix everywhere avoids confusion with the unrelated `godotty` terminal-emulator addon
  (github.com/ingur/godotty). `godot-mcp` was taken on npm. `server/package.json` stays
  `"private": true` until release prep (M8).
- [2026-11-20] Minimum Godot version **4.5** (runtime errors come from the `Logger` API via
  `OS.add_logger`). CI tests the floor and 4.7.2.
- [2026-11-20] Bridge: the MCP server listens on `127.0.0.1:<random>`; editor plugin and runtime
  helper connect in. Transport is plain TCP with one JSON object per line (M5: both Godot's
  StreamPeerTCP and Node's `net` support it natively, no dependency; WebSocket bought nothing on
  loopback). The runtime's token travels in the `GODOTTY_BRIDGE_TOKEN` env var, not argv (visible
  to other local users via `ps`). Port + per-session token are written to
  `res://.godot/godotty_mcp/session.json` (editor) or passed as user args (game launched by
  `run_game`).
- [2026-11-20] Tool set is 21 tools + opt-in `eval_gdscript`: `capture_frames` folded into
  `screenshot` (count/interval), `attach_script` folded into `update_node`; live inspection tools
  take `target: game|editor`.
- [2026-11-20] Screenshots need a real renderer (`--headless` uses a dummy one): `run_game` is
  windowed by default; CI renders under xvfb with `opengl3`/llvmpipe.
- [2026-11-20] Docs (M3): `--doctool` gives version-exact signatures but no description text, so
  `godot_docs` takes signatures from the local binary and descriptions from the engine's
  `doc/classes` XML at the matching `X.Y.Z-stable` tag, fetched per class and cached; works
  offline with signatures only.
- [2026-11-20] Runtime errors: counts come from the runtime helper's Logger records; stderr adds
  only errors the helper never saw (before it loaded). Matching uses message + script location.
- [2026-11-20] `override.cfg` lives only from launch until the helper reports ready (or the launch
  fails), then the user's file is restored; a marker line lets the next server start recover
  after a crash.
- [2026-11-20] Editor tools (`open_scene`, `add_node`, `remove_node`, `update_node`,
  `save_scene`) are always listed and return EDITOR_NOT_CONNECTED with setup steps when the plugin
  isn't connected — tool-list change notifications aren't reliable across clients. Edits apply to
  the scene currently open in the editor; `undo`/`redo` exist on the bridge (used by tests) but are
  not exposed as tools yet.
- [2026-11-20] TypeScript pinned to 6.0.x (typescript-eslint 8.x supports `<6.1`).
