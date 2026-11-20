import { describe, expect, it } from 'vitest';

import {
  classifyLines,
  errorKey,
  loggerRecordToError,
  parseErrorBlocks,
  withUserLocation,
} from '../../src/godot/godot-log.js';

// Verbatim Godot 4.7.2 stderr captured during the M2 spike.
const STDERR = `WARNING: demo warning
     at: push_warning (core/variant/variant_utility.cpp:1033)
     GDScript backtrace (most recent call first):
         [0] _ready (res://runtime.gd:31)
ERROR: demo error
   at: push_error (core/variant/variant_utility.cpp:1023)
   GDScript backtrace (most recent call first):
       [0] _ready (res://runtime.gd:32)
SCRIPT ERROR: Cannot call method 'queue_free' on a null value.
          at: _boom (res://runtime.gd:37)
          GDScript backtrace (most recent call first):
              [0] _boom (res://runtime.gd:37)
              [1] _ready (res://runtime.gd:33)
plain output line
ERROR: Failed to load script "res://x.gd" with error "Parse error".
   at: load (modules/gdscript/gdscript_resource_format.cpp:46)`.split('\n');

describe('classifyLines', () => {
  it('assigns header levels to continuation lines and resets on plain output', () => {
    const levels = classifyLines(STDERR);
    expect(levels.slice(0, 4)).toEqual(['warning', 'warning', 'warning', 'warning']);
    expect(levels[4]).toBe('error');
    expect(levels[13]).toBe('info');
    expect(levels[14]).toBe('error');
    expect(classifyLines(['ERROR: x', '', '  indented after blank'])).toEqual([
      'error',
      'info',
      'info',
    ]);
  });
});

describe('parseErrorBlocks', () => {
  it('extracts structured errors and promotes script locations', () => {
    const errors = parseErrorBlocks(STDERR);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toEqual({
      severity: 'warning',
      kind: 'engine',
      message: 'demo warning',
      function: '_ready',
      file: 'res://runtime.gd',
      line: 31,
      backtrace: [{ function: '_ready', file: 'res://runtime.gd', line: 31 }],
    });
    expect(errors[2]).toMatchObject({
      kind: 'script',
      file: 'res://runtime.gd',
      line: 37,
      function: '_boom',
    });
    expect(errors[2]?.backtrace).toHaveLength(2);
    // No script frame: the engine location is kept.
    expect(errors[3]).toMatchObject({
      file: 'modules/gdscript/gdscript_resource_format.cpp',
      line: 46,
    });
  });

  it('parses parse errors and shader errors', () => {
    const errors = parseErrorBlocks([
      'SCRIPT ERROR: Parse Error: Expected parameter name.',
      '          at: GDScript::reload (res://fixtures/parse_error.gd:3)',
      'SHADER ERROR: bad shader',
    ]);
    expect(errors[0]).toMatchObject({
      kind: 'script',
      message: 'Parse Error: Expected parameter name.',
      line: 3,
    });
    expect(errors[1]).toMatchObject({ kind: 'shader', file: undefined, line: undefined });
  });
});

describe('loggerRecordToError', () => {
  it('maps Logger records, preferring rationale and script frames', () => {
    const base = {
      function: 'push_error',
      file: 'core/x.cpp',
      line: 9,
      code: 'code text',
      rationale: '',
      backtrace: [],
    };
    expect(loggerRecordToError({ ...base, type: 0 })).toMatchObject({
      severity: 'error',
      kind: 'engine',
      message: 'code text',
    });
    expect(loggerRecordToError({ ...base, type: 1, rationale: 'why' })).toMatchObject({
      severity: 'warning',
      message: 'why',
    });
    expect(loggerRecordToError({ ...base, type: 2 }).kind).toBe('script');
    expect(loggerRecordToError({ ...base, type: 3 }).kind).toBe('shader');
    expect(loggerRecordToError({ ...base, type: 99 }).severity).toBe('error');
    const withFrame = loggerRecordToError({
      ...base,
      type: 0,
      backtrace: [{ function: 'f', file: 'res://a.gd', line: 4 }],
    });
    expect(withFrame).toMatchObject({ file: 'res://a.gd', line: 4, function: 'f' });
  });
});

describe('helpers', () => {
  it('keeps res:// locations and builds stable keys', () => {
    const error = {
      severity: 'error' as const,
      kind: 'script' as const,
      message: 'm',
      file: 'res://a.gd',
      line: 1,
      function: 'f',
      backtrace: [],
    };
    expect(withUserLocation(error)).toBe(error);
    expect(errorKey(error)).toBe('error|m|res://a.gd:1');
    expect(errorKey({ ...error, file: undefined, line: undefined })).toBe('error|m|:');
  });
});
