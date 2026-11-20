import { z } from 'zod';

import { formatVersion } from '../godot/executable.js';
import { bbcodeToMarkdown, firstSentence } from '../godot/docs/bbcode.js';
import {
  memberKey,
  type ClassApi,
  type ClassText,
  type MemberDoc,
  type MemberKind,
} from '../godot/docs/class-xml.js';
import { DocsStore, type ApiIndex } from '../godot/docs/docs-store.js';
import {
  ancestry,
  enumShortName,
  resolve,
  type EnumDoc,
  type SearchHit,
} from '../godot/docs/lookup.js';
import { paginate, truncateText } from '../util/paginate.js';
import { defineTool, textResult, type ToolContext } from './registry.js';

const SECTIONS = ['overview', 'methods', 'properties', 'signals', 'constants'] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_KINDS: Readonly<Record<Exclude<Section, 'overview'>, readonly MemberKind[]>> = {
  methods: ['method', 'constructor', 'operator', 'annotation'],
  properties: ['property', 'theme_item'],
  signals: ['signal'],
  constants: ['constant'],
};
const MAX_SEARCH_HITS = 15;
const MAX_QUERY_CHARS = 200;
const DESCRIPTION_BUDGET = 2500;
const MEMBER_BUDGET = 5000;
const SUMMARY_CHARS = 110;
const INHERITED_BY_SHOWN = 12;
const TUTORIALS_SHOWN = 3;
const DEFAULT_SECTION_LIMIT = 60;
const MAX_SECTION_LIMIT = 300;
const NO_TEXT_NOTE =
  '(Description text unavailable — offline, or no published docs for this build. Signatures above are exact for your Godot.)';

export const godotDocs = defineTool({
  name: 'godot_docs',
  title: 'Godot docs',
  description:
    'Looks up the class reference of the INSTALLED Godot version (exact signatures from your Godot binary; ' +
    'descriptions from the matching engine release, cached). Use it instead of memory to avoid Godot 3/4 API ' +
    'mix-ups. Query forms: "CharacterBody3D" (class overview: inheritance, description, member names), ' +
    '"Node.add_child" or "CharacterBody3D.velocity" (one member, also found on ancestors), "Node.ProcessMode" ' +
    '(enum), or any word like "move_and_slide", "lerp", "@export" (ranked search). Use "section" with a class ' +
    'to list all methods/properties/signals/constants with signatures.',
  inputSchema: {
    query: z
      .string()
      .min(1)
      .max(MAX_QUERY_CHARS)
      .describe('Class, Class.member, or a search term.'),
    section: z
      .enum(SECTIONS)
      .default('overview')
      .describe('For a class query: which part to show.'),
    offset: z.number().int().min(0).default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SECTION_LIMIT)
      .default(DEFAULT_SECTION_LIMIT)
      .describe('Items per page for section lists.'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) =>
    textResult(await lookup(ctx, args.query, args.section, args.offset, args.limit)),
});

async function lookup(
  ctx: ToolContext,
  query: string,
  section: Section,
  offset: number,
  limit: number,
): Promise<string> {
  const index = await ctx.docs.api();
  const header = `Godot ${formatVersion(index.version)} docs`;
  const resolution = resolve(index, query, MAX_SEARCH_HITS);
  const docsBase = DocsStore.docsBase(index.version);
  const md = (text: string): string => bbcodeToMarkdown(text, docsBase);
  switch (resolution.kind) {
    case 'class': {
      const text = await ctx.docs.text(resolution.cls.name);
      return section === 'overview'
        ? classOverview(header, index, resolution.cls, text, md)
        : sectionList(header, resolution.cls, text, section, offset, limit, md);
    }
    case 'member': {
      const text = await ctx.docs.text(resolution.owner.name);
      return memberDetail(header, resolution.cls, resolution.owner, resolution.members, text, md);
    }
    case 'enum': {
      const text = await ctx.docs.text(resolution.owner.name);
      return enumDetail(header, resolution.cls, resolution.owner, resolution.enumDoc, text, md);
    }
    case 'search':
      return searchResults(header, query, resolution.hits);
  }
}

function classOverview(
  header: string,
  index: ApiIndex,
  cls: ClassApi,
  text: ClassText | undefined,
  md: (t: string) => string,
): string {
  const chain = ancestry(index, cls)
    .slice(1)
    .map((c) => c.name);
  const children = index.children.get(cls.name) ?? [];
  const lines = [`${header} — class ${cls.name}${flags(cls)}`];
  if (chain.length > 0) lines.push(`Inherits: ${chain.join(' < ')}`);
  if (children.length > 0) {
    const more =
      children.length > INHERITED_BY_SHOWN
        ? `, … (${children.length - INHERITED_BY_SHOWN} more)`
        : '';
    lines.push(`Inherited by: ${children.slice(0, INHERITED_BY_SHOWN).join(', ')}${more}`);
  }
  if (text === undefined) {
    lines.push(NO_TEXT_NOTE);
  } else {
    lines.push(
      '',
      md(text.brief),
      '',
      truncateText(
        md(text.description),
        DESCRIPTION_BUDGET,
        `the full text is at ${cls.name} in the online docs`,
      ),
    );
  }
  lines.push('');
  for (const [title, kinds] of Object.entries(SECTION_KINDS)) {
    const members = cls.members.filter((m) => kinds.includes(m.kind));
    if (members.length === 0) continue;
    const names =
      title === 'constants'
        ? constantGroups(members)
        : members.map((m) => (m.kind === 'constructor' ? `${cls.name}()` : m.name));
    lines.push(`${capitalize(title)} (${members.length}): ${names.join(', ')}`);
  }
  if (text !== undefined && text.tutorials.length > 0) {
    const shown = text.tutorials.slice(0, TUTORIALS_SHOWN).map((t) => `${t.title} (${md(t.url)})`);
    const more =
      text.tutorials.length > TUTORIALS_SHOWN
        ? `; +${text.tutorials.length - TUTORIALS_SHOWN} more`
        : '';
    lines.push(`Tutorials: ${shown.join('; ')}${more}`);
  }
  lines.push(
    `More: query "${cls.name}.<member>" for details, or section="methods"|"properties"|"signals"|"constants" for signatures. Inherited members are documented on the ancestors.`,
  );
  return lines.join('\n');
}

/** "ProcessMode (PROCESS_MODE_INHERIT, …)" for enums, plain names for loose constants. */
function constantGroups(constants: readonly MemberDoc[]): string[] {
  const groups = new Map<string, string[]>();
  const loose: string[] = [];
  for (const c of constants) {
    if (c.enumName === undefined) loose.push(c.name);
    else groups.set(c.enumName, [...(groups.get(c.enumName) ?? []), c.name]);
  }
  return [
    ...[...groups.entries()].map(
      ([name, values]) => `enum ${enumShortName(name)} {${values.join(', ')}}`,
    ),
    ...loose,
  ];
}

function sectionList(
  header: string,
  cls: ClassApi,
  text: ClassText | undefined,
  section: Exclude<Section, 'overview'>,
  offset: number,
  limit: number,
  md: (t: string) => string,
): string {
  const members = cls.members.filter((m) => SECTION_KINDS[section].includes(m.kind));
  if (members.length === 0)
    return `${header} — ${cls.name} declares no ${section} (check its ancestors).`;
  const page = paginate(members, { offset, limit });
  const lines = [
    `${header} — ${cls.name} ${section} (${page.total}), showing ${page.offset + 1}–${page.offset + page.items.length}:`,
  ];
  for (const member of page.items) {
    const description = text?.members[memberKey(member)];
    const summary =
      description === undefined ? '' : ` — ${firstSentence(md(description), SUMMARY_CHARS)}`;
    const group = member.enumName === undefined ? '' : `[${enumShortName(member.enumName)}] `;
    lines.push(`${group}${signature(cls, member)}${flags(member)}${summary}`);
  }
  if (page.nextOffset !== undefined) lines.push(`More: call again with offset=${page.nextOffset}.`);
  if (text === undefined) lines.push(NO_TEXT_NOTE);
  return lines.join('\n');
}

function memberDetail(
  header: string,
  cls: ClassApi,
  owner: ClassApi,
  members: readonly MemberDoc[],
  text: ClassText | undefined,
  md: (t: string) => string,
): string {
  const parts = members.map((member) => {
    const lines = [
      `${header} — ${owner.name}.${member.name} (${member.kind === 'property' ? 'property' : member.kind})${flags(member)}`,
    ];
    if (owner !== cls) lines.push(`Inherited by ${cls.name} from ${owner.name}.`);
    lines.push(signature(owner, member));
    const description = text?.members[memberKey(member)];
    if (text === undefined) lines.push(NO_TEXT_NOTE);
    else if (description !== undefined) lines.push('', md(description));
    return lines.join('\n');
  });
  return truncateText(parts.join('\n\n'), MEMBER_BUDGET, 'see the online docs for the rest');
}

function enumDetail(
  header: string,
  cls: ClassApi,
  owner: ClassApi,
  enumDoc: EnumDoc,
  text: ClassText | undefined,
  md: (t: string) => string,
): string {
  const lines = [`${header} — enum ${owner.name}.${enumShortName(enumDoc.name)}`];
  if (owner !== cls) lines.push(`Inherited by ${cls.name} from ${owner.name}.`);
  for (const constant of enumDoc.constants) {
    const description = text?.members[memberKey(constant)];
    const summary =
      description === undefined ? '' : ` — ${firstSentence(md(description), SUMMARY_CHARS * 2)}`;
    lines.push(`${constant.name} = ${constant.value ?? '?'}${flags(constant)}${summary}`);
  }
  if (text === undefined) lines.push(NO_TEXT_NOTE);
  return lines.join('\n');
}

function searchResults(header: string, query: string, hits: readonly SearchHit[]): string {
  if (hits.length === 0) {
    return `${header} — nothing matches "${query}". Try a shorter term or a class name (e.g. "Node3D").`;
  }
  const lines = [
    `${header} — ${hits.length === 1 ? 'best match' : `${hits.length} best matches`} for "${query}":`,
  ];
  for (const hit of hits) {
    lines.push(
      hit.member === undefined
        ? `class ${hit.cls.name}${flags(hit.cls)}`
        : `${hit.cls.name}.${hit.member.name} (${hit.member.kind}): ${signature(hit.cls, hit.member)}${flags(hit.member)}`,
    );
  }
  lines.push('Query "Class.member" for the full description.');
  return lines.join('\n');
}

/** GDScript-style signature, e.g. `add_child(node: Node, force_readable_name: bool = false) -> void`. */
export function signature(cls: ClassApi, member: MemberDoc): string {
  const params = member.params.map(
    (p) => `${p.name}: ${p.type}${p.default === undefined ? '' : ` = ${p.default}`}`,
  );
  if (member.qualifiers?.includes('vararg') === true) params.push('...');
  const args = `(${params.join(', ')})`;
  const qualifiers = member.qualifiers === undefined ? '' : ` [${member.qualifiers}]`;
  switch (member.kind) {
    case 'method':
      return `${member.name}${args} -> ${member.type ?? 'void'}${qualifiers}`;
    case 'constructor':
      return `${cls.name}${args}`;
    case 'operator':
      return `${member.name}${args} -> ${member.type ?? 'void'}`;
    case 'annotation':
      return `${member.name}${args}`;
    case 'signal':
      return `signal ${member.name}${args}`;
    case 'property':
    case 'theme_item':
      return `${member.name}: ${member.type ?? 'Variant'}${member.value === undefined ? '' : ` = ${member.value}`}`;
    case 'constant':
      return `${member.name} = ${member.value ?? '?'}`;
  }
}

function flags(item: { deprecated: boolean; experimental: boolean }): string {
  return `${item.deprecated ? ' [deprecated]' : ''}${item.experimental ? ' [experimental]' : ''}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
