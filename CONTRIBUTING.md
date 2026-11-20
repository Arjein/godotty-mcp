# Contributing to Godotty

Thanks for helping! Bug reports, docs fixes and pull requests are all welcome.

## Setup

```bash
git clone https://github.com/Arjein/godotty-mcp.git
cd godotty-mcp
npm install
pipx install 'gdtoolkit==4.*'   # gdlint / gdformat for the GDScript addon
```

You also need Godot 4.5+ for integration tests (`GODOT_PATH=/path/to/Godot`).

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first; [AGENTS.md](AGENTS.md) lists the
conventions in compact form (it is also what AI coding agents read).

## Commands

| Command                                 | What it does                                                 |
| --------------------------------------- | ------------------------------------------------------------ |
| `npm run lint`                          | ESLint (strict, type-checked), Prettier, gdlint and gdformat |
| `npm run format`                        | Prettier + gdformat write                                    |
| `npm run typecheck`                     | TypeScript strict mode                                       |
| `npm test`                              | Unit tests (Vitest, fakes for Godot)                         |
| `npm run coverage`                      | Unit tests with coverage thresholds                          |
| `GODOT_PATH=… npm run test:integration` | Integration tests against real Godot (opens game windows)    |
| `npm run build`                         | Compile the server to `server/dist`                          |

To try your build in an MCP client, point it at
`node /path/to/godotty-mcp/server/dist/index.js --project examples/demo-project`.

## Pull requests

- Keep changes focused; one topic per PR.
- `npm run lint`, `npm run typecheck` and `npm test` must pass; run the integration tests when you
  touch Godot-facing code (CI runs them on Linux with Godot 4.5.2 and 4.7.2).
- Every bug fix comes with a regression test.
- New tools follow "Adding a tool" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): strict zod
  schemas with bounds, sandboxed paths, compact outputs, actionable errors.
- GDScript is statically typed, documented with `##` comments, and passes gdlint/gdformat.
- Verify Godot behavior against a real Godot run instead of assuming; record new findings in
  [docs/agents/godot-behavior.md](docs/agents/godot-behavior.md).
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Security

Please report vulnerabilities privately through a GitHub security advisory, not a public issue.
See [docs/SECURITY.md](docs/SECURITY.md) for the safety model.
