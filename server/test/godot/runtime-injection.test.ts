import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findRuntimeSourceDir,
  OVERRIDE_MARKER,
  RUNTIME_ENTRY,
  RuntimeInjection,
  STATE_DIR,
} from '../../src/godot/runtime-injection.js';
import { makeTempProject } from '../helpers/tmp-project.js';

describe('RuntimeInjection', () => {
  let project: ReturnType<typeof makeTempProject>;
  let runtimeDir: string;
  let injection: RuntimeInjection;
  const override = (): string => path.join(project.root, 'override.cfg');

  beforeEach(() => {
    project = makeTempProject({
      'runtime-src/godotty_runtime.gd': 'extends Node\n',
      'runtime-src/notes.txt': 'x',
    });
    runtimeDir = path.join(project.root, 'runtime-src');
    injection = new RuntimeInjection(project.root, runtimeDir);
  });

  afterEach(() => {
    project.cleanup();
  });

  it('copies the helper and registers it as an autoload, then removes the override', () => {
    injection.inject();
    const copied = path.join(project.root, STATE_DIR, 'runtime', RUNTIME_ENTRY);
    expect(existsSync(copied)).toBe(true);
    expect(existsSync(path.join(project.root, STATE_DIR, 'runtime', 'notes.txt'))).toBe(false);
    const content = readFileSync(override(), 'utf8');
    expect(content.startsWith(OVERRIDE_MARKER)).toBe(true);
    expect(content).toContain(
      'GodottyRuntime="*res://.godot/godotty_mcp/runtime/godotty_runtime.gd"',
    );
    injection.restore();
    expect(existsSync(override())).toBe(false);
    injection.restore(); // idempotent
  });

  it('preserves and restores a user override.cfg', () => {
    writeFileSync(override(), '[display]\nwindow/size/viewport_width=640\n');
    injection.inject();
    const content = readFileSync(override(), 'utf8');
    expect(content).toContain('window/size/viewport_width=640');
    expect(content).toContain('[autoload]');
    injection.restore();
    expect(readFileSync(override(), 'utf8')).toBe('[display]\nwindow/size/viewport_width=640\n');
  });

  it('recovers from a crash that left our override and a backup behind', () => {
    writeFileSync(override(), 'user\n');
    injection.inject();
    // Simulate a crash: a new instance starts and recovers.
    new RuntimeInjection(project.root, runtimeDir).recover();
    expect(readFileSync(override(), 'utf8')).toBe('user\n');
  });

  it('never touches a user override.cfg when nothing was injected', () => {
    writeFileSync(override(), 'user\n');
    injection.recover();
    injection.restore();
    expect(readFileSync(override(), 'utf8')).toBe('user\n');
  });
});

describe('findRuntimeSourceDir', () => {
  it('finds the addon runtime folder from the source tree', () => {
    expect(existsSync(path.join(findRuntimeSourceDir(), RUNTIME_ENTRY))).toBe(true);
  });

  it('prefers a packaged runtime folder next to the package', () => {
    const project = makeTempProject({ 'pkg/runtime/godotty_runtime.gd': '' });
    try {
      mkdirSync(path.join(project.root, 'pkg/dist/godot'), { recursive: true });
      const moduleUrl = pathToFileURL(
        path.join(project.root, 'pkg/dist/godot/runtime-injection.js'),
      ).href;
      expect(findRuntimeSourceDir(moduleUrl)).toBe(path.join(project.root, 'pkg/runtime'));
    } finally {
      project.cleanup();
    }
  });

  it('explains a broken installation', () => {
    expect(() => findRuntimeSourceDir('file:///nowhere/dist/godot/x.js')).toThrow(
      /Runtime helper not found/,
    );
  });
});
