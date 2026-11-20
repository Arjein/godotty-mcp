#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { HelpRequested, loadConfig, USAGE } from './config.js';
import { createServer } from './server.js';
import { formatError } from './util/errors.js';

/** stdio entry point. stdout belongs to the MCP protocol, so all diagnostics go to stderr. */
async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2), process.env, process.cwd());
  const { server, registeredTools } = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(
    `godotty-mcp: serving ${config.projectPath} (${registeredTools.length} tools, godot: ${config.godotPath})`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof HelpRequested) {
    console.error(USAGE);
    process.exit(0);
  }
  console.error(formatError(error));
  process.exit(1);
});
