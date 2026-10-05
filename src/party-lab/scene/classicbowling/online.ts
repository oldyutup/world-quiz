import {Quaternion} from 'three';
import type {GameStream} from '../../network/gameStream';
import type {LobbySnapshot} from '../../network/types';
import type {NetDiagnostics} from '../../network/diagnostics';
import type {AnyInputPacket} from '../../../../shared/party-lab/network/protocol';
import type {MovementInput} from '../../../../shared/party-lab/intent';
import type {ClassicGame} from '../../../../shared/party-lab/simulation/classicbowling/game';
import {positionAt,directionAt,powerAt} from '../../../../shared/party-lab/simulation/classicbowling/config';
import {restoreClassic} from '../../../../shared/party-lab/simulation/classicbowling/wire';
export interface ClassicOnline {lobby:LobbySnapshot;stream:GameStream;sendInput:(input:MovementInput)=>AnyInputPacket|null|undefined;diagnostics?:NetDiagnostics|null;}
export class ClassicOnlineController{
 readonly slot:number;self=0;private acc=0;private epoch=-1;private displayedTime=0;private pending:number|null=null;private eventId=-1;private qa=new Quaternion();private qb=new Quaternion();
 readonly selections:{epoch:number;eventTime:number;phase:string;value:number;accepted?:number}[]=[];
 constructor(readonly options:ClassicOnline){this.slot=options.lobby.players.find(p=>p.id===options.lobby.selfId)?.slot??-1;}
 advance(g:ClassicGame,dt:number,edge:boolean,off:boolean){const {stream,sendInput,diagnostics}=this.options,latest=stream.snapshots.latest,w=latest?.snapshot.classic;if(!latest||!w)return;
  const now=performance.now();this.self=w.seats.indexOf(this.slot);
  if(this.epoch!==w.epoch){this.epoch=w.epoch;this.pending=null;}
  const active=latest.snapshot.phase==='playing'&&w.state.seat===this.self&&['position','direction','power'].includes(w.state.phase);
  if(edge&&!off&&active&&g.phase===w.state.phase&&this.pending===null&&this.displayedTime>=w.phaseStart){this.pending=this.displayedTime;this.selections.push({epoch:w.epoch,eventTime:this.pending,phase:w.state.phase,value:w.state.phase==='position'?g.position:w.state.phase==='direction'?g.angle:g.power});}
  this.acc=dt>.25?0:Math.min(.05,this.acc+dt);
  while(this.acc>=1/60){this.acc-=1/60;sendInput({x:0,z:0,jump:false,classic:{seq:0,round:latest.snapshot.round,epoch:w.epoch,pressed:active&&this.pending!==null,eventTime:this.pending??0}});}
  const sample=stream.snapshots.sample(now);let poses=latest.values;
  if(sample&&sample.a.snapshot.classic?.epoch===w.epoch&&sample.b.snapshot.classic?.epoch===w.epoch){poses=latest.values.slice();for(let i=0;i<11;i++){const o=i*7;for(let k=0;k<3;k++)poses[o+k]=sample.a.values[o+k]+(sample.b.values[o+k]-sample.a.values[o+k])*sample.alpha;this.qa.fromArray(sample.a.values,o+3);this.qb.fromArray(sample.b.values,o+3);this.qa.slerp(this.qb,sample.alpha).toArray(poses,o+3);}}
  restoreClassic(g,w,poses);
  // All viewers see the same deterministic phase clock. The press records the last painted sample.
  const mapped=diagnostics?.rtt.length?Date.now()+diagnostics.clockOffsetMs:w.serverNow+(now-latest.received);
  this.displayedTime=this.pending??Math.max(w.phaseStart,mapped);
  if(latest.snapshot.phase==='playing'&&['position','direction','power'].includes(g.phase)){
   g.phaseTime=Math.max(0,(this.displayedTime-w.phaseStart)/1000);
   if(g.phase==='position')g.position=positionAt(g.phaseTime);else if(g.phase==='direction')g.angle=directionAt(g.phaseTime);else g.power=powerAt(g.phaseTime);
  }
  for(const e of w.events){if(this.eventId>=0&&e.id>this.eventId)g.events.push(e.kind);}
  this.eventId=Math.max(this.eventId,0,...w.events.map(e=>e.id));
  for(const s of this.selections)if(s.accepted===undefined&&w.epoch>s.epoch)s.accepted=s.phase==='position'?w.state.position:s.phase==='direction'?w.state.angle:w.state.power;
 }
 snapshot(g:ClassicGame){return{...g.snapshot(),bot:g.score.seat!==this.self};}
}
