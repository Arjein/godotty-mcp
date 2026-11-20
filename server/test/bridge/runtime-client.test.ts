import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BridgeServer } from '../../src/bridge/bridge-server.js';
import {
  editorClient,
  runtimeClient,
  type RuntimeClient,
} from '../../src/bridge/runtime-client.js';
import type { GameManager } from '../../src/godot/game.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';

describe('RuntimeClient', () => {
  let bridge: BridgeServer;
  let peer: FakeRuntime;
  let running: boolean;
  let client: RuntimeClient;

  beforeEach(async () => {
    bridge = new BridgeServer();
    running = true;
    client = runtimeClient(bridge, {
      get isRunning() {
        return running;
      },
    } as unknown as GameManager);
    peer = new FakeRuntime({
      tree: () => ({ result: { ok: true } }),
      screenshot: () => ({ error: { code: 'HEADLESS', message: 'headless' } }),
      get_props: () => ({ error: { code: 'MYSTERY', message: 'odd' } }),
    });
    await peer.connect(await bridge.listen(), { token: bridge.tokenFor('runtime') });
  });

  afterEach(() => {
    peer.close();
    bridge.close();
  });

  it('calls methods on the connected helper', async () => {
    await expect(client.call('tree', { path: '', depth: 1, max_nodes: 1 }, 1000)).resolves.toEqual({
      ok: true,
    });
  });

  it('maps remote errors to actionable tool errors', async () => {
    await expect(
      client.call('screenshot', { max_size: 1, count: 1, interval_ms: 0 }, 1000),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      hint: expect.stringContaining('headless=false') as string,
    });
    await expect(
      client.call('get_props', { path: '', names: [], filter: '', max: 1 }, 1000),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'odd', hint: undefined });
  });

  it('explains when no game runs or the helper is missing', async () => {
    running = false;
    await expect(client.call('tree', { path: '', depth: 1, max_nodes: 1 }, 1000)).rejects.toThrow(
      /No game is running/,
    );
    running = true;
    peer.close();
    await expect.poll(() => bridge.peer('runtime')).toBeUndefined();
    const quick = runtimeClient(bridge, { isRunning: true } as unknown as GameManager);
    const started = Date.now();
    await expect(quick.call('tree', { path: '', depth: 1, max_nodes: 1 }, 1000)).rejects.toThrow(
      /runtime helper is not connected/,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
  }, 10_000);
});

describe('editorClient', () => {
  it('explains how to connect the editor when its plugin is absent', async () => {
    const bridge = new BridgeServer();
    const client = editorClient(bridge);
    expect(client.isConnected).toBe(false);
    await expect(
      client.call('tree', { path: '', depth: 1, max_nodes: 1 }, 1000),
    ).rejects.toMatchObject({
      code: 'EDITOR_NOT_CONNECTED',
      hint: expect.stringContaining('Project Settings → Plugins') as string,
    });
    bridge.close();
  });
});
