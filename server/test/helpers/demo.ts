import { readFileSync } from 'node:fs';
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
