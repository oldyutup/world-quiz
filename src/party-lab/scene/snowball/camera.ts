/** Mirrors the LOCAL Rooftop camera in ArenaScene's Playground effect.
 * Keep this local: extracting that inline effect would touch existing modes.
 * Same 12:14 elevation, origin target, 45° lens and narrow-viewport multiplier.
 * The 1.6 framing scale gives the 20 m disk and edge departures room to breathe.
 * No player/heading/phase/radius-over-time input: the view cannot orbit or follow.
 */
export function snowballArenaCamera(width: number, height: number) {
  const distance = 1.6 * Math.max(1, 1.5 / (Math.max(1, width) / Math.max(1, height)));
  return {
    position: [0, 12 * distance, 14 * distance] as const,
    target: [0, 0, 0] as const,
    fov: 45,
  };
}
