import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { memberKey, parseClassXml } from '../../../src/godot/docs/class-xml.js';
import { DOC_FIXTURES } from '../../helpers/fake-docs.js';

const read = (relative: string) =>
  parseClassXml(readFileSync(path.join(DOC_FIXTURES, relative), 'utf8'), relative);

describe('parseClassXml', () => {
  it('parses signatures with ordered params, enum types, qualifiers and flags', () => {
    const { api } = read('doc/classes/Node.xml');
    expect(api).toMatchObject({
      name: 'Node',
      inherits: 'Object',
      sourcePath: 'doc/classes/Node.xml',
      deprecated: false,
    });
    const addChild = api.members.find((m) => m.name === 'add_child');
    expect(addChild).toMatchObject({ kind: 'method', type: 'void', overload: 0 });
    expect(addChild?.params).toEqual([
      { name: 'node', type: 'Node', default: undefined },
      { name: 'force_readable_name', type: 'bool', default: 'false' },
      { name: 'internal', type: 'Node.InternalMode', default: '0' },
    ]);
    expect(api.members.find((m) => m.name === 'get_child')?.qualifiers).toBe('const');
    expect(api.members.find((m) => m.name === 'print_tree_old')?.deprecated).toBe(true);
    expect(api.members.find((m) => m.name === 'process_mode')).toMatchObject({
      kind: 'property',
      type: 'Node.ProcessMode',
      value: '0',
    });
    expect(api.members.find((m) => m.name === 'PROCESS_MODE_ALWAYS')).toMatchObject({
      kind: 'constant',
      value: '3',
      enumName: 'ProcessMode',
      type: undefined,
    });
    expect(api.members.find((m) => m.name === 'ready')?.kind).toBe('signal');
  });

  it('extracts description text keyed by member, keeping indentation for dedent', () => {
    const { text } = read('doc/classes/Node.xml');
    expect(text.brief).toBe('\t\tBase class for all scene objects.');
    expect(text.tutorials[0]).toEqual({
      title: 'Nodes and scenes',
      url: '$DOCS_URL/getting_started/step_by_step/nodes_and_scenes.html',
    });
    expect(text.members['method:add_child']).toContain('[codeblocks]');
    expect(text.members['property:name']).toContain('The name of the node.');
    expect(text.members['constant:PROCESS_MODE_ALWAYS']).toContain('Always processes.');
    expect(text.members['method:print_tree_old']).toBeUndefined();
  });

  it('handles constructors (renamed for the XML parser), overloads and operators', () => {
    const { api, text } = read('doc/classes/Vector3.xml');
    const ctors = api.members.filter((m) => m.kind === 'constructor');
    expect(ctors.map((c) => [c.overload, c.params.length])).toEqual([
      [0, 0],
      [1, 3],
    ]);
    expect(
      text.members[memberKey(ctors[0] ?? { kind: 'constructor', name: '', overload: 0 })],
    ).toContain('default-initialized');
    expect(text.members['constructor:Vector3#1']).toContain('given components');
    expect(api.members.find((m) => m.kind === 'operator')?.name).toBe('operator +');
    expect(api.members.find((m) => m.name === 'ZERO')?.value).toBe('Vector3(0, 0, 0)');
  });

  it('reads class flags and annotations', () => {
    expect(read('doc/classes/CharacterBody3D.xml').api.experimental).toBe(true);
    const annotation = read('modules/gdscript/doc_classes/@GDScript.xml').api.members[0];
    expect(annotation).toMatchObject({
      kind: 'annotation',
      name: '@export_range',
      qualifiers: 'vararg',
    });
  });

  it('rejects non-class XML', () => {
    expect(() => parseClassXml('<html></html>', 'x.xml')).toThrow(/not a class reference/);
  });
});
