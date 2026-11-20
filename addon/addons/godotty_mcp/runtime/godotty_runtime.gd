extends Node
## godotty-mcp runtime helper, injected as an autoload only when the game is launched by the server.
##
## Reads its configuration from user command-line arguments (after `--`). Without them it stays
## inert, so it is harmless if it ever ends up in a normal run.

## Bumped when the events-file or bridge format changes; the server checks it on "ready".
const PROTOCOL_VERSION: int = 1
const EVENTS_ARG: String = "--godotty-events="
const READY_EVENT: String = "ready"
const ErrorLogger = preload("godotty_error_logger.gd")

var _events: FileAccess
var _logger: ErrorLogger


func _init() -> void:
	var events_path: String = _user_arg(EVENTS_ARG)
	if events_path.is_empty():
		return
	_events = FileAccess.open(events_path, FileAccess.WRITE)
	if _events == null:
		push_warning("godotty-mcp: cannot open events file %s" % events_path)
		return
	_logger = ErrorLogger.new(_events)
	OS.add_logger(_logger)


func _ready() -> void:
	if _logger == null:
		return
	var ready_record: Dictionary = {
		"event": READY_EVENT,
		"protocol": PROTOCOL_VERSION,
		"godot": Engine.get_version_info().get("string", ""),
		"pid": OS.get_process_id(),
	}
	_logger.write_record(ready_record)


func _exit_tree() -> void:
	if _logger != null:
		OS.remove_logger(_logger)
		_logger = null
	if _events != null:
		_events.close()
		_events = null


## Returns the value of a `--name=value` user argument, or "" when absent.
func _user_arg(prefix: String) -> String:
	for arg: String in OS.get_cmdline_user_args():
		if arg.begins_with(prefix):
			return arg.trim_prefix(prefix)
	return ""
