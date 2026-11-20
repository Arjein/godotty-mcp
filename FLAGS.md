# Flags

- [2026-11-20] server/src/godot/script-checker.ts: if the Godot editor is open on the same project
  but its language server is unreachable (disabled, or a non-default port without `--lsp-port`),
  `check_scripts` starts a second, headless editor on that project; both may write `.godot/`
  caches at once. Detect a running editor (or prefer `--check-only`) before spawning.
