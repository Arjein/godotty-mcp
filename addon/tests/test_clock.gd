extends GutTest
## Tests freezing and stepping the game. Every test leaves the tree unpaused: GUT itself stops
## while the SceneTree is paused, so nothing here awaits GUT while frozen.

const GodottyClock = preload("res://addons/godotty_mcp/runtime/godotty_clock.gd")
const GodottyCommands = preload("res://addons/godotty_mcp/runtime/godotty_commands.gd")


## Counts the physics frames it was processed in (pausable, like game nodes).
class Ticker:
	extends Node
	var ticks: int = 0

	func _physics_process(_delta: float) -> void:
		ticks += 1


var _host: Node
var _clock: GodottyClock


func before_each() -> void:
	_host = Node.new()
	add_child_autofree(_host)
	_clock = GodottyClock.new(_host)


func after_each() -> void:
	get_tree().paused = false
	Engine.time_scale = 1.0


func test_freeze_and_resume_restore_the_games_own_pause() -> void:
	_clock.freeze()
	assert_true(get_tree().paused)
	assert_true(_clock.is_frozen())
	_clock.resume()
	assert_false(get_tree().paused)
	get_tree().paused = true
	_clock.freeze()
	assert_true(_clock.is_game_paused(), "the game had paused itself")
	_clock.resume()
	assert_true(get_tree().paused, "resume keeps the game's own pause")


func test_commands_run_the_frozen_game_and_freeze_it_again() -> void:
	_clock.freeze()
	_clock.begin()
	assert_false(get_tree().paused, "runs while a command works")
	_clock.begin()
	_clock.end()
	assert_false(get_tree().paused, "still running while another command works")
	_clock.end()
	assert_true(get_tree().paused)
	_clock.resume()


func test_step_runs_exactly_the_requested_physics_frames_then_freezes() -> void:
	var ticker: Ticker = Ticker.new()
	add_child_autofree(ticker)
	await wait_physics_frames(1)
	_clock.freeze()
	var before: int = ticker.ticks
	await _clock.step(5)
	var stepped: int = ticker.ticks - before
	var frozen: bool = get_tree().paused
	_clock.resume()
	assert_eq(stepped, 5, "game nodes ran exactly 5 physics frames")
	assert_true(frozen, "the game is frozen after a step")


func test_step_freezes_a_running_game() -> void:
	await _clock.step(1)
	var frozen: bool = get_tree().paused and _clock.is_frozen()
	_clock.resume()
	assert_true(frozen)


func test_pause_command_reports_state_and_time_scale() -> void:
	var commands: GodottyCommands = GodottyCommands.new(_host)
	var paused: Dictionary = await commands.run("pause", {"paused": true, "time_scale": 0.5})
	var running: Dictionary = await commands.run("pause", {"paused": false})
	assert_true(paused["result"]["paused"])
	assert_eq(paused["result"]["time_scale"], 0.5)
	assert_false(running["result"]["paused"])
	assert_false(get_tree().paused)


func test_input_runs_a_frozen_game_for_its_duration() -> void:
	var commands: GodottyCommands = GodottyCommands.new(_host)
	var ticker: Ticker = Ticker.new()
	add_child_autofree(ticker)
	commands.freeze()
	var outcome: Dictionary = await commands.run(
		"input", {"steps": [{"type": "wait", "frames": 3}]}
	)
	var frozen_after: bool = get_tree().paused
	await commands.run("pause", {"paused": false})
	assert_true(outcome.has("result"))
	assert_gt(ticker.ticks, 0, "the game ran during the input batch")
	assert_true(frozen_after, "and was frozen again afterwards")
