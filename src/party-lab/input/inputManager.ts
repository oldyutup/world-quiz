import { ACTIONS, type Action, type ActionIntent } from "./actions";
import type { Binding, Bindings } from "./bindings";
import { defaultBindings } from "./defaults";

/** OR all bindings before detecting edges, so overlapping aliases never double-fire. */
export class InputManager {
  private held = new Set<Binding>();
  private pressed = new Set<Action>();
  private released = new Set<Action>();
  private suspended = false;
  constructor(public bindings: Bindings = defaultBindings()) {}
  isActionDown = (action: Action) =>
    this.bindings[action].some(
      (binding) => binding !== null && this.held.has(binding)
    );
  wasActionPressed = (action: Action) => this.pressed.has(action);
  wasActionReleased = (action: Action) => this.released.has(action);
  setBindingDown(binding: Binding, down: boolean) {
    if (this.suspended) return;
    const before = ACTIONS.map(this.isActionDown);
    if (down) this.held.add(binding);
    else this.held.delete(binding);
    ACTIONS.forEach((action, index) => {
      const after = this.isActionDown(action);
      if (after && !before[index]) this.pressed.add(action);
      if (!after && before[index]) this.released.add(action);
    });
  }
  getMovementVector() {
    const x =
      Number(this.isActionDown("moveRight")) -
      Number(this.isActionDown("moveLeft"));
    const z =
      Number(this.isActionDown("moveBackward")) -
      Number(this.isActionDown("moveForward"));
    const scale = Math.max(1, Math.hypot(x, z));
    return { x: x / scale, z: z / scale };
  }
  readIntent(): ActionIntent {
    const intent = {
      ...this.getMovementVector(),
      jump: this.wasActionPressed("jump"),
      punch: this.wasActionPressed("punch"),
      grab: this.isActionDown("grab"),
      lift: this.isActionDown("lift"),
    };
    this.pressed.clear();
    this.released.clear();
    return intent;
  }
  clear() {
    this.held.clear();
    this.pressed.clear();
    this.released.clear();
  }
  setSuspended(value: boolean) {
    this.suspended = value;
    this.clear();
  }
  setBindings(bindings: Bindings) {
    this.bindings = bindings;
    this.clear();
  }
}
