import type { AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
/**
 * The pending window must cover RTT + snapshot wait + jitter. At 300 ms / 18 ticks,
 * RTT 150 ms with 0–60 ms jitter already overflowed and RTT 200 + 80 ms suspended
 * prediction 19 times in 8 s, each time snapping the local rig back 1.3–1.7 m to the
 * delayed authoritative pose. 500 ms / 30 ticks measured zero suspends and ≤0.16 m
 * frame steps up to RTT 300 + 60 ms or RTT 150 + 150 ms jitter (≈20 replay ticks per
 * snapshot in the worst case, ~6–8 at a 70 ms RTT).
 */
export const PREDICTION_LIMITS = {
  history: 48,
  replayTicks: 30,
  staleMs: 500,
} as const;
export interface PendingInput {
  packet: AnyInputPacket;
  ticks: number;
  sentAt: number;
}
/** Bounded command history. Durations are local replay metadata, never server simulation instructions. */
export class InputHistory {
  records: PendingInput[] = [];
  lastSeq = -1;
  add(packet: AnyInputPacket, ticks: number, sentAt: number) {
    if (
      packet.seq <= this.lastSeq ||
      !Number.isInteger(ticks) ||
      ticks < 1 ||
      ticks > 3
    )
      return false;
    this.lastSeq = packet.seq;
    this.records.push({ packet: { ...packet }, ticks, sentAt });
    if (
      this.records.length > PREDICTION_LIMITS.history ||
      this.records.reduce((n, p) => n + p.ticks, 0) >
        PREDICTION_LIMITS.replayTicks
    ) {
      this.records = [];
      return false;
    }
    return true;
  }
  acknowledge(seq: number) {
    const acknowledged = this.records.filter((p) => p.packet.seq <= seq);
    this.records = this.records.filter((p) => p.packet.seq > seq);
    return acknowledged;
  }
  clear() {
    this.records = [];
    this.lastSeq = -1;
  }
}
