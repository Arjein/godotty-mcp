extends GutTest
## Tests how values are read and shown: object values, getters, rounded positions, observe.

const Commands = preload("res://addons/godotty_mcp/runtime/godotty_commands.gd")


## A node holding another node, like a state machine holding its current state.
class Holder:
	extends Node
	var helper: Node
	var data: RefCounted = RefCounted.new()


## Moves `target` one unit along x every frame (pausable, like game nodes).
class Mover:
	extends Node
	var target: Node3D

	func _process(_delta: float) -> void:
		target.position.x += 1.0


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
	_level.add_child(_hero)


func _props(names: Array) -> Dictionary:
	var params: Dictionary = {"path": str(_level.get_path()) + "/Holder", "names": names}
	params.merge({"filter": "", "max": 50})
	return await _commands.run("get_props", params)


func _add_holder() -> Holder:
	var holder: Holder = Holder.new()
	holder.name = "Holder"
	holder.helper = _hero
	_level.add_child(holder)
	return holder


func test_object_values_name_their_node_path_or_class() -> void:
	_add_holder()
	var props: Array = (await _props(["helper", "data"]))["result"]["props"]
	assert_eq(props[0]["value"], "<Node3D %s>" % _hero.get_path())
	assert_eq(props[1]["value"], "<RefCounted>")
	var loose: Node = Node.new()
	assert_eq(_commands._format(loose), "<Node %s (not in tree)>" % loose.name)
	loose.free()


func test_zero_argument_getters_can_be_read() -> void:
	_add_holder()
	var names: Array = ["is_inside_tree()", "get_child_count()", "helper:get_child_count()"]
	var props: Array = (await _props(names))["result"]["props"]
	var values: Array = props.map(func(p: Dictionary) -> String: return p["value"])
	assert_eq(values, ["true", "0", "0"])


func test_methods_that_are_not_zero_argument_getters_are_refused() -> void:
	_add_holder()
	for name: String in ["queue_free()", "get_node()", "nope()", "data:is_nothing()"]:
		var outcome: Dictionary = await _props([name])
		assert_eq(outcome["error"]["code"], "PROPERTY_NOT_FOUND", name)
	var queued: Dictionary = await _props(["queue_free()"])
	assert_string_contains(queued["error"]["message"], "not a getter")
	assert_false(_level.get_node("Holder").is_queued_for_deletion())
	var condition: Dictionary = {"node": str(_hero.get_path()), "property": "free()"}
	var waited: Dictionary = await _commands.run("wait", {"until": condition, "timeout_s": 0.1})
	assert_eq(waited["error"]["code"], "BAD_PARAMS")


func test_wait_on_a_getter() -> void:
	var condition: Dictionary = {
		"node": str(_hero.get_path()), "property": "is_inside_tree()", "value": "true"
	}
	var met: Dictionary = await _commands.run("wait", {"until": condition, "timeout_s": 1})
	assert_true(met["result"]["met"])


func test_tree_positions_are_rounded() -> void:
	_hero.position = Vector3(-4.9548123e-07, 0.00088487676, 6.8990545)
	var params: Dictionary = {"path": str(_level.get_path()), "depth": 1, "max_nodes": 5}
	var tree: Dictionary = (await _commands.run("tree", params))["result"]
	assert_eq(tree["root"]["children"][0]["info"], "pos=(0, 0.001, 6.899)")


func test_input_reports_observed_changes() -> void:
	var mover: Mover = Mover.new()
	mover.target = _hero
	add_child_autofree(mover)
	var watch: Array = [
		{"node": str(_hero.get_path()), "property": "position:x"},
		{"node": "/root/Ghost", "property": "visible"},
	]
	var params: Dictionary = {"steps": [{"type": "wait", "frames": 3}], "observe": watch}
	var result: Dictionary = (await _commands.run("input", params))["result"]
	var changes: Array = result["observed"]
	var hero: Array = changes.filter(
		func(c: Dictionary) -> bool: return str(c["name"]).ends_with("position:x")
	)
	assert_gt(hero.size(), 2, "a value per frame it changed")
	assert_eq(hero[0]["step"], 0, "the first sample is taken before step 1")
	assert_eq(hero[1]["step"], 1)
	var ghost: Array = changes.filter(
		func(c: Dictionary) -> bool: return str(c["name"]).begins_with("/root/Ghost")
	)
	assert_eq(ghost.size(), 1, "unchanged values are reported once")
	assert_eq(ghost[0]["value"], "<no node>")
	assert_false(result["observed_truncated"])
	var bad: Dictionary = {"steps": [{"type": "wait", "frames": 1}], "observe": [{"node": ""}]}
	assert_eq((await _commands.run("input", bad))["error"]["code"], "BAD_PARAMS")
