import { z } from 'zod';

import type { EditResult, SceneInfo } from '../bridge/protocol.js';
import { ErrorCode, ToolError } from '../util/errors.js';
import { assertSafeLiterals } from '../util/literals.js';
import { defineTool, textResult, type ToolContext } from './registry.js';

const EDIT_TIMEOUT_MS = 15_000;
const MAX_PATH_CHARS = 1000;
const MAX_NAME_CHARS = 200;
const MAX_LITERAL_CHARS = 10_000;
const SCENE_EXTENSIONS = ['.tscn', '.scn'];

const nodePath = z
  .string()
  .max(MAX_PATH_CHARS)
  .describe('Node path relative to the edited scene root ("." = root, "Player/Camera3D").');
const properties = z
  .record(z.string().max(MAX_NAME_CHARS), z.string().max(MAX_LITERAL_CHARS))
  .default({})
  .describe(
    'Property → Godot literal, e.g. {"position": "Vector3(0, 1, 0)", "text": "\\"Start\\""}.',
  );

function sceneLine(info: SceneInfo): string {
  const where = info.scene === '' ? 'unsaved new scene' : info.scene;
  return `${where} — root ${info.root} (${info.class}), ${info.nodes} nodes${info.unsaved ? ', unsaved changes (call save_scene)' : ''}`;
}

function editText(result: EditResult): string {
  return [
    `${result.action} → ${result.node} (undoable in the editor: Ctrl/Cmd+Z)`,
    ...result.changes.map((c) => `  ${c}`),
    sceneLine(result),
  ].join('\n');
}

/** Resolves a res:// file argument through the sandbox; optionally requires a scene extension. */
function resPath(ctx: ToolContext, input: string, requireScene: boolean): string {
  const resolved = ctx.sandbox.toResPath(input);
  if (requireScene && !SCENE_EXTENSIONS.some((ext) => resolved.endsWith(ext))) {
    throw new ToolError(ErrorCode.InvalidInput, `${resolved} is not a scene file (.tscn/.scn).`);
  }
  return resolved;
}

export const openScene = defineTool({
  name: 'open_scene',
  title: 'Open scene in editor',
  description:
    'Opens a scene in the Godot editor (needs the editor open with the Godotty addon enabled) so the editing ' +
    'tools act on it. With create_root_type, first creates a new scene file whose root is that Node class ' +
    '(e.g. "Node2D", "Control"). Editing tools always act on the scene currently open in the editor.',
  inputSchema: {
    path: z.string().max(MAX_PATH_CHARS).describe('res:// path of the .tscn to open or create.'),
    create_root_type: z
      .string()
      .max(MAX_NAME_CHARS)
      .optional()
      .describe('Create a new scene with a root of this class.'),
    root_name: z
      .string()
      .max(MAX_NAME_CHARS)
      .optional()
      .describe('Root node name for a new scene (default: file name in PascalCase).'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    const path = resPath(ctx, args.path, true);
    const info = await ctx.editor.call(
      'open_scene',
      { path, create_root_type: args.create_root_type, root_name: args.root_name },
      EDIT_TIMEOUT_MS,
    );
    return textResult(
      `${args.create_root_type === undefined ? 'Opened' : 'Created and opened'} ${sceneLine(info)}`,
    );
  },
});

export const addNode = defineTool({
  name: 'add_node',
  title: 'Add node',
  description:
    'Adds a node to the scene open in the editor, as one undoable step: a new node of a class ("type", e.g. ' +
    '"Sprite2D", "CollisionShape3D") or an instance of a scene ("scene"), with optional initial properties. ' +
    'Names must be unique among siblings. Call save_scene to write the change to disk.',
  inputSchema: {
    parent: nodePath.default('.'),
    name: z.string().min(1).max(MAX_NAME_CHARS),
    type: z.string().max(MAX_NAME_CHARS).optional().describe('Node class to create.'),
    scene: z
      .string()
      .max(MAX_PATH_CHARS)
      .optional()
      .describe('res:// .tscn to instance instead of a class.'),
    properties,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    assertSafeLiterals(Object.values(args.properties), ctx.config.allowEval);
    if ((args.type === undefined) === (args.scene === undefined)) {
      throw new ToolError(ErrorCode.InvalidInput, 'Pass exactly one of "type" or "scene".');
    }
    const scene = args.scene === undefined ? undefined : resPath(ctx, args.scene, true);
    const result = await ctx.editor.call(
      'add_node',
      { parent: args.parent, name: args.name, type: args.type, scene, properties: args.properties },
      EDIT_TIMEOUT_MS,
    );
    return textResult(editText(result));
  },
});

export const removeNode = defineTool({
  name: 'remove_node',
  title: 'Remove node',
  description:
    'Removes a node (and its children) from the scene open in the editor, as one undoable step. The scene root cannot be removed.',
  inputSchema: { node: nodePath },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  handler: async (args, ctx) =>
    textResult(
      editText(await ctx.editor.call('remove_node', { node: args.node }, EDIT_TIMEOUT_MS)),
    ),
});

export const updateNode = defineTool({
  name: 'update_node',
  title: 'Update node',
  description:
    'Changes a node in the scene open in the editor, all as ONE undoable step: set properties, rename, ' +
    'reparent (keeps the global transform), and/or attach a script (res:// path) or detach it (""). Values are ' +
    'type-checked. To set variables of a newly attached script, attach first and set them in a second call.',
  inputSchema: {
    node: nodePath,
    properties,
    rename: z.string().min(1).max(MAX_NAME_CHARS).optional(),
    reparent: nodePath.optional().describe('New parent path.'),
    script: z
      .string()
      .max(MAX_PATH_CHARS)
      .optional()
      .describe('res:// script to attach, or "" to detach.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    assertSafeLiterals(Object.values(args.properties), ctx.config.allowEval);
    const script =
      args.script === undefined || args.script === ''
        ? args.script
        : resPath(ctx, args.script, false);
    const result = await ctx.editor.call(
      'update_node',
      {
        node: args.node,
        properties: args.properties,
        rename: args.rename,
        reparent: args.reparent,
        script,
      },
      EDIT_TIMEOUT_MS,
    );
    return textResult(editText(result));
  },
});

export const saveScene = defineTool({
  name: 'save_scene',
  title: 'Save scene',
  description:
    'Saves the scene open in the editor to disk, or to a new path ("save as"). Running games and read_scene only see saved changes.',
  inputSchema: {
    path: z.string().max(MAX_PATH_CHARS).optional().describe('Save as this res:// .tscn instead.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    const path = args.path === undefined ? undefined : resPath(ctx, args.path, true);
    return textResult(
      `Saved ${sceneLine(await ctx.editor.call('save_scene', { path }, EDIT_TIMEOUT_MS))}`,
    );
  },
});
