import { existsSync } from 'node:fs';

import { z } from 'zod';

import type { TestCase } from '../godot/tests/junit.js';
import {
  detectFrameworks,
  FRAMEWORKS,
  type Framework,
  type TestRunResult,
} from '../godot/tests/test-runner.js';
import { ErrorCode, ToolError } from '../util/errors.js';
import { defineTool, textResult, type ToolContext } from './registry.js';

const DEFAULT_TIMEOUT_S = 300;
const MAX_TIMEOUT_S = 1800;
const MS_PER_SECOND = 1000;
const MAX_FAILURES_SHOWN = 30;
const MAX_MESSAGE_CHARS = 400;
const MAX_TEST_NAME_CHARS = 200;
const STATUS_MARK = { passed: '✓', failed: '✗', error: '✗', skipped: '-' } as const;

export const runTests = defineTool({
  name: 'run_tests',
  title: 'Run tests',
  description:
    "Runs the project's GUT or gdUnit4 tests headless (auto-detected from addons/) and returns structured " +
    'results: totals, then each failing test with its file:line and message, skipped tests, and a warning ' +
    'when tests declared by a suite never reported (crash). Imports the project first so new test scripts ' +
    'are found. Narrow with "path" (folder or test script) and "test_name" (substring of test names).',
  inputSchema: {
    framework: z
      .enum(['auto', 'gut', 'gdunit4'])
      .default('auto')
      .describe('Which framework to use; "auto" picks the installed one.'),
    path: z
      .string()
      .optional()
      .describe(
        'res:// test folder or test script. Default: res://test (or res://tests; GUT honors .gutconfig.json).',
      ),
    test_name: z
      .string()
      .max(MAX_TEST_NAME_CHARS)
      .optional()
      .describe('Only tests whose name contains this text.'),
    include_passed: z.boolean().default(false).describe('Also list passing tests.'),
    timeout_s: z.number().int().min(1).max(MAX_TIMEOUT_S).default(DEFAULT_TIMEOUT_S),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    const framework = chooseFramework(ctx, args.framework);
    const target = args.path === undefined ? undefined : resolveTarget(ctx, args.path);
    const result = await ctx.tests.run({
      framework,
      target,
      testName: args.test_name,
      timeoutMs: args.timeout_s * MS_PER_SECOND,
    });
    return textResult(formatResult(result, args.include_passed));
  },
});

function chooseFramework(ctx: ToolContext, requested: 'auto' | Framework): Framework {
  const installed = detectFrameworks(ctx.sandbox.root);
  if (requested !== 'auto') {
    if (!installed.includes(requested)) {
      throw new ToolError(
        ErrorCode.NotFound,
        `${FRAMEWORKS[requested].label} is not installed (missing res://${FRAMEWORKS[requested].entry}).`,
        'Install it into addons/, or use framework="auto".',
      );
    }
    return requested;
  }
  const [only, ...others] = installed;
  if (only === undefined) {
    throw new ToolError(
      ErrorCode.NotFound,
      'No test framework found (looked for GUT and gdUnit4 in addons/).',
      'Install GUT (addons/gut) or gdUnit4 (addons/gdUnit4) from the Asset Library, then run again.',
    );
  }
  if (others.length > 0) {
    throw new ToolError(
      ErrorCode.InvalidInput,
      'Both GUT and gdUnit4 are installed.',
      'Pass framework="gut" or framework="gdunit4".',
    );
  }
  return only;
}

function resolveTarget(ctx: ToolContext, input: string): string {
  const file = ctx.sandbox.resolve(input);
  const resPath = ctx.sandbox.toResPath(file);
  if (!existsSync(file)) {
    throw new ToolError(
      ErrorCode.NotFound,
      `${resPath} does not exist.`,
      'Find test scripts with list_files glob="test*".',
    );
  }
  return resPath;
}

export function formatResult(result: TestRunResult, includePassed: boolean): string {
  const cases = result.suites.flatMap((s) => s.cases);
  const count = (status: TestCase['status']): number =>
    cases.filter((c) => c.status === status).length;
  const failed = count('failed');
  const errored = count('error');
  const missing = result.suites.reduce((n, s) => n + Math.max(0, s.declared - s.cases.length), 0);
  const loadFailures = result.loadErrors.length;
  const verdict =
    failed + errored + missing + loadFailures > 0
      ? 'FAILED'
      : cases.length === 0
        ? 'NO TESTS'
        : 'PASSED';
  const seconds = (result.durationMs / MS_PER_SECOND).toFixed(1);
  const lines = [
    `${FRAMEWORKS[result.framework].label} ${verdict} — ${cases.length} test(s): ${count('passed')} passed, ${failed} failed, ${errored} errored, ${count('skipped')} skipped (${seconds}s, ${result.target})`,
  ];
  if (loadFailures > 0) {
    lines.push('Scripts that failed to load (their tests did NOT run):');
    for (const e of result.loadErrors.slice(0, MAX_FAILURES_SHOWN)) {
      lines.push(
        `✗ ${e.file ?? '?'}${e.line === undefined ? '' : `:${e.line}`}  ${truncate(e.message)}`,
      );
    }
  }
  const problems = cases.filter((c) => c.status === 'failed' || c.status === 'error');
  if (problems.length > 0) {
    lines.push('Failures:');
    for (const c of problems.slice(0, MAX_FAILURES_SHOWN)) lines.push(...describeCase(c));
    if (problems.length > MAX_FAILURES_SHOWN)
      lines.push(`… ${problems.length - MAX_FAILURES_SHOWN} more; narrow with path or test_name.`);
  }
  const skipped = cases.filter((c) => c.status === 'skipped');
  if (skipped.length > 0) {
    lines.push(
      'Skipped:',
      ...skipped.map(
        (c) =>
          `- ${c.suite} › ${c.name}${c.message === undefined ? '' : `: ${truncate(c.message)}`}`,
      ),
    );
  }
  if (includePassed) {
    const passed = cases.filter((c) => c.status === 'passed');
    if (passed.length > 0)
      lines.push('Passed:', ...passed.map((c) => `${STATUS_MARK.passed} ${c.suite} › ${c.name}`));
  }
  for (const suite of result.suites.filter((s) => s.declared > s.cases.length)) {
    lines.push(
      `Warning: ${suite.name} declares ${suite.declared} tests but only ${suite.cases.length} reported — some crashed or never ran; run that file alone to see why.`,
    );
  }
  if (cases.length === 0 && loadFailures === 0)
    lines.push(
      "No tests ran. Check that test scripts follow the framework's naming (GUT: test_*.gd extending GutTest; gdUnit4: *_test.gd extending GdUnitTestSuite).",
    );
  if (result.filteredAfterRun)
    lines.push(
      'Note: gdUnit4 cannot select tests by name, so the whole selection ran and results were filtered.',
    );
  return lines.join('\n');
}

function describeCase(c: TestCase): string[] {
  const where =
    c.file === undefined ? '' : `  (${c.file}${c.line === undefined ? '' : `:${c.line}`})`;
  const kind = c.status === 'error' ? ' [error]' : '';
  const lines = [`${STATUS_MARK[c.status]} ${c.suite} › ${c.name}${kind}${where}`];
  if (c.message !== undefined) lines.push(`    ${truncate(c.message)}`);
  return lines;
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}
