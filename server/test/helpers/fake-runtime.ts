import { connect, type Socket } from 'node:net';

import { PROTOCOL_VERSION } from '../../src/bridge/protocol.js';

export type Handler = (
  params: Record<string, unknown>,
) => { result?: unknown; error?: { code: string; message: string } } | undefined;

/** Plays the Godot runtime helper: connects, says hello, answers requests with `handlers`. */
export class FakeRuntime {
  public readonly requests: { method: string; params: Record<string, unknown> }[] = [];
  public readonly received: unknown[] = [];
  private socket: Socket | undefined;

  public constructor(private readonly handlers: Record<string, Handler> = {}) {}

  /** Connects and resolves with the server's first reply (welcome or rejected). */
  public connect(port: number, hello: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      this.socket = socket;
      let buffer = '';
      let first = true;
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
          const message = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
          buffer = buffer.slice(end + 1);
          this.received.push(message);
          if (first) {
            first = false;
            resolve(message);
          } else {
            this.answer(message);
          }
        }
      });
      socket.on('connect', () => {
        socket.write(
          `${JSON.stringify({ type: 'hello', role: 'runtime', protocol: PROTOCOL_VERSION, godot: '4.7.2', ...hello })}\n`,
        );
      });
    });
  }

  public send(raw: string): void {
    this.socket?.write(raw);
  }

  public close(): void {
    this.socket?.destroy();
  }

  private answer(message: Record<string, unknown>): void {
    const method = String(message.method);
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.requests.push({ method, params });
    const handler = this.handlers[method];
    const outcome =
      handler === undefined
        ? { error: { code: 'UNKNOWN_METHOD', message: `no ${method}` } }
        : handler(params);
    if (outcome !== undefined)
      this.socket?.write(`${JSON.stringify({ id: message.id, ...outcome })}\n`);
  }
}
