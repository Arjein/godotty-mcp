import { afterEach, describe, expect, it } from 'vitest';

import { PORT_ARG, TOKEN_ENV, ALLOW_EVAL_ARG } from '../../src/godot/game.js';
import { fakeGodot } from '../helpers/fake-godot.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { makeTempProject } from '../helpers/tmp-project.js';
import { connectTools, type ToolClient } from '../helpers/tool-client.js';

describe('eval_gdscript tool', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function setup(
    allowEval: boolean,
  ): Promise<{ tools: ToolClient; runtime: FakeRuntime; gameArgs: () => readonly string[] }> {
    const project = makeTempProject();
    const runtime = new FakeRuntime({
      eval: (p) =>
        p.code === 'bad'
          ? { error: { code: 'EVAL_PARSE', message: 'line 1: Parse Error: x' } }
          : { result: { value: '42', errors: p.code === 'oops' ? ['line 2: boom'] : [] } },
      set_props: () => ({ result: { path: '/root/Main/P', props: [] } }),
    });
    let args: readonly string[] = [];
    const tools = await connectTools(
      project.root,
      fakeGodot({
        onGame: (_proc, events, call) => {
          args = call.args;
          const port = Number(
            call.args.find((a) => a.startsWith(PORT_ARG))?.slice(PORT_ARG.length),
          );
          void runtime.connect(port, { token: call.env?.[TOKEN_ENV] ?? '' }).then(() => {
            events.ready();
          });
        },
      }).spawner,
      { allowEval },
    );
    cleanups.push(
      () => {
        project.cleanup();
      },
      () => tools.close(),
      () => {
        runtime.close();
      },
    );
    return { tools, runtime, gameArgs: () => args };
  }

  it('is only registered with --allow-eval, which is also passed to the game', async () => {
    const off = await setup(false);
    await off.tools.call('run_game');
    expect(off.gameArgs()).not.toContain(ALLOW_EVAL_ARG);
    expect((await off.tools.call('eval_gdscript', { code: 'return 1' })).text).toMatch(
      /not found|Unknown tool|eval_gdscript/i,
    );

    const on = await setup(true);
    await on.tools.call('run_game');
    expect(on.gameArgs()).toContain(ALLOW_EVAL_ARG);
    expect((await on.tools.call('eval_gdscript', { code: 'return 42' })).text).toBe('Returned: 42');
    expect((await on.tools.call('eval_gdscript', { code: 'oops' })).text).toBe(
      'Returned: 42\nErrors while running:\n  line 2: boom',
    );
    const parse = await on.tools.call('eval_gdscript', { code: 'bad' });
    expect(parse.isError).toBe(true);
    expect(parse.text).toContain('line 1: Parse Error: x');
    expect(parse.text).toContain('use return to send back a value');
    // With eval on, Resource literals pass the server check.
    expect(
      (
        await on.tools.call('set_node_property', {
          node: 'P',
          properties: { script: 'Resource("res://a.gd")' },
        })
      ).isError,
    ).toBe(false);
  });

  it('runs in the editor with target=editor', async () => {
    const { tools } = await setup(true);
    expect(
      (await tools.call('eval_gdscript', { code: 'return 1', target: 'editor' })).text,
    ).toContain('EDITOR_NOT_CONNECTED');
  });
});
