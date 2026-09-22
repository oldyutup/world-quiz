import type { Bindings } from "./bindings";
export const defaultBindings = (): Bindings => ({
  moveForward: ["KeyW", "ArrowUp"],
  moveBackward: ["KeyS", "ArrowDown"],
  moveLeft: ["KeyA", "ArrowLeft"],
  moveRight: ["KeyD", "ArrowRight"],
  jump: ["Space", null],
  punch: ["KeyF", "MouseLeft"],
  grab: ["KeyE", "MouseRight"],
  lift: ["ShiftLeft", "ShiftRight"],
});
