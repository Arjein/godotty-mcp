extends RefCounted
## Simulates player input for the godotty-mcp `input` command.
##
## Events go through Input.parse_input_event, so they reach _input/_unhandled_input handlers and
## update Input.is_action_pressed() exactly like real devices (verified on Godot 4.5 and 4.7).

## Frames between press and release for a "tap", so is_action_just_pressed() sees it.
const TAP_PHYSICS_FRAMES: int = 2
const DEFAULT_HOLD_MS: int = 500
const MS_PER_SECOND: float = 1000.0
const MOUSE_BUTTONS: Dictionary = {
	"left": MOUSE_BUTTON_LEFT,
	"right": MOUSE_BUTTON_RIGHT,
	"middle": MOUSE_BUTTON_MIDDLE,
	"wheel_up": MOUSE_BUTTON_WHEEL_UP,
	"wheel_down": MOUSE_BUTTON_WHEEL_DOWN,
}

var _host: Node
var _mouse: Vector2 = Vector2.ZERO


func _init(host: Node) -> void:
	_host = host


## Checks every step before anything is sent, so a typo doesn't leave keys held down.
## Returns "" when valid, else a message prefixed with an error code and "|".
func validate(steps: Array) -> String:
	for step: Variant in steps:
		if not step is Dictionary:
			return "BAD_PARAMS|Each step must be an object."
		var data: Dictionary = step
		match str(data.get("type", "")):
			"action":
				if not InputMap.has_action(str(data.get("action", ""))):
					return "UNKNOWN_ACTION|No input action named '%s'." % data.get("action", "")
			"key":
				if OS.find_keycode_from_string(str(data.get("key", ""))) == KEY_NONE:
					return "UNKNOWN_KEY|Unknown key '%s'." % data.get("key", "")
			"mouse_button":
				if not MOUSE_BUTTONS.has(str(data.get("button", ""))):
					return "BAD_PARAMS|Unknown mouse button '%s'." % data.get("button", "")
			"mouse_motion", "wait":
				pass
			_:
				return "BAD_PARAMS|Unknown step type '%s'." % data.get("type", "")
	return ""


## Performs one validated step, awaiting holds and waits.
func perform(step: Dictionary) -> void:
	match str(step["type"]):
		"action":
			await _press_release(step, _action_event.bind(step))
		"key":
			await _press_release(step, _key_event.bind(step))
		"mouse_button":
			_move_mouse(_vec(step.get("position", [0, 0])))
			await _press_release(step, _mouse_button_event.bind(step))
		"mouse_motion":
			_move_mouse(_vec(step.get("position", [0, 0])))
		"wait":
			await _wait(step)


## press / release / tap / hold, using `make_event(pressed)` to build each event.
func _press_release(step: Dictionary, make_event: Callable) -> void:
	var mode: String = str(step.get("mode", "tap"))
	if mode != "release":
		Input.parse_input_event(make_event.call(true))
	if mode == "tap":
		var frames: int = TAP_PHYSICS_FRAMES
		for i: int in frames:
			await _host.get_tree().physics_frame
	elif mode == "hold":
		await _sleep_ms(int(step.get("duration_ms", DEFAULT_HOLD_MS)))
	if mode != "press":
		Input.parse_input_event(make_event.call(false))


func _action_event(pressed: bool, step: Dictionary) -> InputEvent:
	var event: InputEventAction = InputEventAction.new()
	event.action = StringName(str(step["action"]))
	event.pressed = pressed
	event.strength = float(step.get("strength", 1.0)) if pressed else 0.0
	return event


func _key_event(pressed: bool, step: Dictionary) -> InputEvent:
	var keycode: Key = OS.find_keycode_from_string(str(step["key"]))
	var event: InputEventKey = InputEventKey.new()
	event.keycode = keycode
	event.physical_keycode = keycode
	event.key_label = keycode
	event.pressed = pressed
	event.shift_pressed = bool(step.get("shift", false))
	event.ctrl_pressed = bool(step.get("ctrl", false))
	event.alt_pressed = bool(step.get("alt", false))
	event.meta_pressed = bool(step.get("meta", false))
	var text: String = str(step["key"])
	if pressed and text.length() == 1:
		event.unicode = (text if event.shift_pressed else text.to_lower()).unicode_at(0)
	return event


func _mouse_button_event(pressed: bool, step: Dictionary) -> InputEvent:
	var event: InputEventMouseButton = InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTONS[str(step["button"])]
	event.pressed = pressed
	event.position = _mouse
	event.global_position = _mouse
	event.double_click = pressed and bool(step.get("double_click", false))
	return event


func _move_mouse(target: Vector2) -> void:
	var event: InputEventMouseMotion = InputEventMouseMotion.new()
	event.position = target
	event.global_position = target
	event.relative = target - _mouse
	_mouse = target
	Input.parse_input_event(event)


func _wait(step: Dictionary) -> void:
	if step.has("frames"):
		var target: int = Engine.get_process_frames() + int(step["frames"])
		while Engine.get_process_frames() < target:
			await _host.get_tree().process_frame
	else:
		await _sleep_ms(int(step.get("ms", 0)))


func _sleep_ms(ms: int) -> void:
	if ms <= 0:
		return
	# Process even while paused and ignore Engine.time_scale: waits are wall-clock.
	await _host.get_tree().create_timer(ms / MS_PER_SECOND, true, false, true).timeout


func _vec(value: Variant) -> Vector2:
	if value is Array and (value as Array).size() >= 2:
		return Vector2(float(value[0]), float(value[1]))
	return Vector2.ZERO
