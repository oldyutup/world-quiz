import RAPIER from '@dimforge/rapier3d-compat';
import { SnowballGame } from '../../../../shared/party-lab/simulation/snowball/game';
import { SNOWBALL as C, arenaRadiusAt } from '../../../../shared/party-lab/simulation/snowball/config';
import { snowballScreenInput } from '../../../../shared/party-lab/simulation/snowball/screenInput';
import { snowballMotion } from '../../../../shared/party-lab/simulation/snowball/wire';
import { snowballAxes, type SnowballInputPacket } from '../../../../shared/party-lab/network/snowballInput';
import type { BufferedSnapshot } from '../gameStream';
import { InputHistory, PREDICTION_LIMITS } from './history';
import { RigCorrection } from './correction';

/** Predict physical motion only. Remote spheres coast from server velocities so
 * contact is physical, never a fabricated knockback. Every snapshot restores ALL
 * positions and linear/angular momentum before replay. No client scoring/kill step. */
export class SnowballPrediction {
  readonly game:SnowballGame; readonly history=new InputHistory(); readonly correction=new RigCorrection(1);
  readonly metrics={corrections:0,hard:0,maxError:0,overflows:0,replaySteps:0};
  active=false; private seq=-1; private epoch=''; private index=-1; private initialized=false;
  private pose=new Float32Array(7); private shown=new Float32Array(7);
  private contactAssistance=false;
  constructor(readonly slot:number,players:2|3){this.game=new SnowballGame(players);this.game.bots=false;}
  private capture(){const b=this.game.balls[this.index],p=b.body.translation(),q=b.body.rotation();this.pose.set([p.x,p.y,p.z,q.x,q.y,q.z,q.w]);return this.pose;}
  reconcile(frame:BufferedSnapshot,now:number){
    if(frame.snapshot.seq<=this.seq)return;this.seq=frame.snapshot.seq;
    const s=frame.snapshot,w=s.snowball;if(!w)return;
    const epoch=`${s.round}:${w.stage}`,index=w.seats.indexOf(this.slot),active=w.phase==='playing'&&index>=0&&!!(s.alive&(1<<this.slot));
    if(epoch!==this.epoch||!active||!this.active){this.history.clear();this.correction.clear();this.initialized=false;}
    this.epoch=epoch;this.index=index;this.active=active;
    const before=this.shown.slice(),g=this.game,m=snowballMotion(w),v=frame.values;
    g.elapsed=w.elapsed;g.radius=w.radius;g.floor.setEnabled(w.radius>0);if(w.radius>0)g.floor.setShape(new RAPIER.Cylinder(.65,w.radius));
    g.balls.forEach((b,i)=>{const o=i*7;b.alive=!!(s.alive&(1<<w.seats[i]));b.body.setEnabled(b.alive);
      b.body.setTranslation({x:v[o],y:v[o+1],z:v[o+2]},true);b.body.setRotation({x:v[o+3],y:v[o+4],z:v[o+5],w:v[o+6]},true);
      b.body.setLinvel({x:m[o],y:m[o+1],z:m[o+2]},true);b.body.setAngvel({x:m[o+3],y:m[o+4],z:m[o+5]},true);b.heading=m[o+6];
      b.body.resetForces(true);b.body.resetTorques(true);
    });
    // Protocol 12 already carries an extensible controller array. An older
    // server's empty array keeps legacy prediction; snapshots remain authority.
    this.contactAssistance=g.restoreContactState(s.prediction?.slot===this.slot?s.prediction.controller:undefined);
    if(!active)return;
    this.history.acknowledge(s.ack[this.slot]);
    if(this.history.records.some(p=>now-p.sentAt>PREDICTION_LIMITS.staleMs)){this.history.clear();this.initialized=false;}
    for(const record of this.history.records)if('keys' in record.packet)for(let i=0;i<record.ticks;i++){this.run(record.packet);this.metrics.replaySteps++;}
    const pose=this.capture();
    if(this.initialized){
      // A rolling sphere's decorative orientation is not a facing constraint.
      // Keep translation easing, without the ragdoll's 90° facing teleport guard.
      before.set(pose.subarray(3,7),3);
      const vel=g.balls[index].body.linvel(),r=this.correction.begin(before,pose,Math.max(1,1+Math.hypot(vel.x,vel.z)*.25));
      this.metrics.maxError=Math.max(this.metrics.maxError,r.error);if(r.tier!=='none')this.metrics.corrections++;if(r.tier==='hard')this.metrics.hard++;
    }
  }
  private run(p:SnowballInputPacket){
    const g=this.game,b=g.balls[this.index],axes=snowballAxes(p.keys);
    for(let i=0;i<2;i++){
      g.elapsed+=C.step;const radius=arenaRadiusAt(g.elapsed);if(Math.abs(radius-g.radius)>.01||radius===0){g.radius=radius;g.floor.setEnabled(radius>0);if(radius>0)g.floor.setShape(new RAPIER.Cylinder(.65,radius));}
      const v=b.body.linvel();g.drive(b,snowballScreenInput(axes.x,axes.z,b.heading,Math.hypot(v.x,v.z)));g.hits.length=0;g.stepPhysics(this.contactAssistance);
    }
  }
  step(packet:SnowballInputPacket,now:number){if(!this.active)return;if(!this.history.add(packet,1,now)){this.metrics.overflows++;this.active=false;return;}this.run(packet);}
  visual(dt:number){this.initialized=true;return this.correction.apply(this.capture(),dt,this.shown);}
  dispose(){this.game.dispose();}
}
