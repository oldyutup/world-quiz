import type { Binding } from "./bindings";
import { keyboardBinding, mouseBinding } from "./device";

/** Installed after slot activation. Capture down/up/click; commit only after release. */
export function captureBinding(
  onCapture: (binding: Binding | null) => void,
  target: EventTarget = window
) {
  let pending: Binding | null | undefined;
  let releaseCode: string | number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const block = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  function down(event: Event) {
    block(event);
    if (event.type === "keydown" && (event as KeyboardEvent).code === "Escape") {
      clearTimeout(timer);
      timer = undefined;
      pending = null;
      releaseCode = "Escape";
      return;
    }
    if (pending !== undefined) return;
    if (event.type === "keydown") {
      const key = event as KeyboardEvent;
      if (key.repeat) return;
      const binding = keyboardBinding(key);
      if (binding === null) return;
      pending = binding;
      releaseCode = key.code;
    } else {
      const mouse = event as MouseEvent;
      const binding = mouseBinding(mouse.button);
      if (!binding) return;
      pending = binding;
      releaseCode = mouse.button;
    }
  }
  function up(event: Event) {
    block(event);
    const code =
      event.type === "keyup"
        ? (event as KeyboardEvent).code
        : (event as MouseEvent).button;
    if (pending !== undefined && code === releaseCode && timer === undefined) {
      // Keep swallowing the click synthesized after mouseup / Space keyup.
      timer = setTimeout(() => {
        dispose();
        onCapture(pending!);
      }, 0);
    }
  }
  /**
   * Only the window itself losing focus (another app, another tab) cancels. A capture
   * listener on the window also sees every element's blur on its way down, including
   * the slot button's own blur when it is disabled for the capture: that is not a cancel.
   */
  function blur(event: Event) {
    if (event.target !== target) return;
    dispose();
    onCapture(null);
  }
  function dispose() {
    clearTimeout(timer);
    for (const type of ["keydown", "mousedown"])
      target.removeEventListener(type, down, true);
    for (const type of ["keyup", "mouseup"])
      target.removeEventListener(type, up, true);
    for (const type of ["click", "contextmenu"])
      target.removeEventListener(type, block, true);
    target.removeEventListener("blur", blur, true);
  }
  for (const type of ["keydown", "mousedown"])
    target.addEventListener(type, down, true);
  for (const type of ["keyup", "mouseup"])
    target.addEventListener(type, up, true);
  for (const type of ["click", "contextmenu"])
    target.addEventListener(type, block, true);
  target.addEventListener("blur", blur, true);
  return dispose;
}
