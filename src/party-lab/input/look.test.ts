import assert from "node:assert/strict";
import { test } from "node:test";
import { bindLook, loadLookMode, saveLookMode, type LookStatus } from "./look";

class Target extends EventTarget {
  listeners = 0;
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    this.listeners++;
    super.addEventListener(type, callback, options);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    this.listeners--;
    super.removeEventListener(type, callback, options);
  }
}
const event = (type: string, properties: Record<string, unknown> = {}) => Object.assign(new Event(type, { cancelable: true }), properties);

/** Fake window/document/HTMLElement with a controllable Pointer Lock. */
function environment(check: (env: { win: Target; doc: Target & { pointerLockElement: unknown; exits: number }; surface: HTMLElement & Target & { requests: number }; ui: HTMLElement & Target; grant: (ok: boolean) => void; statuses: LookStatus[] }) => void) {
  const win = new Target(),
    doc = Object.assign(new Target(), { pointerLockElement: null as unknown, exits: 0 });
  let allow = true;
  class Element extends Target {
    requests = 0;
    closest(selector: string) {
      return selector === "[tabindex]" ? this : null;
    }
    requestPointerLock() {
      this.requests++;
      if (!allow) return Promise.reject(new Error("refused"));
      doc.pointerLockElement = this;
      doc.dispatchEvent(event("pointerlockchange"));
      return Promise.resolve();
    }
  }
  class Button extends Element {
    override closest(selector: string) {
      return selector.includes("button") ? this : null;
    }
  }
  Object.assign(doc, {
    exitPointerLock() {
      doc.exits++;
      doc.pointerLockElement = null;
      doc.dispatchEvent(event("pointerlockchange"));
    },
  });
  const keys = ["window", "document", "HTMLElement"] as const;
  const originals = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperties(globalThis, {
    window: { value: win, configurable: true },
    document: { value: doc, configurable: true },
    HTMLElement: { value: Element, configurable: true },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    check({
      win,
      doc,
      surface: new Element() as unknown as HTMLElement & Target & { requests: number },
      ui: new Button() as unknown as HTMLElement & Target,
      grant: (ok) => (allow = ok),
      statuses: [],
    });
  } finally {
    console.warn = warn;
    keys.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(globalThis, key, originals[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

test("lock mode: a click in the arena requests Pointer Lock; only locked movement turns the camera", () =>
  environment(({ win, doc, surface, statuses }) => {
    const look = bindLook(surface, "lock", (s) => statuses.push(s));
    win.dispatchEvent(event("mousemove", { movementX: 30, movementY: 5 }));
    assert.deepEqual(look.consume(), { dx: 0, dy: 0 }, "no look before the lock");
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    assert.equal(surface.requests, 1);
    assert.equal(doc.pointerLockElement, surface);
    assert.equal(look.status, "locked");
    win.dispatchEvent(event("mousemove", { movementX: 30, movementY: 5 }));
    win.dispatchEvent(event("mousemove", { movementX: -10, movementY: 2 }));
    win.dispatchEvent(event("mousemove", { movementX: 900, movementY: 0 })); // glitch spike
    assert.deepEqual(look.consume(), { dx: 20, dy: 7 });
    assert.deepEqual(look.consume(), { dx: 0, dy: 0 }, "deltas are consumed once");
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    assert.equal(surface.requests, 1, "no re-request while locked");
    // Esc (browser) releases the lock.
    (doc as unknown as { exitPointerLock(): void }).exitPointerLock();
    assert.equal(look.status, "unlocked");
    assert.deepEqual(statuses, ["locked", "unlocked"]);
    look.dispose();
  }));

test("lock mode: a refused lock reports an error and never turns the camera", async () => {
  let status: LookStatus = "unlocked";
  let pending: Promise<void> = Promise.resolve();
  const warn = console.warn;
  console.warn = () => {};
  environment(({ win, surface, grant }) => {
    grant(false);
    const look = bindLook(surface, "lock", (s) => (status = s));
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    win.dispatchEvent(event("mousemove", { movementX: 40, movementY: 0 }));
    assert.deepEqual(look.consume(), { dx: 0, dy: 0 });
    pending = new Promise((resolve) => setTimeout(resolve, 0));
    look.dispose();
  });
  await pending;
  console.warn = warn;
  assert.equal(status, "error");
});

test("drag mode: only a held primary button turns the camera; no lock is requested", () =>
  environment(({ win, surface }) => {
    const look = bindLook(surface, "drag", () => {});
    win.dispatchEvent(event("mousemove", { movementX: 25, movementY: 0, buttons: 0 }));
    surface.dispatchEvent(event("mousedown", { button: 2 }));
    win.dispatchEvent(event("mousemove", { movementX: 25, movementY: 0, buttons: 2 }));
    assert.deepEqual(look.consume(), { dx: 0, dy: 0 }, "hover and right-drag do nothing");
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    assert.equal(look.status, "dragging");
    win.dispatchEvent(event("mousemove", { movementX: 12, movementY: -4, buttons: 1 }));
    win.dispatchEvent(event("mouseup", { button: 0 }));
    win.dispatchEvent(event("mousemove", { movementX: 50, movementY: 0, buttons: 0 }));
    assert.deepEqual(look.consume(), { dx: 12, dy: -4 });
    assert.equal(look.status, "unlocked");
    assert.equal(surface.requests, 0);
    look.dispose();
  }));

test("pausing (settings) or switching modes releases the lock; dispose cleans up", () =>
  environment(({ win, doc, surface }) => {
    const look = bindLook(surface, "lock", () => {});
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    assert.equal(doc.pointerLockElement, surface);
    look.setEnabled(false);
    assert.equal(doc.pointerLockElement, null);
    assert.equal(look.status, "unlocked");
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    assert.equal(surface.requests, 1, "disabled: no lock");
    look.setEnabled(true);
    surface.dispatchEvent(event("mousedown", { button: 0 }));
    assert.equal(doc.pointerLockElement, surface);
    look.setMode("drag");
    assert.equal(doc.pointerLockElement, null, "switching to drag releases the lock");
    look.dispose();
    assert.equal(win.listeners + doc.listeners + surface.listeners, 0);
  }));

test("clicks on UI inside the arena (buttons, selects) never take the lock", () =>
  environment(({ doc, surface, ui }) => {
    const look = bindLook(surface, "lock", () => {});
    const click = event("mousedown", { button: 0 });
    Object.defineProperty(click, "target", { value: ui });
    surface.dispatchEvent(click);
    assert.equal(surface.requests, 0);
    assert.equal(doc.pointerLockElement, null);
    look.dispose();
  }));

test("look mode storage: defaults to lock, survives blocked storage", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } },
    configurable: true,
  });
  try {
    assert.equal(loadLookMode(), "lock");
    saveLookMode("drag");
    assert.equal(loadLookMode(), "drag");
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } },
      configurable: true,
    });
    assert.equal(loadLookMode(), "lock");
    saveLookMode("drag");
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
