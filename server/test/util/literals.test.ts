import { describe, expect, it } from 'vitest';

import { assertSafeLiterals } from '../../src/util/literals.js';

describe('assertSafeLiterals', () => {
  it.each([
    'Resource("res://evil.gd")',
    'Object(Node,"script":null)',
    'ExtResource("1")',
    'SubResource ("x")',
    '[1, Resource("a")]',
  ])('rejects %s', (literal) => {
    expect(() => {
      assertSafeLiterals([literal], false);
    }).toThrow(/Object\/Resource literals are not allowed/);
  });

  it.each([
    'Vector3(1, 2, 3)',
    '"Resources are fine as text"',
    'true',
    '3.5',
    'Color(1, 0, 0, 1)',
    'MyObject',
  ])('accepts %s', (literal) => {
    expect(() => {
      assertSafeLiterals([literal, undefined], false);
    }).not.toThrow();
  });

  it('allows everything when eval is enabled', () => {
    expect(() => {
      assertSafeLiterals(['Resource("res://a.gd")'], true);
    }).not.toThrow();
  });
});
