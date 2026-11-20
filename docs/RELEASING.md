# Releasing

Releases are published by a maintainer by hand; nothing publishes automatically.

1. **Version.** Bump the same version in `server/package.json` and
   `addon/addons/godotty_mcp/plugin.cfg` (a unit test fails if they differ). Bump
   `PROTOCOL_VERSION` in `server/src/bridge/protocol.ts` and `godotty_bridge_client.gd` only for
   incompatible bridge changes.
2. **Changelog.** Move `Unreleased` entries in `CHANGELOG.md` under the new version and date.
3. **Verify.** `npm run lint && npm run typecheck && npm run coverage`, then
   `GODOT_PATH=… npm run test:integration`. Check that CI is green on `main`.
4. **Inspect the package.** `npm pack --dry-run -w server` — expect `dist/`, `addon/godotty_mcp/`,
   README, LICENSE, CHANGELOG and no source maps or tests. (`prepack` builds and copies the addon
   and docs into `server/`; those copies are gitignored.)
5. **Publish to npm.** `npm publish -w server` (add `--access public` the first time; consider
   `--provenance` from CI).
6. **Addon archive.** `scripts/package-addon.sh` → `release/godotty_mcp-<version>.zip`.
7. **Tag and GitHub release.** `git tag v<version> && git push origin v<version>`, then create a
   GitHub release from the tag with the changelog section and attach the addon zip.
8. **Asset Library (optional).** Submit the addon zip / repository to the Godot Asset Library.
