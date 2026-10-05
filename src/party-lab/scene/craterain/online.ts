import type { GameStream, BufferedSnapshot } from '../../network/gameStream';
import type { LobbySnapshot } from '../../network/types';
import type { AnyInputPacket } from '../../../../shared/party-lab/network/protocol';
import type { CrateInputPacket } from '../../../../shared/party-lab/network/crateInput';
import type { MovementInput } from '../../../../shared/party-lab/intent';
import { CrateRainGame } from './game';
import { CRATE_RAIN as C, type Input } from './config';
import { restoreCrates, restoreCratePlayers } from '../../../../shared/party-lab/simulation/craterain/wire';
import { InputHistory, PREDICTION_LIMITS } from '../../network/prediction/history';
import { RigCorrection } from '../../network/prediction/correction';
export interface CrateOnline { lobby: LobbySnapshot; stream: GameStream; sendInput: (input: MovementInput) => AnyInputPacket | null | undefined; }
export class CratePrediction {
  readonly game: CrateRainGame; readonly history = new InputHistory(); readonly correction = new RigCorrection(1);
  readonly metrics = { corrections:0, hard:0, maxError:0, overflows:0, replaySteps:0 };
  private seq = -1; private stage = -1; private shown = new Float32Array(7); private pose = new Float32Array(7); private ready = false;
  active = false; index = 0;
  constructor(readonly slot: number, count: 2|3, seed: number) { this.game = new CrateRainGame(count,seed); this.game.bots = this.game.spawning = false; }
  private capture() { const p = this.game.players[this.index].body.translation(); this.pose.set([p.x,p.y,p.z,0,0,0,1]); return this.pose; }
  reconcile(frame: BufferedSnapshot, now: number) {
    const s=frame.snapshot,w=s.crate; if(!w||s.seq<=this.seq)return; this.seq=s.seq;
    this.index=w.seats.indexOf(this.slot); this.active=this.index>=0&&w.phase==='playing'&&w.alive[this.index];
    if(w.stage!==this.stage||!this.active){this.history.clear();this.correction.clear();this.ready=false;this.stage=w.stage;}
    if(this.index<0)return;
    const before=this.shown.slice(); restoreCrates(this.game,w); restoreCratePlayers(this.game,w,frame.values);
    this.history.acknowledge(s.ack[this.slot]);
    if(this.history.records.some(p=>now-p.sentAt>PREDICTION_LIMITS.staleMs)){this.history.clear();this.ready=false;}
    let held=w.held[this.index]??0;
    if(this.active)for(const p of this.history.records)if('jumpHeld' in p.packet){if(held-->0)continue;this.run(p.packet);this.metrics.replaySteps++;}
    if(this.ready){const r=this.correction.begin(before,this.capture());this.metrics.maxError=Math.max(this.metrics.maxError,r.error);if(r.tier!=='none')this.metrics.corrections++;if(r.tier==='hard')this.metrics.hard++;}
  }
  private run(p: CrateInputPacket) { for(let sub=0;sub<2;sub++)this.game.predictPlayer(this.index,{x:p.moveX,z:p.moveZ,jump:p.jumpHeld,sprint:p.sprintHeld}); }
  step(p: CrateInputPacket, now:number) { if(!this.active)return;if(!this.history.add(p,1,now)){this.metrics.overflows++;this.ready=false;return;}this.run(p); }
  visual(dt:number) { this.ready=true;return this.correction.apply(this.capture(),dt,this.shown); }
  dispose(){this.game.dispose();}
}
export class CrateOnlineController {
  readonly prediction: CratePrediction; readonly slot:number; self=0; private acc=0; private seenStage=-1; private landed=new Set<number>();
  constructor(readonly options:CrateOnline, count:2|3, seed:number){this.slot=options.lobby.players.find(p=>p.id===options.lobby.selfId)?.slot??-1;this.prediction=new CratePrediction(this.slot,count,seed);}
  advance(g:CrateRainGame,delta:number,input:Input,off:boolean){
    const {stream,sendInput}=this.options,latest=stream.snapshots.latest,w=latest?.snapshot.crate;if(!latest||!w)return;
    const now=performance.now();this.self=Math.max(0,w.seats.indexOf(this.slot));this.prediction.reconcile(latest,now);
    this.acc=delta>.25?0:Math.min(.05,this.acc+delta);
    while(this.acc>=1/60){this.acc-=1/60;const packet=sendInput({x:0,z:0,jump:false,crate:{seq:0,round:latest.snapshot.round,stage:w.stage,moveX:off?0:input.x,moveZ:off?0:input.z,jumpHeld:!off&&input.jump,sprintHeld:!off&&input.sprint}});if(packet&&'jumpHeld'in packet)this.prediction.step(packet,now);}
    const sample=stream.snapshots.sample(now);let poses=latest.values;
    if(sample&&sample.a.snapshot.crate?.stage===w.stage&&sample.b.snapshot.crate?.stage===w.stage){poses=sample.a.values.map((n,i)=>n+(sample.b.values[i]-n)*sample.alpha);}
    const elapsed=w.phase==='playing'?Math.min(C.maxRoundTime,w.elapsed+Math.min(.1,(now-latest.received)/1000)):w.elapsed;
    restoreCrates(g,w,elapsed);restoreCratePlayers(g,w,poses);
    g.hits=[];const fresh=this.seenStage===w.stage;if(!fresh){this.landed.clear();this.seenStage=w.stage;}
    for(const c of g.crates)if(c.firstHit&&!this.landed.has(c.id)){this.landed.add(c.id);if(fresh)g.hits.push({...c.body.translation(),speed:14});}
    if(this.prediction.active){const v=this.prediction.visual(Math.min(.1,delta)),p=g.players[this.self];p.body.setTranslation({x:v[0],y:v[1],z:v[2]},false);p.positionBefore=p.body.translation();p.heading=this.prediction.game.players[this.self].heading;}
  }
  dispose(){this.prediction.dispose();}
}
