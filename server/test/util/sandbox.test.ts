import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../../src/util/errors.js';
import { ProjectSandbox } from '../../src/util/sandbox.js';
import { makeTempProject } from '../helpers/tmp-project.js';

describe('ProjectSandbox', () => {
  let project: ReturnType<typeof makeTempProject>;
  let outside: string;
  let sandbox: ProjectSandbox;

  beforeEach(() => {
    project = makeTempProject({ 'scenes/main.tscn': '' });
    outside = mkdtempSync(path.join(tmpdir(), 'godot-mcp-outside-'));
    sandbox = new ProjectSandbox(project.root);
  });

  afterEach(() => {
    project.cleanup();
    rmSync(outside, { recursive: true, force: true });
  });

  it.each([['res://scenes/main.tscn'], ['scenes/main.tscn'], ['./scenes/../scenes/main.tscn']])(
    'resolves %s inside the project',
    (input) => {
      expect(sandbox.resolve(input)).toBe(path.join(project.root, 'scenes', 'main.tscn'));
    },
  );

  it('accepts the root itself and absolute paths inside it', () => {
    expect(sandbox.resolve('res://')).toBe(project.root);
    expect(sandbox.resolve(path.join(project.root, 'scenes'))).toBe(
      path.join(project.root, 'scenes'),
    );
  });

  it('accepts not-yet-existing files inside the project', () => {
    expect(sandbox.resolve('res://new/dir/file.gd')).toBe(
      path.join(project.root, 'new', 'dir', 'file.gd'),
    );
  });

  it.each([['../escape.txt'], ['res://../../etc/passwd'], ['/etc/passwd']])(
    'rejects %s',
    (input) => {
      expect(() => sandbox.resolve(input)).toThrow(ToolError);
      expect(() => sandbox.resolve(input)).toThrow(/outside the project root/);
    },
  );

  it('rejects a sibling directory sharing the root as a name prefix', () => {
    const sibling = `${project.root}-evil`;
    mkdirSync(sibling);
    try {
      expect(() => sandbox.resolve(path.join(sibling, 'x'))).toThrow(/outside/);
    } finally {
      rmSync(sibling, { recursive: true });
    }
  });

  it('rejects symlinks that point outside, even for missing targets beneath them', () => {
    symlinkSync(outside, path.join(project.root, 'link'));
    expect(() => sandbox.resolve('res://link/secret.txt')).toThrow(/outside/);
  });

  it('rejects NUL bytes', () => {
    expect(() => sandbox.resolve('res://a\0b')).toThrow(/NUL/);
  });

  it('converts to res:// paths with forward slashes', () => {
    expect(sandbox.toResPath(path.join(project.root, 'scenes', 'main.tscn'))).toBe(
      'res://scenes/main.tscn',
    );
    expect(sandbox.toResPath('scenes/main.tscn')).toBe('res://scenes/main.tscn');
  });
});
