import { checkScripts, getErrors } from './diagnostics.js';
import { godotDocs } from './docs.js';
import { addNode, openScene, removeNode, saveScene, updateNode } from './editor.js';
import { listFiles, projectInfo, readScene } from './project.js';
import type { ToolDefinition } from './registry.js';
import { getOutput, runGame, stopGame } from './run.js';
import {
  getNodeProperties,
  inspectSceneTree,
  screenshot,
  sendInput,
  setNodeProperty,
  wait,
} from './runtime.js';
import { runTests } from './tests.js';

/**
 * Every tool the server knows about, in the order clients list them.
 * Add new tools here; `registerTools` skips the ones whose `enabled` check fails.
 */
export const ALL_TOOLS = [
  // Project
  projectInfo,
  listFiles,
  readScene,
  // Docs and diagnostics
  godotDocs,
  checkScripts,
  getErrors,
  // Run
  runGame,
  stopGame,
  getOutput,
  // See and play
  screenshot,
  sendInput,
  wait,
  inspectSceneTree,
  getNodeProperties,
  setNodeProperty,
  // Editor
  openScene,
  addNode,
  removeNode,
  updateNode,
  saveScene,
  // Tests
  runTests,
] as unknown as readonly ToolDefinition[];
