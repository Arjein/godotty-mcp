extends Node
## TCP client side of the godotty-mcp bridge (see server/src/bridge/protocol.ts).
##
## Connects to the server on 127.0.0.1, authenticates with the session token, then answers
## requests `{id, method, params}` with `{id, result}` or `{id, error}`. One JSON object per line.
## Commands may await frames, so several can be in flight; each answers when it finishes.

## Must match PROTOCOL_VERSION in server/src/bridge/protocol.ts.
const PROTOCOL_VERSION: int = 1
const HOST: String = "127.0.0.1"
const NEWLINE: int = 10
const ROLE: String = "runtime"

var _tcp: StreamPeerTCP = StreamPeerTCP.new()
var _buffer: PackedByteArray = PackedByteArray()
var _port: int
var _token: String
var _commands: RefCounted
var _hello_sent: bool = false
var _finished: bool = false


## Prepares the connection; it is opened when the node enters the tree.
func setup(port: int, token: String, commands: RefCounted) -> void:
	_port = port
	_token = token
	_commands = commands


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var error: Error = _tcp.connect_to_host(HOST, _port)
	if error != OK:
		push_warning("godotty-mcp: cannot connect to the server bridge (%s)" % error_string(error))
		_finished = true


func _process(_delta: float) -> void:
	if _finished:
		return
	_tcp.poll()
	match _tcp.get_status():
		StreamPeerTCP.STATUS_CONNECTED:
			if not _hello_sent:
				_send_hello()
			_read_available()
		StreamPeerTCP.STATUS_ERROR, StreamPeerTCP.STATUS_NONE:
			# The server went away; the game keeps running without the bridge.
			_finished = true


func _send_hello() -> void:
	_hello_sent = true
	var hello: Dictionary = {
		"type": "hello",
		"role": ROLE,
		"protocol": PROTOCOL_VERSION,
		"token": _token,
		"godot": Engine.get_version_info().get("string", ""),
		"pid": OS.get_process_id(),
	}
	_send(hello)


func _read_available() -> void:
	var available: int = _tcp.get_available_bytes()
	if available <= 0:
		return
	var chunk: Array = _tcp.get_data(available)
	if chunk[0] != OK:
		return
	_buffer.append_array(chunk[1])
	var end: int = _buffer.find(NEWLINE)
	while end != -1:
		var line: String = _buffer.slice(0, end).get_string_from_utf8()
		_buffer = _buffer.slice(end + 1)
		_dispatch(line)
		end = _buffer.find(NEWLINE)


func _dispatch(line: String) -> void:
	# JSON.parse_string() logs an engine error on bad input; a bad line is just ignored here.
	var json: JSON = JSON.new()
	if json.parse(line) != OK or typeof(json.data) != TYPE_DICTIONARY:
		return
	var data: Dictionary = json.data
	if data.get("type", "") == "rejected":
		push_warning("godotty-mcp: bridge rejected this game: %s" % data.get("reason", ""))
		_finished = true
	elif data.has("id") and data.has("method"):
		_run(data)


func _run(request: Dictionary) -> void:
	var params: Variant = request.get("params", {})
	var outcome: Dictionary = await _commands.call(
		"run", str(request["method"]), params if params is Dictionary else {}
	)
	outcome["id"] = int(request["id"])
	_send(outcome)


func _send(message: Dictionary) -> void:
	if _tcp.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_tcp.put_data((JSON.stringify(message) + "\n").to_utf8_buffer())
