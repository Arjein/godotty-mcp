import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { BridgeServer } from '../bridge/bridge-server.js';
import { ErrorCode, ToolError } from '../util/errors.js';
import { killGracefully, type GodotExecutable } from './executable.js';
import {
  errorKey,
  loggerRecordToError,
  parseErrorBlocks,
  type GodotError,
  type LoggerRecord,
} from './godot-log.js';
import { OutputBuffer, type OutputPage, type OutputQuery } from './output-buffer.js';
import { STATE_DIR, type RuntimeInjection } from './runtime-injection.js';

export interface RunOptions {
  /** res:// scene to run instead of the main scene. */
  scene?: string | undefined;
  /** Passed to the game after `--` (read with OS.get_cmdline_user_args()). */
  args: readonly string[];
  headless: boolean;
}

export type RunState = 'starting' | 'running' | 'exited';

export interface RunInfo {
  id: number;
  pid: number | undefined;
  scene: string | undefined;
  headless: boolean;
  state: RunState;
  /** Whether the runtime helper reported ready (needed for screenshots/input/inspection). */
  helperReady: boolean;
  startedAt: number;
  exit: { code: number | null; signal: string | null; at: number } | undefined;
}

export interface ErrorSummary {
  error: GodotError;
  count: number;
}

export interface GameManagerOptions {
  godot: GodotExecutable;
  projectRoot: string;
  injection: RuntimeInjection;
  /** When set, the game's runtime helper connects back to it (screenshots, input, inspection). */
  bridge?: BridgeServer | undefined;
  readyTimeoutMs?: number;
  outputCapacity?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_CAPACITY = 20_000;
const READY_POLL_MS = 100;
const EXIT_WAIT_MS = 5_000;
const RUNS_KEPT = 5;
/** Errors quoted in a startup-crash message; the rest are one get_errors call away. */
const STARTUP_ERRORS_SHOWN = 3;
export const EVENTS_ARG = '--godotty-events=';
export const PORT_ARG = '--godotty-port=';
/** Passed via the environment, not argv, so other local users can't read it from `ps`. */
export const TOKEN_ENV = 'GODOTTY_BRIDGE_TOKEN';

interface Run extends RunInfo {
  process: ChildProcess;
  output: OutputBuffer;
  eventsFile: string;
  exited: Promise<void>;
}

/** Launches and supervises one game process at a time. */
export class GameManager {
  private current: Run | undefined;
  private nextId = 1;
  private readonly runsDir: string;

  public constructor(private readonly options: GameManagerOptions) {
    this.runsDir = path.join(options.projectRoot, STATE_DIR, 'runs');
  }

  /** The current run, or the last one after it exited. */
  public get run(): RunInfo | undefined {
    return this.current === undefined ? undefined : snapshot(this.current);
  }

  public get isRunning(): boolean {
    return this.current !== undefined && this.current.state !== 'exited';
  }

  /**
   * Starts the game and waits until the runtime helper reports ready, the process exits, or the
   * ready timeout passes. Stops a previous run first.
   */
  public async start(options: RunOptions): Promise<{ run: RunInfo; stoppedPrevious: boolean }> {
    const stoppedPrevious = this.isRunning;
    if (stoppedPrevious) await this.stop();
    await this.options.godot.version();
    const bridge = await this.bridgeArgs();
    const run = this.launch(options, bridge);
    try {
      await this.waitForReady(run);
    } finally {
      this.options.injection.restore();
    }
    if (run.state === 'exited' && !run.helperReady) {
      throw this.launchFailure(run);
    }
    return { run: snapshot(run), stoppedPrevious };
  }

  /** Stops the running game (SIGTERM, then SIGKILL). Returns the final run info. */
  public async stop(): Promise<RunInfo> {
    const run = this.current;
    if (run === undefined || run.state === 'exited') {
      throw new ToolError(
        ErrorCode.GameNotRunning,
        'No game is running.',
        'Start one with run_game.',
      );
    }
    killGracefully(run.process);
    await Promise.race([run.exited, delay(EXIT_WAIT_MS)]);
    return snapshot(run);
  }

  public output(query: OutputQuery): OutputPage & { run: RunInfo } {
    const run = this.requireRun();
    return { ...run.output.query(query), run: snapshot(run) };
  }

  /** Errors and warnings of the current/last run, de-duplicated, in first-seen order. */
  public errors(): { run: RunInfo; errors: ErrorSummary[] } {
    const run = this.requireRun();
    const fromHelper = summarize(readLoggerRecords(run.eventsFile).map(loggerRecordToError));
    // Godot prints every error to stderr too, so stderr only contributes errors the helper never
    // saw (raised before it loaded, or when it failed to load). Counts come from the helper.
    const seen = new Set(fromHelper.map((e) => errorKey(e.error)));
    const stderrLines = run.output
      .all()
      .filter((l) => l.stream === 'stderr')
      .map((l) => l.text);
    const stderrOnly = summarize(parseErrorBlocks(stderrLines)).filter(
      (e) => !seen.has(errorKey(e.error)),
    );
    return { run: snapshot(run), errors: [...stderrOnly, ...fromHelper] };
  }

  /** Kills the game and restores the project (server shutdown). */
  public dispose(): void {
    if (this.current !== undefined && this.current.state !== 'exited')
      killGracefully(this.current.process);
    this.options.injection.restore();
  }

  private requireRun(): Run {
    if (this.current === undefined) {
      throw new ToolError(
        ErrorCode.GameNotRunning,
        'The game has not been run yet in this session.',
        'Start it with run_game.',
      );
    }
    return this.current;
  }

  /** Port argument and token environment for the runtime helper's bridge connection. */
  private async bridgeArgs(): Promise<{ args: string[]; env: Record<string, string> }> {
    const bridge = this.options.bridge;
    if (bridge === undefined) return { args: [], env: {} };
    // A helper from a previous run must never answer for the new one.
    bridge.peer('runtime')?.close();
    const port = await bridge.listen();
    return { args: [`${PORT_ARG}${port}`], env: { [TOKEN_ENV]: bridge.token } };
  }

  private launch(
    options: RunOptions,
    bridge: { args: string[]; env: Record<string, string> },
  ): Run {
    mkdirSync(this.runsDir, { recursive: true });
    pruneRuns(this.runsDir);
    const id = this.nextId++;
    const eventsFile = path.join(this.runsDir, `run-${Date.now()}-${id}.jsonl`);
    this.options.injection.inject();
    const args = [
      '--path',
      this.options.projectRoot,
      ...(options.headless ? ['--headless'] : []),
      ...(options.scene === undefined ? [] : [options.scene]),
      '--',
      `${EVENTS_ARG}${eventsFile}`,
      ...bridge.args,
      ...options.args,
    ];
    const child = this.options.godot.spawn(args, {
      cwd: this.options.projectRoot,
      env: { ...process.env, ...bridge.env },
    });
    const output = new OutputBuffer(this.options.outputCapacity ?? DEFAULT_OUTPUT_CAPACITY);
    let markExited = (): void => undefined;
    const run: Run = {
      id,
      pid: child.pid,
      scene: options.scene,
      headless: options.headless,
      state: 'starting',
      helperReady: false,
      startedAt: Date.now(),
      exit: undefined,
      process: child,
      output,
      eventsFile,
      exited: new Promise((resolve) => (markExited = resolve)),
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      output.push('stdout', chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output.push('stderr', chunk.toString());
    });
    child.on('error', (error) => {
      output.push('stderr', `ERROR: failed to start Godot: ${error.message}\n`);
    });
    child.on('close', (code: number | null, signal: string | null) => {
      output.end();
      run.state = 'exited';
      run.exit = { code, signal, at: Date.now() };
      markExited();
    });
    this.current = run;
    return run;
  }

  private async waitForReady(run: Run): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    while (Date.now() < deadline && run.state !== 'exited') {
      if (helperReported(run.eventsFile)) {
        run.helperReady = true;
        run.state = 'running';
        return;
      }
      await Promise.race([run.exited, delay(READY_POLL_MS)]);
    }
    if (run.state !== 'exited') run.state = 'running';
  }

  private launchFailure(run: Run): ToolError {
    const errors = summarize(
      parseErrorBlocks(
        run.output
          .all()
          .filter((l) => l.stream === 'stderr')
          .map((l) => l.text),
      ),
    );
    const top = errors
      .filter((e) => e.error.severity === 'error')
      .slice(0, STARTUP_ERRORS_SHOWN)
      .map((e) => `  - ${formatLocation(e.error)}${e.error.message}`)
      .join('\n');
    const exit = run.exit?.code ?? run.exit?.signal ?? 'unknown';
    return new ToolError(
      ErrorCode.GodotFailed,
      `The game exited during startup (exit ${exit}).${top === '' ? '' : `\n${top}`}`,
      'Fix the errors above, or call get_errors / get_output for the full log.',
    );
  }
}

/** Groups identical errors (same message and location), keeping first-seen order. */
export function summarize(errors: readonly GodotError[]): ErrorSummary[] {
  const byKey = new Map<string, ErrorSummary>();
  for (const error of errors) {
    const key = errorKey(error);
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, { error, count: 1 });
    else existing.count++;
  }
  return [...byKey.values()];
}

export function formatLocation(error: GodotError): string {
  if (error.file === undefined) return '';
  return `${error.file}${error.line === undefined ? '' : `:${error.line}`} `;
}

function snapshot(run: Run): RunInfo {
  const { id, pid, scene, headless, state, helperReady, startedAt, exit } = run;
  return { id, pid, scene, headless, state, helperReady, startedAt, exit };
}

function readEvents(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (line.trim() === '') return [];
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return []; // A line being written while we read; it will be complete next time.
      }
    });
}

function helperReported(file: string): boolean {
  return readEvents(file).some((e) => e.event === 'ready');
}

function readLoggerRecords(file: string): LoggerRecord[] {
  return readEvents(file).filter((e) => e.event === 'error') as unknown as LoggerRecord[];
}

/** Deletes old events files, keeping the most recent few for debugging. */
function pruneRuns(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  for (const file of files.slice(0, Math.max(0, files.length - RUNS_KEPT))) {
    rmSync(path.join(dir, file), { force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
