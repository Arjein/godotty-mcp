import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DocsStore, type ApiIndex } from '../../../src/godot/docs/docs-store.js';
import {
  ancestry,
  enumShortName,
  findClass,
  nameScore,
  resolve,
  search,
} from '../../../src/godot/docs/lookup.js';
import { GodotExecutable } from '../../../src/godot/executable.js';
import { fakeGodot } from '../../helpers/fake-godot.js';

describe('lookup', () => {
  let cacheRoot: string;
  let index: ApiIndex;

  beforeAll(async () => {
    cacheRoot = mkdtempSync(path.join(tmpdir(), 'godotty-lookup-'));
    const docs = new DocsStore({
      godot: new GodotExecutable('godot', fakeGodot().spawner),
      cacheRoot,
      fetchText: () => Promise.resolve(undefined),
      offline: true,
    });
    index = await docs.api();
  });

  afterAll(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('resolves classes exactly or case-insensitively', () => {
    expect(resolve(index, 'Node3D', 5)).toMatchObject({ kind: 'class', cls: { name: 'Node3D' } });
    expect(resolve(index, ' characterbody3d ', 5)).toMatchObject({
      kind: 'class',
      cls: { name: 'CharacterBody3D' },
    });
    expect(findClass(index, 'nope')).toBeUndefined();
  });

  it('resolves members on the class or the nearest ancestor', () => {
    const own = resolve(index, 'CharacterBody3D.move_and_slide()', 5);
    expect(own).toMatchObject({ kind: 'member', owner: { name: 'CharacterBody3D' } });
    const inherited = resolve(index, 'CharacterBody3D::add_child', 5);
    expect(inherited).toMatchObject({
      kind: 'member',
      cls: { name: 'CharacterBody3D' },
      owner: { name: 'Node' },
    });
    expect(resolve(index, 'node.ADD_CHILD', 5)).toMatchObject({
      kind: 'member',
      owner: { name: 'Node' },
    });
    expect(resolve(index, 'Node3D.free', 5)).toMatchObject({
      kind: 'member',
      owner: { name: 'Object' },
    });
  });

  it('resolves enums by short name', () => {
    const result = resolve(index, 'CharacterBody3D.ProcessMode', 5);
    expect(result.kind).toBe('enum');
    if (result.kind === 'enum') {
      expect(result.owner.name).toBe('Node');
      expect(result.enumDoc.constants.map((c) => c.name)).toEqual([
        'PROCESS_MODE_INHERIT',
        'PROCESS_MODE_ALWAYS',
      ]);
    }
    expect(enumShortName('Node.ProcessMode')).toBe('ProcessMode');
  });

  it('searches within a class chain when the member is unknown, else globally', () => {
    const scoped = resolve(index, 'CharacterBody3D.slide', 5);
    expect(scoped.kind).toBe('search');
    if (scoped.kind === 'search') expect(scoped.hits[0]?.member?.name).toBe('move_and_slide');
    const global = resolve(index, 'lerp', 5);
    if (global.kind === 'search')
      expect(global.hits[0]).toMatchObject({
        cls: { name: '@GlobalScope' },
        member: { name: 'lerp' },
      });
    const annotation = resolve(index, '@export_range', 5);
    if (annotation.kind === 'search')
      expect(annotation.hits[0]?.member?.name).toBe('@export_range');
    expect(resolve(index, 'Unknown.thing', 5).kind).toBe('search');
  });

  it('ranks classes, demotes deprecated members, and skips operators/constructors', () => {
    const hits = search(index, 'node', 10);
    expect(hits[0]).toMatchObject({ cls: { name: 'Node' }, member: undefined });
    expect(
      search(index, 'print', 10)
        .map((h) => h.member?.name)
        .slice(0, 2),
    ).toEqual(['print', 'print_tree_old']);
    expect(search(index, 'operator', 10)).toEqual([]);
    expect(search(index, '', 10)).toEqual([]);
    expect(search(index, 'zzzz', 10)).toEqual([]);
  });

  it('scores name matches', () => {
    expect(nameScore('move_and_slide', 'move_and_slide')).toBeGreaterThan(
      nameScore('move_and_slide', 'move'),
    );
    expect(nameScore('move_and_slide', 'move')).toBeGreaterThan(
      nameScore('move_and_slide', 'slide'),
    );
    expect(nameScore('move_and_slide', 'slide')).toBeGreaterThan(
      nameScore('move_and_slide', 'lide'),
    );
    expect(nameScore('move_and_slide', 'lide')).toBeGreaterThan(
      nameScore('move_and_slide', 'mvsld'),
    );
    expect(nameScore('move_and_slide', 'mvsld')).toBeGreaterThan(0);
    expect(nameScore('move_and_slide', 'ms')).toBe(0);
  });

  it('walks ancestry nearest first', () => {
    const cls = findClass(index, 'CharacterBody3D');
    expect(cls && ancestry(index, cls).map((c) => c.name)).toEqual([
      'CharacterBody3D',
      'Node3D',
      'Node',
      'Object',
    ]);
  });
});
