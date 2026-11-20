import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './harness.js';

/** A uniform frame (e.g. a camera facing empty sky) compresses to a few KB; the demo scene doesn't. */
const MIN_SCENE_PNG_BYTES = 5_000;

async function callRaw(
  h: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await h.client.callTool({ name, arguments: args })) as CallToolResult;
}

function images(result: CallToolResult): { data: string; mimeType: string }[] {
  return result.content.filter(
    (c): c is { type: 'image'; data: string; mimeType: string } => c.type === 'image',
  );
}

function playerX(text: string): number {
  const match = /position: Vector3 = Vector3\(([-\d.e]+),/.exec(text);
  if (match === null) throw new Error(`no position in: ${text}`);
  return Number(match[1]);
}

describe('see and play the running game (windowed)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    const started = await h.call('run_game', { headless: false });
    expect(started.text).toContain('Runtime helper: ready');
  });

  afterAll(async () => {
    await h.close();
  });

  it('takes a screenshot of the rendered scene', async () => {
    const result = await callRaw(h, 'screenshot', { max_size: 640 });
    expect(result.isError).not.toBe(true);
    const [shot] = images(result);
    expect(shot?.mimeType).toBe('image/png');
    expect(JSON.stringify(result.content[0])).toContain('Screenshot (640×360)');
    expect(Buffer.from(shot?.data ?? '', 'base64').length).toBeGreaterThan(MIN_SCENE_PNG_BYTES);
  });

  it('captures frame sequences', async () => {
    const result = await callRaw(h, 'screenshot', { max_size: 320, count: 3, interval_ms: 100 });
    expect(images(result)).toHaveLength(3);
  });

  it('moves the player with input, observed via live properties', async () => {
    await h.call('wait', {
      node: 'Player',
      property: 'velocity:y',
      op: '>=',
      value: '0',
      timeout_s: 5,
    });
    const before = playerX(
      (await h.call('get_node_properties', { node: 'Player', properties: ['position'] })).text,
    );
    const input = await callRaw(h, 'send_input', {
      steps: [{ type: 'action', action: 'move_right', mode: 'hold', duration_ms: 600 }],
      screenshot_after: true,
      max_size: 320,
    });
    expect(JSON.stringify(input.content[0])).toMatch(/Performed 1 step\(s\) in \d+ ms/);
    expect(images(input)).toHaveLength(1);
    const after = playerX(
      (await h.call('get_node_properties', { node: 'Player', properties: ['position'] })).text,
    );
    expect(after - before).toBeGreaterThan(1.5);
  });

  it('presses keys bound to actions', async () => {
    const before = playerX(
      (await h.call('get_node_properties', { node: '/root/Main/Player', properties: ['position'] }))
        .text,
    );
    await h.call('send_input', {
      steps: [{ type: 'key', key: 'A', mode: 'hold', duration_ms: 400 }],
    });
    const after = playerX(
      (await h.call('get_node_properties', { node: '/root/Main/Player', properties: ['position'] }))
        .text,
    );
    expect(after).toBeLessThan(before - 1);
  });

  it('waits for conditions and reports timeouts', async () => {
    await h.call('set_node_property', {
      node: 'Player',
      properties: { position: 'Vector3(0, 4, 0)' },
    });
    const landed = await h.call('wait', {
      node: 'Player',
      property: 'position:y',
      op: '<',
      value: '1.2',
      timeout_s: 10,
    });
    expect(landed.text).toMatch(/^Condition met after [\d.]+s \(\d+ frames\); position:y = /);
    const never = await h.call('wait', {
      node: 'Player',
      property: 'position:y',
      op: '>',
      value: '100',
      timeout_s: 0.3,
    });
    expect(never.text).toMatch(/^Timed out after/);
    expect((await h.call('wait', { frames: 5 })).text).toMatch(/^Waited [\d.]+s \(\d+ frames\)\./);
    expect((await h.call('wait', { node: 'Enemy', timeout_s: 0.2 })).text).toMatch(/^Timed out/);
  });

  it('shows the live tree without the helper itself', async () => {
    const { text } = await h.call('inspect_scene_tree');
    expect(text).toContain('Live tree at /root (current scene: /root/Main)');
    expect(text).toMatch(
      /Player \(CharacterBody3D\) {2}script=res:\/\/scripts\/player\.gd {2}pos=\(/,
    );
    expect(text).not.toContain('GodottyRuntime');
    const shallow = await h.call('inspect_scene_tree', { node: 'Floor', depth: 0 });
    expect(shallow.text).toContain('Floor (StaticBody3D)  pos=(0, -0.5, 0)\n└─ … 2 more children');
  });

  it('lists, filters, sets and validates properties', async () => {
    const listed = await h.call('get_node_properties', { node: 'Player', filter: 'floor' });
    expect(listed.text).toMatch(
      /^\/root\/Main\/Player \(CharacterBody3D, script res:\/\/scripts\/player\.gd\) — \d+ properties/,
    );
    expect(listed.text).toContain('floor_max_angle: float =');
    const set = await h.call('set_node_property', {
      node: 'Player',
      properties: { visible: 'false' },
    });
    expect(set.text).toBe('Set on /root/Main/Player (live only):\nvisible = false');
    const badType = await h.call('set_node_property', {
      node: 'Player',
      properties: { visible: '"yes"' },
    });
    expect(badType.text).toContain('visible expects bool, got String');
    const badName = await h.call('get_node_properties', { node: 'Player', properties: ['nope'] });
    expect(badName.text).toContain('NOT_FOUND');
    const badNode = await h.call('get_node_properties', { node: 'Ghost' });
    expect(badNode.text).toContain("No node at 'Ghost'");
    const badAction = await h.call('send_input', { steps: [{ type: 'action', action: 'fly' }] });
    expect(badAction.text).toContain("No input action named 'fly'");
  });
});

describe('runtime tools without a rendering game', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('explains that a game must be running', async () => {
    const { text, isError } = await h.call('screenshot');
    expect(isError).toBe(true);
    expect(text).toContain('No game is running');
  });

  it('refuses screenshots of headless runs instead of hanging, while input still works', async () => {
    await h.call('run_game', { headless: true });
    const shot = await h.call('screenshot');
    expect(shot.text).toContain('runs headless');
    expect(shot.text).toContain('headless=false');
    const input = await h.call('send_input', { steps: [{ type: 'action', action: 'jump' }] });
    expect(input.text).toMatch(/^Performed 1 step/);
    await h.call('stop_game');
    expect((await h.call('inspect_scene_tree')).text).toContain('No game is running');
  });
});
