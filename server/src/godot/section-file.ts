import { measureVariant, parseVariant, VariantParseError, type GdValue } from './variant.js';

/** One `[tag attr=value ...]` section and the `key = value` lines below it. */
export interface Section {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, GdValue>>;
  readonly props: readonly Property[];
  /** 1-based line of the section header, for error messages. */
  readonly line: number;
}

export interface Property {
  readonly key: string;
  readonly value: GdValue;
  /** The value exactly as written in the file (may span lines). */
  readonly raw: string;
}

/** Thrown with a 1-based line number when a file cannot be parsed. */
export class SectionFileError extends Error {
  public constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
  }
}

/**
 * Parses Godot's INI-like text formats: project.godot (ConfigFile), .tscn and .tres. Properties
 * that appear before the first section (e.g. `config_version=5`) go into a section with tag "".
 */
export function parseSectionFile(text: string): Section[] {
  return new SectionReader(text).read();
}

interface MutableSection {
  tag: string;
  attrs: Record<string, GdValue>;
  props: Property[];
  line: number;
}

class SectionReader {
  private position = 0;
  private readonly sections: MutableSection[] = [];
  private current: MutableSection = { tag: '', attrs: {}, props: [], line: 1 };

  public constructor(private readonly text: string) {}

  public read(): Section[] {
    for (;;) {
      this.skipBlankAndComments();
      if (this.position >= this.text.length) break;
      if (this.text[this.position] === '[') {
        this.header();
      } else {
        this.property();
      }
    }
    this.flush();
    return this.sections;
  }

  private lineAt(position: number): number {
    let line = 1;
    for (let i = 0; i < position; i++) {
      if (this.text[i] === '\n') line++;
    }
    return line;
  }

  private fail(message: string): never {
    throw new SectionFileError(message, this.lineAt(this.position));
  }

  private skipBlankAndComments(): void {
    while (this.position < this.text.length) {
      const c = this.text[this.position];
      if (c === ';' || c === '#') {
        const end = this.text.indexOf('\n', this.position);
        this.position = end === -1 ? this.text.length : end + 1;
      } else if (c !== undefined && /\s/.test(c)) {
        this.position++;
      } else {
        return;
      }
    }
  }

  private flush(): void {
    if (this.current.tag !== '' || this.current.props.length > 0) {
      this.sections.push(this.current);
    }
  }

  private header(): void {
    this.flush();
    const line = this.lineAt(this.position);
    this.position++; // '['
    const tag = this.word();
    const attrs: Record<string, GdValue> = {};
    for (;;) {
      this.skipInlineSpace();
      if (this.text[this.position] === ']') {
        this.position++;
        break;
      }
      const key = this.word();
      if (key === '' || this.text[this.position] !== '=')
        this.fail(`Malformed section header [${tag}`);
      this.position++; // '='
      attrs[key] = this.valueAt();
    }
    this.current = { tag, attrs, props: [], line };
  }

  private property(): void {
    const eq = this.text.indexOf('=', this.position);
    const newline = this.text.indexOf('\n', this.position);
    if (eq === -1 || (newline !== -1 && newline < eq)) this.fail('Expected "key = value"');
    const key = unquote(this.text.slice(this.position, eq).trim());
    this.position = eq + 1;
    this.skipInlineSpace();
    const start = this.position;
    const value = this.valueAt();
    this.current.props.push({ key, value, raw: this.text.slice(start, this.position) });
  }

  private valueAt(): GdValue {
    this.skipInlineSpace();
    try {
      const length = measureVariant(this.text, this.position);
      const raw = this.text.slice(this.position, this.position + length);
      this.position += length;
      return parseVariant(raw);
    } catch (error) {
      if (error instanceof VariantParseError) this.fail(error.message);
      throw error;
    }
  }

  private word(): string {
    const start = this.position;
    while (
      this.position < this.text.length &&
      /[A-Za-z0-9_/.:-]/.test(this.text[this.position] ?? '')
    ) {
      this.position++;
    }
    return this.text.slice(start, this.position);
  }

  private skipInlineSpace(): void {
    while (this.text[this.position] === ' ' || this.text[this.position] === '\t') {
      this.position++;
    }
  }
}

function unquote(key: string): string {
  return key.startsWith('"') && key.endsWith('"') ? key.slice(1, -1) : key;
}

/** Looks up a property by key in a section. */
export function getProp(section: Section | undefined, key: string): GdValue | undefined {
  return section?.props.find((p) => p.key === key)?.value;
}
