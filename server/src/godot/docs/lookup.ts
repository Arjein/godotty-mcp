import type { ClassApi, MemberDoc } from './class-xml.js';
import type { ApiIndex } from './docs-store.js';

export interface EnumDoc {
  name: string;
  constants: MemberDoc[];
}

export type Resolution =
  | { kind: 'class'; cls: ClassApi }
  | { kind: 'member'; cls: ClassApi; owner: ClassApi; members: MemberDoc[] }
  | { kind: 'enum'; cls: ClassApi; owner: ClassApi; enumDoc: EnumDoc }
  | { kind: 'search'; hits: SearchHit[] };

export interface SearchHit {
  cls: ClassApi;
  member: MemberDoc | undefined;
  score: number;
}

/** Built-in scopes whose members are global functions/annotations; ranked a little higher. */
const GLOBAL_SCOPES = new Set(['@GlobalScope', '@GDScript']);
/** Shorter needles would subsequence-match almost everything. */
const MIN_SUBSEQUENCE_LENGTH = 3;
const SCORE = {
  exact: 100,
  prefix: 70,
  wordStart: 50,
  substring: 40,
  subsequence: 10,
  global: 3,
  classBonus: 5,
  deprecated: -20,
} as const;

/**
 * Resolves "Node", "Node.add_child", "CharacterBody3D.velocity" (found on the class or an
 * ancestor), "Node.ProcessMode" (enum), or anything else via ranked fuzzy search.
 */
export function resolve(index: ApiIndex, rawQuery: string, maxHits: number): Resolution {
  const query = rawQuery.trim().replace(/\(\)$/, '').replace('::', '.');
  const dot = query.indexOf('.');
  if (dot > 0) {
    const cls = findClass(index, query.slice(0, dot));
    const name = query.slice(dot + 1);
    if (cls !== undefined) {
      const found = findMember(index, cls, name);
      if (found !== undefined) return found;
      return { kind: 'search', hits: search(index, name, maxHits, ancestry(index, cls)) };
    }
  }
  const cls = findClass(index, query);
  if (cls !== undefined) return { kind: 'class', cls };
  return { kind: 'search', hits: search(index, query, maxHits) };
}

export function findClass(index: ApiIndex, name: string): ClassApi | undefined {
  const exact = index.classes.get(name);
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  for (const cls of index.classes.values()) {
    if (cls.name.toLowerCase() === lower) return cls;
  }
  return undefined;
}

/** The class followed by its ancestors, nearest first. */
export function ancestry(index: ApiIndex, cls: ClassApi): ClassApi[] {
  const chain: ClassApi[] = [];
  for (
    let c: ClassApi | undefined = cls;
    c !== undefined && !chain.includes(c);
    c = c.inherits === undefined ? undefined : index.classes.get(c.inherits)
  ) {
    chain.push(c);
  }
  return chain;
}

function findMember(index: ApiIndex, cls: ClassApi, name: string): Resolution | undefined {
  const lower = name.toLowerCase();
  for (const matchName of [(n: string) => n === name, (n: string) => n.toLowerCase() === lower]) {
    for (const owner of ancestry(index, cls)) {
      const members = owner.members.filter((m) => matchName(m.name));
      if (members.length > 0) return { kind: 'member', cls, owner, members };
      const constants = owner.members.filter(
        (m) =>
          m.kind === 'constant' && m.enumName !== undefined && matchName(enumShortName(m.enumName)),
      );
      if (constants.length > 0) {
        return {
          kind: 'enum',
          cls,
          owner,
          enumDoc: { name: constants[0]?.enumName ?? name, constants },
        };
      }
    }
  }
  return undefined;
}

/** "Node.ProcessMode" → "ProcessMode". */
export function enumShortName(enumName: string): string {
  return enumName.slice(enumName.lastIndexOf('.') + 1);
}

/** Ranks classes and members by how well their name matches `term`. */
export function search(
  index: ApiIndex,
  term: string,
  maxHits: number,
  within?: readonly ClassApi[],
): SearchHit[] {
  const needle = term.toLowerCase().replace(/^@/, '');
  if (needle === '') return [];
  const hits: SearchHit[] = [];
  for (const cls of within ?? index.classes.values()) {
    const classScore = nameScore(cls.name.toLowerCase().replace(/^@/, ''), needle);
    if (classScore > 0 && within === undefined)
      hits.push({ cls, member: undefined, score: classScore + SCORE.classBonus });
    for (const member of cls.members) {
      if (member.kind === 'operator' || member.kind === 'constructor') continue;
      const score = nameScore(member.name.toLowerCase().replace(/^@/, ''), needle);
      if (score === 0) continue;
      const bonus =
        (GLOBAL_SCOPES.has(cls.name) ? SCORE.global : 0) +
        (member.deprecated ? SCORE.deprecated : 0);
      hits.push({ cls, member, score: score + bonus });
    }
  }
  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.member?.name ?? a.cls.name).length - (b.member?.name ?? b.cls.name).length ||
        a.cls.name.localeCompare(b.cls.name),
    )
    .slice(0, maxHits);
}

/** 0 = no match. Exact > prefix > start of a word (after _) > substring > subsequence. */
export function nameScore(name: string, needle: string): number {
  if (name === needle) return SCORE.exact;
  if (name.startsWith(needle)) return SCORE.prefix;
  const at = name.indexOf(needle);
  if (at > 0) return name[at - 1] === '_' ? SCORE.wordStart : SCORE.substring;
  return needle.length >= MIN_SUBSEQUENCE_LENGTH && isSubsequence(needle, name)
    ? SCORE.subsequence
    : 0;
}

function isSubsequence(needle: string, name: string): boolean {
  let i = 0;
  for (const c of name) {
    if (c === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}
