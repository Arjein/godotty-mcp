/**
 * Parser for Godot's text Variant syntax, as used in project.godot, .tscn and .tres files, e.g.
 * `Vector3(0, 1, 0)`, `PackedStringArray("a")`, `{"events": [Object(InputEventKey,"keycode":65)]}`,
 * `ExtResource("1_abc")`, `&"string_name"`, `Array[int]([1, 2])`.
 */

/** A constructor-style value such as `Vector3(1, 2, 3)` or `ExtResource("1_abc")`. */
export interface GdCall {
  readonly kind: 'call';
  readonly type: string;
  readonly args: readonly GdValue[];
}

/** `Object(ClassName, "prop": value, ...)`, used for inline objects such as input events. */
export interface GdObject {
  readonly kind: 'object';
  readonly className: string;
  readonly props: Readonly<Record<string, GdValue>>;
}

/** A dictionary. Keys are stringified (Godot allows any Variant as a key). */
export interface GdDict {
  readonly kind: 'dict';
  readonly entries: Readonly<Record<string, GdValue>>;
}

export type GdValue =
  null | boolean | number | string | readonly GdValue[] | GdCall | GdObject | GdDict;

export class VariantParseError extends Error {}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const NUMBER = /^-?(?:\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)/i;
const SPECIAL_NUMBERS: Readonly<Record<string, number>> = { inf: Infinity, nan: NaN };
const NEGATIVE_INF = '-inf';
const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '"': '"',
  '\\': '\\',
};
const HEX = 16;
const ERROR_SNIPPET_CHARS = 20;
/** Deeper nesting is refused (hostile files would otherwise exhaust the stack). */
const MAX_DEPTH = 64;

/** Assigns without invoking setters such as __proto__. */
function setOwn(target: Record<string, GdValue>, key: string, value: GdValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
const UNICODE_ESCAPE_LENGTH = 4;

/** Parses one complete Variant value; throws VariantParseError on malformed or trailing input. */
export function parseVariant(text: string): GdValue {
  const parser = new Parser(text);
  const value = parser.value();
  parser.skipSpace();
  if (!parser.done()) {
    throw parser.error('Unexpected trailing input');
  }
  return value;
}

/**
 * Returns the length of the Variant value starting at `start` (strings, brackets and parentheses
 * balanced). Used to find where a possibly multi-line property value ends in a resource file.
 */
export function measureVariant(text: string, start: number): number {
  const parser = new Parser(text, start);
  parser.value();
  return parser.position - start;
}

class Parser {
  public position: number;

  public constructor(
    private readonly text: string,
    start = 0,
  ) {
    this.position = start;
  }

  public done(): boolean {
    return this.position >= this.text.length;
  }

  public error(message: string): VariantParseError {
    const snippet = this.text.slice(this.position, this.position + ERROR_SNIPPET_CHARS);
    return new VariantParseError(`${message} at offset ${this.position}: "${snippet}"`);
  }

  public skipSpace(): void {
    while (!this.done() && /\s/.test(this.peek())) {
      this.position++;
    }
  }

  private depth = 0;

  public value(): GdValue {
    if (++this.depth > MAX_DEPTH) throw this.error('Nesting is too deep');
    try {
      return this.valueInner();
    } finally {
      this.depth--;
    }
  }

  private valueInner(): GdValue {
    this.skipSpace();
    const c = this.peek();
    if (c === '"') return this.string();
    if ((c === '&' || c === '^') && this.text[this.position + 1] === '"') {
      this.position++; // StringName / NodePath literals are represented as plain strings.
      return this.string();
    }
    if (c === '[') return this.array();
    if (c === '{') return this.dict();
    if (c === '-' || c === '.' || /\d/.test(c)) return this.number();
    if (IDENT_START.test(c)) return this.identifierValue();
    throw this.error('Unexpected character');
  }

  private peek(): string {
    return this.text[this.position] ?? '';
  }

  private expect(char: string): void {
    this.skipSpace();
    if (this.peek() !== char) {
      throw this.error(`Expected "${char}"`);
    }
    this.position++;
  }

  /** Consumes `char` if it is next (after whitespace) and reports whether it did. */
  private accept(char: string): boolean {
    this.skipSpace();
    if (this.peek() === char) {
      this.position++;
      return true;
    }
    return false;
  }

  private string(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      if (this.done()) throw this.error('Unterminated string');
      const c = this.text[this.position++] ?? '';
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const next = this.text[this.position++] ?? '';
      if (next === 'u') {
        const hex = this.text.slice(this.position, this.position + UNICODE_ESCAPE_LENGTH);
        out += String.fromCharCode(parseInt(hex, HEX));
        this.position += UNICODE_ESCAPE_LENGTH;
      } else {
        out += ESCAPES[next] ?? next;
      }
    }
  }

  private number(): number {
    if (this.text.startsWith(NEGATIVE_INF, this.position)) {
      this.position += NEGATIVE_INF.length;
      return -Infinity;
    }
    const match = NUMBER.exec(this.text.slice(this.position));
    if (match === null) throw this.error('Invalid number');
    this.position += match[0].length;
    return Number(match[0]);
  }

  private identifier(): string {
    const start = this.position;
    while (!this.done() && IDENT_PART.test(this.peek())) {
      this.position++;
    }
    return this.text.slice(start, this.position);
  }

  private identifierValue(): GdValue {
    const name = this.identifier();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    const special = SPECIAL_NUMBERS[name];
    if (special !== undefined) return special;
    this.skipSpace();
    if (this.peek() === '[') {
      return this.typedContainer();
    }
    if (name === 'Object') return this.object();
    return { kind: 'call', type: name, args: this.list('(', ')') };
  }

  /** `Array[int]([1, 2])` or `Dictionary[String, int]({...})`: the type parameters are dropped. */
  private typedContainer(): GdValue {
    this.skipBalanced('[', ']');
    this.expect('(');
    const inner = this.value();
    this.expect(')');
    return inner;
  }

  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      if (this.done()) throw this.error(`Unbalanced "${open}"`);
      const c = this.text[this.position++];
      if (c === open) depth++;
      if (c === close) depth--;
    }
  }

  private object(): GdObject {
    this.expect('(');
    this.skipSpace();
    const className = this.identifier();
    const props: Record<string, GdValue> = {};
    while (this.accept(',')) {
      const key = this.string();
      this.expect(':');
      setOwn(props, key, this.value());
    }
    this.expect(')');
    return { kind: 'object', className, props };
  }

  private array(): GdValue[] {
    return this.list('[', ']');
  }

  private list(open: string, close: string): GdValue[] {
    this.expect(open);
    const items: GdValue[] = [];
    if (this.accept(close)) return items;
    do {
      if (this.accept(close)) return items; // trailing comma
      items.push(this.value());
    } while (this.accept(','));
    this.expect(close);
    return items;
  }

  private dict(): GdDict {
    this.expect('{');
    const entries: Record<string, GdValue> = {};
    if (this.accept('}')) return { kind: 'dict', entries };
    do {
      if (this.accept('}')) return { kind: 'dict', entries };
      const key = this.value();
      this.expect(':');
      setOwn(entries, typeof key === 'string' ? key : formatVariant(key), this.value());
    } while (this.accept(','));
    this.expect('}');
    return { kind: 'dict', entries };
  }
}

/** Compact, human-readable rendering (not round-trippable): `Vector3(0, 1, 0)`, `"text"`. */
export function formatVariant(value: GdValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(formatVariant).join(', ')}]`;
  const complex = value as GdCall | GdObject | GdDict;
  switch (complex.kind) {
    case 'call':
      return `${complex.type}(${complex.args.map(formatVariant).join(', ')})`;
    case 'object':
      return `${complex.className}(${formatEntries(complex.props)})`;
    case 'dict':
      return `{${formatEntries(complex.entries)}}`;
  }
}

function formatEntries(entries: Readonly<Record<string, GdValue>>): string {
  return Object.entries(entries)
    .map(([k, v]) => `${k}: ${formatVariant(v)}`)
    .join(', ');
}

/** Trims float noise such as 0.30000001 → 0.3 for display. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const DISPLAY_PRECISION = 6;
  return String(Number(n.toPrecision(DISPLAY_PRECISION)));
}

function kindOf(value: GdValue | undefined): 'call' | 'object' | 'dict' | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return (value as GdCall | GdObject | GdDict).kind;
}

/** Type guard for constructor-style values, optionally of a specific type. */
export function isCall(value: GdValue | undefined, type?: string): value is GdCall {
  return kindOf(value) === 'call' && (type === undefined || (value as GdCall).type === type);
}

export function isObject(value: GdValue | undefined): value is GdObject {
  return kindOf(value) === 'object';
}

export function isDict(value: GdValue | undefined): value is GdDict {
  return kindOf(value) === 'dict';
}
