import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeGodot } from '../helpers/fake-godot.js';
import { FakeRuntime, type Handler } from '../helpers/fake-runtime.js';
import { makeTempProject } from '../helpers/tmp-project.js';
import { connectTools, type ToolClient } from '../helpers/tool-client.js';

const SCENE = { scene: 'res://main.tscn', root: 'Main', class: 'Node3D', nodes: 4, unsaved: false };
const edit = (action: string, node: string, changes: string[]) => ({
  result: { ...SCENE, nodes: 5, unsaved: true, action, node, changes },
});

const HANDLERS: Record<string, Handler> = {
  open_scene: (p) =>
    p.path === 'res://missing.tscn'
      ? { error: { code: 'FILE_NOT_FOUND', message: "Scene 'res://missing.tscn' does not exist." } }
      : { result: { ...SCENE, scene: p.path } },
  add_node: (p) =>
    edit(`Godotty: add ${String(p.name)}`, String(p.name), ['position = Vector3(1, 0, 0)']),
  remove_node: () => edit('Godotty: remove Enemy', 'Enemy', ['removed Enemy']),
  update_node: (p) =>
    p.reparent === 'Ghost'
      ? { error: { code: 'NODE_NOT_FOUND', message: "No node at 'Ghost'." } }
      : edit('Godotty: update Enemy', 'Floor/Enemy', ['moved under Floor']),
  save_scene: (p) => ({
    result: { ...SCENE, scene: (p.path as string | undefined) ?? SCENE.scene },
  }),
  tree: () => ({
    result: {
      path: '.',
      current_scene: 'res://main.tscn',
      truncated: false,
      root: {
        name: 'Main',
        class: 'Node3D',
        children: [{ name: 'Enemy', class: 'Node3D', info: 'pos=(1, 0, 0)' }],
      },
    },
  }),
  get_props: () => ({
    result: {
      path: 'Enemy',
      class: 'Node3D',
      total: 1,
      props: [{ name: 'position', type: 'Vector3', value: 'Vector3(1, 0, 0)' }],
    },
  }),
};

describe('editor tools', () => {
  let project: ReturnType<typeof makeTempProject>;
  let tools: ToolClient;
  let editor: FakeRuntime;

  beforeEach(async () => {
    project = makeTempProject({ 'main.tscn': '', 'enemy.tscn': '', 'enemy.gd': '' });
    tools = await connectTools(project.root, fakeGodot().spawner);
    await tools.services.start();
    editor = new FakeRuntime(HANDLERS);
    await editor.connect(await tools.services.bridge.listen(), {
      role: 'editor',
      token: tools.services.bridge.tokenFor('editor'),
    });
  });

  afterEach(async () => {
    editor.close();
    await tools.close();
    project.cleanup();
  });

  it('opens and creates scenes, sandboxing paths', async () => {
    expect((await tools.call('open_scene', { path: 'main.tscn' })).text).toBe(
      'Opened res://main.tscn — root Main (Node3D), 4 nodes',
    );
    expect(
      (await tools.call('open_scene', { path: 'res://new.tscn', create_root_type: 'Node2D' })).text,
    ).toMatch(/^Created and opened res:\/\/new\.tscn/);
    expect(editor.requests.at(-1)?.params).toEqual({
      path: 'res://new.tscn',
      create_root_type: 'Node2D',
    });
    const missing = await tools.call('open_scene', { path: 'res://missing.tscn' });
    expect(missing.text).toContain('NOT_FOUND');
    expect(missing.text).toContain('list_files');
    expect((await tools.call('open_scene', { path: 'notes.txt' })).text).toContain(
      'not a scene file',
    );
    expect((await tools.call('open_scene', { path: '../x.tscn' })).text).toContain(
      'PATH_OUTSIDE_PROJECT',
    );
  });

  it('adds nodes by type or scene, and requires exactly one', async () => {
    expect(
      (
        await tools.call('add_node', {
          name: 'Enemy',
          type: 'Node3D',
          properties: { position: 'Vector3(1, 0, 0)' },
        })
      ).text,
    ).toBe(
      [
        'Godotty: add Enemy → Enemy (undoable in the editor: Ctrl/Cmd+Z)',
        '  position = Vector3(1, 0, 0)',
        'res://main.tscn — root Main (Node3D), 5 nodes, unsaved changes (call save_scene)',
      ].join('\n'),
    );
    await tools.call('add_node', { name: 'E2', scene: 'enemy.tscn', parent: 'Floor' });
    expect(editor.requests.at(-1)?.params).toEqual({
      parent: 'Floor',
      name: 'E2',
      scene: 'res://enemy.tscn',
      properties: {},
    });
    expect((await tools.call('add_node', { name: 'X' })).text).toContain(
      'exactly one of "type" or "scene"',
    );
    expect(
      (await tools.call('add_node', { name: 'X', type: 'Node', scene: 'enemy.tscn' })).text,
    ).toContain('exactly one');
  });

  it('removes, updates (with script paths sandboxed) and saves', async () => {
    expect((await tools.call('remove_node', { node: 'Enemy' })).text).toContain(
      'Godotty: remove Enemy → Enemy',
    );
    expect(
      (await tools.call('update_node', { node: 'Enemy', reparent: 'Floor', script: 'enemy.gd' }))
        .text,
    ).toContain('  moved under Floor');
    expect(editor.requests.at(-1)?.params).toMatchObject({
      script: 'res://enemy.gd',
      reparent: 'Floor',
    });
    await tools.call('update_node', { node: 'Enemy', script: '' });
    expect(editor.requests.at(-1)?.params).toMatchObject({ script: '' });
    expect((await tools.call('update_node', { node: 'Enemy', reparent: 'Ghost' })).text).toContain(
      "No node at 'Ghost'",
    );
    expect((await tools.call('save_scene')).text).toBe(
      'Saved res://main.tscn — root Main (Node3D), 4 nodes',
    );
    expect((await tools.call('save_scene', { path: 'res://copy.tscn' })).text).toBe(
      'Saved res://copy.tscn — root Main (Node3D), 4 nodes',
    );
    expect((await tools.call('save_scene', { path: 'copy.txt' })).text).toContain(
      'not a scene file',
    );
  });

  it('inspects the edited scene with target=editor', async () => {
    expect((await tools.call('inspect_scene_tree', { target: 'editor' })).text).toBe(
      'Editor scene res://main.tscn at .\nMain (Node3D)\n└─ Enemy (Node3D)  pos=(1, 0, 0)',
    );
    expect(
      (await tools.call('get_node_properties', { target: 'editor', node: 'Enemy' })).text,
    ).toBe('Enemy (Node3D) — 1 properties\nposition: Vector3 = Vector3(1, 0, 0)');
  });

  it('explains when the editor is not connected', async () => {
    editor.close();
    await expect.poll(() => tools.services.editor.isConnected).toBe(false);
    const result = await tools.call('open_scene', { path: 'main.tscn' });
    expect(result.text).toContain('EDITOR_NOT_CONNECTED');
    expect(result.text).toContain('Project Settings → Plugins');
  });
});
