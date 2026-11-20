import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ServerConfig } from './config.js';
import { createServices, type Services } from './services.js';
import { ALL_TOOLS } from './tools/index.js';
import { registerTools, type ToolDefinition } from './tools/registry.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

const INSTRUCTIONS = `Tools for a Godot 4 project: read project and scenes, look up version-correct docs, check scripts, run the game, see it (screenshots), play it (input), inspect it live, edit scenes undoably in the editor, and run tests.`;

export interface CreatedServer {
  server: McpServer;
  registeredTools: string[];
  services: Services;
}

/** Builds the MCP server for one project. Transport-agnostic so tests can connect in-memory. */
export function createServer(
  config: ServerConfig,
  tools: readonly ToolDefinition[] = ALL_TOOLS,
  services: Services = createServices(config),
): CreatedServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );
  const registeredTools = registerTools(server, tools, services);
  return { server, registeredTools, services };
}
