import type { GameManager } from '../godot/game.js';
import { ErrorCode, ToolError } from '../util/errors.js';
import type { BridgeServer } from './bridge-server.js';
import { PeerClient } from './peer-client.js';
import type { EditorMethods, RuntimeMethods } from './protocol.js';

/** How long to wait for the helper of a just-started game to connect. */
const RUNTIME_CONNECT_TIMEOUT_MS = 5_000;
/** The editor plugin connects within its 1 s polling interval; don't make tools wait long. */
const EDITOR_CONNECT_TIMEOUT_MS = 1_500;

export type RuntimeClient = PeerClient<RuntimeMethods>;
export type EditorClient = PeerClient<EditorMethods>;

/** Client for the running game's runtime helper. */
export function runtimeClient(bridge: BridgeServer, game: GameManager): RuntimeClient {
  return new PeerClient<RuntimeMethods>(bridge, {
    role: 'runtime',
    connectTimeoutMs: RUNTIME_CONNECT_TIMEOUT_MS,
    precheck: () => {
      if (!game.isRunning) {
        throw new ToolError(
          ErrorCode.GameNotRunning,
          'No game is running.',
          'Start it with run_game (windowed for screenshots).',
        );
      }
    },
    notConnected: () =>
      new ToolError(
        ErrorCode.GameNotRunning,
        'The game is running but its runtime helper is not connected.',
        'Restart it with run_game; check get_output for errors during startup.',
      ),
  });
}

/** Client for the Godotty editor plugin. */
export function editorClient(bridge: BridgeServer): EditorClient {
  return new PeerClient<EditorMethods>(bridge, {
    role: 'editor',
    connectTimeoutMs: EDITOR_CONNECT_TIMEOUT_MS,
    precheck: () => undefined,
    notConnected: () =>
      new ToolError(
        ErrorCode.EditorNotConnected,
        'The Godot editor is not connected.',
        'Open this project in the Godot editor with the Godotty addon installed (addons/godotty_mcp) and enabled in Project Settings → Plugins.',
      ),
  });
}
