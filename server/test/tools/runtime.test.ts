import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PORT_ARG, START_PAUSED_ARG, TOKEN_ENV } from '../../src/godot/game.js';
import { fakeGodot } from '../helpers/fake-godot.js';
import { FakeRuntime, type Handler } from '../helpers/fake-runtime.js';
import { makeTempProject } from '../helpers/tmp-project.js';
import { connectTools, type ToolClient } from '../helpers/tool-client.js';

const PNG = Buffer.from('fake-png').toString('base64');

const HANDLERS: Record<string, Handler> = {
  screenshot: (p) => ({
    result: { width: 640, height: 360, frames: Array.from({ length: Number(p.count) }, () => PNG) },
  }),
  input: (p) => ({
    result: {
      steps: (p.steps as unknown[]).length,
      elapsed_ms: 612,
      frames: 37,
      ...(p.observe === undefined
        ? {}
        : {
            observed: [
              { t_ms: 0, step: 0, name: 'HUD/Subtitle:text', value: '""' },
              { t_ms: 350, step: 2, name: 'HUD/Subtitle:text', value: '"Two falls."' },
            ],
            observed_truncated: true,
          }),
    },
  }),
  pause: (p) => ({
    result: {
      paused: p.paused,
      game_paused: false,
      time_scale: p.time_scale ?? 1,
      physics_frame: 120,
    },
  }),
  step: (p) => ({
    result: {
      paused: true,
      game_paused: true,
      time_scale: 1,
      physics_frame: 120 + Number(p.frames),
      frames: p.frames,
      elapsed_ms: 500,
    },
  }),
  controls: () => ({
    result: {
      path: '/root',
      total: 3,
      controls: [
        {
          path: '/root/Menu/Begin',
          class: 'Button',
          text: 'Begin the climb',
          rect: [520, 400, 240, 48],
          focused: true,
          disabled: false,
        },
        {
          path: '/root/Menu/Icon',
          class: 'TextureButton',
          text: '',
          rect: [10, 10, 32, 32],
          focused: false,
          disabled: true,
        },
      ],
    },
  }),
  press: (p) => ({
    result: {
      path: '/root/Menu/Begin',
      class: 'Button',
      text: 'Begin the climb',
      rect: [520, 400, 240, 48],
      focused: false,
      disabled: false,
      action: p.action,
      pressed: p.action !== 'click',
    },
  }),
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
  let gameArgs: readonly string[] = [];

  beforeEach(async () => {
    project = makeTempProject({ 'scenes/a.tscn': '' });
    runtime = new FakeRuntime(HANDLERS);
    tools = await connectTools(
      project.root,
      fakeGodot({
        onGame: (_proc, events, call) => {
          gameArgs = call.args;
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
    expect((await tools.call('pause_game')).text).toContain('No game is running');
  });

  it('starts the game paused on request', async () => {
    const { text } = await tools.call('run_game', { paused: true });
    expect(text).toContain('Paused: step_game');
    expect(gameArgs).toContain(START_PAUSED_ARG);
    const game = (await tools.call('run_game')).text;
    expect(game).not.toContain('Paused:');
    expect(gameArgs).not.toContain(START_PAUSED_ARG);
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

    it('reports values observed during an input batch', async () => {
      const observe = [{ node: 'HUD/Subtitle', property: 'text' }];
      const { text } = await tools.call('send_input', {
        steps: [{ type: 'wait', ms: 100 }],
        observe,
      });
      expect(text).toBe(
        [
          'Performed 1 step(s) in 612 ms (37 frames).',
          'Observed (2 value(s), first = before step 1):',
          '  +0 ms  step 0  HUD/Subtitle:text = ""',
          '  +350 ms  step 2  HUD/Subtitle:text = "Two falls."',
          '  … more changes not recorded; watch fewer values or use a shorter batch.',
        ].join('\n'),
      );
      expect(runtime.requests.at(-1)?.params.observe).toEqual(observe);
      await tools.call('send_input', { steps: [{ type: 'wait', ms: 1 }] });
      expect(runtime.requests.at(-1)?.params).not.toHaveProperty('observe');
    });

    it('pauses, resumes and steps the game', async () => {
      expect((await tools.call('pause_game')).text).toBe(
        'Game paused at physics frame 120. send_input/wait/press_control advance it and pause again; step_game advances exact frames.',
      );
      expect(runtime.requests.at(-1)).toEqual({ method: 'pause', params: { paused: true } });
      expect((await tools.call('pause_game', { paused: false, time_scale: 0.5 })).text).toBe(
        'Game running in real time (physics frame 120, time_scale 0.5).',
      );
      expect((await tools.call('step_game', { frames: 30 })).text).toBe(
        'Stepped 30 physics frame(s) in 500 ms; paused at physics frame 150; the game has also paused itself (its pause menu?).',
      );
      expect((await tools.call('step_game', { frames: 0 })).isError).toBe(true);
    });

    it('lists and presses UI controls', async () => {
      expect((await tools.call('list_controls')).text).toBe(
        [
          '2 of 3 visible control(s) under /root:',
          '"Begin the climb"  Button  /root/Menu/Begin  at (520, 400) 240×48  [focused]',
          '(no text)  TextureButton  /root/Menu/Icon  at (10, 10) 32×32  [disabled]',
          'More: raise max or pass a deeper node.',
        ].join('\n'),
      );
      expect((await tools.call('press_control', { text: 'begin', action: 'accept' })).text).toBe(
        'Accepted "Begin the climb"  Button  /root/Menu/Begin  at (520, 400) 240×48.',
      );
      expect(runtime.requests.at(-1)?.params).toEqual({ text: 'begin', action: 'accept' });
      expect((await tools.call('press_control', { node: 'Menu/Begin' })).text).toContain(
        'did not emit pressed',
      );
      const both = await tools.call('press_control', { node: 'Menu/Begin', text: 'Begin' });
      expect(both.text).toContain('exactly one of text or node');
      expect((await tools.call('press_control', {})).isError).toBe(true);
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
