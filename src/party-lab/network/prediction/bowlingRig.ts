import {Quaternion} from "three";
import {BowlingGame} from '../../../../shared/party-lab/simulation/bowling/game';
import {BOWLING,BULLET} from '../../../../shared/party-lab/simulation/bowling/config';
import type {BowlingInputPacket} from '../../../../shared/party-lab/network/bowlingInput';
import type {BufferedSnapshot} from '../gameStream';
import {InputHistory,PREDICTION_LIMITS} from './history';
import {RigCorrection} from './correction';
/** Car-only prediction. No predicted ragdoll, pins, score, eject or turn advancement. */
export class BowlingPrediction {
 readonly game:BowlingGame; readonly history=new InputHistory();readonly correction=new RigCorrection(1);
 readonly metrics={corrections:0,hard:0,maxError:0,overflows:0,replaySteps:0,heldSteps:0};
 active=false; private seq=-1;private turn=-1;private accumulator=0;private scale=1;
 private previous=new Float32Array(7);private blended=new Float32Array(7);private qa=new Quaternion();private qb=new Quaternion();
 private pose=new Float32Array(7);private shown=new Float32Array(7);private initialized=false;
 constructor(readonly slot:number,seed:number,players:2|3,obstacles=false){
  this.game=new BowlingGame(players,seed,true,obstacles);
  // The first Rapier step measured ~84ms at 4× CPU slowdown. Initialize its
  // pipeline while the arena loads, including for spectators, before any drive.
  // The first authoritative driving snapshot resets/restores this private world.
  this.game.world.step();
 }
 private capture(){const b=this.game.car.body,p=b.translation(),q=b.rotation();this.pose.set([p.x,p.y,p.z,q.x,q.y,q.z,q.w]);return this.pose;}
 reconcile(frame:BufferedSnapshot,now:number){
  if(frame.snapshot.seq<=this.seq)return;this.seq=frame.snapshot.seq;
  const s=frame.snapshot,w=s.bowling!;
  const active=w.phase==='drive'&&w.seats[w.turn%w.seats.length]===this.slot;
  const reset=w.turn!==this.turn||!active||!this.active;
  if(reset){this.history.clear();this.correction.clear();this.initialized=false;this.turn=w.turn;}
  this.active=active;if(!active)return;
  const before=this.shown.slice(),g=this.game;
  // Only the turn changes the course/rack. Rebuilding its joints and waking all
  // ten pins at every snapshot wasted driving CPU; restore the car below.
  g.score.turn=w.turn;if(reset)g.resetThrow();g.phase='drive';
  const v=frame.values;g.car.body.setTranslation({x:v[0],y:v[1],z:v[2]},true);g.car.body.setRotation({x:v[3],y:v[4],z:v[5],w:v[6]},true);
  g.car.body.setLinvel({x:w.velocity[0],y:w.velocity[1],z:w.velocity[2]},true);g.car.body.setAngvel({x:w.velocity[3],y:w.velocity[4],z:w.velocity[5]},true);
  g.car.heading=w.heading;g.car.pitch=w.pitch;g.car.grounded=w.grounded;
  g.car.props.forEach((p,i)=>{const j=i*4;Object.assign(p.state,{hit:!!w.stunts[j],age:w.stunts[j+1],speed:w.stunts[j+2],side:w.stunts[j+3]});p.collider.setEnabled(g.obstacles[i].active&&!p.state.hit);});
  this.previous.set(this.capture());
  // A snapshot is the current fixed-step pose. Reconstruct the preceding visual
  // sample so interpolation does not add a full-step jump at every 20 Hz restore.
  for(let i=0;i<3;i++)this.previous[i]-=w.velocity[i]*BOWLING.step;
  this.accumulator=w.accumulator;this.scale=w.charging?BULLET.scale:1;
  this.history.acknowledge(s.ack[this.slot]);
  if(this.history.records.some(p=>now-p.sentAt>PREDICTION_LIMITS.staleMs)){this.history.clear();this.initialized=false;}
  // The server has already simulated these durations with its last held input.
  // Replaying them again made a 180ms TCP stall jump the car forward ~8m,
  // then snap it back when the acknowledgement caught up.
  let held=w.heldTicks??0;
  for(const p of this.history.records)if('space' in p.packet)for(let i=0;i<p.ticks;i++){
   if(held-->0){this.metrics.heldSteps++;continue;}
   this.run(p.packet);this.metrics.replaySteps++;
  }
  this.interpolate();
  // The walking rig's 1 m snap threshold is less than two car ticks at top
  // speed. Keep its correction tiers/easing, scaled to at most 120 ms of car
  // travel, so ordinary acknowledgement jitter blends instead of teleporting.
  if(this.initialized){const r=this.correction.begin(before,this.blended,Math.max(1,g.car.speed*.12));this.metrics.maxError=Math.max(this.metrics.maxError,r.error);if(r.tier!=='none')this.metrics.corrections++;if(r.tier==='hard')this.metrics.hard++;}
 }
 private run(p:BowlingInputPacket){
  const g=this.game;
  this.scale=p.space&&(this.scale===BULLET.scale||g.inLaunchRegion)?BULLET.scale:1;
  this.accumulator+=BOWLING.step*this.scale;
  while(this.accumulator+1e-9>=BOWLING.step){this.previous.set(this.capture());g.car.step(p);g.world.step();this.accumulator-=BOWLING.step;}
 }
 step(packet:BowlingInputPacket,now:number){
  if(!this.active)return;
  if(!this.history.add(packet,1,now)){this.metrics.overflows++;this.active=false;return;}
  this.run(packet);
 }
 private interpolate(){
  const current=this.capture(),alpha=Math.max(0,Math.min(1,this.accumulator/BOWLING.step));
  for(let i=0;i<3;i++)this.blended[i]=this.previous[i]+(current[i]-this.previous[i])*alpha;
  this.qa.fromArray(this.previous,3);this.qb.fromArray(current,3);this.qa.slerp(this.qb,alpha).toArray(this.blended,3);
  return this.blended;
 }
 visual(dt:number){if(this.active)this.initialized=true;return this.correction.apply(this.interpolate(),dt,this.shown);}
 dispose(){this.game.dispose();}
}
