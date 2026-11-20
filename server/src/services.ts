import type { ServerConfig } from './config.js';
import { GodotExecutable, type Spawner } from './godot/executable.js';
import { GameManager } from './godot/game.js';
import { findRuntimeSourceDir, RuntimeInjection } from './godot/runtime-injection.js';
import { DEFAULT_EDITOR_LSP_PORT, ScriptChecker } from './godot/script-checker.js';
import type { ToolContext } from './tools/registry.js';
import { ProjectSandbox } from './util/sandbox.js';

export interface Services extends ToolContext {
  /** Stops child processes and restores the project; call on shutdown. */
  dispose: () => void;
}

export interface ServiceOptions {
  /** Process factory override, used by tests to fake Godot. */
  spawner?: Spawner;
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
  return {
    config,
    sandbox,
    godot,
    game,
    checker,
    dispose: () => {
      game.dispose();
      checker.dispose();
    },
  };
}
