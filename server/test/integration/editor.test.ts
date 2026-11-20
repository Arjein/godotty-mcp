import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GODOT, startHarness, type Harness } from './harness.js';

/** First launch imports the project before plugins load. */
const EDITOR_CONNECT_MS = 120_000;

describe('editor plugin: undoable scene edits in a real (headless) Godot editor', () => {
  let h: Harness;
  let editor: ChildProcess;

  beforeAll(async () => {
    // The demo project ships with the Godotty plugin enabled.
    h = await startHarness();
    editor = spawn(GODOT, ['--headless', '--editor', '--path', h.root], { stdio: 'ignore' });
    const peer = await h.server.services.bridge.waitFor('editor', EDITOR_CONNECT_MS);
    expect(peer?.hello.role).toBe('editor');
  });

  afterAll(async () => {
    editor.kill('SIGKILL');
    await h.close();
  });

  it('opens a scene', async () => {
    const { text, isError } = await h.call('open_scene', { path: 'res://scenes/main.tscn' });
    expect(isError).toBe(false);
    // The editor counts nodes inside instanced scenes too (the Player instance has 3).
    expect(text).toBe('Opened res://scenes/main.tscn — root Main (Node3D), 9 nodes');
  });

  it('adds nodes and scene instances with initial properties', async () => {
    const added = await h.call('add_node', {
      name: 'Spawn',
      type: 'Marker3D',
      properties: { position: 'Vector3(2, 0, -3)' },
    });
    expect(added.text).toBe(
      [
        'Godotty: add Spawn → Spawn (undoable in the editor: Ctrl/Cmd+Z)',
        '  position = Vector3(2, 0, -3)',
        'res://scenes/main.tscn — root Main (Node3D), 10 nodes, unsaved changes (call save_scene)',
      ].join('\n'),
    );
    const instance = await h.call('add_node', {
      name: 'Player2',
      scene: 'res://scenes/player.tscn',
    });
    expect(instance.text).toContain('Godotty: add Player2 → Player2');
    expect(instance.text).toContain('13 nodes');
  });

  it('shows the edited (unsaved) scene with target=editor', async () => {
    const tree = await h.call('inspect_scene_tree', { target: 'editor' });
    expect(tree.text).toContain('Editor scene res://scenes/main.tscn at .');
    expect(tree.text).toContain('Spawn (Marker3D)  pos=(2, 0, -3)');
    const props = await h.call('get_node_properties', {
      target: 'editor',
      node: 'Spawn',
      properties: ['position'],
    });
    expect(props.text).toBe(
      'Spawn (Marker3D) — 1 properties\nposition: Vector3 = Vector3(2, 0, -3)',
    );
  });

  it('updates a node in one step: properties, rename, reparent', async () => {
    const { text } = await h.call('update_node', {
      node: 'Spawn',
      properties: { visible: 'false' },
      rename: 'SpawnPoint',
      reparent: 'Floor',
    });
    expect(text).toContain('Godotty: update Spawn → Floor/SpawnPoint');
    expect(text).toContain('  visible = false\n  renamed Spawn → SpawnPoint\n  moved under Floor');
  });

  it('removes nodes, and the editor can undo and redo it', async () => {
    expect((await h.call('remove_node', { node: 'Player2' })).text).toContain(
      'Godotty: remove Player2 → Player2',
    );
    const undone = await h.server.services.editor.call('undo', {}, 5000);
    expect(undone.action).toBe('Godotty: remove Player2');
    expect((await h.call('inspect_scene_tree', { target: 'editor', depth: 1 })).text).toContain(
      'Player2',
    );
    expect((await h.server.services.editor.call('redo', {}, 5000)).action).toBe(
      'Godotty: remove Player2',
    );
    expect((await h.call('inspect_scene_tree', { target: 'editor', depth: 1 })).text).not.toContain(
      'Player2',
    );
  });

  it('rejects invalid edits with actionable errors and leaves the scene untouched', async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['add_node', { name: 'Floor', type: 'Node3D' }, 'already has a child named'],
      ['add_node', { name: 'X', type: 'NotAClass' }, 'not an instantiable Node class'],
      ['add_node', { name: 'a/b', type: 'Node' }, "contains '/'"],
      [
        'add_node',
        { name: 'X', type: 'Node3D', properties: { position: '"far"' } },
        'position expects Vector3',
      ],
      ['remove_node', { node: '.' }, 'scene root cannot be removed'],
      [
        'update_node',
        { node: 'Floor', reparent: 'Floor/SpawnPoint' },
        'cannot be moved under itself',
      ],
      [
        'update_node',
        { node: 'Floor/SpawnPoint', script: 'res://scripts/player.gd' },
        'extends CharacterBody3D',
      ],
      ['update_node', { node: 'Floor' }, 'Nothing to update'],
      ['remove_node', { node: 'Ghost' }, "No node at 'Ghost'"],
    ];
    for (const [tool, args, message] of cases) {
      const result = await h.call(tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(result.text).toContain(message);
    }
    expect((await h.call('inspect_scene_tree', { target: 'editor', depth: 1 })).text).not.toMatch(
      /^.*\bX \(/m,
    );
  });

  it('saves to disk, where read_scene sees the edits', async () => {
    expect((await h.call('save_scene')).text).toBe(
      'Saved res://scenes/main.tscn — root Main (Node3D), 10 nodes',
    );
    const onDisk = await h.call('read_scene', {
      path: 'res://scenes/main.tscn',
      include_properties: false,
    });
    expect(onDisk.text).toContain('│  └─ SpawnPoint (Marker3D)');
    expect(onDisk.text).not.toContain('Player2');
  });

  it('keeps editors started by the server offline (no second "editor" peer)', async () => {
    const connected = h.server.services.bridge.peer('editor');
    // The real editor is open, so check_scripts must not start a second editor on the project.
    const checked = await h.call('check_scripts', { path: 'res://scripts/player.gd' });
    expect(checked.text).toContain('checked with check-only');
    expect(h.server.services.bridge.peer('editor')).toBe(connected);
  });

  it('refuses eval in the editor when the server did not enable it (plugin-side lock)', async () => {
    await expect(
      h.server.services.editor.call('eval', { code: 'return 1' }, 5000),
    ).rejects.toMatchObject({ code: 'DISABLED' });
  });

  it('creates new scenes and refuses to overwrite', async () => {
    const created = await h.call('open_scene', {
      path: 'res://scenes/levels/level_one.tscn',
      create_root_type: 'Node2D',
    });
    expect(created.text).toBe(
      'Created and opened res://scenes/levels/level_one.tscn — root LevelOne (Node2D), 1 nodes',
    );
    expect(existsSync(path.join(h.root, 'scenes/levels/level_one.tscn'))).toBe(true);
    const again = await h.call('open_scene', {
      path: 'res://scenes/levels/level_one.tscn',
      create_root_type: 'Node2D',
    });
    expect(again.text).toContain('already exists');
    // Godot 4.7 adds unique_id=… to node headers; 4.5 doesn't.
    expect(readFileSync(path.join(h.root, 'scenes/levels/level_one.tscn'), 'utf8')).toMatch(
      /\[node name="LevelOne" type="Node2D"[ \]]/,
    );
  });
});
