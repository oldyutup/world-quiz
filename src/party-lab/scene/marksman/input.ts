import { bindingLabel, type Bindings } from "../../input/bindings";
import { isUIInput, keyboardBinding } from "../../input/device";
import type { ClickPresses } from "../clickrace/input";

const keysOf = (slots: readonly (string | null)[], fallback: string) => {
  const keys = slots.filter((binding): binding is string => !!binding && !binding.startsWith("Mouse"));
  return new Set(keys.length ? keys : [fallback]);
};
/** What fires: the player's Jump keys (Space by default). Mouse buttons do not (a click only focuses). */
export const fireBindings = (bindings: Bindings): ReadonlySet<string> => keysOf(bindings.jump, "Space");
/** What aims left and right: the player's Sola Git / Sağa Git keys (A / D and the arrows by default). */
export const aimBindings = (bindings: Bindings) => ({ left: keysOf(bindings.moveLeft, "KeyA"), right: keysOf(bindings.moveRight, "KeyD") });
/** "SPACE", "A / D": the keys, for the HUD. */
export const fireLabel = (bindings: Bindings) => [...fireBindings(bindings)].map(bindingLabel).join(" / ");
export const aimLabel = (bindings: Bindings) => {
  const { left, right } = aimBindings(bindings);
  return `${bindingLabel([...left][0])} / ${bindingLabel([...right][0])}`;
};

/**
 * The aim from the held keys: the middle with none, left while a left key is held, right while a
 * right key is; with both, the one pressed last (letting it go falls back to the other).
 */
export class AimKeys {
  private held: string[] = [];
  constructor(public left: ReadonlySet<string>, public right: ReadonlySet<string>) {}
  /** A key went down; true when it is an aim key. */
  down(code: string | null) {
    if (!code || (!this.left.has(code) && !this.right.has(code))) return false;
    this.held = this.held.filter((c) => c !== code);
    this.held.push(code);
    return true;
  }
  up(code: string) {
    this.held = this.held.filter((c) => c !== code);
  }
  clear() {
    this.held = [];
  }
  /** −1 left, 0 middle, +1 right. */
  get aim() {
    const last = this.held[this.held.length - 1];
    return last === undefined ? 0 : this.left.has(last) ? -1 : 1;
  }
}

/**
 * Keys window-wide (so focus never eats a press): aim keys while held, one shot per press of a
 * fire key (its repeats and a press without a release never fire). Keys on menus and text
 * fields are not game keys. `onAim` runs whenever the aim may have changed.
 */
export function bindMarksmanInput(fire: ClickPresses, aim: AimKeys, enabled: () => boolean, onFire: () => void, onAim: () => void) {
  const keyDown = (event: KeyboardEvent) => {
    if (!enabled() || isUIInput(event.target) || isUIInput(document.activeElement)) return;
    const code = keyboardBinding(event);
    if (!code) return;
    if (aim.left.has(code) || aim.right.has(code)) {
      event.preventDefault();
      if (!event.repeat && aim.down(code)) onAim();
      return;
    }
    if (!fire.bindings.has(code)) return;
    event.preventDefault();
    if (fire.key(code, event.repeat)) onFire();
  };
  const keyUp = (event: KeyboardEvent) => {
    fire.keyUp(event.code);
    aim.up(event.code);
    onAim();
  };
  const blur = () => {
    fire.clear();
    aim.clear();
    onAim();
  };
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  window.addEventListener("blur", blur);
  return () => {
    window.removeEventListener("keydown", keyDown);
    window.removeEventListener("keyup", keyUp);
    window.removeEventListener("blur", blur);
    fire.clear();
    aim.clear();
  };
}
