import { ErrorCode, ToolError } from './errors.js';

/**
 * Godot's str_to_var understands `Resource("res://x.gd")` and `Object(Class, ...)`. Loading a
 * resource can run script code (e.g. static initializers), so value literals with these
 * constructors would be code execution by another name. They are refused unless eval is enabled.
 * The Godot side enforces the same rule independently.
 */
/** How much of a rejected literal to quote back. */
const QUOTED_CHARS = 60;
const UNSAFE_LITERAL = /\b(?:Object|Resource|ExtResource|SubResource)\s*\(/;

export function assertSafeLiterals(
  literals: Iterable<string | undefined>,
  allowEval: boolean,
): void {
  if (allowEval) return;
  for (const literal of literals) {
    if (literal !== undefined && UNSAFE_LITERAL.test(literal)) {
      throw new ToolError(
        ErrorCode.InvalidInput,
        `Object/Resource literals are not allowed in values ("${literal.slice(0, QUOTED_CHARS)}").`,
        'Loading a resource can run script code. Attach scripts with update_node script=..., instance scenes with add_node scene=..., or start the server with --allow-eval.',
      );
    }
  }
}
