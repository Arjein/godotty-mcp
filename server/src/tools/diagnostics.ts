import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { formatLocation, type ErrorSummary } from '../godot/game.js';
import type { ScriptDiagnostic } from '../godot/script-checker.js';
import { ErrorCode, ToolError } from '../util/errors.js';
import { walkProject } from '../util/files.js';
import { paginate } from '../util/paginate.js';
import { describeRun } from './run.js';
import { defineTool, textResult, type ToolContext } from './registry.js';

const DEFAULT_DIAGNOSTICS_LIMIT = 100;
const MAX_DIAGNOSTICS_LIMIT = 500;
const DEFAULT_ERRORS_LIMIT = 20;
const MAX_ERRORS_LIMIT = 200;
const BACKTRACE_FRAMES = 5;
const GDSCRIPT_EXT = '.gd';
const ADDONS_PREFIX = 'addons/';
const MAX_EXCLUDED_CODES = 50;
/** A warning code repeated this often in one file is shown as one grouped line. */
const GROUP_MIN = 3;
const GROUP_LINES_SHOWN = 12;
/** Godot's language server prefixes warnings with their code: "(UNUSED_SIGNAL): …". */
const WARNING_CODE = /^\(([A-Z_]+)\): /;

export const checkScripts = defineTool({
  name: 'check_scripts',
  title: 'Check scripts',
  description:
    "Reports GDScript parse/type errors and warnings with file:line:column, using Godot's own language " +
    "server (the open editor's if it has this project, otherwise a headless editor started on demand and " +
    'kept warm; per-file --check-only as last resort). Checks one .gd file or every .gd file under a folder ' +
    '(default: whole project, excluding addons/ unless the folder is inside addons). The first call may take ' +
    'a while if Godot needs to import the project.',
  inputSchema: {
    path: z.string().default('res://').describe('A .gd file or a folder (res:// path).'),
    include_warnings: z
      .boolean()
      .default(true)
      .describe('Include warnings (unused variables, unsafe casts, ...).'),
    exclude_codes: z
      .array(z.string().regex(/^[A-Za-z_]+$/))
      .max(MAX_EXCLUDED_CODES)
      .default([])
      .describe('Warning codes to leave out, e.g. ["UNUSED_SIGNAL"] (shown in each warning).'),
    limit: z.number().int().min(1).max(MAX_DIAGNOSTICS_LIMIT).default(DEFAULT_DIAGNOSTICS_LIMIT),
  },
  // Not read-only: it may start a headless editor, which runs the project's @tool scripts and
  // writes .godot/ caches.
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    const files = scriptsAt(ctx, args.path);
    if (files.length === 0) return textResult(`No GDScript files found under ${args.path}.`);
    const result = await ctx.checker.check(files);
    const excluded = new Set(args.exclude_codes.map((c) => c.toUpperCase()));
    const shown = result.diagnostics.filter((d) => args.include_warnings || d.severity === 'error');
    const diagnostics = shown.filter((d) => !excluded.has(warningCode(d) ?? ''));
    const text = formatDiagnostics(ctx, diagnostics, result.checked, result.source, args.limit);
    const hidden = shown.length - diagnostics.length;
    return textResult(
      hidden === 0 ? text : `${text}\n(${hidden} warning(s) excluded by exclude_codes.)`,
    );
  },
});

function scriptsAt(ctx: ToolContext, input: string): string[] {
  const target = ctx.sandbox.resolve(input);
  if (!existsSync(target)) {
    throw new ToolError(
      ErrorCode.NotFound,
      `${input} does not exist.`,
      'Find scripts with list_files type="script".',
    );
  }
  if (statSync(target).isFile()) {
    if (!target.endsWith(GDSCRIPT_EXT)) {
      throw new ToolError(
        ErrorCode.InvalidInput,
        `${input} is not a GDScript file.`,
        'Pass a .gd file or a folder.',
      );
    }
    return [target];
  }
  const insideAddons = ctx.sandbox.toResPath(target).startsWith(`res://${ADDONS_PREFIX}`);
  return walkProject(ctx.sandbox.root, target, { includeAddons: insideAddons })
    .filter((f) => f.endsWith(GDSCRIPT_EXT))
    .map((f) => path.join(ctx.sandbox.root, f));
}

function formatDiagnostics(
  ctx: ToolContext,
  diagnostics: readonly ScriptDiagnostic[],
  checked: number,
  source: string,
  limit: number,
): string {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const filesWithIssues = new Set(diagnostics.map((d) => d.file)).size;
  const summary =
    diagnostics.length === 0
      ? `No problems in ${checked} script(s) (checked with ${source}).`
      : `${errors} error(s), ${warnings} warning(s) in ${filesWithIssues} of ${checked} script(s) (checked with ${source}).`;
  const sorted = [...diagnostics].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || severityRank(a) - severityRank(b),
  );
  const page = paginate(sorted, { limit });
  const lines: string[] = [summary];
  const byFile = new Map<string, ScriptDiagnostic[]>();
  for (const d of page.items) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);
  for (const [file, items] of byFile) {
    lines.push(ctx.sandbox.toResPath(file), ...fileLines(items));
  }
  if (page.nextOffset !== undefined) {
    lines.push(
      `… ${page.total - page.items.length} more not shown; check a single file or folder, or raise "limit".`,
    );
  }
  return lines.join('\n');
}

/** One line per diagnostic, except warning codes repeated GROUP_MIN+ times: one line each. */
function fileLines(items: readonly ScriptDiagnostic[]): string[] {
  const counts = new Map<string, number>();
  for (const d of items) {
    const code = warningCode(d);
    if (code !== undefined) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const grouped = new Set<string>();
  const lines: string[] = [];
  for (const d of items) {
    const code = warningCode(d);
    if (code === undefined || (counts.get(code) ?? 0) < GROUP_MIN) {
      lines.push(
        `  ${d.line}${d.column === undefined ? '' : `:${d.column}`} ${d.severity}: ${d.message}`,
      );
      continue;
    }
    if (grouped.has(code)) continue;
    grouped.add(code);
    const same = items.filter((other) => warningCode(other) === code);
    const at = same.slice(0, GROUP_LINES_SHOWN).map((other) => other.line);
    const more = same.length > GROUP_LINES_SHOWN ? ', …' : '';
    lines.push(
      `  ${same.length}× ${d.severity} ${code} at lines ${at.join(', ')}${more}; first: ${d.message.replace(WARNING_CODE, '')}`,
    );
  }
  return lines;
}

function warningCode(d: ScriptDiagnostic): string | undefined {
  return d.severity === 'warning' ? WARNING_CODE.exec(d.message)?.[1] : undefined;
}

function severityRank(d: ScriptDiagnostic): number {
  return d.severity === 'error' ? 0 : 1;
}

export const getErrors = defineTool({
  name: 'get_errors',
  title: 'Get runtime errors',
  description:
    'Lists runtime errors and warnings from the current or last game run (started with run_game), ' +
    'de-duplicated with occurrence counts, each with its script location and GDScript backtrace. Captured ' +
    "through Godot's Logger API by the runtime helper, plus startup errors from stderr. For script " +
    'parse/type errors without running, use check_scripts.',
  inputSchema: {
    severity: z.enum(['all', 'errors', 'warnings']).default('all'),
    include_backtrace: z.boolean().default(true),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(MAX_ERRORS_LIMIT).default(DEFAULT_ERRORS_LIMIT),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (args, ctx) => {
    const { run, errors } = ctx.game.errors();
    const wanted = errors.filter(
      (e) =>
        args.severity === 'all' ||
        (args.severity === 'errors'
          ? e.error.severity === 'error'
          : e.error.severity === 'warning'),
    );
    const errorCount = errors.filter((e) => e.error.severity === 'error').length;
    const header = `${describeRun(run)} — ${errorCount} unique error(s), ${errors.length - errorCount} unique warning(s).`;
    if (wanted.length === 0) return Promise.resolve(textResult(header));
    const page = paginate(wanted, args);
    const body = page.items.map((e, i) =>
      formatErrorEntry(e, page.offset + i + 1, args.include_backtrace),
    );
    const more =
      page.nextOffset === undefined ? '' : `\nMore: call again with offset=${page.nextOffset}.`;
    return Promise.resolve(textResult([header, ...body].join('\n') + more));
  },
});

function formatErrorEntry(entry: ErrorSummary, index: number, includeBacktrace: boolean): string {
  const { error, count } = entry;
  const times = count > 1 ? ` ×${count}` : '';
  const inScript = error.function !== undefined && error.file?.startsWith('res://') === true;
  const where = inScript ? `in ${error.function ?? ''}(): ` : '';
  const lines = [
    `${index}. ${error.severity.toUpperCase()}${times} ${formatLocation(error)}${where}${error.message}`,
  ];
  if (includeBacktrace && error.backtrace.length > 1) {
    const frames = error.backtrace
      .slice(0, BACKTRACE_FRAMES)
      .map((f) => `${f.function} (${f.file}:${f.line})`);
    lines.push(
      `   backtrace: ${frames.join(' ← ')}${error.backtrace.length > BACKTRACE_FRAMES ? ' ← …' : ''}`,
    );
  }
  return lines.join('\n');
}
