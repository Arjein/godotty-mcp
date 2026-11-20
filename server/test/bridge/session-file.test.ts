import { readFileSync, statSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  removeSessionFile,
  sessionFilePath,
  writeSessionFile,
} from '../../src/bridge/session-file.js';
import { makeTempProject } from '../helpers/tmp-project.js';

describe('session file', () => {
  let project: ReturnType<typeof makeTempProject>;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('is written owner-only with port, token, protocol and pid', () => {
    writeSessionFile(project.root, 4321, 'secret', '1.2.3');
    const file = sessionFilePath(project.root);
    expect(file).toMatch(/\.godot[/\\]godotty_mcp[/\\]session\.json$/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      port: 4321,
      token: 'secret',
      protocol: 1,
      pid: process.pid,
      server: '1.2.3',
      allow_eval: false,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeSessionFile(project.root, 4321, 'secret', '1.2.3', true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ allow_eval: true });
  });

  it('is removed only while it still belongs to this process', () => {
    writeSessionFile(project.root, 1, 't', 'v');
    const file = sessionFilePath(project.root);
    writeFileSync(file, JSON.stringify({ pid: process.pid + 1 }));
    removeSessionFile(project.root);
    expect(readFileSync(file, 'utf8')).toContain(String(process.pid + 1));
    writeSessionFile(project.root, 1, 't', 'v');
    removeSessionFile(project.root);
    expect(() => statSync(file)).toThrow();
    removeSessionFile(project.root);
    writeFileSync(file, 'garbage');
    removeSessionFile(project.root);
    expect(() => statSync(file)).toThrow();
  });
});
