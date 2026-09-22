import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InputMailbox,
  NET,
  validateInput,
  TRANSFORM_BYTES,
  type GameSnapshot,
} from "../../../shared/party-lab/network/protocol";
import { GameStream, SnapshotBuffer } from "./gameStream";
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
  assert.ok(buffer.frames.length <= 12);
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
