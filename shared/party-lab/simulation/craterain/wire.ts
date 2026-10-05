import RAPIER from '@dimforge/rapier3d-compat';
import { CrateRainGame, type CratePhase } from './game.js';
import { BOX_KINDS, CRATE_SIZE, CRATE_RAIN as C } from './config.js';
export interface CrateWire {
  seats: number[]; seed: number; stage: number; phase: CratePhase; time: number; elapsed: number;
  wins: number[]; winner: number; timeout: boolean; alive: boolean[];
  /** Six bytes per immutable spawn: cell, paint/layer/landed, start tick, landing tick.
   * Self-contained journal survives lost snapshots and reconnect. Never crate transforms. */
  journal: Uint8Array;
  motion: number[][]; held: number[];
}
export function crateTransforms(g: CrateRainGame) {
  const bytes = new Uint8Array(g.count * 28), view = new DataView(bytes.buffer);
  for (const [i, p] of g.players.entries()) {
    const v = p.body.translation();
    [v.x, v.y, v.z, 0, 0, 0, 1].forEach((n, j) => view.setFloat32((i * 7 + j) * 4, n, true));
  }
  return bytes;
}
export function crateSection(g: CrateRainGame, seats: number[]): CrateWire {
  const journal = new Uint8Array(g.crates.length * 6), v = new DataView(journal.buffer);
  for (const [i, c] of g.crates.entries()) {
    journal[i * 6] = c.cell;
    journal[i * 6 + 1] = BOX_KINDS.indexOf(c.kind) | (+c.firstHit << 2) | (Math.round((c.landingY - CRATE_SIZE / 2) / CRATE_SIZE) << 3);
    v.setUint16(i * 6 + 2, Math.round(c.spawnedAt / C.step), true);
    v.setUint16(i * 6 + 4, Math.round(c.impactAt / C.step), true);
  }
  return { seats, seed: g.seed, stage: g.round, phase: g.phase, time: g.phaseTime, elapsed: g.elapsed,
    wins: [...g.wins], winner: g.winner, timeout: g.timeout, alive: g.players.map(p => p.alive), journal,
    held: g.players.map(() => 0), motion: g.players.map(p => { const v = p.body.linvel(); return [v.x, v.y, v.z, p.heading, +p.grounded, p.support ?? -1, p.coyote, p.buffer, +p.jumpHeld, p.stepped]; }) };
}
/** Idempotent reconstruction: unchanged fixed crates are never recreated or moved. */
export function restoreCrates(g: CrateRainGame, w: CrateWire, elapsed = w.elapsed) {
  if (g.round !== w.stage || g.crates.length > w.journal.length / 6) { g.round = w.stage; g.resetRound(); }
  const v = new DataView(w.journal.buffer, w.journal.byteOffset, w.journal.byteLength);
  for (let i = 0; i < w.journal.length / 6; i++) {
    const cell = g.cells[w.journal[i * 6]], flags = w.journal[i * 6 + 1], kind = BOX_KINDS[flags & 3];
    const layer = flags >> 3, landed = !!(flags & 4), start = v.getUint16(i * 6 + 2, true) * C.step, end = v.getUint16(i * 6 + 4, true) * C.step;
    const landingY = (layer + .5) * CRATE_SIZE, startY = landingY + C.spawnHeight;
    let c = g.crates[i];
    if (!c) {
      g.elapsed = start;
      c = g.addCrate(kind, cell.x, startY, cell.z, 0, start, end - start)!;
      c.id = i; c.landingY = landingY; c.startY = startY; c.spawnedAt = start; c.impactAt = end;
    }
    if (!c.firstHit) {
      const t = Math.max(0, Math.min(1, (elapsed - start) / Math.max(C.step, end - start)));
      c.before = c.body.translation();
      c.body.setTranslation({ x: cell.x, y: landed ? landingY : startY + (landingY - startY) * t * t, z: cell.z }, false);
      if (landed) { c.firstHit = true; c.body.setBodyType(RAPIER.RigidBodyType.Fixed, false); c.collider.setSensor(false); cell.layers = layer + 1; cell.reserved = false; }
    }
  }
  g.warnings.length = 0;
  for (const c of g.crates) if (!c.firstHit) {
    const cell = g.cells[c.cell];
    g.warnings.push({ id: c.id, cell: c.cell, kind: c.kind, x: cell.x, y: c.landingY - CRATE_SIZE / 2, z: cell.z, since: c.spawnedAt, spawnAt: c.spawnedAt, impactAt: c.impactAt, spawned: true, landed: false });
  }
  g.phase = w.phase; g.phaseTime = w.time; g.elapsed = elapsed; g.wins = [...w.wins]; g.winner = w.winner; g.timeout = w.timeout;
  g.world.propagateModifiedBodyPositionsToColliders();
}
export function restoreCratePlayers(g: CrateRainGame, w: CrateWire, poses: ArrayLike<number>) {
  g.players.forEach((p, i) => {
    const m = w.motion[i], o = i * 7;
    p.body.setTranslation({ x: poses[o], y: poses[o + 1], z: poses[o + 2] }, true);
    p.body.setLinvel({ x: m[0], y: m[1], z: m[2] }, true);
    Object.assign(p, { alive: w.alive[i], heading: m[3], grounded: !!m[4], support: m[5] < 0 ? null : m[5], coyote: m[6], buffer: m[7], jumpHeld: !!m[8], stepped: m[9] });
    p.body.setEnabled(p.alive); p.positionBefore = p.body.translation();
  });
  g.world.propagateModifiedBodyPositionsToColliders();
}
