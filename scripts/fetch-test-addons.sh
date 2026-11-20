#!/usr/bin/env bash
# Installs a pinned, checksum-verified test framework into a Godot project's addons/ folder.
#
# Usage: scripts/fetch-test-addons.sh <gut|gdunit4> <project-dir> [godot-minor, e.g. 4.7]
#
# The Godot minor version picks the matching GUT release (GUT is built per Godot version); it
# defaults to the version reported by "${GODOT_PATH:-godot} --version". Archives are cached in
# ${XDG_CACHE_HOME:-~/.cache}/godotty-mcp/test-addons.
set -euo pipefail

framework="${1:?usage: fetch-test-addons.sh <gut|gdunit4> <project-dir> [godot-minor]}"
project="${2:?usage: fetch-test-addons.sh <gut|gdunit4> <project-dir> [godot-minor]}"
minor="${3:-$("${GODOT_PATH:-godot}" --version | grep -oE '^[0-9]+\.[0-9]+')}"

case "${framework}:${minor}" in
  gut:4.5) repo=bitwes/Gut tag=v9.5.0 sha=b4513c1886bd77460a683ad3dbbb2756a8f80fa8bc1d8a6223be81afc3d8e273 addon=gut ;;
  gut:4.6) repo=bitwes/Gut tag=v9.6.1 sha=3eddacf23d69109e0bef4efa6c9194b1c9e5f812b5124eca438850c9142a2372 addon=gut ;;
  gut:4.7) repo=bitwes/Gut tag=v9.7.1 sha=6da99c4e9228d9bec3fb4bd1730a487770a989f0f511dac82a2897a964613385 addon=gut ;;
  gdunit4:4.5 | gdunit4:4.6 | gdunit4:4.7)
    repo=MikeSchulze/gdUnit4 tag=v6.2.3 sha=42dc61721b1b6bc40dac0ff34a71d2b0811ca92109add0b923ad01f96f04abf8 addon=gdUnit4 ;;
  *) echo "No pinned ${framework} release for Godot ${minor}." >&2; exit 2 ;;
esac

cache="${XDG_CACHE_HOME:-$HOME/.cache}/godotty-mcp/test-addons"
archive="${cache}/${repo//\//_}-${tag}.tar.gz"
mkdir -p "${cache}"
if [[ ! -f "${archive}" ]]; then
  curl -fsSL -o "${archive}.part" "https://codeload.github.com/${repo}/tar.gz/refs/tags/${tag}"
  mv "${archive}.part" "${archive}"
fi

actual="$( (sha256sum "${archive}" 2>/dev/null || shasum -a 256 "${archive}") | cut -d' ' -f1)"
if [[ "${actual}" != "${sha}" ]]; then
  rm -f "${archive}"
  echo "Checksum mismatch for ${repo} ${tag}: expected ${sha}, got ${actual}." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
tar -xzf "${archive}" -C "${work}"
mkdir -p "${project}/addons"
rm -rf "${project}/addons/${addon}"
cp -R "${work}"/*/addons/"${addon}" "${project}/addons/${addon}"
echo "Installed ${addon} ${tag} into ${project}/addons/${addon}"
