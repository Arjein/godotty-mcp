/**
 * Converts Godot class-reference markup (BBCode-like: `[code]`, `[method foo]`, `[codeblocks]`, …)
 * into compact Markdown suitable for an agent. C# examples are dropped; GDScript ones are kept.
 */

const DOCS_URL_TOKEN = '$DOCS_URL';
const CODEBLOCKS = /\[codeblocks\]([\s\S]*?)\[\/codeblocks\]/g;
const GDSCRIPT_BLOCK = /\[gdscript[^\]]*\]([\s\S]*?)\[\/gdscript\]/;
const CODEBLOCK = /\[codeblock[^\]]*\]([\s\S]*?)\[\/codeblock\]/g;
/** `[method foo]`, `[member Node.name]`, … → the referenced name in backticks. */
const REFERENCE =
  /\[(method|member|signal|constant|enum|param|annotation|theme_item|operator|constructor) ([^\]]+)\]/g;
/** A bare class reference such as `[Node]` or `[@GlobalScope]`. */
const CLASS_REFERENCE = /\[(@?[A-Z][A-Za-z0-9_]*)\]/g;

/** Converts markup to Markdown. `docsBase` replaces $DOCS_URL in links. */
export function bbcodeToMarkdown(text: string, docsBase: string): string {
  const blocks: string[] = [];
  // Code blocks first, so the inline rules below don't touch their contents.
  const stash = (code: string): string => {
    blocks.push(`\n\`\`\`gdscript\n${dedent(code).trim()}\n\`\`\`\n`);
    return `\uE000${blocks.length - 1}\uE000`;
  };
  let out = dedent(text)
    .replace(CODEBLOCKS, (_m, inner: string) => {
      const gd = GDSCRIPT_BLOCK.exec(inner);
      return gd === null ? '' : stash(gd[1] ?? '');
    })
    .replace(CODEBLOCK, (_m, code: string) => stash(code));

  out = out
    .replace(/\[code\]([\s\S]*?)\[\/code\]/g, '`$1`')
    .replace(/\[kbd\]([\s\S]*?)\[\/kbd\]/g, '`$1`')
    .replace(/\[b\]([\s\S]*?)\[\/b\]/g, '**$1**')
    .replace(/\[i\]([\s\S]*?)\[\/i\]/g, '*$1*')
    .replace(/\[u\]([\s\S]*?)\[\/u\]/g, '$1')
    .replace(
      /\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/g,
      (_m, url: string, label: string) => `${label} (${url})`,
    )
    .replace(/\[url\]([\s\S]*?)\[\/url\]/g, '$1')
    .replace(
      REFERENCE,
      (_m, kind: string, name: string) =>
        `\`${name}${kind === 'method' || kind === 'constructor' ? '()' : ''}\``,
    )
    .replace(CLASS_REFERENCE, '$1')
    .replace(/\[br\]/g, '\n')
    .replace(/\[\/?(center|color[^\]]*|font[^\]]*)\]/g, '')
    .replace(/\[lb\]/g, '[')
    .replace(/\[rb\]/g, ']')
    .split(DOCS_URL_TOKEN)
    .join(docsBase)
    .replace(/\n{3,}/g, '\n\n');

  return out.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => blocks[Number(i)] ?? '').trim();
}

/** Removes the common leading indentation (Godot indents descriptions with tabs). */
export function dedent(text: string): string {
  const lines = text.replace(/^\n+/, '').split('\n');
  const indents = lines
    .filter((l) => l.trim() !== '')
    .map((l) => /^[\t ]*/.exec(l)?.[0].length ?? 0);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines
    .map((l) => l.slice(common))
    .join('\n')
    .trimEnd();
}

/** First sentence of a Markdown description, for one-line summaries. */
export function firstSentence(markdown: string, maxChars: number): string {
  const flat = markdown.split('```')[0]?.replace(/\s+/g, ' ').trim() ?? '';
  const end = flat.search(/(?<=[.!?])\s/);
  const sentence = end === -1 ? flat : flat.slice(0, end);
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1)}…` : sentence;
}
