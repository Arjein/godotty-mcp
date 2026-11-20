import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ServerConfig } from '../../src/config.js';
import { createServer, type CreatedServer } from '../../src/server.js';
import type { Services } from '../../src/services.js';
import { copyDemoProject, DEMO_PROJECT } from '../helpers/demo.js';

export const GODOT = process.env.GODOT_PATH ?? 'godot';
const REPO_ROOT = path.resolve(DEMO_PROJECT, '../..');

/** A temp copy of the demo project plus extra files, served by a real server + in-memory client. */
export interface Harness {
  root: string;
  client: Client;
  server: CreatedServer;
  call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ text: string; isError: boolean }>;
  close: () => Promise<void>;
}

/** Installs a pinned test framework with scripts/fetch-test-addons.sh (cached after first use). */
export function installTestAddon(root: string, framework: 'gut' | 'gdunit4'): void {
  execFileSync(path.join(REPO_ROOT, 'scripts', 'fetch-test-addons.sh'), [framework, root], {
    env: { ...process.env, GODOT_PATH: GODOT },
    stdio: 'pipe',
  });
}

export async function startHarness(
  extraFiles: Record<string, string> = {},
  options: { allowEval?: boolean } = {},
): Promise<Harness> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'godotty-it-')));
  copyDemoProject(root);
  for (const [relative, content] of Object.entries(extraFiles)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
  const server = createServer({
    projectPath: root,
    godotPath: GODOT,
    allowEval: options.allowEval ?? false,
    editorLspPort: 1,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'integration', version: '0.0.0' });
  await server.services.start();
  await Promise.all([server.server.connect(serverSide), client.connect(clientSide)]);
  return {
    root,
    client,
    server,
    call: async (name, args = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const text = result.content
        .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
        .join('\n');
      return { text, isError: result.isError === true };
    },
    close: async () => {
      server.services.dispose();
      await client.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Serves `services` to an in-memory client (no project copy). */
export async function connectServices(
  config: ServerConfig,
  services: Services,
): Promise<{ call: Harness['call']; close: () => Promise<void> }> {
  const server = createServer(config, undefined, services);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'integration', version: '0.0.0' });
  await Promise.all([server.server.connect(serverSide), client.connect(clientSide)]);
  return {
    call: async (name, args = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const text = result.content
        .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
        .join('\n');
      return { text, isError: result.isError === true };
    },
    close: async () => {
      services.dispose();
      await client.close();
    },
  };
}
