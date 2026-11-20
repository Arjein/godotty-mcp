# godot-mcp — agent guide

MCP server + Godot editor plugin + runtime helper that let AI agents edit, **run, see, play-test
and debug** Godot 4 projects. Full plan and milestones: `docs/PLAN.md`. Decisions: `DECISIONS.md`.
Known problems: `FLAGS.md`.

## Layout

- `server/` — the MCP server (TypeScript, Node 20+, ESM, stdio). npm workspace package.
  - `src/index.ts` stdio entry · `src/server.ts` builds the `McpServer` (transport-agnostic) ·
    `src/config.ts` CLI flags/env.
  - `src/tools/` one file per tool or tool group; each exports `defineTool(...)` objects, listed in
    `src/tools/index.ts`. `registry.ts` wraps handlers so errors become MCP `isError` results.
  - `src/godot/` process management, CLI wrapper, version detection, docs cache.
  - `src/bridge/` WebSocket server for the editor plugin and runtime helper; protocol types live in
    one file (`protocol.ts`), versioned.
  - `src/util/` `errors.ts` (ToolError + codes), `sandbox.ts` (path resolution), `paginate.ts`.
  - `test/` Vitest unit tests mirror `src/`; `test/integration/` runs real Godot (excluded from
    `npm test`).
- `addon/addons/godot_mcp/` — GDScript editor plugin + runtime helper. Statically typed.
- `examples/demo-project/` — small Godot 4 3D project (GL Compatibility renderer, so it renders under
  Mesa/xvfb on CI) for demos and integration tests.

## Commands (run from repo root)

- `npm run lint` — ESLint (strict type-checked) + Prettier check + gdlint + gdformat check.
  gdtoolkit is installed via `pipx install 'gdtoolkit==4.*'` (binaries in `~/.local/bin`).
- `npm run typecheck` · `npm test` · `npm run coverage` (thresholds in `server/vitest.config.ts`).
- `npm run format` — Prettier + gdformat write.
- Godot sanity check: `godot --headless --path examples/demo-project --quit-after 60`.

## Conventions

- TypeScript strict + `noUncheckedIndexedAccess`; no `any`; no magic numbers (named constants).
  TypeScript is pinned to 6.0.x because typescript-eslint does not support 7.x yet.
- Tool rules: precise description, zod input schema, compact structured output; lists paginate via
  `util/paginate.ts`; expected failures throw `ToolError(code, message, hint)` — the hint says what
  to do next. Never print to stdout outside the MCP transport (stdout is the protocol channel).
- Every user-supplied path goes through `ProjectSandbox.resolve` (accepts `res://`, relative,
  absolute; resolves symlinks; rejects anything outside the project root).
- Opt-in tools use `enabled: (config) => ...` and stay unregistered by default (`eval_gdscript`).
- GDScript: static types everywhere, `##` doc comments on public classes/methods, gdlint/gdformat
  clean. Indent with tabs.
- Verify Godot CLI flags/APIs against the installed version (`godot --help`, `--doctool`, a real
  run) before relying on them. Dev machine: Godot 4.7.2 at `/opt/homebrew/bin/godot`. Minimum
  supported: 4.5.
- Commit `*.uid` files Godot generates next to scripts; never commit `.godot/`.
- Every bug fix gets a regression test.
