import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './harness.js';

const FIXTURES = {
  // Type errors: valid syntax for gdlint, rejected by Godot's analyzer.
  'fixtures/type_error.gd':
    'extends Node\n\n\nfunc _ready() -> void:\n\tvar x: int = "hello"\n\tprint(undefined_thing)\n',
  'fixtures/parse_error.gd': 'extends Node\n\n\nfunc _ready( -> void:\n\tpass\n',
  // A scene whose script logs, warns, errors, and crashes a call, then keeps running.
  'scripts/crash.gd': [
    'extends Node',
    '',
    '',
    'func _ready() -> void:',
    '\tprint("crash scene ready")',
    '\tpush_warning("integration warning")',
    '\tpush_error("integration error")',
    '\t_boom()',
    '',
    '',
    'func _boom() -> void:',
    '\tvar n: Node = null',
    '\tn.queue_free()',
    '',
  ].join('\n'),
  'scenes/crash.tscn': [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="res://scripts/crash.gd" id="1"]',
    '',
    '[node name="Crash" type="Node"]',
    'script = ExtResource("1")',
    '',
  ].join('\n'),
};

describe('headless core against real Godot', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness(FIXTURES);
  });

  afterAll(async () => {
    await h.close();
  });

  it('project_info reports version, main scene and input map', async () => {
    const { text, isError } = await h.call('project_info');
    expect(isError).toBe(false);
    expect(text).toMatch(/Godot: 4\.\d+\.\d+/);
    expect(text).toContain('Main scene: res://scenes/main.tscn');
    expect(text).toContain('jump: SPACE (physical)');
    expect(text).toContain('Game: not running');
  });

  it('list_files filters by type', async () => {
    const { text } = await h.call('list_files', { type: 'scene' });
    expect(text).toContain('res://scenes/main.tscn');
    expect(text).not.toContain('.gd');
  });

  it('read_scene renders the main scene', async () => {
    const { text } = await h.call('read_scene', { path: 'res://scenes/main.tscn' });
    expect(text).toContain('└─ Player [instance res://scenes/player.tscn]  pos=(0, 1, 0)');
  });

  it('check_scripts reports errors with locations and passes clean scripts', async () => {
    const broken = await h.call('check_scripts', { path: 'res://fixtures' });
    expect(broken.isError).toBe(false);
    // Must come from Godot's language server, not the --check-only fallback.
    expect(broken.text).toContain('checked with headless-lsp');
    expect(broken.text).toContain('res://fixtures/type_error.gd');
    expect(broken.text).toMatch(/5:\d+ error: .*String/);
    expect(broken.text).toMatch(/6:\d+ error: Identifier "undefined_thing" not declared/);
    expect(broken.text).toContain('res://fixtures/parse_error.gd');
    expect(broken.text).toMatch(/4:\d+ error: Expected/);

    const clean = await h.call('check_scripts', { path: 'res://scripts/player.gd' });
    expect(clean.text).toMatch(/^No problems in 1 script/);
  });

  it('runs a scene, captures structured runtime errors and output, and stops it', async () => {
    const started = await h.call('run_game', { scene: 'res://scenes/crash.tscn', headless: true });
    expect(started.isError).toBe(false);
    expect(started.text).toContain('Runtime helper: ready');
    // The temporary override must be gone as soon as the game is up.
    expect(existsSync(path.join(h.root, 'override.cfg'))).toBe(false);

    await expect
      .poll(async () => (await h.call('get_errors')).text, { timeout: 10_000 })
      .toContain('Cannot call method');
    const errors = (await h.call('get_errors')).text;
    expect(errors).toMatch(
      /ERROR res:\/\/scripts\/crash\.gd:13 in _boom\(\): Cannot call method 'queue_free' on a null value/,
    );
    expect(errors).toMatch(
      /backtrace: _boom \(res:\/\/scripts\/crash\.gd:13\) ← _ready \(res:\/\/scripts\/crash\.gd:8\)/,
    );
    expect(errors).toMatch(/ERROR res:\/\/scripts\/crash\.gd:7 in _ready\(\): integration error/);
    expect(errors).toMatch(
      /WARNING res:\/\/scripts\/crash\.gd:6 in _ready\(\): integration warning/,
    );

    const output = await h.call('get_output', { pattern: 'crash scene ready' });
    expect(output.text).toMatch(/\d+ {2}\| crash scene ready/);
    const errorsOnly = await h.call('get_output', { filter: 'errors' });
    expect(errorsOnly.text).toContain('E| SCRIPT ERROR');

    const info = await h.call('project_info');
    expect(info.text).toMatch(/Game: running \(run #1/);

    const stopped = await h.call('stop_game');
    expect(stopped.text).toMatch(/^Stopped: Run #1/);
    expect(stopped.text).toContain('2 unique error(s), 1 unique warning(s)');
  });

  it('reports startup crashes and keeps the user override.cfg intact', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs');
    const userOverride = '[display]\n\nwindow/size/viewport_width=640\n';
    writeFileSync(path.join(h.root, 'override.cfg'), userOverride);
    const started = await h.call('run_game', { scene: 'res://scenes/main.tscn', headless: true });
    expect(started.isError).toBe(false);
    expect(readFileSync(path.join(h.root, 'override.cfg'), 'utf8')).toBe(userOverride);
    await h.call('stop_game');
  });

  it('gives actionable errors for bad input', async () => {
    const outside = await h.call('read_scene', { path: '../outside.tscn' });
    expect(outside).toMatchObject({ isError: true });
    expect(outside.text).toContain('PATH_OUTSIDE_PROJECT');
    const missing = await h.call('run_game', { scene: 'res://nope.tscn' });
    expect(missing.text).toContain('NOT_FOUND');
  });
});
