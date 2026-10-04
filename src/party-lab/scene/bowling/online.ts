import {Quaternion} from 'three';
import type {GameStream} from '../../network/gameStream';
import type {LobbySnapshot} from '../../network/types';
import type {MovementInput} from '../../../../shared/party-lab/intent';
import type {AnyInputPacket} from '../../../../shared/party-lab/network/protocol';
import {BowlingPrediction} from '../../network/prediction/bowlingRig';
import {FrameClock,frameTime,ACCUMULATOR_START} from '../frameClock';
import {PARTS} from '../ragdoll/config';
import {launchAngle} from './config';
import type {BowlingGame,BowlingInput} from './game';
export interface BowlingOnline {
 lobby:LobbySnapshot;stream:GameStream;
 sendInput:(input:MovementInput)=>AnyInputPacket|null|undefined;
}
/** Reuses the room stream, playout clock, bounded input history and rigid correction. */
export class BowlingOnlineController {
 readonly prediction:BowlingPrediction;readonly frameClock=new FrameClock();
 private accumulator=ACCUMULATOR_START;private turn=-1;private a=new Quaternion();private b=new Quaternion();
 private lastSpace=false;private edges:boolean[]=[];
 readonly slot:number;
 constructor(readonly options:BowlingOnline,seed:number,players:2|3){
  this.slot=options.lobby.players.find(p=>p.id===options.lobby.selfId)?.slot??-1;
  this.prediction=new BowlingPrediction(this.slot,seed,players,options.lobby.game?.bowling?.obstacles??false);
 }
 advance(g:BowlingGame,delta:number,input:BowlingInput,off:boolean){
  const {stream,lobby,sendInput}=this.options,latest=stream.snapshots.latest;if(!latest?.snapshot.bowling)return;
  const now=performance.now(),dt=this.frameClock.step(frameTime(now),delta);
  this.prediction.reconcile(latest,now);
  const lw=latest.snapshot.bowling,active=lw.seats[lw.turn%lw.seats.length]===this.slot&&lobby.status==='connected'&&lobby.phase==='playing'&&(lw.phase==='drive'||lw.phase==='flight');
  if(this.turn!==lw.turn){this.edges=[];this.lastSpace=false;this.accumulator=ACCUMULATOR_START;this.turn=lw.turn;}
  const space=!off&&input.eject;
  if(space!==this.lastSpace){this.edges.push(space);this.lastSpace=space;}
  if(dt>.25){this.accumulator=0;this.edges=[];}
  else this.accumulator+=dt;
  let steps=0;
  while(this.accumulator>=1/60&&steps++<3){
   this.accumulator-=1/60;
   if(active){
    const packet=sendInput({x:0,z:0,jump:false,bowling:{seq:0,round:latest.snapshot.round,turn:lw.turn,throttle:off?0:input.throttle,brake:off?0:input.brake,steer:off?0:input.steer,pitch:off?0:input.pitch??0,space:this.edges.length?this.edges[0]:space}});
    if(packet){if(this.edges.length)this.edges.shift();if('space' in packet&&!off)this.prediction.step(packet,now);}
   }
  }
  // A measured 50ms reserve halves held spectator frames in the Bowling TCP
  // jitter trace. Driving prediction still uses the latest authoritative pose.
  const sample=stream.snapshots.sample(this.frameClock.time,150);if(!sample)return;
  let {a,b,alpha}=sample;
  // Never interpolate a teleport/reset or cross a body-layout transition.
  if(a.snapshot.bowling?.turn!==b.snapshot.bowling?.turn||a.values.length!==b.values.length){a=b;alpha=1;}
  const useLatest=active&&(lw.phase==='drive'||lw.phase==='countdown');
  if(useLatest){a=b=latest;alpha=1;}
  const w=(alpha===1?b:a).snapshot.bowling!;
  const reset=w.phase==='countdown'&&(g.phase!=='countdown'||g.score.turn!==w.turn)
    ||w.phase==='drive'&&(g.score.turn!==w.turn||g.phase==='score'||g.ejected&&!w.ejected);
  g.score.turn=w.turn;if(reset)g.resetThrow();
  g.score.throws=w.throws.map(t=>[...t]);g.phase=w.phase;g.phaseTime=w.phaseTime;g.elapsed=w.elapsed;
  g.ejected=w.ejected;g.charging=w.charging;g.launchCommitted=w.committed;g.angle=w.angle;g.chargeTime=w.chargeTime;g.tailTime=w.tailTime;
  g.nudgeUsed=w.nudge;g.impact=w.impact;g.landed=w.landed;g.missedEject=w.missed;g.lastPlayer=w.lastPlayer;g.lastPoints=w.points;g.airHeading=w.airHeading;g.speed=w.speed;
  // Presentation time only, bounded to one snapshot interval. Release is resolved
  // by the server and replaces the displayed prediction with its exact angle.
  if(w.charging){g.chargeTime+=useLatest?Math.min(.05,Math.max(0,(now-latest.received)/1000)):Math.max(0,(b.snapshot.bowling!.chargeTime-w.chargeTime)*alpha);g.angle=launchAngle(g.chargeTime);}
  g.car.heading=w.heading;g.car.pitch=w.pitch;g.car.grounded=w.grounded;
  g.character.body.setLinvel({x:w.bodyVelocity[0],y:w.bodyVelocity[1],z:w.bodyVelocity[2]},false);
  g.car.body.setLinvel({x:w.velocity[0],y:w.velocity[1],z:w.velocity[2]},false);
  g.car.stuntStates.forEach((s,i)=>{const j=i*4;Object.assign(s,{hit:!!w.stunts[j],age:w.stunts[j+1],speed:w.stunts[j+2],side:w.stunts[j+3]});});
  g.car.hitCount=g.car.stuntStates.filter(s=>s.hit).length;
  g.pins.forEach((p,i)=>p.down=!!(w.mask&(1<<i)));
  const bodies=[g.car.body,...(a.values.length>7?[...PARTS.map(n=>g.character.parts[n].body),...g.pins.map(p=>p.body)]:[])];
  bodies.forEach((body,i)=>{
   const o=i*7,x=a.values,y=b.values;
   body.setTranslation({x:x[o]+(y[o]-x[o])*alpha,y:x[o+1]+(y[o+1]-x[o+1])*alpha,z:x[o+2]+(y[o+2]-x[o+2])*alpha},false);
   this.a.fromArray(x,o+3);this.b.fromArray(y,o+3);this.a.slerp(this.b,alpha);body.setRotation(this.a,false);
  });
  if(useLatest&&this.prediction.active&&!off){
   const pose=this.prediction.visual(Math.min(.1,dt)),car=this.prediction.game.car;
   g.car.body.setTranslation({x:pose[0],y:pose[1],z:pose[2]},false);g.car.body.setRotation({x:pose[3],y:pose[4],z:pose[5],w:pose[6]},false);
   g.car.body.setLinvel(car.body.linvel(),false);g.car.heading=car.heading;g.car.pitch=car.pitch;
  }
 }
 dispose(){this.prediction.dispose();}
}
