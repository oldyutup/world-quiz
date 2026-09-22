import assert from "node:assert/strict";
import { test } from "node:test";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { OnlineRoundSimulation } from "../../../shared/party-lab/simulation/onlineRound";
import { capturePredictionState } from "../../../shared/party-lab/simulation/predictionState";
import {
  InputMailbox,
  type InputPacket,
  type GameSnapshot,
} from "../../../shared/party-lab/network/protocol";
import { SnapshotBuffer } from "./gameStream";
import { LocalPrediction } from "./prediction/localPrediction";

const step = 1000 / 60;
test("0/50/100/150 ms RTT: predicted movement/jump stays responsive, corrections bounded; compare 30 and 60 Hz", async () => {
  await initializePhysics();
  for (const inputHz of [30, 60])
    for (const rtt of [0, 50, 100, 150]) {
      const server = new OnlineRoundSimulation(),
        local = new LocalPrediction(0),
        remote = new SnapshotBuffer(),
        box = new InputMailbox();
      server.start([0, 1]);
      for (let i = 0; i < 360; i++) server.step([]);
      const snap = () => ({
        ...server.snapshot([box.processedSeq, -1, -1]),
        prediction: capturePredictionState(
          server.physics.players[0],
          server.combat.players[0]
        ),
      });
      remote.push(snap(), 0);
      local.reconcile(remote.latest!, 0);
      const up: { due: number; p: InputPacket }[] = [],
        down: { due: number; s: GameSnapshot }[] = [];
      let sequence = 0,
        predicted = -1,
        baseline = -1,
        serverResponse = -1,
        jumped = -1,
        maxPending = 0,
        bytes = 0,
        packets = 0;
      const start = 507,
        period = 60 / inputHz;
      let localOrigin = server.physics.players[0].body.translation().x,
        remoteOrigin = localOrigin,
        serverOrigin = localOrigin;
      const presentDown = (now: number) => {
        while (down[0]?.due <= now + 1e-6) {
          const item = down.shift()!;
          remote.push(item.s, now);
          local.reconcile(remote.latest!, now);
        }
      };
      try {
        for (let i = 0; i < 240; i++) {
          const now = i * step;
          presentDown(now);
          if (i % period === 0) {
            const p: InputPacket = {
              seq: ++sequence,
              round: 1,
              moveX: now >= start && now < 1100 ? 1 : 0,
              moveZ: 0,
              jumpPressed: i === 120,
              punchPressed: i === 132,
              grabHeld: false,
              liftHeld: false,
            };
            up.push({ due: now + rtt / 2, p });
            bytes += JSON.stringify(p).length;
            packets++;
            const result = local.advance(p, period, now);
            if (result?.jumped && jumped < 0) jumped = now;
          }
          while (up[0]?.due <= now + 1e-6) {
            const item = up.shift()!;
            box.accept(item.p, 1, now);
          }
          server.step([box.read(now)]);
          if (now < start)
            serverOrigin = server.physics.players[0].body.translation().x;
          if (
            now >= start &&
            serverResponse < 0 &&
            server.physics.players[0].body.translation().x >
              serverOrigin + 0.002
          )
            serverResponse = now;
          if (i % 3 === 0) down.push({ due: now + rtt / 2, s: snap() });
          presentDown(now);
          const pose = local.pose(1 / 60),
            sample = remote.sample(now);
          if (now < start && pose) localOrigin = pose[0];
          if (
            now >= start &&
            pose &&
            predicted < 0 &&
            pose[0] > localOrigin + 0.002
          )
            predicted = now;
          if (sample) {
            const x =
              sample.a.values[0] +
              (sample.b.values[0] - sample.a.values[0]) * sample.alpha;
            if (now < start) remoteOrigin = x;
            if (now >= start && baseline < 0 && x > remoteOrigin + 0.002)
              baseline = now;
          }
          maxPending = Math.max(maxPending, local.history.records.length);
          assert.ok(local.rig.valid());
        }
        const metrics = local.metrics;
        const result = {
          inputHz,
          rtt,
          predictedResponseMs: Math.round(predicted - start),
          baselineResponseMs: Math.round(baseline - start),
          serverResponseMs: Math.round(serverResponse - start),
          jumpResponseMs: Math.round(jumped - 2000),
          averageError:
            metrics.totalError / Math.max(1, metrics.reconciliations),
          maxError: metrics.maxError,
          corrections: metrics.corrections,
          hard: metrics.hard,
          maxPending,
          predictionStepMs: metrics.stepMs / metrics.steps,
          reconcileMs:
            metrics.reconcileMs / Math.max(1, metrics.reconciliations),
          inputBytesPerSecond: Math.round(bytes / 4),
          packets,
        };
        console.log(JSON.stringify(result));
        assert.ok(
          predicted >= start && predicted - start <= (inputHz === 60 ? 17 : 34)
        );
        assert.ok(Math.abs(jumped - 2000) < 0.001);
        assert.equal(metrics.hard, 0);
        assert.ok(metrics.maxError < 0.5);
        assert.ok(maxPending <= 18);
        assert.equal(server.combat.stats.punches, 1);
      } finally {
        local.dispose();
        server.dispose();
      }
    }
});
test("75 versus 100 ms remote buffering under ordered 0–80 ms delivery jitter", async () => {
  await initializePhysics();
  const s = new OnlineRoundSimulation();
  s.start([0, 1]);
  for (let i = 0; i < 180; i++) s.step([]);
  try {
    const base = s.snapshot([-1, -1, -1]),
      results = [];
    for (const delay of [75, 100]) {
      const buffer = new SnapshotBuffer(delay),
        queue: { due: number; s: GameSnapshot }[] = [];
      let lastDue = 0,
        holds = 0,
        frames = 0;
      for (let i = 0; i < 600; i++) {
        const now = i * step;
        if (i % 3 === 0) {
          lastDue = Math.max(
            lastDue + 1,
            now + [0, 15, 60, 25, 80][(i / 3) % 5]
          );
          queue.push({ due: lastDue, s: { ...base, seq: i + 1, tick: i + 1 } });
        }
        while (queue[0]?.due <= now) {
          const item = queue.shift()!;
          buffer.push(item.s, now);
        }
        const sample = buffer.sample(now);
        if (sample && i > 60) {
          frames++;
          if (buffer.renderMs >= buffer.latest!.snapshot.tick * step - 0.01)
            holds++;
        }
      }
      results.push({ delay, heldFrames: holds, frames });
    }
    console.log(JSON.stringify({ remoteInterpolation: results }));
    assert.ok(results[1].heldFrames <= results[0].heldFrames);
  } finally {
    s.dispose();
  }
});
