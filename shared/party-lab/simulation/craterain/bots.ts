import { clamp, CRATE_PUNCH, FEET, IDLE, type Input } from './config.js';
export interface BotWarning { id: number; x: number; z: number; radius: number; since: number }
export interface BotSense {
  x: number; y: number; z: number; grounded: boolean; elapsed: number; half: number;
  /** ONLY warnings already displayed (including the warning for a visible falling box). */
  warnings: readonly BotWarning[];
  height: (x: number, z: number) => number;
  clear: (x: number, z: number, y: number) => boolean;
  /** Living rivals (centres); `open`: neither stunned nor guarded, so a punch can land. */
  rivals?: readonly { x: number; y: number; z: number; open: boolean }[];
  /** This bot's punch is ready (no swing, no cooldown). */
  canPunch?: boolean;
}
export class CrateBot {
  input = { ...IDLE }; nextThink = 0; reaction: number; lastX = 0; lastZ = 0; stuck = 0;
  constructor(readonly id: number, readonly random: () => number) { this.reaction = 0.16 + id * 0.035 + random() * 0.08; }
  think(s: BotSense): Input {
    if (s.elapsed < this.nextThink) return this.input;
    this.nextThink = s.elapsed + 0.10 + this.random() * 0.09;
    const dangers = s.warnings.filter(w => s.elapsed - w.since >= this.reaction);
    // The punch, like a player's: a rival in reach (not stunned or guarded), never while dodging a crate.
    const reach = CRATE_PUNCH.range * 0.88, aggression = this.id % 2 === 1 ? 1 : 0.55;
    const near = (s.rivals ?? []).filter(r => r.open && Math.abs(r.y - s.y) < CRATE_PUNCH.heightGap * 0.9)
      .map(r => ({ r, d: Math.hypot(r.x - s.x, r.z - s.z) })).sort((a, b) => a.d - b.d)[0];
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
      // A calm bot drifts toward a rival close by, looking for a punch.
      const hunt = !threatened && near && near.d < 3.5 ? aggression * Math.max(0, near.d - Math.hypot(near.r.x - x, near.r.z - z)) * 0.9 : 0;
      const score = -routeDanger -danger(x, z) - edge * 0.8 + climb + hunt + this.random() * (threatened ? 0.7 : 2.5);
      if (score > best) { best = score; chosen = { x, y, z }; }
    }
    this.stuck = Math.hypot(s.x - this.lastX, s.z - this.lastZ) < 0.12 ? this.stuck + 0.23 : 0;
    this.lastX = s.x; this.lastZ = s.z;
    const dx = chosen.x - s.x, dz = chosen.z - s.z, d = Math.hypot(dx, dz);
    this.input = { x: d > 0.2 ? dx / d : 0, z: d > 0.2 ? dz / d : 0,
      sprint: threatened || this.id % 2 === 1,
      jump: s.grounded && (chosen.y > s.y - FEET + 0.25 || this.stuck > 0.65), punch: false };
    if (!threatened && s.canPunch && near && near.d <= reach && this.random() < 0.35 + 0.35 * aggression) {
      // Face the rival and swing (held for this think: one press).
      const dx = near.r.x - s.x, dz = near.r.z - s.z, d = Math.max(1e-6, near.d);
      this.input = { ...this.input, x: dx / d, z: dz / d, punch: true };
      return this.input;
    }
    // Small, seeded hesitation. Stats and controller remain identical to the human.
    if (this.random() < 0.045) this.input = { ...IDLE };
    if (this.stuck > 1.2) { this.input.x = Math.sin(s.elapsed * 3 + this.id); this.input.z = Math.cos(s.elapsed * 3 + this.id); this.stuck = 0; }
    return this.input;
  }
}
