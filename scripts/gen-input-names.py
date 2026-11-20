#!/usr/bin/env python3
"""Regenerate server/src/godot/input-names.ts from a Godot binary's class reference.

Usage: python3 scripts/gen-input-names.py [path/to/godot]

Runs `godot --headless --doctool` into a temp dir and extracts the Key, MouseButton, JoyButton and
JoyAxis enums from @GlobalScope.xml, so the table always matches a real Godot build.
"""

import re
import subprocess
import sys
import tempfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "server" / "src" / "godot" / "input-names.ts"

TABLES = [
    ("KEY_NAMES", "KEY", "Key", {"NONE", "SPECIAL"}),
    ("MOUSE_BUTTON_NAMES", "MOUSE_BUTTON", "MouseButton", {"NONE"}),
    ("JOY_BUTTON_NAMES", "JOY_BUTTON", "JoyButton", {"INVALID", "SDL_MAX", "MAX"}),
    ("JOY_AXIS_NAMES", "JOY_AXIS", "JoyAxis", {"INVALID", "SDL_MAX", "MAX"}),
]


def dump_global_scope(godot: str) -> tuple[str, str]:
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([godot, "--headless", "--doctool", tmp], check=True, capture_output=True)
        version = subprocess.run(
            [godot, "--version"], check=True, capture_output=True, text=True
        ).stdout.strip()
        xml = (Path(tmp) / "doc" / "classes" / "@GlobalScope.xml").read_text()
        return xml, version


def rows(xml: str, prefix: str, enum: str, skip: set[str]) -> list[tuple[int, str]]:
    pattern = rf'<constant name="{prefix}_([A-Z0-9_]+)" value="(-?\d+)" enum="{enum}"'
    seen: set[int] = set()
    result: list[tuple[int, str]] = []
    for name, value in re.findall(pattern, xml):
        if name in skip or int(value) in seen:
            continue
        seen.add(int(value))
        result.append((int(value), name))
    return result


def main() -> None:
    godot = sys.argv[1] if len(sys.argv) > 1 else "godot"
    xml, version = dump_global_scope(godot)
    lines = [
        f"// GENERATED from Godot {version} `--doctool` (@GlobalScope enums). Do not edit by hand.",
        "// Regenerate with: python3 scripts/gen-input-names.py [godot]",
        "",
    ]
    for const, prefix, enum, skip in TABLES:
        lines.append(f"/** Godot `{enum}` enum values to names (without the {prefix}_ prefix). */")
        lines.append(f"export const {const}: ReadonlyMap<number, string> = new Map([")
        lines += [f"  [{value}, '{name}']," for value, name in rows(xml, prefix, enum, skip)]
        lines += ["]);", ""]
    OUT.write_text("\n".join(lines))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
