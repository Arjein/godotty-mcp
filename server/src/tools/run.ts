import { existsSync } from 'node:fs';

import { z } from 'zod';

import type { RunInfo } from '../godot/game.js';
import type { OutputLine } from '../godot/output-buffer.js';
import { ErrorCode, ToolError } from '../util/errors.js';
import { defineTool, textResult } from './registry.js';

const MS_PER_SECOND = 1000;
const DEFAULT_OUTPUT_LIMIT = 100;
const MAX_OUTPUT_LIMIT = 500;
const MAX_LINE_CHARS = 500;
const MAX_PATTERN_CHARS = 200;
const MAX_ARGS = 50;
const MAX_ARG_CHARS = 1000;
/** Arguments the server passes to the runtime helper; agents may not forge them. */
const RESERVED_ARG_PREFIX = '--godotty-';
const LEVEL_MARK = { info: ' ', warning: 'W', error: 'E' } as const;

/** One-line run summary shared by run/diagnostic tools. */
export function describeRun(run: RunInfo): string {
  const end = run.exit?.at ?? Date.now();
  const seconds = ((end - run.startedAt) / MS_PER_SECOND).toFixed(1);
  const state =
    run.state === 'exited'
      ? `exited with ${run.exit?.signal ?? `code ${run.exit?.code ?? '?'}`} after ${seconds}s`
      : `running for ${seconds}s, pid ${run.pid ?? '?'}`;
  return `Run #${run.id} (${run.scene ?? 'main scene'}, ${run.headless ? 'headless' : 'windowed'}; ${state})`;
}

export const runGame = defineTool({
  name: 'run_game',
  title: 'Run game',
  description:
    'Starts the game (main scene, or "scene") as a separate Godot process with the godotty runtime helper ' +
    'injected for this launch only (no project files are changed). Returns once the helper reports ready, ' +
    'or with the startup errors if the game crashes. Stops a previous run first. Windowed by default so it ' +
    'can be seen and screenshotted; headless=true runs without a window (no rendering). Then use ' +
    'get_output, get_errors, stop_game.',
  inputSchema: {
    scene: z.string().optional().describe('res:// scene to run instead of the main scene.'),
    args: z
      .array(z.string().max(MAX_ARG_CHARS))
      .max(MAX_ARGS)
      .default([])
      .describe('Extra user arguments for the game (OS.get_cmdline_user_args()).'),
    headless: z.boolean().default(false).describe('Run without a window or rendering.'),
    paused: z
      .boolean()
      .default(false)
      .describe(
        'Start frozen (after the main scene is ready, before its first frame); see pause_game / step_game.',
      ),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    const forged = args.args.find((a) => a.startsWith(RESERVED_ARG_PREFIX));
    if (forged !== undefined) {
      throw new ToolError(
        ErrorCode.InvalidInput,
        `"${forged}" is reserved for godotty-mcp.`,
        'Remove arguments starting with --godotty-.',
      );
    }
    let scene: string | undefined;
    if (args.scene !== undefined) {
      const file = ctx.sandbox.resolve(args.scene);
      scene = ctx.sandbox.toResPath(file);
      if (!existsSync(file)) {
        throw new ToolError(
          ErrorCode.NotFound,
          `Scene ${scene} does not exist.`,
          'Find scenes with list_files type="scene".',
        );
      }
    }
    const { run, stoppedPrevious } = await ctx.game.start({
      scene,
      args: args.args,
      headless: args.headless,
      paused: args.paused,
    });
    const lines = [
      `${stoppedPrevious ? 'Stopped the previous run. ' : ''}Started ${describeRun(run)}.`,
      run.helperReady
        ? 'Runtime helper: ready (errors are captured with backtraces).'
        : 'Runtime helper: did NOT report ready; errors come from stderr only. Check get_output.',
      ...(args.paused && run.helperReady
        ? [
            'Paused: step_game, send_input, wait or press_control advance it; pause_game paused=false resumes.',
          ]
        : []),
      'Next: get_output for logs, get_errors for errors, stop_game to end.',
    ];
    return textResult(lines.join('\n'));
  },
});

export const stopGame = defineTool({
  name: 'stop_game',
  title: 'Stop game',
  description:
    'Stops the game started with run_game (graceful terminate, then kill) and reports how it ended with ' +
    'a count of errors and warnings. Output and errors stay available until the next run_game.',
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (_args, ctx) => {
    const previous = ctx.game.run;
    if (previous === undefined) {
      throw new ToolError(
        ErrorCode.GameNotRunning,
        'No game has been started in this session.',
        'Start one with run_game.',
      );
    }
    const alreadyExited = previous.state === 'exited';
    const run = alreadyExited ? previous : await ctx.game.stop();
    const { errors } = ctx.game.errors();
    const errorCount = errors.filter((e) => e.error.severity === 'error').length;
    const prefix = alreadyExited ? 'The game had already exited' : 'Stopped';
    return textResult(
      `${prefix}: ${describeRun(run)}.\n${errorCount} unique error(s), ${errors.length - errorCount} unique warning(s)` +
        (errors.length > 0 ? ' — call get_errors for details.' : '.'),
    );
  },
});

export const getOutput = defineTool({
  name: 'get_output',
  title: 'Get game output',
  description:
    'Returns console output (stdout+stderr) of the current or last run, each line prefixed with its ' +
    'sequence number and level (E=error, W=warning). Without "since" returns the newest lines; pass ' +
    '"since" = the last sequence number you saw to get only new lines. Filter by level or by text.',
  inputSchema: {
    since: z.number().int().min(0).optional().describe('Only lines after this sequence number.'),
    filter: z
      .enum(['all', 'warnings', 'errors'])
      .default('all')
      .describe('"warnings" includes errors.'),
    contains: z
      .string()
      .max(MAX_PATTERN_CHARS)
      .optional()
      .describe('Only lines containing this text (case-insensitive).'),
    limit: z.number().int().min(1).max(MAX_OUTPUT_LIMIT).default(DEFAULT_OUTPUT_LIMIT),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (args, ctx) => {
    const page = ctx.game.output({
      since: args.since,
      filter: args.filter,
      contains: args.contains,
      limit: args.limit,
    });
    const header = `${describeRun(page.run)} — ${page.lines.length} of ${page.matched} matching line(s)`;
    const dropped = page.dropped > 0 ? ` (${page.dropped} oldest lines were discarded)` : '';
    const lastSeq = page.lines.at(-1)?.seq;
    const footer = lastSeq === undefined ? '' : `\nNext: since=${lastSeq}`;
    return Promise.resolve(
      textResult(`${header}${dropped}\n${page.lines.map(formatLine).join('\n')}${footer}`),
    );
  },
});

function formatLine(line: OutputLine): string {
  const text =
    line.text.length > MAX_LINE_CHARS ? `${line.text.slice(0, MAX_LINE_CHARS)}…` : line.text;
  return `${line.seq} ${LEVEL_MARK[line.level]}| ${text}`;
}
