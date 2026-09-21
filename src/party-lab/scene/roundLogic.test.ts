import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUND, RoundLogic } from "./roundLogic";

function playing() {
  const round = new RoundLogic();
  assert.equal(round.tick(ROUND.countdown), "started");
  return round;
}

test("countdown is 3, 2, 1 then play; elimination reports are ignored before play", () => {
  const round = new RoundLogic();
  assert.equal(round.seconds, 3);
  round.tick(1, [0]);
  assert.equal(round.seconds, 2);
  round.tick(1);
  assert.equal(round.seconds, 1);
  assert.deepEqual(round.alive, [true, true, true]);
  assert.equal(round.tick(1), "started");
  assert.equal(round.seconds, 60);
});

test("one elimination leaves the round playing; the last survivor wins after grace", () => {
  const round = playing();
  round.tick(0.1, [1]);
  assert.deepEqual(round.alive, [true, false, true]);
  assert.equal(round.phase, "playing");
  round.tick(0.1, [2]);
  assert.equal(round.winner, null);
  assert.equal(round.tick(ROUND.finalFallGrace), "finished");
  assert.equal(round.winner, 0);
  assert.equal(round.reason, "survivor");
});

test("all three falls in the same tick draw regardless of report order", () => {
  for (const ids of [[0, 1, 2], [2, 0, 1]] as const) {
    const round = playing();
    assert.equal(round.tick(0.01, ids), "finished");
    assert.equal(round.winner, null);
    assert.equal(round.reason, "all-fell");
  }
});

test("a final fall inside the grace window converts a pending win to a draw", () => {
  const round = playing();
  round.tick(0.01, [0, 1]);
  round.tick(0.2);
  assert.equal(round.phase, "playing");
  assert.equal(round.tick(0.01, [2]), "finished");
  assert.equal(round.winner, null);
  assert.equal(round.reason, "all-fell");
});

test("timeout with multiple survivors is a draw, including after one elimination", () => {
  const round = playing();
  round.tick(1, [0]);
  assert.equal(round.tick(ROUND.duration - 1), "finished");
  assert.equal(round.winner, null);
  assert.equal(round.reason, "timeout");
});

test("a last-survivor decision at the time limit still gets the fall grace window", () => {
  const round = playing();
  round.tick(ROUND.duration, [0, 1]);
  assert.equal(round.phase, "playing");
  round.tick(0.2, [2]);
  assert.equal(round.reason, "all-fell");
});

test("results are stable, then reset revives everyone and clears the previous result", () => {
  const round = playing();
  round.tick(0.01, [0, 2]);
  round.tick(ROUND.finalFallGrace);
  const snapshot = round.snapshot();
  round.tick(1, [1]);
  assert.equal(round.winner, 1);
  assert.equal(round.tick(ROUND.results - 1), "reset");
  assert.equal(round.phase, "countdown");
  assert.equal(round.seconds, 3);
  assert.deepEqual(round.alive, [true, true, true]);
  assert.equal(round.winner, null);
  assert.equal(round.reason, null);
  assert.deepEqual(snapshot.alive, [false, true, false], "published snapshots must not mutate on reset");
});
