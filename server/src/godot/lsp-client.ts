import { connect, type Socket } from 'node:net';

import { ErrorCode, ToolError } from '../util/errors.js';

/** A decoded JSON-RPC message from the language server. */
export interface LspMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const HEADER_END = '\r\n\r\n';
const CONTENT_LENGTH = /Content-Length: *(\d+)/i;

/** Encodes one JSON-RPC message with LSP's Content-Length framing. */
export function encodeLspMessage(message: object): Buffer {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}${HEADER_END}${body}`);
}

/** Incremental decoder: feed it socket chunks, get back every complete message. */
export class LspDecoder {
  private buffer = Buffer.alloc(0);

  public push(chunk: Buffer): LspMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: LspMessage[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd === -1) return messages;
      const match = CONTENT_LENGTH.exec(this.buffer.subarray(0, headerEnd).toString());
      if (match === null) {
        throw new Error('LSP message without Content-Length header');
      }
      const start = headerEnd + HEADER_END.length;
      const end = start + Number(match[1]);
      if (this.buffer.length < end) return messages;
      messages.push(JSON.parse(this.buffer.subarray(start, end).toString()) as LspMessage);
      this.buffer = this.buffer.subarray(end);
    }
  }
}

type NotificationHandler = (params: unknown) => void;

/** A JSON-RPC connection to a language server over TCP. */
export class LspConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly handlers = new Map<string, NotificationHandler[]>();
  private readonly decoder = new LspDecoder();
  private closed = false;

  public constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values())
        reject(new Error('Language server connection closed'));
      this.pending.clear();
    });
    socket.on('error', () => {
      socket.destroy();
    });
  }

  /** Opens a TCP connection; rejects if nothing is listening within `timeoutMs`. */
  public static open(port: number, timeoutMs: number): Promise<LspConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to 127.0.0.1:${port}`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(new LspConnection(socket));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ToolError(
            ErrorCode.Timeout,
            `Language server did not answer "${method}" in ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.write(encodeLspMessage({ id, method, params }));
    });
  }

  public notify(method: string, params: unknown): void {
    this.socket.write(encodeLspMessage({ method, params }));
  }

  /** Subscribes to a server notification; returns an unsubscribe function. */
  public on(method: string, handler: NotificationHandler): () => void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
    return () => {
      this.handlers.set(
        method,
        (this.handlers.get(method) ?? []).filter((h) => h !== handler),
      );
    };
  }

  public close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    let messages: LspMessage[];
    try {
      messages = this.decoder.push(chunk);
    } catch {
      this.socket.destroy();
      return;
    }
    for (const message of messages) {
      this.dispatch(message);
    }
  }

  private dispatch(message: LspMessage): void {
    if (message.method !== undefined) {
      if (message.id !== undefined) {
        // Server-to-client request (e.g. workspace/configuration): answer with null so it continues.
        this.socket.write(encodeLspMessage({ id: message.id, result: null }));
        return;
      }
      for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(
        new Error(`Language server error ${message.error.code}: ${message.error.message}`),
      );
    } else {
      pending.resolve(message.result);
    }
  }
}
