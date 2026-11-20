import { describe, expect, it } from 'vitest';

import { encodeLspMessage, LspConnection, LspDecoder } from '../../src/godot/lsp-client.js';
import { FakeLsp } from '../helpers/fake-lsp.js';

describe('LspDecoder', () => {
  it('decodes messages split across and packed into chunks', () => {
    const a = encodeLspMessage({ id: 1, result: 'é' });
    const b = encodeLspMessage({ method: 'x', params: {} });
    const both = Buffer.concat([a, b]);
    const decoder = new LspDecoder();
    expect(decoder.push(both.subarray(0, 10))).toEqual([]);
    expect(decoder.push(both.subarray(10, a.length + 5))).toEqual([
      { jsonrpc: '2.0', id: 1, result: 'é' },
    ]);
    expect(decoder.push(both.subarray(a.length + 5))).toEqual([
      { jsonrpc: '2.0', method: 'x', params: {} },
    ]);
  });

  it('rejects frames without Content-Length', () => {
    expect(() => new LspDecoder().push(Buffer.from('Foo: 1\r\n\r\n{}'))).toThrow(/Content-Length/);
  });
});

describe('LspConnection', () => {
  it('performs requests, answers server requests and dispatches notifications', async () => {
    const server = new FakeLsp({ workspace: '/proj' });
    const port = await server.listen();
    const connection = await LspConnection.open(port, 1000);
    const announced: unknown[] = [];
    const off = connection.on('gdscript_client/changeWorkspace', (params) =>
      announced.push(params),
    );
    await expect(connection.request('initialize', {}, 1000)).resolves.toEqual({ capabilities: {} });
    expect(announced).toEqual([{ path: '/proj' }]);
    off();
    await expect
      .poll(() => server.received.some((m) => m.id === 'cfg-1' && m.result === null))
      .toBe(true);
    connection.close();
    await expect.poll(() => connection.isClosed).toBe(true);
    await server.close();
  });

  it('rejects error responses, timeouts and requests pending at close', async () => {
    const server = new FakeLsp({ failInitialize: true });
    const port = await server.listen();
    const connection = await LspConnection.open(port, 1000);
    await expect(connection.request('initialize', {}, 1000)).rejects.toThrow(/error -32600: nope/);
    await expect(connection.request('never/answered', {}, 20)).rejects.toThrow(/did not answer/);
    const pending = connection.request('never/answered', {}, 5000);
    await server.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it('fails to open when nothing listens', async () => {
    const server = new FakeLsp({});
    const port = await server.listen();
    await server.close();
    await expect(LspConnection.open(port, 1000)).rejects.toThrow();
  });
});
