/**
 * Error codes every tool may return. Codes are stable and part of the public output contract,
 * so agents (and tests) can branch on them.
 */
export const ErrorCode = {
  InvalidInput: 'INVALID_INPUT',
  PathOutsideProject: 'PATH_OUTSIDE_PROJECT',
  NotFound: 'NOT_FOUND',
  GodotNotFound: 'GODOT_NOT_FOUND',
  GodotFailed: 'GODOT_FAILED',
  EditorNotConnected: 'EDITOR_NOT_CONNECTED',
  GameNotRunning: 'GAME_NOT_RUNNING',
  Timeout: 'TIMEOUT',
  Disabled: 'DISABLED',
  Internal: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * An expected, user-facing failure. `hint` tells the agent what to do next and is always shown.
 * Throw this from tool handlers; anything else is treated as an internal error.
 */
export class ToolError extends Error {
  public readonly code: ErrorCode;
  public readonly hint: string | undefined;

  public constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hint = hint;
  }
}

/** Renders any thrown value as a single compact, actionable text block for an MCP error result. */
export function formatError(error: unknown): string {
  if (error instanceof ToolError) {
    const hint = error.hint === undefined ? '' : `\nHint: ${error.hint}`;
    return `Error [${error.code}]: ${error.message}${hint}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Error [${ErrorCode.Internal}]: ${message}\nHint: This is a bug in godot-mcp; please report it with the steps that led here.`;
}
