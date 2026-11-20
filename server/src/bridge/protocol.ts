import { z } from 'zod';

/**
 * Wire protocol between the MCP server and the Godot side (runtime helper now, editor plugin in
 * M6). Transport: TCP on 127.0.0.1, one JSON object per line (UTF-8, "\n"-terminated).
 *
 * 1. Godot connects and sends `hello` (role, protocol version, session token).
 * 2. The server answers `welcome`, or `rejected` and closes (bad token, unsupported version).
 * 3. The server sends requests `{id, method, params}`; Godot answers `{id, result}` or
 *    `{id, error: {code, message}}`, possibly out of order (commands may await frames).
 *
 * The GDScript side mirrors this file in addon/addons/godotty_mcp/runtime/godotty_bridge_client.gd;
 * bump PROTOCOL_VERSION on any incompatible change to messages or methods.
 */
export const PROTOCOL_VERSION = 1;

/** Upper bound for one line; screenshot sequences are the largest messages. */
export const MAX_MESSAGE_BYTES = 67_108_864; // 64 MiB

export const roleSchema = z.enum(['runtime', 'editor']);
export type Role = z.infer<typeof roleSchema>;

export const helloSchema = z.object({
  type: z.literal('hello'),
  role: roleSchema,
  protocol: z.number().int(),
  token: z.string(),
  godot: z.string().default(''),
  pid: z.number().int().optional(),
});
export type Hello = z.infer<typeof helloSchema>;

export const responseSchema = z.object({
  id: z.number().int(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type Response = z.infer<typeof responseSchema>;

/** Error codes the Godot side may return. */
export const RemoteErrorCode = {
  NodeNotFound: 'NODE_NOT_FOUND',
  PropertyNotFound: 'PROPERTY_NOT_FOUND',
  InvalidValue: 'INVALID_VALUE',
  UnknownAction: 'UNKNOWN_ACTION',
  UnknownKey: 'UNKNOWN_KEY',
  Headless: 'HEADLESS',
  UnknownMethod: 'UNKNOWN_METHOD',
  BadParams: 'BAD_PARAMS',
} as const;

// ---------------------------------------------------------------------------------------------
// Runtime methods: params sent by the server, results returned by the runtime helper.

export interface ScreenshotParams {
  /** Longest side of the returned images, in pixels (images are only scaled down). */
  max_size: number;
  count: number;
  interval_ms: number;
}
export interface ScreenshotResult {
  width: number;
  height: number;
  /** Base64 PNG per frame. */
  frames: string[];
}

export type InputMode = 'press' | 'release' | 'tap' | 'hold';
export type InputStep =
  | {
      type: 'action';
      action: string;
      mode: InputMode;
      duration_ms?: number | undefined;
      strength?: number | undefined;
    }
  | {
      type: 'key';
      key: string;
      mode: InputMode;
      duration_ms?: number | undefined;
      shift?: boolean | undefined;
      ctrl?: boolean | undefined;
      alt?: boolean | undefined;
      meta?: boolean | undefined;
    }
  | {
      type: 'mouse_button';
      button: 'left' | 'right' | 'middle' | 'wheel_up' | 'wheel_down';
      mode: InputMode;
      position: [number, number];
      duration_ms?: number | undefined;
      double_click?: boolean | undefined;
    }
  | { type: 'mouse_motion'; position: [number, number] }
  | { type: 'wait'; ms?: number | undefined; frames?: number | undefined };
export interface InputParams {
  steps: InputStep[];
}
export interface InputResult {
  steps: number;
  elapsed_ms: number;
  frames: number;
}

export type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=';
export interface WaitParams {
  frames?: number | undefined;
  seconds?: number | undefined;
  until?:
    | {
        node: string;
        property?: string | undefined;
        op?: CompareOp | undefined;
        value?: string | undefined;
      }
    | undefined;
  timeout_s: number;
}
export interface WaitResult {
  met: boolean;
  elapsed_ms: number;
  frames: number;
  /** For property conditions: the last value seen (var_to_str). */
  last_value?: string;
}

export interface TreeParams {
  /** Node path ("" = scene tree root /root). */
  path: string;
  depth: number;
  max_nodes: number;
}
export interface TreeNode {
  name: string;
  class: string;
  script?: string;
  /** Short state summary, e.g. "pos=(1, 0, 2) visible=false". */
  info?: string;
  children?: TreeNode[];
  /** Children not included because of depth/max_nodes. */
  hidden_children?: number;
}
export interface TreeResult {
  root: TreeNode;
  path: string;
  current_scene: string;
  truncated: boolean;
}

export interface GetPropsParams {
  path: string;
  names: string[];
  filter: string;
  max: number;
}
export interface PropValue {
  name: string;
  type: string;
  value: string;
}
export interface GetPropsResult {
  path: string;
  class: string;
  script?: string;
  props: PropValue[];
  total: number;
}

export interface SetPropsParams {
  path: string;
  values: Record<string, string>;
}
export interface SetPropsResult {
  path: string;
  props: PropValue[];
}

/** Every runtime method with its params and result types. */
export interface RuntimeMethods {
  screenshot: { params: ScreenshotParams; result: ScreenshotResult };
  input: { params: InputParams; result: InputResult };
  wait: { params: WaitParams; result: WaitResult };
  tree: { params: TreeParams; result: TreeResult };
  get_props: { params: GetPropsParams; result: GetPropsResult };
  set_props: { params: SetPropsParams; result: SetPropsResult };
}
export type RuntimeMethod = keyof RuntimeMethods;

// ---------------------------------------------------------------------------------------------
// Editor methods (editor plugin). Node paths are relative to the edited scene root ("." = root).

export interface SceneInfo {
  /** res:// path of the edited scene ("" if never saved). */
  scene: string;
  root: string;
  class: string;
  nodes: number;
  /** True when the scene has unsaved changes. */
  unsaved: boolean;
}

export interface OpenSceneParams {
  path: string;
  /** When set, create a new scene with a root of this class (the file must not exist). */
  create_root_type?: string | undefined;
  root_name?: string | undefined;
}

export interface AddNodeParams {
  parent: string;
  name: string;
  /** Class to instantiate, e.g. "Sprite2D"; or `scene` to instance a .tscn. */
  type?: string | undefined;
  scene?: string | undefined;
  properties: Record<string, string>;
}

export interface UpdateNodeParams {
  node: string;
  properties: Record<string, string>;
  rename?: string | undefined;
  reparent?: string | undefined;
  /** res:// script to attach, or "" to detach. */
  script?: string | undefined;
}

export interface EditResult extends SceneInfo {
  /** Path of the affected node after the edit (relative to the scene root). */
  node: string;
  /** The undo-history entry name. */
  action: string;
  changes: string[];
}

export interface EditorMethods {
  open_scene: { params: OpenSceneParams; result: SceneInfo };
  add_node: { params: AddNodeParams; result: EditResult };
  remove_node: { params: { node: string }; result: EditResult };
  update_node: { params: UpdateNodeParams; result: EditResult };
  save_scene: { params: { path?: string | undefined }; result: SceneInfo };
  tree: { params: TreeParams; result: TreeResult };
  get_props: { params: GetPropsParams; result: GetPropsResult };
  /** Test/maintenance hooks: step the edited scene's undo history. */
  undo: { params: Record<string, never>; result: SceneInfo & { action: string } };
  redo: { params: Record<string, never>; result: SceneInfo & { action: string } };
}
export type EditorMethod = keyof EditorMethods;

/** Extra remote error codes from the editor plugin. */
export const EditorErrorCode = {
  NoScene: 'NO_SCENE',
  InvalidType: 'INVALID_TYPE',
  InvalidName: 'INVALID_NAME',
  InvalidOperation: 'INVALID_OPERATION',
  FileExists: 'FILE_EXISTS',
  FileNotFound: 'FILE_NOT_FOUND',
  SaveFailed: 'SAVE_FAILED',
} as const;

/** Written by the server so the editor plugin can find it; see session-file.ts. */
export interface SessionFile {
  port: number;
  token: string;
  protocol: number;
  pid: number;
  server: string;
}
