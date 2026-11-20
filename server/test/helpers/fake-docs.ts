import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TextFetcher } from '../../src/godot/docs/docs-store.js';

/** Fixture class XMLs with descriptions, laid out like the engine source tree. */
export const DOC_FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/docs',
);

/** Mimics `godot --doctool <dir>`: same files, but description text removed (as real doctool does). */
export function writeDoctoolOutput(target: string): void {
  cpSync(DOC_FIXTURES, target, { recursive: true });
  for (const file of listFiles(target)) {
    const xml = readFileSync(file, 'utf8')
      .replace(/(<(brief_description|description)>)[\s\S]*?(<\/\2>)/g, '$1\n\t$3')
      .replace(/(<(member|constant)\b[^>]*>)[^<]*(<\/\2>)/g, '$1\n\t\t$3');
    writeFileSync(file, xml);
  }
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

/** A fetcher serving the fixtures for one git ref and recording every URL requested. */
export function fixtureFetcher(ref: string): { fetchText: TextFetcher; urls: string[] } {
  const urls: string[] = [];
  const base = `https://raw.githubusercontent.com/godotengine/godot/${ref}/`;
  return {
    urls,
    fetchText: (url) => {
      urls.push(url);
      if (!url.startsWith(base)) return Promise.resolve(undefined);
      try {
        return Promise.resolve(
          readFileSync(path.join(DOC_FIXTURES, url.slice(base.length)), 'utf8'),
        );
      } catch {
        return Promise.resolve(undefined);
      }
    },
  };
}
