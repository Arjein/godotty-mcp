class_name Player
extends CharacterBody3D
## Demo player: walks on the XZ plane with the move_* actions and jumps with "jump".

const SPEED: float = 5.0
const JUMP_VELOCITY: float = 4.5


func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity += get_gravity() * delta
	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = JUMP_VELOCITY
	var input_dir: Vector2 = Input.get_vector(
		"move_left", "move_right", "move_forward", "move_back"
	)
	velocity.x = input_dir.x * SPEED
	velocity.z = input_dir.y * SPEED
	move_and_slide()
