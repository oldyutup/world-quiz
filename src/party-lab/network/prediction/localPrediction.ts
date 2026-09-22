import type { BufferedSnapshot } from "../gameStream";
import type {
  InputPacket,
  GameSnapshot,
} from "../../../../shared/party-lab/network/protocol";
import type { PlayerId } from "../../../../shared/party-lab/simulation/players";
import { PredictionRig } from "./rig";
import { InputHistory, PREDICTION_LIMITS, type PendingInput } from "./history";
import { RigCorrection } from "./correction";

export function canPredict(snapshot: GameSnapshot, slot: number) {
  return (
    snapshot.phase === "playing" &&
    !!(snapshot.mask & snapshot.alive & (1 << slot)) &&
    snapshot.states[slot] === 0 &&
    !snapshot.grips.some(
      (target, hand) =>
        target === slot || (Math.floor(hand / 2) === slot && target >= 0)
    )
  );
}
export class LocalPrediction {
  readonly rig;
  readonly history = new InputHistory();
  readonly correction = new RigCorrection();
  readonly metrics = {
    reconciliations: 0,
    corrections: 0,
    hard: 0,
    error: 0,
    totalError: 0,
    maxError: 0,
    steps: 0,
    replaySteps: 0,
    stepMs: 0,
    reconcileMs: 0,
    ackDelayMs: 0,
    overflows: 0,
  };
  active = false;
  lastAck = -1;
  private round = -1;
  private sequence = -1;
  private latest: BufferedSnapshot | null = null;
  private heldConstraint = false;
  private raw = new Float32Array(63);
  private visual = new Float32Array(63);
  constructor(readonly slot: PlayerId) {
    this.rig = new PredictionRig(slot);
  }
  private run(record: PendingInput) {
    let swing = false,
      jumped = false;
    const p = record.packet;
    for (let i = 0; i < record.ticks; i++) {
      const began = performance.now();
      const result = this.rig.step({
        x: p.moveX,
        z: p.moveZ,
        jump: i === 0 && p.jumpPressed,
        punch: i === 0 && p.punchPressed,
      });
      this.metrics.stepMs += performance.now() - began;
      this.metrics.steps++;
      if (!result.valid) return { valid: false, swing: false, jumped: false };
      swing ||= result.swing;
      jumped ||= result.jumped;
    }
    return { valid: true, swing, jumped };
  }
  reconcile(frame: BufferedSnapshot, now: number) {
    const s = frame.snapshot;
    if (s.seq <= this.sequence) return;
    const began = performance.now();
    this.sequence = s.seq;
    const newRound = this.round !== s.round;
    if (newRound) {
      this.suspend();
      this.round = s.round;
    }
    this.latest = frame;
    const ack = s.ack[this.slot];
    if (!Number.isSafeInteger(ack) || ack < this.lastAck) {
      this.suspend();
      return;
    }
    this.lastAck = ack;
    const acknowledged = this.history.acknowledge(ack);
    if (acknowledged.length) {
      const delay = now - acknowledged[acknowledged.length - 1].sentAt;
      this.metrics.ackDelayMs = this.metrics.ackDelayMs
        ? this.metrics.ackDelayMs * 0.8 + delay * 0.2
        : delay;
    }
    const wasActive = this.active;
    const before = this.pose(0)?.slice();
    if (
      !canPredict(s, this.slot) ||
      this.heldConstraint ||
      !this.rig.restore(s, frame.values)
    ) {
      this.active = false;
      this.history.clear();
      this.correction.clear();
      return;
    }
    this.active = true;
    for (const record of this.history.records) {
      if (!this.run(record).valid) {
        this.suspend();
        return;
      }
      this.metrics.replaySteps += record.ticks;
    }
    if (wasActive && before && !newRound) {
      const { error, tier } = this.correction.begin(
        before,
        this.rig.pose(this.raw)
      );
      this.metrics.error = error;
      this.metrics.totalError += error;
      this.metrics.maxError = Math.max(this.metrics.maxError, error);
      this.metrics.reconciliations++;
      if (tier !== "none") this.metrics.corrections++;
      if (tier === "hard") this.metrics.hard++;
    } else this.correction.clear();
    this.metrics.reconcileMs += performance.now() - began;
  }
  advance(packet: InputPacket, ticks: number, now: number) {
    this.heldConstraint = packet.grabHeld || packet.liftHeld;
    const frame = this.latest;
    if (
      !frame ||
      now - frame.received > PREDICTION_LIMITS.staleMs ||
      packet.round !== this.round
    ) {
      this.suspend();
      return null;
    }
    if (!canPredict(frame.snapshot, this.slot) || this.heldConstraint) {
      this.active = false;
      this.history.clear();
      this.correction.clear();
      return null;
    }
    if (!this.active) {
      if (!this.rig.restore(frame.snapshot, frame.values)) return null;
      this.active = true;
    }
    if (packet.seq <= this.history.lastSeq) return null;
    if (!this.history.add(packet, ticks, now)) {
      this.metrics.overflows++;
      this.suspend();
      return null;
    }
    const result = this.run(
      this.history.records[this.history.records.length - 1]
    );
    if (!result.valid) {
      this.metrics.hard++;
      this.suspend();
      return null;
    }
    return result;
  }
  pose(dt: number) {
    return this.active
      ? this.correction.apply(this.rig.pose(this.raw), dt, this.visual)
      : null;
  }
  suspend() {
    this.active = false;
    this.history.clear();
    this.correction.clear();
    this.latest = null;
    this.lastAck = -1;
    this.heldConstraint = false;
  }
  dispose() {
    this.suspend();
    this.rig.dispose();
  }
}
