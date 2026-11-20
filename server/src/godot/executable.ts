import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { ErrorCode, ToolError } from '../util/errors.js';

export interface GodotVersion {
  major: number;
  minor: number;
  patch: number;
  /** e.g. "stable", "rc1", "dev". */
  status: string;
  /** Full `--version` output, e.g. "4.7.2.stable.official.ed1daf0bf". */
  full: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs: number;
}

/** Injectable process factory so tests can substitute fake Godot processes. */
export type Spawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export const MIN_GODOT = { major: 4, minor: 5 } as const;
/**
 * Set on every Godot process the server starts (headless LSP editor, --import, --doctool, tests,
 * games). The Godotty editor plugin stays offline when it sees it, so only the user's own editor
 * ever connects as "the editor".
 */
export const NO_EDITOR_BRIDGE_ENV = 'GODOTTY_NO_EDITOR_BRIDGE';
const VERSION_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 2_000;
const VERSION_PATTERN = /^(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+))?\.(?<status>[a-z0-9_]+)/i;
/** How much unexpected `--version` output to quote in an error. */
const OUTPUT_SNIPPET_CHARS = 100;

/** Parses `godot --version` output; returns undefined if it doesn't look like a Godot version. */
export function parseGodotVersion(output: string): GodotVersion | undefined {
  const full = output.trim().split('\n').pop()?.trim() ?? '';
  const groups = VERSION_PATTERN.exec(full)?.groups;
  if (groups === undefined) return undefined;
  return {
    major: Number(groups.major),
    minor: Number(groups.minor),
    patch: Number(groups.patch ?? 0),
    status: groups.status ?? '',
    full,
  };
}

export function formatVersion(v: GodotVersion): string {
  return `${v.major}.${v.minor}.${v.patch}.${v.status}`;
}

/** Wraps one Godot executable: version detection (cached) and process launching. */
export class GodotExecutable {
  private versionPromise: Promise<GodotVersion> | undefined;

  public constructor(
    public readonly path: string,
    private readonly spawner: Spawner = spawn,
  ) {}

  /** Detects and validates the Godot version once; later calls reuse the result. */
  public version(): Promise<GodotVersion> {
    this.versionPromise ??= this.detectVersion();
    // Don't cache failures: the user may fix the path or install Godot and retry.
    this.versionPromise.catch(() => {
      this.versionPromise = undefined;
    });
    return this.versionPromise;
  }

  /** Starts Godot with `args`; the caller owns the process. */
  public spawn(args: readonly string[], options: SpawnOptions = {}): ChildProcess {
    const env = { ...process.env, ...options.env, [NO_EDITOR_BRIDGE_ENV]: '1' };
    return this.spawner(this.path, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options, env });
  }

  /** Runs Godot to completion, collecting output; kills it after `timeoutMs`. */
  public exec(args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(args, options.cwd === undefined ? {} : { cwd: options.cwd });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => {
        timedOut = true;
        killGracefully(child);
      }, options.timeoutMs);
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(error.code === 'ENOENT' ? notFound(this.path) : error);
      });
      child.on('close', (exitCode: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode, timedOut });
      });
    });
  }

  private async detectVersion(): Promise<GodotVersion> {
    const result = await this.exec(['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
    const version = parseGodotVersion(result.stdout);
    if (version === undefined) {
      throw new ToolError(
        ErrorCode.GodotNotFound,
        `"${this.path}" did not report a Godot version (output: ${JSON.stringify(result.stdout.slice(0, OUTPUT_SNIPPET_CHARS))}).`,
        'Point --godot / GODOT_PATH at a Godot 4 editor executable.',
      );
    }
    if (version.major !== MIN_GODOT.major || version.minor < MIN_GODOT.minor) {
      throw new ToolError(
        ErrorCode.GodotNotFound,
        `Godot ${formatVersion(version)} is not supported; godotty-mcp needs ${MIN_GODOT.major}.${MIN_GODOT.minor} or newer 4.x.`,
        'Install a supported Godot 4 version and point --godot / GODOT_PATH at it.',
      );
    }
    return version;
  }
}

/** SIGTERM, then SIGKILL if the process hasn't exited after a grace period. */
export function killGracefully(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  timer.unref();
}

function notFound(path: string): ToolError {
  return new ToolError(
    ErrorCode.GodotNotFound,
    `Godot executable "${path}" was not found.`,
    'Pass --godot <path> or set GODOT_PATH to your Godot 4 executable (e.g. /Applications/Godot.app/Contents/MacOS/Godot).',
  );
}
