import {
  NET,
  TRANSFORM_BYTES,
  type GameSnapshot,
  type GameEvent,
} from "../../../shared/party-lab/network/protocol";
import { SFX_NAMES } from "../audio/events";
export interface BufferedSnapshot {
  snapshot: GameSnapshot;
  values: Float32Array;
  received: number;
}
export class SnapshotBuffer {
  frames: BufferedSnapshot[] = [];
  private sequence = -1;
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
    }
    this.sequence = snapshot.seq;
    this.frames.push({ snapshot, values, received: now });
    if (this.frames.length > 12) this.frames.shift();
    return true;
  }
  sample(now: number) {
    const latest = this.frames[this.frames.length - 1];
    if (!latest) return null;
    const end = (latest.snapshot.tick * 1000) / NET.physicsHz;
    this.renderMs = Math.min(
      end,
      Math.max(this.renderMs, end + now - latest.received - this.delayMs)
    );
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
  }
}
/** Events are never reconstructed from poses; IDs are monotonic for the room lifetime. */
export class GameStream {
  readonly snapshots = new SnapshotBuffer();
  private eventHead = 0;
  private events: GameEvent[] = [];
  private presentationEnabled = true;
  private localSwings = new Set<string>();
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
      if (visible && this.presentationEnabled) this.events.push(event);
    }
    if (this.events.length > 128)
      this.events.splice(0, this.events.length - 128);
  }
  drain(round: number, renderMs: number) {
    const ready: GameEvent[] = [];
    this.events = this.events.filter((e) => {
      if (e.round < round) return false;
      if (e.round === round && (e.tick * 1000) / NET.physicsHz <= renderMs) {
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
    this.presentationEnabled = true;
  }
}
