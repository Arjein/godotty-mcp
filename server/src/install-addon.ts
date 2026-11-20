import { cpSync, existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { findAddonDir } from './godot/runtime-injection.js';
import { ErrorCode, ToolError } from './util/errors.js';

const ADDON_RELATIVE = path.join('addons', 'godotty_mcp');
const PLUGIN_CFG = 'res://addons/godotty_mcp/plugin.cfg';

export interface InstallResult {
  target: string;
  replaced: boolean;
  enabled: boolean;
}

/**
 * Copies the Godotty editor plugin into `<project>/addons/godotty_mcp`. Refuses to overwrite an
 * existing copy unless `force` (an older version would be replaced).
 */
export function installAddon(
  projectRoot: string,
  force: boolean,
  addonDir = findAddonDir(),
): InstallResult {
  if (!existsSync(path.join(projectRoot, 'project.godot'))) {
    throw new ToolError(
      ErrorCode.NotFound,
      `No project.godot in "${projectRoot}".`,
      'Run this inside your Godot project or pass --project <dir>.',
    );
  }
  const target = path.join(projectRoot, ADDON_RELATIVE);
  const exists = existsSync(target) || isSymlink(target);
  if (exists && !force) {
    throw new ToolError(
      ErrorCode.InvalidInput,
      `${target} already exists.`,
      'Pass --force (install_addon: force=true) to replace it with this version.',
    );
  }
  if (exists) rmSync(target, { recursive: true, force: true });
  cpSync(addonDir, target, { recursive: true });
  const enabled = readFileSync(path.join(projectRoot, 'project.godot'), 'utf8').includes(
    PLUGIN_CFG,
  );
  return { target, replaced: exists, enabled };
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

export function describeInstall(result: InstallResult): string {
  const lines = [
    `${result.replaced ? 'Replaced' : 'Installed'} the Godotty editor plugin in ${result.target}.`,
  ];
  if (!result.enabled) {
    lines.push('Enable it in Godot: Project → Project Settings → Plugins → Godotty → Enable.');
  }
  lines.push(
    'With the editor open and the MCP server running, the editor tools (open_scene, add_node, …) work.',
  );
  return lines.join('\n');
}

export const INSTALL_COMMAND = 'install-addon';
export const INSTALL_USAGE = `Usage: godotty-mcp install-addon [--project <dir>] [--force]

Copies the Godotty editor plugin into <project>/addons/godotty_mcp (default: current directory).`;

/** `godotty-mcp install-addon ...`: returns the text to print. */
export function runInstallCommand(argv: readonly string[], cwd: string): string {
  const { values } = parseArgs({
    args: [...argv],
    options: { project: { type: 'string' }, force: { type: 'boolean' }, help: { type: 'boolean' } },
    strict: true,
  });
  if (values.help === true) return INSTALL_USAGE;
  return describeInstall(
    installAddon(path.resolve(cwd, values.project ?? '.'), values.force === true),
  );
}
