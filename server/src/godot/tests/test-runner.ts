import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ErrorCode, ToolError } from '../../util/errors.js';
import type { ExecResult, GodotExecutable } from '../executable.js';
import { errorKey, parseErrorBlocks, type GodotError } from '../godot-log.js';
import { parseJUnit, type TestSuite } from './junit.js';

export type Framework = 'gut' | 'gdunit4';

export const FRAMEWORKS: Readonly<Record<Framework, { label: string; entry: string }>> = {
  gut: { label: 'GUT', entry: 'addons/gut/gut_cmdln.gd' },
  gdunit4: { label: 'gdUnit4', entry: 'addons/gdUnit4/bin/GdUnitCmdTool.gd' },
};

export interface TestRunOptions {
  framework: Framework;
  /** res:// folder or test script; undefined = the framework's default location. */
  target: string | undefined;
  /** Only tests whose name contains this text. */
  testName: string | undefined;
  /** Godot's --fixed-fps: N frames per simulated second, without real-time sync. */
  fixedFps?: number | undefined;
  timeoutMs: number;
}

export interface TestRunResult {
  framework: Framework;
  target: string;
  suites: TestSuite[];
  /** True when `testName` was applied to the results (gdUnit4 has no CLI filter). */
  filteredAfterRun: boolean;
  /** Scripts that failed to parse/load during the run; frameworks silently skip such test files. */
  loadErrors: GodotError[];
  durationMs: number;
}

const IMPORT_TIMEOUT_MS = 300_000;
const GUT_CONFIG = '.gutconfig.json';
const DEFAULT_TEST_DIRS = ['test', 'tests'];
const RES_PREFIX = 'res://';
const OUTPUT_TAIL_LINES = 15;
const MS_PER_SECOND = 1000;
const STARTUP_ERRORS_SHOWN = 5;

/** Frameworks installed in the project (by their CLI entry script). */
export function detectFrameworks(projectRoot: string): Framework[] {
  return (Object.keys(FRAMEWORKS) as Framework[]).filter((f) =>
    existsSync(path.join(projectRoot, FRAMEWORKS[f].entry)),
  );
}

/** Runs GUT or gdUnit4 headless and returns the parsed JUnit results. */
export class TestRunner {
  public constructor(
    private readonly godot: GodotExecutable,
    private readonly projectRoot: string,
  ) {}

  public async run(options: TestRunOptions): Promise<TestRunResult> {
    const started = Date.now();
    await this.godot.version();
    // Both frameworks rely on the global class cache; without an import they fail or silently
    // run nothing (GUT exits 0 without results), and new test classes wouldn't be found.
    await this.godot.exec(['--headless', '--path', this.projectRoot, '--import'], {
      cwd: this.projectRoot,
      timeoutMs: IMPORT_TIMEOUT_MS,
    });
    const work = mkdtempSync(path.join(tmpdir(), 'godotty-tests-'));
    try {
      const target = options.target ?? this.defaultTarget(options.framework);
      const { args, resultsFile } = this.command(options, target, work);
      const result = await this.godot.exec(args, {
        cwd: this.projectRoot,
        timeoutMs: options.timeoutMs,
      });
      const file = resultsFile();
      if (file === undefined) throw noResults(options, result);
      let suites = parseJUnit(readFileSync(file, 'utf8'));
      const filteredAfterRun = options.framework === 'gdunit4' && options.testName !== undefined;
      if (filteredAfterRun) suites = filterByName(suites, options.testName ?? '');
      return {
        framework: options.framework,
        target: target ?? `${RES_PREFIX}${GUT_CONFIG}`,
        suites,
        filteredAfterRun,
        loadErrors: scriptLoadErrors(result),
        durationMs: Date.now() - started,
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** res://test or res://tests if present; GUT with a .gutconfig.json uses its configured dirs. */
  private defaultTarget(framework: Framework): string | undefined {
    if (framework === 'gut' && existsSync(path.join(this.projectRoot, GUT_CONFIG)))
      return undefined;
    const dir = DEFAULT_TEST_DIRS.find((d) => existsSync(path.join(this.projectRoot, d)));
    return `${RES_PREFIX}${dir ?? ''}`;
  }

  private command(
    options: TestRunOptions,
    target: string | undefined,
    work: string,
  ): { args: string[]; resultsFile: () => string | undefined } {
    const base = [
      '--headless',
      '--path',
      this.projectRoot,
      ...(options.fixedFps === undefined ? [] : ['--fixed-fps', String(options.fixedFps)]),
      '-s',
      `${RES_PREFIX}${FRAMEWORKS[options.framework].entry}`,
    ];
    if (options.framework === 'gut') {
      const xml = path.join(work, 'results.xml');
      const selection =
        target === undefined
          ? []
          : target.endsWith('.gd')
            ? [`-gtest=${target}`]
            : [`-gdir=${target}`, '-ginclude_subdirs'];
      const name = options.testName === undefined ? [] : [`-gunit_test_name=${options.testName}`];
      return {
        args: [...base, '-gexit', `-gjunit_xml_file=${xml}`, ...selection, ...name],
        resultsFile: () => (existsSync(xml) ? xml : undefined),
      };
    }
    // -c: gdUnit4 stops at the first failing test unless told to continue.
    return {
      args: [...base, '-a', target ?? RES_PREFIX, '-c', '--ignoreHeadlessMode', '-rd', work],
      resultsFile: () => findResults(work),
    };
  }
}

const PARSE_ERROR_PREFIX = 'Parse Error: ';

/** Parse errors printed during the run, one per script location (Godot repeats them per load). */
export function scriptLoadErrors(result: ExecResult): GodotError[] {
  const seen = new Set<string>();
  return parseErrorBlocks(`${result.stdout}\n${result.stderr}`.split('\n')).filter((e) => {
    if (e.kind !== 'script' || !e.message.startsWith(PARSE_ERROR_PREFIX) || seen.has(errorKey(e)))
      return false;
    seen.add(errorKey(e));
    return true;
  });
}

/** gdUnit4 writes <report dir>/report_N/results.xml. */
function findResults(reportDir: string): string | undefined {
  const reports = readdirSync(reportDir)
    .filter((d) => d.startsWith('report_'))
    .sort((a, b) => Number(b.slice('report_'.length)) - Number(a.slice('report_'.length)));
  return reports.map((d) => path.join(reportDir, d, 'results.xml')).find((f) => existsSync(f));
}

function filterByName(suites: readonly TestSuite[], name: string): TestSuite[] {
  return suites
    .map((s) => {
      const cases = s.cases.filter((c) => c.name.includes(name));
      return { ...s, declared: cases.length, cases };
    })
    .filter((s) => s.cases.length > 0);
}

function noResults(options: TestRunOptions, result: ExecResult): ToolError {
  const label = FRAMEWORKS[options.framework].label;
  if (result.timedOut) {
    return new ToolError(
      ErrorCode.Timeout,
      `${label} did not finish within ${options.timeoutMs / MS_PER_SECOND}s and was stopped.`,
      'Raise timeout_s, or run a single file/test to find the one that hangs.',
    );
  }
  const output = `${result.stdout}\n${result.stderr}`.split('\n');
  const errors = parseErrorBlocks(output)
    .filter((e) => e.severity === 'error')
    .slice(0, STARTUP_ERRORS_SHOWN)
    .map(
      (e) =>
        `  - ${e.file === undefined ? '' : `${e.file}${e.line === undefined ? '' : `:${e.line}`} `}${e.message}`,
    );
  const tail = output
    .filter((l) => l.trim() !== '')
    .slice(-OUTPUT_TAIL_LINES)
    .map((l) => `  | ${l}`);
  const detail =
    errors.length > 0 ? `Errors:\n${errors.join('\n')}` : `Last output:\n${tail.join('\n')}`;
  return new ToolError(
    ErrorCode.GodotFailed,
    `${label} exited (code ${result.exitCode ?? '?'}) without writing results — no tests were reported.\n${detail}`,
    'Fix the errors above (often a parse error in a test script; run check_scripts), then run again.',
  );
}
