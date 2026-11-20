import { describe, expect, it } from 'vitest';

import { bbcodeToMarkdown, dedent, firstSentence } from '../../../src/godot/docs/bbcode.js';

const BASE = 'https://docs.godotengine.org/en/4.7';

describe('bbcodeToMarkdown', () => {
  it('converts inline markup and references', () => {
    expect(
      bbcodeToMarkdown(
        '[b]Note:[/b] use [method add_child] on [Node], set [member owner], emit [signal ready], [param node] is [code]null[/code], press [kbd]Ctrl[/kbd], see [constant FOO] and [enum Node.ProcessMode], [annotation @export], [i]x[/i][u]y[/u][lb]z[rb]',
        BASE,
      ),
    ).toBe(
      '**Note:** use `add_child()` on Node, set `owner`, emit `ready`, `node` is `null`, press `Ctrl`, see `FOO` and `Node.ProcessMode`, `@export`, *x*y[z]',
    );
  });

  it('rewrites links and $DOCS_URL', () => {
    expect(
      bbcodeToMarkdown(
        '[url=$DOCS_URL/a.html]Guide[/url] and [url]https://x.dev[/url][br]next',
        BASE,
      ),
    ).toBe(`Guide (${BASE}/a.html) and https://x.dev\nnext`);
  });

  it('keeps GDScript examples, drops C#, and protects code from inline rules', () => {
    const text =
      '\t\tIntro.\n\t\t[codeblocks]\n\t\t[gdscript]\n\t\tif a:\n\t\t\tprint([b]x[/b])\n\t\t[/gdscript]\n\t\t[csharp]\n\t\tFoo();\n\t\t[/csharp]\n\t\t[/codeblocks]\n\t\t[codeblock lang=text]\n\t\traw [code]\n\t\t[/codeblock]';
    expect(bbcodeToMarkdown(text, BASE)).toBe(
      'Intro.\n\n```gdscript\nif a:\n\tprint([b]x[/b])\n```\n\n\n```gdscript\nraw [code]\n```',
    );
  });

  it('drops codeblocks without a GDScript variant and strips layout tags', () => {
    expect(
      bbcodeToMarkdown(
        'A[codeblocks][csharp]x[/csharp][/codeblocks] [center]B[/center][color=red]C[/color]',
        BASE,
      ),
    ).toBe('A BC');
  });
});

describe('dedent', () => {
  it('removes the common indent and leading blank lines', () => {
    expect(dedent('\n\t\ta\n\t\t\tb\n\n\t\tc\n')).toBe('a\n\tb\n\nc');
    expect(dedent('')).toBe('');
  });
});

describe('firstSentence', () => {
  it('returns the first sentence, ignoring code, and truncates', () => {
    expect(firstSentence('One thing. Two things.', 100)).toBe('One thing.');
    expect(firstSentence('No period here', 100)).toBe('No period here');
    expect(firstSentence('Example:\n```gdscript\nx. y\n```', 100)).toBe('Example:');
    expect(firstSentence('A very long sentence indeed.', 10)).toBe('A very lo…');
  });
});
