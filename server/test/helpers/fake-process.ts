import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** Minimal stand-in for a ChildProcess: write to stdout/stderr, then exit(). */
export class FakeProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly signals: string[] = [];
  public pid = 4242;
  /** When false, kill() records the signal but the process keeps running. */
  public diesOnKill = true;

  public kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.diesOnKill) this.exit(null, signal);
    return true;
  }

  public exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    // Real processes emit 'exit' then 'close' after stdio drains.
    setImmediate(() => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }

  public asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  /** Started behind the process guard; `command`/`args` are then Godot's, not the guard's. */
  guarded: boolean;
}

/** Splits `node -e <guard> -- <grace> <godot> <args...>` back into the Godot command line. */
function unwrapGuard(command: string, args: readonly string[]): Omit<SpawnCall, 'cwd' | 'env'> {
  if (command !== process.execPath || args[0] !== '-e' || args[2] !== '--') {
    return { command, args, guarded: false };
  }
  return { command: args[4] ?? '', args: args.slice(5), guarded: true };
}

/** A spawner that hands out scripted fake processes and records every call. */
export function fakeSpawner(onSpawn: (proc: FakeProcess, call: SpawnCall) => void): {
  spawner: (
    command: string,
    args: readonly string[],
    options: { cwd?: string | URL; env?: NodeJS.ProcessEnv },
  ) => ChildProcess;
  calls: SpawnCall[];
  processes: FakeProcess[];
} {
  const calls: SpawnCall[] = [];
  const processes: FakeProcess[] = [];
  return {
    calls,
    processes,
    spawner: (command, args, options) => {
      const proc = new FakeProcess();
      const call = {
        ...unwrapGuard(command, args),
        cwd: options.cwd?.toString(),
        env: options.env,
      };
      calls.push(call);
      processes.push(proc);
      setImmediate(() => {
        onSpawn(proc, call);
      });
      return proc.asChild();
    },
  };
}
