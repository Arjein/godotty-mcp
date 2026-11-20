import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type {
  GetPropsParams,
  GetPropsResult,
  InputStep,
  TreeNode,
  TreeParams,
  TreeResult,
} from '../bridge/protocol.js';
import { ErrorCode, ToolError } from '../util/errors.js';
import { assertSafeLiterals } from '../util/literals.js';
import { defineTool, textResult, type ToolContext } from './registry.js';

const DEFAULT_MAX_SIZE = 960;
const MIN_MAX_SIZE = 64;
const MAX_MAX_SIZE = 2048;
const MAX_FRAMES = 8;
const DEFAULT_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 10_000;
const MAX_STEPS = 100;
const MAX_DURATION_MS = 30_000;
const DEFAULT_TIMEOUT_S = 10;
const MAX_TIMEOUT_S = 120;
const DEFAULT_TREE_DEPTH = 4;
const MAX_TREE_DEPTH = 20;
const DEFAULT_TREE_NODES = 150;
const MAX_TREE_NODES = 1000;
const DEFAULT_PROPS = 60;
const MAX_PROPS = 400;
const MS_PER_SECOND = 1000;
const MAX_PATH_CHARS = 1000;
const MAX_NAME_CHARS = 200;
const MAX_LITERAL_CHARS = 10_000;
/** Slack on top of the time a command needs (frame waits, encoding, transfer). */
const COMMAND_SLACK_MS = 15_000;
/** Assumed duration of a tap/release step when estimating timeouts. */
const STEP_ESTIMATE_MS = 100;

const nodePath = z
  .string()
  .max(MAX_PATH_CHARS)
  .describe(
    'Node path: absolute ("/root/Main/Player") or relative to the current scene ("Player", "." = scene root).',
  );

const target = z
  .enum(['game', 'editor'])
  .default('game')
  .describe(
    '"game" = the running game; "editor" = the scene open in the Godot editor (needs the Godotty addon).',
  );

type Target = 'game' | 'editor';

/** tree/get_props exist on both peers with identical shapes; route to the requested one. */
function fetchTree(ctx: ToolContext, where: Target, params: TreeParams): Promise<TreeResult> {
  return where === 'editor'
    ? ctx.editor.call('tree', params, COMMAND_SLACK_MS)
    : ctx.runtime.call('tree', params, COMMAND_SLACK_MS);
}

function fetchProps(
  ctx: ToolContext,
  where: Target,
  params: GetPropsParams,
): Promise<GetPropsResult> {
  return where === 'editor'
    ? ctx.editor.call('get_props', params, COMMAND_SLACK_MS)
    : ctx.runtime.call('get_props', params, COMMAND_SLACK_MS);
}

/** Image content for MCP. */
function image(data: string): CallToolResult['content'][number] {
  return { type: 'image', data, mimeType: 'image/png' };
}

async function capture(
  ctx: ToolContext,
  maxSize: number,
  count = 1,
  intervalMs = 0,
): Promise<{ text: string; images: string[] }> {
  const result = await ctx.runtime.call(
    'screenshot',
    { max_size: maxSize, count, interval_ms: intervalMs },
    COMMAND_SLACK_MS + count * intervalMs,
  );
  const what = count === 1 ? 'Screenshot' : `${count} frames, ${intervalMs} ms apart`;
  return {
    text: `${what} (${result.width}×${result.height}) of run #${ctx.game.run?.id ?? '?'}.`,
    images: result.frames,
  };
}

export const screenshot = defineTool({
  name: 'screenshot',
  title: 'Screenshot',
  description:
    'Captures what the running game renders (needs run_game with headless=false) and returns it as an ' +
    'image, scaled so its longest side is at most max_size. Use count + interval_ms to capture a short ' +
    'sequence (e.g. to check an animation or movement). Larger images cost more context.',
  inputSchema: {
    max_size: z
      .number()
      .int()
      .min(MIN_MAX_SIZE)
      .max(MAX_MAX_SIZE)
      .default(DEFAULT_MAX_SIZE)
      .describe('Longest side in pixels.'),
    count: z.number().int().min(1).max(MAX_FRAMES).default(1).describe('Number of frames.'),
    interval_ms: z
      .number()
      .int()
      .min(0)
      .max(MAX_INTERVAL_MS)
      .default(DEFAULT_INTERVAL_MS)
      .describe('Delay between frames.'),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    const shot = await capture(ctx, args.max_size, args.count, args.interval_ms);
    return { content: [{ type: 'text', text: shot.text }, ...shot.images.map(image)] };
  },
});

// Semantics of mode/duration_ms/position are explained once in the tool description; describing
// them on these shared schemas would repeat the text in every step variant of the JSON schema.
const holdMode = z.enum(['tap', 'press', 'release', 'hold']).default('tap');
const duration = z.number().int().min(0).max(MAX_DURATION_MS).optional();
const position = z.tuple([z.number(), z.number()]);

const stepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('action'),
    action: z.string().describe('InputMap action, e.g. "jump" (see project_info).'),
    mode: holdMode,
    duration_ms: duration,
    strength: z.number().min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal('key'),
    key: z.string().describe('Godot key name, e.g. "A", "Space", "Enter", "Escape", "Left".'),
    mode: holdMode,
    duration_ms: duration,
    shift: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    alt: z.boolean().optional(),
    meta: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('mouse_button'),
    button: z.enum(['left', 'right', 'middle', 'wheel_up', 'wheel_down']),
    position,
    mode: holdMode,
    duration_ms: duration,
    double_click: z.boolean().optional(),
  }),
  z.object({ type: z.literal('mouse_motion'), position }),
  z.object({
    type: z.literal('wait'),
    ms: z.number().int().min(0).max(MAX_DURATION_MS).optional(),
    frames: z.number().int().min(0).max(MAX_DURATION_MS).optional(),
  }),
]);

export const sendInput = defineTool({
  name: 'send_input',
  title: 'Send input',
  description:
    "Plays input steps in the running game, in order, with real timing; events go through Godot's input " +
    'pipeline like real devices. Step types: action (InputMap name; best choice, e.g. "jump"), key (Godot ' +
    'key name: "A", "Space", "Escape", "Left"), mouse_button (position = viewport pixels [x, y]), ' +
    'mouse_motion, wait (ms or frames). mode: tap (default: press, release 2 physics frames later), press, ' +
    'release, or hold (press, wait duration_ms, default 500, release). Example: [{"type":"action",' +
    '"action":"move_right","mode":"hold","duration_ms":800},{"type":"action","action":"jump"}]. ' +
    'screenshot_after returns an image of the result.',
  inputSchema: {
    steps: z.array(stepSchema).min(1).max(MAX_STEPS),
    screenshot_after: z
      .boolean()
      .default(false)
      .describe('Return a screenshot after the last step (windowed runs only).'),
    max_size: z.number().int().min(MIN_MAX_SIZE).max(MAX_MAX_SIZE).default(DEFAULT_MAX_SIZE),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    const steps = args.steps as InputStep[];
    const result = await ctx.runtime.call('input', { steps }, COMMAND_SLACK_MS + estimateMs(steps));
    const text = `Performed ${result.steps} step(s) in ${result.elapsed_ms} ms (${result.frames} frames).`;
    if (!args.screenshot_after) return textResult(text);
    const shot = await capture(ctx, args.max_size);
    return {
      content: [{ type: 'text', text: `${text}\n${shot.text}` }, ...shot.images.map(image)],
    };
  },
});

function estimateMs(steps: readonly InputStep[]): number {
  return steps.reduce((total, step) => {
    if (step.type === 'wait') return total + (step.ms ?? 0) + (step.frames ?? 0) * STEP_ESTIMATE_MS;
    if ('duration_ms' in step && step.duration_ms !== undefined) return total + step.duration_ms;
    return total + STEP_ESTIMATE_MS;
  }, 0);
}

export const wait = defineTool({
  name: 'wait',
  title: 'Wait in game',
  description:
    'Waits inside the running game: a number of frames, a number of seconds, or until a condition holds ' +
    '(a node exists, or a node property compares to a value), then reports how long it took. Prefer a ' +
    'condition over fixed sleeps, e.g. node="Player", property="position:y", op="<", value="0.6".',
  inputSchema: {
    frames: z.number().int().min(1).max(MAX_DURATION_MS).optional(),
    seconds: z.number().min(0).max(MAX_TIMEOUT_S).optional(),
    node: nodePath
      .optional()
      .describe('Wait until this node exists (and, with property, until the condition holds).'),
    property: z
      .string()
      .max(MAX_NAME_CHARS)
      .optional()
      .describe('Property or sub-property, e.g. "visible", "position:x".'),
    op: z.enum(['==', '!=', '<', '<=', '>', '>=']).default('=='),
    value: z
      .string()
      .max(MAX_LITERAL_CHARS)
      .optional()
      .describe('Godot literal to compare with, e.g. "true", "3.5", "Vector2(0, 0)".'),
    timeout_s: z
      .number()
      .min(0)
      .max(MAX_TIMEOUT_S)
      .default(DEFAULT_TIMEOUT_S)
      .describe('Give up on the condition after this long.'),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    const modes = [args.frames, args.seconds, args.node].filter((v) => v !== undefined).length;
    if (modes !== 1) {
      throw new ToolError(
        ErrorCode.InvalidInput,
        'Pass exactly one of frames, seconds, or node.',
        'For a property condition pass node + property (+ op/value).',
      );
    }
    assertSafeLiterals([args.value], ctx.config.allowEval);
    const until =
      args.node === undefined
        ? undefined
        : { node: args.node, property: args.property, op: args.op, value: args.value };
    const budgetS = args.seconds ?? (until === undefined ? 0 : args.timeout_s);
    const result = await ctx.runtime.call(
      'wait',
      { frames: args.frames, seconds: args.seconds, until, timeout_s: args.timeout_s },
      COMMAND_SLACK_MS + budgetS * MS_PER_SECOND + (args.frames ?? 0) * STEP_ESTIMATE_MS,
    );
    const took = `${(result.elapsed_ms / MS_PER_SECOND).toFixed(2)}s (${result.frames} frames)`;
    const value =
      result.last_value === undefined ? '' : `; ${args.property ?? ''} = ${result.last_value}`;
    if (until === undefined) return textResult(`Waited ${took}.`);
    return textResult(
      result.met
        ? `Condition met after ${took}${value}.`
        : `Timed out after ${took}; condition not met${value}.`,
    );
  },
});

export const inspectSceneTree = defineTool({
  name: 'inspect_scene_tree',
  title: 'Inspect scene tree',
  description:
    "Shows a live node tree: the running game's (target=game: autoloads, nodes created at runtime) or the " +
    'scene open in the Godot editor, including unsaved edits (target=editor). Each node: name, class, ' +
    'script, and a short state summary (position, visibility, text). Depth- and size-limited; start deeper ' +
    'with "node". For scene files on disk use read_scene.',
  inputSchema: {
    target: target,
    node: nodePath
      .default('')
      .describe('Start node; "" = the whole tree (game: /root, editor: scene root).'),
    depth: z.number().int().min(0).max(MAX_TREE_DEPTH).default(DEFAULT_TREE_DEPTH),
    max_nodes: z.number().int().min(1).max(MAX_TREE_NODES).default(DEFAULT_TREE_NODES),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    const result = await fetchTree(ctx, args.target, {
      path: args.node,
      depth: args.depth,
      max_nodes: args.max_nodes,
    });
    const lines = [
      args.target === 'editor'
        ? `Editor scene ${result.current_scene || '(never saved)'} at ${result.path}`
        : `Live tree at ${result.path} (current scene: ${result.current_scene || 'none'})`,
    ];
    renderTree(result.root, '', '', lines);
    if (result.truncated)
      lines.push(
        `… stopped at ${args.max_nodes} nodes; raise max_nodes or start from a deeper node.`,
      );
    return textResult(lines.join('\n'));
  },
});

function renderTree(node: TreeNode, prefix: string, childPrefix: string, lines: string[]): void {
  const extras = [node.script === undefined ? '' : `script=${node.script}`, node.info ?? ''].filter(
    (e) => e !== '',
  );
  lines.push(
    `${prefix}${node.name} (${node.class})${extras.length > 0 ? `  ${extras.join('  ')}` : ''}`,
  );
  const children = node.children ?? [];
  children.forEach((child, i) => {
    const last = i === children.length - 1 && node.hidden_children === undefined;
    renderTree(
      child,
      childPrefix + (last ? '└─ ' : '├─ '),
      childPrefix + (last ? '   ' : '│  '),
      lines,
    );
  });
  if (node.hidden_children !== undefined)
    lines.push(`${childPrefix}└─ … ${node.hidden_children} more children`);
}

export const getNodeProperties = defineTool({
  name: 'get_node_properties',
  title: 'Get node properties',
  description:
    'Reads property values of a node in the running game (target=game) or in the scene open in the editor ' +
    '(target=editor). Pass "properties" for specific ones (sub-properties ' +
    'like "position:x" work), or list the inspector-visible and script properties, optionally filtered by ' +
    'name. Values use Godot syntax (Vector3(1, 0, 2)).',
  inputSchema: {
    target: target,
    node: nodePath,
    properties: z.array(z.string().max(MAX_NAME_CHARS)).max(MAX_PROPS).default([]),
    filter: z
      .string()
      .max(MAX_NAME_CHARS)
      .default('')
      .describe('Only properties whose name contains this text.'),
    limit: z.number().int().min(1).max(MAX_PROPS).default(DEFAULT_PROPS),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    const result = await fetchProps(ctx, args.target, {
      path: args.node,
      names: args.properties,
      filter: args.filter,
      max: args.limit,
    });
    const script = result.script === undefined ? '' : `, script ${result.script}`;
    const shown =
      result.props.length < result.total
        ? `${result.props.length} of ${result.total}`
        : `${result.total}`;
    const lines = [
      `${result.path} (${result.class}${script}) — ${shown} properties`,
      ...result.props.map((p) => `${p.name}: ${p.type} = ${p.value}`),
    ];
    if (result.props.length < result.total) lines.push('More: raise limit or use filter.');
    return textResult(lines.join('\n'));
  },
});

export const setNodeProperty = defineTool({
  name: 'set_node_property',
  title: 'Set live node properties',
  description:
    'Sets properties on a node in the running game (for experiments: teleport the player, toggle ' +
    'visibility, tweak a speed). Changes are live only — not saved, not undoable, gone when the game stops; ' +
    'edit scenes/scripts for permanent changes. Values are Godot literals; types are checked first.',
  inputSchema: {
    node: nodePath,
    properties: z
      .record(z.string().max(MAX_NAME_CHARS), z.string().max(MAX_LITERAL_CHARS))
      .refine((v) => Object.keys(v).length > 0, 'Pass at least one property.')
      .describe(
        'Property → Godot literal, e.g. {"position": "Vector3(0, 3, 0)", "visible": "false", "name": "\\"Hero\\""}.',
      ),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    assertSafeLiterals(Object.values(args.properties), ctx.config.allowEval);
    const result = await ctx.runtime.call(
      'set_props',
      { path: args.node, values: args.properties },
      COMMAND_SLACK_MS,
    );
    return textResult(
      [
        `Set on ${result.path} (live only):`,
        ...result.props.map((p) => `${p.name} = ${p.value}`),
      ].join('\n'),
    );
  },
});
