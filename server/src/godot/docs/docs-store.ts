import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ErrorCode, ToolError } from '../../util/errors.js';
import type { GodotExecutable, GodotVersion } from '../executable.js';
import { parseClassXml, type ClassApi, type ClassText } from './class-xml.js';

/** Fetches a URL's body as text; resolves undefined on 404 or network failure. */
export type TextFetcher = (url: string) => Promise<string | undefined>;

export interface DocsStoreOptions {
  godot: GodotExecutable;
  /** Root cache folder (e.g. ~/.cache/godotty-mcp). */
  cacheRoot: string;
  fetchText: TextFetcher;
  /** Never fetch description text from the network. */
  offline: boolean;
}

export interface ApiIndex {
  version: GodotVersion;
  classes: ReadonlyMap<string, ClassApi>;
  /** Class name → names of classes that directly inherit it. */
  children: ReadonlyMap<string, readonly string[]>;
}

/** Bump when the cached JSON shape changes so old caches are rebuilt. */
const CACHE_FORMAT = 2;
const DOCTOOL_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 10_000;
const SOURCE_BASE = 'https://raw.githubusercontent.com/godotengine/godot';
const COMMIT_HASH = /^[0-9a-f]{7,40}$/;

/**
 * Version-exact class reference. Signatures come from the installed Godot (`--doctool`, cached
 * per version); description text comes from the engine source at the matching tag or commit,
 * fetched per class on first use and cached, because `--doctool` output has no descriptions.
 */
export class DocsStore {
  private apiPromise: Promise<ApiIndex> | undefined;
  private readonly textCache = new Map<string, Promise<ClassText | undefined>>();

  public constructor(private readonly options: DocsStoreOptions) {}

  public api(): Promise<ApiIndex> {
    this.apiPromise ??= this.loadApi();
    this.apiPromise.catch(() => {
      this.apiPromise = undefined;
    });
    return this.apiPromise;
  }

  /** Description text for a class, or undefined when offline/unavailable for this build. */
  public text(className: string): Promise<ClassText | undefined> {
    let cached = this.textCache.get(className);
    if (cached === undefined) {
      cached = this.loadText(className);
      this.textCache.set(className, cached);
      // Failures aren't cached across calls: the network may come back.
      void cached.then((value) => {
        if (value === undefined) this.textCache.delete(className);
      });
    }
    return cached;
  }

  /** Base URL that replaces $DOCS_URL in descriptions. */
  public static docsBase(version: GodotVersion): string {
    return `https://docs.godotengine.org/en/${version.major}.${version.minor}`;
  }

  private async versionDir(): Promise<{ dir: string; version: GodotVersion }> {
    const version = await this.options.godot.version();
    const safe = version.full.replace(/[^A-Za-z0-9._-]/g, '_');
    return { dir: path.join(this.options.cacheRoot, 'docs', `${safe}-v${CACHE_FORMAT}`), version };
  }

  private async loadApi(): Promise<ApiIndex> {
    const { dir, version } = await this.versionDir();
    const file = path.join(dir, 'api.json');
    let classes: ClassApi[];
    if (existsSync(file)) {
      classes = JSON.parse(readFileSync(file, 'utf8')) as ClassApi[];
    } else {
      classes = await this.dumpApi();
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(classes));
    }
    return buildIndex(version, classes);
  }

  /** Runs `--doctool` into a temp folder and parses every class XML it writes. */
  private async dumpApi(): Promise<ClassApi[]> {
    const tmp = mkdtempSync(path.join(tmpdir(), 'godotty-doctool-'));
    try {
      const result = await this.options.godot.exec(['--headless', '--doctool', tmp], {
        cwd: tmp,
        timeoutMs: DOCTOOL_TIMEOUT_MS,
      });
      const files = listXml(tmp);
      if (files.length === 0) {
        throw new ToolError(
          ErrorCode.GodotFailed,
          `godot --doctool produced no class reference (exit ${result.exitCode ?? 'timeout'}).`,
          'Check that --godot points at a Godot 4 editor build (export templates cannot dump docs).',
        );
      }
      return files.map(
        (relative) => parseClassXml(readFileSync(path.join(tmp, relative), 'utf8'), relative).api,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async loadText(className: string): Promise<ClassText | undefined> {
    const { dir, version } = await this.versionDir();
    const file = path.join(dir, 'text', `${className.replace(/[^A-Za-z0-9@_-]/g, '_')}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ClassText;
    if (this.options.offline) return undefined;
    const api = (await this.api()).classes.get(className);
    if (api === undefined) return undefined;
    for (const ref of sourceRefs(version)) {
      const xml = await this.options.fetchText(`${SOURCE_BASE}/${ref}/${api.sourcePath}`);
      if (xml === undefined) continue;
      try {
        const { text } = parseClassXml(xml, api.sourcePath);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(text));
        return text;
      } catch {
        // Not a class XML (e.g. an HTML error page): try the next ref.
      }
    }
    return undefined;
  }
}

/** Git refs that may hold this build's docs: the release tag, then the build's commit. */
export function sourceRefs(version: GodotVersion): string[] {
  const refs: string[] = [];
  if (version.status !== 'dev' && version.status !== 'custom_build') {
    const number =
      version.patch === 0
        ? `${version.major}.${version.minor}`
        : `${version.major}.${version.minor}.${version.patch}`;
    refs.push(`${number}-${version.status}`);
  }
  const hash = version.full.split('.').at(-1) ?? '';
  if (COMMIT_HASH.test(hash)) refs.push(hash);
  return refs;
}

function buildIndex(version: GodotVersion, list: readonly ClassApi[]): ApiIndex {
  const classes = new Map(list.map((c) => [c.name, c]));
  const children = new Map<string, string[]>();
  for (const cls of list) {
    if (cls.inherits === undefined) continue;
    const siblings = children.get(cls.inherits) ?? [];
    siblings.push(cls.name);
    children.set(cls.inherits, siblings);
  }
  for (const names of children.values()) names.sort();
  return { version, classes, children };
}

function listXml(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.xml'))
        out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(root);
  return out.sort();
}

/** Default fetcher: global fetch with a timeout; any failure resolves undefined. */
export const httpFetchText: TextFetcher = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
};
