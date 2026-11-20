import { existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionFilePath } from '../../src/bridge/session-file.js';
import { copyDemoProject } from '../helpers/demo.js';
import { fakeGodot } from '../helpers/fake-godot.js';
import { fakeSpawner } from '../helpers/fake-process.js';
import { makeTempProject } from '../helpers/tmp-project.js';
import { connectTools, type ToolClient } from '../helpers/tool-client.js';

describe('project tools', () => {
  let project: ReturnType<typeof makeTempProject>;
  let tools: ToolClient;

  beforeEach(async () => {
    project = makeTempProject();
    copyDemoProject(project.root);
    tools = await connectTools(project.root, fakeGodot().spawner);
  });

  afterEach(async () => {
    await tools.close();
    project.cleanup();
  });

  describe('install_addon', () => {
    it('copies the plugin into addons/ and refuses to overwrite without force', async () => {
      const bare = makeTempProject();
      const other = await connectTools(bare.root, fakeGodot().spawner);
      try {
        expect((await other.call('project_info')).text).toContain('install it with install_addon');
        const first = await other.call('install_addon');
        expect(first.text).toContain('Installed the Godotty editor plugin');
        expect(first.text).toContain('Project Settings → Plugins');
        expect(existsSync(path.join(bare.root, 'addons/godotty_mcp/plugin.cfg'))).toBe(true);
        expect((await other.call('project_info')).text).toContain('installed but not enabled');
        const again = await other.call('install_addon');
        expect(again).toMatchObject({ isError: true });
        expect(again.text).toContain('force=true');
        expect((await other.call('install_addon', { force: true })).text).toContain('Replaced');
      } finally {
        await other.close();
        bare.cleanup();
      }
    });

    it('refuses an addons folder that links outside the project', async () => {
      const bare = makeTempProject();
      const outside = makeTempProject();
      symlinkSync(outside.root, path.join(bare.root, 'addons'));
      const other = await connectTools(bare.root, fakeGodot().spawner);
      try {
        expect((await other.call('install_addon')).text).toContain('PATH_OUTSIDE_PROJECT');
        expect(existsSync(path.join(outside.root, 'godotty_mcp'))).toBe(false);
      } finally {
        await other.close();
        bare.cleanup();
        outside.cleanup();
      }
    });
  });

  describe('without project.godot', () => {
    it('serves, reports NOT_FOUND for project tools, and picks the project up once it exists', async () => {
      const bare = makeTempProject();
      rmSync(path.join(bare.root, 'project.godot'));
      const other = await connectTools(bare.root, fakeGodot().spawner);
      try {
        await other.services.start();
        expect(existsSync(sessionFilePath(bare.root))).toBe(false);
        const info = await other.call('project_info');
        expect(info).toMatchObject({ isError: true });
        expect(info.text).toContain('Error [NOT_FOUND]: No project.godot in');
        expect(info.text).toContain('without a restart');
        expect((await other.call('list_files')).text).toContain('No project.godot');
        writeFileSync(path.join(bare.root, 'project.godot'), 'config_version=5\n');
        expect((await other.call('project_info')).isError).toBe(false);
        // The editor plugin finds the server once the project exists.
        expect(existsSync(sessionFilePath(bare.root))).toBe(true);
      } finally {
        await other.close();
        bare.cleanup();
      }
    });
  });

  describe('project_info', () => {
    it('summarizes the project', async () => {
      const { text, isError } = await tools.call('project_info');
      expect(isError).toBe(false);
      expect(text).toContain('Project: godotty-mcp demo — Small 3D scene');
      expect(text).toContain('Godot: 4.7.2.stable (godot)');
      expect(text).toContain('Project features: 4.5, GL Compatibility');
      expect(text).toContain('Renderer: gl_compatibility');
      expect(text).toContain('Autoloads (0): none');
      expect(text).toContain('Input actions (5):\n  move_left: A (physical)');
      expect(text).toContain('Game: not running');
      expect(text).toContain(
        'Editor bridge: not connected (the Godotty plugin is enabled; open this project in the Godot editor)',
      );
      expect(text).not.toContain('later version');
    });

    it('lists autoloads and plugins, and survives a missing Godot', async () => {
      writeFileSync(
        path.join(project.root, 'project.godot'),
        'config_version=5\n[autoload]\nG="*res://g.gd"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/x/plugin.cfg")\n[input]\nnone={"events": []}\n',
      );
      const missing = fakeSpawner((proc) => {
        proc.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });
      const other = await connectTools(project.root, missing.spawner);
      const { text } = await other.call('project_info');
      expect(text).toContain('Project: (unnamed)');
      expect(text).toContain('Godot: unavailable — Godot executable "godot" was not found.');
      expect(text).toContain('  G: res://g.gd (singleton)');
      expect(text).toContain('  res://addons/x/plugin.cfg');
      expect(text).toContain('none: no bindings');
      expect(text).toContain('Main scene: not set');
      expect(text).toContain('Renderer: default (forward_plus)');
      expect(text).toContain('installed but not enabled');
      await other.close();
    });

    it('explains an unparseable project.godot', async () => {
      writeFileSync(path.join(project.root, 'project.godot'), '[application]\nconfig/name=[1, 2\n');
      const { text, isError } = await tools.call('project_info');
      expect(isError).toBe(true);
      expect(text).toContain('project.godot could not be parsed');
    });
  });

  describe('list_files', () => {
    it('filters by type and glob', async () => {
      expect((await tools.call('list_files', { type: 'script' })).text).toBe(
        '2 files (showing 1–2):\nres://scripts/player.gd\nres://test/unit/test_player.gd',
      );
      expect((await tools.call('list_files', { glob: '*.tscn' })).text).toContain(
        'res://scenes/player.tscn',
      );
      expect((await tools.call('list_files', { glob: 'nothing*' })).text).toBe(
        'No matching files.',
      );
    });

    it('paginates', async () => {
      const first = await tools.call('list_files', { limit: 2 });
      expect(first.text).toMatch(/^\d+ files \(showing 1–2\)/);
      expect(first.text).toContain('call again with offset=2');
      const second = await tools.call('list_files', { limit: 2, offset: 2 });
      expect(second.text).toContain('showing 3–4');
    });

    it('rejects missing folders and paths outside the project', async () => {
      expect((await tools.call('list_files', { folder: 'res://nope' })).text).toContain(
        'NOT_FOUND',
      );
      expect((await tools.call('list_files', { folder: '../' })).text).toContain(
        'PATH_OUTSIDE_PROJECT',
      );
    });
  });

  describe('read_scene', () => {
    it('renders a scene with a node filter and connections', async () => {
      writeFileSync(
        path.join(project.root, 'scenes/signals.tscn'),
        '[gd_scene format=3]\n[node name="Root" type="Node"]\n[node name="Button" type="Button" parent="."]\n[connection signal="pressed" from="Button" to="." method="_on_pressed"]\n',
      );
      const { text } = await tools.call('read_scene', { path: 'res://scenes/signals.tscn' });
      expect(text).toBe(
        'res://scenes/signals.tscn — 2 nodes\nRoot (Node)\n└─ Button (Button)\nSignal connections (1):\n  Button.pressed → Root._on_pressed()',
      );
      const sub = await tools.call('read_scene', {
        path: 'scenes/main.tscn',
        node: 'Floor',
        depth: 0,
        include_properties: false,
      });
      expect(sub.text).toBe(
        'res://scenes/main.tscn — 7 nodes\nFloor (StaticBody3D)\n… 2 more nodes (increase depth to see)',
      );
    });

    it.each([
      ['res://scenes/x.scn', 'binary scene'],
      ['res://scripts/player.gd', 'not a scene file'],
      ['res://scenes/missing.tscn', 'does not exist'],
    ])('rejects %s', async (scenePath, message) => {
      const { text, isError } = await tools.call('read_scene', { path: scenePath });
      expect(isError).toBe(true);
      expect(text).toContain(message);
    });

    it('explains broken scenes and bad node paths', async () => {
      writeFileSync(
        path.join(project.root, 'scenes/broken.tscn'),
        '[node name="A" type="Node"]\n[node name="B" type="Node" parent="Ghost"]\n',
      );
      expect((await tools.call('read_scene', { path: 'res://scenes/broken.tscn' })).text).toContain(
        'unknown parent "Ghost"',
      );
      expect(
        (await tools.call('read_scene', { path: 'res://scenes/main.tscn', node: 'Ghost' })).text,
      ).toContain('No node at path "Ghost"');
    });
  });
});
