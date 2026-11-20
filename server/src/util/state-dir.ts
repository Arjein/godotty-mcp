import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ErrorCode, ToolError } from './errors.js';

/** Folder (inside the project's .godot) owned by godotty-mcp. */
export const STATE_DIR = path.join('.godot', 'godotty_mcp');
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Returns `<root>/.godot/godotty_mcp[/sub]`, creating it owner-only. Refuses symlinks on the way:
 * a project (e.g. an extracted archive) could otherwise plant `.godot/godotty_mcp -> ~/something`
 * and make the server write or delete files outside the project.
 */
export function ensureStateDir(projectRoot: string, ...sub: string[]): string {
  const root = realpathSync(projectRoot);
  let current = root;
  for (const part of [...STATE_DIR.split(path.sep), ...sub]) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw symlinkError(current);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      mkdirSync(current, { mode: PRIVATE_DIR_MODE });
    }
  }
  return current;
}

/**
 * Writes a private file by unlinking whatever is there (including a symlink, without following
 * it) and creating it exclusively, so the mode is always applied and nothing outside is touched.
 */
export function writePrivateFile(file: string, content: string): void {
  rmSync(file, { force: true });
  writeFileSync(file, content, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
}

function symlinkError(where: string): ToolError {
  return new ToolError(
    ErrorCode.PathOutsideProject,
    `${where} is a symlink; godotty-mcp refuses to write state through it.`,
    'Delete it (Godot recreates .godot/ on its own) and try again.',
  );
}
