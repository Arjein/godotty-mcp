/**
 * Regression tests for the M7 security review. Each guards a concrete failure: a hang (ReDoS,
 * quadratic/exponential parsing), memory exhaustion, or a write outside the project.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionFilePath, writeSessionFile } from '../src/bridge/session-file.js';
import { GodotExecutable, MAX_EXEC_OUTPUT_CHARS } from '../src/godot/executable.js';
import { parseErrorBlocks } from '../src/godot/godot-log.js';
import { LspDecoder } from '../src/godot/lsp-client.js';
import { parseSceneFile, renderScene } from '../src/godot/scene-file.js';
import { parseSectionFile } from '../src/godot/section-file.js';
import { parseVariant, VariantParseError } from '../src/godot/variant.js';
import { globToRegExp } from '../src/util/files.js';
import { ensureStateDir } from '../src/util/state-dir.js';
import { fakeSpawner } from './helpers/fake-process.js';
import { makeTempProject } from './helpers/tmp-project.js';

/** Fails if `fn` takes longer than `ms` (instead of hanging the suite for minutes). */
function fast<T>(fn: () => T, ms = 1000): T {
  const start = Date.now();
  const result = fn();
  expect(Date.now() - start).toBeLessThan(ms);
  return result;
}

describe('denial of service', () => {
  it('rejects globs with many wildcards and collapses repeated **', () => {
    expect(() => globToRegExp('**a'.repeat(8) + '**b')).toThrow(/more than 6 wildcards/);
    const collapsed = fast(() => globToRegExp('**/**/**/x.gd'));
    expect(collapsed.test('a/b/c/x.gd')).toBe(true);
    expect(fast(() => globToRegExp('**/a*/**/b*/**/c*.gd').test(`${'a/'.repeat(30)}zz`))).toBe(
      false,
    );
  });

  it('parses huge log lines in linear time', () => {
    const line = `   at: ${'('.repeat(1_000_000)}`;
    expect(
      fast(() => parseErrorBlocks(['ERROR: x', line, `       [0] f ${'('.repeat(500_000)}`])),
    ).toHaveLength(1);
  });

  it('counts lines incrementally in big project files', () => {
    expect(fast(() => parseSectionFile('[a]\n'.repeat(80_000)))).toHaveLength(80_000);
  });

  it('bounds sub-resource inlining (exponential fan-out and cycles)', () => {
    const levels = 40;
    const subs = Array.from(
      { length: levels },
      (_, i) =>
        `[sub_resource type="R" id="s${i}"]\na = SubResource("s${Math.min(i + 1, levels - 1)}")\nb = SubResource("s${Math.min(i + 1, levels - 1)}")\n`,
    ).join('\n');
    const scene = parseSceneFile(
      `${subs}\n[node name="Root" type="Node"]\nres = SubResource("s0")\n[node name="Self" type="Node" parent="."]\nres = SubResource("s${levels - 1}")\n`,
    );
    const text = fast(() => renderScene(scene, { depth: 5, includeProperties: true, from: '.' }));
    expect(text).toContain('res=R(a=R(a=R(');
  });

  it('refuses absurdly nested values instead of overflowing the stack', () => {
    expect(() => parseVariant('['.repeat(10_000))).toThrow(VariantParseError);
    expect(() => parseVariant('['.repeat(10_000))).toThrow(/too deep/);
  });

  it('stores a "__proto__" key as plain data', () => {
    const value = parseVariant('{"__proto__": {"polluted": true}}');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses gigantic LSP frames', () => {
    expect(() =>
      new LspDecoder().push(Buffer.from('Content-Length: 999999999999\r\n\r\n{}')),
    ).toThrow(/too large/);
  });

  it('keeps only the tail of huge process output', async () => {
    const chunk = 'x'.repeat(1_000_000);
    const fake = fakeSpawner((proc) => {
      for (let i = 0; i < 10; i++) proc.stdout.write(chunk);
      proc.stdout.write('END');
      proc.exit(0);
    });
    const result = await new GodotExecutable('g', fake.spawner).exec([], { timeoutMs: 5000 });
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_EXEC_OUTPUT_CHARS);
    expect(result.stdout.endsWith('END')).toBe(true);
  });
});

describe('state files never escape the project', () => {
  let project: ReturnType<typeof makeTempProject>;
  let outside: string;

  beforeEach(() => {
    project = makeTempProject();
    outside = mkdtempSync(path.join(tmpdir(), 'godotty-outside-'));
  });

  afterEach(() => {
    project.cleanup();
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a symlinked state folder', () => {
    mkdirSync(path.join(project.root, '.godot'));
    symlinkSync(outside, path.join(project.root, '.godot', 'godotty_mcp'));
    expect(() => {
      writeSessionFile(project.root, 1, 'secret', 'v');
    }).toThrow(/is a symlink/);
    expect(() => ensureStateDir(project.root, 'runs')).toThrow(/is a symlink/);
    expect(() => statSync(path.join(outside, 'session.json'))).toThrow();
  });

  it('replaces a planted session.json symlink instead of writing through it', () => {
    const victim = path.join(outside, 'victim.txt');
    writeFileSync(victim, 'keep me');
    ensureStateDir(project.root);
    symlinkSync(victim, sessionFilePath(project.root));
    writeSessionFile(project.root, 1, 'secret', 'v');
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(lstatSync(sessionFilePath(project.root)).isSymbolicLink()).toBe(false);
  });

  it('re-creates a world-readable session file as owner-only', () => {
    ensureStateDir(project.root);
    writeFileSync(sessionFilePath(project.root), 'old', { mode: 0o644 });
    writeSessionFile(project.root, 1, 'secret', 'v');
    expect(statSync(sessionFilePath(project.root)).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(project.root, '.godot', 'godotty_mcp')).isDirectory()).toBe(true);
  });
});
