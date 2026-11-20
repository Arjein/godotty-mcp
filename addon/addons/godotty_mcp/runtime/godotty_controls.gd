@tool
extends RefCounted
## Finds and presses UI controls for list_controls / press_control in godotty-mcp.
##
## A click is pushed into the control's own viewport at its centre, in viewport coordinates, so it
## lands regardless of window size, stretch mode or SubViewports, and goes through the normal GUI
## input path (gui_input, focus, pressed). Headless runs drop mouse input, so clicks are refused
## there. "accept" focuses the control and taps ui_accept through Input, like a keyboard or gamepad.

const MAX_TEXT_CHARS: int = 60
const ACCEPT_ACTION: StringName = &"ui_accept"
## Frames between press and release, and after the release so handlers (scene changes) run.
const SETTLE_FRAMES: int = 2

var _host: Node


func _init(host: Node) -> void:
	_host = host


## Visible interactive controls under `start` (buttons and anything that takes focus).
func collect(start: Node) -> Array[Control]:
	var found: Array[Control] = []
	_collect(start, found)
	return found


func _collect(node: Node, found: Array[Control]) -> void:
	if node is CanvasItem and not (node as CanvasItem).visible:
		return
	if node is CanvasLayer and not (node as CanvasLayer).visible:
		return
	if node is Control and _is_interactive(node) and (node as Control).is_visible_in_tree():
		found.append(node)
	for child: Node in node.get_children():
		_collect(child, found)


func _is_interactive(control: Control) -> bool:
	return control is BaseButton or control.focus_mode != Control.FOCUS_NONE


## Controls under `start` whose text is `text` (case-insensitive), else those containing it.
func find_by_text(start: Node, text: String) -> Array[Control]:
	var wanted: String = text.strip_edges().to_lower()
	var controls: Array[Control] = collect(start)
	var exact: Array[Control] = controls.filter(
		func(c: Control) -> bool: return label(c).strip_edges().to_lower() == wanted
	)
	if not exact.is_empty():
		return exact
	return controls.filter(func(c: Control) -> bool: return label(c).to_lower().contains(wanted))


## The text a player sees on the control (or its tooltip when it has no text).
func label(control: Control) -> String:
	var text: Variant = control.get("text")
	if text is String and text != "":
		return text
	return control.tooltip_text


## One control as list_controls shows it; rect is in its viewport's pixels.
func describe(control: Control, display_path: String) -> Dictionary:
	var transform: Transform2D = control.get_global_transform_with_canvas()
	var top_left: Vector2 = transform * Vector2.ZERO
	var bottom_right: Vector2 = transform * control.size
	var text: String = label(control)
	return {
		"path": display_path,
		"class": control.get_class(),
		"text": text if text.length() <= MAX_TEXT_CHARS else text.left(MAX_TEXT_CHARS - 1) + "…",
		"rect":
		[
			roundi(top_left.x),
			roundi(top_left.y),
			roundi(bottom_right.x - top_left.x),
			roundi(bottom_right.y - top_left.y)
		],
		"focused": control.has_focus(),
		"disabled": control is BaseButton and (control as BaseButton).disabled,
	}


## "" when `control` can be pressed with `action`, else why not.
func problem(control: Control, action: String) -> String:
	if not control.is_visible_in_tree():
		return "%s is not visible." % control.name
	if control is BaseButton and (control as BaseButton).disabled:
		return "%s is disabled." % control.name
	if action != "click" and control.focus_mode == Control.FOCUS_NONE:
		return "%s cannot take focus (focus_mode is None); use action=click." % control.name
	if action == "click" and DisplayServer.get_name() == "headless":
		return "Mouse clicks need a window (this game runs headless); use action=accept."
	if action == "accept" and not InputMap.has_action(ACCEPT_ACTION):
		return "The project has no ui_accept action; use action=click."
	return ""


## Clicks, focuses or accepts `control`; reports whether a button emitted `pressed`.
func press(control: Control, action: String) -> Dictionary:
	var fired: Array[bool] = [false]
	var on_pressed: Callable = func() -> void: fired[0] = true
	var button: BaseButton = control as BaseButton
	if button != null:
		button.pressed.connect(on_pressed)
	match action:
		"focus":
			control.grab_focus()
		"accept":
			control.grab_focus()
			await _tap_accept()
		_:
			await _click(control)
	if button != null and is_instance_valid(button) and button.pressed.is_connected(on_pressed):
		button.pressed.disconnect(on_pressed)
	return {"pressed": fired[0]} if button != null else {}


func _click(control: Control) -> void:
	var viewport: Viewport = control.get_viewport()
	var centre: Vector2 = control.get_global_transform_with_canvas() * (control.size / 2.0)
	# Press and release in the same frame, each right after a motion to the centre: a real mouse
	# moving over the window in between would otherwise make the button see the press leave it.
	for pressed: bool in [true, false]:
		var motion: InputEventMouseMotion = InputEventMouseMotion.new()
		motion.position = centre
		motion.global_position = centre
		motion.button_mask = MOUSE_BUTTON_MASK_LEFT if not pressed else 0
		viewport.push_input(motion, true)
		var event: InputEventMouseButton = InputEventMouseButton.new()
		event.button_index = MOUSE_BUTTON_LEFT
		event.button_mask = MOUSE_BUTTON_MASK_LEFT if pressed else 0
		event.pressed = pressed
		event.position = centre
		event.global_position = centre
		viewport.push_input(event, true)
	await _frames(SETTLE_FRAMES)


func _tap_accept() -> void:
	for pressed: bool in [true, false]:
		var event: InputEventAction = InputEventAction.new()
		event.action = ACCEPT_ACTION
		event.pressed = pressed
		event.strength = 1.0 if pressed else 0.0
		Input.parse_input_event(event)
		await _frames(SETTLE_FRAMES)


func _frames(count: int) -> void:
	var target: int = Engine.get_process_frames() + count
	while Engine.get_process_frames() < target:
		await _host.get_tree().process_frame
