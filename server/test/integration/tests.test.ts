import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installTestAddon, startHarness, type Harness } from './harness.js';

const GUT_EXTRA = [
  'extends GutTest',
  '',
  '',
  'func test_math_fails() -> void:',
  '\tassert_eq(2 * 2, 5, "two times two")',
  '',
  '',
  'func test_later() -> void:',
  '\tpending("not yet")',
  '',
  '',
  'func test_crashes() -> void:',
  '\tvar n: Node = null',
  '\tn.queue_free()',
  '',
].join('\n');

const GDUNIT_SUITE = [
  'extends GdUnitTestSuite',
  '',
  '',
  'func test_adds() -> void:',
  '\tassert_int(1 + 1).is_equal(2)',
  '',
  '',
  'func test_fails() -> void:',
  '\tassert_int(2 * 2).is_equal(5)',
  '',
  '',
  'func test_errors() -> void:',
  '\tvar n: Node = null',
  '\tn.queue_free()',
  '',
].join('\n');

describe('run_tests with GUT', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ 'test/unit/test_extra.gd': GUT_EXTRA });
    installTestAddon(h.root, 'gut');
  });

  afterAll(async () => {
    await h.close();
  });

  it('runs the demo player tests plus failures, pending and crashing tests', async () => {
    const { text, isError } = await h.call('run_tests');
    expect(isError).toBe(false);
    expect(text).toMatch(
      /^GUT FAILED — 6 test\(s\): 3 passed, 2 failed, 0 errored, 1 skipped \([\d.]+s, res:\/\/test\)/,
    );
    expect(text).toContain(
      '✗ test/unit/test_extra.gd › test_math_fails  (res://test/unit/test_extra.gd:5)',
    );
    expect(text).toContain('[4] expected to equal [5]: two times two');
    expect(text).toMatch(
      /✗ test\/unit\/test_extra\.gd › test_crashes .*\n {4}Unexpected Errors: \[1\] <engine-\d+>Cannot call method 'queue_free' on a null value\./,
    );
    expect(text).toContain('- test/unit/test_extra.gd › test_later: not yet');
  });

  it('narrows by file and by test name', async () => {
    const file = await h.call('run_tests', {
      path: 'res://test/unit/test_player.gd',
      include_passed: true,
    });
    expect(file.text).toMatch(/^GUT PASSED — 3 test\(s\): 3 passed/);
    expect(file.text).toContain('✓ test/unit/test_player.gd › test_moves_right_with_input');
    const named = await h.call('run_tests', { test_name: 'falls' });
    expect(named.text).toMatch(/^GUT PASSED — 1 test\(s\): 1 passed/);
  });

  it('reports test scripts that fail to load instead of a silent pass', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      path.join(h.root, 'test/unit/test_broken.gd'),
      'extends GutTest\n\n\nfunc test_x( -> void:\n\tpass\n',
    );
    const alone = await h.call('run_tests', { path: 'res://test/unit/test_broken.gd' });
    expect(alone.text).toMatch(/^GUT FAILED — 0 test\(s\)/);
    expect(alone.text).toContain(
      'Scripts that failed to load (their tests did NOT run):\n✗ res://test/unit/test_broken.gd:4  Parse Error:',
    );
    // In a folder run the broken file must not just vanish from an otherwise green run.
    const all = await h.call('run_tests', { path: 'res://test/unit/test_player.gd' });
    expect(all.text).toMatch(/^GUT PASSED/);
    const folder = await h.call('run_tests', { test_name: 'falls' });
    expect(folder.text).toMatch(/^GUT FAILED — 1 test\(s\): 1 passed/);
    expect(folder.text).toContain('res://test/unit/test_broken.gd:4');
  });
});

describe('run_tests with gdUnit4', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ 'test/math_test.gd': GDUNIT_SUITE });
    installTestAddon(h.root, 'gdunit4');
  });

  afterAll(async () => {
    await h.close();
  });

  it('runs every test (no fail-fast) and reports failures and runtime errors', async () => {
    const { text } = await h.call('run_tests', { path: 'res://test/math_test.gd' });
    expect(text).toMatch(/^gdUnit4 FAILED — 3 test\(s\): 1 passed, 1 failed, 1 errored, 0 skipped/);
    expect(text).toContain('✗ math_test › test_fails  (res://test/math_test.gd:9)');
    expect(text).toMatch(/Expecting: 5 but was 4/);
    expect(text).toContain(
      "✗ math_test › test_errors [error]  (res://test/math_test.gd:14)\n    'Cannot call method 'queue_free' on a null value.'",
    );
    // Reports go to a temp folder, never into the project.
    expect(existsSync(path.join(h.root, 'reports'))).toBe(false);
  });

  it('filters by test name after the run', async () => {
    const { text } = await h.call('run_tests', {
      path: 'res://test/math_test.gd',
      test_name: 'adds',
    });
    expect(text).toMatch(/^gdUnit4 PASSED — 1 test\(s\): 1 passed/);
    expect(text).toContain('gdUnit4 cannot select tests by name');
  });

  it('explains a missing framework', async () => {
    const { text, isError } = await h.call('run_tests', { framework: 'gut' });
    expect(isError).toBe(true);
    expect(text).toContain('GUT is not installed');
  });
});
