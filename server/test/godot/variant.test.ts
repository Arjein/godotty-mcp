import { describe, expect, it } from 'vitest';

import {
  formatNumber,
  formatVariant,
  isCall,
  isDict,
  isObject,
  measureVariant,
  parseVariant,
  VariantParseError,
} from '../../src/godot/variant.js';

describe('parseVariant', () => {
  it.each([
    ['true', true],
    ['false', false],
    ['null', null],
    ['42', 42],
    ['-3.5', -3.5],
    ['1e-05', 1e-5],
    ['.5', 0.5],
    ['inf', Infinity],
    ['-inf', -Infinity],
    ['"hi"', 'hi'],
    ['&"name"', 'name'],
    ['^"Path/To"', 'Path/To'],
    ['"a\\"b\\\\c\\nd\\u00e9"', 'a"b\\c\ndé'],
  ])('parses scalar %s', (text, expected) => {
    expect(parseVariant(text)).toEqual(expected);
  });

  it('parses nan', () => {
    expect(parseVariant('nan')).toBeNaN();
  });

  it('parses constructors and nested containers', () => {
    expect(parseVariant('Vector3(0, 1.5, -2)')).toEqual({
      kind: 'call',
      type: 'Vector3',
      args: [0, 1.5, -2],
    });
    expect(parseVariant('[1, "a", [true]]')).toEqual([1, 'a', [true]]);
    expect(parseVariant('{"k": Color(1, 0, 0, 1), 3: null}')).toEqual({
      kind: 'dict',
      entries: { k: { kind: 'call', type: 'Color', args: [1, 0, 0, 1] }, '3': null },
    });
    expect(parseVariant('PackedStringArray()')).toEqual({
      kind: 'call',
      type: 'PackedStringArray',
      args: [],
    });
  });

  it('accepts trailing commas', () => {
    expect(parseVariant('[1, 2,]')).toEqual([1, 2]);
    expect(parseVariant('{"a": 1,}')).toEqual({ kind: 'dict', entries: { a: 1 } });
  });

  it('parses Object(...) input events', () => {
    const value = parseVariant(
      'Object(InputEventKey,"device":-1,"physical_keycode":65,"script":null)',
    );
    expect(value).toEqual({
      kind: 'object',
      className: 'InputEventKey',
      props: { device: -1, physical_keycode: 65, script: null },
    });
  });

  it('unwraps typed containers', () => {
    expect(parseVariant('Array[int]([1, 2])')).toEqual([1, 2]);
    expect(parseVariant('Dictionary[String, Array[int]]({"a": [1]})')).toEqual({
      kind: 'dict',
      entries: { a: [1] },
    });
  });

  it.each(['', '[1, 2', '"open', '@', '1 2', 'Vector3(1,', '{"a" 1}', 'Array[int(1)', '-x'])(
    'rejects malformed input %j',
    (text) => {
      expect(() => parseVariant(text)).toThrow(VariantParseError);
    },
  );
});

describe('measureVariant', () => {
  it('measures a multi-line value and stops before trailing text', () => {
    const text = 'x = {\n"a": [1,\n2]\n}\nnext = 1';
    const start = text.indexOf('{');
    expect(text.slice(start, start + measureVariant(text, start))).toBe('{\n"a": [1,\n2]\n}');
  });
});

describe('formatVariant', () => {
  it('renders compactly', () => {
    expect(formatVariant(parseVariant('Vector3(0.30000001, 1, 0)'))).toBe('Vector3(0.3, 1, 0)');
    expect(formatVariant(parseVariant('{"a": [1, "b"]}'))).toBe('{a: [1, "b"]}');
    expect(formatVariant(parseVariant('Object(InputEventKey,"keycode":65)'))).toBe(
      'InputEventKey(keycode: 65)',
    );
    expect(formatVariant(null)).toBe('null');
    expect(formatVariant(true)).toBe('true');
  });

  it('formats numbers without float noise', () => {
    expect(formatNumber(3)).toBe('3');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
  });
});

describe('type guards', () => {
  it('distinguish value kinds', () => {
    const call = parseVariant('ExtResource("1")');
    expect(isCall(call)).toBe(true);
    expect(isCall(call, 'ExtResource')).toBe(true);
    expect(isCall(call, 'SubResource')).toBe(false);
    expect(isCall([1])).toBe(false);
    expect(isObject(parseVariant('Object(Foo)'))).toBe(true);
    expect(isObject(call)).toBe(false);
    expect(isDict(parseVariant('{}'))).toBe(true);
    expect(isDict(null)).toBe(false);
  });
});
