import type { ToolDefinition } from './registry.js';

/**
 * Every tool the server knows about, in the order clients list them.
 * Add new tools here; `registerTools` skips the ones whose `enabled` check fails.
 */
export const ALL_TOOLS: readonly ToolDefinition[] = [];
