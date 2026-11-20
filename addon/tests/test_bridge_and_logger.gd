extends GutTest
## Tests bridge message dispatch (without a socket) and the error logger's JSON records.

const BridgeClient = preload("res://addons/godotty_mcp/runtime/godotty_bridge_client.gd")
const ErrorLogger = preload("res://addons/godotty_mcp/runtime/godotty_error_logger.gd")


## Records warnings instead of logging them (GUT 9.5 fails tests on any push_warning).
class QuietClient:
	extends BridgeClient
	var warnings: Array[String] = []

	func _warn(message: String) -> void:
		warnings.append(message)


class FakeCommands:
	extends RefCounted
	var calls: Array[Array] = []

	func run(method: String, params: Dictionary) -> Dictionary:
		calls.append([method, params])
		return {"result": {}}


func test_dispatch_runs_requests_with_their_params() -> void:
	var commands: FakeCommands = FakeCommands.new()
	var client: BridgeClient = BridgeClient.new()
	client.setup(1, "token", commands)
	client._dispatch(JSON.stringify({"id": 3, "method": "tree", "params": {"depth": 2}}))
	await wait_physics_frames(1)
	assert_eq(commands.calls.size(), 1)
	assert_eq(commands.calls[0][0], "tree")
	assert_eq(int(commands.calls[0][1]["depth"]), 2)
	client.free()


func test_dispatch_ignores_garbage_and_stops_when_rejected() -> void:
	var commands: FakeCommands = FakeCommands.new()
	var client: QuietClient = QuietClient.new()
	client.setup(1, "token", commands)
	client._dispatch("not json")
	client._dispatch(JSON.stringify([1, 2]))
	client._dispatch(JSON.stringify({"type": "welcome", "protocol": 1}))
	assert_eq(commands.calls.size(), 0)
	client._dispatch(JSON.stringify({"type": "rejected", "reason": "invalid token"}))
	assert_true(client._finished)
	assert_eq(client.warnings, ["godotty-mcp: bridge rejected this game: invalid token"])
	client.free()


func test_logger_writes_one_json_record_per_error() -> void:
	var path: String = OS.get_user_data_dir().path_join("godotty_logger_test.jsonl")
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	var logger: ErrorLogger = ErrorLogger.new(file)
	var no_backtraces: Array[ScriptBacktrace] = []
	logger._log_error("f", "res://a.gd", 7, "boom", "", false, 2, no_backtraces)
	file.close()
	var lines: PackedStringArray = FileAccess.get_file_as_string(path).strip_edges().split("\n")
	assert_eq(lines.size(), 1)
	var record: Dictionary = JSON.parse_string(lines[0])
	assert_eq(record["event"], "error")
	assert_eq(record["code"], "boom")
	assert_eq(int(record["line"]), 7)
	assert_eq(int(record["type"]), 2)
	assert_eq(record["backtrace"], [])
	DirAccess.remove_absolute(path)
