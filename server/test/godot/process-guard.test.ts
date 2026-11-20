import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GodotExecutable, killGracefully } from '../../src/godot/executable.js';
import { guardArgs } from '../../src/godot/process-guard.js';

const WAIT_MS = 5_000;
const POLL_MS = 25;
const SHORT_GRACE_MS = 200;

/** A stand-in for the Godot binary: prints its pid, then behaves as its first argument says. */
const FAKE_GODOT = `#!${process.execPath}
const mode = process.argv[2];
if (mode === 'stubborn') process.on('SIGTERM', () => undefined);
process.stdout.write('pid ' + process.pid + '\\n');
if (mode === 'exit3') {
  process.stdout.write('hello\\n');
  process.exit(3);
}
setInterval(() => undefined, 1000);
`;

/** Plays a server that starts Godot behind the guard, so the test can SIGKILL it. */
const MINI_SERVER = `
const { spawn } = require('node:child_process');
spawn(process.execPath, JSON.parse(process.env.GUARD_ARGS), { stdio: ['pipe', 'inherit', 'inherit'] });
setInterval(() => undefined, 1000);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Resolves with the fake Godot's pid once it printed it. */
function godotPid(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = /pid (\d+)/.exec(out);
      if (match?.[1] !== undefined) resolve(Number(match[1]));
    });
  });
}

function closed(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.on('close', (code: number | null, signal: string | null) => {
      resolve({ code, signal });
    });
  });
}

describe.skipIf(process.platform === 'win32')('process guard', () => {
  let dir: string;
  let godot: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'godotty-guard-'));
    godot = path.join(dir, 'godot');
    writeFileSync(godot, FAKE_GODOT);
    chmodSync(godot, 0o755);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes output and the exit code through', async () => {
    const child = new GodotExecutable(godot).spawnGuarded(['exit3']);
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    expect(await closed(child)).toEqual({ code: 3, signal: null });
    expect(out).toContain('hello');
  });

  it('stops Godot when the server is killed hard', async () => {
    const server = spawn(process.execPath, ['-e', MINI_SERVER], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, GUARD_ARGS: JSON.stringify([...guardArgs(godot), 'wait']) },
    });
    const pid = await godotPid(server);
    expect(isAlive(pid)).toBe(true);
    server.kill('SIGKILL');
    await waitFor(() => !isAlive(pid), 'Godot to exit after the server died');
  });

  it('forwards SIGTERM and reports how Godot ended', async () => {
    const child = new GodotExecutable(godot).spawnGuarded(['wait']);
    const pid = await godotPid(child);
    const done = closed(child);
    killGracefully(child);
    expect(await done).toEqual({ code: null, signal: 'SIGTERM' });
    expect(isAlive(pid)).toBe(false);
  });

  it('escalates to SIGKILL when Godot ignores SIGTERM', async () => {
    const child = spawn(process.execPath, [...guardArgs(godot, SHORT_GRACE_MS), 'stubborn'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const pid = await godotPid(child);
    const done = closed(child);
    child.kill('SIGTERM');
    expect(await done).toEqual({ code: null, signal: 'SIGKILL' });
    expect(isAlive(pid)).toBe(false);
  });
});
