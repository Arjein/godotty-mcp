import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseJUnit } from '../../../src/godot/tests/junit.js';

// Verbatim results.xml files written by the real frameworks during the M4 spike.
const fixture = (name: string): string =>
  readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/junit', name),
    'utf8',
  );

describe('parseJUnit', () => {
  it('parses GUT 9.7.1 output: pass, assertion failure, pending, unexpected engine error', () => {
    const [suite] = parseJUnit(fixture('gut-9.7.1.xml'));
    expect(suite?.name).toBe('test/unit/test_math.gd');
    expect(suite?.declared).toBe(4);
    expect(suite?.cases.map((c) => [c.name, c.status])).toEqual([
      ['test_adds', 'passed'],
      ['test_fails', 'failed'],
      ['test_pending', 'skipped'],
      ['test_errors', 'failed'],
    ]);
    expect(suite?.cases[1]).toMatchObject({
      message: '[4] expected to equal [5]: two times two',
      file: 'res://test/unit/test_math.gd',
      line: 9,
    });
    expect(suite?.cases[2]?.message).toBe('not yet');
    expect(suite?.cases[3]).toMatchObject({
      file: 'res://test/unit/test_math.gd',
      line: undefined,
    });
    expect(suite?.cases[3]?.message).toMatch(
      /^Unexpected Errors: \[1\] <engine-\d+>Cannot call method 'queue_free' on a null value\.$/,
    );
    expect(suite?.cases[0]?.time).toBeGreaterThan(0);
  });

  it('parses gdUnit4 6.2.3 output: failure and runtime error with res:// locations', () => {
    const [suite] = parseJUnit(fixture('gdunit4-6.2.3.xml'));
    expect(suite?.name).toBe('math_test');
    expect(suite?.cases.map((c) => [c.name, c.status, c.file, c.line])).toEqual([
      ['test_adds', 'passed', undefined, undefined],
      ['test_fails', 'failed', 'res://test/math_test.gd', 9],
      ['test_errors', 'error', 'res://test/math_test.gd', 14],
    ]);
    expect(suite?.cases[1]?.message).toBe('Expecting: 5 but was 4');
    expect(suite?.cases[2]?.message).toBe("'Cannot call method 'queue_free' on a null value.'");
  });

  it('handles attribute-only messages, missing counts and a bare testsuite root', () => {
    const suites = parseJUnit(
      '<testsuite name="s"><testcase name="a"><failure message="boom"/></testcase><testcase name="b"><skipped/></testcase></testsuite>',
    );
    expect(suites[0]).toMatchObject({ declared: 2 });
    expect(suites[0]?.cases.map((c) => [c.status, c.message, c.time])).toEqual([
      ['failed', 'boom', 0],
      ['skipped', undefined, 0],
    ]);
    expect(parseJUnit('<testsuites/>')).toEqual([]);
  });
});
