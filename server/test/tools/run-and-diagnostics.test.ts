import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeGodot, type FakeGodotBehavior } from '../helpers/fake-godot.js';
import { FakeLsp } from '../helpers/fake-lsp.js';
import { makeTempProject } from '../helpers/tmp-project.js';
import { connectTools, type ToolClient } from '../helpers/tool-client.js';

const GAME: FakeGodotBehavior = {
  onGame: (proc, events) => {
    proc.stdout.write('Godot Engine v4.7.2\nplayer spawned\n');
    events.ready();
    proc.stderr.write('WARNING: low fps\n   at: f (res://a.gd:1)\n');
    events.error({ type: 1, message: 'low fps', file: 'res://a.gd', line: 1, func: 'f' });
    proc.stderr.write('SCRIPT ERROR: boom\n   at: g (res://b.gd:2)\n');
    events.write({
      event: 'error',
      type: 2,
      function: 'g',
      file: 'res://b.gd',
      line: 2,
      code: 'boom',
      rationale: '',
      backtrace: [1, 2, 3, 4, 5, 6].map((i) => ({
        function: `f${i}`,
        file: 'res://b.gd',
        line: i,
      })),
    });
  },
};

describe('run and diagnostics tools', () => {
  let project: ReturnType<typeof makeTempProject>;
  let tools: ToolClient;

  beforeEach(async () => {
    project = makeTempProject({
      'rt/x': '',
      'scenes/level.tscn': '',
      'scripts/a.gd': 'extends Node\n',
      'scripts/b.gd': 'extends Node\n',
      'notes.txt': '',
    });
    tools = await connectTools(project.root, fakeGodot(GAME).spawner);
  });

  afterEach(async () => {
    await tools.close();
    project.cleanup();
  });

  it('runs, reads output and errors, and stops', async () => {
    expect((await tools.call('get_errors')).text).toContain('GAME_NOT_RUNNING');
    expect((await tools.call('stop_game')).text).toContain('No game has been started');

    const started = await tools.call('run_game', { scene: 'scenes/level.tscn', headless: true });
    expect(started.text).toMatch(
      /^Started Run #1 \(res:\/\/scenes\/level\.tscn, headless; running for/,
    );
    expect(started.text).toContain('Runtime helper: ready');

    await expect.poll(async () => (await tools.call('get_errors')).text).toContain('boom');
    const errors = (await tools.call('get_errors')).text;
    expect(errors).toContain('1 unique error(s), 1 unique warning(s).');
    expect(errors).toContain('1. WARNING res://a.gd:1 in f(): low fps');
    expect(errors).toContain('2. ERROR res://b.gd:2 in g(): boom');
    expect(errors).toContain(
      'backtrace: f1 (res://b.gd:1) ← f2 (res://b.gd:2) ← f3 (res://b.gd:3) ← f4 (res://b.gd:4) ← f5 (res://b.gd:5) ← …',
    );
    expect(
      (await tools.call('get_errors', { severity: 'errors', include_backtrace: false })).text,
    ).not.toContain('WARNING');
    expect((await tools.call('get_errors', { severity: 'warnings' })).text).not.toContain('boom');
    expect((await tools.call('get_errors', { limit: 1 })).text).toContain(
      'call again with offset=1',
    );

    await expect
      .poll(async () => (await tools.call('get_output')).text)
      .toContain('player spawned');
    const all = (await tools.call('get_output')).text;
    expect(all).toMatch(/\d+ {2}\| player spawned/);
    expect(all).toMatch(/\d+ E\| SCRIPT ERROR: boom/);
    expect(all).toMatch(/Next: since=\d+/);
    const filtered = await tools.call('get_output', { filter: 'warnings', contains: 'FPS' });
    expect(filtered.text).toMatch(/1 of 1 matching line\(s\)\n\d+ W\| WARNING: low fps/);
    expect((await tools.call('get_output', { since: 999 })).text).not.toContain('Next:');
    // A substring filter, never an agent regex: '(' is just text (regression: ReDoS).
    expect((await tools.call('get_output', { contains: '(a+)+$' })).text).toContain(
      '0 of 0 matching',
    );
    expect((await tools.call('run_game', { args: ['--godotty-allow-eval'] })).text).toContain(
      'reserved for godotty-mcp',
    );

    expect((await tools.call('project_info')).text).toMatch(
      /Game: running \(run #1, pid \d+, [\d.]+s, helper ready\)/,
    );

    const stopped = await tools.call('stop_game');
    expect(stopped.text).toMatch(/^Stopped: Run #1 .*exited with SIGTERM/);
    expect(stopped.text).toContain(
      '1 unique error(s), 1 unique warning(s) — call get_errors for details.',
    );
    expect((await tools.call('stop_game')).text).toMatch(/^The game had already exited/);
    expect((await tools.call('project_info')).text).toContain(
      'not running (last run #1 exited with SIGTERM)',
    );
  });

  it('rejects missing scenes before launching anything', async () => {
    const missing = await tools.call('run_game', { scene: 'res://nope.tscn' });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain('Scene res://nope.tscn does not exist');
    expect(tools.services.game.run).toBeUndefined();
  });

  describe('check_scripts', () => {
    let lsp: FakeLsp;
    let checked: ToolClient;

    beforeEach(async () => {
      lsp = new FakeLsp({
        workspace: project.root,
        diagnostics: (file) =>
          file.endsWith('a.gd')
            ? [
                { line: 0, character: 0, severity: 2, message: 'unused' },
                { line: 2, character: 4, severity: 1, message: 'bad type' },
              ]
            : [],
      });
      const port = await lsp.listen();
      checked = await connectTools(project.root, fakeGodot().spawner, { editorLspPort: port });
    });

    afterEach(async () => {
      await checked.close();
      await lsp.close();
    });

    it('reports grouped, sorted diagnostics for the project', async () => {
      const { text } = await checked.call('check_scripts');
      expect(text).toBe(
        [
          '1 error(s), 1 warning(s) in 1 of 2 script(s) (checked with editor-lsp).',
          'res://scripts/a.gd',
          '  1:1 warning: unused',
          '  3:5 error: bad type',
        ].join('\n'),
      );
      expect((await checked.call('check_scripts', { include_warnings: false })).text).not.toContain(
        'unused',
      );
      expect((await checked.call('check_scripts', { limit: 1 })).text).toContain(
        '1 more not shown',
      );
      expect((await checked.call('check_scripts', { path: 'res://scripts/b.gd' })).text).toBe(
        'No problems in 1 script(s) (checked with editor-lsp).',
      );
    });

    it('groups repeated warning codes per file and excludes codes on request', async () => {
      const signal = (
        line: number,
        name: string,
      ): { line: number; character: number; severity: number; message: string } => ({
        line,
        character: 7,
        severity: 2,
        message: `(UNUSED_SIGNAL): The signal "${name}" is declared but never explicitly used in the class.`,
      });
      const noisy = new FakeLsp({
        workspace: project.root,
        diagnostics: (file) =>
          file.endsWith('a.gd')
            ? [
                signal(9, 'a'),
                signal(12, 'b'),
                signal(15, 'c'),
                { line: 20, character: 1, severity: 2, message: '(UNUSED_VARIABLE): x unused' },
              ]
            : [],
      });
      const tools = await connectTools(project.root, fakeGodot().spawner, {
        editorLspPort: await noisy.listen(),
      });
      try {
        expect((await tools.call('check_scripts')).text).toBe(
          [
            '0 error(s), 4 warning(s) in 1 of 2 script(s) (checked with editor-lsp).',
            'res://scripts/a.gd',
            '  3× warning UNUSED_SIGNAL at lines 10, 13, 16; first: The signal "a" is declared but never explicitly used in the class.',
            '  21:2 warning: (UNUSED_VARIABLE): x unused',
          ].join('\n'),
        );
        expect((await tools.call('check_scripts', { exclude_codes: ['unused_signal'] })).text).toBe(
          [
            '0 error(s), 1 warning(s) in 1 of 2 script(s) (checked with editor-lsp).',
            'res://scripts/a.gd',
            '  21:2 warning: (UNUSED_VARIABLE): x unused',
            '(3 warning(s) excluded by exclude_codes.)',
          ].join('\n'),
        );
      } finally {
        await tools.close();
        await noisy.close();
      }
    });

    it('validates the path', async () => {
      expect((await checked.call('check_scripts', { path: 'res://notes.txt' })).text).toContain(
        'not a GDScript file',
      );
      expect((await checked.call('check_scripts', { path: 'res://missing' })).text).toContain(
        'does not exist',
      );
      expect((await checked.call('check_scripts', { path: 'res://scenes' })).text).toBe(
        'No GDScript files found under res://scenes.',
      );
      expect(
        (await checked.call('check_scripts', { path: path.join(project.root, '..') })).text,
      ).toContain('PATH_OUTSIDE_PROJECT');
    });
  });
});
