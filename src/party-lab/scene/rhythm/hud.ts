import type { RhythmWire } from "../../../../shared/party-lab/simulation/rhythm/wire";

/** Lanes top to bottom: this player's first, then the others in lane order. */
export const laneOrder = (count: number, self: number) => {
  const lanes = Array.from({ length: count }, (_, lane) => lane);
  return self >= 0 && self < count ? [self, ...lanes.filter((lane) => lane !== self)] : lanes;
};
/** Lanes in places order (ties in lane order). */
export const resultOrder = (wire: RhythmWire) => wire.seats.map((_, lane) => lane).sort((a, b) => wire.places[a] - wire.places[b] || a - b);
/** The combo's size: it grows with the combo, up to 1.7× at 40 and beyond. */
export const comboScale = (combo: number) => (1 + 0.7 * Math.min(1, Math.log2(1 + Math.max(0, combo)) / Math.log2(41))).toFixed(3);
