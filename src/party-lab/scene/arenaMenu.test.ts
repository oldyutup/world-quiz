import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultBindings } from "../input/defaults";
import { changeBinding } from "../input/bindings";
import { ESC_UNLOCK_GRACE_MS, EscapeGate, controlHint, escapeStep } from "./arenaMenu";

test("Esc steps: closed → menu → closed; a sub-view goes back to the menu first", () => {
  assert.equal(escapeStep(null), "main");
  assert.equal(escapeStep("main"), null);
  assert.equal(escapeStep("controls"), "main");
  assert.equal(escapeStep("audio"), "main");
});

test("Esc gate: a press while locked belongs to the browser (it ends the lock)", () => {
  const gate = new EscapeGate();
  assert.equal(gate.accepts(1000, true), false);
  assert.equal(gate.accepts(1000, false), true, "no lock: Esc toggles the menu");
});

test("Esc gate: the press that ended the lock is not seen twice (either delivery order)", () => {
  // Browser ends the lock first, then (some browsers) delivers the same keydown.
  const gate = new EscapeGate();
  gate.lockEnded(5000);
  assert.equal(gate.accepts(5000 + 1, false), false, "same press right after pointerlockchange");
  assert.equal(gate.accepts(5000 + ESC_UNLOCK_GRACE_MS - 1, false), false);
  assert.equal(gate.accepts(5000 + ESC_UNLOCK_GRACE_MS, false), true, "a later, separate press closes the menu");
  // Keydown first while still locked: ignored; the lock's end then opens the menu once.
  const other = new EscapeGate();
  assert.equal(other.accepts(9000, true), false);
  other.lockEnded(9002);
  assert.equal(other.accepts(9003, false), false);
});

test("Esc gate: one physical press opens the menu exactly once", () => {
  // Simulate the arena: lock loss opens (never toggles); accepted key presses toggle.
  for (const order of ["unlock-then-key", "key-then-unlock", "unlock-only"] as const) {
    const gate = new EscapeGate();
    let view: ReturnType<typeof escapeStep> = null;
    const unlock = (now: number) => {
      gate.lockEnded(now);
      view = view ?? "main";
    };
    const key = (now: number, locked: boolean) => {
      if (gate.accepts(now, locked)) view = escapeStep(view);
    };
    if (order === "unlock-then-key") {
      unlock(100);
      key(104, false);
    } else if (order === "key-then-unlock") {
      key(100, true);
      unlock(103);
    } else unlock(100);
    assert.equal(view, "main", order);
    key(100 + ESC_UNLOCK_GRACE_MS + 50, false);
    assert.equal(view, null, `${order}: the next Esc returns to the game`);
  }
});

test("controls line: built from the player's current bindings, Esc menu last", () => {
  const bindings = defaultBindings();
  assert.equal(controlHint(bindings, "rooftop"), "WASD hareket · Space zıpla · F yumruk · E tut · Shift kaldır · Esc menü");
  assert.equal(controlHint(bindings, "barn"), "WASD hareket · Shift koş · Space zıpla · F ateş/yumruk · E silah al · Esc menü");
  assert.match(controlHint(bindings, "barn", "drag"), /E silah al · sürükleyerek bak · Esc menü$/);
  const rebound = changeBinding(changeBinding(bindings, "punch", 0, "KeyJ")!, "moveForward", 0, "KeyZ")!;
  assert.match(controlHint(rebound, "rooftop"), /^ZASD hareket · .* J yumruk/);
  const arrows = changeBinding(changeBinding(bindings, "moveForward", 1, null)!, "moveForward", 0, "ArrowUp")!;
  assert.match(controlHint(arrows, "rooftop"), /^↑\/A\/S\/D hareket/);
});
