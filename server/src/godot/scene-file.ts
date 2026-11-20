import { parseSectionFile, type Property, type Section } from './section-file.js';
import { formatNumber, formatVariant, isCall, type GdValue } from './variant.js';

export interface ExtResource {
  type: string;
  path: string;
}

export interface SubResource {
  type: string;
  props: readonly Property[];
}

export interface SceneNode {
  name: string;
  /** Absent for instanced scenes that don't override the type. */
  type: string | undefined;
  /** res:// path of the instanced scene, if this node is a scene instance. */
  instance: string | undefined;
  /** res:// path of the attached script, if any. */
  script: string | undefined;
  groups: string[];
  /** Saved properties (Godot only saves non-default values), excluding script. */
  props: Property[];
  children: SceneNode[];
}

export interface Connection {
  signal: string;
  from: string;
  to: string;
  method: string;
}

export interface SceneFile {
  root: SceneNode;
  nodeCount: number;
  extResources: ReadonlyMap<string, ExtResource>;
  subResources: ReadonlyMap<string, SubResource>;
  connections: Connection[];
}

export class SceneFormatError extends Error {}

/** Parses .tscn text into a node tree with resolved resource references. */
export function parseSceneFile(text: string): SceneFile {
  const sections = parseSectionFile(text);
  const extResources = new Map<string, ExtResource>();
  const subResources = new Map<string, SubResource>();
  const connections: Connection[] = [];
  const nodes: { section: Section; node: SceneNode }[] = [];

  for (const section of sections) {
    const attrs = section.attrs;
    if (section.tag === 'ext_resource') {
      extResources.set(str(attrs.id), { type: str(attrs.type), path: str(attrs.path) });
    } else if (section.tag === 'sub_resource') {
      subResources.set(str(attrs.id), { type: str(attrs.type), props: section.props });
    } else if (section.tag === 'connection') {
      connections.push({
        signal: str(attrs.signal),
        from: str(attrs.from),
        to: str(attrs.to),
        method: str(attrs.method),
      });
    } else if (section.tag === 'node') {
      nodes.push({ section, node: makeNode(section, extResources) });
    }
  }
  const root = buildTree(nodes);
  return { root, nodeCount: nodes.length, extResources, subResources, connections };
}

function makeNode(section: Section, ext: ReadonlyMap<string, ExtResource>): SceneNode {
  const attrs = section.attrs;
  const scriptProp = section.props.find((p) => p.key === 'script');
  const groups = Array.isArray(attrs.groups) ? attrs.groups : [];
  return {
    name: str(attrs.name),
    type: typeof attrs.type === 'string' ? attrs.type : undefined,
    instance: extPath(attrs.instance, ext),
    script: extPath(scriptProp?.value, ext),
    groups: (groups as readonly GdValue[]).filter((g): g is string => typeof g === 'string'),
    props: section.props.filter((p) => p.key !== 'script'),
    children: [],
  };
}

function buildTree(nodes: readonly { section: Section; node: SceneNode }[]): SceneNode {
  const first = nodes[0];
  if (first === undefined || first.section.attrs.parent !== undefined) {
    throw new SceneFormatError('Scene has no root node.');
  }
  const byPath = new Map<string, SceneNode>([['.', first.node]]);
  for (const { section, node } of nodes.slice(1)) {
    const parentPath = str(section.attrs.parent);
    const parent = byPath.get(parentPath);
    if (parent === undefined) {
      throw new SceneFormatError(
        `Node "${node.name}" (line ${section.line}) has unknown parent "${parentPath}".`,
      );
    }
    parent.children.push(node);
    byPath.set(parentPath === '.' ? node.name : `${parentPath}/${node.name}`, node);
  }
  return first.node;
}

function extPath(
  value: GdValue | undefined,
  ext: ReadonlyMap<string, ExtResource>,
): string | undefined {
  if (!isCall(value, 'ExtResource')) return undefined;
  const id = value.args[0];
  return typeof id === 'string' ? ext.get(id)?.path : undefined;
}

function str(value: GdValue | undefined): string {
  return typeof value === 'string' ? value : value === undefined ? '' : formatVariant(value);
}

// ---------------------------------------------------------------------------------------------
// Rendering

export interface RenderOptions {
  /** Levels below the start node to show; deeper children are summarized as a count. */
  depth: number;
  includeProperties: boolean;
  /** Node path relative to the root ("." or "Floor/CollisionShape3D") to start from. */
  from: string;
}

/** Longest rendered property value before it is cut with an ellipsis. */
export const MAX_VALUE_CHARS = 80;
/** Editor-only metadata that would only add noise for an agent. */
const HIDDEN_PROP_PREFIXES = ['metadata/_edit_', '_edit_'];
const IDENTITY_BASIS_3D = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const IDENTITY_BASIS_2D = [1, 0, 0, 1];
const BASIS_3D_LENGTH = IDENTITY_BASIS_3D.length;
const BASIS_2D_LENGTH = IDENTITY_BASIS_2D.length;

/** Renders the scene as a compact indented tree, one node per line. */
export function renderScene(scene: SceneFile, options: RenderOptions): string {
  const start = findNode(scene.root, options.from);
  if (start === undefined) {
    throw new SceneFormatError(`No node at path "${options.from}".`);
  }
  const lines: string[] = [];
  renderNode(scene, start, '', '', options.depth, options, lines);
  return lines.join('\n');
}

/** Finds a node by path relative to the root ("." is the root). */
export function findNode(root: SceneNode, nodePath: string): SceneNode | undefined {
  if (nodePath === '.' || nodePath === '' || nodePath === root.name) return root;
  let current: SceneNode | undefined = root;
  for (const part of nodePath.split('/')) {
    current = current?.children.find((c) => c.name === part);
  }
  return current;
}

function renderNode(
  scene: SceneFile,
  node: SceneNode,
  prefix: string,
  childPrefix: string,
  depth: number,
  options: RenderOptions,
  lines: string[],
): void {
  lines.push(prefix + describeNode(scene, node, options.includeProperties));
  if (node.children.length === 0) return;
  if (depth <= 0) {
    lines.push(`${childPrefix}… ${countDescendants(node)} more nodes (increase depth to see)`);
    return;
  }
  node.children.forEach((child, i) => {
    const last = i === node.children.length - 1;
    renderNode(
      scene,
      child,
      childPrefix + (last ? '└─ ' : '├─ '),
      childPrefix + (last ? '   ' : '│  '),
      depth - 1,
      options,
      lines,
    );
  });
}

function countDescendants(node: SceneNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

function describeNode(scene: SceneFile, node: SceneNode, includeProperties: boolean): string {
  const parts = [
    node.instance === undefined
      ? `${node.name} (${node.type ?? '?'})`
      : `${node.name} [instance ${node.instance}]`,
  ];
  if (node.instance !== undefined && node.type !== undefined) parts.push(`type=${node.type}`);
  if (node.script !== undefined) parts.push(`script=${node.script}`);
  if (node.groups.length > 0) parts.push(`groups=[${node.groups.join(', ')}]`);
  if (includeProperties) {
    for (const prop of node.props) {
      if (HIDDEN_PROP_PREFIXES.some((p) => prop.key.startsWith(p))) continue;
      parts.push(describeProperty(scene, prop.key, prop.value));
    }
  }
  return parts.join('  ');
}

function describeProperty(scene: SceneFile, key: string, value: GdValue): string {
  if (isCall(value, 'Transform3D') || isCall(value, 'Transform2D')) {
    return describeTransform(value.type, value.args);
  }
  return `${key}=${truncate(describeValue(scene, value))}`;
}

/** Shows a transform as its position, flagging rotation/scale instead of dumping the basis. */
function describeTransform(type: string, args: readonly GdValue[]): string {
  const nums = args.filter((a): a is number => typeof a === 'number');
  const is3d = type === 'Transform3D';
  const basisLength = is3d ? BASIS_3D_LENGTH : BASIS_2D_LENGTH;
  const identity = is3d ? IDENTITY_BASIS_3D : IDENTITY_BASIS_2D;
  const origin = nums.slice(basisLength).map(formatNumber).join(', ');
  const basisChanged = nums
    .slice(0, basisLength)
    .some((n, i) => Math.abs(n - (identity[i] ?? 0)) > Number.EPSILON);
  return `pos=(${origin})${basisChanged ? ' rotated/scaled' : ''}`;
}

/** The id argument of `ExtResource("id")` / `SubResource("id")`. */
function resourceId(args: readonly GdValue[]): string {
  const id = args[0];
  return typeof id === 'string' ? id : '';
}

/** Resolves ExtResource/SubResource references so the agent sees what they point to. */
function describeValue(scene: SceneFile, value: GdValue): string {
  if (isCall(value, 'ExtResource')) {
    const ext = scene.extResources.get(resourceId(value.args));
    return ext === undefined ? formatVariant(value) : ext.path;
  }
  if (isCall(value, 'SubResource')) {
    const sub = scene.subResources.get(resourceId(value.args));
    if (sub === undefined) return formatVariant(value);
    const inner = sub.props.map((p) => `${p.key}=${describeValue(scene, p.value)}`).join(', ');
    return `${sub.type}(${inner})`;
  }
  return formatVariant(value);
}

function truncate(text: string): string {
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text;
}
