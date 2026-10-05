import type { AudioManager } from '../../audio/AudioManager';
import type { Recipe } from '../../audio/sfx';
import { CRATE_RAIN as C, CRATE_SIZE, clamp } from './config';
import type { CrateRainGame, Warning } from './game';
export function warningPose(g: CrateRainGame, w: Warning) {
  const crate = w.spawned ? g.crates.find(c => c.id === w.id) : undefined;
  const at = crate?.body.translation() ?? { x: w.x, y: w.y + C.spawnHeight + CRATE_SIZE / 2 + Math.max(0, w.spawnAt - g.elapsed) * 2, z: w.z };
  const height = Math.max(0, at.y - CRATE_SIZE / 2 - w.y);
  const proximity = 1 - clamp(height / (C.spawnHeight + (w.spawnAt - w.since) * 2), 0, 1);
  return { at, height, proximity, size: CRATE_SIZE * (0.9 + proximity * 0.35), opacity: 0.20 + proximity * 0.46 };
}
const AIR: Recipe = { frequency: 480, end: 180, duration: 0.68, noise: 0.82, gain: 0.14, priority: 1, cooldown: 0.25 };
const NEAR: Recipe = { frequency: 290, end: 95, duration: 0.42, noise: 0.90, gain: 0.20, priority: 2, cooldown: 0.25 };
export class CrateWarningsAudio {
  private played = new Map<number, number>(); private round = -1; private last = -10;
  readonly stats = { started: 0, near: 0 };
  update(g: CrateRainGame, audio: AudioManager, listener: { x: number; y: number; z: number }) {
    if (g.round !== this.round || g.elapsed < this.last) { this.played.clear(); this.last = -10; this.round = g.round; }
    for (const id of this.played.keys()) if (!g.warnings.some(w => w.id === id)) this.played.delete(id);
    const warnings = g.warnings.filter(w => !w.landed).sort((a, b) => Math.hypot(a.x - listener.x, a.z - listener.z) - Math.hypot(b.x - listener.x, b.z - listener.z));
    for (const w of warnings) {
      const pose = warningPose(g, w), distance = Math.hypot(w.x - listener.x, w.z - listener.z), stage = pose.height < 4.5 ? 2 : 1;
      if (distance > 7 || (this.played.get(w.id) ?? 0) >= stage || g.elapsed - this.last < 0.28) continue;
      if (audio.playSpatial(stage === 1 ? 'crate-air' : 'crate-near', stage === 1 ? AIR : NEAR, { x: w.x, y: Math.min(pose.at.y, listener.y + 4), z: w.z }, { refDistance: 3, rolloff: 0.9, maxDistance: 15, spatial: 0.7, gain: distance < 2 ? 1 : 0.7 })) {
        this.played.set(w.id, stage); this.last = g.elapsed; if (stage === 1) this.stats.started++; else this.stats.near++;
      }
    }
  }
}
