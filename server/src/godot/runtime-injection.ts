import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Makes the runtime helper an autoload for one launch, without touching project.godot:
 * copies the helper into `.godot/godotty_mcp/runtime/` and writes a temporary `override.cfg`
 * that registers it. A pre-existing `override.cfg` is backed up and its settings preserved.
 *
 * The override must only exist while a launch is starting (the editor reads it too), so callers
 * `restore()` as soon as the helper reports ready or the launch fails. A marker line lets the next
 * server start clean up after a crash.
 */

import { ensureStateDir, STATE_DIR } from '../util/state-dir.js';

export { STATE_DIR };
export const AUTOLOAD_NAME = 'GodottyRuntime';
export const RUNTIME_ENTRY = 'godotty_runtime.gd';
export const OVERRIDE_MARKER = '; godotty-mcp: temporary override, restored automatically';

const OVERRIDE_FILE = 'override.cfg';
const BACKUP_FILE = 'override.cfg.backup';

export class RuntimeInjection {
  private readonly stateDir: string;
  private readonly overridePath: string;
  private readonly backupPath: string;

  public constructor(
    private readonly projectRoot: string,
    private readonly runtimeSourceDir: string,
  ) {
    this.stateDir = path.join(projectRoot, STATE_DIR);
    this.overridePath = path.join(projectRoot, OVERRIDE_FILE);
    this.backupPath = path.join(this.stateDir, BACKUP_FILE);
  }

  /** Copies the helper and writes the temporary override. Call `restore()` afterwards. */
  public inject(): void {
    this.recover();
    const runtimeDir = ensureStateDir(this.projectRoot, 'runtime');
    for (const file of readdirSync(this.runtimeSourceDir)) {
      if (!file.endsWith('.gd')) continue;
      const target = path.join(runtimeDir, file);
      rmSync(target, { force: true });
      copyFileSync(path.join(this.runtimeSourceDir, file), target);
    }
    const original = existsSync(this.overridePath)
      ? readFileSync(this.overridePath, 'utf8')
      : undefined;
    if (original !== undefined) renameSync(this.overridePath, this.backupPath);
    const autoloadPath = `res://${STATE_DIR.split(path.sep).join('/')}/runtime/${RUNTIME_ENTRY}`;
    // ConfigFile merges repeated sections, so appending keeps the user's own overrides intact.
    const content = [
      OVERRIDE_MARKER,
      original ?? '',
      '',
      '[autoload]',
      '',
      `${AUTOLOAD_NAME}="*${autoloadPath}"`,
      '',
    ].join('\n');
    writeFileSync(this.overridePath, content);
  }

  /** Puts the user's override.cfg back (or removes ours). Safe to call repeatedly. */
  public restore(): void {
    if (this.isOurs()) rmSync(this.overridePath);
    if (existsSync(this.backupPath)) renameSync(this.backupPath, this.overridePath);
  }

  /** Undoes a previous injection left behind by a crash. */
  public recover(): void {
    if (this.isOurs() || existsSync(this.backupPath)) this.restore();
  }

  private isOurs(): boolean {
    return (
      existsSync(this.overridePath) &&
      readFileSync(this.overridePath, 'utf8').startsWith(OVERRIDE_MARKER)
    );
  }
}

/**
 * Finds the Godotty addon folder (addons/godotty_mcp): inside the published package
 * (`<pkg>/addon/godotty_mcp`) or, in a repository checkout, `addon/addons/godotty_mcp`.
 */
export function findAddonDir(moduleUrl: string = import.meta.url): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(here, '../../addon/godotty_mcp'),
    path.resolve(here, '../../../addon/addons/godotty_mcp'),
  ];
  const found = candidates.find((dir) => existsSync(path.join(dir, 'runtime', RUNTIME_ENTRY)));
  if (found === undefined) {
    throw new Error(
      `Godotty addon not found (looked in: ${candidates.join(', ')}). The installation is incomplete.`,
    );
  }
  return found;
}

/** The runtime helper sources inside the addon. */
export function findRuntimeSourceDir(moduleUrl: string = import.meta.url): string {
  return path.join(findAddonDir(moduleUrl), 'runtime');
}
