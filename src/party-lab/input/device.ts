import { isBinding } from "./bindings";
export const mouseBinding = (button: number) =>
  (["MouseLeft", "MouseMiddle", "MouseRight"] as const)[button] ?? null;
export function keyboardBinding(event: KeyboardEvent) {
  // Browser/OS command chords are reserved. Standalone Ctrl/Alt are bindable.
  if (event.metaKey || event.isComposing) return null;
  if (event.ctrlKey && !event.code.startsWith("Control")) return null;
  if (event.altKey && !event.code.startsWith("Alt")) return null;
  return isBinding(event.code) ? event.code : null;
}
export const isUIInput = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest(
    "input,textarea,select,button,a,[contenteditable],[data-party-controls]"
  );
