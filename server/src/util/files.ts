import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { ErrorCode, ToolError } from './errors.js';

/** File categories agents can filter by, mapped to extensions. */
export const FILE_TYPES = {
  scene: ['.tscn', '.scn'],
  script: ['.gd', '.cs'],
  resource: ['.tres', '.res'],
  shader: ['.gdshader', '.gdshaderinc'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.bmp', '.tga', '.exr', '.hdr', '.ktx'],
  audio: ['.wav', '.ogg', '.mp3'],
  model: ['.glb', '.gltf', '.fbx', '.obj', '.blend', '.dae'],
  font: ['.ttf', '.otf', '.woff', '.woff2', '.fnt'],
} as const;

export type FileType = keyof typeof FILE_TYPES;

/** Generated or editor-internal files that are never interesting to list. */
const IGNORED_SUFFIXES = ['.import', '.uid'];
const GDIGNORE = '.gdignore';
const ADDONS_DIR = 'addons';
/** Separate wildcard runs allowed in one glob (backtracking grows with each). */
const MAX_GLOB_WILDCARDS = 6;

export interface WalkOptions {
  includeAddons: boolean;
}

/**
 * Lists project files as root-relative POSIX paths, sorted. Skips hidden folders (including
 * .godot), folders Godot ignores (containing .gdignore), and `addons/` unless requested.
 */
export function walkProject(root: string, startDir: string, options: WalkOptions): string[] {
  const results: string[] = [];
  const visit = (dir: string): void => {
    if (existsSync(path.join(dir, GDIGNORE))) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!options.includeAddons && relative === ADDONS_DIR) continue;
        visit(full);
      } else if (entry.isFile() && !IGNORED_SUFFIXES.some((s) => entry.name.endsWith(s))) {
        results.push(relative);
      }
    }
  };
  visit(startDir);
  return results.sort();
}

export function matchesType(file: string, type: FileType | 'all'): boolean {
  if (type === 'all') return true;
  const ext = path.extname(file).toLowerCase();
  return (FILE_TYPES[type] as readonly string[]).includes(ext);
}

/**
 * Compiles a glob to a RegExp over root-relative POSIX paths. Supports `**`, `*`, `?` and `{a,b}`.
 * A pattern without `/` matches the file name in any folder (like .gitignore).
 */
export function globToRegExp(glob: string): RegExp {
  // Adjacent ** collapse to one; many wildcards make backtracking explode, so they are capped.
  const pattern = glob.replace(/^res:\/\//, '').replace(/(\*\*\/?){2,}/g, '**/');
  if ((pattern.match(/\*+/g) ?? []).length > MAX_GLOB_WILDCARDS) {
    throw new ToolError(
      ErrorCode.InvalidInput,
      `The glob has more than ${MAX_GLOB_WILDCARDS} wildcards.`,
      'Use a simpler pattern, e.g. "scenes/**/*.tscn".',
    );
  }
  const anyFolder = !pattern.includes('/');
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        source += '\\{';
        continue;
      }
      source += `(?:${pattern
        .slice(i + 1, end)
        .split(',')
        .map(escapeRegExp)
        .join('|')})`;
      i = end;
    } else {
      source += escapeRegExp(c);
    }
  }
  return new RegExp(`^${anyFolder ? '(?:.*/)?' : ''}${source}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
