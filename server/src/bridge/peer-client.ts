import { ErrorCode, ToolError } from '../util/errors.js';
import { RemoteError, type BridgeServer } from './bridge-server.js';
import { EditorErrorCode, RemoteErrorCode, type Role } from './protocol.js';

const REMOTE_HINTS: Readonly<Record<string, { code: ErrorCode; hint: string }>> = {
  [RemoteErrorCode.Headless]: {
    code: ErrorCode.InvalidInput,
    hint: 'Restart with run_game headless=false to render frames.',
  },
  [RemoteErrorCode.NodeNotFound]: {
    code: ErrorCode.NotFound,
    hint: 'List nodes with inspect_scene_tree; game paths are absolute (/root/Main/Player) or relative to the current scene, editor paths are relative to the edited scene root.',
  },
  [RemoteErrorCode.PropertyNotFound]: {
    code: ErrorCode.NotFound,
    hint: "List the node's properties with get_node_properties.",
  },
  [RemoteErrorCode.InvalidValue]: {
    code: ErrorCode.InvalidInput,
    hint: 'Values use Godot syntax: 3.5, true, Vector3(0, 1, 0), Color(1, 0, 0), "text".',
  },
  [RemoteErrorCode.UnknownAction]: {
    code: ErrorCode.InvalidInput,
    hint: 'project_info lists the input actions.',
  },
  [RemoteErrorCode.UnknownKey]: {
    code: ErrorCode.InvalidInput,
    hint: 'Use Godot key names: A, Space, Enter, Escape, Left, Shift, F1, …',
  },
  [RemoteErrorCode.EvalDisabled]: {
    code: ErrorCode.Disabled,
    hint: 'Start the server with --allow-eval (or GODOTTY_ALLOW_EVAL=1) and relaunch the game / reopen the editor.',
  },
  [RemoteErrorCode.EvalParse]: {
    code: ErrorCode.InvalidInput,
    hint: 'Fix the GDScript; the code is the body of a function, so use return to send back a value.',
  },
  [EditorErrorCode.NoScene]: { code: ErrorCode.InvalidInput, hint: 'Open one with open_scene.' },
  [EditorErrorCode.InvalidType]: {
    code: ErrorCode.InvalidInput,
    hint: 'Use a Node class name (check with godot_docs) or a .tscn for "scene".',
  },
  [EditorErrorCode.InvalidName]: {
    code: ErrorCode.InvalidInput,
    hint: 'Names cannot be empty or contain . : @ / " % and must be unique among siblings.',
  },
  [EditorErrorCode.FileNotFound]: { code: ErrorCode.NotFound, hint: 'Find files with list_files.' },
  [EditorErrorCode.FileExists]: {
    code: ErrorCode.InvalidInput,
    hint: 'Open the existing scene instead, or choose another path.',
  },
};

export interface PeerClientOptions {
  role: Role;
  /** How long to wait for the peer before giving up. */
  connectTimeoutMs: number;
  /** Throws when the peer cannot be expected (e.g. no game running). */
  precheck: () => void;
  notConnected: () => ToolError;
}

/** Calls methods on one Godot peer (runtime or editor) with actionable errors. */
export class PeerClient<
  Methods extends { [K in keyof Methods]: { params: unknown; result: unknown } },
> {
  public constructor(
    private readonly bridge: BridgeServer,
    private readonly options: PeerClientOptions,
  ) {}

  public get isConnected(): boolean {
    return this.bridge.peer(this.options.role) !== undefined;
  }

  public async call<M extends keyof Methods & string>(
    method: M,
    params: Methods[M]['params'],
    timeoutMs: number,
  ): Promise<Methods[M]['result']> {
    this.options.precheck();
    const peer = await this.bridge.waitFor(this.options.role, this.options.connectTimeoutMs);
    if (peer === undefined) throw this.options.notConnected();
    try {
      return await peer.request(method, params, timeoutMs);
    } catch (error) {
      if (error instanceof RemoteError) {
        const mapped = REMOTE_HINTS[error.code];
        throw new ToolError(mapped?.code ?? ErrorCode.InvalidInput, error.message, mapped?.hint);
      }
      throw error;
    }
  }
}
