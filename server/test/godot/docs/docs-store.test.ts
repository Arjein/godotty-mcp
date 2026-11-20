import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { DocsStore, httpFetchText, sourceRefs } from '../../../src/godot/docs/docs-store.js';
import {
  GodotExecutable,
  parseGodotVersion,
  type GodotVersion,
} from '../../../src/godot/executable.js';
import { fixtureFetcher } from '../../helpers/fake-docs.js';
import { fakeGodot } from '../../helpers/fake-godot.js';
import { fakeSpawner } from '../../helpers/fake-process.js';

const version = (full: string): GodotVersion => {
  const v = parseGodotVersion(full);
  if (v === undefined) throw new Error('bad version');
  return v;
};

describe('sourceRefs', () => {
  it.each([
    ['4.7.2.stable.official.ed1daf0bf', ['4.7.2-stable', 'ed1daf0bf']],
    ['4.5.stable.official.abcdef1', ['4.5-stable', 'abcdef1']],
    ['4.6.rc2.official.1234567', ['4.6-rc2', '1234567']],
    ['4.7.dev.custom_build.ffffff0', ['ffffff0']],
    ['4.7.2.stable.mono.custom', ['4.7.2-stable']],
  ])('%s → %j', (full, refs) => {
    expect(sourceRefs(version(full))).toEqual(refs);
  });

  it('builds the docs base URL', () => {
    expect(DocsStore.docsBase(version('4.7.2.stable.x'))).toBe(
      'https://docs.godotengine.org/en/4.7',
    );
  });
});

describe('DocsStore', () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(path.join(tmpdir(), 'godotty-docs-test-'));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  function store(
    opts: { offline?: boolean; ref?: string; spawner?: ReturnType<typeof fakeGodot> } = {},
  ) {
    const fake = opts.spawner ?? fakeGodot();
    const fetcher = fixtureFetcher(opts.ref ?? '4.7.2-stable');
    const docs = new DocsStore({
      godot: new GodotExecutable('godot', fake.spawner),
      cacheRoot,
      fetchText: fetcher.fetchText,
      offline: opts.offline ?? false,
    });
    return { docs, fake, fetcher };
  }

  it('builds the API index from doctool once and caches it on disk', async () => {
    const { docs, fake } = store();
    const index = await docs.api();
    expect([...index.classes.keys()]).toEqual(
      expect.arrayContaining(['Node', 'CharacterBody3D', '@GDScript', 'Vector3']),
    );
    expect(index.classes.get('@GDScript')?.sourcePath).toBe(
      'modules/gdscript/doc_classes/@GDScript.xml',
    );
    expect(index.children.get('Node')).toEqual(['Node3D']);
    await docs.api();
    expect(fake.calls.filter((c) => c.args.includes('--doctool'))).toHaveLength(1);

    const { docs: second, fake: secondFake } = store();
    await second.api();
    expect(secondFake.calls.filter((c) => c.args.includes('--doctool'))).toHaveLength(0);
  });

  it('fetches description text from the matching tag once, then serves it from disk', async () => {
    const { docs, fetcher } = store();
    const text = await docs.text('Node');
    expect(text?.members['method:add_child']).toContain('Adds a child');
    expect(fetcher.urls).toEqual([
      'https://raw.githubusercontent.com/godotengine/godot/4.7.2-stable/doc/classes/Node.xml',
    ]);
    await docs.text('Node');
    expect(fetcher.urls).toHaveLength(1);
    const { docs: fresh, fetcher: freshFetcher } = store();
    expect((await fresh.text('Node'))?.brief).toContain('Base class');
    expect(freshFetcher.urls).toHaveLength(0);
  });

  it('falls back to the commit hash when the tag has no docs', async () => {
    const { docs, fetcher } = store({ ref: 'ed1daf0bf' });
    expect(await docs.text('Node')).toBeDefined();
    expect(fetcher.urls.map((u) => u.split('/')[5])).toEqual(['4.7.2-stable', 'ed1daf0bf']);
  });

  it('returns undefined offline, for unknown classes, and when nothing is published (without caching failures)', async () => {
    expect(await store({ offline: true }).docs.text('Node')).toBeUndefined();
    const { docs, fetcher } = store({ ref: 'nowhere' });
    expect(await docs.text('Ghost')).toBeUndefined();
    expect(await docs.text('Node')).toBeUndefined();
    expect(await docs.text('Node')).toBeUndefined();
    expect(fetcher.urls.filter((u) => u.endsWith('Node.xml'))).toHaveLength(4);
    expect(existsSync(path.join(cacheRoot, 'docs'))).toBe(true);
  });

  it('ignores fetched content that is not a class XML', async () => {
    const fake = fakeGodot();
    const docs = new DocsStore({
      godot: new GodotExecutable('godot', fake.spawner),
      cacheRoot,
      fetchText: () => Promise.resolve('<html>rate limited</html>'),
      offline: false,
    });
    expect(await docs.text('Node')).toBeUndefined();
  });

  it('explains when doctool produces nothing, and retries next time', async () => {
    const broken = fakeSpawner((proc, call) => {
      if (call.args.includes('--version')) proc.stdout.write('4.7.2.stable.official.ed1daf0bf\n');
      proc.exit(call.args.includes('--version') ? 0 : 1);
    });
    const docs = new DocsStore({
      godot: new GodotExecutable('godot', broken.spawner),
      cacheRoot,
      fetchText: () => Promise.resolve(undefined),
      offline: false,
    });
    // Another test file's doctool run may be using the shared tmpdir at the same time.
    const foreign = mkdtempSync(path.join(tmpdir(), 'godotty-doctool-'));
    mkdirSync(path.join(foreign, 'doc'));
    onTestFinished(() => {
      rmSync(foreign, { recursive: true, force: true });
    });
    await expect(docs.api()).rejects.toThrow(/produced no class reference \(exit 1\)/);
    await expect(docs.api()).rejects.toThrow(/produced no class reference/);
    const doctoolCalls = broken.calls.filter((c) => c.args.includes('--doctool'));
    expect(doctoolCalls).toHaveLength(2);
    // Each run's own temp folder is cleaned up (the folder follows --doctool in its args).
    const used = doctoolCalls.map((c) => c.args[c.args.indexOf('--doctool') + 1] ?? '');
    expect(used.every((dir) => dir.includes('godotty-doctool-') && !existsSync(dir))).toBe(true);
  });
});

describe('httpFetchText', () => {
  it('resolves undefined on network failure', async () => {
    expect(await httpFetchText('http://127.0.0.1:1/nothing')).toBeUndefined();
  });
});
