import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GodotExecutable } from '../../src/godot/executable.js';
import { findFreePort, ScriptChecker } from '../../src/godot/script-checker.js';
import { fakeGodot, type FakeGodotBehavior } from '../helpers/fake-godot.js';
import { FakeLsp } from '../helpers/fake-lsp.js';
import { makeTempProject } from '../helpers/tmp-project.js';

const FAST = {
  connect: 200,
  headlessStart: 3000,
  request: 1000,
  diagnostics: 500,
  idle: 60_000,
  checkOnly: 1000,
};

describe('ScriptChecker', () => {
  let project: ReturnType<typeof makeTempProject>;
  let a: string;
  let b: string;
  const servers: FakeLsp[] = [];
  const checkers: ScriptChecker[] = [];

  beforeEach(() => {
    project = makeTempProject({ 'a.gd': 'extends Node\n', 'b.gd': 'extends Node\n' });
    a = path.join(project.root, 'a.gd');
    b = path.join(project.root, 'b.gd');
  });

  afterEach(async () => {
    for (const checker of checkers.splice(0)) checker.dispose();
    for (const server of servers.splice(0)) await server.close();
    project.cleanup();
  });

  async function lsp(
    options: ConstructorParameters<typeof FakeLsp>[0],
    port?: number,
  ): Promise<number> {
    const server = new FakeLsp(options);
    servers.push(server);
    return server.listen(port);
  }

  function checker(
    editorLspPort: number,
    behavior: FakeGodotBehavior = {},
  ): { checker: ScriptChecker; fake: ReturnType<typeof fakeGodot> } {
    const fake = fakeGodot(behavior);
    const instance = new ScriptChecker({
      godot: new GodotExecutable('godot', fake.spawner),
      projectRoot: project.root,
      editorLspPort,
      timeouts: FAST,
    });
    checkers.push(instance);
    return { checker: instance, fake };
  }

  const diagnosticsFor = (file: string) =>
    file.endsWith('a.gd')
      ? [
          { line: 3, character: 14, severity: 1, message: 'Type mismatch' },
          { line: 4, character: 0, severity: 2, message: '(UNUSED_VARIABLE) x' },
        ]
      : [];

  it('uses the editor language server when it has this project open', async () => {
    const port = await lsp({ workspace: project.root, diagnostics: diagnosticsFor });
    const { checker: c, fake } = checker(port);
    const result = await c.check([a, b]);
    expect(result.source).toBe('editor-lsp');
    expect(result.checked).toBe(2);
    expect(result.diagnostics).toEqual([
      { file: a, line: 4, column: 15, severity: 'error', message: 'Type mismatch' },
      { file: a, line: 5, column: 1, severity: 'warning', message: '(UNUSED_VARIABLE) x' },
    ]);
    expect(fake.calls).toHaveLength(0);
  });

  it('starts a headless editor when the editor has another project open, and reuses it', async () => {
    const editorPort = await lsp({ workspace: '/some/other/project' });
    const { checker: c, fake } = checker(editorPort, {
      onEditor: (_proc, port) => {
        void lsp({ diagnostics: diagnosticsFor }, port);
      },
    });
    const first = await c.check([a]);
    expect(first.source).toBe('headless-lsp');
    expect(first.diagnostics).toHaveLength(2);
    const second = await c.check([b]);
    expect(second.source).toBe('headless-lsp');
    expect(fake.calls.filter((call) => call.args.includes('--lsp-port'))).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual(
      expect.arrayContaining(['--headless', '--editor', '--path', project.root]),
    );
    expect(fake.calls[0]?.guarded).toBe(process.platform !== 'win32');
  });

  it('falls back to --check-only when no language server comes up', async () => {
    const { checker: c } = checker(await findFreePort(), {
      onEditor: (proc) => {
        proc.exit(1);
      },
      onCheckOnly: (resPath) =>
        resPath === 'res://a.gd'
          ? 'SCRIPT ERROR: Parse Error: Expected parameter name.\n          at: GDScript::reload (res://a.gd:3)\nSCRIPT ERROR: dependency\n          at: GDScript::reload (res://other.gd:1)\n'
          : '',
    });
    const result = await c.check([a, b]);
    expect(result.source).toBe('check-only');
    expect(result.diagnostics).toEqual([
      {
        file: a,
        line: 3,
        column: undefined,
        severity: 'error',
        message: 'Parse Error: Expected parameter name.',
      },
    ]);
  });

  it('falls back to --check-only and drops a headless editor that never publishes diagnostics', async () => {
    const { checker: c, fake } = checker(await findFreePort(), {
      onEditor: (_proc, port) => {
        void lsp({ diagnostics: () => undefined }, port);
      },
    });
    const result = await c.check([a]);
    expect(result.source).toBe('check-only');
    const editor = fake.processes.find((_, i) => fake.calls[i]?.args.includes('--lsp-port'));
    expect(editor?.signals).toContain('SIGTERM');
  });

  it('never starts a second editor while the real one is open (regression: concurrent .godot writes)', async () => {
    const fake = fakeGodot({ onEditor: () => undefined, onCheckOnly: () => '' });
    const instance = new ScriptChecker({
      godot: new GodotExecutable('godot', fake.spawner),
      projectRoot: project.root,
      editorLspPort: await findFreePort(),
      editorOpen: () => true,
      timeouts: FAST,
    });
    checkers.push(instance);
    expect((await instance.check([a])).source).toBe('check-only');
    expect(fake.calls.some((c) => c.args.includes('--lsp-port'))).toBe(false);
  });

  it('ignores an editor that does not announce its workspace', async () => {
    const editorPort = await lsp({ diagnostics: diagnosticsFor });
    const { checker: c } = checker(editorPort, {
      onEditor: (proc) => {
        proc.exit(1);
      },
    });
    expect((await c.check([b])).source).toBe('check-only');
  });
});

describe('findFreePort', () => {
  it('returns a usable port', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
  });
});
