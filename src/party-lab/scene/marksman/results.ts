import type { MarksmanWire } from "../../../../shared/party-lab/simulation/marksman/wire";

/** Lanes in places order (ties in lane order). */
export const resultOrder = (wire: MarksmanWire) => wire.seats.map((_, lane) => lane).sort((a, b) => wire.places[a] - wire.places[b] || a - b);
/** "+5", "−5", "0": a score as shown. */
export const points = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");
/** "−12" with a real minus sign, "34" otherwise. */
export const scoreText = (n: number) => (n < 0 ? `−${-n}` : `${n}`);
