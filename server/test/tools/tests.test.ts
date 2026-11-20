import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TestRunResult } from '../../src/godot/tests/test-runner.js';
import { formatResult } from '../../src/tools/tests.js';
import { fakeGodot } from '../helpers/fake-godot.js';
import { makeTempProject } from '../helpers/tmp-project.js';
import { connectTools, type ToolClient } from '../helpers/tool-client.js';

const GUT_XML = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/junit/gut-9.7.1.xml'),
  'utf8',
);

describe('run_tests tool', () => {
  let project: ReturnType<typeof makeTempProject>;
  let tools: ToolClient;

  beforeEach(async () => {
    project = makeTempProject({ 'addons/gut/gut_cmdln.gd': '', 'test/test_math.gd': '' });
    tools = await connectTools(
      project.root,
      fakeGodot({
        onScript: (proc, _script, call) => {
          writeFileSync(
            call.args
              .find((a) => a.startsWith('-gjunit_xml_file='))
              ?.slice('-gjunit_xml_file='.length) ?? '',
            GUT_XML,
          );
          proc.exit(1);
        },
      }).spawner,
    );
  });

  afterEach(async () => {
    await tools.close();
    project.cleanup();
  });

  it('runs the detected framework and formats results', async () => {
    const { text, isError } = await tools.call('run_tests', { include_passed: true });
    expect(isError).toBe(false);
    expect(text).toMatch(
      /^GUT FAILED — 4 test\(s\): 1 passed, 2 failed, 0 errored, 1 skipped \([\d.]+s, res:\/\/test\)\nFailures:\n/,
    );
    expect(text).toContain(
      '✗ test/unit/test_math.gd › test_fails  (res://test/unit/test_math.gd:9)\n    [4] expected to equal [5]: two times two',
    );
    expect(text).toContain('Skipped:\n- test/unit/test_math.gd › test_pending: not yet');
    expect(text).toContain('Passed:\n✓ test/unit/test_math.gd › test_adds');
  });

  it('validates framework choice and path', async () => {
    expect((await tools.call('run_tests', { framework: 'gdunit4' })).text).toContain(
      'gdUnit4 is not installed',
    );
    expect((await tools.call('run_tests', { path: 'res://nope' })).text).toContain(
      'res://nope does not exist',
    );
    expect((await tools.call('run_tests', { path: '../x' })).text).toContain(
      'PATH_OUTSIDE_PROJECT',
    );
    expect(
      (await tools.call('run_tests', { framework: 'gut', path: 'test/test_math.gd' })).isError,
    ).toBe(false);
  });

  it('asks to choose when both frameworks are installed, and explains when none is', async () => {
    const both = makeTempProject({
      'addons/gut/gut_cmdln.gd': '',
      'addons/gdUnit4/bin/GdUnitCmdTool.gd': '',
    });
    const none = makeTempProject();
    const bothTools = await connectTools(both.root, fakeGodot().spawner);
    const noneTools = await connectTools(none.root, fakeGodot().spawner);
    expect((await bothTools.call('run_tests')).text).toContain(
      'Both GUT and gdUnit4 are installed',
    );
    expect((await noneTools.call('run_tests')).text).toContain('No test framework found');
    await bothTools.close();
    await noneTools.close();
    both.cleanup();
    none.cleanup();
  });
});

describe('formatResult', () => {
  const base: TestRunResult = {
    framework: 'gdunit4',
    target: 'res://test',
    suites: [],
    filteredAfterRun: false,
    loadErrors: [],
    durationMs: 1500,
  };
  const passing = {
    suite: 's',
    name: 't',
    status: 'passed' as const,
    message: undefined,
    file: undefined,
    line: undefined,
    time: 0,
  };

  it('says NO TESTS with a naming hint when nothing ran', () => {
    expect(formatResult(base, false)).toBe(
      "gdUnit4 NO TESTS — 0 test(s): 0 passed, 0 failed, 0 errored, 0 skipped (1.5s, res://test)\nNo tests ran. Check that test scripts follow the framework's naming (GUT: test_*.gd extending GutTest; gdUnit4: *_test.gd extending GdUnitTestSuite).",
    );
  });

  it('fails runs with missing tests, load errors, and notes post-run filtering', () => {
    const text = formatResult(
      {
        ...base,
        filteredAfterRun: true,
        suites: [{ name: 'math_test', declared: 3, cases: [passing] }],
        loadErrors: [
          {
            severity: 'error',
            kind: 'script',
            message: 'Parse Error: x',
            file: 'res://b.gd',
            line: 2,
            function: undefined,
            backtrace: [],
          },
        ],
      },
      false,
    );
    expect(text).toMatch(/^gdUnit4 FAILED — 1 test\(s\): 1 passed/);
    expect(text).toContain(
      'Scripts that failed to load (their tests did NOT run):\n✗ res://b.gd:2  Parse Error: x',
    );
    expect(text).toContain('Warning: math_test declares 3 tests but only 1 reported');
    expect(text).toContain('gdUnit4 cannot select tests by name');
    expect(text).not.toContain('Passed:');
  });

  it('caps long failure lists and messages', () => {
    const failing = Array.from({ length: 35 }, (_, i) => ({
      ...passing,
      name: `t${i}`,
      status: 'failed' as const,
      message: 'x'.repeat(500),
    }));
    const text = formatResult(
      { ...base, suites: [{ name: 's', declared: 35, cases: failing }] },
      false,
    );
    expect(text).toContain('… 5 more; narrow with path or test_name.');
    expect(text).toContain(`${'x'.repeat(399)}…`);
    expect(text).toMatch(/✗ s › t0\n/);
  });
});
