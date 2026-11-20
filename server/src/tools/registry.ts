import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { EditorClient, RuntimeClient } from '../bridge/runtime-client.js';
import type { ServerConfig } from '../config.js';
import type { DocsStore } from '../godot/docs/docs-store.js';
import type { GodotExecutable } from '../godot/executable.js';
import type { GameManager } from '../godot/game.js';
import type { ScriptChecker } from '../godot/script-checker.js';
import type { TestRunner } from '../godot/tests/test-runner.js';
import { formatError } from '../util/errors.js';
import type { ProjectSandbox } from '../util/sandbox.js';

/** Everything a tool handler may depend on. Extended as milestones add bridge services. */
export interface ToolContext {
  config: ServerConfig;
  sandbox: ProjectSandbox;
  godot: GodotExecutable;
  game: GameManager;
  checker: ScriptChecker;
  docs: DocsStore;
  tests: TestRunner;
  runtime: RuntimeClient;
  editor: EditorClient;
}

/**
 * One MCP tool. Each tool file exports one (or a small group of) these; `server.ts` registers them.
 * Handlers return plain content and throw `ToolError` for expected failures.
 */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  /** Precise, agent-facing description: what it does, when to use it, what it returns. */
  description: string;
  inputSchema: Shape;
  annotations?: ToolAnnotations;
  /** Return false to leave the tool unregistered (e.g. opt-in tools). Defaults to enabled. */
  enabled?: (config: ServerConfig) => boolean;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<CallToolResult>;
}

/** Identity helper that preserves the schema's inferred argument type for `handler`. */
export function defineTool<Shape extends z.ZodRawShape>(
  tool: ToolDefinition<Shape>,
): ToolDefinition<Shape> {
  return tool;
}

/** Wraps a text payload as a successful tool result. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Runs a handler and converts any thrown error into an MCP error result, so failures always reach
 * the agent as actionable text instead of a protocol-level exception.
 */
export async function runHandler<Shape extends z.ZodRawShape>(
  tool: ToolDefinition<Shape>,
  args: z.infer<z.ZodObject<Shape>>,
  ctx: ToolContext,
): Promise<CallToolResult> {
  try {
    return await tool.handler(args, ctx);
  } catch (error) {
    return { content: [{ type: 'text', text: formatError(error) }], isError: true };
  }
}

/** Registers every enabled tool on `server` and returns the names that were registered. */
export function registerTools(
  server: McpServer,
  tools: readonly ToolDefinition[],
  ctx: ToolContext,
): string[] {
  const registered: string[] = [];
  for (const tool of tools) {
    if (tool.enabled !== undefined && !tool.enabled(ctx.config)) {
      continue;
    }
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      },
      (args: z.infer<z.ZodObject<z.ZodRawShape>>) => runHandler(tool, args, ctx),
    );
    registered.push(tool.name);
  }
  return registered;
}
