import type { BufferedSnapshot } from "../gameStream";
import {
  isBarnPacket,
  type AnyInputPacket,
  type GameSnapshot,
} from "../../../../shared/party-lab/network/protocol";
import type { PlayerId } from "../../../../shared/party-lab/simulation/players";
import type { GameMode } from "../../../../shared/party-lab/modes";
import type { WeaponKind } from "../../../../shared/party-lab/simulation/barn/weapons";
import { PredictionRig } from "./rig";
import { BarnPredictionRig, canPredictBarn } from "./barnRig";
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
/** A predicted local shot to present now (each weapon round at most once). */
export interface PredictedShot {
  kind: WeaponKind;
  spread: number;
  /** Tick within the input record it fired on (0 for a round a replay revealed late). */
  tick: number;
}
/**
 * Local articulated prediction and reconciliation for one mode. Rooftop Brawl uses the
 * rooftop rig and packet; Barn Shootout the barn rig (movement, aim-facing, sprint,
 * idle anchor, trap hold, stagger, punches and its own weapon cadence). History,
 * windows and correction tiers are shared and unchanged.
 */
export class LocalPrediction {
  readonly rig: PredictionRig | BarnPredictionRig;
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
  /**
   * Barn: rounds a reconciliation replay fired that were never presented (the timing
   * moved into an already-acknowledged record). The arena presents them once, late.
   */
  readonly lateShots: PredictedShot[] = [];
  /** Highest round presented for the current weapon life (see BarnPredictionRig.weaponLife). */
  private presented = { life: -1, round: 0 };
  private round = -1;
  private sequence = -1;
  private latest: BufferedSnapshot | null = null;
  private heldConstraint = false;
  private raw = new Float32Array(63);
  private visual = new Float32Array(63);
  constructor(readonly slot: PlayerId, readonly mode: GameMode = "rooftop_brawl") {
    this.rig = mode === "barn_shootout" ? new BarnPredictionRig(slot) : new PredictionRig(slot);
  }
  private run(record: PendingInput) {
    let swing = false,
      jumped = false;
    const shots: PredictedShot[] = [];
    const p = record.packet;
    for (let i = 0; i < record.ticks; i++) {
      const began = performance.now();
      let result: { valid: boolean; swing: boolean; jumped: boolean };
      if (this.rig instanceof BarnPredictionRig) {
        if (!isBarnPacket(p)) return { valid: false, swing: false, jumped: false, shots };
        const barn = this.rig.stepPacket(p, i === 0);
        if (barn.shot && this.present(barn.shot.life, barn.shot.round)) shots.push({ kind: barn.shot.kind, spread: barn.shot.spread, tick: i });
        result = barn;
      } else {
        if (isBarnPacket(p)) return { valid: false, swing: false, jumped: false, shots };
        result = this.rig.step({
          x: p.moveX,
          z: p.moveZ,
          jump: i === 0 && p.jumpPressed,
          punch: i === 0 && p.punchPressed,
        });
      }
      this.metrics.stepMs += performance.now() - began;
      this.metrics.steps++;
      if (!result.valid) return { valid: false, swing: false, jumped: false, shots };
      swing ||= result.swing;
      jumped ||= result.jumped;
    }
    return { valid: true, swing, jumped, shots };
  }
  /** Whether this weapon round is new to the screen (and mark it shown). */
  private present(life: number, round: number) {
    if (life === this.presented.life && round <= this.presented.round) return false;
    this.presented = { life, round };
    return true;
  }
  private predictable(snapshot: GameSnapshot) {
    return this.mode === "barn_shootout" ? canPredictBarn(snapshot, this.slot) : canPredict(snapshot, this.slot);
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
      !this.predictable(s) ||
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
      const replay = this.run(record);
      if (!replay.valid) {
        this.suspend();
        return;
      }
      // A replay can fire a round no first run showed (its timing moved): show it now.
      for (const shot of replay.shots) this.lateShots.push({ ...shot, tick: 0 });
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
  advance(packet: AnyInputPacket, ticks: number, now: number) {
    // Rooftop grips/lift are server-driven presentation; the barn has neither.
    this.heldConstraint = !isBarnPacket(packet) && (packet.grabHeld || packet.liftHeld);
    const frame = this.latest;
    if (
      !frame ||
      now - frame.received > PREDICTION_LIMITS.staleMs ||
      packet.round !== this.round
    ) {
      this.suspend();
      return null;
    }
    if (!this.predictable(frame.snapshot) || this.heldConstraint) {
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
