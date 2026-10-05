import { clamp, FEET, IDLE, type Input } from './config';
export interface BotWarning { id: number; x: number; z: number; radius: number; since: number }
export interface BotSense {
  x: number; y: number; z: number; grounded: boolean; elapsed: number; half: number;
  /** ONLY warnings already displayed (including the warning for a visible falling box). */
  warnings: readonly BotWarning[];
  height: (x: number, z: number) => number;
  clear: (x: number, z: number, y: number) => boolean;
}
export class CrateBot {
  input = { ...IDLE }; nextThink = 0; reaction: number; lastX = 0; lastZ = 0; stuck = 0;
  constructor(readonly id: number, readonly random: () => number) { this.reaction = 0.16 + id * 0.035 + random() * 0.08; }
  think(s: BotSense): Input {
    if (s.elapsed < this.nextThink) return this.input;
    this.nextThink = s.elapsed + 0.10 + this.random() * 0.09;
    const dangers = s.warnings.filter(w => s.elapsed - w.since >= this.reaction);
    const danger = (x: number, z: number) => dangers.reduce((sum, w) => sum + Math.max(0, w.radius + 1.0 - Math.max(Math.abs(x - w.x), Math.abs(z - w.z))) * 12, 0);
    let best = -Infinity, chosen = { x: s.x, z: s.z, y: s.y - FEET };
    const threatened = danger(s.x, s.z) > 0;
    // A dozen local samples, no navmesh or access to the scheduler's future RNG.
    for (let i = 0; i < 14; i++) {
      const angle = i * Math.PI * 2 / 13 + this.id * 0.4;
      const distance = i === 13 ? 0 : threatened ? 2.5 : 1.8;
      const x = clamp(s.x + Math.sin(angle) * distance, -s.half + 1.0, s.half - 1.0);
      const z = clamp(s.z + Math.cos(angle) * distance, -s.half + 1.0, s.half - 1.0);
      const y = s.height(x, z), rise = y - (s.y - FEET);
      if (rise > 1.65 || !s.clear(x, z, y + FEET + 0.06)) continue;
      const edge = Math.max(Math.abs(x), Math.abs(z)) / s.half;
      const climb = this.id % 2 === 0 ? clamp(rise, 0, 1.4) * 1.4 : -Math.max(0, rise) * 0.25;
      // Sample the route too: a safe destination behind a two-level wall is not an escape.
      let blocked = false, routeDanger = 0;
      for (const fraction of [.33, .66]) {
        const px = s.x + (x - s.x) * fraction, pz = s.z + (z - s.z) * fraction;
        if (s.height(px, pz) > s.y - FEET + 1.65) blocked = true;
        routeDanger += danger(px, pz) * .35;
      }
      if (blocked) continue;
      const score = -routeDanger -danger(x, z) - edge * 0.8 + climb + this.random() * (threatened ? 0.7 : 2.5);
      if (score > best) { best = score; chosen = { x, y, z }; }
    }
    this.stuck = Math.hypot(s.x - this.lastX, s.z - this.lastZ) < 0.12 ? this.stuck + 0.23 : 0;
    this.lastX = s.x; this.lastZ = s.z;
    const dx = chosen.x - s.x, dz = chosen.z - s.z, d = Math.hypot(dx, dz);
    this.input = { x: d > 0.2 ? dx / d : 0, z: d > 0.2 ? dz / d : 0,
      sprint: threatened || this.id % 2 === 1,
      jump: s.grounded && (chosen.y > s.y - FEET + 0.25 || this.stuck > 0.65), };
    // Small, seeded hesitation. Stats and controller remain identical to the human.
    if (this.random() < 0.045) this.input = { ...IDLE };
    if (this.stuck > 1.2) { this.input.x = Math.sin(s.elapsed * 3 + this.id); this.input.z = Math.cos(s.elapsed * 3 + this.id); this.stuck = 0; }
    return this.input;
  }
}
