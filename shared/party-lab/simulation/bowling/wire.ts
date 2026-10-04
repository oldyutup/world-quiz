import type { BowlingGame, BowlingPhase } from './game.js';
import type { BowlingClock } from './clock.js';
import { PARTS } from '../ragdoll/config.js';
/** Self-contained turn state. Poses: car, then nine ragdoll segments and ten pins.
 * Driving sends only the car; the rack is reconstructed from shared reset anchors. */
export interface BowlingWire {
  seed:number; obstacles:boolean; seats:number[]; turn:number; phase:BowlingPhase; throws:number[][];
  elapsed:number; phaseTime:number; realTime:number; chargeTime:number; tailTime:number;
  charging:boolean; committed:boolean; angle:number; ejected:boolean; nudge:boolean;
  impact:boolean; landed:boolean; missed:boolean; lastPlayer:number; points:number; mask:number;
  heading:number; pitch:number; grounded:boolean; airHeading:number; speed:number;
  velocity:number[]; bodyVelocity:number[]; stunts:number[]; accumulator:number; throttle:number; heldTicks:number;
}
export function bowlingSection(g:BowlingGame,c:BowlingClock,seats:readonly number[],throttle:number,heldTicks=0):BowlingWire {
  const v=g.car.body.linvel(),w=g.car.body.angvel(),bv=g.character.body.linvel();
  return {seed:g.seed,obstacles:g.obstaclesEnabled,seats:[...seats],turn:g.score.turn,phase:g.phase,throws:g.score.throws.map(t=>[...t]),elapsed:g.elapsed,phaseTime:g.phaseTime,realTime:c.realTime,chargeTime:g.chargeTime,tailTime:g.tailTime,charging:g.charging,committed:g.launchCommitted,angle:g.angle,ejected:g.ejected,nudge:g.nudgeUsed,impact:g.impact,landed:g.landed,missed:g.missedEject,lastPlayer:g.lastPlayer,points:g.lastPoints,mask:g.mask,heading:g.car.heading,pitch:g.car.pitch,grounded:g.car.grounded,airHeading:g.airHeading,speed:g.speed,velocity:[v.x,v.y,v.z,w.x,w.y,w.z],bodyVelocity:[bv.x,bv.y,bv.z],stunts:g.car.stuntStates.flatMap(s=>[+s.hit,s.age,s.speed,s.side]),accumulator:c.accumulator,throttle,heldTicks};
}
export function bowlingTransforms(g:BowlingGame) {
  const bodies=[g.car.body,...(g.ejected?[...PARTS.map(n=>g.character.parts[n].body),...g.pins.map(p=>p.body)]:[])];
  const bytes=new Uint8Array(bodies.length*28),v=new DataView(bytes.buffer);let o=0;
  for(const b of bodies){const p=b.translation(),q=b.rotation();for(const n of [p.x,p.y,p.z,q.x,q.y,q.z,q.w]){v.setFloat32(o,n,true);o+=4;}}
  return bytes;
}
