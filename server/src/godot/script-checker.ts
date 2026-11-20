import type { ChildProcess } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ErrorCode, ToolError } from '../util/errors.js';
import { killGracefully, type GodotExecutable } from './executable.js';
import { parseErrorBlocks } from './godot-log.js';
import { LspConnection } from './lsp-client.js';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export type CheckSource = 'editor-lsp' | 'headless-lsp' | 'check-only';

export interface ScriptDiagnostic {
  /** Absolute filesystem path. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based; undefined when the source (check-only) has no column info. */
  column: number | undefined;
  severity: DiagnosticSeverity;
  message: string;
}

export interface CheckResult {
  source: CheckSource;
  checked: number;
  diagnostics: ScriptDiagnostic[];
}

export interface ScriptCheckerOptions {
  godot: GodotExecutable;
  projectRoot: string;
  /** Port the Godot editor's language server listens on (editor setting, default 6005). */
  editorLspPort: number;
  timeouts?: Partial<CheckerTimeouts>;
}

export interface CheckerTimeouts {
  connect: number;
  /** Starting a headless editor can include a first-time import of the whole project. */
  headlessStart: number;
  request: number;
  diagnostics: number;
  /** A warm headless editor is stopped after this long without use. */
  idle: number;
  checkOnly: number;
}

export const DEFAULT_EDITOR_LSP_PORT = 6005;
const MS_PER_MINUTE = 60_000;
const IDLE_MINUTES = 5;
const DEFAULT_TIMEOUTS: CheckerTimeouts = {
  connect: 1_000,
  headlessStart: 120_000,
  request: 15_000,
  diagnostics: 30_000,
  idle: IDLE_MINUTES * MS_PER_MINUTE,
  checkOnly: 30_000,
};
const PORT_POLL_MS = 250;
const LSP_BATCH_SIZE = 25;
const CHECK_ONLY_CONCURRENCY = 4;
const LSP_SEVERITY: Readonly<Record<number, DiagnosticSeverity>> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'info',
};

interface LspDiagnostic {
  range: { start: { line: number; character: number } };
  severity?: number;
  message: string;
}

interface Session {
  connection: LspConnection;
  source: 'editor-lsp' | 'headless-lsp';
}

/**
 * Collects GDScript diagnostics. Prefers the running editor's language server (when it has this
 * project open), then a headless editor it starts and keeps warm, then per-file `--check-only`.
 */
export class ScriptChecker {
  private readonly timeouts: CheckerTimeouts;
  private headless: { process: ChildProcess; session: Session } | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly root: string;

  public constructor(private readonly options: ScriptCheckerOptions) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.root = realpathSync(options.projectRoot);
  }

  /** Checks `files` (absolute paths). Falls back to --check-only if no language server works. */
  public async check(files: readonly string[]): Promise<CheckResult> {
    const session = await this.lspSession().catch(() => undefined);
    if (session !== undefined) {
      try {
        const diagnostics = await this.collectDiagnostics(session.connection, files);
        return { source: session.source, checked: files.length, diagnostics };
      } catch {
        // A misbehaving headless editor is replaced next time rather than reused.
        if (session.source === 'headless-lsp') this.dispose();
      } finally {
        if (session.source === 'editor-lsp') session.connection.close();
        else if (this.headless !== undefined) this.touchIdleTimer();
      }
    }
    return {
      source: 'check-only',
      checked: files.length,
      diagnostics: await this.checkOnly(files),
    };
  }

  /** Stops the headless editor, if one is running. */
  public dispose(): void {
    clearTimeout(this.idleTimer);
    if (this.headless !== undefined) {
      this.headless.session.connection.close();
      killGracefully(this.headless.process);
      this.headless = undefined;
    }
  }

  private async lspSession(): Promise<Session> {
    const editor = await this.editorSession().catch(() => undefined);
    if (editor !== undefined) return editor;
    if (this.headless !== undefined && !this.headless.session.connection.isClosed) {
      return this.headless.session;
    }
    return this.startHeadless();
  }

  /** Connects to the user's editor LSP and verifies it has this project open. */
  private async editorSession(): Promise<Session> {
    const connection = await LspConnection.open(this.options.editorLspPort, this.timeouts.connect);
    try {
      const workspace = await this.initialize(connection);
      if (workspace === undefined || !samePath(workspace, this.root)) {
        throw new Error('Editor language server has a different project open');
      }
      return { connection, source: 'editor-lsp' };
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  private async startHeadless(): Promise<Session> {
    const port = await findFreePort();
    const process = this.options.godot.spawn([
      '--headless',
      '--editor',
      '--path',
      this.root,
      '--lsp-port',
      String(port),
    ]);
    try {
      const connection = await this.waitForLsp(port, process);
      await this.initialize(connection);
      const session: Session = { connection, source: 'headless-lsp' };
      this.headless = { process, session };
      process.once('exit', () => {
        if (this.headless?.process === process) this.headless = undefined;
      });
      return session;
    } catch (error) {
      killGracefully(process);
      throw error;
    }
  }

  private async waitForLsp(port: number, process: ChildProcess): Promise<LspConnection> {
    const deadline = Date.now() + this.timeouts.headlessStart;
    while (Date.now() < deadline) {
      if (process.exitCode !== null) throw new Error('Headless editor exited during startup');
      try {
        return await LspConnection.open(port, this.timeouts.connect);
      } catch {
        await delay(PORT_POLL_MS);
      }
    }
    throw new ToolError(
      ErrorCode.Timeout,
      'Headless Godot editor did not start its language server in time.',
    );
  }

  /** Runs the LSP handshake; resolves with the workspace path Godot announces, if any. */
  private async initialize(connection: LspConnection): Promise<string | undefined> {
    let workspace: string | undefined;
    const off = connection.on('gdscript_client/changeWorkspace', (params) => {
      const p = (params as { path?: unknown } | undefined)?.path;
      if (typeof p === 'string') workspace = p;
    });
    await connection.request(
      'initialize',
      { processId: process.pid, rootUri: pathToFileURL(this.root).href, capabilities: {} },
      this.timeouts.request,
    );
    connection.notify('initialized', {});
    off();
    return workspace;
  }

  private async collectDiagnostics(
    connection: LspConnection,
    files: readonly string[],
  ): Promise<ScriptDiagnostic[]> {
    const all: ScriptDiagnostic[] = [];
    for (let i = 0; i < files.length; i += LSP_BATCH_SIZE) {
      all.push(...(await this.collectBatch(connection, files.slice(i, i + LSP_BATCH_SIZE))));
    }
    return all;
  }

  private collectBatch(
    connection: LspConnection,
    files: readonly string[],
  ): Promise<ScriptDiagnostic[]> {
    const waiting = new Map(files.map((f) => [canonical(f), f]));
    const results: ScriptDiagnostic[] = [];
    return new Promise((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        off();
        for (const file of files)
          connection.notify('textDocument/didClose', {
            textDocument: { uri: pathToFileURL(file).href },
          });
        if (error === undefined) resolve(results);
        else reject(error);
      };
      const timer = setTimeout(() => {
        finish(
          new ToolError(
            ErrorCode.Timeout,
            `No diagnostics for ${waiting.size} file(s) within ${this.timeouts.diagnostics} ms.`,
          ),
        );
      }, this.timeouts.diagnostics);
      const off = connection.on('textDocument/publishDiagnostics', (params) => {
        const { uri, diagnostics } = params as { uri: string; diagnostics: LspDiagnostic[] };
        const file = waiting.get(canonical(fileURLToPath(uri)));
        if (file === undefined) return;
        waiting.delete(canonical(fileURLToPath(uri)));
        results.push(...diagnostics.map((d) => toDiagnostic(file, d)));
        if (waiting.size === 0) finish();
      });
      for (const file of files) {
        connection.notify('textDocument/didOpen', {
          textDocument: {
            uri: pathToFileURL(file).href,
            languageId: 'gdscript',
            version: 1,
            text: readFileSync(file, 'utf8'),
          },
        });
      }
    });
  }

  private async checkOnly(files: readonly string[]): Promise<ScriptDiagnostic[]> {
    const results: ScriptDiagnostic[][] = [];
    const queue = [...files];
    const worker = async (): Promise<void> => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        results.push(await this.checkOnlyFile(file));
      }
    };
    await Promise.all(Array.from({ length: CHECK_ONLY_CONCURRENCY }, worker));
    return results.flat();
  }

  private async checkOnlyFile(file: string): Promise<ScriptDiagnostic[]> {
    const resPath = `res://${path.relative(this.root, canonical(file)).split(path.sep).join('/')}`;
    const result = await this.options.godot.exec(
      ['--headless', '--path', this.root, '--check-only', '--script', resPath],
      { timeoutMs: this.timeouts.checkOnly },
    );
    return parseErrorBlocks(result.stderr.split('\n'))
      .filter((e) => e.file === resPath)
      .map((e) => ({
        file,
        line: e.line ?? 1,
        column: undefined,
        severity: e.severity,
        message: e.message,
      }));
  }

  private touchIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.dispose();
    }, this.timeouts.idle);
    this.idleTimer.unref();
  }
}

function toDiagnostic(file: string, d: LspDiagnostic): ScriptDiagnostic {
  return {
    file,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    severity: LSP_SEVERITY[d.severity ?? 1] ?? 'error',
    message: d.message,
  };
}

function canonical(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Asks the OS for an unused loopback port. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}
