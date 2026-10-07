import type { GoldKind } from "../../../../shared/party-lab/simulation/goldminer/config";
import { itemKind, itemState, type GoldWire } from "../../../../shared/party-lab/simulation/goldminer/wire";

export const KIND_NAMES: Readonly<Record<GoldKind, string>> = { small: "küçük altın", big: "büyük altın", rock: "taş", diamond: "elmas", sack: "çuval" };
/** Lanes in places order: places first, then lane order for equal places. */
export function resultOrder(wire: GoldWire) {
  return wire.seats.map((_, lane) => lane).sort((a, b) => wire.places[a] - wire.places[b] || a - b);
}
/** What `lane` brought up, by kind ("2 büyük altın, 1 elmas"), most valuable first; "—" for nothing. */
export function finds(wire: GoldWire, lane: number) {
  const counts = new Map<GoldKind, number>();
  wire.kind.forEach((_, i) => {
    if (wire.by[i] === lane && itemState(wire, i) === "banked") counts.set(itemKind(wire, i), (counts.get(itemKind(wire, i)) ?? 0) + 1);
  });
  const order: GoldKind[] = ["diamond", "big", "sack", "small", "rock"];
  const text = order.filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${KIND_NAMES[k]}`);
  return text.length ? text.join(", ") : "—";
}
/** Items still in the mine (free or on their way up). */
export const itemsLeft = (wire: GoldWire) => wire.state.filter((_, i) => ["free", "carried"].includes(itemState(wire, i))).length;
