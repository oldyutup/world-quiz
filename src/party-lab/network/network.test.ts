import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InputMailbox,
  NET,
  validateInput,
  TRANSFORM_BYTES,
  type GameSnapshot,
} from "../../../shared/party-lab/network/protocol";
import { GameStream, PLAYOUT, SnapshotBuffer } from "./gameStream";
import { serverEndpoint } from "./endpoint";
const input = (seq = 1) => ({
  seq,
  round: 1,
  moveX: 1,
  moveZ: 0,
  jumpPressed: false,
  punchPressed: false,
  grabHeld: false,
  liftHeld: false,
});
test("intent validation rejects spoofed targets/transforms and clamps finite movement", () => {
  for (const invalid of [
    null,
    [],
    {},
    { ...input(), slot: 2 },
    { ...input(), position: [1, 2, 3] },
    { ...input(), moveX: NaN },
    { ...input(), moveZ: Infinity },
    { ...input(), seq: -1 },
    { ...input(), seq: 1.5 },
    { ...input(), grabHeld: 1 },
  ])
    assert.equal(validateInput(invalid), null);
  const valid = validateInput({ ...input(), moveX: 999, moveZ: -999 })!;
  assert.equal(Math.hypot(valid.moveX, valid.moveZ), 1);
  assert.ok(valid.moveX > 0 && valid.moveZ < 0);
});
test("mailbox sequences, round epochs, edge consumption, held transitions and expiry", () => {
  const box = new InputMailbox();
  assert.ok(
    box.accept(
      { ...input(), punchPressed: true, grabHeld: true, liftHeld: true },
      1,
      0
    )
  );
  assert.equal(box.accept({ ...input(), punchPressed: true }, 1, 20), false);
  assert.equal(box.read(20).punch, true);
  assert.equal(box.read(30).punch, false);
  assert.equal(box.read(40).grab, true);
  assert.ok(
    box.accept({ ...input(2), punchPressed: true, grabHeld: true }, 1, 50)
  );
  assert.equal(
    box.read(50).punch,
    false,
    "repeated edge state does not repeat"
  );
  assert.ok(box.accept(input(3), 1, 70));
  assert.equal(box.read(70).grab, false);
  assert.ok(
    box.accept(
      { ...input(4), jumpPressed: true, punchPressed: true, grabHeld: true },
      1,
      90
    )
  );
  const expired = box.read(391);
  assert.equal(expired.x, 0);
  assert.equal(expired.grab, false);
  assert.equal(expired.lift, false);
  assert.equal(expired.punch, false);
  assert.equal(expired.jump, false);
  assert.equal(box.accept(input(3), 1, 400), false);
  assert.equal(box.accept(input(5), 2, 400), false);
  box.clear();
  assert.ok(box.accept({ ...input(6), round: 2 }, 2, 410));
});
const frame = (seq: number, tick: number, round = 1): GameSnapshot => ({
  v: NET.version,
  mode: "rooftop_brawl",
  seq,
  tick,
  round,
  phase: "playing",
  seconds: 60,
  winner: -1,
  mask: 7,
  alive: 7,
  states: [0, 0, 0],
  meters: [0, 0, 0],
  grips: [-1, -1, -1, -1, -1, -1],
  ack: [0, 0, 0],
  transforms: new Uint8Array(TRANSFORM_BYTES),
});
test("snapshots are bounded, ordered, delayed, and reset without interpolating across spawns", () => {
  const buffer = new SnapshotBuffer();
  assert.ok(buffer.push(frame(1, 60), 0));
  assert.ok(buffer.push(frame(2, 63), 50));
  assert.ok(buffer.push(frame(3, 66), 100));
  const sample = buffer.sample(125)!;
  assert.equal(sample.alpha, 0.5);
  assert.equal(buffer.push(frame(2, 63), 150), false);
  assert.equal(buffer.push(frame(4, 50), 150), false);
  assert.ok(buffer.push(frame(5, 120, 2), 160));
  assert.equal(buffer.frames.length, 1);
  for (let i = 6; i < 50; i++)
    buffer.push(frame(i, 120 + i * 3, 2), 160 + i * 50);
  assert.ok(buffer.frames.length <= PLAYOUT.frames);
  assert.equal(
    buffer.push({ ...frame(99, 400, 2), transforms: new Uint8Array(2) }, 2000),
    false
  );
});
test("authoritative event IDs suppress resends and snapshot overlap, but allow next round fall", () => {
  const stream = new GameStream();
  const fall = { name: "fall" as const, id: 1, round: 1, tick: 60, actor: 0 };
  stream.acceptEvents([fall, fall]);
  assert.equal(stream.drain(1, 999).length, 0);
  assert.equal(stream.drain(1, 1000).length, 1);
  stream.acceptEvents([fall]);
  assert.equal(stream.drain(1, 2000).length, 0);
  stream.clearPresentation();
  stream.acceptEvents([fall]);
  assert.equal(stream.drain(1, 2000).length, 0);
  stream.acceptEvents([{ ...fall, id: 2, round: 2, tick: 200 }]);
  assert.equal(stream.drain(2, 4000).length, 1);
});
test("LAN hostname default, localhost, IPv6, secure page, explicit override and production gating", () => {
  for (const hostname of ["192.168.1.34", "localhost", "127.0.0.1", "[::1]"])
    assert.equal(
      serverEndpoint(undefined, true, { hostname, protocol: "http:" }),
      `ws://${hostname}:2567`
    );
  assert.equal(
    serverEndpoint(undefined, true, {
      hostname: "host.local",
      protocol: "https:",
    }),
    "wss://host.local:2567"
  );
  assert.equal(
    serverEndpoint("ws://custom:9000", true, {
      hostname: "ignored",
      protocol: "http:",
    }),
    "ws://custom:9000"
  );
  assert.throws(() =>
    serverEndpoint(undefined, false, { hostname: "host", protocol: "https:" })
  );
  assert.throws(() =>
    serverEndpoint("ws://user:password@host", true, {
      hostname: "host",
      protocol: "http:",
    })
  );
});
test("production HTTPS page uses the configured secure endpoint and refuses insecure ones", () => {
  const page = { hostname: "torble.com", protocol: "https:" };
  assert.equal(
    serverEndpoint("wss://party.up.railway.app", false, page),
    "wss://party.up.railway.app"
  );
  assert.equal(
    serverEndpoint("https://party.up.railway.app", false, page),
    "https://party.up.railway.app"
  );
  for (const insecure of ["ws://party.up.railway.app", "http://party.up.railway.app"])
    assert.throws(() => serverEndpoint(insecure, false, page), /SERVER_NOT_CONFIGURED/);
  assert.throws(() => serverEndpoint(undefined, false, page), /SERVER_NOT_CONFIGURED/);
});
test("hidden or settings-paused presentation consumes IDs without replaying an audio backlog", () => {
  const stream = new GameStream();
  const event = { name: "fall" as const, id: 1, round: 1, tick: 60, actor: 0 };
  stream.acceptEvents([event], false);
  stream.acceptEvents([event]);
  assert.equal(stream.drain(1, 1000).length, 0);
  stream.setPresentationEnabled(false);
  stream.acceptEvents([{ ...event, id: 2 }]);
  stream.setPresentationEnabled(true);
  stream.acceptEvents([{ ...event, id: 2 }]);
  assert.equal(stream.drain(1, 1000).length, 0);
  stream.acceptEvents([{ ...event, id: 3 }]);
  stream.discardEvents();
  stream.acceptEvents([{ ...event, id: 3 }]);
  assert.equal(stream.drain(1, 1000).length, 0);
  stream.acceptEvents([{ ...event, id: 4 }]);
  assert.equal(stream.drain(1, 1000).length, 1);
});
/** TCP-like delivery: per-snapshot delay, never before the previous one; a stall holds everything. */
function playout(stallMs: number, jitter = 0) {
  const buffer = new SnapshotBuffer(),
    step = 1000 / 60,
    queue: { due: number; s: GameSnapshot }[] = [];
  let last = 0,
    maxSkip = 0,
    previous = -1,
    backwards = 0,
    beyondNewest = 0;
  for (let i = 0; i < 600; i++) {
    const now = i * step;
    if (i % 3 === 0) {
      let due = now + 40 + ((i * 7919) % 97) / 97 * jitter;
      if (stallMs && now + 40 >= 4000 && now + 40 < 4000 + stallMs)
        due = Math.max(due, 4000 + stallMs);
      last = Math.max(last, due);
      queue.push({ due: last, s: frame(i + 1, 600 + i) });
    }
    while (queue[0]?.due <= now) buffer.push(queue.shift()!.s, now);
    if (!buffer.sample(now)) continue;
    if (previous >= 0) {
      maxSkip = Math.max(maxSkip, buffer.renderMs - previous - step);
      if (buffer.renderMs < previous - 1e-9) backwards++;
    }
    if (buffer.renderMs > (buffer.latest!.snapshot.tick * 1000) / NET.physicsHz + 1e-9)
      beyondNewest++;
    previous = buffer.renderMs;
  }
  return { maxSkip, backwards, beyondNewest };
}
test("remote playout catches up after 300–800 ms stalls instead of skipping, never runs backwards or extrapolates", () => {
  for (const stall of [300, 500, 800]) {
    const r = playout(stall);
    assert.ok(r.maxSkip < 20, `${stall} ms stall: max one-frame skip ${r.maxSkip.toFixed(1)} ms (was ≈ stall − 117 ms)`);
    assert.equal(r.backwards, 0);
    assert.equal(r.beyondNewest, 0);
  }
  const jittery = playout(0, 80);
  assert.ok(jittery.maxSkip < 10, `0–80 ms jitter skip ${jittery.maxSkip.toFixed(1)} ms`);
  assert.equal(jittery.backwards, 0);
  const outage = playout(1500);
  assert.ok(outage.maxSkip > PLAYOUT.snapMs / 2, "a >1 s outage still snaps to the present");
  assert.equal(outage.backwards, 0);
});
test("playout clock restarts with a new round and after clear()", () => {
  const buffer = new SnapshotBuffer();
  buffer.push(frame(1, 600), 0);
  buffer.push(frame(2, 603), 50);
  buffer.sample(60);
  // Ticks are room-lifetime monotonic; a new round only resets the playout clock.
  buffer.push(frame(3, 900, 2), 5000);
  const sample = buffer.sample(5001)!;
  assert.equal(sample.a.snapshot.round, 2);
  assert.ok(Math.abs(buffer.renderMs - (15000 + 1 - NET.interpolationMs)) < 1e-6);
  buffer.clear();
  assert.equal(buffer.sample(6000), null);
  buffer.push(frame(4, 960, 2), 6000);
  buffer.sample(6000);
  assert.ok(Math.abs(buffer.renderMs - (16000 - NET.interpolationMs)) < 1e-6);
});
