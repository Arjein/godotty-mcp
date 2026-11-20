@tool
extends RefCounted
## Runtime commands for the godotty-mcp bridge: screenshot, input, wait, tree, get/set properties,
## pause/step, and UI controls.
##
## Every command returns {"result": ...} or {"error": {"code", "message"}}; see
## server/src/bridge/protocol.ts for parameter and result shapes.

const GodottyInput = preload("godotty_input.gd")
const GodottyEval = preload("godotty_eval.gd")
const GodottyClock = preload("godotty_clock.gd")
const GodottyControls = preload("godotty_controls.gd")

const MAX_VALUE_CHARS: int = 200
const MAX_TEXT_CHARS: int = 40
const MS_PER_SECOND: float = 1000.0
const FLOAT_TOLERANCE: float = 0.0001
const AUTOLOAD_NAME: String = "GodottyRuntime"
const SKIPPED_USAGE: int = PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP
const LISTED_USAGE: int = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_SCRIPT_VARIABLE
## Positions in tree summaries are rounded to this step; smaller values print as 0.
const SUMMARY_STEP: float = 0.001
const SUMMARY_DECIMALS: int = 3
## "name()" in a property list calls a zero-argument method whose name starts with one of these.
const GETTER_PREFIXES: Array[String] = ["is_", "has_", "can_", "get_"]
const GETTER_SUFFIX: String = "()"
## Commands that play the game: while it is frozen they run it, then freeze it again.
const ADVANCING_METHODS: Array[String] = ["input", "wait", "press"]
const MAX_OBSERVED_CHANGES: int = 200
const MIN_TIME_SCALE: float = 0.01
const MAX_TIME_SCALE: float = 16.0

## Literals that make str_to_var load resources or build objects — loading a script can run its
## code, so these are refused unless eval is enabled.
const UNSAFE_LITERAL: String = "\\b(Object|Resource|ExtResource|SubResource)\\s*\\("

## Set by the owner when the server enabled eval_gdscript (--allow-eval).
var eval_allowed: bool = false
var _host: Node
var _input: GodottyInput
var _clock: GodottyClock
var _controls: GodottyControls
var _unsafe_literal: RegEx = RegEx.create_from_string(UNSAFE_LITERAL)


func _init(host: Node) -> void:
	_host = host
	_input = GodottyInput.new(host)
	_clock = GodottyClock.new(host)
	_controls = GodottyControls.new(host)


## Freezes the game before its first frame runs (run_game paused=true).
func freeze() -> void:
	_clock.freeze()


## Runs one request. Unknown methods and failures come back as {"error": ...}.
func run(method: String, params: Dictionary) -> Dictionary:
	var handler: String = "_cmd_" + method
	if not has_method(handler):
		return _error("UNKNOWN_METHOD", "Unknown method '%s'." % method)
	if not method in ADVANCING_METHODS:
		return await call(handler, params)
	_clock.begin()
	var outcome: Dictionary = await call(handler, params)
	_clock.end()
	return outcome


func _cmd_screenshot(params: Dictionary) -> Dictionary:
	# Headless uses a dummy renderer: frame_post_draw never fires, so never await it there.
	if DisplayServer.get_name() == "headless":
		return _error("HEADLESS", "The game runs headless, so nothing is rendered.")
	var max_size: int = int(params.get("max_size", 0))
	var count: int = maxi(1, int(params.get("count", 1)))
	var interval: float = float(params.get("interval_ms", 0)) / MS_PER_SECOND
	var frames: Array[String] = []
	var size: Vector2i = Vector2i.ZERO
	for i: int in count:
		if i > 0 and interval > 0.0:
			await _host.get_tree().create_timer(interval, true, false, true).timeout
		await RenderingServer.frame_post_draw
		var image: Image = _host.get_viewport().get_texture().get_image()
		_shrink(image, max_size)
		size = image.get_size()
		frames.append(Marshalls.raw_to_base64(image.save_png_to_buffer()))
	return _ok({"width": size.x, "height": size.y, "frames": frames})


func _cmd_input(params: Dictionary) -> Dictionary:
	var steps: Array = params.get("steps", [])
	var problem: String = _input.validate(steps)
	if problem != "":
		return _error(problem.get_slice("|", 0), problem.get_slice("|", 1))
	var watch: Array = params.get("observe", [])
	for entry: Variant in watch:
		var bad: String = _watch_problem(entry)
		if bad != "":
			return _error("BAD_PARAMS", bad)
	var start_ms: int = Time.get_ticks_msec()
	var start_frame: int = Engine.get_process_frames()
	var record: Dictionary = {
		"running": true, "step": 0, "start_ms": start_ms, "changes": [], "last": {}, "full": false
	}
	if not watch.is_empty():
		_sample(watch, record)
		_observe(watch, record)
	for i: int in steps.size():
		record["step"] = i + 1
		await _input.perform(steps[i])
	record["running"] = false
	var elapsed: Dictionary = {
		"steps": steps.size(),
		"elapsed_ms": Time.get_ticks_msec() - start_ms,
		"frames": Engine.get_process_frames() - start_frame,
	}
	if not watch.is_empty():
		_sample(watch, record)
		elapsed["observed"] = record["changes"]
		elapsed["observed_truncated"] = record["full"]
	return _ok(elapsed)


## "" when an observe entry is {node, property} with a readable property, else why not.
func _watch_problem(entry: Variant) -> String:
	if not entry is Dictionary or str(entry.get("node", "")) == "":
		return "Each observe entry needs a node and a property."
	return _getter_syntax_problem(str(entry.get("property", "")))


## Samples the watched values every frame until the batch ends (runs alongside the steps).
func _observe(watch: Array, record: Dictionary) -> void:
	while record["running"]:
		await _host.get_tree().process_frame
		if record["running"]:
			_sample(watch, record)


## Records each watched value that differs from the last one seen.
func _sample(watch: Array, record: Dictionary) -> void:
	var last: Dictionary = record["last"]
	var changes: Array = record["changes"]
	for entry: Dictionary in watch:
		var node_path: String = str(entry["node"])
		var property: String = str(entry.get("property", ""))
		var key: String = "%s:%s" % [node_path, property]
		var node: Node = _resolve(node_path)
		var text: String = "<no node>"
		if node != null:
			var read: Array = _read(node, property)
			text = _format(read[1]) if read[0] == "" else "<%s>" % read[0]
		if last.has(key) and last[key] == text:
			continue
		last[key] = text
		if changes.size() >= MAX_OBSERVED_CHANGES:
			record["full"] = true
			continue
		var change: Dictionary = {
			"t_ms": Time.get_ticks_msec() - int(record["start_ms"]),
			"step": record["step"],
			"name": key,
			"value": text,
		}
		changes.append(change)


func _cmd_wait(params: Dictionary) -> Dictionary:
	var until: Variant = params.get("until", {})
	if until is Dictionary and (until as Dictionary).has("value"):
		var problem: String = _literal_problem(str(until["value"]))
		if problem != "":
			return _error("INVALID_VALUE", problem)
	if until is Dictionary:
		var syntax: String = _getter_syntax_problem(str(until.get("property", "")))
		if syntax != "":
			return _error("BAD_PARAMS", syntax)
	var start_ms: int = Time.get_ticks_msec()
	var start_frame: int = Engine.get_process_frames()
	var outcome: Dictionary = {"met": true}
	if params.has("until"):
		outcome = await _wait_until(params["until"], float(params.get("timeout_s", 10.0)))
	elif params.has("frames"):
		await _wait_frames(int(params["frames"]))
	else:
		var seconds: float = float(params.get("seconds", 0.0))
		await _host.get_tree().create_timer(seconds, true, false, true).timeout
	outcome["elapsed_ms"] = Time.get_ticks_msec() - start_ms
	outcome["frames"] = Engine.get_process_frames() - start_frame
	return _ok(outcome)


## Waits until `count` frames have passed by the engine's counter (the first process_frame
## signal may still belong to the current frame).
func _wait_frames(count: int) -> void:
	var target: int = Engine.get_process_frames() + count
	while Engine.get_process_frames() < target:
		await _host.get_tree().process_frame


func _wait_until(condition: Dictionary, timeout_s: float) -> Dictionary:
	var deadline: int = Time.get_ticks_msec() + int(timeout_s * MS_PER_SECOND)
	var state: Dictionary = _check(condition)
	while not state["met"] and Time.get_ticks_msec() < deadline:
		await _host.get_tree().process_frame
		state = _check(condition)
	return state


## {"met": bool, "last_value"?: String} for one `until` condition.
func _check(condition: Dictionary) -> Dictionary:
	var node: Node = _resolve(str(condition.get("node", "")))
	var property: String = str(condition.get("property", ""))
	if node == null or property == "":
		return {"met": node != null}
	var read: Array = _read(node, property)
	if read[0] != "":
		return {"met": false, "last_value": "<%s>" % read[0]}
	var current: Variant = read[1]
	var state: Dictionary = {"met": true, "last_value": _format(current)}
	if condition.has("value"):
		var expected: Variant = str_to_var(str(condition["value"]))
		state["met"] = _compare(current, expected, str(condition.get("op", "==")))
	return state


func _cmd_pause(params: Dictionary) -> Dictionary:
	if params.has("time_scale"):
		Engine.time_scale = clampf(float(params["time_scale"]), MIN_TIME_SCALE, MAX_TIME_SCALE)
	if bool(params.get("paused", true)):
		_clock.freeze()
	else:
		_clock.resume()
	return _ok(_clock_state())


func _cmd_step(params: Dictionary) -> Dictionary:
	var frames: int = maxi(1, int(params.get("frames", 1)))
	var start_ms: int = Time.get_ticks_msec()
	await _clock.step(frames)
	return _ok(
		_clock_state().merged({"frames": frames, "elapsed_ms": Time.get_ticks_msec() - start_ms})
	)


func _clock_state() -> Dictionary:
	return {
		"paused": _clock.is_frozen(),
		"game_paused": _clock.is_game_paused(),
		"time_scale": Engine.time_scale,
		"physics_frame": Engine.get_physics_frames(),
	}


func _cmd_controls(params: Dictionary) -> Dictionary:
	var path: String = str(params.get("path", ""))
	var start: Node = _tree_start(path)
	if start == null:
		return _error("NODE_NOT_FOUND", "No node at '%s'." % path)
	var found: Array[Control] = _controls.collect(start)
	var listed: Array[Dictionary] = []
	for control: Control in found.slice(0, int(params.get("max", 100))):
		listed.append(_controls.describe(control, _display_path(control)))
	return _ok({"controls": listed, "total": found.size(), "path": _display_path(start)})


func _cmd_press(params: Dictionary) -> Dictionary:
	var action: String = str(params.get("action", "click"))
	var found: Dictionary = _find_control(params)
	if found.has("error"):
		return found
	var control: Control = found["control"]
	var problem: String = _controls.problem(control, action)
	if problem != "":
		return _error("CONTROL_UNAVAILABLE", problem)
	# Describe first: pressing may free the control (a scene change).
	var pressed: Dictionary = _controls.describe(control, _display_path(control))
	pressed["action"] = action
	return _ok(pressed.merged(await _controls.press(control, action)))


## {"control": Control} for a press request by node path or visible text, else {"error": ...}.
func _find_control(params: Dictionary) -> Dictionary:
	var path: String = str(params.get("path", ""))
	if path != "":
		var node: Node = _resolve(path)
		if not node is Control:
			return _error("NODE_NOT_FOUND", "No Control at '%s'." % path)
		return {"control": node}
	var text: String = str(params.get("text", ""))
	var matches: Array[Control] = _controls.find_by_text(_host.get_tree().root, text)
	if matches.size() == 1:
		return {"control": matches[0]}
	if matches.is_empty():
		var visible: PackedStringArray = []
		for control: Control in _controls.collect(_host.get_tree().root).slice(0, 15):
			if _controls.label(control) != "":
				visible.append('"%s"' % _controls.label(control))
		return _error(
			"NODE_NOT_FOUND",
			(
				"No visible control with text '%s'. Visible: %s."
				% [text, ", ".join(visible) if not visible.is_empty() else "none with text"]
			)
		)
	var candidates: PackedStringArray = []
	for control: Control in matches.slice(0, 10):
		candidates.append('%s ("%s")' % [_display_path(control), _controls.label(control)])
	return _error(
		"AMBIGUOUS", "%d controls match '%s': %s." % [matches.size(), text, ", ".join(candidates)]
	)


func _cmd_tree(params: Dictionary) -> Dictionary:
	var path: String = str(params.get("path", ""))
	var start: Node = _tree_start(path)
	if start == null:
		return _error("NODE_NOT_FOUND", "No node at '%s'." % path)
	# [nodes left, 1 if anything was left out because of the budget]
	var budget: Array[int] = [int(params.get("max_nodes", 200)), 0]
	var tree: Dictionary = _serialize(start, int(params.get("depth", 4)), budget)
	var result: Dictionary = {
		"root": tree,
		"path": _display_path(start),
		"current_scene": _current_scene_label(),
		"truncated": budget[1] == 1,
	}
	return _ok(result)


func _serialize(node: Node, depth: int, budget: Array[int]) -> Dictionary:
	budget[0] -= 1
	var entry: Dictionary = {"name": str(node.name), "class": node.get_class()}
	var script: Script = node.get_script()
	if script != null and script.resource_path != "":
		entry["script"] = script.resource_path
	var info: String = _summary(node)
	if info != "":
		entry["info"] = info
	var children: Array[Node] = node.get_children().filter(_is_listed)
	var listed: Array[Dictionary] = []
	for child: Node in children:
		if depth <= 0:
			break
		if budget[0] <= 0:
			budget[1] = 1
			break
		listed.append(_serialize(child, depth - 1, budget))
	if not listed.is_empty():
		entry["children"] = listed
	if listed.size() < children.size():
		entry["hidden_children"] = children.size() - listed.size()
	return entry


func _is_listed(node: Node) -> bool:
	return node.name != AUTOLOAD_NAME


## Short state summary that helps an agent orient itself without a full property dump.
func _summary(node: Node) -> String:
	var parts: PackedStringArray = []
	var position: Variant = _position(node)
	# Vector2/Vector3 must not be compared with each other (runtime type error); ask each instead.
	if position != null and not position.is_zero_approx():
		parts.append("pos=%s" % _compact(position))
	if (node is CanvasItem or node is Node3D) and not node.get("visible"):
		parts.append("visible=false")
	if node is Label or node is Button or node is LineEdit:
		parts.append("text=%s" % _clip(var_to_str(str(node.get("text"))), MAX_TEXT_CHARS))
	if node.process_mode == Node.PROCESS_MODE_DISABLED:
		parts.append("disabled")
	return " ".join(parts)


func _position(node: Node) -> Variant:
	if node is Node3D or node is Node2D or node is Control:
		return node.get("position")
	return null


## Vector3(1, 2.00049, -4.9e-07) → "(1, 2, 0)": rounded, so summaries stay short.
func _compact(value: Variant) -> String:
	var parts: PackedStringArray = []
	var count: int = 2 if value is Vector2 else 3
	for i: int in count:
		parts.append(_short_number(float(value[i])))
	return "(%s)" % ", ".join(parts)


func _short_number(number: float) -> String:
	var rounded: float = snappedf(number, SUMMARY_STEP)
	if absf(rounded) < SUMMARY_STEP / 2.0:
		rounded = 0.0
	var text: String = String.num(rounded, SUMMARY_DECIMALS)
	return text.trim_suffix(".0") if text.ends_with(".0") else text


func _cmd_get_props(params: Dictionary) -> Dictionary:
	var path: String = str(params.get("path", ""))
	var node: Node = _resolve(path)
	if node == null:
		return _error("NODE_NOT_FOUND", "No node at '%s'." % path)
	var names: Array = params.get("names", [])
	var props: Array[Dictionary] = []
	var total: int = 0
	if names.is_empty():
		var listed: Array[Dictionary] = _listed_properties(node, str(params.get("filter", "")))
		total = listed.size()
		props = listed.slice(0, int(params.get("max", 80)))
	else:
		for name: Variant in names:
			var read: Array = _read(node, str(name))
			if read[0] != "":
				return _error("PROPERTY_NOT_FOUND", read[0])
			var info: Dictionary = {} if _is_getter(str(name)) else _property_info(node, str(name))
			props.append(_value_entry(str(name), read[1], info))
		total = props.size()
	return _ok(_node_header(node).merged({"props": props, "total": total}))


## Inspector-visible and script properties, most specific first: script variables, then the node's
## own class, then its ancestors (Node's generic settings last).
func _listed_properties(node: Node, filter: String) -> Array[Dictionary]:
	var sections: Array[Array] = [[]]
	for info: Dictionary in node.get_property_list():
		var usage: int = info["usage"]
		if usage & PROPERTY_USAGE_CATEGORY:
			sections.append([])
			continue
		var name: String = info["name"]
		if usage & SKIPPED_USAGE or not usage & LISTED_USAGE:
			continue
		if filter == "" or name.contains(filter):
			sections.back().append(_prop_entry(node, name, info))
	var listed: Array[Dictionary] = []
	for i: int in range(sections.size() - 1, -1, -1):
		listed.append_array(sections[i])
	return listed


func _cmd_set_props(params: Dictionary) -> Dictionary:
	var path: String = str(params.get("path", ""))
	var node: Node = _resolve(path)
	if node == null:
		return _error("NODE_NOT_FOUND", "No node at '%s'." % path)
	var values: Dictionary = params.get("values", {})
	var parsed: Dictionary = {}
	for name: Variant in values:
		var problem: String = _parse_assignment(node, str(name), str(values[name]), parsed)
		if problem != "":
			return _error("INVALID_VALUE", problem)
	var props: Array[Dictionary] = []
	for name: Variant in parsed:
		node.set_indexed(NodePath(str(name)), parsed[name])
		props.append(_prop_entry(node, str(name), _property_info(node, str(name))))
	return _ok({"path": _display_path(node), "props": props})


## Validates one `name = literal` assignment into `parsed`; returns "" or a problem description.
func _parse_assignment(node: Node, name: String, literal: String, parsed: Dictionary) -> String:
	if not _has_property(node, name):
		return "%s has no property '%s'." % [node.get_class(), name]
	var unsafe: String = _literal_problem(literal)
	if unsafe != "":
		return unsafe
	var value: Variant = str_to_var(literal)
	# Second layer behind the literal check: nothing that parsed into an object gets through.
	if typeof(value) == TYPE_OBJECT and not eval_allowed:
		return "Object values are not allowed; attach scripts with update_node script=..."
	if value == null and literal.strip_edges() != "null":
		return 'Cannot parse \'%s\' as a Godot value (strings need quotes: "\\"text\\"").' % literal
	var current: Variant = node.get_indexed(NodePath(name))
	if not _assignable(current, value):
		return (
			"%s expects %s, got %s."
			% [name, type_string(typeof(current)), type_string(typeof(value))]
		)
	parsed[name] = value
	return ""


## "" if `literal` is safe to give to str_to_var, else why not.
func _literal_problem(literal: String) -> String:
	if eval_allowed or _unsafe_literal.search(literal) == null:
		return ""
	return (
		"Object/Resource literals are not allowed (loading a resource can run script code). "
		+ "Attach scripts with update_node script=..., or enable eval_gdscript."
	)


func _cmd_eval(params: Dictionary) -> Dictionary:
	if not eval_allowed:
		return _error(
			"EVAL_DISABLED", "eval is disabled (the server was not started with --allow-eval)."
		)
	var outcome: Dictionary = await GodottyEval.new().evaluate(
		str(params.get("code", "")), _host.get_tree(), _eval_scene()
	)
	if outcome.has("parse_errors"):
		var errors: Array = outcome["parse_errors"]
		return _error("EVAL_PARSE", "\n".join(errors) if not errors.is_empty() else "Parse error.")
	return _ok(outcome)


## What `scene` refers to inside eval code: the current scene of the game.
func _eval_scene() -> Node:
	return _host.get_tree().current_scene


## [problem, value]: a property or sub-property ("position:x"), or a getter call ("is_open()",
## "state_machine:current_name()"). problem is "" when the value could be read.
func _read(node: Node, name: String) -> Array:
	if not _is_getter(name):
		if not _has_property(node, name):
			return ["%s has no property '%s'." % [node.get_class(), name], null]
		return ["", node.get_indexed(NodePath(name))]
	var call_path: String = name.trim_suffix(GETTER_SUFFIX)
	var colon: int = call_path.rfind(":")
	var method: String = call_path.substr(colon + 1)
	var target: Variant = node
	if colon != -1:
		var holder: String = call_path.left(colon)
		if not _has_property(node, holder):
			return ["%s has no property '%s'." % [node.get_class(), holder], null]
		target = node.get_indexed(NodePath(holder))
	var problem: String = _getter_problem(target, method)
	if problem != "":
		return [problem, null]
	return ["", (target as Object).call(method)]


func _is_getter(name: String) -> bool:
	return name.ends_with(GETTER_SUFFIX)


## "" unless `name` is a call that is not an allowed getter name.
func _getter_syntax_problem(name: String) -> String:
	if not _is_getter(name):
		return ""
	var method: String = name.trim_suffix(GETTER_SUFFIX).get_slice(":", name.count(":"))
	for prefix: String in GETTER_PREFIXES:
		if method.begins_with(prefix) and method.is_valid_identifier():
			return ""
	return (
		"'%s' is not a getter: only zero-argument methods named is_*, has_*, can_* or get_* " % name
		+ "can be called."
	)


func _getter_problem(target: Variant, method: String) -> String:
	var syntax: String = _getter_syntax_problem(method + GETTER_SUFFIX)
	if syntax != "":
		return syntax
	if typeof(target) != TYPE_OBJECT or not is_instance_valid(target):
		return "%s() needs an object to call on, got %s." % [method, type_string(typeof(target))]
	var object: Object = target
	if not object.has_method(method):
		return "%s has no method '%s'." % [object.get_class(), method]
	if _required_arguments(object, method) != 0:
		return "%s() takes arguments; only zero-argument getters can be called." % method
	return ""


## Arguments `method` needs (defaulted ones don't count); -1 when it is not listed.
func _required_arguments(object: Object, method: String) -> int:
	for info: Dictionary in object.get_method_list():
		if info["name"] == method:
			return (info["args"] as Array).size() - (info["default_args"] as Array).size()
	return -1


func _assignable(current: Variant, value: Variant) -> bool:
	var current_type: int = typeof(current)
	var value_type: int = typeof(value)
	if current_type == TYPE_NIL or current_type == value_type:
		return true
	var numeric: Array[int] = [TYPE_INT, TYPE_FLOAT]
	return current_type in numeric and value_type in numeric


func _has_property(node: Node, name: String) -> bool:
	return not _property_info(node, name).is_empty()


## Property-list entry for `name` ("position:x" → "position"), or {} when there is none.
func _property_info(node: Node, name: String) -> Dictionary:
	var base: String = name.get_slice(":", 0)
	for info: Dictionary in node.get_property_list():
		if info["name"] == base:
			return info
	return {}


func _prop_entry(node: Node, name: String, info: Dictionary) -> Dictionary:
	return _value_entry(name, node.get_indexed(NodePath(name)), info)


func _value_entry(name: String, value: Variant, info: Dictionary) -> Dictionary:
	var type_name: String = type_string(typeof(value))
	if typeof(value) == TYPE_OBJECT and is_instance_valid(value):
		type_name = (value as Object).get_class()
	var text: String = _format(value)
	var label: String = _enum_label(info, value) if name == info.get("name", "") else ""
	if label != "":
		text += " (%s)" % label
	return {"name": name, "type": type_name, "value": text}


## For enum properties ("Inherit,Pausable:1,..."), the name of the current value.
func _enum_label(info: Dictionary, value: Variant) -> String:
	if info.get("hint", 0) != PROPERTY_HINT_ENUM or typeof(value) != TYPE_INT:
		return ""
	var options: PackedStringArray = str(info.get("hint_string", "")).split(",")
	for i: int in options.size():
		var parts: PackedStringArray = options[i].split(":")
		var option_value: int = parts[1].to_int() if parts.size() > 1 else i
		if option_value == value:
			return parts[0]
	return ""


func _node_header(node: Node) -> Dictionary:
	var header: Dictionary = {"path": _display_path(node), "class": node.get_class()}
	var script: Script = node.get_script()
	if script != null and script.resource_path != "":
		header["script"] = script.resource_path
	return header


## Where "tree" starts for an empty path: the whole scene tree in a game.
func _tree_start(path: String) -> Node:
	return _host.get_tree().root if path == "" else _resolve(path)


## Names the scene the paths refer to, for "tree" results.
func _current_scene_label() -> String:
	var scene: Node = _host.get_tree().current_scene
	return str(scene.get_path()) if scene != null else ""


## How node paths are shown to the agent: absolute in a game.
func _display_path(node: Node) -> String:
	return str(node.get_path())


## Absolute paths ("/root/Main/Player") or paths relative to the current scene ("Player").
func _resolve(path: String) -> Node:
	if path.begins_with("/"):
		return _host.get_node_or_null(NodePath(path))
	var scene: Node = _host.get_tree().current_scene
	if scene == null:
		return null
	return scene if path == "" or path == "." else scene.get_node_or_null(NodePath(path))


func _compare(current: Variant, expected: Variant, op: String) -> bool:
	var numeric: Array[int] = [TYPE_INT, TYPE_FLOAT]
	if typeof(current) in numeric and typeof(expected) in numeric:
		return _compare_numbers(float(current), float(expected), op)
	var same: bool = typeof(current) == typeof(expected) and current == expected
	if op == "==":
		return same
	return not same if op == "!=" else false


func _compare_numbers(a: float, b: float, op: String) -> bool:
	var close: bool = absf(a - b) <= FLOAT_TOLERANCE
	var results: Dictionary = {
		"==": close, "!=": not close, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b
	}
	return results.get(op, false)


func _format(value: Variant) -> String:
	if typeof(value) == TYPE_OBJECT:
		return _describe_object(value)
	return _clip(var_to_str(value), MAX_VALUE_CHARS)


## Resources with a file → their path; nodes → <Class /path script.gd>; others → <Class script.gd>.
func _describe_object(value: Variant) -> String:
	if value == null:
		return "null"
	if not is_instance_valid(value):
		return "<freed object>"
	var object: Object = value
	if object is Resource and (object as Resource).resource_path != "":
		return (object as Resource).resource_path
	var parts: PackedStringArray = [object.get_class()]
	if object is Node:
		var node: Node = object
		parts.append(
			_display_path(node) if node.is_inside_tree() else "%s (not in tree)" % node.name
		)
	var script: Variant = object.get_script()
	if script is Script and (script as Script).resource_path != "":
		parts.append((script as Script).resource_path.get_file())
	return "<%s>" % " ".join(parts)


func _clip(text: String, limit: int) -> String:
	return text if text.length() <= limit else text.left(limit - 1) + "…"


func _shrink(image: Image, max_size: int) -> void:
	var longest: int = maxi(image.get_width(), image.get_height())
	if max_size <= 0 or longest <= max_size:
		return
	var factor: float = float(max_size) / longest
	image.resize(
		maxi(1, roundi(image.get_width() * factor)),
		maxi(1, roundi(image.get_height() * factor)),
		Image.INTERPOLATE_LANCZOS
	)


func _ok(result: Dictionary) -> Dictionary:
	return {"result": result}


func _error(code: String, message: String) -> Dictionary:
	return {"error": {"code": code, "message": message}}
