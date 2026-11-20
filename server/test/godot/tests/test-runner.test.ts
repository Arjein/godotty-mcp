import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GodotExecutable } from '../../../src/godot/executable.js';
import {
  detectFrameworks,
  scriptLoadErrors,
  TestRunner,
  type TestRunOptions,
} from '../../../src/godot/tests/test-runner.js';
import { fakeGodot, type FakeGodotBehavior } from '../../helpers/fake-godot.js';
import { makeTempProject } from '../../helpers/tmp-project.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/junit');
const GUT_XML = readFileSync(path.join(FIXTURES, 'gut-9.7.1.xml'), 'utf8');
const GDUNIT_XML = readFileSync(path.join(FIXTURES, 'gdunit4-6.2.3.xml'), 'utf8');

const argValue = (args: readonly string[], prefix: string): string =>
  args.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? '';

/** Fake framework runs that write results the way the real CLIs do. */
const writesResults: FakeGodotBehavior = {
  onScript: (proc, script, call) => {
    if (script.includes('gut_cmdln')) {
      writeFileSync(argValue(call.args, '-gjunit_xml_file='), GUT_XML);
      proc.exit(1);
    } else {
      const dir = call.args[call.args.indexOf('-rd') + 1] ?? '';
      mkdirSync(path.join(dir, 'report_1'), { recursive: true });
      mkdirSync(path.join(dir, 'report_2'), { recursive: true });
      writeFileSync(path.join(dir, 'report_2', 'results.xml'), GDUNIT_XML);
      proc.exit(100);
    }
  },
};

describe('TestRunner', () => {
  let project: ReturnType<typeof makeTempProject>;
  const opts = (o: Partial<TestRunOptions>): TestRunOptions => ({
    framework: 'gut',
    target: undefined,
    testName: undefined,
    timeoutMs: 5000,
    ...o,
  });

  beforeEach(() => {
    project = makeTempProject({ 'addons/gut/gut_cmdln.gd': '', 'test/test_a.gd': '' });
  });

  afterEach(() => {
    project.cleanup();
  });

  function runner(behavior: FakeGodotBehavior = writesResults): {
    runner: TestRunner;
    fake: ReturnType<typeof fakeGodot>;
  } {
    const fake = fakeGodot(behavior);
    return {
      runner: new TestRunner(new GodotExecutable('godot', fake.spawner), project.root),
      fake,
    };
  }

  it('detects installed frameworks', () => {
    expect(detectFrameworks(project.root)).toEqual(['gut']);
    const both = makeTempProject({
      'addons/gut/gut_cmdln.gd': '',
      'addons/gdUnit4/bin/GdUnitCmdTool.gd': '',
    });
    expect(detectFrameworks(both.root)).toEqual(['gut', 'gdunit4']);
    both.cleanup();
  });

  it('imports first, then runs GUT on res://test with JUnit output', async () => {
    const { runner: r, fake } = runner();
    const result = await r.run(opts({}));
    // Calls: --version, then --import, then the framework run.
    expect(fake.calls.map((c) => c.args.find((a) => a === '--import' || a === '-s'))).toEqual([
      undefined,
      '--import',
      '-s',
    ]);
    const gut = fake.calls[2]?.args ?? [];
    expect(gut).toEqual(
      expect.arrayContaining([
        '--headless',
        '-s',
        'res://addons/gut/gut_cmdln.gd',
        '-gexit',
        '-gdir=res://test',
        '-ginclude_subdirs',
      ]),
    );
    expect(result).toMatchObject({
      framework: 'gut',
      target: 'res://test',
      filteredAfterRun: false,
      loadErrors: [],
    });
    expect(result.suites[0]?.cases).toHaveLength(4);
  });

  it('passes file targets and name filters to GUT, and honors .gutconfig.json', async () => {
    const { runner: r, fake } = runner();
    await r.run(opts({ target: 'res://test/test_a.gd', testName: 'adds' }));
    expect(fake.calls[2]?.args).toEqual(
      expect.arrayContaining(['-gtest=res://test/test_a.gd', '-gunit_test_name=adds']),
    );
    writeFileSync(path.join(project.root, '.gutconfig.json'), '{}');
    const configured = await r.run(opts({}));
    expect(configured.target).toBe('res://.gutconfig.json');
    expect(fake.calls.at(-1)?.args.some((a) => a.startsWith('-gdir'))).toBe(false);
  });

  it('runs gdUnit4 with --continue, finds the newest report and filters by name afterwards', async () => {
    const { runner: r, fake } = runner();
    const result = await r.run(
      opts({ framework: 'gdunit4', target: 'res://test', testName: 'fails' }),
    );
    expect(fake.calls[2]?.args).toEqual(
      expect.arrayContaining([
        '-s',
        'res://addons/gdUnit4/bin/GdUnitCmdTool.gd',
        '-a',
        'res://test',
        '-c',
        '--ignoreHeadlessMode',
        '-rd',
      ]),
    );
    expect(result.filteredAfterRun).toBe(true);
    expect(result.suites[0]?.cases.map((c) => c.name)).toEqual(['test_fails']);
    expect(result.suites[0]?.declared).toBe(1);
    const nothing = await r.run(
      opts({ framework: 'gdunit4', target: 'res://test', testName: 'zzz' }),
    );
    expect(nothing.suites).toEqual([]);
  });

  it('defaults to res://tests when there is no res://test, then to res://', async () => {
    project.cleanup();
    project = makeTempProject({ 'addons/gut/gut_cmdln.gd': '', 'tests/x.gd': '' });
    expect((await runner().runner.run(opts({}))).target).toBe('res://tests');
    project.cleanup();
    project = makeTempProject({ 'addons/gut/gut_cmdln.gd': '' });
    expect((await runner().runner.run(opts({}))).target).toBe('res://');
  });

  it('reports runs that write no results, quoting errors or the output tail', async () => {
    const parseError = runner({
      onScript: (proc) => {
        proc.stderr.write(
          'SCRIPT ERROR: Parse Error: Expected parameter name.\n          at: GDScript::reload (res://test/test_a.gd:4)\n',
        );
        proc.exit(0);
      },
    });
    await expect(parseError.runner.run(opts({}))).rejects.toThrow(
      /GUT exited \(code 0\) without writing results[\s\S]*res:\/\/test\/test_a\.gd:4 Parse Error/,
    );
    const quiet = runner({
      onScript: (proc) => {
        proc.stdout.write('line one\nline two\n');
        proc.exit(3);
      },
    });
    await expect(quiet.runner.run(opts({ framework: 'gdunit4' }))).rejects.toThrow(
      /gdUnit4 exited \(code 3\)[\s\S]*Last output:\n {2}\| line one\n {2}\| line two/,
    );
  });

  it('stops runs that exceed the timeout', async () => {
    const hang = runner({ onScript: () => undefined });
    await expect(hang.runner.run(opts({ timeoutMs: 20 }))).rejects.toThrow(
      /did not finish within 0\.02s/,
    );
  });
});

describe('scriptLoadErrors', () => {
  it('keeps one parse error per location and ignores other errors', () => {
    const block =
      'SCRIPT ERROR: Parse Error: Expected parameter name.\n          at: GDScript::reload (res://t.gd:4)\n';
    const errors = scriptLoadErrors({
      stdout: '',
      stderr: `${block}${block}ERROR: Failed to load script "res://t.gd" with error "Parse error".\n   at: load (x.cpp:1)\nSCRIPT ERROR: Cannot call method on null\n   at: f (res://u.gd:2)\n`,
      exitCode: 0,
      timedOut: false,
    });
    expect(errors.map((e) => [e.file, e.line, e.message])).toEqual([
      ['res://t.gd', 4, 'Parse Error: Expected parameter name.'],
    ]);
  });
});
