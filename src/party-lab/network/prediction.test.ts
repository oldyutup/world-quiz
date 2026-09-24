import { restore } from "../../../shared/party-lab/simulation/ragdoll/character";
import { impact } from "../../../shared/party-lab/simulation/combat/knockout";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { OnlineRoundSimulation } from "../../../shared/party-lab/simulation/onlineRound";
import { capturePredictionState } from "../../../shared/party-lab/simulation/predictionState";
import {
  InputMailbox,
  type InputPacket,
  type GameSnapshot,
} from "../../../shared/party-lab/network/protocol";
import { LocalPrediction, canPredict } from "./prediction/localPrediction";
import { InputHistory, PREDICTION_LIMITS } from "./prediction/history";
import { RigCorrection, correctionTier } from "./prediction/correction";
import {
  GameStream,
  SnapshotBuffer,
  type BufferedSnapshot,
} from "./gameStream";
import { PARTS } from "../../../shared/party-lab/simulation/ragdoll/config";

before(() => initializePhysics());
const packet = (
  seq: number,
  values: Partial<InputPacket> = {}
): InputPacket => ({
  seq,
  round: 1,
  moveX: 0,
  moveZ: 0,
  jumpPressed: false,
  punchPressed: false,
  grabHeld: false,
  liftHeld: false,
  ...values,
});
function fixture() {
  const server = new OnlineRoundSimulation();
  server.start([0, 1]);
  for (let i = 0; i < 360; i++) server.step([]);
  const local = new LocalPrediction(0);
  return {
    server,
    local,
    close() {
      local.dispose();
      server.dispose();
    },
  };
}
function frame(
  server: OnlineRoundSimulation,
  ack = -1,
  now = 0
): BufferedSnapshot {
  const s: GameSnapshot = {
    ...server.snapshot([ack, -1, -1]),
    prediction: capturePredictionState(
      server.physics.players[0],
      server.combat.players[0]
    ),
  };
  const buffer = new SnapshotBuffer();
  assert.ok(buffer.push(s, now));
  return buffer.latest!;
}
test("mailbox acknowledges consumed inputs, not merely received ones; punch keeps its originating sequence", () => {
  const box = new InputMailbox();
  box.accept(packet(1, { punchPressed: true }), 1, 0);
  assert.equal(box.processedSeq, -1);
  box.accept(packet(2), 1, 20);
  assert.equal(box.processedSeq, -1);
  assert.equal(box.read(21).punch, true);
  assert.equal(box.processedSeq, 2);
  assert.equal(box.processedPunchSeq, 1);
  assert.equal(box.processedRound, 1);
  assert.equal(box.read(22).punch, false);
  assert.equal(box.processedPunchSeq, -1);
  box.accept(packet(3, { jumpPressed: true }), 1, 40);
  assert.equal(box.processedSeq, 2);
  box.read(400);
  assert.equal(
    box.processedSeq,
    2,
    "stale unconsumed input is not acknowledged as processed"
  );
});
test("bounded history removes acknowledged records and retains later input exactly once", () => {
  const history = new InputHistory();
  history.add(packet(1), 1, 0);
  history.add(packet(2), 2, 16);
  history.add(packet(3), 1, 33);
  assert.equal(history.add(packet(3), 1, 40), false);
  assert.equal(history.records.length, 3);
  assert.deepEqual(
    history.acknowledge(2).map((p) => p.packet.seq),
    [1, 2]
  );
  assert.deepEqual(
    history.records.map((p) => p.packet.seq),
    [3]
  );
  for (let i = 4; i < 100; i++) history.add(packet(i), 1, i * 16);
  assert.ok(history.records.length <= PREDICTION_LIMITS.replayTicks);
  history.clear();
  assert.equal(history.records.length, 0);
});
test("correction tiers converge, preserve rig geometry and hard-correct invalid/large errors", () => {
  assert.equal(correctionTier(0), "none");
  assert.equal(correctionTier(0.01), "tiny");
  assert.equal(correctionTier(0.1), "small");
  assert.equal(correctionTier(0.6), "medium");
  assert.equal(correctionTier(1.01), "hard");
  assert.equal(correctionTier(NaN), "hard");
  const pose = new Float32Array(63);
  for (let i = 0; i < 9; i++) {
    pose[i * 7] = i * 0.1;
    pose[i * 7 + 6] = 1;
  }
  for (const amount of [0, 0.01, 0.1, 0.6, 1.5]) {
    const before = pose.slice();
    for (let i = 0; i < 63; i += 7) before[i] += amount;
    const smoothing = new RigCorrection(),
      result = smoothing.begin(before, pose);
    assert.equal(result.tier, correctionTier(amount));
    const halfway = smoothing.apply(pose, 0.03);
    assert.ok(
      Math.abs(halfway[7] - halfway[0] - (pose[7] - pose[0])) < 1e-6,
      "coherent whole-rig translation"
    );
    const settled = smoothing.apply(pose, 0.3);
    assert.deepEqual(settled, pose);
    assert.equal(smoothing.active, false);
  }
});
test("everyday corrections ease in and a following one continues the motion; medium keeps the quadratic", () => {
  const rest = new Float32Array(63);
  for (let i = 0; i < 9; i++) {
    rest[i * 7] = i * 0.1;
    rest[i * 7 + 6] = 1;
  }
  const shifted = (dx: number) => {
    const p = rest.slice();
    for (let i = 0; i < 63; i += 7) p[i] += dx;
    return p;
  };
  // A one-tick slip at walking speed (77 mm), then the next snapshot finds 26 mm more.
  const smoothing = new RigCorrection();
  assert.equal(smoothing.begin(shifted(0.077), rest).tier, "small");
  const drawn = [0.077];
  for (let f = 0; f < 3; f++) drawn.push(smoothing.apply(rest, 1 / 60)[0] - rest[0]);
  const before = smoothing.apply(rest, 0).slice();
  const after = shifted(-0.026);
  smoothing.begin(before, after);
  for (let f = 0; f < 12; f++) drawn.push(smoothing.apply(after, 1 / 60)[0] - rest[0]);
  const steps = drawn.slice(1).map((x, i) => x - drawn[i]);
  // The quadratic moved 26% of a walking step (77 mm) on the first frame.
  assert.ok(Math.abs(steps[0]) < 0.006, `onset ${steps[0]}`);
  // Frame-to-frame change of the correction's own motion: 20 mm at the quadratic's onset.
  const jumps = [Math.abs(steps[0]), ...steps.slice(1).map((d, i) => Math.abs(d - steps[i]))];
  assert.ok(Math.max(...jumps) < 0.008, `largest frame-to-frame change ${Math.max(...jumps)}`);
  assert.ok(Math.abs(smoothing.apply(after, 0.3)[0] - after[0]) < 1e-9, "settles on the new pose");
  assert.equal(smoothing.active, false);
  // Medium (stall recovery): unchanged quadratic ease.
  const medium = new RigCorrection();
  assert.equal(medium.begin(shifted(0.6), rest).tier, "medium");
  const eased = medium.apply(rest, 0.03)[0] - rest[0];
  assert.ok(Math.abs(eased - 0.6 * (1 - 0.03 / 0.18) ** 2) < 1e-6);
});
test("one-tick acknowledgement flips while walking barely change the drawn step", () => {
  // Inputs reaching the server right at its tick boundary: the acknowledgement alternates
  // between two inputs while the server has run the same ticks, so snapshots read one tick
  // (77 mm at walking speed) ahead, then behind (measured up to 8–9 a second while walking).
  const rest = new Float32Array(63);
  for (let i = 0; i < 9; i++) {
    rest[i * 7] = i * 0.1;
    rest[i * 7 + 6] = 1;
  }
  const at = (x: number) => {
    const p = rest.slice();
    for (let i = 0; i < 63; i += 7) p[i] += x;
    return p;
  };
  const step = 0.077;
  const worst = (flips: (snapshot: number) => boolean) => {
    const smoothing = new RigCorrection();
    let slip = 0;
    const drawn: number[] = [];
    for (let f = 1, snapshot = 0; f <= 150; f++) {
      if (f % 3 === 0 && flips(++snapshot)) {
        const before = smoothing.apply(at((f - 1) * step + slip), 0).slice();
        slip = slip ? 0 : step;
        smoothing.begin(before, at((f - 1) * step + slip));
      }
      drawn.push(smoothing.apply(at(f * step + slip), 1 / 60)[0] - rest[0]);
    }
    const steps = drawn.slice(30).map((x, i) => x - drawn[29 + i]);
    return Math.max(...steps.map((s) => Math.abs(s - step) / step));
  };
  // Eased over 60/120 ms these moved the body 22% faster or slower than the walk.
  assert.ok(worst((n) => n % 2 === 0) < 0.05, `flip every other snapshot: ${worst((n) => n % 2 === 0)}`);
  assert.ok(worst(() => true) < 0.05, `flip every snapshot: ${worst(() => true)}`);
  // A lasting one-tick shift still settles, gently (21% before).
  assert.ok(worst((n) => n === 10) < 0.1, `single shift: ${worst((n) => n === 10)}`);
});
test("articulated prediction uses nine bodies/eight joints; unacknowledged movement replays after restoration", () => {
  const f = fixture();
  try {
    const base = frame(f.server);
    f.local.reconcile(base, 0);
    assert.equal(f.local.rig.world.bodies.len(), 9);
    assert.equal(f.local.rig.world.impulseJoints.len(), 8);
    for (let i = 1; i <= 6; i++)
      f.local.advance(packet(i, { moveX: 1 }), 1, (i * 1000) / 60);
    const before = f.local.rig.pose();
    assert.ok(before[0] > base.values[0] + 0.1);
    const update = frame(f.server, -1, 100);
    f.local.reconcile(update, 100);
    assert.equal(f.local.history.records.length, 6);
    assert.equal(f.local.metrics.replaySteps, 6);
    assert.ok(Math.abs(f.local.rig.pose()[0] - before[0]) < 0.12);
    for (let i = 0; i < 6; i++) f.server.step([{ x: 1, z: 0, jump: false }]);
    f.local.reconcile(frame(f.server, 6, 110), 110);
    assert.equal(f.local.history.records.length, 0);
    assert.ok(f.local.rig.valid());
  } finally {
    f.close();
  }
});
test("jump predicts once, accepted jump reconciles, and rejected jump converges without replaying an acknowledged edge", () => {
  const f = fixture();
  try {
    f.local.reconcile(frame(f.server), 0);
    const y0 = f.local.rig.character.body.translation().y;
    const command = packet(1, { jumpPressed: true });
    assert.equal(f.local.advance(command, 1, 16)?.jumped, true);
    assert.ok(f.local.rig.character.body.translation().y > y0);
    assert.equal(f.local.advance(command, 1, 17), null);
    f.server.step([{ x: 0, z: 0, jump: true }]);
    f.local.reconcile(frame(f.server, 1, 30), 30);
    assert.equal(f.local.history.records.length, 0);
    assert.ok(f.local.rig.character.jumpIn > 0);
    f.local.suspend();
    f.server.combat.reset();
    f.server.physics.reset();
    for (let i = 0; i < 180; i++) f.server.step([]);
    f.local.reconcile(frame(f.server, 1, 40), 40);
    assert.equal(
      f.local.advance(packet(2, { jumpPressed: true }), 1, 56)?.jumped,
      true
    );
    const grounded = frame(f.server, 2, 70);
    f.local.reconcile(grounded, 70);
    assert.equal(f.local.history.records.length, 0);
    assert.equal(f.local.rig.character.jumpIn, 0);
    const result = f.local.pose(0.3)!;
    assert.ok(Math.abs(result[1] - grounded.values[1]) < 1e-5);
  } finally {
    f.close();
  }
});
test("KO/daze/recovery, incoming/outgoing grips, held grab/lift and elimination disable locomotion prediction", () => {
  const f = fixture();
  try {
    const base = frame(f.server);
    for (const state of [1, 2, 3])
      assert.equal(
        canPredict({ ...base.snapshot, states: [state, 0, 0] }, 0),
        false
      );
    assert.equal(canPredict({ ...base.snapshot, alive: 2 }, 0), false);
    for (const grips of [
      [1, -1, -1, -1, -1, -1],
      [-1, -1, 0, -1, -1, -1],
    ])
      assert.equal(canPredict({ ...base.snapshot, grips }, 0), false);
    f.local.reconcile(base, 0);
    f.local.advance(packet(1, { moveX: 1 }), 1, 16);
    const ko = frame(f.server, 1, 30);
    ko.snapshot.states[0] = 2;
    f.local.reconcile(ko, 30);
    assert.equal(f.local.active, false);
    assert.equal(f.local.history.records.length, 0);
    assert.equal(f.local.pose(0.02), null);
    f.local.reconcile(frame(f.server, 1, 40), 40);
    f.local.advance(packet(2, { grabHeld: true, liftHeld: true }), 1, 56);
    assert.equal(f.local.active, false);
    assert.equal(f.local.history.records.length, 0);
  } finally {
    f.close();
  }
});
test("disconnect, stale snapshots and new rounds clear history/smoothing; reconnect reseeds only from fresh authority", () => {
  const f = fixture();
  try {
    const initial = frame(f.server);
    f.local.reconcile(initial, 0);
    f.local.advance(packet(1, { moveX: 1 }), 1, 16);
    f.local.suspend();
    assert.equal(f.local.lastAck, -1);
    assert.equal(f.local.history.records.length, 0);
    assert.equal(f.local.correction.active, false);
    f.local.reconcile(initial, 20);
    assert.equal(
      f.local.active,
      false,
      "old snapshot cannot restart after disconnect"
    );
    f.local.reconcile(frame(f.server, 1, 30), 30);
    assert.equal(f.local.active, true);
    assert.equal(f.local.history.records.length, 0);
    const stale = 30 + PREDICTION_LIMITS.staleMs + 50;
    f.local.advance(packet(2, { moveX: 1 }), 1, stale);
    assert.equal(f.local.active, false, "stale snapshot freezes prediction");
    const spawn = frame(f.server, -1, stale + 10);
    spawn.snapshot.round = 2;
    f.local.reconcile(spawn, stale + 10);
    assert.equal(f.local.lastAck, -1);
    assert.equal(f.local.history.records.length, 0);
    assert.equal(f.local.correction.active, false);
    assert.ok(Math.abs(f.local.pose(0)![0] - spawn.values[0]) < 1e-6);
  } finally {
    f.close();
  }
});
test("large displacement restores all limbs, velocities and valid joints together", () => {
  const f = fixture();
  try {
    f.local.reconcile(frame(f.server), 0);
    for (const name of PARTS) {
      const body = f.local.rig.character.parts[name].body,
        p = body.translation();
      body.setTranslation({ x: p.x + 3, y: p.y, z: p.z }, true);
    }
    const authoritative = frame(f.server, -1, 50);
    f.local.reconcile(authoritative, 50);
    assert.equal(f.local.metrics.hard, 1);
    assert.equal(f.local.correction.active, false);
    assert.ok(f.local.rig.valid());
    for (let i = 0; i < 63; i++)
      assert.ok(Math.abs(f.local.pose(0)![i] - authoritative.values[i]) < 1e-5);
  } finally {
    f.close();
  }
});
test("speculative punch is only a physical swing; replay is silent and exact authoritative swing is deduplicated", () => {
  const f = fixture(),
    stream = new GameStream();
  try {
    f.local.reconcile(frame(f.server), 0);
    const command = packet(1, { punchPressed: true });
    assert.equal(f.local.advance(command, 1, 16)?.swing, true);
    stream.markLocalSwing(1, 0, 1);
    f.local.reconcile(frame(f.server, -1, 50), 50);
    assert.equal(f.local.history.records.length, 1);
    const events = [
      {
        id: 1,
        round: 1,
        tick: 60,
        actor: 0,
        inputSeq: 1,
        name: "punchSwing" as const,
      },
      { id: 2, round: 1, tick: 60, actor: 0, name: "bodyHit" as const },
      { id: 3, round: 1, tick: 60, actor: 1, name: "fall" as const },
    ];
    stream.acceptEvents([...events, ...events]);
    assert.deepEqual(
      stream.drain(1, 1000).map((e) => e.name),
      ["bodyHit", "fall"]
    );
    stream.acceptEvents([
      { id: 4, round: 2, tick: 120, actor: 1, name: "fall" },
    ]);
    assert.deepEqual(
      stream.drain(2, 2000).map((e) => e.name),
      ["fall"]
    );
    assert.equal(
      f.server.combat.stats.hits,
      0,
      "no speculative server contact"
    );
  } finally {
    f.close();
  }
});

test("authoritative player collision correction converges and real KO/grab authority overrides prediction", () => {
  const f = fixture();
  try {
    const move = (player: 0 | 1, z: number) => {
      const character = f.server.physics.players[player],
        original = character.body.translation();
      for (const name of PARTS) {
        const body = character.parts[name].body,
          p = body.translation();
        body.setTranslation(
          { x: p.x - original.x, y: p.y, z: p.z - original.z + z },
          true
        );
      }
    };
    move(0, 1);
    move(1, 2.1);
    for (let i = 0; i < 90; i++) f.server.step([]);
    let seq = 0,
      now = 0;
    for (let i = 0; i < 180; i++) {
      now = (i * 1000) / 60;
      const p = packet(++seq, { moveZ: i < 35 ? 1 : 0 });
      f.local.advance(p, 1, now);
      f.server.step([{ x: 0, z: p.moveZ, jump: false }]);
      if (i % 3 === 0) f.local.reconcile(frame(f.server, seq, now), now);
      f.local.pose(1 / 60);
      assert.ok(f.local.rig.valid());
    }
    const last = frame(f.server, seq, now);
    f.local.reconcile(last, now);
    assert.ok(
      Math.hypot(
        f.local.pose(0.3)![0] - last.values[0],
        f.local.pose(0)![2] - last.values[2]
      ) < 0.001
    );
    // Actual grip acquisition runs only on authority; its snapshot gates prediction.
    f.server.combat.reset();
    f.server.physics.reset();
    restore(f.server.physics.players[0], { x: 0, y: 1, z: 1.85 }, 0);
    restore(f.server.physics.players[1], { x: 0, y: 1, z: 1 }, 0);
    for (let i = 0; i < 180; i++) f.server.step([]);
    for (let i = 0; i < 65; i++)
      f.server.step([
        { x: 0, z: 0, jump: false },
        { x: 0, z: 0, jump: false, grab: true },
      ]);
    assert.ok(f.server.combat.grips.count(1) > 0);
    f.local.reconcile(frame(f.server, seq, now + 50), now + 50);
    assert.equal(f.local.active, false);
    f.server.combat.grips.clear();
    impact(f.server.combat.players[0].condition, 100);
    f.local.reconcile(frame(f.server, seq, now + 100), now + 100);
    assert.equal(f.local.active, false);
    assert.equal(f.local.history.records.length, 0);
    assert.ok(f.local.rig.valid());
  } finally {
    f.close();
  }
});
test("invalid authoritative velocity/pose data cannot poison the local articulated world", () => {
  const f = fixture();
  try {
    f.local.reconcile(frame(f.server), 0);
    const broken = frame(f.server, -1, 50);
    new DataView(broken.snapshot.prediction!.velocities.buffer).setFloat32(
      0,
      NaN,
      true
    );
    f.local.reconcile(broken, 50);
    assert.equal(f.local.active, false);
    assert.ok(f.local.rig.valid());
    f.local.reconcile(frame(f.server, -1, 100), 100);
    assert.equal(f.local.active, true);
  } finally {
    f.close();
  }
});

test("drawn local pose interpolates between the last two predicted ticks: even steps whatever the frame/tick phase", () => {
  const f = fixture();
  try {
    const close = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a).every((v, i) => Math.abs(v - b[i]) < 1e-6);
    f.local.reconcile(frame(f.server), 0);
    assert.ok(close(f.local.pose(0, 0.3)!.slice(), f.local.pose(0, 1)!), "nothing to interpolate from right after a restore");
    // Straight back from the spawn, clear of the other player and the deck (~3 m).
    const input = { x: 0, z: -1, jump: false };
    let seq = 0,
      now = 0;
    // The server runs the same ticks and acknowledges every third frame (as in play).
    const run = (ticks: number, n: number) => {
      f.local.advance(packet(++seq, { moveZ: -1 }), ticks, now);
      for (let i = 0; i < ticks; i++) f.server.step([input]);
      if (n % 3 === 0) f.local.reconcile(frame(f.server, seq, now), now);
    };
    for (let n = 0; n < 20; n++, now += 1000 / 60) run(1, n);
    // At alpha 1 the newest tick is drawn (the arenas' old presentation), once any
    // reconciliation blend has settled.
    f.local.pose(0.3, 1);
    assert.equal(f.local.correction.active, false);
    assert.ok(close(f.local.pose(0, 1)!, f.local.rig.pose()));
    assert.ok(!close(f.local.pose(0, 0.5)!, f.local.rig.pose()), "half a tick back while moving");
    // A steady 60 Hz display with the tick phase on the boundary: the frame's clock reading
    // wanders ±0.8 ms, so frames run 0, 1 or 2 ticks (as measured in the arenas).
    const drawn: number[] = [],
      newest: number[] = [],
      dts: number[] = [];
    let acc = 0,
      jitter = 0;
    for (let n = 0; n < 30; n++) {
      const next = (n % 3 === 0 ? 0.8 : n % 3 === 1 ? -0.8 : 0.3) / 1000;
      const dt = 1 / 60 + next - jitter;
      jitter = next;
      dts.push(dt);
      now += dt * 1000;
      acc += dt;
      const ticks = acc + 1e-6 >= 1 / 60 ? Math.min(3, Math.floor((acc + 1e-6) * 60)) : 0;
      if (ticks > 0) {
        acc -= ticks / 60;
        run(ticks, n);
      }
      drawn.push(f.local.pose(dt, Math.min(1, acc * 60))![2]);
      newest.push(f.local.rig.pose()[2]);
    }
    // Speed on screen: each frame's step over that frame's time.
    const steps = (xs: number[]) => xs.slice(1).map((x, i) => (xs[i] - x) / dts[i + 1]);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
    // A step far from its neighbourhood's (the body is still speeding up a little).
    const irregular = (xs: number[]) => {
      const s = steps(xs);
      return s.filter((d, i) => {
        const m = median(s.slice(Math.max(0, i - 3), i + 4));
        return d < 0.4 * m || d > 1.6 * m;
      }).length;
    };
    assert.ok(irregular(newest) > 10, `the newest tick alone judders (${irregular(newest)} irregular frames)`);
    assert.equal(irregular(drawn), 0, "interpolated drawing steps evenly");
    assert.ok(f.local.rig.valid());
  } finally {
    f.close();
  }
});
