import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixtureFetcher } from '../helpers/fake-docs.js';
import { fakeGodot } from '../helpers/fake-godot.js';
import { makeTempProject } from '../helpers/tmp-project.js';
import { connectTools, type ToolClient } from '../helpers/tool-client.js';

describe('godot_docs', () => {
  let project: ReturnType<typeof makeTempProject>;
  let cacheRoot: string;
  let tools: ToolClient;

  beforeEach(async () => {
    project = makeTempProject();
    cacheRoot = mkdtempSync(path.join(tmpdir(), 'godotty-docs-tool-'));
    tools = await connectTools(
      project.root,
      fakeGodot().spawner,
      {},
      { cacheRoot, fetchText: fixtureFetcher('4.7.2-stable').fetchText },
    );
  });

  afterEach(async () => {
    await tools.close();
    project.cleanup();
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  const docs = async (args: Record<string, unknown>): Promise<string> =>
    (await tools.call('godot_docs', args)).text;

  it('shows a class overview', async () => {
    const text = await docs({ query: 'Node' });
    expect(text).toContain('Godot 4.7.2.stable docs — class Node');
    expect(text).toContain('Inherits: Object');
    expect(text).toContain('Inherited by: Node3D');
    expect(text).toContain('Base class for all scene objects.');
    expect(text).toContain('A tree of nodes is called a *scene*.');
    expect(text).toContain('Methods (3): add_child, get_child, print_tree_old');
    expect(text).toContain('Properties (2): name, process_mode');
    expect(text).toContain('Signals (1): ready');
    expect(text).toContain(
      'Constants (3): enum ProcessMode {PROCESS_MODE_INHERIT, PROCESS_MODE_ALWAYS}, NOTIFICATION_READY',
    );
    expect(text).toContain(
      'Tutorials: Nodes and scenes (https://docs.godotengine.org/en/4.7/getting_started/step_by_step/nodes_and_scenes.html); T2 (https://example.com/2); T3 (https://example.com/3); +1 more',
    );
  });

  it('flags experimental classes and lists constructors in overviews', async () => {
    expect(await docs({ query: 'CharacterBody3D' })).toContain(
      'class CharacterBody3D [experimental]\nInherits: Node3D < Node < Object',
    );
    expect(await docs({ query: 'Vector3' })).toContain(
      'Methods (3): Vector3(), Vector3(), operator +',
    );
  });

  it('lists a section with signatures and one-line summaries, paginated', async () => {
    const methods = await docs({ query: 'Node', section: 'methods', limit: 2 });
    expect(methods).toBe(
      [
        'Godot 4.7.2.stable docs — Node methods (3), showing 1–2:',
        'add_child(node: Node, force_readable_name: bool = false, internal: Node.InternalMode = 0) -> void — Adds a child `node`.',
        'get_child(idx: int) -> Node [const] — Returns a child node by its index.',
        'More: call again with offset=2.',
      ].join('\n'),
    );
    expect(await docs({ query: 'Node', section: 'methods', offset: 2 })).toContain(
      'print_tree_old() -> void [deprecated]',
    );
    expect(await docs({ query: 'Node', section: 'properties' })).toContain(
      'process_mode: Node.ProcessMode = 0 — The node',
    );
    expect(await docs({ query: 'Node', section: 'signals' })).toContain(
      'signal ready() — Emitted when the node is ready.',
    );
    expect(await docs({ query: 'Node', section: 'constants' })).toContain(
      '[ProcessMode] PROCESS_MODE_ALWAYS = 3 — Always processes.',
    );
    expect(await docs({ query: 'Node3D', section: 'signals' })).toContain(
      'Node3D declares no signals',
    );
    const ctors = await docs({ query: 'Vector3', section: 'methods' });
    expect(ctors).toContain('Vector3() — Constructs a default-initialized Vector3.');
    expect(ctors).toContain(
      'Vector3(x: float, y: float, z: float) — Returns a Vector3 with the given components.',
    );
    expect(ctors).toContain('operator +(right: Vector3) -> Vector3 — Adds each component.');
  });

  it('shows member details, including inherited ones, as Markdown', async () => {
    const own = await docs({ query: 'CharacterBody3D.velocity' });
    expect(own).toBe(
      'Godot 4.7.2.stable docs — CharacterBody3D.velocity (property)\nvelocity: Vector3 = Vector3(0, 0, 0)\n\nCurrent velocity vector.',
    );
    const inherited = await docs({ query: 'CharacterBody3D.add_child' });
    expect(inherited).toContain('Inherited by CharacterBody3D from Node.');
    expect(inherited).toContain('Adds a child `node`. See `remove_child()`.');
    expect(inherited).toContain('```gdscript\nvar child = Node.new()\nadd_child(child)\n```');
    expect(inherited).not.toContain('AddChild');
    expect(await docs({ query: '@GlobalScope.print' })).toContain('print(...) -> void [vararg]');
    expect(await docs({ query: '@GDScript.@export_range' })).toContain(
      '@export_range(min: float, max: float, ...)',
    );
    expect(await docs({ query: 'Vector3.ZERO' })).toContain('ZERO = Vector3(0, 0, 0)');
  });

  it('shows enums with values and summaries', async () => {
    expect(await docs({ query: 'Node3D.ProcessMode' })).toBe(
      [
        'Godot 4.7.2.stable docs — enum Node.ProcessMode',
        'Inherited by Node3D from Node.',
        "PROCESS_MODE_INHERIT = 0 — Inherits `process_mode` from the node's parent.",
        'PROCESS_MODE_ALWAYS = 3 — Always processes.',
      ].join('\n'),
    );
  });

  it('searches and explains misses', async () => {
    expect(await docs({ query: 'slide' })).toBe(
      'Godot 4.7.2.stable docs — best match for "slide":\nCharacterBody3D.move_and_slide (method): move_and_slide() -> bool\nQuery "Class.member" for the full description.',
    );
    expect(await docs({ query: 'child' })).toMatch(
      /2 best matches for "child":\nNode\.add_child \(method\)/,
    );
    expect(await docs({ query: 'xyzzy' })).toContain('nothing matches "xyzzy"');
    expect(await docs({ query: 'nod' })).toContain('class Node');
  });

  it('notes missing descriptions when offline', async () => {
    const offline = await connectTools(
      project.root,
      fakeGodot().spawner,
      { offline: true },
      { cacheRoot: mkdtempSync(path.join(tmpdir(), 'godotty-off-')) },
    );
    const text = (await offline.call('godot_docs', { query: 'Node' })).text;
    expect(text).toContain('Description text unavailable');
    expect(text).toContain('Methods (3)');
    expect((await offline.call('godot_docs', { query: 'Node.add_child' })).text).toContain(
      'Description text unavailable',
    );
    expect((await offline.call('godot_docs', { query: 'Node.ProcessMode' })).text).toContain(
      'Description text unavailable',
    );
    expect(
      (await offline.call('godot_docs', { query: 'Node', section: 'methods' })).text,
    ).toContain('Description text unavailable');
    await offline.close();
  });
});
