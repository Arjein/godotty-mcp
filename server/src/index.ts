#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { hasProjectFile, HelpRequested, loadConfig, USAGE } from './config.js';
import { INSTALL_COMMAND, runInstallCommand } from './install-addon.js';
import { createServer } from './server.js';
import { formatError } from './util/errors.js';

/** stdio entry point. stdout belongs to the MCP protocol, so all diagnostics go to stderr. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === INSTALL_COMMAND) {
    // A one-shot CLI command, not an MCP session: plain output on stdout.
    console.log(runInstallCommand(argv.slice(1), process.cwd()));
    return;
  }
  const config = loadConfig(argv, process.env, process.cwd());
  const { server, registeredTools, services } = createServer(config);
  const shutdown = (): void => {
    services.dispose();
    process.exit(0);
  };
  // The client closing stdin (or signalling us) ends the session: stop Godot processes first.
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await services.start();
  await server.connect(new StdioServerTransport());
  const waiting = hasProjectFile(config.projectPath)
    ? ''
    : '; no project.godot yet, project tools report NOT_FOUND until it exists';
  console.error(
    `godotty-mcp: serving ${config.projectPath} (${registeredTools.length} tools, godot: ${config.godotPath}${waiting})`,
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
