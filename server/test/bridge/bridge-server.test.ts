import { connect } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BridgeServer, RemoteError } from '../../src/bridge/bridge-server.js';
import { ToolError } from '../../src/util/errors.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';

describe('BridgeServer', () => {
  let bridge: BridgeServer;
  let port: number;
  const peers: FakeRuntime[] = [];

  beforeEach(async () => {
    bridge = new BridgeServer();
    port = await bridge.listen();
  });

  afterEach(() => {
    for (const p of peers.splice(0)) p.close();
    bridge.close();
  });

  const runtime = (handlers: ConstructorParameters<typeof FakeRuntime>[0] = {}): FakeRuntime => {
    const peer = new FakeRuntime(handlers);
    peers.push(peer);
    return peer;
  };

  it('listens on loopback once and uses a random 256-bit token', async () => {
    expect(await bridge.listen()).toBe(port);
    expect(bridge.token).toMatch(/^[0-9a-f]{64}$/);
    expect(new BridgeServer().token).not.toBe(bridge.token);
  });

  it('welcomes a peer with the right token and routes requests and errors', async () => {
    const peer = runtime({
      echo: (p) => ({ result: p }),
      fail: () => ({ error: { code: 'NODE_NOT_FOUND', message: 'nope' } }),
    });
    const waiting = bridge.waitFor('runtime', 1000);
    expect(await peer.connect(port, { token: bridge.token })).toEqual({
      type: 'welcome',
      protocol: 1,
    });
    const connection = await waiting;
    expect(connection?.hello.role).toBe('runtime');
    expect(bridge.peer('runtime')).toBe(connection);
    await expect(connection?.request('echo', { a: 1 }, 1000)).resolves.toEqual({ a: 1 });
    await expect(connection?.request('fail', {}, 1000)).rejects.toThrow(RemoteError);
    await expect(connection?.request('fail', {}, 1000)).rejects.toMatchObject({
      code: 'NODE_NOT_FOUND',
    });
  });

  it.each([
    ['a wrong token', { token: 'wrong' }, 'invalid token'],
    ['a same-length wrong token', { token: 'x'.repeat(64) }, 'invalid token'],
    ['an unsupported protocol', { protocol: 99, useToken: true }, 'protocol 99 is not supported'],
    ['a non-hello message', { type: 'nonsense' }, 'expected hello'],
  ])('rejects %s', async (_label, hello: Record<string, unknown>, reason) => {
    const { useToken, ...rest } = hello;
    const reply = await runtime().connect(
      port,
      useToken === true ? { ...rest, token: bridge.token } : rest,
    );
    expect(reply.type).toBe('rejected');
    expect(String(reply.reason)).toContain(reason);
    expect(bridge.peer('runtime')).toBeUndefined();
  });

  it('drops peers that send invalid JSON', async () => {
    const socket = connect({ host: '127.0.0.1', port });
    await new Promise((resolve) => socket.on('connect', resolve));
    socket.write('{not json\n');
    await new Promise((resolve) => socket.on('close', resolve));
    expect(bridge.peer('runtime')).toBeUndefined();
  });

  it('times out unanswered requests and fails pending ones on disconnect', async () => {
    const peer = runtime({ silent: () => undefined });
    await peer.connect(port, { token: bridge.token });
    const connection = bridge.peer('runtime');
    await expect(connection?.request('silent', {}, 20)).rejects.toThrow(
      /did not answer "silent" within 20 ms/,
    );
    const pending = connection?.request('silent', {}, 5000);
    peer.close();
    await expect(pending).rejects.toThrow(ToolError);
    await expect.poll(() => bridge.peer('runtime')).toBeUndefined();
    await expect(connection?.request('silent', {}, 100)).rejects.toThrow(/not connected/);
  });

  it('replaces an older peer of the same role and ignores stray responses', async () => {
    const first = runtime({ who: () => ({ result: 'first' }) });
    await first.connect(port, { token: bridge.token });
    const second = runtime({ who: () => ({ result: 'second' }) });
    await second.connect(port, { token: bridge.token });
    await expect(bridge.peer('runtime')?.request('who', {}, 1000)).resolves.toBe('second');
    second.send('{"id":999,"result":1}\n{"unexpected":true}\n');
    await expect(bridge.peer('runtime')?.request('who', {}, 1000)).resolves.toBe('second');
  });

  it('gives up waiting for a peer after the timeout', async () => {
    expect(await bridge.waitFor('editor', 20)).toBeUndefined();
  });
});
