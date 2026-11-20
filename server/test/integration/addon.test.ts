import { cpSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEMO_PROJECT } from '../helpers/demo.js';
import { installTestAddon, startHarness, type Harness } from './harness.js';

const ADDON_ROOT = path.resolve(DEMO_PROJECT, '../../addon');

/** The addon's own GUT tests, run through run_tests in a demo copy with the addon installed. */
describe('addon GDScript tests (GUT)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    cpSync(
      path.join(ADDON_ROOT, 'addons', 'godotty_mcp'),
      path.join(h.root, 'addons', 'godotty_mcp'),
      { recursive: true },
    );
    cpSync(path.join(ADDON_ROOT, 'tests'), path.join(h.root, 'test', 'addon'), { recursive: true });
    installTestAddon(h.root, 'gut');
  });

  afterAll(async () => {
    await h.close();
  });

  it('pass', async () => {
    const { text } = await h.call('run_tests', { path: 'res://test/addon', include_passed: true });
    expect(text).toMatch(/^GUT PASSED — \d+ test\(s\): \d+ passed, 0 failed, 0 errored/);
    expect(text).not.toContain('failed to load');
  });
});
