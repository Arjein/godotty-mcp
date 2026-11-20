import { connect } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BridgeServer,
  LineReader,
  RemoteError,
  welcomeProof,
} from '../../src/bridge/bridge-server.js';
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
    expect(bridge.tokenFor('runtime')).toMatch(/^[0-9a-f]{64}$/);
    expect(bridge.tokenFor('editor')).toMatch(/^[0-9a-f]{64}$/);
    expect(bridge.tokenFor('editor')).not.toBe(bridge.tokenFor('runtime'));
    expect(new BridgeServer().tokenFor('runtime')).not.toBe(bridge.tokenFor('runtime'));
  });

  it('welcomes a peer with the right token and routes requests and errors', async () => {
    const peer = runtime({
      echo: (p) => ({ result: p }),
      fail: () => ({ error: { code: 'NODE_NOT_FOUND', message: 'nope' } }),
    });
    const waiting = bridge.waitFor('runtime', 1000);
    expect(await peer.connect(port, { token: bridge.tokenFor('runtime') })).toEqual({
      type: 'welcome',
      protocol: 1,
      proof: welcomeProof(bridge.tokenFor('runtime'), peer.nonce),
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
      useToken === true ? { ...rest, token: bridge.tokenFor('runtime') } : rest,
    );
    expect(reply.type).toBe('rejected');
    expect(String(reply.reason)).toContain(reason);
    expect(bridge.peer('runtime')).toBeUndefined();
  });

  it('keeps role tokens separate: a game cannot connect as the editor', async () => {
    const reply = await runtime().connect(port, {
      role: 'editor',
      token: bridge.tokenFor('runtime'),
    });
    expect(reply).toMatchObject({ type: 'rejected', reason: 'invalid token' });
    const editor = runtime();
    expect(
      await editor.connect(port, { role: 'editor', token: bridge.tokenFor('editor') }),
    ).toMatchObject({
      type: 'welcome',
      proof: welcomeProof(bridge.tokenFor('editor'), editor.nonce),
    });
  });

  it('drops oversized hellos and caps unauthenticated connections', async () => {
    const big = connect({ host: '127.0.0.1', port });
    await new Promise((resolve) => big.on('connect', resolve));
    big.write('x'.repeat(20_000));
    await new Promise((resolve) => big.on('close', resolve));
    const idle = await Promise.all(
      Array.from({ length: 9 }, async () => {
        const socket = connect({ host: '127.0.0.1', port });
        await new Promise((resolve) => socket.on('connect', resolve));
        return socket;
      }),
    );
    await expect
      .poll(() => idle.filter((s) => s.destroyed || s.readableEnded).length, { timeout: 2000 })
      .toBeGreaterThanOrEqual(1);
    for (const socket of idle) socket.destroy();
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
    await peer.connect(port, { token: bridge.tokenFor('runtime') });
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
    await first.connect(port, { token: bridge.tokenFor('runtime') });
    const second = runtime({ who: () => ({ result: 'second' }) });
    await second.connect(port, { token: bridge.tokenFor('runtime') });
    await expect(bridge.peer('runtime')?.request('who', {}, 1000)).resolves.toBe('second');
    second.send('{"id":999,"result":1}\n{"unexpected":true}\n');
    await expect(bridge.peer('runtime')?.request('who', {}, 1000)).resolves.toBe('second');
  });

  it('gives up waiting for a peer after the timeout', async () => {
    expect(await bridge.waitFor('editor', 20)).toBeUndefined();
  });
});

describe('LineReader', () => {
  it('reassembles lines across chunks and enforces the pending limit', () => {
    const reader = new LineReader();
    expect(reader.push(Buffer.from('{"a":'), 100)).toEqual([]);
    expect(reader.push(Buffer.from('1}\n{"b":2}\n{"c"'), 100)).toEqual(['{"a":1}', '{"b":2}']);
    expect(reader.push(Buffer.from(':3}\n'), 100)).toEqual(['{"c":3}']);
    expect(() => reader.push(Buffer.from('x'.repeat(101)), 100)).toThrow(/too long/);
  });
});
