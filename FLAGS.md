# Flags

- [2026-11-20] server/src/godot/game.ts, script-checker.ts: Godot processes the server starts are not
  in their own process group, so a SIGKILLed server leaves games / the headless LSP editor running.
- [2026-11-20] server/src/godot/script-checker.ts: `didOpen` sends full script text to whatever
  listens on the editor LSP port (trusted, documented in docs/SECURITY.md); sending only the URI and
  letting Godot read the file would remove the disclosure.
