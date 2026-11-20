@tool
extends Node
## TCP client side of the godotty-mcp bridge (see server/src/bridge/protocol.ts).
##
## Connects to the server on 127.0.0.1 and sends a hello with the role's token and a random nonce.
## The server must answer `welcome` with proof = HMAC-SHA256(token, nonce); until that checks out
## every request is ignored, so whatever squats on a stale port cannot drive Godot. Then answers
## requests `{id, method, params}` with `{id, result}` or `{id, error}`. One JSON object per line.
## Commands may await frames, so several can be in flight; each answers when it finishes.

## Must match PROTOCOL_VERSION in server/src/bridge/protocol.ts.
const PROTOCOL_VERSION: int = 1
const HOST: String = "127.0.0.1"
const NEWLINE: int = 10
const NONCE_BYTES: int = 16

var _tcp: StreamPeerTCP = StreamPeerTCP.new()
var _buffer: PackedByteArray = PackedByteArray()
var _port: int
var _token: String
var _commands: RefCounted
var _role: String = "runtime"
var _hello_sent: bool = false
var _authenticated: bool = false
var _nonce: String = Crypto.new().generate_random_bytes(NONCE_BYTES).hex_encode()
var _finished: bool = false


## Prepares the connection; it is opened when the node enters the tree.
## `role` is "runtime" (game) or "editor" (editor plugin).
func setup(port: int, token: String, commands: RefCounted, role: String = "runtime") -> void:
	_port = port
	_token = token
	_commands = commands
	_role = role


## True once the server is gone or rejected us; the owner may reconnect with a new client.
func is_finished() -> bool:
	return _finished


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var error: Error = _tcp.connect_to_host(HOST, _port)
	if error != OK:
		_warn("godotty-mcp: cannot connect to the server bridge (%s)" % error_string(error))
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
		"role": _role,
		"protocol": PROTOCOL_VERSION,
		"token": _token,
		"nonce": _nonce,
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
	match str(data.get("type", "")):
		"welcome":
			_verify_welcome(str(data.get("proof", "")))
		"rejected":
			_warn("godotty-mcp: bridge rejected this %s: %s" % [_role, data.get("reason", "")])
			_finished = true
		_:
			if _authenticated and data.has("id") and data.has("method"):
				_run(data)


## True once the server proved it knows the token.
func is_authenticated() -> bool:
	return _authenticated


func _verify_welcome(proof: String) -> void:
	var expected: String = (
		Crypto
		. new()
		. hmac_digest(HashingContext.HASH_SHA256, _token.to_utf8_buffer(), _nonce.to_utf8_buffer())
		. hex_encode()
	)
	if proof == expected:
		_authenticated = true
		return
	_warn("godotty-mcp: the bridge server failed to prove its identity; disconnecting.")
	_finished = true


func _run(request: Dictionary) -> void:
	var params: Variant = request.get("params", {})
	var outcome: Dictionary = await _commands.call(
		"run", str(request["method"]), params if params is Dictionary else {}
	)
	outcome["id"] = int(request["id"])
	_send(outcome)


## Reports a bridge problem to the game's log (overridden in tests).
func _warn(message: String) -> void:
	push_warning(message)


func _send(message: Dictionary) -> void:
	if _tcp.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_tcp.put_data((JSON.stringify(message) + "\n").to_utf8_buffer())
