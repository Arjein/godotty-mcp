extends GutTest
## GUT tests for the demo player.
## Install GUT first: scripts/fetch-test-addons.sh gut examples/demo-project

const PlayerScene: PackedScene = preload("res://scenes/player.tscn")
const SETTLE_FRAMES: int = 10

var _player: CharacterBody3D


func before_each() -> void:
	_player = PlayerScene.instantiate()
	add_child_autofree(_player)


func after_each() -> void:
	Input.action_release("move_right")


func test_falls_when_airborne() -> void:
	await wait_physics_frames(SETTLE_FRAMES)
	assert_lt(_player.velocity.y, 0.0, "gravity pulls an airborne player down")


func test_moves_right_with_input() -> void:
	Input.action_press("move_right")
	await wait_physics_frames(SETTLE_FRAMES)
	assert_almost_eq(_player.velocity.x, Player.SPEED, 0.01, "full speed to the right")
	assert_gt(_player.position.x, 0.0, "position moved right")


func test_stands_still_without_input() -> void:
	await wait_physics_frames(SETTLE_FRAMES)
	assert_eq(_player.velocity.x, 0.0, "no horizontal movement without input")
