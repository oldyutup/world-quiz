import {Quaternion} from 'three';
import type {GameStream,BufferedSnapshot} from '../../network/gameStream';
import type {LobbySnapshot} from '../../network/types';
import type {AnyInputPacket} from '../../../../shared/party-lab/network/protocol';
import type {RaceInputPacket} from '../../../../shared/party-lab/network/raceInput';
import type {MovementInput} from '../../../../shared/party-lab/intent';
import {RaceGame} from '../../../../shared/party-lab/simulation/kartrace/game';
import {restoreRace} from '../../../../shared/party-lab/simulation/kartrace/wire';
import {IDLE,type DriveInput} from '../../../../shared/party-lab/simulation/kartrace/config';
import {InputHistory,PREDICTION_LIMITS} from '../../network/prediction/history';
import {RigCorrection} from '../../network/prediction/correction';
export interface RaceOnline {lobby:LobbySnapshot;stream:GameStream;sendInput:(input:MovementInput)=>AnyInputPacket|null|undefined;}
export class RacePrediction{
 readonly game:RaceGame;readonly history=new InputHistory();readonly correction=new RigCorrection(1);readonly metrics={corrections:0,hard:0,maxError:0,overflows:0,replaySteps:0,heldSteps:0};
 private seq=-1;private epoch=-1;private shown=new Float32Array(7);private pose=new Float32Array(7);private ready=false;private remote:DriveInput[]=[];active=false;index=0;
 constructor(readonly slot:number,count:2|3){this.game=new RaceGame(count);this.game.bots=false;}
 private capture(){const b=this.game.cars[this.index].body,p=b.translation(),q=b.rotation();this.pose.set([p.x,p.y,p.z,q.x,q.y,q.z,q.w]);return this.pose;}
 reconcile(frame:BufferedSnapshot,now:number){const s=frame.snapshot,w=s.race;if(!w||s.seq<=this.seq)return;this.seq=s.seq;this.index=w.seats.indexOf(this.slot);if(this.index<0)return;
  const epoch=w.progress[this.index].resets;this.active=w.phase==='racing'&&w.progress[this.index].finish===null&&w.enabled[this.index];
  if(epoch!==this.epoch||!this.active){this.epoch=epoch;this.history.clear();this.correction.clear();this.ready=false;}
  const before=this.shown.slice();restoreRace(this.game,w,frame.values);this.remote=w.inputs.map(i=>({...i,reset:false}));this.history.acknowledge(s.ack[this.slot]);
  if(this.history.records.some(p=>now-p.sentAt>PREDICTION_LIMITS.staleMs)){this.history.clear();this.ready=false;}
  let held=w.held[this.index]??0;if(this.active)for(const p of this.history.records)if('handbrake'in p.packet){if(held-->0){this.metrics.heldSteps++;continue;}this.run(p.packet);this.metrics.replaySteps++;}
  if(this.ready){const r=this.correction.begin(before,this.capture(),Math.max(1,this.game.cars[this.index].speed*.12));this.metrics.maxError=Math.max(this.metrics.maxError,r.error);if(r.tier!=='none')this.metrics.corrections++;if(r.tier==='hard')this.metrics.hard++;}
 }
 private run(p:RaceInputPacket){const inputs=this.remote.map(i=>({...i}));inputs[this.index]={throttle:p.throttle,brake:p.brake,steer:p.steer,handbrake:p.handbrake};this.game.predictStep(inputs);}
 step(p:RaceInputPacket,now:number){if(!this.active)return;if(!this.history.add(p,1,now)){this.metrics.overflows++;this.ready=false;return;}this.run(p);}
 visual(dt:number){this.ready=true;return this.correction.apply(this.capture(),dt,this.shown);}dispose(){this.game.dispose();}
}
export class RaceOnlineController{
 readonly prediction:RacePrediction;readonly slot:number;self=0;private acc=0;private reset=false;private contacts=-1;private previousLap=-1;private qa=new Quaternion();private qb=new Quaternion();
 constructor(readonly options:RaceOnline,count:2|3){this.slot=options.lobby.players.find(p=>p.id===options.lobby.selfId)?.slot??-1;this.prediction=new RacePrediction(this.slot,count);}
 advance(g:RaceGame,dt:number,input:DriveInput,off:boolean){const {stream,sendInput}=this.options,latest=stream.snapshots.latest,w=latest?.snapshot.race;if(!latest||!w)return;
  const now=performance.now();this.self=Math.max(0,w.seats.indexOf(this.slot));this.prediction.reconcile(latest,now);this.reset ||= !off&&!!input.reset;if(off)this.reset=false;
  this.acc=dt>.25?0:Math.min(.05,this.acc+dt);
  while(this.acc>=1/60){this.acc-=1/60;const drive=off?IDLE:input,p=sendInput({x:0,z:0,jump:false,race:{seq:0,round:latest.snapshot.round,resetEpoch:w.progress[this.self].resets,throttle:drive.throttle,brake:drive.brake,steer:drive.steer,handbrake:!!drive.handbrake,reset:this.reset}});if(p&&'handbrake'in p){this.prediction.step(p,now);this.reset=false;}}
  const sample=stream.snapshots.sample(now);let poses=latest.values;
  if(sample&&sample.a.snapshot.race&&sample.b.snapshot.race){poses=latest.values.slice();for(let i=0;i<g.count;i++){if(sample.a.snapshot.race.progress[i].resets!==w.progress[i].resets)continue;const o=i*7;for(let k=0;k<3;k++)poses[o+k]=sample.a.values[o+k]+(sample.b.values[o+k]-sample.a.values[o+k])*sample.alpha;this.qa.fromArray(sample.a.values,o+3);this.qb.fromArray(sample.b.values,o+3);this.qa.slerp(this.qb,sample.alpha).toArray(poses,o+3);}}
  restoreRace(g,w,poses);
  if(this.prediction.active){const v=this.prediction.visual(Math.min(.1,dt)),c=g.cars[this.self],pred=this.prediction.game.cars[this.self];c.body.setTranslation({x:v[0],y:v[1],z:v[2]},false);c.body.setRotation({x:v[3],y:v[4],z:v[5],w:v[6]},false);c.body.setLinvel(pred.body.linvel(),false);c.previous=c.body.translation();c.heading=pred.heading;c.previousHeading=c.heading;c.steer=pred.steer;}
  if(this.contacts>=0&&w.contacts>this.contacts)g.events.push({kind:'impact',id:this.self,intensity:.5});this.contacts=w.contacts;
  if(this.previousLap>=0&&w.progress[this.self].laps>this.previousLap)g.events.push({kind:w.progress[this.self].finish!==null?'finish':'lap',id:this.self,intensity:1});this.previousLap=w.progress[this.self].laps;
 }
 dispose(){this.prediction.dispose();}
}
