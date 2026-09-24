import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS } from "./actions";
import {
  actionBindingLabel,
  changeBinding,
  conflicts,
  isBinding,
} from "./bindings";
import { defaultBindings } from "./defaults";
import { InputManager } from "./inputManager";
import {
  CONTROLS_KEY,
  deserializeControls,
  loadControls,
  saveControls,
  serializeControls,
} from "./storage";
import { captureBinding } from "./capture";
import { keyboardBinding } from "./device";

test("all exact defaults activate the corresponding action including both Shifts", () => {
  assert.deepEqual(defaultBindings(), {
    moveForward: ["KeyW", "ArrowUp"],
    moveBackward: ["KeyS", "ArrowDown"],
    moveLeft: ["KeyA", "ArrowLeft"],
    moveRight: ["KeyD", "ArrowRight"],
    jump: ["Space", null],
    punch: ["KeyF", "MouseLeft"],
    grab: ["KeyE", "MouseRight"],
    lift: ["ShiftLeft", "ShiftRight"],
  });
  const manager = new InputManager();
  for (const action of ACTIONS)
    for (const binding of manager.bindings[action]) {
      if (!binding) continue;
      manager.clear();
      manager.setBindingDown(binding, true);
      assert.equal(manager.isActionDown(action), true);
      assert.equal(manager.wasActionPressed(action), true);
      manager.readIntent();
      manager.setBindingDown(binding, false);
      assert.equal(manager.wasActionReleased(action), true);
      assert.equal(manager.isActionDown(action), false);
    }
});
test("overlapping aliases, repeats and duplicate same-action slots emit only one punch", () => {
  for (const bindings of [
    defaultBindings(),
    changeBinding(defaultBindings(), "punch", 1, "KeyF")!,
  ]) {
    const m = new InputManager(bindings);
    m.setBindingDown("KeyF", true);
    m.setBindingDown("MouseLeft", true);
    assert.equal(m.readIntent().punch, true);
    m.setBindingDown("KeyF", true);
    assert.equal(m.readIntent().punch, false);
    m.setBindingDown("KeyF", false);
    m.setBindingDown("MouseLeft", false);
    assert.equal(m.readIntent().punch, false);
    m.setBindingDown("KeyF", true);
    assert.equal(m.readIntent().punch, true);
  }
});
test("OR holds release only when last alias releases in either order", () => {
  for (const order of [
    ["KeyE", "MouseRight"],
    ["MouseRight", "KeyE"],
  ]) {
    const m = new InputManager();
    order.forEach((b) => m.setBindingDown(b, true));
    m.readIntent();
    m.setBindingDown(order[0], false);
    assert.equal(m.isActionDown("grab"), true);
    assert.equal(m.wasActionReleased("grab"), false);
    m.setBindingDown(order[1], false);
    assert.equal(m.readIntent().grab, false);
  }
});
test("movement normalizes diagonals and opposing directions cancel", () => {
  const m = new InputManager();
  m.setBindingDown("KeyW", true);
  assert.deepEqual(m.getMovementVector(), { x: 0, z: -1 });
  m.setBindingDown("KeyD", true);
  assert.ok(
    Math.abs(Math.hypot(...Object.values(m.getMovementVector())) - 1) < 0.00001
  );
  m.setBindingDown("KeyA", true);
  m.setBindingDown("KeyS", true);
  assert.deepEqual(m.getMovementVector(), { x: 0, z: 0 });
});
test("customization preserves primary, supports secondary/removal and rejects conflicts without mutation", () => {
  const original = defaultBindings();
  const custom = changeBinding(original, "punch", 0, "KeyG")!;
  assert.deepEqual(original.punch, ["KeyF", "MouseLeft"]);
  assert.deepEqual(custom.punch, ["KeyG", "MouseLeft"]);
  assert.deepEqual(changeBinding(custom, "punch", 1, "KeyH")!.punch, [
    "KeyG",
    "KeyH",
  ]);
  assert.deepEqual(changeBinding(custom, "punch", 1, null)!.punch, [
    "KeyG",
    null,
  ]);
  assert.equal(changeBinding(custom, "punch", 0, null), null);
  assert.equal(changeBinding(custom, "punch", 0, "KeyE"), null);
  assert.deepEqual(conflicts(custom, "punch", "KeyE"), ["grab"]);
  assert.deepEqual(conflicts(custom, "punch", "MouseLeft"), []);
});
test("versioned custom controls survive reload and reset persists defaults", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
  const custom = changeBinding(defaultBindings(), "punch", 0, "KeyG")!;
  assert.equal(saveControls(custom, storage), true);
  assert.equal(JSON.parse(map.get(CONTROLS_KEY)!).version, 1);
  assert.deepEqual(loadControls(storage), custom);
  assert.deepEqual(deserializeControls(serializeControls(custom)), custom);
  saveControls(defaultBindings(), storage);
  assert.deepEqual(loadControls(storage), defaultBindings());
});
test("malformed, incompatible, missing, conflicting and unsafe storage falls back safely", () => {
  for (const raw of [
    null,
    "{",
    "null",
    "[]",
    '{"version":2}',
    JSON.stringify({ version: 1, bindings: {} }),
    JSON.stringify({
      version: 1,
      bindings: { ...defaultBindings(), punch: [null, null] },
    }),
    JSON.stringify({
      version: 1,
      bindings: { ...defaultBindings(), punch: ["KeyE", null] },
    }),
    JSON.stringify({
      version: 1,
      bindings: { ...defaultBindings(), punch: ["Escape", null] },
    }),
  ])
    assert.deepEqual(deserializeControls(raw), defaultBindings());
  const blocked = {
    getItem() {
      throw Error();
    },
    setItem() {
      throw Error();
    },
  };
  assert.deepEqual(loadControls(blocked), defaultBindings());
  assert.equal(saveControls(defaultBindings(), blocked), false);
});
test("HUD derives all custom binding labels including Turkish mouse labels", () => {
  const b = changeBinding(defaultBindings(), "punch", 0, "KeyG")!;
  assert.equal(actionBindingLabel(b, "punch"), "G / Sol Tık");
  assert.equal(actionBindingLabel(b, "grab"), "E / Sağ Tık");
  assert.equal(
    actionBindingLabel(changeBinding(b, "jump", 1, "MouseMiddle")!, "jump"),
    "SPACE / Orta Tık"
  );
});
test("common keys are valid; Escape, OS commands and unsafe chords are reserved", () => {
  for (const key of [
    "KeyZ",
    "Digit2",
    "Space",
    "ShiftLeft",
    "ControlRight",
    "AltLeft",
    "ArrowDown",
    "Tab",
    "Enter",
    "MouseMiddle",
  ])
    assert.ok(isBinding(key));
  assert.equal(isBinding("Escape"), false);
  assert.equal(
    keyboardBinding({ code: "KeyQ", metaKey: true } as KeyboardEvent),
    null
  );
  assert.equal(
    keyboardBinding({ code: "KeyW", ctrlKey: true } as KeyboardEvent),
    null
  );
  assert.equal(
    keyboardBinding({ code: "ControlLeft", ctrlKey: true } as KeyboardEvent),
    "ControlLeft"
  );
});
const event = (type: string, props = {}) =>
  Object.assign(new Event(type, { cancelable: true }), props);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
test("capture ignores opening click and repeated opener; Escape cancels without binding", async () => {
  const target = new EventTarget();
  const results: (string | null)[] = [];
  const dispose = captureBinding((b) => results.push(b), target);
  target.dispatchEvent(event("click"));
  target.dispatchEvent(event("keydown", { code: "Enter", repeat: true }));
  target.dispatchEvent(event("keyup", { code: "Enter" }));
  await tick();
  assert.deepEqual(results, []);
  target.dispatchEvent(event("keydown", { code: "Escape" }));
  target.dispatchEvent(event("keyup", { code: "Escape" }));
  await tick();
  assert.deepEqual(results, [null]);
  dispose();
});
test("capture swallows F, Space and all mouse buttons through release/click without gameplay leaks", async () => {
  for (const input of ["KeyF", "Space", 0, 1, 2]) {
    const target = new EventTarget();
    let result: string | null = null,
      leaked = 0;
    captureBinding((b) => {
      result = b;
    }, target);
    for (const type of ["keydown", "keyup", "mousedown", "mouseup", "click"])
      target.addEventListener(type, () => leaked++);
    const mouse = typeof input === "number";
    target.dispatchEvent(
      event(
        mouse ? "mousedown" : "keydown",
        mouse ? { button: input } : { code: input }
      )
    );
    target.dispatchEvent(
      event(
        mouse ? "mouseup" : "keyup",
        mouse ? { button: input } : { code: input }
      )
    );
    target.dispatchEvent(event("click"));
    await tick();
    assert.equal(
      result,
      mouse
        ? ["MouseLeft", "MouseMiddle", "MouseRight"][input as number]
        : input
    );
    assert.equal(leaked, 0);
  }
});
test("Escape also cancels capture while the candidate key is still held", async () => {
  const target = new EventTarget();
  const results: (string | null)[] = [];
  captureBinding(binding => results.push(binding), target);
  target.dispatchEvent(event("keydown", { code: "KeyG" }));
  target.dispatchEvent(event("keydown", { code: "Escape" }));
  target.dispatchEvent(event("keyup", { code: "Escape" }));
  await tick();
  assert.deepEqual(results, [null]);
});
/** A blur of some element inside the page, as the window's capture-phase listener sees it. */
const elementBlur = () =>
  Object.defineProperty(event("blur"), "target", { value: { tagName: "BUTTON" } });
test("the slot button's own blur (disabled as capture starts) does not cancel; the next key is assigned", async () => {
  const target = new EventTarget();
  const results: (string | null)[] = [];
  captureBinding((b) => results.push(b), target);
  // Chrome blurs a focused button once it becomes disabled; the window's capture
  // listener sees that element blur on its way down. It used to cancel every capture.
  target.dispatchEvent(elementBlur());
  await tick();
  assert.deepEqual(results, []);
  target.dispatchEvent(event("keydown", { code: "KeyT" }));
  target.dispatchEvent(event("keyup", { code: "KeyT" }));
  await tick();
  assert.deepEqual(results, ["KeyT"]);
});
test("the window itself losing focus still cancels capture, and a new capture works after it", async () => {
  const results: (string | null)[] = [];
  const first = new EventTarget();
  captureBinding((b) => results.push(b), first);
  first.dispatchEvent(event("keydown", { code: "KeyG" }));
  first.dispatchEvent(event("blur")); // target === the window: Alt-Tab, another app
  assert.deepEqual([...results], [null]);
  // (Node's EventTarget keeps boolean-capture listeners after removal, so the next
  // capture gets its own target; browsers detach them.)
  const next = new EventTarget();
  captureBinding((b) => results.push(b), next);
  next.dispatchEvent(elementBlur());
  next.dispatchEvent(event("mousedown", { button: 2 }));
  next.dispatchEvent(event("mouseup", { button: 2 }));
  next.dispatchEvent(event("contextmenu"));
  await tick();
  assert.deepEqual(results, [null, "MouseRight"]);
});
