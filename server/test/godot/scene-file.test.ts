import { describe, expect, it } from 'vitest';

import {
  findNode,
  parseSceneFile,
  renderScene,
  SceneFormatError,
} from '../../src/godot/scene-file.js';
import { readDemo } from '../helpers/demo.js';

const ALL = { depth: 10, includeProperties: true, from: '.' };

describe('parseSceneFile', () => {
  it('builds the demo main scene tree with resolved instances', () => {
    const scene = parseSceneFile(readDemo('scenes/main.tscn'));
    expect(scene.nodeCount).toBe(7);
    expect(scene.root.name).toBe('Main');
    expect(scene.root.children.map((c) => c.name)).toEqual(['Sun', 'Camera3D', 'Floor', 'Player']);
    expect(findNode(scene.root, 'Player')?.instance).toBe('res://scenes/player.tscn');
    expect(findNode(scene.root, 'Floor/CollisionShape3D')?.type).toBe('CollisionShape3D');
    expect(findNode(scene.root, 'Main')).toBe(scene.root);
    expect(findNode(scene.root, 'Nope/Child')).toBeUndefined();
  });

  it('resolves scripts, groups and connections', () => {
    const scene = parseSceneFile(
      [
        '[gd_scene format=3]',
        '[ext_resource type="Script" path="res://a.gd" id="1"]',
        '[node name="Root" type="Node" groups=["enemies"]]',
        'script = ExtResource("1")',
        '[node name="Child" type="Node" parent="."]',
        '[connection signal="ready" from="Child" to="." method="_on_ready"]',
      ].join('\n'),
    );
    expect(scene.root.script).toBe('res://a.gd');
    expect(scene.root.groups).toEqual(['enemies']);
    expect(scene.root.props).toEqual([]);
    expect(scene.connections).toEqual([
      { signal: 'ready', from: 'Child', to: '.', method: '_on_ready' },
    ]);
  });

  it('rejects scenes without a root or with dangling parents', () => {
    expect(() => parseSceneFile('[gd_scene format=3]')).toThrow(SceneFormatError);
    expect(() =>
      parseSceneFile('[node name="A" type="Node"]\n[node name="B" type="Node" parent="X"]'),
    ).toThrow(/unknown parent "X"/);
  });
});

describe('renderScene', () => {
  it('renders the demo scene compactly', () => {
    const scene = parseSceneFile(readDemo('scenes/main.tscn'));
    expect(renderScene(scene, ALL)).toBe(
      [
        'Main (Node3D)',
        '├─ Sun (DirectionalLight3D)  pos=(0, 10, 0) rotated/scaled  shadow_enabled=true',
        '├─ Camera3D (Camera3D)  pos=(0, 6, 8) rotated/scaled  current=true',
        '├─ Floor (StaticBody3D)  pos=(0, -0.5, 0)',
        '│  ├─ CollisionShape3D (CollisionShape3D)  shape=BoxShape3D(size=Vector3(20, 1, 20))',
        '│  └─ MeshInstance3D (MeshInstance3D)  mesh=BoxMesh(size=Vector3(20, 1, 20))  surface_material_override/0=StandardMaterial3D(albedo_color=Color(0.35, 0.55, 0.35, 1))',
        '└─ Player [instance res://scenes/player.tscn]  pos=(0, 1, 0)',
      ].join('\n'),
    );
  });

  it('limits depth and starts from a subtree', () => {
    const scene = parseSceneFile(readDemo('scenes/main.tscn'));
    expect(renderScene(scene, { ...ALL, depth: 0 })).toBe(
      'Main (Node3D)\n… 6 more nodes (increase depth to see)',
    );
    expect(renderScene(scene, { depth: 1, includeProperties: false, from: 'Floor' })).toBe(
      [
        'Floor (StaticBody3D)',
        '├─ CollisionShape3D (CollisionShape3D)',
        '└─ MeshInstance3D (MeshInstance3D)',
      ].join('\n'),
    );
    expect(() => renderScene(scene, { ...ALL, from: 'Ghost' })).toThrow(/No node at path "Ghost"/);
  });

  it('shows scripts, instance type overrides, 2D transforms, long values and hides editor metadata', () => {
    const scene = parseSceneFile(
      [
        '[ext_resource type="Script" path="res://p.gd" id="1"]',
        '[ext_resource type="PackedScene" path="res://e.tscn" id="2"]',
        '[node name="Root" type="Node2D"]',
        'script = ExtResource("1")',
        'transform = Transform2D(1, 0, 0, 1, 5, 6)',
        'metadata/_edit_lock_ = true',
        `text = "${'x'.repeat(100)}"`,
        'missing = ExtResource("9")',
        'sub = SubResource("nope")',
        '[node name="E" parent="." instance=ExtResource("2")]',
        '[node name="T" type="Area2D" parent="." instance=ExtResource("2")]',
      ].join('\n'),
    );
    const lines = renderScene(scene, ALL).split('\n');
    expect(lines[0]).toMatch(
      /^Root \(Node2D\) {2}script=res:\/\/p\.gd {2}pos=\(5, 6\) {2}text="x+… {2}missing=ExtResource\("9"\) {2}sub=SubResource\("nope"\)$/,
    );
    expect(lines[0]).not.toContain('_edit_lock_');
    expect(lines[1]).toBe('├─ E [instance res://e.tscn]');
    expect(lines[2]).toBe('└─ T [instance res://e.tscn]  type=Area2D');
  });
});
