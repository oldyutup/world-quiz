import type {GameStream,BufferedSnapshot} from '../../network/gameStream';
import type {LobbySnapshot} from '../../network/types';
import type {AnyInputPacket} from '../../../../shared/party-lab/network/protocol';
import type {FightInputPacket} from '../../../../shared/party-lab/network/fightInput';
import type {MovementInput} from '../../../../shared/party-lab/intent';
import {SnowFightGame} from './game';
import {restoreFight} from '../../../../shared/party-lab/simulation/snowfight/wire';
import {type FightInput,flight} from './config';
import {InputHistory,PREDICTION_LIMITS} from '../../network/prediction/history';
import {RigCorrection} from '../../network/prediction/correction';
export interface FightOnline {lobby:LobbySnapshot;stream:GameStream;sendInput:(input:MovementInput)=>AnyInputPacket|null|undefined;}
export class FightPrediction{
 readonly game:SnowFightGame;readonly history=new InputHistory();readonly correction=new RigCorrection(1);readonly metrics={corrections:0,hard:0,maxError:0,overflows:0,replaySteps:0};
 private seq=-1;private life=-1;private shown=new Float32Array(7);private pose=new Float32Array(7);private ready=false;active=false;index=0;
 constructor(readonly slot:number,count:2|3,seed:number){this.game=new SnowFightGame(count,seed);this.game.bots=false;}
 private capture(){const p=this.game.players[this.index].body.translation();this.pose.set([p.x,p.y,p.z,0,0,0,1]);return this.pose;}
 reconcile(frame:BufferedSnapshot,now:number){const s=frame.snapshot,w=s.fight;if(!w||s.seq<=this.seq)return;this.seq=s.seq;this.index=w.seats.indexOf(this.slot);if(this.index<0)return;
  const life=w.players[this.index][20];this.active=w.phase==='playing'&&w.players[this.index][3]>0;
  if(life!==this.life||!this.active){this.life=life;this.history.clear();this.correction.clear();this.ready=false;}
  const before=this.shown.slice();restoreFight(this.game,w,frame.values);this.history.acknowledge(s.ack[this.slot]);
  if(this.history.records.some(p=>now-p.sentAt>PREDICTION_LIMITS.staleMs)){this.history.clear();this.ready=false;}
  let held=w.held[this.index]??0;if(this.active)for(const p of this.history.records)if('throwPressed'in p.packet){if(held-->0)continue;this.run(p.packet);this.metrics.replaySteps++;}
  if(this.ready){const r=this.correction.begin(before,this.capture());this.metrics.maxError=Math.max(this.metrics.maxError,r.error);if(r.tier!=='none')this.metrics.corrections++;if(r.tier==='hard')this.metrics.hard++;}
 }
 private run(p:FightInputPacket){this.game.predictPlayer(this.index,{x:p.moveX,z:p.moveZ,yaw:p.yaw,jump:p.jumpHeld,sprint:p.sprintHeld,crouch:p.crouchHeld,gather:p.gatherHeld,throw:false});}
 step(p:FightInputPacket,now:number){if(!this.active)return;if(!this.history.add(p,1,now)){this.metrics.overflows++;this.ready=false;return;}this.run(p);}
 visual(dt:number){this.ready=true;return this.correction.apply(this.capture(),dt,this.shown);}dispose(){this.game.dispose();}
}
export class FightOnlineController{
 readonly prediction:FightPrediction;readonly slot:number;self=0;private acc=0;private thrown=false;private event=-1;
 constructor(readonly options:FightOnline,count:2|3,seed:number){this.slot=options.lobby.players.find(p=>p.id===options.lobby.selfId)?.slot??-1;this.prediction=new FightPrediction(this.slot,count,seed);}
 advance(g:SnowFightGame,dt:number,input:FightInput,pitch:number,off:boolean){const {stream,sendInput}=this.options,latest=stream.snapshots.latest,w=latest?.snapshot.fight;if(!latest||!w)return;
  const now=performance.now();this.self=Math.max(0,w.seats.indexOf(this.slot));this.prediction.reconcile(latest,now);this.thrown ||= !off&&input.throw;if(off)this.thrown=false;
  this.acc=dt>.25?0:Math.min(.05,this.acc+dt);
  while(this.acc>=1/60){this.acc-=1/60;const p=sendInput({x:0,z:0,jump:false,fight:{seq:0,round:latest.snapshot.round,life:w.players[this.self][20],moveX:off?0:input.x,moveZ:off?0:input.z,yaw:input.yaw,pitch,jumpHeld:!off&&input.jump,sprintHeld:!off&&input.sprint,crouchHeld:!off&&input.crouch,gatherHeld:!off&&input.gather,throwPressed:this.thrown}});if(p&&'throwPressed'in p){this.prediction.step(p,now);this.thrown=false;}}
  const sample=stream.snapshots.sample(now);let poses=latest.values;
  if(sample&&sample.a.snapshot.fight&&sample.b.snapshot.fight){poses=sample.a.values.map((n,i)=>{const seat=Math.floor(i/7);return sample.a.snapshot.fight!.players[seat][20]===w.players[seat][20]?n+(sample.b.values[i]-n)*sample.alpha:latest.values[i];});}
  restoreFight(g,w,poses);const age=Math.min(.1,Math.max(0,(now-latest.received)/1000));
  for(const b of g.balls){b.p=flight(b.p,b.v,age);b.previous={...b.p};}
  if(this.prediction.active){const v=this.prediction.visual(Math.min(.1,dt)),p=g.players[this.self];p.body.setTranslation({x:v[0],y:v[1],z:v[2]},false);p.previous=p.body.translation();p.yaw=input.yaw;}
  if(this.event<0)this.event=w.events[w.events.length-1]?.id??0;
  g.events=w.events.filter(e=>e.id>this.event);this.event=Math.max(this.event,w.events[w.events.length-1]?.id??0);
 }
 dispose(){this.prediction.dispose();}
}
