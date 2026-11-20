import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginate,
  truncateText,
} from '../../src/util/paginate.js';

const items = Array.from({ length: 120 }, (_, i) => i);

describe('paginate', () => {
  it('returns the first default-sized page with nextOffset', () => {
    const page = paginate(items);
    expect(page.items).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(page).toMatchObject({ total: 120, offset: 0, nextOffset: DEFAULT_PAGE_SIZE });
  });

  it('omits nextOffset on the last page', () => {
    const page = paginate(items, { offset: 100, limit: 50 });
    expect(page.items).toEqual(items.slice(100));
    expect(page.nextOffset).toBeUndefined();
  });

  it('clamps out-of-range and fractional values', () => {
    expect(paginate(items, { offset: -5, limit: 0 }).items).toEqual([0]);
    expect(paginate(items, { offset: 999 }).items).toEqual([]);
    expect(paginate(items, { limit: 10_000 }).items).toHaveLength(Math.min(120, MAX_PAGE_SIZE));
    expect(paginate(items, { offset: 2.7, limit: 2.2 }).items).toEqual([2, 3]);
  });
});

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    expect(truncateText('abc', 10, 'n/a')).toBe('abc');
  });

  it('cuts at a line boundary and explains how to get more', () => {
    const out = truncateText('line one\nline two\nline three', 15, 'use offset');
    expect(out).toBe('line one\n… [truncated 20 chars; use offset]');
  });

  it('hard-cuts when there is no newline within budget', () => {
    expect(truncateText('abcdefghij', 4, 'x')).toBe('abcd\n… [truncated 6 chars; x]');
  });
});
