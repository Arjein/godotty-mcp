import { z } from 'zod';

import type { EvalResult } from '../bridge/protocol.js';
import { defineTool, textResult, type ToolContext } from './registry.js';

const MAX_CODE_CHARS = 20_000;
const DEFAULT_TIMEOUT_S = 10;
const MAX_TIMEOUT_S = 60;
const MS_PER_SECOND = 1000;

function run(
  ctx: ToolContext,
  target: 'game' | 'editor',
  code: string,
  timeoutMs: number,
): Promise<EvalResult> {
  return target === 'editor'
    ? ctx.editor.call('eval', { code }, timeoutMs)
    : ctx.runtime.call('eval', { code }, timeoutMs);
}

/**
 * OPT-IN: registered only when the server runs with --allow-eval / GODOTTY_ALLOW_EVAL=1. It runs
 * arbitrary code inside Godot with the user's permissions; see docs (safety model).
 */
export const evalGdscript = defineTool({
  name: 'eval_gdscript',
  title: 'Evaluate GDScript (opt-in)',
  description:
    'Runs arbitrary GDScript in the running game (target=game) or in the Godot editor (target=editor). The ' +
    'code is the body of a function: `tree` (SceneTree) and `scene` (current game scene / edited scene root) ' +
    'are available, `await` works, and `return` sends back a value. Parse and runtime errors are reported ' +
    'with line numbers. Editor changes made this way are NOT undoable; prefer the dedicated tools. An endless ' +
    'loop freezes Godot.',
  inputSchema: {
    code: z
      .string()
      .min(1)
      .max(MAX_CODE_CHARS)
      .describe('GDScript statements, e.g. "return scene.get_node(\\"Player\\").position".'),
    target: z.enum(['game', 'editor']).default('game'),
    timeout_s: z.number().min(1).max(MAX_TIMEOUT_S).default(DEFAULT_TIMEOUT_S),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  enabled: (config) => config.allowEval,
  handler: async (args, ctx) => {
    const result = await run(ctx, args.target, args.code, args.timeout_s * MS_PER_SECOND);
    const errors =
      result.errors.length === 0
        ? ''
        : `\nErrors while running:\n${result.errors.map((e) => `  ${e}`).join('\n')}`;
    return textResult(`Returned: ${result.value}${errors}`);
  },
});
