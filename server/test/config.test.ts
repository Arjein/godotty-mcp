import { rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENV, hasProjectFile, HelpRequested, loadConfig } from '../src/config.js';
import { makeTempProject } from './helpers/tmp-project.js';

describe('loadConfig', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('defaults to cwd, "godot" on PATH and eval disabled', () => {
    expect(loadConfig([], {}, project.root)).toEqual({
      projectPath: project.root,
      godotPath: 'godot',
      allowEval: false,
    });
  });

  it('reads env vars', () => {
    const config = loadConfig(
      [],
      { [ENV.project]: project.root, [ENV.godot]: '/opt/godot', [ENV.allowEval]: 'TRUE' },
      '/',
    );
    expect(config).toEqual({ projectPath: project.root, godotPath: '/opt/godot', allowEval: true });
  });

  it('lets flags override env vars', () => {
    const config = loadConfig(
      ['--project', project.root, '--godot', '/flag/godot', '--allow-eval'],
      { [ENV.project]: '/nope', [ENV.godot]: '/env/godot', [ENV.allowEval]: '0' },
      '/',
    );
    expect(config).toEqual({
      projectPath: project.root,
      godotPath: '/flag/godot',
      allowEval: true,
    });
  });

  it('treats non-truthy eval values as disabled', () => {
    expect(loadConfig([], { [ENV.allowEval]: 'nope' }, project.root).allowEval).toBe(false);
  });

  it('accepts a folder without project.godot (it may be created later), but not a missing folder', () => {
    rmSync(path.join(project.root, 'project.godot'));
    expect(loadConfig(['--project', project.root], {}, '/').projectPath).toBe(project.root);
    expect(hasProjectFile(project.root)).toBe(false);
    expect(() => loadConfig(['--project', '/definitely/missing'], {}, '/')).toThrow(
      /does not exist/,
    );
  });

  it('rejects unknown flags', () => {
    expect(() => loadConfig(['--bogus'], {}, project.root)).toThrow();
  });

  it('signals --help', () => {
    expect(() => loadConfig(['--help'], {}, project.root)).toThrow(HelpRequested);
  });
});
