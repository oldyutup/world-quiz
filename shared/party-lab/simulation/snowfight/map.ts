import { FIGHT, add, mul, sub, length, type Vec } from './config.js';
export interface Solid { id: string; kind: 'bank' | 'fence' | 'hut' | 'porch' | 'rock' | 'tree' | 'boundary'; p: Vec; half: Vec; snow: boolean }
const box = (id: string, kind: Solid['kind'], x: number, y: number, z: number, sx: number, sy: number, sz: number, snow = false): Solid => ({ id, kind, p: { x, y, z }, half: { x: sx / 2, y: sy / 2, z: sz / 2 }, snow });
/** Open middle and three broad circulation lanes. Low banks hide a 1.02 m crouch. */
export function makeMap(size: number = FIGHT.arenaSize): Solid[] {
  const h = size / 2;
  return [
    box('bank-west', 'bank', -5, .6, 2, 4, 1.2, 1.1, true),
    box('bank-east', 'bank', 5, .6, -2, 4, 1.2, 1.1, true),
    box('bank-south', 'bank', 2, .6, 7, 3.4, 1.2, 1.1, true),
    box('bank-north', 'bank', -2, .6, -7, 3.4, 1.2, 1.1, true),
    box('fence-west', 'fence', -8, 1.05, -3, .25, 2.1, 3.5),
    box('fence-east', 'fence', 8, 1.05, 4, .25, 2.1, 3.5),
    box('hut-west', 'hut', -10, 1.8, 9.5, 4, 3.6, 4),
    box('hut-east', 'hut', 10, 1.8, -9.5, 4, 3.6, 4),
    box('porch-west', 'porch', -10, .15, 6.8, 4.2, .3, 1.4),
    box('porch-east', 'porch', 10, .15, -6.8, 4.2, .3, 1.4),
    box('rock-west', 'rock', -3.4, .95, -3.2, 1.7, 1.9, 1.7),
    box('rock-east', 'rock', 3.4, .85, 3.2, 1.6, 1.7, 1.6),
    box('snow-step', 'bank', -11, .15, -7, 3, .3, 3, true),
    box('snow-hill', 'bank', -12, .35, -8, 2, .7, 2, true),
    ...[[-10,0], [10,0], [-6,-10], [6,10]].flatMap(([x,z], i) => [
      box(`tree-${i}`, 'tree', x, 1.1, z, .65, 2.2, .65),
      box(`crown-${i}`, 'tree', x, 3.5, z, 2.4, 2.6, 2.4),
    ]),
    ...[-1,1].flatMap(sign => [box(`edge-x${sign}`, 'boundary', sign*(h+.25), 1.1, 0, .5, 2.2, size+1, true), box(`edge-z${sign}`, 'boundary', 0, 1.1, sign*(h+.25), size, 2.2, .5, true)]),
  ];
}
export const MAP = makeMap();
export const SPAWNS: Vec[] = [{ x: -5.5, y: .025, z: 10.5 }, { x: 5.5, y: .025, z: -10.5 }, { x: 10.5, y: .025, z: 8 }, { x: -10.5, y: .025, z: -10.5 }, { x: -10.5, y: .025, z: 4 }, { x: 10.5, y: .025, z: -4 }, { x: 0, y: .025, z: 11.5 }, { x: 0, y: .025, z: -11.5 }];
export function inside(p: Vec, s: Solid, inflate = 0) { return Math.abs(p.x-s.p.x) < s.half.x+inflate && Math.abs(p.y-s.p.y) < s.half.y+inflate && Math.abs(p.z-s.p.z) < s.half.z+inflate; }
/** Swept sphere against conservative box blockers, in metres along a unit ray. */
export function castMap(solids: readonly Solid[], o: Vec, dir: Vec, max: number, radius = 0) {
  let best = max;
  for (const s of solids) {
    let enter = 0, exit = max;
    for (const k of ['x','y','z'] as const) {
      const lo = s.p[k]-s.half[k]-radius, hi = s.p[k]+s.half[k]+radius;
      if (Math.abs(dir[k]) < 1e-9) { if (o[k] < lo || o[k] > hi) { enter = Infinity; break; } }
      else { const a=(lo-o[k])/dir[k], b=(hi-o[k])/dir[k]; enter=Math.max(enter,Math.min(a,b)); exit=Math.min(exit,Math.max(a,b)); }
    }
    if (enter<=exit) best=Math.min(best,enter);
  }
  // Snow floor also stops a camera looking upward from sinking under the world.
  if (dir.y < -1e-6) best=Math.min(best,Math.max(0,(radius-o.y)/dir.y));
  return best;
}
export function clearLine(solids: readonly Solid[], a: Vec, b: Vec, radius = 0) { const d=sub(b,a), n=length(d); return castMap(solids,a,mul(d,1/Math.max(n,.001)),n,radius)>=n-.001; }
export function surfaceAt(solids: readonly Solid[], x: number, z: number, below = Infinity) {
  let y=0, snow=true;
  for(const s of solids) if(Math.abs(x-s.p.x)<s.half.x && Math.abs(z-s.p.z)<s.half.z && s.p.y+s.half.y>y && s.p.y+s.half.y<=below) { y=s.p.y+s.half.y; snow=s.snow; }
  return { y, snow };
}
export function gatherSurface(solids: readonly Solid[], feet: Vec, grounded: boolean, half = FIGHT.arenaSize/2) { const s=surfaceAt(solids,feet.x,feet.z,feet.y+.15); return grounded && Math.abs(feet.x)<half && Math.abs(feet.z)<half && s.snow && Math.abs(feet.y-s.y)<.15; }
export function safeSpawn(solids: readonly Solid[], enemies: readonly Vec[], serial: number, half = FIGHT.arenaSize/2) {
  let best=SPAWNS[0], score=-Infinity;
  SPAWNS.forEach((candidate,i)=>{
    const p={...candidate,x:Math.max(-half+1.4,Math.min(half-1.4,candidate.x)),z:Math.max(-half+1.4,Math.min(half-1.4,candidate.z))};
    if(!gatherSurface(solids,p,true,half) || solids.some(s=>inside(add(p,{x:0,y:.8,z:0}),s,.4)))return;
    const value=Math.min(...enemies.map(e=>Math.hypot(e.x-p.x,e.z-p.z)),20)+enemies.reduce((n,e)=>n+(!clearLine(solids,add(p,{x:0,y:1.2,z:0}),add(e,{x:0,y:1.2,z:0}))?1.5:0),0)+((i+serial)%SPAWNS.length)*.001;
    if(value>score){score=value;best=p;}
  }); return {...best};
}
