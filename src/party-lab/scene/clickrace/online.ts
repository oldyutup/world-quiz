import { CLICK_RACE as C } from "../../../../shared/party-lab/simulation/clickrace/config";
import type { ClickWire } from "../../../../shared/party-lab/simulation/clickrace/wire";
import type { AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import type { GameStream } from "../../network/gameStream";

/** Presses kept while the link refuses them (a long outage drops the oldest). */
const MAX_PENDING = 256;

/**
 * The client half of the click count: it stamps each press on its own clock (ms after
 * BAŞLA) and sends the stamps, so presses a slow link delivers in one burst keep their
 * real spacing on the server. Nothing here moves a car: positions come from the server.
 *
 * BAŞLA on this clock is the earliest `received − race clock` seen. A snapshot always
 * arrives after the server sent it, so the estimate is never earlier than BAŞLA itself and
 * a stamp never leads the server's clock; it only moves earlier, so stamps never go back.
 */
export class ClickRaceClient {
  private round = -1;
  private goAt = Infinity;
  private pending: number[] = [];
  /** Presses this client counted locally (shown at once, before the server confirms). */
  pressed = 0;
  observe(wire: ClickWire, round: number, received: number) {
    if (round !== this.round) {
      this.round = round;
      this.goAt = Infinity;
      this.pending = [];
      this.pressed = 0;
    }
    if (wire.phase !== "countdown") this.goAt = Math.min(this.goAt, received - wire.elapsed);
  }
  /** A press at `now`: kept only while this player is racing and BAŞLA has been seen. */
  press(now: number, racing: boolean) {
    if (!racing || !Number.isFinite(this.goAt)) return false;
    this.pending.push(Math.max(0, now - this.goAt));
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    this.pressed++;
    return true;
  }
  /** Sends the pending stamps oldest first; whatever `send` refuses waits for the next call. */
  flush(send: (stamps: number[]) => boolean) {
    while (this.pending.length) {
      const batch = this.pending.slice(0, C.maxStamps);
      if (!send(batch)) return;
      this.pending.splice(0, batch.length);
    }
  }
  get waiting() {
    return this.pending.length;
  }
}

/** One frame of a race to show: the counted state, the winning lane (−1 none/draw) and its round. */
export interface ClickFrame {
  wire: ClickWire;
  winner: number;
  round: number;
}
/** Where the arena's race comes from: the server (online) or a local game with bots. */
export interface ClickSource {
  /** This frame's race (online: the latest snapshot; local: steps the game unless paused). */
  frame(dt: number, paused: boolean): ClickFrame | null;
  /** A press now by this player; true when it counts toward their car. */
  press(now: number): boolean;
}

export interface ClickRaceOnline {
  stream: GameStream;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
}
/** Online: presses go to the server stamped; the race shown is the server's. */
export class OnlineClickSource implements ClickSource {
  readonly client = new ClickRaceClient();
  private wire: ClickWire | undefined;
  /** The arena refreshes this every render (the stream and sender it should use now). */
  constructor(public online: ClickRaceOnline, readonly round: number, readonly self: number) {}
  frame(): ClickFrame | null {
    const latest = this.online.stream.snapshots.latest,
      wire = latest?.snapshot.click;
    if (!latest || !wire || latest.snapshot.round !== this.round) return null;
    this.wire = wire;
    this.client.observe(wire, this.round, latest.received);
    this.client.flush((stamps) => !!this.online.sendInput({ x: 0, z: 0, jump: false, click: { seq: 0, round: this.round, stamps } }));
    return { wire, winner: wire.seats.indexOf(latest.snapshot.winner), round: this.round };
  }
  press(now: number) {
    return this.client.press(now, racing(this.wire, this.self));
  }
}
/** This lane is still racing (BAŞLA seen, not finished, not left). */
export const racing = (wire: ClickWire | undefined, lane: number) => !!wire && wire.phase === "racing" && lane >= 0 && wire.finish[lane] < 0 && !wire.out[lane];
