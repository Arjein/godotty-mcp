@tool
extends RefCounted
## Compiles and runs agent-supplied GDScript for the opt-in `eval_gdscript` tool.
##
## The code becomes the body of `func run()` in a throwaway script that can see `tree`
## (SceneTree) and `scene` (current scene in a game, edited scene root in the editor). It may
## `await` and `return` a value. Parse and runtime errors raised while it runs are captured by a
## temporary Logger and returned with line numbers relative to the agent's code.

## Lines the wrapper adds before the agent's first line (see _wrap).
const HEADER_LINES: int = 6
const GENERATED_PREFIX: String = "gdscript://"


class ErrorCapture:
	extends Logger
	var errors: Array[String] = []
	var _mutex: Mutex = Mutex.new()

	func _log_error(
		_function: String,
		file: String,
		line: int,
		code: String,
		rationale: String,
		_editor_notify: bool,
		_error_type: int,
		script_backtraces: Array[ScriptBacktrace]
	) -> void:
		var message: String = rationale if rationale != "" else code
		var where: int = (
			line if file.begins_with(GENERATED_PREFIX) else _user_line(script_backtraces)
		)
		_mutex.lock()
		errors.append("line %d: %s" % [where - HEADER_LINES, message] if where > 0 else message)
		_mutex.unlock()

	func _log_message(_message: String, _error: bool) -> void:
		pass

	func _user_line(backtraces: Array[ScriptBacktrace]) -> int:
		for backtrace: ScriptBacktrace in backtraces:
			for i: int in backtrace.get_frame_count():
				if backtrace.get_frame_file(i).begins_with(GENERATED_PREFIX):
					return backtrace.get_frame_line(i)
		return 0


## Runs `code`; returns {"value": String, "errors": Array[String]} or {"parse_errors": [...]}.
func evaluate(code: String, tree: SceneTree, scene: Node) -> Dictionary:
	var script: GDScript = GDScript.new()
	script.source_code = _wrap(code)
	var capture: ErrorCapture = ErrorCapture.new()
	OS.add_logger(capture)
	var compiled: Error = script.reload()
	if compiled != OK:
		OS.remove_logger(capture)
		return {"parse_errors": capture.errors}
	var instance: Object = script.new()
	instance.set("tree", tree)
	instance.set("scene", scene)
	var value: Variant = await instance.call("run")
	OS.remove_logger(capture)
	return {"value": _describe(value), "errors": capture.errors}


func _wrap(code: String) -> String:
	var lines: PackedStringArray = [
		"extends RefCounted",
		"var tree: SceneTree",
		"var scene: Node",
		"",
		"",
		"func run() -> Variant:",
	]
	for line: String in code.split("\n"):
		lines.append("\t" + line)
	lines.append("\treturn null")
	return "\n".join(lines)


func _describe(value: Variant) -> String:
	if value is Object and value != null:
		var object: Object = value
		if object is Node:
			return "<%s %s>" % [object.get_class(), (object as Node).get_path()]
		return "<%s>" % object.get_class()
	return var_to_str(value)
