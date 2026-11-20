import { homedir } from 'node:os';
import path from 'node:path';

import type { ServerConfig } from './config.js';
import { DocsStore, httpFetchText, type TextFetcher } from './godot/docs/docs-store.js';
import { GodotExecutable, type Spawner } from './godot/executable.js';
import { GameManager } from './godot/game.js';
import { findRuntimeSourceDir, RuntimeInjection } from './godot/runtime-injection.js';
import { DEFAULT_EDITOR_LSP_PORT, ScriptChecker } from './godot/script-checker.js';
import { TestRunner } from './godot/tests/test-runner.js';
import type { ToolContext } from './tools/registry.js';
import { ProjectSandbox } from './util/sandbox.js';

export interface Services extends ToolContext {
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
  const game = new GameManager({ godot, projectRoot: sandbox.root, injection });
  const checker = new ScriptChecker({
    godot,
    projectRoot: sandbox.root,
    editorLspPort: config.editorLspPort ?? DEFAULT_EDITOR_LSP_PORT,
  });
  const docs = new DocsStore({
    godot,
    cacheRoot: options.cacheRoot ?? defaultCacheRoot(),
    fetchText: options.fetchText ?? httpFetchText,
    offline: config.offline === true,
  });
  return {
    config,
    sandbox,
    godot,
    game,
    checker,
    docs,
    tests: new TestRunner(godot, sandbox.root),
    dispose: () => {
      game.dispose();
      checker.dispose();
    },
  };
}
