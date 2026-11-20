@tool
extends "res://addons/godotty_mcp/runtime/godotty_commands.gd"
## Editor-side bridge commands: open/create scenes and make undoable edits to the edited scene.
##
## Every edit is validated completely first, then applied as ONE EditorUndoRedoManager action
## named "Godotty: ...", so Ctrl+Z in the editor reverts it. Node paths are relative to the edited
## scene root ("." = root). Shares tree/property code with the runtime commands.

const ACTION_PREFIX: String = "Godotty: "
const INVALID_NAME_CHARS: Array[String] = [".", ":", "@", "/", '"', "%"]
const SCENE_EXTENSIONS: Array[String] = ["tscn", "scn"]
const EDITOR_METHODS: Array[String] = [
	"open_scene",
	"add_node",
	"remove_node",
	"update_node",
	"save_scene",
	"tree",
	"get_props",
	"undo",
	"redo",
]

var _undo_redo: EditorUndoRedoManager
## res:// paths of scenes Godotty edited since they were last saved.
var _unsaved: Dictionary = {}


func _init(host: Node, undo_redo: EditorUndoRedoManager) -> void:
	super(host)
	_undo_redo = undo_redo


## Only editor commands are available here (no screenshots/input in the editor).
func run(method: String, params: Dictionary) -> Dictionary:
	if not method in EDITOR_METHODS:
		return _error("UNKNOWN_METHOD", "Unknown editor method '%s'." % method)
	return await super.run(method, params)


func _root() -> Node:
	return EditorInterface.get_edited_scene_root()


func _tree_start(path: String) -> Node:
	return _resolve(path)


func _current_scene_label() -> String:
	var root: Node = _root()
	return root.scene_file_path if root != null else ""


func _display_path(node: Node) -> String:
	var root: Node = _root()
	if root == null or not (node == root or root.is_ancestor_of(node)):
		return str(node.get_path())
	return "." if node == root else str(root.get_path_to(node))


func _resolve(path: String) -> Node:
	var root: Node = _root()
	if root == null:
		return null
	return root if path == "" or path == "." else root.get_node_or_null(NodePath(path))


func _no_scene() -> Dictionary:
	return _error("NO_SCENE", "No scene is open in the editor.")


func _cmd_open_scene(params: Dictionary) -> Dictionary:
	var path: String = str(params.get("path", ""))
	if not path.get_extension() in SCENE_EXTENSIONS:
		return _error("INVALID_OPERATION", "'%s' is not a scene file (.tscn/.scn)." % path)
	var type: String = str(params.get("create_root_type", ""))
	if type != "":
		var problem: Dictionary = _create_scene(path, type, str(params.get("root_name", "")))
		if not problem.is_empty():
			return problem
	elif not ResourceLoader.exists(path):
		return _error("FILE_NOT_FOUND", "Scene '%s' does not exist." % path)
	EditorInterface.open_scene_from_path(path)
	await _host.get_tree().process_frame
	var root: Node = _root()
	if root == null or root.scene_file_path != path:
		return _error("INVALID_OPERATION", "The editor did not open '%s'." % path)
	return _ok(_scene_info())


## Writes a new scene with a single root node; returns {} or an error.
func _create_scene(path: String, type: String, root_name: String) -> Dictionary:
	if ResourceLoader.exists(path) or FileAccess.file_exists(path):
		return _error("FILE_EXISTS", "'%s' already exists." % path)
	if not _is_node_class(type):
		return _error("INVALID_TYPE", "'%s' is not an instantiable Node class." % type)
	var node: Node = ClassDB.instantiate(type)
	node.name = root_name if root_name != "" else path.get_file().get_basename().to_pascal_case()
	var packed: PackedScene = PackedScene.new()
	packed.pack(node)
	node.free()
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(path.get_base_dir()))
	var error: Error = ResourceSaver.save(packed, path)
	if error != OK:
		return _error("SAVE_FAILED", "Could not write '%s' (%s)." % [path, error_string(error)])
	EditorInterface.get_resource_filesystem().update_file(path)
	return {}


func _cmd_add_node(params: Dictionary) -> Dictionary:
	var root: Node = _root()
	if root == null:
		return _no_scene()
	var parent: Node = _resolve(str(params.get("parent", ".")))
	if parent == null:
		return _error("NODE_NOT_FOUND", "No node at '%s'." % params.get("parent", "."))
	var name: String = str(params.get("name", ""))
	var name_problem: String = _name_problem(name, parent, null)
	if name_problem != "":
		return _error("INVALID_NAME", name_problem)
	var made: Variant = _instantiate(params)
	if made is Dictionary:
		return made
	var node: Node = made
	node.name = name
	var parsed: Dictionary = {}
	var values: Dictionary = params.get("properties", {})
	for key: Variant in values:
		var problem: String = _parse_assignment(node, str(key), str(values[key]), parsed)
		if problem != "":
			node.free()
			return _error("INVALID_VALUE", problem)
	for key: Variant in parsed:
		node.set_indexed(NodePath(str(key)), parsed[key])
	var action: String = ACTION_PREFIX + "add " + name
	_undo_redo.create_action(action, UndoRedo.MERGE_DISABLE, root)
	_undo_redo.add_do_method(parent, "add_child", node, true)
	_undo_redo.add_do_method(node, "set_owner", root)
	_undo_redo.add_do_reference(node)
	_undo_redo.add_undo_method(parent, "remove_child", node)
	_undo_redo.commit_action()
	var changes: Array[String] = []
	for key: Variant in parsed:
		changes.append("%s = %s" % [key, _format(parsed[key])])
	return _edit_result(_display_path(node), action, changes)


## A new node from "type" or an instance of "scene"; an error Dictionary on failure.
func _instantiate(params: Dictionary) -> Variant:
	var scene: String = str(params.get("scene", ""))
	if scene != "":
		if not ResourceLoader.exists(scene):
			return _error("FILE_NOT_FOUND", "Scene '%s' does not exist." % scene)
		var packed: PackedScene = load(scene) as PackedScene
		if packed == null:
			return _error("INVALID_TYPE", "'%s' is not a scene." % scene)
		return packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	var type: String = str(params.get("type", ""))
	if not _is_node_class(type):
		return _error("INVALID_TYPE", "'%s' is not an instantiable Node class." % type)
	return ClassDB.instantiate(type)


func _cmd_remove_node(params: Dictionary) -> Dictionary:
	var root: Node = _root()
	if root == null:
		return _no_scene()
	var node: Node = _resolve(str(params.get("node", "")))
	if node == null:
		return _error("NODE_NOT_FOUND", "No node at '%s'." % params.get("node", ""))
	if node == root:
		return _error("INVALID_OPERATION", "The scene root cannot be removed.")
	var path: String = _display_path(node)
	var parent: Node = node.get_parent()
	var action: String = ACTION_PREFIX + "remove " + str(node.name)
	_undo_redo.create_action(action, UndoRedo.MERGE_DISABLE, root)
	_undo_redo.add_do_method(parent, "remove_child", node)
	_undo_redo.add_undo_method(parent, "add_child", node, true)
	_undo_redo.add_undo_method(parent, "move_child", node, node.get_index())
	# Restore ownership so the node is saved with the scene again after an undo.
	for owned: Node in _owned_subtree(node):
		_undo_redo.add_undo_method(owned, "set_owner", owned.owner)
	_undo_redo.add_undo_reference(node)
	_undo_redo.commit_action()
	return _edit_result(path, action, ["removed %s" % path])


func _owned_subtree(node: Node) -> Array[Node]:
	var nodes: Array[Node] = [node]
	for child: Node in node.get_children():
		nodes.append_array(_owned_subtree(child))
	return nodes.filter(func(n: Node) -> bool: return n.owner != null)


func _cmd_update_node(params: Dictionary) -> Dictionary:
	var root: Node = _root()
	if root == null:
		return _no_scene()
	var node: Node = _resolve(str(params.get("node", "")))
	if node == null:
		return _error("NODE_NOT_FOUND", "No node at '%s'." % params.get("node", ""))
	var plan: Array[Dictionary] = []
	var problem: Dictionary = _plan_update(node, root, params, plan)
	if not problem.is_empty():
		return problem
	if plan.is_empty():
		return _error(
			"BAD_PARAMS", "Nothing to update: pass properties, rename, reparent or script."
		)
	var action: String = ACTION_PREFIX + "update " + str(node.name)
	_undo_redo.create_action(action, UndoRedo.MERGE_DISABLE, root)
	var changes: Array[String] = []
	for step: Dictionary in plan:
		for call: Array in step["do"]:
			_undo_redo.callv("add_do_method", call)
		for call: Array in step["undo"]:
			_undo_redo.callv("add_undo_method", call)
		changes.append(step["change"])
	_undo_redo.commit_action()
	return _edit_result(_display_path(node), action, changes)


## Validates every requested change and fills `plan` with do/undo calls; returns {} or an error.
func _plan_update(
	node: Node, root: Node, params: Dictionary, plan: Array[Dictionary]
) -> Dictionary:
	if params.has("script"):
		var script_step: Dictionary = _plan_script(node, str(params["script"]))
		if script_step.has("error"):
			return script_step
		plan.append(script_step)
	var parsed: Dictionary = {}
	var values: Dictionary = params.get("properties", {})
	for key: Variant in values:
		var problem: String = _parse_assignment(node, str(key), str(values[key]), parsed)
		if problem != "":
			return _error("INVALID_VALUE", problem)
	for key: Variant in parsed:
		var path: NodePath = NodePath(str(key))
		(
			plan
			. append(
				{
					"do": [[node, "set_indexed", path, parsed[key]]],
					"undo": [[node, "set_indexed", path, node.get_indexed(path)]],
					"change": "%s = %s" % [key, _format(parsed[key])],
				}
			)
		)
	if params.has("rename"):
		var name: String = str(params["rename"])
		var name_problem: String = _name_problem(name, node.get_parent(), node)
		if name_problem != "":
			return _error("INVALID_NAME", name_problem)
		(
			plan
			. append(
				{
					"do": [[node, "set_name", name]],
					"undo": [[node, "set_name", node.name]],
					"change": "renamed %s → %s" % [node.name, name],
				}
			)
		)
	if params.has("reparent"):
		var step: Dictionary = _plan_reparent(node, root, str(params["reparent"]))
		if step.has("error"):
			return step
		plan.append(step)
	return {}


func _plan_script(node: Node, path: String) -> Dictionary:
	var old: Variant = node.get_script()
	if path == "":
		return {
			"do": [[node, "set_script", null]],
			"undo": [[node, "set_script", old]],
			"change": "script detached"
		}
	if not ResourceLoader.exists(path):
		return _error("FILE_NOT_FOUND", "Script '%s' does not exist." % path)
	var script: Script = load(path) as Script
	if script == null:
		return _error("INVALID_TYPE", "'%s' is not a script." % path)
	var base: String = script.get_instance_base_type()
	if base != "" and not ClassDB.is_parent_class(node.get_class(), base):
		return _error(
			"INVALID_TYPE",
			"%s extends %s; it can't be attached to a %s." % [path, base, node.get_class()]
		)
	return {
		"do": [[node, "set_script", script]],
		"undo": [[node, "set_script", old]],
		"change": "script = %s" % path
	}


func _plan_reparent(node: Node, root: Node, target_path: String) -> Dictionary:
	var target: Node = _resolve(target_path)
	if target == null:
		return _error("NODE_NOT_FOUND", "No node at '%s'." % target_path)
	if node == root:
		return _error("INVALID_OPERATION", "The scene root cannot be reparented.")
	if target == node or node.is_ancestor_of(target):
		return _error("INVALID_OPERATION", "A node cannot be moved under itself.")
	var name_problem: String = _name_problem(str(node.name), target, node)
	if name_problem != "":
		return _error("INVALID_NAME", name_problem)
	var parent: Node = node.get_parent()
	return {
		"do": [[node, "reparent", target]],
		"undo": [[node, "reparent", parent], [parent, "move_child", node, node.get_index()]],
		"change": "moved under %s" % _display_path(target),
	}


func _cmd_save_scene(params: Dictionary) -> Dictionary:
	var root: Node = _root()
	if root == null:
		return _no_scene()
	var path: String = str(params.get("path", ""))
	if path != "":
		if not path.get_extension() in SCENE_EXTENSIONS:
			return _error("INVALID_OPERATION", "'%s' is not a scene file (.tscn/.scn)." % path)
		EditorInterface.save_scene_as(path, false)
	elif root.scene_file_path == "":
		return _error("SAVE_FAILED", "This scene has never been saved; pass a path.")
	else:
		var error: Error = EditorInterface.save_scene()
		if error != OK:
			return _error("SAVE_FAILED", "Saving failed (%s)." % error_string(error))
	_unsaved.erase(root.scene_file_path)
	return _ok(_scene_info())


func _cmd_undo(_params: Dictionary) -> Dictionary:
	return _step_history(true)


func _cmd_redo(_params: Dictionary) -> Dictionary:
	return _step_history(false)


func _step_history(undo: bool) -> Dictionary:
	var root: Node = _root()
	if root == null:
		return _no_scene()
	var history: UndoRedo = _undo_redo.get_history_undo_redo(_undo_redo.get_object_history_id(root))
	# The current action is the one an undo would revert; after a redo it's the one redone.
	var name: String = history.get_current_action_name() if undo else ""
	var done: bool = history.undo() if undo else history.redo()
	if not done:
		return _error("INVALID_OPERATION", "Nothing to %s." % ("undo" if undo else "redo"))
	if not undo:
		name = history.get_current_action_name()
	return _ok(_scene_info().merged({"action": name}))


func _edit_result(path: String, action: String, changes: Array[String]) -> Dictionary:
	_unsaved[_root().scene_file_path] = true
	return _ok(_scene_info().merged({"node": path, "action": action, "changes": changes}))


func _scene_info() -> Dictionary:
	var root: Node = _root()
	return {
		"scene": root.scene_file_path,
		"root": str(root.name),
		"class": root.get_class(),
		"nodes": _count(root),
		"unsaved": _unsaved.has(root.scene_file_path),
	}


func _count(node: Node) -> int:
	var total: int = 1
	for child: Node in node.get_children():
		total += _count(child)
	return total


## "" when `name` is a valid, unique child name under `parent` (ignoring `node` itself).
func _name_problem(name: String, parent: Node, node: Node) -> String:
	if name.strip_edges() == "":
		return "The name is empty."
	for character: String in INVALID_NAME_CHARS:
		if name.contains(character):
			return "'%s' contains '%s', which node names cannot use." % [name, character]
	var existing: Node = parent.get_node_or_null(NodePath(name))
	if existing != null and existing != node:
		return "%s already has a child named '%s'." % [_display_path(parent), name]
	return ""


func _is_node_class(type: String) -> bool:
	return (
		ClassDB.class_exists(type)
		and ClassDB.can_instantiate(type)
		and (type == "Node" or ClassDB.is_parent_class(type, "Node"))
	)
