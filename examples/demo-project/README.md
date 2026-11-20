# godotty-mcp demo project

A small Godot 4 3D scene (floor, light, camera, and a `CharacterBody3D` player driven by the
`move_*` and `jump` input actions) used for demos and godotty-mcp's integration tests.

The GUT tests in `test/unit/` need GUT, which is not committed. Install the pinned version that
matches your Godot with:

```bash
scripts/fetch-test-addons.sh gut examples/demo-project
```

Until GUT is installed, `test/unit/test_player.gd` shows an "unknown class GutTest" error in the
editor; the game itself runs fine.
