extends GutTest
## Tests input simulation; relies on the demo project's move_right action (D key).

const GodottyInput = preload("res://addons/godotty_mcp/runtime/godotty_input.gd")
const HOLD_MS: int = 200

var _input: GodottyInput


func before_each() -> void:
	var host: Node = Node.new()
	add_child_autofree(host)
	_input = GodottyInput.new(host)


func after_each() -> void:
	Input.action_release("move_right")


## Parsed input events reach Input state on the next frame.
func _flush() -> void:
	await wait_process_frames(1)


func test_validate_rejects_bad_steps_up_front() -> void:
	assert_string_starts_with(
		_input.validate([{"type": "action", "action": "fly"}]), "UNKNOWN_ACTION|"
	)
	assert_string_starts_with(_input.validate([{"type": "key", "key": "NotAKey"}]), "UNKNOWN_KEY|")
	assert_string_starts_with(_input.validate([{"type": "teleport"}]), "BAD_PARAMS|")
	assert_string_starts_with(_input.validate(["not a step"]), "BAD_PARAMS|")
	var button: Dictionary = {"type": "mouse_button", "button": "thumb"}
	assert_string_starts_with(_input.validate([button]), "BAD_PARAMS|")
	assert_eq(_input.validate([{"type": "action", "action": "move_right"}, {"type": "wait"}]), "")


func test_action_press_and_release() -> void:
	await _input.perform({"type": "action", "action": "move_right", "mode": "press"})
	await _flush()
	assert_true(Input.is_action_pressed("move_right"))
	await _input.perform({"type": "action", "action": "move_right", "mode": "release"})
	await _flush()
	assert_false(Input.is_action_pressed("move_right"))


func test_key_events_trigger_bound_actions() -> void:
	await _input.perform({"type": "key", "key": "D", "mode": "press"})
	await _flush()
	assert_true(Input.is_action_pressed("move_right"), "D is bound to move_right")
	await _input.perform({"type": "key", "key": "D", "mode": "release"})
	await _flush()
	assert_false(Input.is_action_pressed("move_right"))


func test_hold_lasts_about_the_requested_time() -> void:
	var start: int = Time.get_ticks_msec()
	var step: Dictionary = {
		"type": "action", "action": "move_right", "mode": "hold", "duration_ms": HOLD_MS
	}
	await _input.perform(step)
	await _flush()
	assert_gte(Time.get_ticks_msec() - start, HOLD_MS - 20)
	assert_false(Input.is_action_pressed("move_right"), "released after the hold")


func test_hold_survives_input_released_by_a_focus_change() -> void:
	# Godot releases every pressed input when the game window gains or loses focus.
	var held: Array[bool] = [false]
	var step: Dictionary = {
		"type": "action", "action": "move_right", "mode": "hold", "duration_ms": HOLD_MS
	}
	var check: Callable = func() -> void:
		await wait_seconds(HOLD_MS / 4000.0)
		Input.action_release("move_right")
		await wait_seconds(HOLD_MS / 2000.0)
		held[0] = Input.is_action_pressed("move_right")
	check.call()
	await _input.perform(step)
	assert_true(held[0], "the hold is pressed again after an outside release")


func test_tap_presses_then_releases() -> void:
	await _input.perform({"type": "action", "action": "move_right"})
	await _flush()
	assert_false(Input.is_action_pressed("move_right"))


func test_mouse_motion_tracks_position() -> void:
	await _input.perform({"type": "mouse_motion", "position": [10, 20]})
	assert_eq(_input._mouse, Vector2(10, 20))
	await _input.perform({"type": "wait", "frames": 1})
	await _input.perform({"type": "wait", "ms": 10})
