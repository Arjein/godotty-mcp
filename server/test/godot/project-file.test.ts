import { describe, expect, it } from 'vitest';

import { describeInputEvent, parseProjectFile } from '../../src/godot/project-file.js';
import { parseVariant, type GdObject } from '../../src/godot/variant.js';
import { readDemo } from '../helpers/demo.js';

const event = (text: string): GdObject => parseVariant(text) as GdObject;

describe('parseProjectFile', () => {
  it('reads the demo project', () => {
    const project = parseProjectFile(readDemo('project.godot'));
    expect(project).toMatchObject({
      name: 'godotty-mcp demo',
      mainScene: 'res://scenes/main.tscn',
      features: ['4.5', 'GL Compatibility'],
      renderer: 'gl_compatibility',
      autoloads: [],
      enabledPlugins: [],
    });
    expect(project.inputActions).toEqual([
      { name: 'move_left', deadzone: 0.2, events: ['A (physical)'] },
      { name: 'move_right', deadzone: 0.2, events: ['D (physical)'] },
      { name: 'move_forward', deadzone: 0.2, events: ['W (physical)'] },
      { name: 'move_back', deadzone: 0.2, events: ['S (physical)'] },
      { name: 'jump', deadzone: 0.2, events: ['SPACE (physical)'] },
    ]);
  });

  it('reads autoloads and enabled plugins', () => {
    const project = parseProjectFile(
      [
        '[autoload]',
        'Global="*res://global.gd"',
        'Helper="res://helper.tscn"',
        'Broken=3',
        '[editor_plugins]',
        'enabled=PackedStringArray("res://addons/gut/plugin.cfg")',
      ].join('\n'),
    );
    expect(project.autoloads).toEqual([
      { name: 'Global', path: 'res://global.gd', singleton: true },
      { name: 'Helper', path: 'res://helper.tscn', singleton: false },
    ]);
    expect(project.enabledPlugins).toEqual(['res://addons/gut/plugin.cfg']);
    expect(project.name).toBeUndefined();
  });

  it('tolerates odd input map entries', () => {
    const project = parseProjectFile('[input]\nweird=3\nempty={"deadzone": 0.5}');
    expect(project.inputActions).toEqual([
      { name: 'weird', deadzone: undefined, events: [] },
      { name: 'empty', deadzone: 0.5, events: [] },
    ]);
  });
});

describe('describeInputEvent', () => {
  it.each([
    ['Object(InputEventKey,"keycode":83,"ctrl_pressed":true,"shift_pressed":true)', 'Ctrl+Shift+S'],
    ['Object(InputEventKey,"keycode":4194305)', 'ESCAPE'],
    ['Object(InputEventKey,"key_label":65)', 'A'],
    ['Object(InputEventKey,"keycode":123456789)', '#123456789'],
    ['Object(InputEventMouseButton,"button_index":1,"alt_pressed":true)', 'Alt+Mouse LEFT'],
    ['Object(InputEventJoypadButton,"button_index":0)', 'Joy A'],
    ['Object(InputEventJoypadMotion,"axis":0,"axis_value":-1.0)', 'Joy LEFT_X-'],
    ['Object(InputEventJoypadMotion,"axis":1,"axis_value":1.0)', 'Joy LEFT_Y+'],
    ['Object(InputEventScreenTouch)', 'InputEventScreenTouch'],
  ])('%s → %s', (text, expected) => {
    expect(describeInputEvent(event(text))).toBe(expected);
  });
});
