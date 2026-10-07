import type { ClickWire } from "../../../../shared/party-lab/simulation/clickrace/wire";

/** Average counted presses per second over the time the lane raced. */
export const averageRate = (wire: ClickWire, lane: number) => (wire.time[lane] > 0 ? wire.clicks[lane] / (wire.time[lane] / 1000) : 0);

/** Lanes in finishing order: places first, then lane order for equal places. */
export function resultOrder(wire: ClickWire) {
  return wire.seats.map((_, lane) => lane).sort((a, b) => wire.places[a] - wire.places[b] || a - b);
}
