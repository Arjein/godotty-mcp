import { appendFileSync } from 'node:fs';

import { EVENTS_ARG } from '../../src/godot/game.js';
import { fakeSpawner, type FakeProcess, type SpawnCall } from './fake-process.js';

export interface FakeGodotBehavior {
  version?: string;
  /** Called for game launches with the events file the runtime helper would write. */
  onGame?: (proc: FakeProcess, events: GameEvents, call: SpawnCall) => void;
  /** Called for `--check-only --script <res path>`; return stderr text. */
  onCheckOnly?: (resPath: string) => string;
  /** Called for `--headless --editor --lsp-port <port>`. */
  onEditor?: (proc: FakeProcess, port: number) => void;
}

/** Writes runtime-helper records exactly as godotty_runtime.gd would. */
export class GameEvents {
  public constructor(public readonly file: string) {}

  public ready(): void {
    this.write({ event: 'ready', protocol: 1, godot: '4.7.2-stable', pid: 1 });
  }

  public error(record: {
    type?: number;
    message: string;
    file?: string;
    line?: number;
    func?: string;
  }): void {
    this.write({
      event: 'error',
      type: record.type ?? 0,
      function: record.func ?? 'push_error',
      file: record.file ?? 'core/variant/variant_utility.cpp',
      line: record.line ?? 1,
      code: record.message,
      rationale: '',
      backtrace: [],
    });
  }

  public write(record: object): void {
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }
}

/** A spawner that behaves like the Godot CLI for the commands godotty-mcp issues. */
export function fakeGodot(behavior: FakeGodotBehavior = {}): ReturnType<typeof fakeSpawner> {
  return fakeSpawner((proc, call) => {
    const args = call.args;
    if (args.includes('--version')) {
      proc.stdout.write(`${behavior.version ?? '4.7.2.stable.official.ed1daf0bf'}\n`);
      proc.exit(0);
      return;
    }
    if (args.includes('--check-only')) {
      const resPath = args[args.indexOf('--script') + 1] ?? '';
      proc.stderr.write(behavior.onCheckOnly?.(resPath) ?? '');
      proc.exit(0);
      return;
    }
    if (args.includes('--lsp-port')) {
      behavior.onEditor?.(proc, Number(args[args.indexOf('--lsp-port') + 1]));
      return;
    }
    const eventsArg = args.find((a) => a.startsWith(EVENTS_ARG));
    if (eventsArg !== undefined) {
      behavior.onGame?.(proc, new GameEvents(eventsArg.slice(EVENTS_ARG.length)), call);
    }
  });
}
