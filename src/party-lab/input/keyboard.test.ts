import assert from "node:assert/strict";
import { test } from "node:test";
import { bindKeyboard } from "./keyboard";
import { changeBinding } from "./bindings";
import { defaultBindings } from "./defaults";

class Target extends EventTarget {
  listeners = 0;
  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ) {
    this.listeners++;
    super.addEventListener(type, callback, options);
  }
  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ) {
    this.listeners--;
    super.removeEventListener(type, callback, options);
  }
}
function event(type: string, properties: Record<string, unknown> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), properties);
}
function environment(
  check: (win: Target, doc: Target, surface: HTMLElement & Target) => void
) {
  const win = new Target(),
    doc = new Target();
  let focused: Target | undefined;
  class Element extends Target {
    closest(selector: string) {
      return selector === "[tabindex]" ? this : null;
    }
    focus() {
      if (focused !== this) {
        focused = this;
        doc.dispatchEvent(event("focusin"));
      }
    }
  }
  const originals = ["window", "document", "HTMLElement"].map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key)
  );
  Object.defineProperties(globalThis, {
    window: { value: win, configurable: true },
    document: { value: doc, configurable: true },
    HTMLElement: { value: Element, configurable: true },
  });
  try {
    check(win, doc, new Element() as unknown as HTMLElement & Target);
  } finally {
    ["window", "document", "HTMLElement"].forEach((key, index) => {
      if (originals[index])
        Object.defineProperty(globalThis, key, originals[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

test("F and left click produce identical punch intent on press, never on release", () =>
  environment((win, _doc, surface) => {
    const c = bindKeyboard(surface);
    win.dispatchEvent(event("keydown", { code: "KeyF" }));
    const key = c.readIntent();
    assert.equal(key.punch, true);
    win.dispatchEvent(event("keyup", { code: "KeyF" }));
    assert.equal(c.readIntent().punch, false);
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    assert.deepEqual(c.readIntent(), key);
    win.dispatchEvent(event("mouseup", { button: 0 }));
    assert.equal(c.readIntent().punch, false);
    c.dispose();
  }));
test("keyboard/mouse Grab are identical, hold persists with lift, last alias release drops", () =>
  environment((win, _doc, surface) => {
    const c = bindKeyboard(surface);
    surface.dispatchEvent(event("mousedown", { button: 2 }));
    const mouse = c.readIntent();
    assert.equal(mouse.grab, true);
    win.dispatchEvent(event("mouseup", { button: 2 }));
    assert.equal(c.readIntent().grab, false);
    win.dispatchEvent(event("keydown", { code: "KeyE" }));
    assert.deepEqual(c.readIntent(), mouse);
    surface.dispatchEvent(event("mousedown", { button: 2 }));
    win.dispatchEvent(event("keydown", { code: "ShiftLeft" }));
    assert.equal(c.readIntent().lift, true);
    win.dispatchEvent(event("mouseup", { button: 2 }));
    assert.equal(c.readIntent().grab, true);
    assert.equal(c.readIntent().grab, true);
    win.dispatchEvent(event("keyup", { code: "KeyE" }));
    assert.equal(c.readIntent().grab, false);
    c.dispose();
  }));
test("Space is edge-triggered; focus/blur/visibility/cancel clear all pending intent", () =>
  environment((win, doc, surface) => {
    const c = bindKeyboard(surface);
    win.dispatchEvent(event("keydown", { code: "Space" }));
    assert.equal(c.readIntent().jump, true);
    win.dispatchEvent(event("keydown", { code: "Space", repeat: true }));
    assert.equal(c.readIntent().jump, false);
    for (const [target, type] of [
      [win, "blur"],
      [doc, "visibilitychange"],
      [win, "pointercancel"],
      [doc, "focusin"],
    ] as const) {
      win.dispatchEvent(event("keydown", { code: "KeyF" }));
      win.dispatchEvent(event("keydown", { code: "KeyE" }));
      target.dispatchEvent(event(type));
      assert.deepEqual(c.readIntent(), {
        x: 0,
        z: 0,
        jump: false,
        punch: false,
        grab: false,
        lift: false,
      });
    }
    c.dispose();
  }));
test("context menu is canvas-only and conditional; repeated mounts clean all listeners", () =>
  environment((win, doc, surface) => {
    for (let i = 0; i < 8; i++) {
      const c = bindKeyboard(surface),
        inside = event("contextmenu"),
        outside = event("contextmenu");
      surface.dispatchEvent(inside);
      doc.dispatchEvent(outside);
      assert.ok(inside.defaultPrevented && !outside.defaultPrevented);
      c.setBindings(changeBinding(defaultBindings(), "grab", 1, null)!);
      const unbound = event("contextmenu");
      surface.dispatchEvent(unbound);
      assert.equal(unbound.defaultPrevented, false);
      c.dispose();
      assert.equal(win.listeners + doc.listeners + surface.listeners, 0);
    }
  }));
test("settings suspension and UI focus suppress all gameplay, including clicks and held keys", () =>
  environment((win, doc, surface) => {
    const c = bindKeyboard(surface);
    c.setSuspended(true);
    for (const code of ["KeyF", "KeyE", "Space", "KeyW"])
      win.dispatchEvent(event("keydown", { code }));
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    assert.deepEqual(c.readIntent(), {
      x: 0,
      z: 0,
      jump: false,
      punch: false,
      grab: false,
      lift: false,
    });
    c.setSuspended(false);
    // Native input, button, chat or nickname focus uses this same UI selector gate.
    const field = new HTMLElement();
    field.closest = () => field;
    Object.assign(doc, { activeElement: field });
    for (const code of ["KeyF", "KeyE", "Space"])
      win.dispatchEvent(event("keydown", { code }));
    assert.equal(c.readIntent().punch, false);
    assert.equal(c.readIntent().grab, false);
    assert.equal(c.readIntent().jump, false);
    Object.assign(doc, { activeElement: null });
    win.dispatchEvent(event("keydown", { code: "KeyF", repeat: true }));
    assert.equal(c.readIntent().punch, false);
    win.dispatchEvent(event("keydown", { code: "KeyF" }));
    assert.equal(c.readIntent().punch, true);
    c.dispose();
  }));
test("rebinding applies immediately, left click remains and middle mouse is supported", () =>
  environment((win, _doc, surface) => {
    const c = bindKeyboard(surface);
    c.setBindings(changeBinding(defaultBindings(), "punch", 0, "KeyG")!);
    win.dispatchEvent(event("keydown", { code: "KeyF" }));
    assert.equal(c.readIntent().punch, false);
    win.dispatchEvent(event("keydown", { code: "KeyG" }));
    assert.equal(c.readIntent().punch, true);
    win.dispatchEvent(event("keyup", { code: "KeyG" }));
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    assert.equal(c.readIntent().punch, true);
    c.setBindings(changeBinding(defaultBindings(), "jump", 1, "MouseMiddle")!);
    surface.dispatchEvent(event("mousedown", { button: 1 }));
    assert.equal(c.readIntent().jump, true);
    c.dispose();
  }));
test("held Space and arrows suppress browser scrolling without extra jump edges", () =>
  environment((win, _doc, surface) => {
    const c = bindKeyboard(surface);
    for (const code of ["Space", "ArrowDown"]) {
      win.dispatchEvent(event("keydown", { code }));
      c.readIntent();
      const repeat = event("keydown", { code, repeat: true });
      win.dispatchEvent(repeat);
      assert.equal(repeat.defaultPrevented, true);
      assert.equal(c.readIntent().jump, false);
    }
    c.dispose();
  }));
