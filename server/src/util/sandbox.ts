import { realpathSync } from 'node:fs';
import path from 'node:path';

import { ErrorCode, ToolError } from './errors.js';

const RES_PREFIX = 'res://';

/**
 * Resolves user-supplied paths against a Godot project root and refuses anything that escapes it.
 *
 * Accepts `res://` paths, project-relative paths and absolute paths. Symlinks are resolved for the
 * longest existing prefix of the path, so a link pointing outside the project is rejected even if
 * the final file does not exist yet.
 */
export class ProjectSandbox {
  /** Canonical (symlink-free) absolute project root. */
  public readonly root: string;

  public constructor(projectRoot: string) {
    this.root = realpathSync(path.resolve(projectRoot));
  }

  /** Returns the canonical absolute filesystem path for `input`, or throws PATH_OUTSIDE_PROJECT. */
  public resolve(input: string): string {
    if (input.includes('\0')) {
      throw new ToolError(ErrorCode.InvalidInput, 'Path contains a NUL byte.');
    }
    const relative = input.startsWith(RES_PREFIX) ? input.slice(RES_PREFIX.length) : input;
    const absolute = path.resolve(this.root, relative);
    const canonical = canonicalize(absolute);
    if (!isInside(this.root, canonical)) {
      throw new ToolError(
        ErrorCode.PathOutsideProject,
        `Path "${input}" resolves outside the project root.`,
        'Use a res:// path or a path relative to the project root.',
      );
    }
    return canonical;
  }

  /** Converts a path inside the project to its `res://` form (always forward slashes). */
  public toResPath(input: string): string {
    const relative = path.relative(this.root, this.resolve(input));
    return RES_PREFIX + relative.split(path.sep).join('/');
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** realpath of the longest existing ancestor, with the non-existent tail re-appended. */
function canonicalize(absolute: string): string {
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
