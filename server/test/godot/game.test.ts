import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GodotExecutable } from '../../src/godot/executable.js';
import { GameManager, START_PAUSED_ARG, summarize } from '../../src/godot/game.js';
import { RuntimeInjection, STATE_DIR } from '../../src/godot/runtime-injection.js';
import { ToolError } from '../../src/util/errors.js';
import { fakeGodot, type FakeGodotBehavior } from '../helpers/fake-godot.js';
import { makeTempProject } from '../helpers/tmp-project.js';

describe('GameManager', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject({ 'rt/godotty_runtime.gd': 'extends Node\n' });
  });

  afterEach(() => {
    project.cleanup();
  });

  function manager(
    behavior: FakeGodotBehavior,
    readyTimeoutMs = 2000,
  ): { game: GameManager; fake: ReturnType<typeof fakeGodot> } {
    const fake = fakeGodot(behavior);
    const injection = new RuntimeInjection(project.root, path.join(project.root, 'rt'));
    const game = new GameManager({
      godot: new GodotExecutable('godot', fake.spawner),
      projectRoot: project.root,
      injection,
      readyTimeoutMs,
    });
    return { game, fake };
  }

  it('starts, waits for the helper, restores the override and passes arguments', async () => {
    const { game, fake } = manager({
      onGame: (proc, events) => {
        proc.stdout.write('hello from game\n');
        events.ready();
      },
    });
    const { run, stoppedPrevious } = await game.start({
      scene: 'res://a.tscn',
      args: ['--level=2'],
      headless: true,
    });
    expect(stoppedPrevious).toBe(false);
    expect(run).toMatchObject({
      id: 1,
      state: 'running',
      helperReady: true,
      scene: 'res://a.tscn',
      headless: true,
      pid: 1, // Godot's own pid from the helper, not the process guard's
    });
    expect(existsSync(path.join(project.root, 'override.cfg'))).toBe(false);
    const gameCall = fake.calls.find((c) => !c.args.includes('--version'));
    expect(gameCall?.args.slice(0, 5)).toEqual([
      '--path',
      project.root,
      '--headless',
      'res://a.tscn',
      '--',
    ]);
    expect(gameCall?.args.at(-1)).toBe('--level=2');
    expect(gameCall?.guarded).toBe(process.platform !== 'win32');
    expect(game.isRunning).toBe(true);
    await expect
      .poll(() => game.output({ filter: 'all', limit: 10 }).lines.map((l) => l.text))
      .toContain('hello from game');
    game.dispose();
  });

  it('passes the start-paused flag to the helper only when asked', async () => {
    const { game, fake } = manager({
      onGame: (_proc, events) => {
        events.ready();
      },
    });
    await game.start({ args: ['--level=2'], headless: true, paused: true });
    const paused = fake.calls.filter((c) => !c.args.includes('--version')).at(-1)?.args ?? [];
    expect(paused.slice(paused.indexOf('--'))).toContain(START_PAUSED_ARG);
    expect(paused.at(-1)).toBe('--level=2');
    await game.start({ args: [], headless: true });
    const normal = fake.calls.filter((c) => !c.args.includes('--version')).at(-1)?.args ?? [];
    expect(normal).not.toContain(START_PAUSED_ARG);
    game.dispose();
  });

  it('stops the previous run when starting again, and stop() reports the exit', async () => {
    const { game } = manager({
      onGame: (_proc, events) => {
        events.ready();
      },
    });
    await game.start({ args: [], headless: false });
    const second = await game.start({ args: [], headless: false });
    expect(second.stoppedPrevious).toBe(true);
    expect(second.run.id).toBe(2);
    const stopped = await game.stop();
    expect(stopped.state).toBe('exited');
    expect(stopped.exit?.signal).toBe('SIGTERM');
    expect(game.isRunning).toBe(false);
    await expect(game.stop()).rejects.toThrow(/No game is running/);
  });

  it('turns a crash before the helper is ready into GODOT_FAILED with the startup errors', async () => {
    const { game } = manager({
      onGame: (proc) => {
        proc.stderr.write(
          'SCRIPT ERROR: Parse Error: Unexpected "Indent".\n   at: GDScript::reload (res://main.gd:3)\n',
        );
        proc.exit(1);
      },
    });
    const failure = game.start({ args: [], headless: true });
    await expect(failure).rejects.toThrow(ToolError);
    await expect(failure).rejects.toThrow(
      /exited during startup \(exit 1\)[\s\S]*res:\/\/main\.gd:3 Parse Error/,
    );
    expect(existsSync(path.join(project.root, 'override.cfg'))).toBe(false);
    expect(game.errors().errors[0]?.error).toMatchObject({ file: 'res://main.gd', line: 3 });
  });

  it('keeps running when the helper never reports ready', async () => {
    const { game } = manager({ onGame: () => undefined }, 150);
    const { run } = await game.start({ args: [], headless: true });
    expect(run).toMatchObject({ state: 'running', helperReady: false });
    game.dispose();
  });

  it('merges helper errors with stderr-only errors without double counting', async () => {
    const { game } = manager({
      onGame: (proc, events) => {
        // Before the helper loads: only on stderr.
        proc.stderr.write('ERROR: early autoload failure\n   at: _init (res://early.gd:2)\n');
        events.ready();
        // After: printed to stderr AND captured by the helper (twice, same place).
        proc.stderr.write(
          'ERROR: later\n   at: push_error (core/x.cpp:1)\n   GDScript backtrace (most recent call first):\n       [0] f (res://later.gd:9)\n',
        );
        events.write({
          event: 'error',
          type: 0,
          function: 'push_error',
          file: 'core/x.cpp',
          line: 1,
          code: 'later',
          rationale: '',
          backtrace: [{ function: 'f', file: 'res://later.gd', line: 9 }],
        });
        events.write({
          event: 'error',
          type: 0,
          function: 'push_error',
          file: 'core/x.cpp',
          line: 1,
          code: 'later',
          rationale: '',
          backtrace: [{ function: 'f', file: 'res://later.gd', line: 9 }],
        });
        events.write({ event: 'unrelated' });
      },
    });
    await game.start({ args: [], headless: true });
    await expect.poll(() => game.errors().errors.length).toBe(2);
    const { errors } = game.errors();
    expect(errors.map((e) => [e.error.message, e.error.file, e.count])).toEqual([
      ['early autoload failure', 'res://early.gd', 1],
      ['later', 'res://later.gd', 2],
    ]);
    game.dispose();
  });

  it('requires a run before output/errors', () => {
    const { game } = manager({});
    expect(() => game.errors()).toThrow(/has not been run yet/);
    expect(() => game.output({ filter: 'all', limit: 1 })).toThrow(/has not been run yet/);
    expect(game.run).toBeUndefined();
  });

  it('keeps only the most recent events files', async () => {
    const { game } = manager({
      onGame: (_proc, events) => {
        events.ready();
      },
    });
    for (let i = 0; i < 7; i++) await game.start({ args: [], headless: true });
    game.dispose();
    const runs = readdirSync(path.join(project.root, STATE_DIR, 'runs'));
    expect(runs.length).toBeLessThanOrEqual(6);
  });

  it('reports spawn failures in the output', async () => {
    const { game } = manager({
      onGame: (proc) => {
        proc.emit('error', new Error('EACCES'));
        proc.exit(null, 'SIGKILL');
      },
    });
    await expect(game.start({ args: [], headless: true })).rejects.toThrow(/exit SIGKILL/);
    expect(game.output({ filter: 'all', limit: 5 }).lines.map((l) => l.text)).toContain(
      'ERROR: failed to start Godot: EACCES',
    );
  });
});

describe('summarize', () => {
  it('groups by message and location in first-seen order', () => {
    const e = (message: string, line: number) => ({
      severity: 'error' as const,
      kind: 'engine' as const,
      message,
      file: 'res://a.gd',
      line,
      function: undefined,
      backtrace: [],
    });
    expect(
      summarize([e('x', 1), e('y', 2), e('x', 1), e('x', 3)]).map((s) => [
        s.error.message,
        s.error.line,
        s.count,
      ]),
    ).toEqual([
      ['x', 1, 2],
      ['y', 2, 1],
      ['x', 3, 1],
    ]);
  });
});
