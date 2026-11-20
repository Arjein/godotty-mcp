#!/usr/bin/env bash
# Builds the Godot addon archive for a GitHub release or the Asset Library:
#   <out-dir>/godotty_mcp-<version>.zip  containing  addons/godotty_mcp/** and LICENSE
# Usage: scripts/package-addon.sh [out-dir]   (default: ./release)
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-${repo}/release}"
version="$(sed -n 's/^version="\(.*\)"$/\1/p' "${repo}/addon/addons/godotty_mcp/plugin.cfg")"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

mkdir -p "${work}/addons" "${out}"
cp -R "${repo}/addon/addons/godotty_mcp" "${work}/addons/"
cp "${repo}/LICENSE" "${work}/addons/godotty_mcp/LICENSE"
archive="${out}/godotty_mcp-${version}.zip"
rm -f "${archive}"
(cd "${work}" && zip -qr -X "${archive}" addons)
echo "${archive}"
