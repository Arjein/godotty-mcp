import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { formatVersion } from '../godot/executable.js';
import { parseProjectFile, type ProjectSettings } from '../godot/project-file.js';
import { parseSceneFile, renderScene, SceneFormatError } from '../godot/scene-file.js';
import { SectionFileError } from '../godot/section-file.js';
import { ErrorCode, ToolError } from '../util/errors.js';
import {
  FILE_TYPES,
  globToRegExp,
  matchesType,
  walkProject,
  type FileType,
} from '../util/files.js';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_TEXT_BUDGET,
  MAX_PAGE_SIZE,
  paginate,
  truncateText,
} from '../util/paginate.js';
import { defineTool, textResult, type ToolContext } from './registry.js';

const PROJECT_FILE = 'project.godot';
const DEFAULT_SCENE_DEPTH = 6;
const MAX_SCENE_DEPTH = 50;
const MS_PER_SECOND = 1000;

export const projectInfo = defineTool({
  name: 'project_info',
  title: 'Project info',
  description:
    'Summarizes the Godot project: installed Godot version, main scene, renderer, autoloads, input map ' +
    'actions with their bindings, enabled editor plugins, and whether the game/editor bridge is running. ' +
    'Call this first to orient yourself in a project. Works without the editor open.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (_args, ctx) => textResult(await describeProject(ctx)),
});

async function describeProject(ctx: ToolContext): Promise<string> {
  const settings = readProjectSettings(ctx.sandbox.root);
  const godotLine = await ctx.godot
    .version()
    .then((v) => `Godot: ${formatVersion(v)} (${ctx.godot.path})`)
    .catch(
      (error: unknown) =>
        `Godot: unavailable — ${error instanceof Error ? error.message : String(error)}`,
    );
  const lines = [
    `Project: ${settings.name ?? '(unnamed)'}${settings.description === undefined ? '' : ` — ${settings.description}`}`,
    `Root: ${ctx.sandbox.root}`,
    godotLine,
    `Project features: ${settings.features.join(', ') || 'none'}`,
    `Main scene: ${settings.mainScene ?? 'not set'}`,
    `Renderer: ${settings.renderer ?? 'default (forward_plus)'}`,
    ...section(
      `Autoloads (${settings.autoloads.length})`,
      settings.autoloads.map((a) => `${a.name}: ${a.path}${a.singleton ? ' (singleton)' : ''}`),
    ),
    ...section(
      `Input actions (${settings.inputActions.length})`,
      settings.inputActions.map((a) => `${a.name}: ${a.events.join(', ') || 'no bindings'}`),
    ),
    ...section(`Enabled plugins (${settings.enabledPlugins.length})`, settings.enabledPlugins),
    `Game: ${describeGame(ctx)}`,
    'Editor bridge: not connected (editor tools need the Godotty addon; arrives in a later version).',
  ];
  return lines.join('\n');
}

function section(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [`${title}: none`] : [`${title}:`, ...items.map((i) => `  ${i}`)];
}

function describeGame(ctx: ToolContext): string {
  const run = ctx.game.run;
  if (run === undefined) return 'not running';
  if (run.state === 'exited')
    return `not running (last run #${run.id} exited with ${run.exit?.code ?? run.exit?.signal ?? '?'})`;
  const seconds = ((Date.now() - run.startedAt) / MS_PER_SECOND).toFixed(1);
  return `running (run #${run.id}, pid ${run.pid ?? '?'}, ${seconds}s, helper ${run.helperReady ? 'ready' : 'not ready'})`;
}

export function readProjectSettings(root: string): ProjectSettings {
  try {
    return parseProjectFile(readFileSync(path.join(root, PROJECT_FILE), 'utf8'));
  } catch (error) {
    if (error instanceof SectionFileError) {
      throw new ToolError(
        ErrorCode.GodotFailed,
        `project.godot could not be parsed: ${error.message}`,
        'Open the project in Godot once to rewrite it.',
      );
    }
    throw error;
  }
}

/** Connection paths are relative to the root, which is "."; show the root's name instead. */
function nodeLabel(nodePath: string, rootName: string): string {
  return nodePath === '.' ? rootName : nodePath;
}

const FILE_TYPE_NAMES = ['all', ...Object.keys(FILE_TYPES)] as [string, ...string[]];

export const listFiles = defineTool({
  name: 'list_files',
  title: 'List project files',
  description:
    'Lists project files as res:// paths, sorted, optionally filtered by type (scene, script, resource, ' +
    'shader, image, audio, model, font) and glob. Skips .godot, hidden and .gdignore folders, generated ' +
    '.import/.uid files, and addons/ unless include_addons. Paginated: pass the returned offset to continue.',
  inputSchema: {
    type: z.enum(FILE_TYPE_NAMES).default('all').describe('File category to include.'),
    glob: z
      .string()
      .optional()
      .describe(
        'Glob over res:// paths, e.g. "scenes/**/*.tscn" or "*player*". Supports **, *, ?, {a,b}. No "/" = match file name anywhere.',
      ),
    folder: z.string().default('res://').describe('Folder to list (res:// path).'),
    include_addons: z.boolean().default(false).describe('Also list files under res://addons/.'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (args, ctx) => {
    const folder = ctx.sandbox.resolve(args.folder);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      throw new ToolError(
        ErrorCode.NotFound,
        `Folder ${args.folder} does not exist.`,
        'Use list_files without "folder" to see the project.',
      );
    }
    const glob = args.glob === undefined ? undefined : globToRegExp(args.glob);
    const files = walkProject(ctx.sandbox.root, folder, { includeAddons: args.include_addons })
      .filter((f) => matchesType(f, args.type as FileType | 'all'))
      .filter((f) => glob === undefined || glob.test(f));
    const page = paginate(files, args);
    if (page.total === 0) return Promise.resolve(textResult('No matching files.'));
    const shown = `${page.offset + 1}–${page.offset + page.items.length}`;
    const more =
      page.nextOffset === undefined
        ? ''
        : `\nMore available: call again with offset=${page.nextOffset}.`;
    return Promise.resolve(
      textResult(
        `${page.total} files (showing ${shown}):\n${page.items.map((f) => `res://${f}`).join('\n')}${more}`,
      ),
    );
  },
});

export const readScene = defineTool({
  name: 'read_scene',
  title: 'Read scene',
  description:
    'Shows a .tscn scene as a compact node tree: name (type), instanced scenes, attached scripts, groups and ' +
    'the properties saved in the file (only non-default values are saved). Transforms are shown as positions. ' +
    'Sub-resources are inlined, external resources shown as paths. Use "node" to show a subtree and "depth" to ' +
    'limit levels. Reads the file on disk; for the live running game use inspect_scene_tree.',
  inputSchema: {
    path: z.string().describe('Scene file, e.g. "res://scenes/main.tscn".'),
    node: z
      .string()
      .default('.')
      .describe('Node path relative to the scene root to start from ("." = root).'),
    depth: z
      .number()
      .int()
      .min(0)
      .max(MAX_SCENE_DEPTH)
      .default(DEFAULT_SCENE_DEPTH)
      .describe('Levels below the start node to show.'),
    include_properties: z.boolean().default(true).describe('Show saved property values.'),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (args, ctx) => {
    const file = ctx.sandbox.resolve(args.path);
    const resPath = ctx.sandbox.toResPath(file);
    if (file.endsWith('.scn')) {
      throw new ToolError(
        ErrorCode.InvalidInput,
        `${resPath} is a binary scene.`,
        'Only text scenes (.tscn) can be read. Re-save it as .tscn in the editor.',
      );
    }
    if (!file.endsWith('.tscn')) {
      throw new ToolError(
        ErrorCode.InvalidInput,
        `${resPath} is not a scene file.`,
        'Pass a .tscn path; find scenes with list_files type="scene".',
      );
    }
    if (!existsSync(file)) {
      throw new ToolError(
        ErrorCode.NotFound,
        `Scene ${resPath} does not exist.`,
        'Find scenes with list_files type="scene".',
      );
    }
    try {
      const scene = parseSceneFile(readFileSync(file, 'utf8'));
      const tree = renderScene(scene, {
        depth: args.depth,
        includeProperties: args.include_properties,
        from: args.node,
      });
      const connections =
        scene.connections.length === 0
          ? ''
          : `\nSignal connections (${scene.connections.length}):\n${scene.connections.map((c) => `  ${nodeLabel(c.from, scene.root.name)}.${c.signal} → ${nodeLabel(c.to, scene.root.name)}.${c.method}()`).join('\n')}`;
      const header = `${resPath} — ${scene.nodeCount} nodes`;
      return Promise.resolve(
        textResult(
          truncateText(
            `${header}\n${tree}${connections}`,
            DEFAULT_TEXT_BUDGET,
            'use "node" or a smaller "depth", or include_properties=false',
          ),
        ),
      );
    } catch (error) {
      if (error instanceof SceneFormatError || error instanceof SectionFileError) {
        throw new ToolError(
          ErrorCode.InvalidInput,
          `Cannot read ${resPath}: ${error.message}`,
          'Check the node path, or open and re-save the scene in Godot if the file is corrupted.',
        );
      }
      throw error;
    }
  },
});
