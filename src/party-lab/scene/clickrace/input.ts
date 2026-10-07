import type { Bindings } from "../../input/bindings";
import { isUIInput, keyboardBinding, mouseBinding } from "../../input/device";

/** What presses the pedal: the player's Punch keys (default F) and buttons, plus the left button. */
export function pressBindings(bindings: Bindings): ReadonlySet<string> {
  const set = new Set(bindings.punch.filter((binding): binding is string => !!binding));
  set.add("MouseLeft");
  return set;
}

/**
 * One count per physical press. A held key's auto-repeat never counts, and a key counts
 * again only after it was released (some systems repeat without marking `repeat`).
 */
export class ClickPresses {
  private held = new Set<string>();
  constructor(public bindings: ReadonlySet<string>) {}
  key(code: string | null, repeat: boolean) {
    if (!code || !this.bindings.has(code) || repeat || this.held.has(code)) return false;
    this.held.add(code);
    return true;
  }
  keyUp(code: string) {
    this.held.delete(code);
  }
  /** A mouse button (a trackpad click is the left button). */
  mouse(button: number) {
    const binding = mouseBinding(button);
    return !!binding && this.bindings.has(binding);
  }
  clear() {
    this.held.clear();
  }
}

/**
 * Keys (window-wide, so focus never eats a press), mouse buttons and touches on `surface`.
 * Touch and pen come in as pointer events; cancelling their pointerdown stops the browser's
 * emulated mouse press, so a tap counts once. Presses on buttons and menus are not presses.
 */
export function bindClickInput(surface: HTMLElement, presses: ClickPresses, enabled: () => boolean, onPress: () => void) {
  const keyDown = (event: KeyboardEvent) => {
    if (!enabled() || isUIInput(event.target) || isUIInput(document.activeElement)) return;
    const code = keyboardBinding(event);
    if (!code || !presses.bindings.has(code)) return;
    event.preventDefault();
    if (presses.key(code, event.repeat)) onPress();
  };
  const keyUp = (event: KeyboardEvent) => presses.keyUp(event.code);
  const mouseDown = (event: MouseEvent) => {
    if (!enabled() || isUIInput(event.target) || !presses.mouse(event.button)) return;
    event.preventDefault();
    onPress();
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" || isUIInput(event.target)) return;
    event.preventDefault();
    if (enabled()) onPress();
  };
  const contextMenu = (event: Event) => {
    if (presses.bindings.has("MouseRight")) event.preventDefault();
  };
  const blur = () => presses.clear();
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  window.addEventListener("blur", blur);
  surface.addEventListener("mousedown", mouseDown);
  surface.addEventListener("pointerdown", pointerDown);
  surface.addEventListener("contextmenu", contextMenu);
  return () => {
    window.removeEventListener("keydown", keyDown);
    window.removeEventListener("keyup", keyUp);
    window.removeEventListener("blur", blur);
    surface.removeEventListener("mousedown", mouseDown);
    surface.removeEventListener("pointerdown", pointerDown);
    surface.removeEventListener("contextmenu", contextMenu);
    presses.clear();
  };
}
