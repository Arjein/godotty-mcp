# Flags

- [2026-11-20] server/test/godot/docs/docs-store.test.ts: "explains when doctool produces nothing"
  asserts no `godotty-doctool-*/doc` exists in the shared system tmpdir, so a concurrent doctool
  run in another test file can fail it (seen once in `npm test`, passed on 3 reruns).
- [2026-11-20] server/test/integration/runtime.test.ts: "moves the player with input, observed via
  live properties" failed once (15.6 s) in a full integration run, then passed 3 times; timing- or
  window-focus-sensitive.
