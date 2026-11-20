import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of examples/demo-project. */
export const DEMO_PROJECT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../examples/demo-project',
);

export function readDemo(relative: string): string {
  return readFileSync(path.join(DEMO_PROJECT, relative), 'utf8');
}

/**
 * Copies the demo project to `dest` without its .godot cache or locally installed test addons
 * (gitignored), so tests see the same files on every machine and install what they need.
 */
export function copyDemoProject(dest: string): void {
  const excluded = ['.godot', path.join('addons', 'gut'), path.join('addons', 'gdUnit4')].map((p) =>
    path.join(DEMO_PROJECT, p),
  );
  cpSync(DEMO_PROJECT, dest, {
    recursive: true,
    // addons/godotty_mcp is a symlink to the repo's addon; copy its contents.
    dereference: true,
    filter: (src) => !excluded.some((e) => src === e || src.startsWith(`${e}${path.sep}`)),
  });
}
