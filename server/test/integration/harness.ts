import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { createServer, type CreatedServer } from '../../src/server.js';
import { DEMO_PROJECT } from '../helpers/demo.js';

export const GODOT = process.env.GODOT_PATH ?? 'godot';

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

export async function startHarness(extraFiles: Record<string, string> = {}): Promise<Harness> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'godotty-it-')));
  cpSync(DEMO_PROJECT, root, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.godot`),
  });
  for (const [relative, content] of Object.entries(extraFiles)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
  const server = createServer({
    projectPath: root,
    godotPath: GODOT,
    allowEval: false,
    editorLspPort: 1,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'integration', version: '0.0.0' });
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
