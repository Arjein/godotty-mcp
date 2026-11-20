import { randomBytes, timingSafeEqual } from 'node:crypto';
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
const NEWLINE = 0x0a;

/** Why a first message is not an acceptable hello, or undefined if it is. */
function helloProblem(
  message: unknown,
  tokenMatches: (token: string) => boolean,
): string | undefined {
  const hello = helloSchema.safeParse(message);
  if (!hello.success) return 'expected hello';
  if (!tokenMatches(hello.data.token)) return 'invalid token';
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
 * Loopback TCP server that Godot connects to. Only peers presenting this session's random token in
 * their first message are accepted; a newer connection for a role replaces the previous one.
 */
export class BridgeServer {
  public readonly token = randomBytes(TOKEN_BYTES).toString('hex');
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
    let buffer = Buffer.alloc(0);
    let connection: BridgeConnection | undefined;
    const helloTimer = setTimeout(() => {
      socket.destroy();
    }, HELLO_TIMEOUT_MS);
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      for (let end = buffer.indexOf(NEWLINE); end !== -1; end = buffer.indexOf(NEWLINE)) {
        const line = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 1);
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
      }
    });
  }

  private authenticate(socket: Socket, message: unknown): BridgeConnection | undefined {
    const problem = helloProblem(message, (token) => this.tokenMatches(token));
    if (problem !== undefined) {
      socket.end(`${JSON.stringify({ type: 'rejected', reason: problem })}\n`);
      socket.destroy();
      return undefined;
    }
    const hello = helloSchema.parse(message);
    socket.write(`${JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION })}\n`);
    const connection = new BridgeConnection(socket, hello);
    this.peers.get(hello.role)?.close();
    this.peers.set(hello.role, connection);
    for (const waiter of this.waiters.get(hello.role) ?? []) waiter(connection);
    this.waiters.delete(hello.role);
    return connection;
  }

  private tokenMatches(candidate: string): boolean {
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(candidate);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
