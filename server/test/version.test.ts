import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SERVER_NAME, SERVER_VERSION } from '../src/version.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('version', () => {
  it('matches between the npm package and the Godot addon', () => {
    const pluginCfg = readFileSync(path.join(repo, 'addon/addons/godotty_mcp/plugin.cfg'), 'utf8');
    expect(SERVER_NAME).toBe('godotty-mcp');
    expect(/^version="(.+)"$/m.exec(pluginCfg)?.[1]).toBe(SERVER_VERSION);
  });

  it('has a changelog entry', () => {
    expect(readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8')).toContain(
      `## [${SERVER_VERSION}]`,
    );
  });
});
