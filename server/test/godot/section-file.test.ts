import { describe, expect, it } from 'vitest';

import { getProp, parseSectionFile, SectionFileError } from '../../src/godot/section-file.js';

describe('parseSectionFile', () => {
  it('parses headerless props, sections, attributes and multi-line values', () => {
    const sections = parseSectionFile(
      [
        '; comment',
        'config_version=5',
        '',
        '[gd_scene load_steps=2 format=3 uid="uid://abc"]',
        '',
        '[node name="Main" type="Node3D"]',
        'transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0)',
        'surface_material_override/0 = {',
        '"a": 1',
        '}',
        '"quoted key" = 3',
      ].join('\n'),
    );
    expect(sections.map((s) => s.tag)).toEqual(['', 'gd_scene', 'node']);
    expect(getProp(sections[0], 'config_version')).toBe(5);
    expect(sections[1]?.attrs).toEqual({ load_steps: 2, format: 3, uid: 'uid://abc' });
    expect(sections[1]?.line).toBe(4);
    const node = sections[2];
    expect(node?.props.map((p) => p.key)).toEqual([
      'transform',
      'surface_material_override/0',
      'quoted key',
    ]);
    expect(node?.props[1]?.raw).toBe('{\n"a": 1\n}');
    expect(getProp(node, 'missing')).toBeUndefined();
    expect(getProp(undefined, 'x')).toBeUndefined();
  });

  it('parses connection headers with array attributes', () => {
    const [conn] = parseSectionFile(
      '[connection signal="body_entered" from="Area" to="." method="_on" binds=[1]]',
    );
    expect(conn?.attrs).toEqual({
      signal: 'body_entered',
      from: 'Area',
      to: '.',
      method: '_on',
      binds: [1],
    });
  });

  it('reports the line of malformed input', () => {
    expect(() => parseSectionFile('[a]\nnot a property\n')).toThrow(SectionFileError);
    expect(() => parseSectionFile('[a]\nnot a property\n')).toThrow(/line 2/);
    expect(() => parseSectionFile('[a]\nx = [1, 2\n')).toThrow(/line 2/);
    expect(() => parseSectionFile('[node name]')).toThrow(/Malformed section header/);
  });
});
