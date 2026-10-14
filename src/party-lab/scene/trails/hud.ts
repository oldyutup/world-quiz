import { LIGHT_TRAILS as L } from "../../../../shared/party-lab/simulation/trails/config";
import { HEAD, LEFT, NONE, SELF, TRAIL, TRAIN, WALL } from "../../../../shared/party-lab/simulation/trails/game";
import type { TrailWire } from "../../../../shared/party-lab/simulation/trails/wire";

/** Lanes in places order (ties in lane order). */
export const resultOrder = (wire: TrailWire) => wire.seats.map((_, lane) => lane).sort((a, b) => wire.places[a] - wire.places[b] || a - b);
/** Seconds of play left at `step`. */
export const secondsLeft = (wire: TrailWire, step: number) => Math.max(0, wire.limit - step / L.hz);
/** Why a lane is out, in a few words (`names[lane]` for whose trail or head). */
export function causeText(wire: TrailWire, lane: number, names: readonly string[]) {
  const by = wire.by[lane],
    who = by >= 0 ? (names[by] ?? "?") : "?";
  switch (wire.cause[lane]) {
    case WALL:
      return "Duvara çarptı";
    case TRAIL:
      return `İze çarptı (${who})`;
    case SELF:
      return "Kendi izine çarptı";
    case HEAD:
      return `Kafa kafaya (${who})`;
    case TRAIN:
      return "Tren çarptı";
    case LEFT:
      return "Ayrıldı";
    case NONE:
    default:
      return "";
  }
}
/** "23,4 sn": when a lane went out, in seconds of play. */
export const outAt = (wire: TrailWire, lane: number) => `${(Math.max(0, wire.died[lane]) / L.hz).toFixed(1).replace(".", ",")} sn`;
