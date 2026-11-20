import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatVersion,
  GodotExecutable,
  killGracefully,
  NO_EDITOR_BRIDGE_ENV,
  parseGodotVersion,
} from '../../src/godot/executable.js';
import { ToolError } from '../../src/util/errors.js';
import { FakeProcess, fakeSpawner } from '../helpers/fake-process.js';

describe('parseGodotVersion', () => {
  it.each([
    ['4.7.2.stable.official.ed1daf0bf\n', { major: 4, minor: 7, patch: 2, status: 'stable' }],
    ['4.5.stable.official.abc', { major: 4, minor: 5, patch: 0, status: 'stable' }],
    ['some banner\n4.6.1.rc2.custom_build', { major: 4, minor: 6, patch: 1, status: 'rc2' }],
  ])('parses %j', (output, expected) => {
    expect(parseGodotVersion(output)).toMatchObject(expected);
  });

  it('rejects non-version output', () => {
    expect(parseGodotVersion('hello')).toBeUndefined();
    expect(parseGodotVersion('')).toBeUndefined();
  });

  it('formats versions', () => {
    const v = parseGodotVersion('4.7.2.stable.official.x');
    expect(v && formatVersion(v)).toBe('4.7.2.stable');
  });
});

function godotPrinting(stdout: string, code = 0): ReturnType<typeof fakeSpawner> {
  return fakeSpawner((proc) => {
    proc.stdout.write(stdout);
    proc.exit(code);
  });
}

describe('GodotExecutable', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects and caches a supported version', async () => {
    const fake = godotPrinting('4.7.2.stable.official.ed1daf0bf\n');
    const godot = new GodotExecutable('/bin/godot', fake.spawner);
    await expect(godot.version()).resolves.toMatchObject({ major: 4, minor: 7, patch: 2 });
    await godot.version();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ command: '/bin/godot', args: ['--version'] });
  });

  it.each([
    ['4.4.1.stable.official', /4\.4\.1\.stable is not supported/],
    ['3.6.stable.official', /not supported/],
    ['5.0.stable.official', /not supported/],
    ['garbage', /did not report a Godot version/],
  ])('rejects %s and retries on the next call', async (output, message) => {
    const fake = godotPrinting(output);
    const godot = new GodotExecutable('godot', fake.spawner);
    await expect(godot.version()).rejects.toThrow(message);
    await expect(godot.version()).rejects.toThrow(ToolError);
    expect(fake.calls).toHaveLength(2);
  });

  it('maps ENOENT to an actionable GODOT_NOT_FOUND error', async () => {
    const fake = fakeSpawner((proc) => {
      proc.emit('error', Object.assign(new Error('spawn godot ENOENT'), { code: 'ENOENT' }));
    });
    const godot = new GodotExecutable('nope-godot', fake.spawner);
    await expect(godot.exec(['--version'], { timeoutMs: 1000 })).rejects.toThrow(/was not found/);
  });

  it('passes through other spawn errors', async () => {
    const fake = fakeSpawner((proc) => {
      proc.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    });
    await expect(
      new GodotExecutable('g', fake.spawner).exec([], { timeoutMs: 1000 }),
    ).rejects.toThrow('EACCES');
  });

  it('marks every spawned process so the editor plugin stays offline in it', () => {
    const fake = fakeSpawner(() => undefined);
    new GodotExecutable('g', fake.spawner).spawn(['--editor'], { env: { EXTRA: '1' } });
    expect(fake.calls[0]?.env).toMatchObject({ EXTRA: '1', [NO_EDITOR_BRIDGE_ENV]: '1' });
  });

  it('collects stdout/stderr and passes cwd', async () => {
    const fake = fakeSpawner((proc) => {
      proc.stdout.write('out');
      proc.stderr.write('err');
      proc.exit(3);
    });
    const result = await new GodotExecutable('g', fake.spawner).exec(['-x'], {
      cwd: '/proj',
      timeoutMs: 1000,
    });
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 3, timedOut: false });
    expect(fake.calls[0]?.cwd).toBe('/proj');
  });

  it('kills and flags processes that exceed the timeout', async () => {
    const fake = fakeSpawner(() => undefined);
    const result = await new GodotExecutable('g', fake.spawner).exec([], { timeoutMs: 10 });
    expect(result.timedOut).toBe(true);
    expect(fake.processes[0]?.signals).toEqual(['SIGTERM']);
  });
});

describe('killGracefully', () => {
  it('escalates to SIGKILL when SIGTERM is ignored', () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    proc.diesOnKill = false;
    killGracefully(proc.asChild());
    expect(proc.signals).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(5000);
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);
    vi.useRealTimers();
  });

  it('does nothing for exited processes', () => {
    const proc = new FakeProcess();
    proc.exitCode = 0;
    killGracefully(proc.asChild());
    expect(proc.signals).toEqual([]);
  });
});
