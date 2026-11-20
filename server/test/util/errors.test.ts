import { describe, expect, it } from 'vitest';

import { ErrorCode, formatError, ToolError } from '../../src/util/errors.js';

describe('formatError', () => {
  it('renders code, message and hint for ToolError', () => {
    const text = formatError(new ToolError(ErrorCode.NotFound, 'No scene.', 'Check the path.'));
    expect(text).toBe('Error [NOT_FOUND]: No scene.\nHint: Check the path.');
  });

  it('omits the hint line when there is none', () => {
    expect(formatError(new ToolError(ErrorCode.Timeout, 'Too slow.'))).toBe(
      'Error [TIMEOUT]: Too slow.',
    );
  });

  it('reports unexpected errors as INTERNAL with a bug-report hint', () => {
    expect(formatError(new Error('boom'))).toMatch(/^Error \[INTERNAL\]: boom\nHint: .*bug/);
    expect(formatError('raw string')).toMatch(/^Error \[INTERNAL\]: raw string/);
  });
});
