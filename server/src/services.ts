import { homedir } from 'node:os';
import path from 'node:path';

import { BridgeServer } from './bridge/bridge-server.js';
import { editorClient, runtimeClient } from './bridge/runtime-client.js';
import { removeSessionFile, writeSessionFile } from './bridge/session-file.js';
import { hasProjectFile, missingProjectError, type ServerConfig } from './config.js';
import { DocsStore, httpFetchText, type TextFetcher } from './godot/docs/docs-store.js';
import { GodotExecutable, type Spawner } from './godot/executable.js';
import { GameManager } from './godot/game.js';
import { findRuntimeSourceDir, RuntimeInjection } from './godot/runtime-injection.js';
import { DEFAULT_EDITOR_LSP_PORT, ScriptChecker } from './godot/script-checker.js';
import { TestRunner } from './godot/tests/test-runner.js';
import type { ToolContext } from './tools/registry.js';
import { ProjectSandbox } from './util/sandbox.js';
import { SERVER_VERSION } from './version.js';

export interface Services extends ToolContext {
  bridge: BridgeServer;
  /**
   * Starts the bridge and publishes the session file for the editor plugin (once project.godot
   * exists; a later project tool call publishes it if the project is created afterwards).
   */
  start: () => Promise<void>;
  /** Stops child processes and restores the project; call on shutdown. */
  dispose: () => void;
}

export interface ServiceOptions {
  /** Process factory override, used by tests to fake Godot. */
  spawner?: Spawner;
  /** HTTP override for docs text, used by tests. */
  fetchText?: TextFetcher;
  /** Cache folder override (default: $XDG_CACHE_HOME/godotty-mcp or ~/.cache/godotty-mcp). */
  cacheRoot?: string;
}

function defaultCacheRoot(): string {
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'godotty-mcp');
}

/** Wires up the long-lived services for one project. */
export function createServices(config: ServerConfig, options: ServiceOptions = {}): Services {
  const sandbox = new ProjectSandbox(config.projectPath);
  const godot = new GodotExecutable(config.godotPath, options.spawner);
  const injection = new RuntimeInjection(sandbox.root, findRuntimeSourceDir());
  // Clean up after a previous server that crashed mid-launch.
  injection.recover();
  const bridge = new BridgeServer();
  const game = new GameManager({
    godot,
    projectRoot: sandbox.root,
    injection,
    bridge,
    allowEval: config.allowEval,
  });
  const checker = new ScriptChecker({
    godot,
    projectRoot: sandbox.root,
    editorLspPort: config.editorLspPort ?? DEFAULT_EDITOR_LSP_PORT,
    editorOpen: () => bridge.peer('editor') !== undefined,
  });
  const docs = new DocsStore({
    godot,
    cacheRoot: options.cacheRoot ?? defaultCacheRoot(),
    fetchText: options.fetchText ?? httpFetchText,
    offline: config.offline === true,
  });
  let bridgePort: number | undefined;
  let sessionWritten = false;
  const publishSession = (): void => {
    if (sessionWritten || bridgePort === undefined || !hasProjectFile(sandbox.root)) return;
    writeSessionFile(
      sandbox.root,
      bridgePort,
      bridge.tokenFor('editor'),
      SERVER_VERSION,
      config.allowEval,
    );
    sessionWritten = true;
  };
  return {
    config,
    sandbox,
    godot,
    game,
    checker,
    docs,
    tests: new TestRunner(godot, sandbox.root),
    runtime: runtimeClient(bridge, game),
    editor: editorClient(bridge),
    bridge,
    requireProject: () => {
      if (!hasProjectFile(sandbox.root)) throw missingProjectError(sandbox.root);
      publishSession();
    },
    start: async () => {
      bridgePort = await bridge.listen();
      publishSession();
    },
    dispose: () => {
      removeSessionFile(sandbox.root);
      game.dispose();
      checker.dispose();
      bridge.close();
    },
  };
}
