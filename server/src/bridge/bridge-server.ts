import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

import { ErrorCode, ToolError } from '../util/errors.js';
import {
  helloSchema,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  responseSchema,
  type Hello,
  type Response,
  type Role,
} from './protocol.js';

const TOKEN_BYTES = 32;
/** A connection that hasn't said a valid hello by then is dropped. */
const HELLO_TIMEOUT_MS = 5_000;
/** A hello is tiny; anything bigger before authentication is abuse. */
const MAX_HELLO_BYTES = 16_384;
/** Concurrent connections that have not authenticated yet. */
const MAX_PENDING_CONNECTIONS = 8;
const NEWLINE = 0x0a;

/** Splits a byte stream into lines without re-copying the buffer on every chunk. */
export class LineReader {
  private parts: Buffer[] = [];
  private size = 0;

  /** Returns complete lines; throws when the pending (unterminated) data exceeds `limit`. */
  public push(chunk: Buffer, limit: number): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, start)) {
      this.parts.push(chunk.subarray(start, end));
      lines.push(Buffer.concat(this.parts).toString('utf8'));
      this.parts = [];
      this.size = 0;
      start = end + 1;
    }
    if (start < chunk.length) {
      this.parts.push(chunk.subarray(start));
      this.size += chunk.length - start;
      if (this.size > limit) throw new Error('line too long');
    }
    return lines;
  }
}

/** HMAC the server sends back so Godot knows it talks to the real server, not a port squatter. */
export function welcomeProof(token: string, nonce: string): string {
  return createHmac('sha256', token).update(nonce).digest('hex');
}

/** Why a first message is not an acceptable hello, or undefined if it is. */
function helloProblem(
  message: unknown,
  tokenMatches: (role: Role, token: string) => boolean,
): string | undefined {
  const hello = helloSchema.safeParse(message);
  if (!hello.success) return 'expected hello';
  if (!tokenMatches(hello.data.role, hello.data.token)) return 'invalid token';
  if (hello.data.protocol !== PROTOCOL_VERSION) {
    return `protocol ${hello.data.protocol} is not supported (server speaks ${PROTOCOL_VERSION}); update the Godotty addon/server so they match`;
  }
  return undefined;
}

/** Thrown when the Godot side answers a request with an error. */
export class RemoteError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One authenticated Godot peer (runtime helper or editor plugin). */
export class BridgeConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly closeListeners: (() => void)[] = [];

  public constructor(
    private readonly socket: Socket,
    public readonly hello: Hello,
  ) {
    socket.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new ToolError(
            ErrorCode.GameNotRunning,
            `The ${hello.role} disconnected while handling a request.`,
            'The game probably closed or crashed; check get_output and get_errors.',
          ),
        );
      }
      this.pending.clear();
      for (const listener of this.closeListeners) listener();
    });
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** Sends a request and resolves with its result; rejects with RemoteError or a timeout. */
  public request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new ToolError(ErrorCode.GameNotRunning, `The ${this.hello.role} is not connected.`),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ToolError(
            ErrorCode.Timeout,
            `Godot did not answer "${method}" within ${timeoutMs} ms.`,
            'The game may be frozen (infinite loop or breakpoint); check get_output.',
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  public close(): void {
    this.socket.destroy();
  }

  /** Routes one decoded line from the peer. */
  public handle(message: unknown): void {
    const parsed = responseSchema.safeParse(message);
    if (!parsed.success) return;
    const response: Response = parsed.data;
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error !== undefined)
      pending.reject(new RemoteError(response.error.code, response.error.message));
    else pending.resolve(response.result);
  }
}

/**
 * Loopback TCP server that Godot connects to. Each role has its own random token (the game gets
 * the runtime token via its environment, the editor plugin the editor token via the session file),
 * so a game can never pose as the editor. The server answers a valid hello with an HMAC of the
 * peer's nonce, proving it knows the token. A newer connection for a role replaces the older one.
 */
export class BridgeServer {
  private readonly tokens: Readonly<Record<Role, string>> = {
    runtime: randomBytes(TOKEN_BYTES).toString('hex'),
    editor: randomBytes(TOKEN_BYTES).toString('hex'),
  };
  private pendingConnections = 0;
  private server: Server | undefined;
  private listening: Promise<number> | undefined;
  private readonly peers = new Map<Role, BridgeConnection>();
  private readonly waiters = new Map<Role, ((c: BridgeConnection) => void)[]>();

  /** Starts listening (once) and resolves with the port. */
  public listen(): Promise<number> {
    this.listening ??= new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        this.accept(socket);
      });
      this.server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
    return this.listening;
  }

  /** The secret a peer of `role` must present. */
  public tokenFor(role: Role): string {
    return this.tokens[role];
  }

  /** The connected peer for `role`, if any. */
  public peer(role: Role): BridgeConnection | undefined {
    const peer = this.peers.get(role);
    return peer === undefined || peer.isClosed ? undefined : peer;
  }

  /** Resolves with the peer for `role` once it connects, or undefined after `timeoutMs`. */
  public waitFor(role: Role, timeoutMs: number): Promise<BridgeConnection | undefined> {
    const existing = this.peer(role);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.set(
          role,
          (this.waiters.get(role) ?? []).filter((w) => w !== done),
        );
        resolve(undefined);
      }, timeoutMs);
      const done = (connection: BridgeConnection): void => {
        clearTimeout(timer);
        resolve(connection);
      };
      this.waiters.set(role, [...(this.waiters.get(role) ?? []), done]);
    });
  }

  public close(): void {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.server?.close();
  }

  private accept(socket: Socket): void {
    if (this.pendingConnections >= MAX_PENDING_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.pendingConnections++;
    let pending = true;
    const settle = (): void => {
      if (pending) this.pendingConnections--;
      pending = false;
    };
    const reader = new LineReader();
    let connection: BridgeConnection | undefined;
    const helloTimer = setTimeout(() => {
      socket.destroy();
    }, HELLO_TIMEOUT_MS);
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      settle();
    });
    socket.on('data', (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = reader.push(chunk, connection === undefined ? MAX_HELLO_BYTES : MAX_MESSAGE_BYTES);
      } catch {
        socket.destroy();
        return;
      }
      for (const line of lines) {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (connection !== undefined) {
          connection.handle(message);
          continue;
        }
        connection = this.authenticate(socket, message);
        if (connection === undefined) return;
        clearTimeout(helloTimer);
        settle();
      }
    });
  }

  private authenticate(socket: Socket, message: unknown): BridgeConnection | undefined {
    const problem = helloProblem(message, (role, token) => this.tokenMatches(role, token));
    if (problem !== undefined) {
      socket.end(`${JSON.stringify({ type: 'rejected', reason: problem })}\n`);
      socket.destroy();
      return undefined;
    }
    const hello = helloSchema.parse(message);
    const proof = welcomeProof(this.tokens[hello.role], hello.nonce);
    socket.write(`${JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION, proof })}\n`);
    const connection = new BridgeConnection(socket, hello);
    this.peers.get(hello.role)?.close();
    this.peers.set(hello.role, connection);
    for (const waiter of this.waiters.get(hello.role) ?? []) waiter(connection);
    this.waiters.delete(hello.role);
    return connection;
  }

  private tokenMatches(role: Role, candidate: string): boolean {
    const expected = Buffer.from(this.tokens[role]);
    const actual = Buffer.from(candidate);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
