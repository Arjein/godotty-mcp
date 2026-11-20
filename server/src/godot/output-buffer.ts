import { nextLevel, type LogLevel } from './godot-log.js';

export type Stream = 'stdout' | 'stderr';

/** Fraction above capacity the buffer may grow before it is trimmed back. */
const TRIM_SLACK = 0.1;

export interface OutputLine {
  /** Monotonic per run, starting at 1; used as a cursor by get_output. */
  seq: number;
  stream: Stream;
  level: LogLevel;
  text: string;
}

export type LevelFilter = 'all' | 'warnings' | 'errors';

export interface OutputQuery {
  /** Return lines with seq greater than this. When omitted, the newest matching lines are returned. */
  since?: number | undefined;
  filter: LevelFilter;
  pattern?: RegExp | undefined;
  limit: number;
}

export interface OutputPage {
  lines: OutputLine[];
  /** Total matching lines available for the query (before `limit`). */
  matched: number;
  /** Lines discarded because the buffer was full. */
  dropped: number;
}

/** Keeps the most recent `capacity` lines of a process's output, split per stream. */
export class OutputBuffer {
  private readonly lines: OutputLine[] = [];
  private readonly partial: Record<Stream, string> = { stdout: '', stderr: '' };
  private readonly lastLevel: Record<Stream, LogLevel> = { stdout: 'info', stderr: 'info' };
  private seq = 0;
  private droppedCount = 0;

  public constructor(private readonly capacity: number) {}

  /** Appends a raw chunk; complete lines are stored, a trailing partial line waits for more. */
  public push(stream: Stream, chunk: string): void {
    const parts = (this.partial[stream] + chunk).split('\n');
    this.partial[stream] = parts.pop() ?? '';
    for (const part of parts) this.add(stream, part.replace(/\r$/, ''));
  }

  /** Flushes partial lines (call when the process exits). */
  public end(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.partial[stream] !== '') this.add(stream, this.partial[stream]);
      this.partial[stream] = '';
    }
  }

  public get lastSeq(): number {
    return this.seq;
  }

  public all(): readonly OutputLine[] {
    return this.lines;
  }

  public query(query: OutputQuery): OutputPage {
    const matching = this.lines.filter(
      (line) =>
        (query.since === undefined || line.seq > query.since) &&
        passesFilter(line.level, query.filter) &&
        (query.pattern === undefined || query.pattern.test(line.text)),
    );
    const lines =
      query.since === undefined ? matching.slice(-query.limit) : matching.slice(0, query.limit);
    return { lines, matched: matching.length, dropped: this.droppedCount };
  }

  private add(stream: Stream, text: string): void {
    const level = nextLevel(text, this.lastLevel[stream]);
    this.lastLevel[stream] = level;
    this.lines.push({ seq: ++this.seq, stream, level, text });
    // Trim in batches so a chatty game doesn't pay an O(n) shift on every line.
    if (this.lines.length > this.capacity + Math.ceil(this.capacity * TRIM_SLACK)) {
      const excess = this.lines.length - this.capacity;
      this.lines.splice(0, excess);
      this.droppedCount += excess;
    }
  }
}

function passesFilter(level: LogLevel, filter: LevelFilter): boolean {
  if (filter === 'errors') return level === 'error';
  if (filter === 'warnings') return level !== 'info';
  return true;
}
