import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameClock, frameTime } from "./frameClock";

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

test("frame clock: the renderer's delta for the first frame, then even steps from wandering frame times", () => {
  const clock = new FrameClock();
  assert.equal(clock.step(1000, 0.02), 0.02);
  assert.equal(clock.time, 1000);
  // A 60 Hz display read 15–19 ms apart (headed Chrome on macOS): no dropped frame.
  const wander = [0, 1.6, -1.4, 0.9, -1.8, 1.2, -0.6, 1.7, -1.1, 0.4];
  const steps: number[] = [];
  for (let n = 1; n <= 200; n++) steps.push(clock.step(1000 + n * (1000 / 60) + wander[n % wander.length], 0) * 1000);
  const settled = steps.slice(20);
  assert.ok(Math.max(...settled) - Math.min(...settled) < 0.6, `steps ${Math.min(...settled)}–${Math.max(...settled)} ms`);
  const raw = 1000 + 200 * (1000 / 60) + wander[200 % wander.length];
  assert.ok(Math.abs(clock.time - raw) < 3, "presentation time stays on the real clock");
});
test("frame clock: a dropped frame is spread, not lost; a stall restarts from the real clock", () => {
  const clock = new FrameClock();
  clock.step(0, 0.016);
  let t = 0;
  for (let n = 0; n < 20; n++) clock.step((t += 1000 / 60), 0);
  let total = 0;
  total += clock.step((t += 2000 / 60), 0); // one refresh missed
  for (let n = 0; n < 20; n++) total += clock.step((t += 1000 / 60), 0);
  assert.ok(near(total, 22 / 60, 1e-9), "every millisecond is presented");
  assert.ok(near(clock.time, t, 1e-9));
  assert.equal(clock.step(t, 0), 0, "the same frame twice advances nothing");
  assert.ok(near(clock.step((t += 5000), 0), 5), "a hidden tab reads as one long frame (the arenas suspend on it)");
  assert.equal(clock.time, t);
  assert.ok(near(clock.step((t += 1000 / 60), 0), 1 / 60));
});
test("frame time falls back where there is no document timeline", () => {
  assert.equal(frameTime(123.5), 123.5);
});
