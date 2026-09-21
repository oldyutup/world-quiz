export interface MovementInput {
  x: number;
  z: number;
  jump: boolean;
}

const MOVEMENT_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight", "Space"]);

/** Arena-only input. Nothing is registered until the scene mounts. */
export function bindKeyboard() {
  const pressed = new Set<string>();
  const input: MovementInput = { x: 0, z: 0, jump: false };

  function updateAxes() {
    input.x = Number(pressed.has("KeyD") || pressed.has("ArrowRight")) - Number(pressed.has("KeyA") || pressed.has("ArrowLeft"));
    input.z = Number(pressed.has("KeyS") || pressed.has("ArrowDown")) - Number(pressed.has("KeyW") || pressed.has("ArrowUp"));
  }

  function clear() {
    pressed.clear();
    input.x = input.z = 0;
    input.jump = false;
  }

  function keyDown(event: KeyboardEvent) {
    if (!MOVEMENT_KEYS.has(event.code) || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, select, button, a, [contenteditable]")) return;
    event.preventDefault();
    if (event.code === "Space" && !event.repeat && !pressed.has("Space")) input.jump = true;
    pressed.add(event.code);
    updateAxes();
  }

  function keyUp(event: KeyboardEvent) {
    pressed.delete(event.code);
    updateAxes();
  }

  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", clear);
  // Releasing gameplay keys on HUD focus keeps keyboard navigation safe.
  document.addEventListener("focusin", clear);

  return {
    input,
    clear,
    dispose() {
      clear();
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
      document.removeEventListener("focusin", clear);
    },
  };
}
