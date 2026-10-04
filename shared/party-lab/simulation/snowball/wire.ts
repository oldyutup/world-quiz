import type { SnowballGame, SnowPhase } from './game.js';
export interface SnowballWire {
  seed: number; seats: number[]; stage: number; phase: SnowPhase;
  time: number; elapsed: number; radius: number; wins: number[]; winner: number;
  /** Per ball: linear XYZ, angular XYZ, controller heading (seven Float32s). */
  motion: Uint8Array;
  /** Authoritative 120 Hz elimination ticks, -1 while alive. */
  out: number[];
}
export function snowballTransforms(g: SnowballGame) {
  return floats(g.balls.flatMap(b => { const p=b.body.translation(),q=b.body.rotation(); return [p.x,p.y,p.z,q.x,q.y,q.z,q.w]; }));
}
function floats(values: number[]) { const bytes=new Uint8Array(values.length*4),v=new DataView(bytes.buffer);values.forEach((n,i)=>v.setFloat32(i*4,n,true));return bytes; }
export function snowballSection(g: SnowballGame, seats: number[], out: number[]): SnowballWire {
  return {seed:g.seed,seats:[...seats],stage:g.round,phase:g.phase,time:g.phaseTime,elapsed:g.elapsed,radius:g.radius,wins:[...g.wins],winner:g.winner,out:[...out],
    motion:floats(g.balls.flatMap(b=>{const v=b.body.linvel(),w=b.body.angvel();return [v.x,v.y,v.z,w.x,w.y,w.z,b.heading];}))};
}
export function snowballMotion(w: SnowballWire) { const v=new DataView(w.motion.buffer,w.motion.byteOffset,w.motion.byteLength);return Array.from({length:w.motion.byteLength/4},(_,i)=>v.getFloat32(i*4,true)); }
