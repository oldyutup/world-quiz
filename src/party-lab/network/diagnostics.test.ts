import assert from "node:assert/strict";
import { test } from "node:test";
import { LINK, NetDiagnostics } from "./diagnostics";

test("RTT current/average/jitter/max and clock offset from the tightest round trip", () => {
  const d = new NetDiagnostics();
  // Client sends at t, pong arrives at t + rtt; server clock is 5 s ahead of the client.
  const wall = 1_000_000;
  for (const [t, rtt] of [[0, 80], [1000, 60], [2000, 100], [3000, 70]]) {
    const received = t + rtt;
    d.pong({ id: t, t, s: wall + t + rtt / 2 + 5000 }, received, wall + received);
  }
  const s = d.summary(3100);
  assert.equal(s.rtt, 70);
  assert.equal(s.rttAvg, 77.5);
  assert.equal(s.rttMax, 100);
  assert.equal(s.rttJitter, (20 + 40 + 30) / 3);
  assert.ok(Math.abs(s.clockOffsetMs - 5000) < 1e-9);
  d.pong({ id: 9, t: 5000, s: 0 }, 4000, 0);
  assert.equal(d.rtt.length, 4, "negative/invalid samples ignored");
  for (let i = 0; i < 30; i++) d.pong({ id: i, t: i, s: wall }, i + 50, wall);
  assert.equal(d.rtt.length, 20, "rolling history is bounded");
});

test("snapshot gaps, duplicates and cadence are distinguished", () => {
  const d = new NetDiagnostics();
  d.snapshot(1, true, 0);
  d.snapshot(2, true, 50);
  d.snapshot(2, false, 60); // duplicate rejected by the buffer
  d.snapshot(5, true, 400); // 3 and 4 never arrived; 350 ms interval
  const s = d.summary(420);
  assert.equal(s.snapshotGaps, 2);
  assert.equal(s.snapshotsRejected, 1);
  assert.equal(s.snapshotGapMaxMs, 350);
  assert.equal(s.snapshotsPerSecond, 3);
  assert.equal(s.snapshotAge, 20);
});

test("link quality: normal jitter stays good, stalls/slow RTT degrade with hold, silence >10 s is dead", () => {
  const d = new NetDiagnostics();
  d.serverMessage(0);
  // Arena cadence with ordinary lateness never degrades.
  for (let t = 0; t <= 3000; t += 50) {
    const late = t % 400 === 0 ? 80 : 0;
    d.snapshot(t / 50 + 1, true, t + late);
    d.serverMessage(t + late);
    assert.equal(d.quality(t + late + 40, "playing"), "good");
  }
  // A frozen stream (no snapshots) degrades only past snapshotStallMs.
  assert.equal(d.quality(3000 + LINK.snapshotStallMs - 10, "playing"), "good");
  assert.equal(d.quality(3000 + LINK.snapshotStallMs + 10, "playing"), "degraded");
  // Recovery: data flows again, but the badge holds to avoid flicker.
  let seq = 100;
  for (let t = 3700; t <= 3700 + LINK.holdMs + 100; t += 50) {
    d.snapshot(seq++, true, t);
    d.serverMessage(t);
    if (t === 3700) assert.equal(d.quality(t + 10, "playing"), "degraded");
  }
  assert.equal(d.quality(3700 + LINK.holdMs + 110, "playing"), "good");
  // Lobby: no snapshots expected, pongs every second.
  d.serverMessage(10000);
  assert.equal(d.quality(10000 + 2000, "waiting"), "good");
  assert.equal(d.quality(10000 + LINK.silenceMs + 10, "waiting"), "degraded");
  assert.equal(d.dead(10000 + LINK.deadMs - 1), false);
  assert.equal(d.dead(10000 + LINK.deadMs + 1), true);
  // One slow pong (e.g. queued behind a client stall) is not a slow link; two in a row are.
  const slow = new NetDiagnostics();
  slow.serverMessage(0);
  slow.pong({ id: 1, t: 0, s: 0 }, 2300, 0);
  slow.serverMessage(2300);
  assert.equal(slow.quality(2310, "waiting"), "good");
  slow.pong({ id: 2, t: 2400, s: 0 }, 2400 + LINK.slowRttMs + 50, 0);
  slow.serverMessage(2400 + LINK.slowRttMs + 50);
  assert.equal(slow.quality(2400 + LINK.slowRttMs + 60, "waiting"), "degraded");
});

test("drops, reconnects and chat timing are recorded; reconnect restarts silence tracking", () => {
  const d = new NetDiagnostics();
  d.serverMessage(0);
  d.dropped(1006, "", 1000);
  d.reconnected(2500);
  const s = d.summary(2600);
  assert.equal(s.drops, 1);
  assert.equal(s.reconnects, 1);
  assert.equal(s.lastCloseCode, 1006);
  assert.equal(s.lastOutageMs, 1500);
  assert.equal(d.dead(2500 + LINK.deadMs - 1), false, "fresh socket is not instantly dead");
  d.pong({ id: 1, t: 3000, s: 50_000 + 20 }, 3040, 50_000 + 40); // offset 0
  d.chatReceived("m1", 50_000, 3100, 50_100);
  d.chatRendered("m1", 3104);
  d.chatRendered("m1", 3900); // first render wins
  assert.deepEqual(d.summary(4000).chat, { id: "m1", serverToClientMs: 100, receivedAt: 3100, renderMs: 4 });
  d.reset();
  assert.equal(d.summary(0).drops, 0);
  assert.equal(d.summary(0).chat, null);
});
