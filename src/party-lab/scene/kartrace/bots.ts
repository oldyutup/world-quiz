import { angle, clamp, steeringRate, type DriveInput } from './config';
import type { RaceCar } from './car';
import type { RaceTrack } from './track';
import { missedCheckpoint, type Progress } from './rules';

/** Pure pursuit + curvature/braking preview. Every personality drives the same chassis. */
export class RacingBot {
  reverseUntil=0; blocked=0; offset=0;
  recovering:number|null=null;
  constructor(readonly id:number,readonly style:'clean'|'aggressive'|'fast'=id===1?'aggressive':'clean'){}
  input(car:RaceCar,cars:RaceCar[],track:RaceTrack,time:number,progress:Progress):DriveInput {
    const p=car.body.translation(),v=car.speed,q=car.projection,look=clamp(5+v*.48,6,20);
    // A wide collision can miss a finite gate. Backtrack along the actual route
    // using S/steering, then drive through it normally. Never teleport or award it.
    if(this.recovering!==null&&this.recovering!==progress.next)this.recovering=null;
    if(missedCheckpoint(progress,track,q.s))this.recovering=progress.next;
    if(this.recovering!==null){
      const gate=track.checkpoints[this.recovering];let past=track.wrap(q.s-gate.s);if(past>track.length/2)past-=track.length;
      if(past< -9)this.recovering=null;
      else {const target=track.pose(q.s-clamp(5+v*.4,6,10)),reverseHeading=Math.atan2(p.x-target.x,p.z-target.z),turn=clamp(angle(reverseHeading-car.heading)*1.7,-1,1);return {throttle:0,brake:1,steer:turn*(car.forwardSpeed>1?1:-1)};}
    }
    let line=this.style==='aggressive'?.45:this.style==='clean'?-.65:0;
    for(const other of cars){if(other===car)continue;const b=other.body.translation(),dx=b.x-p.x,dz=b.z-p.z,ahead=dx*q.point.tx+dz*q.point.tz,side=dx*q.point.tz-dz*q.point.tx;
      if(ahead>0&&ahead<17&&Math.abs(side)<3.5)line=(side>=0?-1:1)*(this.style==='clean'?2.65:2.0);
    }
    // Small line error, not a stat advantage or speed rubber band.
    line+=Math.sin(time*.63+this.id*7)*(this.style==='fast'?.12:.32);
    this.offset+=(line-this.offset)*.035;
    const target=track.pose(q.s+look,this.offset),dx=target.x-p.x,dz=target.z-p.z;
    const error=angle(Math.atan2(dx,dz)-car.heading),distance=Math.max(2,Math.hypot(dx,dz));
    const yawRate=2*Math.max(4,v)*Math.sin(error)/distance;
    let steer=clamp(yawRate/Math.max(.3,steeringRate(v)),-1,1);
    if(Math.abs(error)>1.1)steer=clamp(error*1.5,-1,1);
    let desired=car.maxSpeed;
    for(let ahead=0;ahead<=65;ahead+=3){const next=track.at(q.s+ahead),cornerSpeed=Math.min(car.maxSpeed,Math.sqrt(10.5/Math.max(.002,next.curve)));desired=Math.min(desired,Math.sqrt(cornerSpeed**2+2*12*Math.max(0,ahead-5)));}
    if(Math.abs(error)>.65)desired=Math.min(desired,12);
    if(Math.abs(error)>1.1)desired=7;
    if(q.distance>q.point.width/2)desired=Math.min(desired,12);
    if(v<1.2&&time>5)this.blocked+=1/60;else this.blocked=0;
    if(this.blocked>1.2){this.reverseUntil=time+1.3;this.blocked=0;}
    if(time<this.reverseUntil){steer=-Math.sign(error||1);return {throttle:0,brake:1,steer};}
    return {throttle:v<desired+.2?1:0,brake:v>desired+1.0?clamp((v-desired)/5,0,1):0,steer};
  }
}
