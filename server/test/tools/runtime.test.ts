import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PORT_ARG, TOKEN_ENV } from '../../src/godot/game.js';
import { fakeGodot } from '../helpers/fake-godot.js';
import { FakeRuntime, type Handler } from '../helpers/fake-runtime.js';
import { makeTempProject } from '../helpers/tmp-project.js';
import { connectTools, type ToolClient } from '../helpers/tool-client.js';

const PNG = Buffer.from('fake-png').toString('base64');

const HANDLERS: Record<string, Handler> = {
  screenshot: (p) => ({
    result: { width: 640, height: 360, frames: Array.from({ length: Number(p.count) }, () => PNG) },
  }),
  input: (p) => ({ result: { steps: (p.steps as unknown[]).length, elapsed_ms: 612, frames: 37 } }),
  wait: (p) =>
    p.until === undefined
      ? { result: { met: true, elapsed_ms: 250, frames: 15 } }
      : {
          result: {
            met: (p.until as { value?: string }).value !== 'never',
            elapsed_ms: 1200,
            frames: 72,
            last_value: '0.5',
          },
        },
  tree: () => ({
    result: {
      path: '/root',
      current_scene: '/root/Main',
      truncated: true,
      root: {
        name: 'root',
        class: 'Window',
        children: [
          {
            name: 'Main',
            class: 'Node3D',
            children: [
              {
                name: 'Player',
                class: 'CharacterBody3D',
                script: 'res://p.gd',
                info: 'pos=(0, 1, 0)',
              },
            ],
            hidden_children: 2,
          },
        ],
      },
    },
  }),
  get_props: (p) => ({
    result: {
      path: '/root/Main/Player',
      class: 'CharacterBody3D',
      script: 'res://p.gd',
      total: (p.names as string[]).length > 0 ? 1 : 41,
      props: [{ name: 'position', type: 'Vector3', value: 'Vector3(0, 1, 0)' }],
    },
  }),
  set_props: () => ({
    result: {
      path: '/root/Main/Player',
      props: [{ name: 'visible', type: 'bool', value: 'false' }],
    },
  }),
};

describe('runtime tools', () => {
  let project: ReturnType<typeof makeTempProject>;
  let tools: ToolClient;
  let runtime: FakeRuntime;

  beforeEach(async () => {
    project = makeTempProject({ 'scenes/a.tscn': '' });
    runtime = new FakeRuntime(HANDLERS);
    tools = await connectTools(
      project.root,
      fakeGodot({
        onGame: (_proc, events, call) => {
          const port = Number(
            call.args.find((a) => a.startsWith(PORT_ARG))?.slice(PORT_ARG.length),
          );
          void runtime.connect(port, { token: call.env?.[TOKEN_ENV] ?? '' }).then(() => {
            events.ready();
          });
        },
      }).spawner,
    );
  });

  afterEach(async () => {
    runtime.close();
    await tools.close();
    project.cleanup();
  });

  it('requires a running game', async () => {
    expect((await tools.call('screenshot')).text).toContain('No game is running');
  });

  describe('with a running game', () => {
    beforeEach(async () => {
      expect((await tools.call('run_game')).text).toContain('Runtime helper: ready');
    });

    it('returns screenshots and frame sequences as images', async () => {
      const result = await tools.call('screenshot', { max_size: 640 });
      expect(result.text).toBe('Screenshot (640×360) of run #1.');
      expect(runtime.requests.at(-1)).toEqual({
        method: 'screenshot',
        params: { max_size: 640, count: 1, interval_ms: 250 },
      });
      const seq = await tools.call('screenshot', { count: 3, interval_ms: 100 });
      expect(seq.text).toBe('3 frames, 100 ms apart (640×360) of run #1.');
    });

    it('sends input steps and optionally screenshots afterwards', async () => {
      const steps = [
        { type: 'action', action: 'jump' },
        { type: 'wait', ms: 100 },
        { type: 'key', key: 'A', mode: 'hold', duration_ms: 300 },
      ];
      expect((await tools.call('send_input', { steps })).text).toBe(
        'Performed 3 step(s) in 612 ms (37 frames).',
      );
      expect(runtime.requests.at(-1)?.params.steps).toEqual([
        { type: 'action', action: 'jump', mode: 'tap' },
        { type: 'wait', ms: 100 },
        { type: 'key', key: 'A', mode: 'hold', duration_ms: 300 },
      ]);
      const withShot = await tools.call('send_input', {
        steps: [
          { type: 'mouse_motion', position: [10, 20] },
          { type: 'wait', frames: 2 },
        ],
        screenshot_after: true,
      });
      expect(withShot.text).toBe(
        'Performed 2 step(s) in 612 ms (37 frames).\nScreenshot (640×360) of run #1.',
      );
      expect((await tools.call('send_input', { steps: [{ type: 'teleport' }] })).isError).toBe(
        true,
      );
    });

    it('waits for frames, seconds or conditions', async () => {
      expect((await tools.call('wait', { frames: 10 })).text).toBe('Waited 0.25s (15 frames).');
      expect(
        (await tools.call('wait', { node: 'Player', property: 'position:y', op: '<', value: '1' }))
          .text,
      ).toBe('Condition met after 1.20s (72 frames); position:y = 0.5.');
      expect(
        (await tools.call('wait', { node: 'Player', property: 'position:y', value: 'never' })).text,
      ).toBe('Timed out after 1.20s (72 frames); condition not met; position:y = 0.5.');
      expect((await tools.call('wait', {})).text).toContain(
        'exactly one of frames, seconds, or node',
      );
      expect((await tools.call('wait', { frames: 1, seconds: 1 })).text).toContain('exactly one');
      await tools.call('wait', { seconds: 0.5 });
      expect(runtime.requests.at(-1)?.params).toMatchObject({ seconds: 0.5 });
    });

    it('renders the live tree with hidden-children and truncation notes', async () => {
      expect((await tools.call('inspect_scene_tree', { max_nodes: 3 })).text).toBe(
        [
          'Live tree at /root (current scene: /root/Main)',
          'root (Window)',
          '└─ Main (Node3D)',
          '   ├─ Player (CharacterBody3D)  script=res://p.gd  pos=(0, 1, 0)',
          '   └─ … 2 more children',
          '… stopped at 3 nodes; raise max_nodes or start from a deeper node.',
        ].join('\n'),
      );
    });

    it('reads and sets properties', async () => {
      expect((await tools.call('get_node_properties', { node: 'Player' })).text).toBe(
        '/root/Main/Player (CharacterBody3D, script res://p.gd) — 1 of 41 properties\nposition: Vector3 = Vector3(0, 1, 0)\nMore: raise limit or use filter.',
      );
      expect(
        (await tools.call('get_node_properties', { node: 'Player', properties: ['position'] }))
          .text,
      ).toBe(
        '/root/Main/Player (CharacterBody3D, script res://p.gd) — 1 properties\nposition: Vector3 = Vector3(0, 1, 0)',
      );
      expect(
        (
          await tools.call('set_node_property', {
            node: 'Player',
            properties: { visible: 'false' },
          })
        ).text,
      ).toBe('Set on /root/Main/Player (live only):\nvisible = false');
      expect(
        (await tools.call('set_node_property', { node: 'Player', properties: {} })).isError,
      ).toBe(true);
    });
  });
});
