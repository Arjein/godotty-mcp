@tool
extends EditorPlugin
## Editor side of godotty-mcp.
##
## Finds the MCP server through the session file it writes (res://.godot/godotty_mcp/session.json:
## port, token, protocol), connects to its loopback bridge as the "editor" peer, and performs
## undoable scene edits on request. Reconnects automatically when the server restarts.

const BridgeClient = preload("runtime/godotty_bridge_client.gd")
const EditorCommands = preload("editor/godotty_editor_commands.gd")
const SESSION_FILE: String = "res://.godot/godotty_mcp/session.json"
const POLL_SECONDS: float = 1.0
const ROLE: String = "editor"
## Set by godotty-mcp on editors it starts itself (headless LSP, --import): those must not connect.
const NO_BRIDGE_ENV: String = "GODOTTY_NO_EDITOR_BRIDGE"

var _timer: Timer
var _client: BridgeClient
var _session_key: String = ""
var _warned_protocol: int = -1


func _enter_tree() -> void:
	if OS.get_environment(NO_BRIDGE_ENV) == "1":
		return
	_timer = Timer.new()
	_timer.wait_time = POLL_SECONDS
	_timer.autostart = true
	_timer.timeout.connect(_poll)
	add_child(_timer)
	_poll.call_deferred()


func _exit_tree() -> void:
	_disconnect()
	if _timer != null:
		_timer.queue_free()
		_timer = null


## Connects to the server named in the session file, or reconnects when it changed.
func _poll() -> void:
	var session: Dictionary = _read_session()
	var key: String = (
		"" if session.is_empty() else "%s:%s" % [session.get("port"), session.get("token")]
	)
	var alive: bool = _client != null and not _client.is_finished()
	if key == _session_key and (alive or key == ""):
		return
	_disconnect()
	_session_key = key
	if session.is_empty() or not _protocol_matches(int(session.get("protocol", 0))):
		return
	# A stale session file (crashed server) may point at a port someone else now owns; that is
	# safe because the bridge client ignores everything until the server proves the token.
	_client = BridgeClient.new()
	_client.name = "GodottyBridge"
	var commands: EditorCommands = EditorCommands.new(self, get_undo_redo())
	commands.eval_allowed = session.get("allow_eval", false) == true
	_client.setup(int(session.get("port", 0)), str(session.get("token", "")), commands, ROLE)
	add_child(_client)


func _protocol_matches(protocol: int) -> bool:
	if protocol == BridgeClient.PROTOCOL_VERSION:
		return true
	if _warned_protocol != protocol:
		_warned_protocol = protocol
		push_warning(
			(
				(
					"Godotty: the MCP server speaks bridge protocol %d, this addon speaks %d. "
					+ "Update the addon or the server so they match."
				)
				% [protocol, BridgeClient.PROTOCOL_VERSION]
			)
		)
	return false


func _read_session() -> Dictionary:
	if not FileAccess.file_exists(SESSION_FILE):
		return {}
	var json: JSON = JSON.new()
	if json.parse(FileAccess.get_file_as_string(SESSION_FILE)) != OK:
		return {}
	return json.data if json.data is Dictionary else {}


func _disconnect() -> void:
	if _client != null:
		_client.queue_free()
		_client = null
