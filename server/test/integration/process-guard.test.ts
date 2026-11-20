import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guardArgs } from '../../src/godot/process-guard.js';
import { copyDemoProject } from '../helpers/demo.js';
import { GODOT } from './harness.js';

const STARTUP_MS = 3_000;
const EXIT_WAIT_MS = 10_000;
const POLL_MS = 50;

/** Plays a godotty-mcp server: starts Godot behind the guard and prints the guard's pid. */
const MINI_SERVER = `
const { spawn } = require('node:child_process');
const guard = spawn(process.execPath, JSON.parse(process.env.GUARD_ARGS), {
  stdio: ['pipe', 'ignore', 'ignore'],
});
process.stdout.write(String(guard.pid) + '\\n');
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

/** Pids of the processes (guard and Godot) running the given project. */
function godotPidsFor(root: string): number[] {
  return spawnSync('pgrep', ['-f', '--', `--path ${root}`], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean)
    .map(Number);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform === 'win32')('process guard with real Godot', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'godotty-guard-godot-'));
    copyDemoProject(root);
  });

  afterAll(() => {
    for (const pid of godotPidsFor(root)) process.kill(pid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });

  it('a game stops when the server that started it is SIGKILLed', async () => {
    const server = spawn(process.execPath, ['-e', MINI_SERVER], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        ...process.env,
        GUARD_ARGS: JSON.stringify([...guardArgs(GODOT), '--headless', '--path', root]),
      },
    });
    await delay(STARTUP_MS);
    const godot = godotPidsFor(root).filter((pid) => pid !== server.pid);
    expect(godot.length).toBeGreaterThan(0);
    server.kill('SIGKILL');
    const deadline = Date.now() + EXIT_WAIT_MS;
    while (godot.some(isAlive) && Date.now() < deadline) await delay(POLL_MS);
    expect(godot.filter(isAlive)).toEqual([]);
  });
});
