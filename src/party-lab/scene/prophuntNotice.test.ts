import assert from "node:assert/strict";
import { test } from "node:test";
import { PROP_HUNT } from "../../../shared/party-lab/simulation/prophunt/config";
import { PROP_NOTICE, PropNoticeClock, propNotice } from "./prophunt/phaseNotice";

test("Saklambaç: hiders see the seeker count down in whole seconds", () => {
  assert.equal(PROP_HUNT.timing.hiding, 15);
  assert.deepEqual(propNotice("hiding", "hider", true, 15, -Infinity), { kind: "counting", text: "Avcı sayıyor: 15" });
  assert.equal(propNotice("hiding", "hider", true, 11.2, -Infinity)?.text, "Avcı sayıyor: 12");
  assert.equal(propNotice("hiding", "hider", true, 0.01, -Infinity)?.text, "Avcı sayıyor: 1");
  // The seeker has the blindfold (its own count); nothing else before the search.
  assert.equal(propNotice("hiding", "seeker", true, 9, -Infinity), null);
  for (const phase of ["countdown", "results"]) for (const role of ["hider", "seeker"] as const) assert.equal(propNotice(phase, role, true, 3, 0), null);
});

test("Saklambaç: when the count ends, hiders still hidden get the alarm and the seeker gets ARA!, briefly", () => {
  assert.deepEqual(propNotice("search", "hider", true, 75, 0), { kind: "hunted", text: "Avcı artık seni arıyor, dikkat!" });
  assert.equal(propNotice("search", "hider", true, 74, PROP_NOTICE.hunted - 0.01)?.kind, "hunted");
  assert.equal(propNotice("search", "hider", true, 72, PROP_NOTICE.hunted), null);
  assert.equal(propNotice("search", "hider", false, 75, 0), null, "a found hider is only watching");
  assert.deepEqual(propNotice("search", "seeker", true, 75, 0), { kind: "seek", text: "ARA!" });
  assert.equal(propNotice("search", "seeker", true, 73, PROP_NOTICE.seek), null);
  // A spectator (no role) never sees either.
  assert.equal(propNotice("hiding", null, false, 9, -Infinity), null);
  assert.equal(propNotice("search", null, false, 75, 0), null);
});

test("Saklambaç: the end of the count is called once, only on the hiding → search change", () => {
  const clock = new PropNoticeClock();
  // Joining (or reconnecting) into a running search: no call.
  assert.equal(clock.update("search", 1), false);
  assert.equal(clock.since(1), Infinity);
  const frames: boolean[] = [];
  for (const [phase, now] of [["countdown", 2], ["hiding", 3], ["hiding", 17], ["search", 18], ["search", 18.1], ["search", 30], ["results", 90], ["countdown", 95], ["hiding", 98], ["search", 113]] as const) frames.push(clock.update(phase, now));
  assert.deepEqual(frames, [false, false, false, true, false, false, false, false, false, true]);
  assert.equal(clock.since(113.5), 0.5);
  assert.equal(propNotice("search", "hider", true, 74.5, clock.since(113.5))?.kind, "hunted");
});
