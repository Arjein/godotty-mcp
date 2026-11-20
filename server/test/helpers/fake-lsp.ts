import { createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

import { encodeLspMessage, LspDecoder, type LspMessage } from '../../src/godot/lsp-client.js';

export interface FakeLspOptions {
  /** Workspace path announced via gdscript_client/changeWorkspace (omit to announce nothing). */
  workspace?: string;
  /** Diagnostics to publish per opened file path; files not listed get none (never published). */
  diagnostics?: (
    file: string,
  ) => { line: number; character: number; severity?: number; message: string }[] | undefined;
  /** Respond to initialize with an error instead. */
  failInitialize?: boolean;
}

/** A tiny GDScript-language-server impersonator listening on 127.0.0.1. */
export class FakeLsp {
  public readonly received: LspMessage[] = [];
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();

  public constructor(private readonly options: FakeLspOptions) {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      const decoder = new LspDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) this.handle(socket, message);
      });
    });
  }

  public listen(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        const address = this.server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  }

  public close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private handle(socket: Socket, message: LspMessage): void {
    this.received.push(message);
    if (message.method === 'initialize') {
      if (this.options.workspace !== undefined) {
        socket.write(
          encodeLspMessage({
            method: 'gdscript_client/changeWorkspace',
            params: { path: this.options.workspace },
          }),
        );
      }
      // A server→client request the client must answer.
      socket.write(
        encodeLspMessage({ id: 'cfg-1', method: 'workspace/configuration', params: {} }),
      );
      socket.write(
        encodeLspMessage(
          this.options.failInitialize === true
            ? { id: message.id, error: { code: -32600, message: 'nope' } }
            : { id: message.id, result: { capabilities: {} } },
        ),
      );
    } else if (message.method === 'textDocument/didOpen') {
      const uri = (message.params as { textDocument: { uri: string } }).textDocument.uri;
      const diagnostics = this.options.diagnostics?.(fileURLToPath(uri));
      if (diagnostics === undefined) return;
      socket.write(
        encodeLspMessage({
          method: 'textDocument/publishDiagnostics',
          params: {
            uri,
            diagnostics: diagnostics.map((d) => ({
              range: {
                start: { line: d.line, character: d.character },
                end: { line: d.line, character: d.character },
              },
              severity: d.severity,
              message: d.message,
            })),
          },
        }),
      );
    }
  }
}
