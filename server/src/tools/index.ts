import { checkScripts, getErrors } from './diagnostics.js';
import { godotDocs } from './docs.js';
import { listFiles, projectInfo, readScene } from './project.js';
import type { ToolDefinition } from './registry.js';
import { getOutput, runGame, stopGame } from './run.js';

/**
 * Every tool the server knows about, in the order clients list them.
 * Add new tools here; `registerTools` skips the ones whose `enabled` check fails.
 */
export const ALL_TOOLS = [
  projectInfo,
  listFiles,
  readScene,
  godotDocs,
  checkScripts,
  getErrors,
  runGame,
  stopGame,
  getOutput,
] as unknown as readonly ToolDefinition[];
