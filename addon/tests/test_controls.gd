extends GutTest
## Tests finding and pressing UI controls (list_controls / press_control).

const GodottyCommands = preload("res://addons/godotty_mcp/runtime/godotty_commands.gd")
## Above GUT's own GUI, so clicks land on these buttons.
const LAYER: int = 100
const OFFSET: Vector2 = Vector2(100, 50)
const BUTTON_SIZE: Vector2 = Vector2(200, 40)

var _commands: GodottyCommands
var _menu: VBoxContainer
var _start: Button
var _options: Button
var _quit: Button
var _presses: Dictionary = {}


func before_each() -> void:
	var host: Node = Node.new()
	add_child_autofree(host)
	_commands = GodottyCommands.new(host)
	var layer: CanvasLayer = CanvasLayer.new()
	layer.layer = LAYER
	layer.offset = OFFSET
	add_child_autofree(layer)
	_menu = VBoxContainer.new()
	_menu.name = "Menu"
	layer.add_child(_menu)
	_presses = {}
	_start = _button("Godotty Start")
	_options = _button("Godotty Options")
	_quit = _button("Godotty Quit")
	_quit.disabled = true
	_button("Godotty Hidden").visible = false
	_menu.add_child(Label.new())
	await wait_process_frames(2)


func _button(text: String) -> Button:
	var button: Button = Button.new()
	button.name = text.replace(" ", "")
	button.text = text
	button.custom_minimum_size = BUTTON_SIZE
	button.pressed.connect(func() -> void: _presses[text] = int(_presses.get(text, 0)) + 1)
	_menu.add_child(button)
	return button


func _run(method: String, params: Dictionary) -> Dictionary:
	return await _commands.run(method, params)


func test_lists_visible_interactive_controls_with_viewport_rects() -> void:
	var result: Dictionary = await _run("controls", {"path": str(_menu.get_path()), "max": 50})
	var listed: Array = result["result"]["controls"]
	var texts: Array = listed.map(func(c: Dictionary) -> String: return c["text"])
	assert_eq(texts, ["Godotty Start", "Godotty Options", "Godotty Quit"], "no hidden, no labels")
	assert_eq(listed[0]["rect"], [100, 50, 200, 40], "rect includes the CanvasLayer offset")
	assert_true(listed[2]["disabled"])


func test_click_by_text_presses_the_button() -> void:
	if DisplayServer.get_name() == "headless":
		var refused: Dictionary = await _run("press", {"text": "godotty start", "action": "click"})
		assert_eq(refused["error"]["code"], "CONTROL_UNAVAILABLE", "headless drops mouse input")
		return
	var outcome: Dictionary = await _run("press", {"text": "godotty start", "action": "click"})
	assert_true(outcome["result"]["pressed"], str(outcome))
	assert_eq(_presses.get("Godotty Start", 0), 1)


func test_accept_focuses_and_presses_through_ui_accept() -> void:
	var path: String = str(_options.get_path())
	var outcome: Dictionary = await _run("press", {"path": path, "action": "accept"})
	assert_true(outcome["result"]["pressed"], str(outcome))
	assert_eq(_presses.get("Godotty Options", 0), 1)
	assert_true(_options.has_focus())


func test_substring_matches_and_ambiguity() -> void:
	var outcome: Dictionary = await _run("press", {"text": "options", "action": "focus"})
	assert_true(_options.has_focus(), str(outcome))
	var ambiguous: Dictionary = await _run("press", {"text": "godotty", "action": "click"})
	assert_eq(ambiguous["error"]["code"], "AMBIGUOUS")
	assert_string_contains(ambiguous["error"]["message"], "GodottyStart")
	assert_eq(_presses, {}, "nothing was pressed")


func test_unavailable_and_missing_controls_are_errors() -> void:
	var disabled: Dictionary = await _run("press", {"text": "Godotty Quit", "action": "click"})
	assert_eq(disabled["error"]["code"], "CONTROL_UNAVAILABLE")
	var missing: Dictionary = await _run("press", {"text": "Godotty Nope", "action": "click"})
	assert_eq(missing["error"]["code"], "NODE_NOT_FOUND")
	assert_string_contains(missing["error"]["message"], '"Godotty Start"')
	var hidden: Dictionary = await _run("press", {"text": "Godotty Hidden", "action": "click"})
	assert_eq(hidden["error"]["code"], "NODE_NOT_FOUND", "hidden controls are not found by text")
	var not_control: Dictionary = await _run("press", {"path": "/root", "action": "click"})
	assert_eq(not_control["error"]["code"], "NODE_NOT_FOUND")
