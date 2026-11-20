# Godotty safety model

Godotty gives an AI agent real control over a Godot project: it reads files, runs the game,
sends input, and edits scenes in the editor. This page explains what it protects against, how,
and where the limits are.

## Who can do what

| Actor                                        | Trusted?                         | What they can reach                                                     |
| -------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| You (the person running the MCP client)      | Yes                              | Everything; you choose the project and flags.                           |
| The AI agent calling tools                   | Partly                           | Only the tools; their inputs are validated and confined to the project. |
| Other processes or users on the same machine | No                               | Must not be able to drive Godot or read the session token.              |
| The project's own files and code             | As much as you trust the project | Running or testing a project runs its code (see limits).                |

## Protections

**File access stays in the project.** Every path a tool accepts (`res://…`, relative or absolute)
is resolved, symlinks included, and refused if it leaves the project root. Godotty's own state
lives in `.godot/godotty_mcp/`; it refuses to use that folder if it, or `.godot`, is a symlink, and
it re-creates its files instead of writing through existing ones.

**No code execution through tools unless you opt in.** Tool inputs never reach a script compiler.
Property values are Godot literals (`Vector3(0, 1, 0)`, `"text"`); literals that would load a
resource or build an object (`Resource("…")`, `Object(…)`) are rejected on both the server and the
Godot side, because loading a script resource can run its code. `eval_gdscript` exists only when
the server runs with `--allow-eval`, and Godot independently refuses eval unless the server
launched the game (or published the editor session) with eval allowed.

**The bridge is loopback-only and mutually authenticated.** The server listens on `127.0.0.1` on a
random port. The game and the editor each get their own random 256-bit token: the game through an
environment variable (not the command line, which other users can read), the editor through
`.godot/godotty_mcp/session.json`, created owner-only (0600). Godot sends the token plus a random
nonce; the server answers with HMAC-SHA256(token, nonce), and Godot ignores every request until
that proof checks out, so a process squatting on a stale port cannot drive it. Before
authentication a connection may send at most 16 KB and only a few may be pending at once.

**Editor edits are undoable.** Every editor tool call is one entry in Godot's undo history
("Godotty: …"); validation happens before anything changes, so failed calls change nothing. Edits
stay in the editor until `save_scene`.

**Editors started by Godotty never pose as your editor.** Every Godot process the server starts
(headless language server, imports, tests, games) carries `GODOTTY_NO_EDITOR_BRIDGE=1`; the plugin
stays offline there. `check_scripts` never starts a second editor while yours is connected.

**Hostile input does not hang the server.** Parsers have depth limits and linear-time line
handling; sub-resource inlining is bounded; output is filtered by substring (no agent-supplied
regular expressions); globs have a wildcard limit; process output and protocol messages have size
caps; tool inputs (screenshot counts, input steps, tree sizes, timeouts) are bounded.

**Network.** The only outbound connection is `godot_docs` fetching class-reference XML from
`raw.githubusercontent.com`; the URL contains only the Godot version and a class name.
`--offline` (or `GODOTTY_OFFLINE=1`) disables it.

## Limits — read these

- **Running a project runs its code.** `run_game` and `run_tests` execute the project's scripts.
  `check_scripts` and `run_tests` may start a headless editor or an import, which runs `@tool`
  scripts and editor plugins. Use Godotty only with projects you would open in the Godot editor
  yourself.
- **`eval_gdscript` is arbitrary code** with your user's permissions, in the game or the editor.
  Editor changes made through it are not undoable. Enable it only when you want that.
- **The editor's language server port (default 6005) is trusted.** `check_scripts` sends script
  text to whatever answers there after checking that it reports this project's path. On a shared
  machine another user could listen on that port; pass `--lsp-port` to a port you control or
  block it.
- **If the MCP server is killed hard** (SIGKILL), a small guard process between it and Godot
  notices and stops the game or headless editor it started (macOS, Linux). On Windows they may
  keep running until you close them.
- **Session files left by a crashed server** are harmless (the proof check above), but contain an
  expired token; Godotty replaces them on the next start.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue.
