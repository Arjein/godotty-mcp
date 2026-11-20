import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createServer } from '../src/server.js';
import { defineTool, textResult, type ToolDefinition } from '../src/tools/registry.js';
import { ErrorCode, ToolError } from '../src/util/errors.js';
import { makeTempProject } from './helpers/tmp-project.js';

const echo = defineTool({
  name: 'echo',
  title: 'Echo',
  description: 'Echoes text.',
  inputSchema: { text: z.string().min(1) },
  annotations: { readOnlyHint: true },
  handler: ({ text }) => Promise.resolve(textResult(text)),
});

const failing = defineTool({
  name: 'failing',
  title: 'Failing',
  description: 'Always fails.',
  inputSchema: { kind: z.enum(['expected', 'unexpected']) },
  handler: ({ kind }) => {
    if (kind === 'expected') {
      throw new ToolError(ErrorCode.GameNotRunning, 'No game.', 'Call run_game first.');
    }
    throw new Error('kaboom');
  },
});

const optIn = defineTool({
  name: 'opt_in',
  title: 'Opt-in',
  description: 'Only with eval.',
  inputSchema: {},
  enabled: (config) => config.allowEval,
  handler: () => Promise.resolve(textResult('ok')),
});

const tools = [echo, failing, optIn] as unknown as ToolDefinition[];

async function connect(allowEval: boolean, root: string): Promise<Client> {
  const { server } = createServer({ projectPath: root, godotPath: 'godot', allowEval }, tools);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe('createServer', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('lists only enabled tools, with schemas and annotations', async () => {
    const client = await connect(false, project.root);
    const { tools: listed } = await client.listTools();
    expect(listed.map((t) => t.name)).toEqual(['echo', 'failing']);
    expect(listed[0]?.inputSchema.required).toEqual(['text']);
    expect(listed[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it('registers opt-in tools when enabled', async () => {
    const client = await connect(true, project.root);
    const { tools: listed } = await client.listTools();
    expect(listed.map((t) => t.name)).toContain('opt_in');
  });

  it('returns handler output', async () => {
    const client = await connect(false, project.root);
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('turns ToolError into an actionable isError result', async () => {
    const client = await connect(false, project.root);
    const result = await client.callTool({ name: 'failing', arguments: { kind: 'expected' } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'Error [GAME_NOT_RUNNING]: No game.\nHint: Call run_game first.' },
    ]);
  });

  it('turns unexpected exceptions into INTERNAL errors', async () => {
    const client = await connect(false, project.root);
    const result = await client.callTool({ name: 'failing', arguments: { kind: 'unexpected' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('INTERNAL');
  });

  it('rejects arguments that violate the schema', async () => {
    const client = await connect(false, project.root);
    const result = await client.callTool({ name: 'echo', arguments: { text: '' } });
    expect(result.isError).toBe(true);
  });
});
