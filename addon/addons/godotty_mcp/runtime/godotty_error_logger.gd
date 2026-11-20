extends Logger
## Captures engine and script errors as JSON lines in the run's events file.
##
## Godot may call loggers from any thread, so writes are serialized with a mutex. Re-entrant calls
## (an error raised while writing) are dropped to avoid recursion.

const ERROR_EVENT: String = "error"

var _file: FileAccess
var _mutex: Mutex = Mutex.new()
var _writing: bool = false


## Uses an already-open events file; the runtime helper owns opening and closing it.
func _init(file: FileAccess) -> void:
	_file = file


func _log_error(
	function: String,
	file: String,
	line: int,
	code: String,
	rationale: String,
	_editor_notify: bool,
	error_type: int,
	script_backtraces: Array[ScriptBacktrace]
) -> void:
	var record: Dictionary = {
		"event": ERROR_EVENT,
		"type": error_type,
		"function": function,
		"file": file,
		"line": line,
		"code": code,
		"rationale": rationale,
		"backtrace": _frames(script_backtraces),
	}
	write_record(record)


func _log_message(_message: String, _error: bool) -> void:
	pass


## Appends one JSON record as a line. Safe to call from any thread.
func write_record(record: Dictionary) -> void:
	_mutex.lock()
	if not _writing and _file != null:
		_writing = true
		_file.store_line(JSON.stringify(record))
		_file.flush()
		_writing = false
	_mutex.unlock()


func _frames(backtraces: Array[ScriptBacktrace]) -> Array[Dictionary]:
	var frames: Array[Dictionary] = []
	for backtrace: ScriptBacktrace in backtraces:
		for i: int in backtrace.get_frame_count():
			var frame: Dictionary = {
				"function": backtrace.get_frame_function(i),
				"file": backtrace.get_frame_file(i),
				"line": backtrace.get_frame_line(i),
			}
			frames.append(frame)
	return frames
