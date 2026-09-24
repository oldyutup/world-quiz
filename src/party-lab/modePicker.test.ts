import assert from "node:assert/strict";
import { test } from "node:test";
import { MODE_LIST_MIN_WIDTH, modeListStep, placeModeList } from "./modePicker";

const desktop = { width: 1440, height: 900 };
const trigger = { top: 380, bottom: 424, right: 640, width: 170 };

test("the mode list opens under its trigger, right edges aligned", () => {
  const at = placeModeList(trigger, 300, desktop);
  assert.equal(at.above, false);
  assert.equal(at.width, MODE_LIST_MIN_WIDTH);
  assert.equal(at.left, 640 - MODE_LIST_MIN_WIDTH);
  assert.equal(at.top, 430);
  assert.ok(at.maxHeight >= 300);
});

test("it flips above when only the space above fits it", () => {
  const low = { top: 600, bottom: 644, right: 640, width: 170 };
  const at = placeModeList(low, 300, { width: 1280, height: 720 });
  assert.equal(at.above, true);
  assert.equal(at.top, 600 - 6 - 300);
  assert.ok(at.top >= 16);
});

test("it stays below and scrolls when neither side fits it whole but below is larger", () => {
  const at = placeModeList({ top: 200, bottom: 244, right: 640, width: 170 }, 800, { width: 1280, height: 720 });
  assert.equal(at.above, false);
  assert.equal(at.maxHeight, 720 - 16 - 244 - 6);
});

test("on a phone it takes the viewport width inside the gutter and never leaves the screen", () => {
  const phone = { width: 320, height: 640 };
  const full = { top: 300, bottom: 344, right: 284, width: 248 };
  const at = placeModeList(full, 280, phone);
  assert.equal(at.width, 320 - 32);
  assert.equal(at.left, 16);
  const narrowTrigger = placeModeList({ top: 300, bottom: 344, right: 120, width: 100 }, 280, phone);
  assert.equal(narrowTrigger.left, 16);
  assert.ok(narrowTrigger.left + narrowTrigger.width <= phone.width - 16);
});

test("arrow keys wrap, Home/End jump, other keys are left alone", () => {
  assert.equal(modeListStep("ArrowDown", 3, 4), 0);
  assert.equal(modeListStep("ArrowUp", 0, 4), 3);
  assert.equal(modeListStep("ArrowDown", 1, 4), 2);
  assert.equal(modeListStep("Home", 2, 4), 0);
  assert.equal(modeListStep("End", 0, 4), 3);
  assert.equal(modeListStep("Enter", 1, 4), null);
});
