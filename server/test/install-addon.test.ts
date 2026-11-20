import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeInstall, installAddon, runInstallCommand } from '../src/install-addon.js';
import { makeTempProject } from './helpers/tmp-project.js';

describe('install-addon', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('copies the plugin and explains how to enable it', () => {
    const text = runInstallCommand(['--project', project.root], '/');
    expect(existsSync(path.join(project.root, 'addons/godotty_mcp/plugin.cfg'))).toBe(true);
    expect(
      existsSync(path.join(project.root, 'addons/godotty_mcp/runtime/godotty_runtime.gd')),
    ).toBe(true);
    expect(
      existsSync(path.join(project.root, 'addons/godotty_mcp/editor/godotty_editor_commands.gd')),
    ).toBe(true);
    expect(text).toContain('Installed the Godotty editor plugin');
    expect(text).toContain('Project → Project Settings → Plugins');
  });

  it('refuses to overwrite unless forced, and notices an enabled plugin', () => {
    runInstallCommand([], project.root);
    expect(() => runInstallCommand([], project.root)).toThrow(/already exists/);
    writeFileSync(
      path.join(project.root, 'project.godot'),
      '[editor_plugins]\nenabled=PackedStringArray("res://addons/godotty_mcp/plugin.cfg")\n',
    );
    const result = installAddon(project.root, true);
    expect(result).toMatchObject({ replaced: true, enabled: true });
    expect(describeInstall(result)).not.toContain('Enable it in Godot');
  });

  it('replaces a symlinked copy (like the demo project) when forced', () => {
    const elsewhere = path.join(project.root, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(path.join(project.root, 'addons'));
    symlinkSync(elsewhere, path.join(project.root, 'addons/godotty_mcp'));
    expect(installAddon(project.root, true).replaced).toBe(true);
    expect(
      readFileSync(path.join(project.root, 'addons/godotty_mcp/plugin.cfg'), 'utf8'),
    ).toContain('name="Godotty"');
    expect(existsSync(path.join(elsewhere, 'plugin.cfg'))).toBe(false);
  });

  it('requires a Godot project and supports --help', () => {
    expect(() => runInstallCommand(['--project', path.join(project.root, 'nope')], '/')).toThrow(
      /No project.godot/,
    );
    expect(runInstallCommand(['--help'], '/')).toContain('Usage: godotty-mcp install-addon');
    expect(() => runInstallCommand(['--bogus'], '/')).toThrow();
  });
});
