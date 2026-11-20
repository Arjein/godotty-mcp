import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ServerConfig } from '../../src/config.js';
import type { Spawner } from '../../src/godot/executable.js';
import { createServer } from '../../src/server.js';
import { createServices, type ServiceOptions, type Services } from '../../src/services.js';

export interface ToolClient {
  call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ text: string; isError: boolean }>;
  services: Services;
  close: () => Promise<void>;
}

/** Real server + in-memory MCP client over `root`, with Godot replaced by `spawner`. */
export async function connectTools(
  root: string,
  spawner: Spawner,
  config: Partial<ServerConfig> = {},
  options: Omit<ServiceOptions, 'spawner'> = {},
): Promise<ToolClient> {
  const fullConfig: ServerConfig = {
    projectPath: root,
    godotPath: 'godot',
    allowEval: false,
    editorLspPort: 1,
    ...config,
  };
  const services = createServices(fullConfig, {
    cacheRoot: path.join(root, '.test-cache'),
    ...options,
    spawner,
  });
  const { server } = createServer(fullConfig, undefined, services);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tools-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    services,
    call: async (name, args = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return {
        text: result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
        isError: result.isError === true,
      };
    },
    close: async () => {
      services.dispose();
      await client.close();
    },
  };
}
