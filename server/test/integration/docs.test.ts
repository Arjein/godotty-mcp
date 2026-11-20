import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServices } from '../../src/services.js';
import { connectServices } from './harness.js';
import { DEMO_PROJECT } from '../helpers/demo.js';
import { GODOT } from './harness.js';

describe('godot_docs against real Godot (network for descriptions)', () => {
  let cacheRoot: string;
  let call: Awaited<ReturnType<typeof connectServices>>['call'];
  let close: () => Promise<void>;

  beforeAll(async () => {
    cacheRoot = mkdtempSync(path.join(tmpdir(), 'godotty-docs-'));
    const config = { projectPath: DEMO_PROJECT, godotPath: GODOT, allowEval: false };
    ({ call, close } = await connectServices(config, createServices(config, { cacheRoot })));
  });

  afterAll(async () => {
    await close();
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('shows a class overview with exact inheritance and description', async () => {
    const { text } = await call('godot_docs', { query: 'CharacterBody3D' });
    expect(text).toMatch(/^Godot 4\.\d+\.\d+\.stable docs — class CharacterBody3D/);
    expect(text).toContain('Inherits: PhysicsBody3D < CollisionObject3D < Node3D < Node < Object');
    expect(text).toMatch(/Methods \(\d+\): .*move_and_slide/);
    expect(text).not.toContain('Description text unavailable');
  });

  it('finds inherited members with signatures and Markdown descriptions', async () => {
    const { text } = await call('godot_docs', { query: 'CharacterBody3D.add_child' });
    expect(text).toContain('Inherited by CharacterBody3D from Node.');
    expect(text).toContain(
      'add_child(node: Node, force_readable_name: bool = false, internal: Node.InternalMode = 0) -> void',
    );
    expect(text).toContain('```gdscript');
    expect(text).not.toContain('[csharp]');
  });

  it('searches across classes and global scope', async () => {
    const { text } = await call('godot_docs', { query: 'lerp' });
    expect(text).toContain('@GlobalScope.lerp (method)');
  });
});
