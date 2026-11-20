# Decisions

- [2026-11-20] Name: repo, addon (`addons/godot_mcp`) and docs use **godot-mcp**. The npm name
  `godot-mcp` is taken by another project; the publishable package name is **open** (decide before
  M8). `server/package.json` stays `"private": true` until then.
- [2026-11-20] Minimum Godot version **4.5** (runtime errors come from the `Logger` API via
  `OS.add_logger`). CI tests the floor and 4.7.2.
- [2026-11-20] Bridge: the MCP server listens on `127.0.0.1:<random>` (WebSocket); editor plugin
  and runtime helper connect in. Port + per-session token are written to
  `res://.godot/godot_mcp/session.json` (editor) or passed as user args (game launched by
  `run_game`).
- [2026-11-20] Tool set is 21 tools + opt-in `eval_gdscript`: `capture_frames` folded into
  `screenshot` (count/interval), `attach_script` folded into `update_node`; live inspection tools
  take `target: game|editor`.
- [2026-11-20] Screenshots need a real renderer (`--headless` uses a dummy one): `run_game` is
  windowed by default; CI renders under xvfb with `opengl3`/llvmpipe.
- [2026-11-20] TypeScript pinned to 6.0.x (typescript-eslint 8.x supports `<6.1`).
