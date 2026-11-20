@tool
extends RefCounted
## Freezes the running game between agent calls (pause_game / step_game in godotty-mcp).
##
## Freezing pauses the SceneTree, which also stops physics; the game's own PROCESS_MODE_ALWAYS
## nodes keep running. While frozen, commands that play the game (input, wait, press) wrap their
## work in `begin()` / `end()`: the tree runs while they do and freezes again afterwards. A pause
## the game made itself (its pause menu) is remembered and kept while advancing and on resume.

var _host: Node
var _frozen: bool = false
## Whether the game itself had the tree paused; restored on resume.
var _game_paused: bool = false
var _advancing: int = 0


func _init(host: Node) -> void:
	_host = host


## True while godotty holds the game frozen.
func is_frozen() -> bool:
	return _frozen


## Whether the game paused itself (its own pause menu), independent of godotty's freeze.
func is_game_paused() -> bool:
	return _game_paused if _frozen and _advancing == 0 else _host.get_tree().paused


## Freezes the game now; a no-op when already frozen.
func freeze() -> void:
	if _frozen:
		return
	var tree: SceneTree = _host.get_tree()
	_game_paused = tree.paused
	_frozen = true
	if _advancing == 0:
		tree.paused = true


## Lets the game run in real time again, restoring the game's own pause state.
func resume() -> void:
	if not _frozen:
		return
	_frozen = false
	if _advancing == 0:
		_host.get_tree().paused = _game_paused


## A command that plays the game starts: run the tree while it works.
func begin() -> void:
	_advancing += 1
	if _frozen and _advancing == 1:
		_host.get_tree().paused = _game_paused


## A command that plays the game finished: freeze again once none is left.
func end() -> void:
	_advancing = maxi(0, _advancing - 1)
	if _frozen and _advancing == 0:
		var tree: SceneTree = _host.get_tree()
		_game_paused = tree.paused
		tree.paused = true


## Runs exactly `frames` physics frames, then leaves the game frozen.
func step(frames: int) -> void:
	begin()
	var target: int = Engine.get_physics_frames() + frames
	while Engine.get_physics_frames() < target:
		await _host.get_tree().physics_frame
	freeze()
	end()
