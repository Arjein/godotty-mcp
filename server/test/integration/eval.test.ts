import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './harness.js';

describe('eval_gdscript enabled (--allow-eval)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({}, { allowEval: true });
    await h.call('run_game', { headless: true });
  });

  afterAll(async () => {
    await h.close();
  });

  it('is listed and returns values from the running game', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toContain('eval_gdscript');
    expect((await h.call('eval_gdscript', { code: 'return scene.name' })).text).toBe(
      'Returned: &"Main"',
    );
    expect(
      (await h.call('eval_gdscript', { code: 'await tree.process_frame\nreturn 6 * 7' })).text,
    ).toBe('Returned: 42');
    expect((await h.call('eval_gdscript', { code: 'return scene.get_node("Player")' })).text).toBe(
      'Returned: <CharacterBody3D /root/Main/Player>',
    );
    expect(
      (await h.call('eval_gdscript', { code: 'scene.get_node("Player").visible = false' })).text,
    ).toBe('Returned: null');
  });

  it('reports parse errors and runtime errors with line numbers of the code', async () => {
    const parse = await h.call('eval_gdscript', { code: 'var a = 1\nreturn undefined_thing' });
    expect(parse.isError).toBe(true);
    expect(parse.text).toContain('line 2: Parse Error: Identifier "undefined_thing" not declared');
    const runtime = await h.call('eval_gdscript', { code: 'var n: Node = null\nreturn n.name' });
    expect(runtime.text).toMatch(
      /^Returned: null\nErrors while running:\n {2}line 2: .*'name'.*Nil/,
    );
  });

  it('allows Object/Resource literals in values when eval is on', async () => {
    const set = await h.call('set_node_property', {
      node: 'Player',
      properties: { script: 'Resource("res://scripts/player.gd")' },
    });
    expect(set.isError).toBe(false);
  });
});

describe('without --allow-eval', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    await h.call('run_game', { headless: true });
  });

  afterAll(async () => {
    await h.close();
  });

  it('does not list eval_gdscript', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('eval_gdscript');
  });

  it('refuses eval inside the game too (second lock, bypassing the server)', async () => {
    await expect(
      h.server.services.runtime.call('eval', { code: 'return 1' }, 5000),
    ).rejects.toMatchObject({ code: 'DISABLED' });
  });

  it('refuses Object/Resource literals that could load and run scripts', async () => {
    const viaServer = await h.call('set_node_property', {
      node: 'Player',
      properties: { script: 'Resource("res://scripts/player.gd")' },
    });
    expect(viaServer.isError).toBe(true);
    expect(viaServer.text).toContain('Object/Resource literals are not allowed');
    // The Godot side refuses on its own as well.
    await expect(
      h.server.services.runtime.call(
        'set_props',
        { path: 'Player', values: { script: 'Resource("res://scripts/player.gd")' } },
        5000,
      ),
    ).rejects.toThrow(/Object\/Resource literals are not allowed/);
    await expect(
      h.server.services.runtime.call(
        'wait',
        { until: { node: 'Player', property: 'visible', value: 'Object(Node)' }, timeout_s: 1 },
        5000,
      ),
    ).rejects.toThrow(/not allowed/);
  });
});
