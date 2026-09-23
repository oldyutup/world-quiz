import {
  NET,
  TRANSFORM_BYTES,
  type GameSnapshot,
  type GameEvent,
} from "../../../shared/party-lab/network/protocol";
import { SFX_NAMES } from "../audio/events";
/**
 * Remote playout clock. The target is unchanged (latest arrival + elapsed − delay),
 * but the render clock follows it at a bounded rate instead of jumping: TCP
 * delivers a stall's snapshots as one burst, and jumping to the new target skipped
 * 180/380/680 ms of motion in one frame after 300/500/800 ms stalls. Following at
 * ≤2× turns that into a brief fast-forward (measured max step 13–17 ms), cut
 * ±80 ms jitter skips from 67 to 3 ms and held fewer frames. It never extrapolates
 * past the newest snapshot; outages longer than snapMs still snap.
 */
export const PLAYOUT = {
  followMs: 250, // rate = 1 + lag / followMs, clamped
  minRate: 0.5,
  maxRate: 2,
  snapMs: 1000,
  frames: 24, // 1.2 s at 20 Hz: enough history to catch up after snapMs
} as const;
export interface BufferedSnapshot {
  snapshot: GameSnapshot;
  values: Float32Array;
  received: number;
}
export class SnapshotBuffer {
  frames: BufferedSnapshot[] = [];
  private sequence = -1;
  private sampledAt = -1;
  renderMs = 0;
  constructor(readonly delayMs: number = NET.interpolationMs) {}
  get latest() {
    return this.frames[this.frames.length - 1];
  }
  push(snapshot: GameSnapshot, now: number) {
    if (
      !snapshot ||
      snapshot.v !== NET.version ||
      !Number.isSafeInteger(snapshot.seq) ||
      snapshot.seq <= this.sequence ||
      !Number.isSafeInteger(snapshot.tick) ||
      snapshot.tick < 0 ||
      !Number.isSafeInteger(snapshot.round) ||
      !(snapshot.transforms instanceof Uint8Array) ||
      snapshot.transforms.byteLength !== TRANSFORM_BYTES
    )
      return false;
    const last = this.frames[this.frames.length - 1];
    if (
      last &&
      (snapshot.tick < last.snapshot.tick ||
        snapshot.round < last.snapshot.round)
    )
      return false;
    const view = new DataView(
      snapshot.transforms.buffer,
      snapshot.transforms.byteOffset,
      snapshot.transforms.byteLength
    );
    const values = new Float32Array(TRANSFORM_BYTES / 4);
    for (let i = 0; i < values.length; i++) {
      values[i] = view.getFloat32(i * 4, true);
      if (!Number.isFinite(values[i])) return false;
    }
    if (
      !last ||
      snapshot.round !== last.snapshot.round ||
      snapshot.mask !== last.snapshot.mask
    ) {
      this.frames = [];
      this.renderMs = (snapshot.tick * 1000) / NET.physicsHz - this.delayMs;
      this.sampledAt = -1;
    }
    this.sequence = snapshot.seq;
    this.frames.push({ snapshot, values, received: now });
    if (this.frames.length > PLAYOUT.frames) this.frames.shift();
    return true;
  }
  sample(now: number) {
    const latest = this.frames[this.frames.length - 1];
    if (!latest) return null;
    const end = (latest.snapshot.tick * 1000) / NET.physicsHz;
    const target = Math.min(end, end + now - latest.received - this.delayMs);
    if (this.sampledAt < 0) this.renderMs = target;
    else {
      const dt = Math.max(0, Math.min(100, now - this.sampledAt));
      const lag = target - this.renderMs;
      if (lag > PLAYOUT.snapMs) this.renderMs = target;
      else
        this.renderMs += dt * Math.max(PLAYOUT.minRate, Math.min(PLAYOUT.maxRate, 1 + lag / PLAYOUT.followMs));
      this.renderMs = Math.min(this.renderMs, end);
    }
    this.sampledAt = now;
    while (
      this.frames.length > 2 &&
      (this.frames[1].snapshot.tick * 1000) / NET.physicsHz <= this.renderMs
    )
      this.frames.shift();
    const a = this.frames[0],
      b = this.frames[1] ?? a;
    const t0 = (a.snapshot.tick * 1000) / NET.physicsHz,
      t1 = (b.snapshot.tick * 1000) / NET.physicsHz;
    return {
      a,
      b,
      alpha:
        t1 === t0
          ? 1
          : Math.max(0, Math.min(1, (this.renderMs - t0) / (t1 - t0))),
    };
  }
  clear() {
    this.frames = [];
    this.sequence = -1;
    this.renderMs = 0;
    this.sampledAt = -1;
  }
}
/** A locally predicted shot waits this long for its server echo before it stops suppressing one. */
export const LOCAL_SHOT_MS = 1500;
const SHOT_NAMES = new Set(["shotgunFire", "smgFire"]);
/** Events are never reconstructed from poses; IDs are monotonic for the room lifetime. */
export class GameStream {
  readonly snapshots = new SnapshotBuffer();
  private eventHead = 0;
  private events: GameEvent[] = [];
  private presentationEnabled = true;
  private localSwings = new Set<string>();
  /**
   * Barn: shots the local player already presented from prediction (flash, tracer,
   * sound). Each suppresses the next confirmed echo of the same weapon from that slot.
   * Counted, not matched by input sequence: held SMG fire can land a tick apart on the
   * server, so an exact sequence would miss and duplicate the presentation.
   */
  private localShots: { slot: number; name: string; at: number }[] = [];
  /** Local predicted shot → confirmed echo (ms), most recent. */
  lastShotEchoMs = NaN;
  markLocalShot(slot: number, name: "shotgunFire" | "smgFire", now = performance.now()) {
    this.localShots.push({ slot, name, at: now });
    if (this.localShots.length > 32) this.localShots.shift();
  }
  markLocalSwing(round: number, slot: number, seq: number) {
    this.localSwings.add(`${round}:${slot}:${seq}`);
    if (this.localSwings.size > 64)
      this.localSwings.delete(this.localSwings.values().next().value!);
  }
  setPresentationEnabled(enabled: boolean) {
    this.presentationEnabled = enabled;
    if (!enabled) this.discardEvents();
  }
  discardEvents() {
    this.events = [];
  }
  acceptEvents(batch: GameEvent[], visible = true) {
    if (!Array.isArray(batch) || batch.length > 256) return;
    for (const event of batch) {
      if (
        !event ||
        !Number.isSafeInteger(event.id) ||
        event.id <= this.eventHead ||
        !SFX_NAMES.includes(event.name) ||
        !Number.isSafeInteger(event.tick) ||
        !Number.isSafeInteger(event.round)
      )
        continue;
      this.eventHead = event.id;
      if (
        event.name === "punchSwing" &&
        this.localSwings.delete(
          `${event.round}:${event.actor}:${event.inputSeq}`
        )
      )
        continue;
      if (SHOT_NAMES.has(event.name) && this.consumeLocalShot(event)) continue;
      if (visible && this.presentationEnabled) this.events.push(event);
    }
    if (this.events.length > 128)
      this.events.splice(0, this.events.length - 128);
  }
  private consumeLocalShot(event: GameEvent) {
    const now = performance.now();
    this.localShots = this.localShots.filter((s) => now - s.at < LOCAL_SHOT_MS);
    const i = this.localShots.findIndex((s) => s.slot === event.actor && s.name === event.name);
    if (i < 0) return false;
    this.lastShotEchoMs = now - this.localShots[i].at;
    this.localShots.splice(i, 1);
    return true;
  }
  /**
   * Events due on the remote playout timeline. `immediate` events (the local player's
   * own confirmed hits, damage, death) are released as soon as they arrive: they match
   * the HUD, which reads the newest snapshot, not the delayed remote timeline.
   */
  drain(round: number, renderMs: number, immediate?: (event: GameEvent) => boolean) {
    const ready: GameEvent[] = [];
    this.events = this.events.filter((e) => {
      if (e.round < round) return false;
      if (e.round === round && ((e.tick * 1000) / NET.physicsHz <= renderMs || immediate?.(e))) {
        ready.push(e);
        return false;
      }
      return true;
    });
    return ready;
  }
  clearPresentation() {
    this.snapshots.clear();
    this.events = [];
  }
  reset() {
    this.clearPresentation();
    this.eventHead = 0;
    this.localSwings.clear();
    this.localShots = [];
    this.lastShotEchoMs = NaN;
    this.presentationEnabled = true;
  }
}
