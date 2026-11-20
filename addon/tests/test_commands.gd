extends GutTest
## Tests the runtime helper's bridge commands (tree, properties, wait, screenshot guard).

const Commands = preload("res://addons/godotty_mcp/runtime/godotty_commands.gd")

var _host: Node
var _commands: Commands
var _level: Node3D
var _hero: Node3D


func before_each() -> void:
	_host = Node.new()
	add_child_autofree(_host)
	_commands = Commands.new(_host)
	_level = Node3D.new()
	_level.name = "Level"
	add_child_autofree(_level)
	_hero = Node3D.new()
	_hero.name = "Hero"
	_hero.position = Vector3(1, 2, 3)
	_level.add_child(_hero)
	var helper: Node = Node.new()
	helper.name = "GodottyRuntime"
	_level.add_child(helper)


func test_unknown_method_is_an_error() -> void:
	var outcome: Dictionary = await _commands.run("nope", {})
	assert_eq(outcome["error"]["code"], "UNKNOWN_METHOD")


func test_tree_serializes_nodes_and_hides_the_helper() -> void:
	var params: Dictionary = {"path": str(_level.get_path()), "depth": 3, "max_nodes": 50}
	var tree: Dictionary = (await _commands.run("tree", params))["result"]
	assert_eq(tree["root"]["name"], "Level")
	assert_eq(tree["root"]["class"], "Node3D")
	var children: Array = tree["root"]["children"]
	assert_eq(children.size(), 1, "the godotty helper node is not listed")
	assert_eq(children[0]["info"], "pos=(1, 2, 3)")
	assert_false(tree["truncated"])


func test_tree_respects_the_node_budget() -> void:
	for i: int in 5:
		var extra: Node = Node.new()
		_hero.add_child(extra)
	var params: Dictionary = {"path": str(_level.get_path()), "depth": 5, "max_nodes": 3}
	var tree: Dictionary = (await _commands.run("tree", params))["result"]
	assert_true(tree["truncated"])
	var hero: Dictionary = tree["root"]["children"][0]
	assert_gt(int(hero.get("hidden_children", 0)), 0, "omitted children are counted")


func test_missing_node_is_reported() -> void:
	var outcome: Dictionary = await _commands.run("tree", {"path": "/root/Ghost"})
	assert_eq(outcome["error"]["code"], "NODE_NOT_FOUND")


func test_properties_list_most_specific_first_with_enum_names() -> void:
	var params: Dictionary = {"path": str(_hero.get_path()), "names": [], "filter": "", "max": 500}
	var result: Dictionary = (await _commands.run("get_props", params))["result"]
	var names: Array = result["props"].map(func(p: Dictionary) -> String: return p["name"])
	assert_lt(names.find("position"), names.find("process_mode"), "Node3D before Node")
	var order: Dictionary = result["props"][names.find("rotation_order")]
	assert_string_contains(order["value"], "(YXZ)")


func test_requested_and_missing_properties() -> void:
	var path: String = str(_hero.get_path())
	var params: Dictionary = {"path": path, "names": ["position:x"], "filter": "", "max": 10}
	var result: Dictionary = (await _commands.run("get_props", params))["result"]
	assert_eq(result["props"][0]["value"], "1.0")
	params["names"] = ["nope"]
	var outcome: Dictionary = await _commands.run("get_props", params)
	assert_eq(outcome["error"]["code"], "PROPERTY_NOT_FOUND")


func test_set_props_parses_godot_literals() -> void:
	var params: Dictionary = {
		"path": str(_hero.get_path()), "values": {"position": "Vector3(4, 5, 6)"}
	}
	var result: Dictionary = (await _commands.run("set_props", params))["result"]
	assert_eq(_hero.position, Vector3(4, 5, 6))
	assert_eq(result["props"][0]["value"], "Vector3(4, 5, 6)")


func test_set_props_rejects_bad_values_without_changing_anything() -> void:
	var path: String = str(_hero.get_path())
	for values: Dictionary in [{"visible": '"yes"'}, {"ghost": "1"}, {"position": "Vector3("}]:
		var outcome: Dictionary = await _commands.run("set_props", {"path": path, "values": values})
		assert_eq(outcome["error"]["code"], "INVALID_VALUE", str(values))
	assert_eq(_hero.position, Vector3(1, 2, 3))
	assert_true(_hero.visible)


func test_compare_handles_numbers_and_mixed_types() -> void:
	assert_true(_commands._compare(1, 1.00001, "=="))
	assert_true(_commands._compare(2.0, 3, "<"))
	assert_false(_commands._compare(2.0, 3, ">="))
	assert_true(_commands._compare(Vector3.ONE, Vector3.ONE, "=="))
	assert_true(_commands._compare(Vector3.ONE, "text", "!="))
	assert_false(_commands._compare(Vector3.ONE, Vector2.ONE, "<"))


func test_wait_for_frames_and_conditions() -> void:
	var frames: Dictionary = (await _commands.run("wait", {"frames": 3}))["result"]
	assert_eq(int(frames["frames"]), 3, "waits exactly the requested frames")
	var path: String = str(_hero.get_path())
	var met: Dictionary = (await _commands.run(
		"wait", {"until": {"node": path, "property": "position:y", "op": ">", "value": "1"}}
	))["result"]
	assert_true(met["met"])
	assert_eq(met["last_value"], "2.0")
	var condition: Dictionary = {"node": path, "property": "position:y", "op": ">", "value": "9"}
	var params: Dictionary = {"until": condition, "timeout_s": 0.1}
	var unmet: Dictionary = (await _commands.run("wait", params))["result"]
	assert_false(unmet["met"])


func test_screenshot_refuses_headless_instead_of_hanging() -> void:
	if DisplayServer.get_name() != "headless":
		pass_test("only meaningful in headless runs")
		return
	var outcome: Dictionary = await _commands.run("screenshot", {"count": 1})
	assert_eq(outcome["error"]["code"], "HEADLESS")


func test_resource_and_object_literals_are_refused_without_eval() -> void:
	var path: String = str(_hero.get_path())
	for literal: String in ['Resource("res://x.gd")', "Object(Node)"]:
		var params: Dictionary = {"path": path, "values": {"editor_description": literal}}
		var outcome: Dictionary = await _commands.run("set_props", params)
		assert_eq(outcome["error"]["code"], "INVALID_VALUE", literal)
		assert_string_contains(outcome["error"]["message"], "not allowed")
	var condition: Dictionary = {"node": path, "property": "visible", "value": "Object(Node)"}
	var waited: Dictionary = await _commands.run("wait", {"until": condition, "timeout_s": 0.1})
	assert_eq(waited["error"]["code"], "INVALID_VALUE")


func test_eval_is_refused_unless_enabled() -> void:
	var outcome: Dictionary = await _commands.run("eval", {"code": "return 1"})
	assert_eq(outcome["error"]["code"], "EVAL_DISABLED")


func test_eval_runs_code_when_enabled() -> void:
	# Parse/runtime error reporting is covered by test/integration/eval.test.ts: GUT fails any test
	# during which an engine error is logged.
	_commands.eval_allowed = true
	var params: Dictionary = {"code": "await tree.process_frame\nreturn 6 * 7"}
	var ok: Dictionary = await _commands.run("eval", params)
	assert_eq(ok["result"]["value"], "42")
	assert_eq(ok["result"]["errors"], [])
