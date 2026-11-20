/** Structured view of Godot's console error/warning output and of runtime-helper error records. */

export type Severity = 'error' | 'warning';
export type LogLevel = 'info' | Severity;

export interface StackFrame {
  function: string;
  file: string;
  line: number;
}

export interface GodotError {
  severity: Severity;
  /** "script" (GDScript), "shader", or "engine" (C++ / push_error). */
  kind: 'script' | 'shader' | 'engine';
  message: string;
  /** Best user-facing location: the first res:// frame when the reported one is engine C++. */
  file: string | undefined;
  line: number | undefined;
  function: string | undefined;
  backtrace: StackFrame[];
}

const HEADER =
  /^(USER SCRIPT ERROR|SCRIPT ERROR|USER ERROR|ERROR|SHADER ERROR|USER WARNING|WARNING): ?(.*)$/;
const AT_LINE = /^\s+at: (?<fn>[^(]*) \((?<file>[^()]*):(?<line>\d+)\)\s*$/;
const FRAME_LINE = /^\s+\[\d+\] (?<fn>[^(]*) \((?<file>[^()]*):(?<line>\d+)\)\s*$/;
/** Longer lines (from a game's own output) are cut before regex matching. */
const MAX_MATCHED_LINE = 4_000;
const CONTINUATION = /^\s/;
const RES_PREFIX = 'res://';

/**
 * Assigns a level to each output line. Error/warning headers set the level; indented continuation
 * lines (`at:`, backtraces) inherit it; anything else is info.
 */
export function classifyLines(lines: readonly string[]): LogLevel[] {
  let current: LogLevel = 'info';
  return lines.map((line) => (current = nextLevel(line, current)));
}

/** Level of `line` given the level of the line before it on the same stream. */
export function nextLevel(raw: string, previous: LogLevel): LogLevel {
  const line = raw.length > MAX_MATCHED_LINE ? raw.slice(0, MAX_MATCHED_LINE) : raw;
  const header = HEADER.exec(line);
  if (header !== null) return headerSeverity(header[1] ?? '');
  return CONTINUATION.test(line) && line.trim() !== '' ? previous : 'info';
}

/** Extracts error/warning blocks (header + `at:` + backtrace) from console output lines. */
export function parseErrorBlocks(lines: readonly string[]): GodotError[] {
  const errors: GodotError[] = [];
  let block:
    | { label: string; message: string; at: StackFrame | undefined; frames: StackFrame[] }
    | undefined;
  const flush = (): void => {
    if (block !== undefined)
      errors.push(blockToError(block.label, block.message, block.at, block.frames));
    block = undefined;
  };
  for (const raw of lines) {
    const line = raw.length > MAX_MATCHED_LINE ? raw.slice(0, MAX_MATCHED_LINE) : raw;
    const header = HEADER.exec(line);
    if (header !== null) {
      flush();
      block = { label: header[1] ?? '', message: header[2] ?? '', at: undefined, frames: [] };
      continue;
    }
    if (block === undefined || !CONTINUATION.test(line)) {
      flush();
      continue;
    }
    const frame = toFrame(FRAME_LINE.exec(line));
    if (frame !== undefined) {
      block.frames.push(frame);
    } else {
      block.at ??= toFrame(AT_LINE.exec(line));
    }
  }
  flush();
  return errors;
}

function toFrame(match: RegExpExecArray | null): StackFrame | undefined {
  const g = match?.groups;
  if (g === undefined) return undefined;
  return { function: g.fn ?? '', file: g.file ?? '', line: Number(g.line) };
}

function headerSeverity(header: string): Severity {
  return header.includes('WARNING') ? 'warning' : 'error';
}

function blockToError(
  label: string,
  message: string,
  at: StackFrame | undefined,
  frames: StackFrame[],
): GodotError {
  const kind = label.includes('SCRIPT') ? 'script' : label.includes('SHADER') ? 'shader' : 'engine';
  return withUserLocation({
    severity: headerSeverity(label),
    kind,
    message,
    function: at?.function,
    file: at?.file,
    line: at?.line,
    backtrace: frames,
  });
}

/**
 * Engine errors raised from scripts (push_error, failed engine calls) report a C++ location; the
 * useful location for an agent is the first script frame, so promote it when available.
 */
export function withUserLocation(error: GodotError): GodotError {
  if (error.file?.startsWith(RES_PREFIX) === true) return error;
  const frame = error.backtrace.find((f) => f.file.startsWith(RES_PREFIX));
  if (frame === undefined) return error;
  return { ...error, file: frame.file, line: frame.line, function: frame.function };
}

/** Logger.ErrorType values (see Godot's Logger class). */
const LOGGER_ERROR_TYPES: Readonly<
  Record<number, { severity: Severity; kind: GodotError['kind'] }>
> = {
  0: { severity: 'error', kind: 'engine' },
  1: { severity: 'warning', kind: 'engine' },
  2: { severity: 'error', kind: 'script' },
  3: { severity: 'error', kind: 'shader' },
};

/** One JSON line written by the runtime helper's Logger. */
export interface LoggerRecord {
  type: number;
  function: string;
  file: string;
  line: number;
  code: string;
  rationale: string;
  backtrace: StackFrame[];
}

/** Converts a runtime-helper Logger record into the common error shape. */
export function loggerRecordToError(record: LoggerRecord): GodotError {
  const mapped = LOGGER_ERROR_TYPES[record.type] ?? {
    severity: 'error' as const,
    kind: 'engine' as const,
  };
  // Godot puts the human message in `rationale` when set (e.g. ERR_FAIL_COND_MSG), else in `code`.
  const message = record.rationale !== '' ? record.rationale : record.code;
  return withUserLocation({
    ...mapped,
    message,
    file: record.file,
    line: record.line,
    function: record.function,
    backtrace: record.backtrace,
  });
}

/** Stable identity for de-duplication: same message at the same place counts as one error. */
export function errorKey(error: GodotError): string {
  return `${error.severity}|${error.message}|${error.file ?? ''}:${error.line ?? ''}`;
}
