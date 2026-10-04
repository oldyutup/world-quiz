import { Quaternion } from 'three';
import type { GameStream } from '../../network/gameStream';
import type { LobbySnapshot } from '../../network/types';
import type { NetDiagnostics } from '../../network/diagnostics';
import type { MovementInput } from '../../../../shared/party-lab/intent';
import type { AnyInputPacket } from '../../../../shared/party-lab/network/protocol';
import { SnowballPrediction } from '../../network/prediction/snowballRig';
import { snowballMotion } from '../../../../shared/party-lab/simulation/snowball/wire';
import { FrameClock, frameTime, ACCUMULATOR_START } from '../frameClock';
import type { SnowballGame } from './game';
export interface SnowballOnline {lobby:LobbySnapshot;stream:GameStream;diagnostics?:NetDiagnostics|null;sendInput:(input:MovementInput)=>AnyInputPacket|null|undefined;}
/** Authoritative presentation uses the same local visuals/camera. */
export class SnowballOnlineController {
  readonly prediction:SnowballPrediction; readonly frameClock=new FrameClock(); readonly slot:number;
  private accumulator=ACCUMULATOR_START;private epoch='';private a=new Quaternion();private b=new Quaternion();
  constructor(readonly options:SnowballOnline,players:2|3){this.slot=options.lobby.players.find(p=>p.id===options.lobby.selfId)?.slot??-1;this.prediction=new SnowballPrediction(this.slot,players);}
  advance(g:SnowballGame,delta:number,keys:number,off:boolean){
    const {stream,lobby,sendInput}=this.options,latest=stream.snapshots.latest;if(!latest?.snapshot.snowball)return;
    const now=performance.now(),dt=this.frameClock.step(frameTime(now),delta),s=latest.snapshot,w=s.snowball!;
    this.prediction.reconcile(latest,now);
    const epoch=`${s.round}:${w.stage}:${w.phase}`;if(epoch!==this.epoch){this.accumulator=ACCUMULATOR_START;this.epoch=epoch;}
    this.accumulator=dt>.25?0:this.accumulator+dt;
    const active=lobby.status==='connected'&&w.phase==='playing'&&!!(s.alive&(1<<this.slot));
    let steps=0;while(this.accumulator>=1/60&&steps++<3){this.accumulator-=1/60;if(active){
      const packet=sendInput({x:0,z:0,jump:false,snowball:{seq:0,round:s.round,stage:w.stage,keys:off?0:keys}});
      if(packet&&'keys' in packet)this.prediction.step(packet,now);
    }}
    const sample=stream.snapshots.sample(this.frameClock.time);if(!sample)return;
    let {a,b,alpha}=sample;
    if(a.snapshot.snowball?.stage!==w.stage||b.snapshot.snowball?.stage!==w.stage||a.snapshot.snowball?.phase!==w.phase){a=b=latest;alpha=1;}
    const motion=snowballMotion(w);
    g.phase=w.phase;g.round=w.stage;g.phaseTime=w.time;g.wins=[...w.wins];g.winner=w.winner;
    // Interpolate the server's actual collider radii on the remote body playout
    // clock. No separate client shrink timer or invisible elimination circle.
    const aw=a.snapshot.snowball!,bw=b.snapshot.snowball!;
    g.radius=aw.radius+(bw.radius-aw.radius)*alpha;g.elapsed=w.elapsed;
    g.balls.forEach((ball,i)=>{const o=i*7,x=a.values,y=b.values;
      ball.alive=!!(s.alive&(1<<w.seats[i]));ball.heading=motion[o+6];
      ball.body.setTranslation({x:x[o]+(y[o]-x[o])*alpha,y:x[o+1]+(y[o+1]-x[o+1])*alpha,z:x[o+2]+(y[o+2]-x[o+2])*alpha},false);
      this.a.fromArray(x,o+3);this.b.fromArray(y,o+3);this.a.slerp(this.b,alpha);ball.body.setRotation(this.a,false);
      ball.body.setLinvel({x:motion[o],y:motion[o+1],z:motion[o+2]},false);
    });
    if(active&&this.prediction.active){const pose=this.prediction.visual(Math.min(.1,dt)),i=w.seats.indexOf(this.slot),ball=g.balls[i];ball.body.setTranslation({x:pose[0],y:pose[1],z:pose[2]},false);ball.body.setRotation({x:pose[3],y:pose[4],z:pose[5],w:pose[6]},false);ball.heading=this.prediction.game.balls[i].heading;}
  }
  dispose(){this.prediction.dispose();}
}
