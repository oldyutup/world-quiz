import type { TowerWire } from "../../../../shared/party-lab/simulation/boxtower/wire";

/** Lanes in places order (ties in lane order). */
export const resultOrder = (wire: TowerWire) => wire.seats.map((_, lane) => lane).sort((a, b) => wire.places[a] - wire.places[b] || a - b);
/** "23,4 sn": a moment on the stacking clock. */
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1).replace(".", ",")} sn`;
