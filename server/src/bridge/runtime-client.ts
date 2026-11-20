import type { GameManager } from '../godot/game.js';
import { ErrorCode, ToolError } from '../util/errors.js';
import { RemoteError, type BridgeServer } from './bridge-server.js';
import { RemoteErrorCode, type RuntimeMethod, type RuntimeMethods } from './protocol.js';

/** How long to wait for the helper of a just-started game to connect. */
const CONNECT_TIMEOUT_MS = 5_000;

const REMOTE_HINTS: Readonly<Record<string, { code: ErrorCode; hint: string }>> = {
  [RemoteErrorCode.Headless]: {
    code: ErrorCode.InvalidInput,
    hint: 'Restart with run_game headless=false to render frames.',
  },
  [RemoteErrorCode.NodeNotFound]: {
    code: ErrorCode.NotFound,
    hint: 'List live nodes with inspect_scene_tree; paths are absolute (/root/Main/Player) or relative to the current scene.',
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
};

/** Calls runtime-helper methods on the running game, with actionable errors. */
export class RuntimeClient {
  public constructor(
    private readonly bridge: BridgeServer,
    private readonly game: GameManager,
  ) {}

  public async call<M extends RuntimeMethod>(
    method: M,
    params: RuntimeMethods[M]['params'],
    timeoutMs: number,
  ): Promise<RuntimeMethods[M]['result']> {
    if (!this.game.isRunning) {
      throw new ToolError(
        ErrorCode.GameNotRunning,
        'No game is running.',
        'Start it with run_game (windowed for screenshots).',
      );
    }
    const peer = await this.bridge.waitFor('runtime', CONNECT_TIMEOUT_MS);
    if (peer === undefined) {
      throw new ToolError(
        ErrorCode.GameNotRunning,
        'The game is running but its runtime helper is not connected.',
        'Restart it with run_game; check get_output for errors during startup.',
      );
    }
    try {
      return (await peer.request(method, params, timeoutMs)) as RuntimeMethods[M]['result'];
    } catch (error) {
      if (error instanceof RemoteError) {
        const mapped = REMOTE_HINTS[error.code];
        throw new ToolError(mapped?.code ?? ErrorCode.InvalidInput, error.message, mapped?.hint);
      }
      throw error;
    }
  }
}
