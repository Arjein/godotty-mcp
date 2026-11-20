import { describe, expect, it } from 'vitest';

import { OutputBuffer } from '../../src/godot/output-buffer.js';

const ALL = { filter: 'all' as const, limit: 100 };

describe('OutputBuffer', () => {
  it('splits chunks into lines, keeping partial lines until complete', () => {
    const buffer = new OutputBuffer(100);
    buffer.push('stdout', 'hello\nwor');
    expect(buffer.all().map((l) => l.text)).toEqual(['hello']);
    buffer.push('stdout', 'ld\r\n');
    buffer.push('stderr', 'tail without newline');
    buffer.end();
    expect(buffer.all().map((l) => [l.seq, l.stream, l.text])).toEqual([
      [1, 'stdout', 'hello'],
      [2, 'stdout', 'world'],
      [3, 'stderr', 'tail without newline'],
    ]);
    expect(buffer.lastSeq).toBe(3);
  });

  it('tracks levels per stream across chunks', () => {
    const buffer = new OutputBuffer(100);
    buffer.push('stderr', 'ERROR: boom\n');
    buffer.push('stdout', 'normal\n');
    buffer.push('stderr', '   at: f (res://a.gd:1)\n');
    expect(buffer.all().map((l) => l.level)).toEqual(['error', 'info', 'error']);
  });

  it('queries newest lines by default and lines after a cursor otherwise', () => {
    const buffer = new OutputBuffer(100);
    buffer.push('stdout', 'a\nb\nc\nd\n');
    expect(buffer.query({ ...ALL, limit: 2 }).lines.map((l) => l.text)).toEqual(['c', 'd']);
    expect(buffer.query({ ...ALL, since: 1, limit: 2 }).lines.map((l) => l.text)).toEqual([
      'b',
      'c',
    ]);
    expect(buffer.query({ ...ALL, since: 4 }).lines).toEqual([]);
  });

  it('filters by level and text and reports matches', () => {
    const buffer = new OutputBuffer(100);
    buffer.push('stderr', 'WARNING: w\nERROR: e\n');
    buffer.push('stdout', 'info line\n');
    expect(buffer.query({ ...ALL, filter: 'errors' }).lines.map((l) => l.text)).toEqual([
      'ERROR: e',
    ]);
    expect(buffer.query({ ...ALL, filter: 'warnings' }).matched).toBe(2);
    expect(buffer.query({ ...ALL, contains: 'INFO' }).lines.map((l) => l.text)).toEqual([
      'info line',
    ]);
  });

  it('discards the oldest lines beyond capacity, in batches', () => {
    const buffer = new OutputBuffer(10);
    for (let i = 1; i <= 25; i++) buffer.push('stdout', `${i}\n`);
    const lines = buffer.all();
    expect(lines.length).toBeGreaterThanOrEqual(10);
    expect(lines.length).toBeLessThanOrEqual(11);
    expect(lines.at(-1)?.text).toBe('25');
    const page = buffer.query(ALL);
    expect(page.dropped).toBe(25 - lines.length);
  });
});
