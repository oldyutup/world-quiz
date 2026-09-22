import type { InputPacket } from "../../../../shared/party-lab/network/protocol";
export const PREDICTION_LIMITS = {
  history: 48,
  replayTicks: 18,
  staleMs: 300,
} as const;
export interface PendingInput {
  packet: InputPacket;
  ticks: number;
  sentAt: number;
}
/** Bounded command history. Durations are local replay metadata, never server simulation instructions. */
export class InputHistory {
  records: PendingInput[] = [];
  lastSeq = -1;
  add(packet: InputPacket, ticks: number, sentAt: number) {
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
