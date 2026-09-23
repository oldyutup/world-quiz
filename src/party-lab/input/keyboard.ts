import type { Bindings } from "./bindings";
import { defaultBindings } from "./defaults";
import { InputManager } from "./inputManager";
import { isUIInput, keyboardBinding, mouseBinding } from "./device";
export type { MovementInput } from "./types";

export interface KeyboardOptions {
  /**
   * Element receiving gameplay mouse presses (default: `surface`). The barn passes
   * its Pointer Lock element: while locked, the browser delivers mouse events there.
   */
  mouseSurface?: HTMLElement;
  /** Presses this returns true for are look input (e.g. the lock-acquiring click), never gameplay. */
  claimMouse?: (event: MouseEvent) => boolean;
}

/** Arena-scoped device adapter. Combat receives only readIntent()'s abstract actions. */
export function bindKeyboard(
  surface: HTMLElement,
  bindings: Bindings = defaultBindings(),
  { mouseSurface = surface, claimMouse }: KeyboardOptions = {}
) {
  const manager = new InputManager(bindings);
  let suspended = false;
  const clear = () => manager.clear();
  const bound = (binding: string) =>
    Object.values(manager.bindings).some((slots) => slots.includes(binding));
  function keyDown(event: KeyboardEvent) {
    if (
      suspended ||
      isUIInput(event.target) ||
      isUIInput(document.activeElement)
    )
      return;
    const binding = keyboardBinding(event);
    if (!binding || !bound(binding)) return;
    event.preventDefault();
    if (event.repeat) return;
    manager.setBindingDown(binding, true);
  }
  function keyUp(event: KeyboardEvent) {
    manager.setBindingDown(event.code, false);
  }
  function mouseDown(event: MouseEvent) {
    if (suspended || isUIInput(event.target) || claimMouse?.(event)) return;
    const binding = mouseBinding(event.button);
    if (!binding || !bound(binding)) return;
    event.preventDefault();
    (surface.closest("[tabindex]") as HTMLElement | null)?.focus();
    manager.setBindingDown(binding, true);
  }
  function mouseUp(event: MouseEvent) {
    const binding = mouseBinding(event.button);
    if (binding) manager.setBindingDown(binding, false);
  }
  const contextMenu = (event: Event) => {
    if (!suspended && bound("MouseRight")) event.preventDefault();
  };
  mouseSurface.addEventListener("mousedown", mouseDown);
  mouseSurface.addEventListener("contextmenu", contextMenu);
  window.addEventListener("mouseup", mouseUp);
  window.addEventListener("pointercancel", clear);
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", clear);
  document.addEventListener("focusin", clear);
  return {
    manager,
    readIntent: () => manager.readIntent(),
    clear,
    setBindings: (next: Bindings) => manager.setBindings(next),
    setSuspended(value: boolean) {
      suspended = value;
      manager.setSuspended(value);
    },
    dispose() {
      clear();
      mouseSurface.removeEventListener("mousedown", mouseDown);
      mouseSurface.removeEventListener("contextmenu", contextMenu);
      window.removeEventListener("mouseup", mouseUp);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
      document.removeEventListener("focusin", clear);
    },
  };
}
