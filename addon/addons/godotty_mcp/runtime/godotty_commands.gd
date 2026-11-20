@tool
extends RefCounted
## Runtime commands for the godotty-mcp bridge: screenshot, input, wait, tree, get/set properties.
##
## Every command returns {"result": ...} or {"error": {"code", "message"}}; see
## server/src/bridge/protocol.ts for parameter and result shapes.

const GodottyInput = preload("godotty_input.gd")

const MAX_VALUE_CHARS: int = 200
const MAX_TEXT_CHARS: int = 40
const MS_PER_SECOND: float = 1000.0
const FLOAT_TOLERANCE: float = 0.0001
const AUTOLOAD_NAME: String = "GodottyRuntime"
const SKIPPED_USAGE: int = PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP
const LISTED_USAGE: int = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_SCRIPT_VARIABLE

var _host: Node
var _input: GodottyInput


func _init(host: Node) -> void:
	_host = host
	_input = GodottyInput.new(host)


## Runs one request. Unknown methods and failures come back as {"error": ...}.
func run(method: String, params: Dictionary) -> Dictionary:
	var handler: String = "_cmd_" + method
	if not has_method(handler):
		return _error("UNKNOWN_METHOD", "Unknown method '%s'." % method)
	return await call(handler, params)


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
	var start_ms: int = Time.get_ticks_msec()
	var start_frame: int = Engine.get_process_frames()
	for step: Dictionary in steps:
		await _input.perform(step)
	var elapsed: Dictionary = {
		"steps": steps.size(),
		"elapsed_ms": Time.get_ticks_msec() - start_ms,
		"frames": Engine.get_process_frames() - start_frame,
	}
	return _ok(elapsed)


func _cmd_wait(params: Dictionary) -> Dictionary:
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
	var current: Variant = node.get_indexed(NodePath(property))
	var state: Dictionary = {"met": true, "last_value": _format(current)}
	if condition.has("value"):
		var expected: Variant = str_to_var(str(condition["value"]))
		state["met"] = _compare(current, expected, str(condition.get("op", "==")))
	return state


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


## "Vector3(1, 2, 3)" → "(1, 2, 3)".
func _compact(value: Variant) -> String:
	var text: String = var_to_str(value)
	var paren: int = text.find("(")
	return text.substr(paren) if paren > 0 else text


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
			if not _has_property(node, str(name)):
				return _error(
					"PROPERTY_NOT_FOUND", "%s has no property '%s'." % [node.get_class(), name]
				)
			props.append(_prop_entry(node, str(name), _property_info(node, str(name))))
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
	var value: Variant = str_to_var(literal)
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
	var value: Variant = node.get_indexed(NodePath(name))
	var type_name: String = type_string(typeof(value))
	if value is Object and value != null:
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
	if value is Resource and (value as Resource).resource_path != "":
		return (value as Resource).resource_path
	if value is Object:
		return "<%s>" % (value as Object).get_class() if value != null else "null"
	return _clip(var_to_str(value), MAX_VALUE_CHARS)


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
