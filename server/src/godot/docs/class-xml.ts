import { XMLParser } from 'fast-xml-parser';

/** What a class member is; also the prefix of its key in `ClassDoc.descriptions`. */
export type MemberKind =
  | 'method'
  | 'property'
  | 'signal'
  | 'constant'
  | 'annotation'
  | 'constructor'
  | 'operator'
  | 'theme_item';

export interface Param {
  name: string;
  type: string;
  default: string | undefined;
}

export interface MemberDoc {
  kind: MemberKind;
  name: string;
  /** Methods/operators/constructors: return type. Properties/theme items: value type. */
  type: string | undefined;
  params: Param[];
  /** e.g. "const", "virtual", "static", "vararg". */
  qualifiers: string | undefined;
  /** Properties and theme items: default value; constants: value. */
  value: string | undefined;
  /** Constants: owning enum name, if any. */
  enumName: string | undefined;
  deprecated: boolean;
  experimental: boolean;
  /** 0 for the first member with this kind+name, 1 for the next overload, … */
  overload: number;
}

/** Signatures of one class, exactly as the installed Godot reports them. */
export interface ClassApi {
  name: string;
  inherits: string | undefined;
  /** Path of the class XML relative to the engine source root, e.g. "doc/classes/Node.xml". */
  sourcePath: string;
  members: MemberDoc[];
  deprecated: boolean;
  experimental: boolean;
}

/** Description text of one class (raw markup), keyed by `${kind}:${name}` for members. */
export interface ClassText {
  brief: string;
  description: string;
  tutorials: { title: string; url: string }[];
  members: Record<string, string>;
}

const ARRAY_TAGS = new Set([
  'method',
  'member',
  'signal',
  'constant',
  'param',
  'link',
  'annotation',
  'ctor',
  'operator',
  'theme_item',
]);
/**
 * fast-xml-parser rejects elements named "constructor" (prototype-pollution guard), which Godot uses
 * for built-in types such as Vector3; rename them to "ctor" before parsing.
 */
const CONSTRUCTOR_TAG = /<(\/?)constructor(s?)(?=[\s>/])/g;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  // Keep values as strings: defaults like "Vector3(0, 0, 0)" or "0.0" must stay verbatim.
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type XmlNode = Record<string, unknown>;

/** Container tag in the class XML → member kind and item tag. */
const SECTIONS: readonly [container: string, item: string, kind: MemberKind][] = [
  ['ctors', 'ctor', 'constructor'],
  ['methods', 'method', 'method'],
  ['operators', 'operator', 'operator'],
  ['members', 'member', 'property'],
  ['signals', 'signal', 'signal'],
  ['constants', 'constant', 'constant'],
  ['annotations', 'annotation', 'annotation'],
  ['theme_items', 'theme_item', 'theme_item'],
];

/** Parses one class reference XML into signatures and description text. */
export function parseClassXml(xml: string, sourcePath: string): { api: ClassApi; text: ClassText } {
  const root = (parser.parse(xml.replace(CONSTRUCTOR_TAG, '<$1ctor$2')) as XmlNode).class as
    XmlNode | undefined;
  if (root === undefined) throw new Error(`${sourcePath} is not a class reference file`);
  const members: MemberDoc[] = [];
  const memberText: Record<string, string> = {};
  const seen = new Map<string, number>();
  for (const [container, item, kind] of SECTIONS) {
    for (const node of items(root[container], item)) {
      const name = attr(node, 'name');
      const overload = seen.get(`${kind}:${name}`) ?? 0;
      seen.set(`${kind}:${name}`, overload + 1);
      const member = toMember(node, kind, overload);
      members.push(member);
      const description = textOf(
        kind === 'property' || kind === 'constant' || kind === 'theme_item'
          ? node
          : node.description,
      );
      if (description !== '') memberText[memberKey(member)] = description;
    }
  }
  return {
    api: {
      name: attr(root, 'name'),
      inherits: optionalAttr(root, 'inherits'),
      sourcePath,
      members,
      deprecated: optionalAttr(root, 'deprecated') !== undefined,
      experimental: optionalAttr(root, 'experimental') !== undefined,
    },
    text: {
      brief: textOf(root.brief_description),
      description: textOf(root.description),
      tutorials: items(root.tutorials, 'link').map((l) => ({
        title: attr(l, 'title'),
        url: textOf(l),
      })),
      members: memberText,
    },
  };
}

/** Key of a member's description; overloads (constructors, operators) are told apart by index. */
export function memberKey(member: Pick<MemberDoc, 'kind' | 'name' | 'overload'>): string {
  return member.overload === 0
    ? `${member.kind}:${member.name}`
    : `${member.kind}:${member.name}#${member.overload}`;
}

function toMember(node: XmlNode, kind: MemberKind, overload: number): MemberDoc {
  const ret = node.return as XmlNode | undefined;
  const typed = ret ?? node;
  const isConstant = kind === 'constant';
  return {
    kind,
    name: attr(node, 'name'),
    // Typed enums carry their name in "enum" (e.g. int + enum="Node.InternalMode"); show that.
    type: isConstant ? undefined : (optionalAttr(typed, 'enum') ?? optionalAttr(typed, 'type')),
    params: items(node.param, 'param')
      .map((p) => ({
        index: Number(optionalAttr(p, 'index') ?? 0),
        name: attr(p, 'name'),
        type: optionalAttr(p, 'enum') ?? attr(p, 'type'),
        default: optionalAttr(p, 'default'),
      }))
      .sort((a, b) => a.index - b.index)
      .map(({ name, type, default: def }) => ({ name, type, default: def })),
    qualifiers: optionalAttr(node, 'qualifiers'),
    value: optionalAttr(node, isConstant ? 'value' : 'default'),
    enumName: isConstant ? optionalAttr(node, 'enum') : undefined,
    deprecated: optionalAttr(node, 'deprecated') !== undefined,
    experimental: optionalAttr(node, 'experimental') !== undefined,
    overload,
  };
}

/** Normalizes "maybe a container node with item array" into the item array. */
function items(container: unknown, item: string): XmlNode[] {
  if (Array.isArray(container)) return container as XmlNode[];
  if (typeof container !== 'object' || container === null) return [];
  const list = (container as XmlNode)[item];
  return Array.isArray(list) ? (list as XmlNode[]) : [];
}

function attr(node: XmlNode, name: string): string {
  return optionalAttr(node, name) ?? '';
}

function optionalAttr(node: XmlNode, name: string): string | undefined {
  const value = node[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Element text with surrounding blank lines removed but per-line indentation kept, so `dedent`
 * can strip the common indent later (trimming here would unindent only the first line).
 */
function textOf(node: unknown): string {
  const raw =
    typeof node === 'string'
      ? node
      : typeof node === 'object' && node !== null
        ? (node as XmlNode)['#text']
        : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  return raw.replace(/^\s*\n/, '').trimEnd();
}
