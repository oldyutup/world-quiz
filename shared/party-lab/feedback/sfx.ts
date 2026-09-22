import type { SfxName } from "./events.js";
export interface Recipe {
  frequency: number;
  end: number;
  duration: number;
  noise: number;
  gain: number;
  priority: 0 | 1 | 2;
  cooldown: number;
  wobble?: number;
  notes?: readonly number[];
}
const tone = (
  frequency: number,
  end: number,
  duration: number,
  noise: number,
  gain: number,
  priority: 0 | 1 | 2 = 1,
  cooldown = 0.07
): Recipe => ({ frequency, end, duration, noise, gain, priority, cooldown });
/** Original toy/rubber palette, expressed as tiny synthesis recipes. No samples. */
export const SFX: Record<SfxName, Recipe> = {
  punchSwing: tone(240, 110, 0.14, 0.7, 0.12, 1, 0.06),
  bodyHit: tone(155, 65, 0.19, 0.15, 0.28),
  headHit: { ...tone(490, 235, 0.24, 0.05, 0.23), wobble: 24 },
  limbHit: tone(270, 145, 0.09, 0.12, 0.12, 0),
  lightBump: tone(175, 95, 0.1, 0.1, 0.13, 0, 0.1),
  heavyBump: tone(125, 48, 0.26, 0.25, 0.28, 1, 0.12),
  floorFlop: tone(115, 48, 0.27, 0.45, 0.24, 1, 0.16),
  grab: tone(340, 155, 0.09, 0.25, 0.12, 1, 0.08),
  secondGrab: tone(230, 380, 0.13, 0.22, 0.17, 1, 0.08),
  gripBreak: tone(420, 140, 0.11, 0.32, 0.18, 1, 0.12),
  lift: { ...tone(140, 330, 0.33, 0.05, 0.12, 1, 1.2), wobble: 14 },
  release: tone(250, 180, 0.1, 0.65, 0.07, 0, 0.14),
  throw: tone(310, 80, 0.3, 0.8, 0.2, 1, 0.12),
  fall: { ...tone(350, 95, 0.45, 0.1, 0.17, 1, 0.15), wobble: 12 },
  knockout: { ...tone(420, 165, 0.55, 0.03, 0.23, 2, 0.12), wobble: 60 },
  recovery: { ...tone(170, 440, 0.3, 0.02, 0.16, 1, 0.14), wobble: 22 },
  jump: tone(140, 330, 0.15, 0.08, 0.14, 1, 0.08),
  landing: tone(150, 65, 0.15, 0.22, 0.16, 0, 0.12),
  countdown: tone(440, 410, 0.12, 0, 0.17, 2, 0.2),
  roundStart: {
    ...tone(400, 600, 0.45, 0.02, 0.22, 2, 0.3),
    notes: [1, 1.25, 1.5],
  },
  winner: {
    ...tone(330, 335, 1.45, 0, 0.22, 2, 1),
    notes: [1, 1.25, 1.5, 2, 1.5, 2],
  },
  draw: { ...tone(290, 255, 0.65, 0.03, 0.18, 2, 1), notes: [1, 1.06, 0.9] },
  uiClick: tone(450, 290, 0.055, 0.06, 0.085, 0, 0.045),
  uiConfirm: { ...tone(420, 520, 0.15, 0, 0.11, 1, 0.08), notes: [1, 1.25] },
  uiBack: tone(360, 240, 0.09, 0.02, 0.09, 0, 0.08),
};
