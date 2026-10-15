import { CAR_LENGTH, DRAFT, angle, clamp, steeringRate, type DriveInput } from './config.js';
import type { RaceCar } from './car.js';
import type { RaceTrack } from './track.js';
import { missedCheckpoint, type Progress } from './rules.js';

/** Pure pursuit + curvature/braking preview. Every personality drives the same chassis. */
export class RacingBot {
  reverseUntil=0; blocked=0; offset=0;
  recovering:number|null=null;
  /** The car being passed after its tow, on which side (+1/−1 lateral) and until when; kept until the bot is by it. */
  passing:number|null=null; passSide=1; passUntil=0;
  constructor(readonly id:number,readonly style:'clean'|'aggressive'|'fast'=id===1?'aggressive':'clean'){}
  input(car:RaceCar,cars:RaceCar[],track:RaceTrack,time:number,progress:Progress):DriveInput {
    const p=car.body.translation(),v=car.speed,q=car.projection,look=clamp(5+v*.48,6,20);
    // A wide collision can miss a finite gate. Backtrack along the actual route
    // using S/steering, then drive through it normally. Never teleport or award it.
    if(this.recovering!==null&&this.recovering!==progress.next)this.recovering=null;
    // The miss stays flagged until the gate is earned: back up only while still past it.
    if(missedCheckpoint(progress)&&this.recovering===null){const gate=track.checkpoints[progress.next];let past=track.wrap(q.s-gate.s);if(past>track.length/2)past-=track.length;if(past>-2)this.recovering=progress.next;}
    if(this.recovering!==null){
      const gate=track.checkpoints[this.recovering];let past=track.wrap(q.s-gate.s);if(past>track.length/2)past-=track.length;
      if(past< -9)this.recovering=null;
      else {const target=track.pose(q.s-clamp(5+v*.4,6,10)),reverseHeading=Math.atan2(p.x-target.x,p.z-target.z),turn=clamp(angle(reverseHeading-car.heading)*1.7,-1,1);return {throttle:0,brake:1,steer:turn*(car.forwardSpeed>1?1:-1)};}
    }
    let line=this.style==='aggressive'?.45:this.style==='clean'?-.65:0;
    // Rüzgâr alma: on a straight, tuck in a few metres behind a car ahead to build its tow and close
    // in on it. Once the tow is up and the wake is near (where it eases out), pull out beside that
    // car, on the inside of the next corner when there is room, and pass on the slingshot. The pass
    // is kept until the bot is by it (no weaving back into its wake), unless the car gets away, time
    // runs out, another car is on that line, or a corner comes before the bot overlaps it on the
    // inside. Level with a car: hold this side of it; into a corner the inside car, once it overlaps
    // the other, keeps its line and the other drops back. Any other car ahead: keep a car's width
    // beside its line, never on it.
    const straight=Math.max(q.point.curve,track.at(q.s+20).curve,track.at(q.s+45).curve)<.006,pullOut=this.style==='clean'?.5:.8;
    const cornerNear=Math.max(q.point.curve,track.at(q.s+25).curve)>=.006;
    // The inside of the next corner within 120 m (+1/−1 lateral, 0 if none).
    let inside=0;for(let d=0;d<=120;d+=6){const a=track.at(q.s+d);if(a.curve<.006)continue;const b=track.at(q.s+d+15);inside=Math.sign(a.tz*b.tx-a.tx*b.tz);break;}
    let yieldTo=Infinity;const edge=q.point.width/2-1.5,beside=(other:RaceCar,side:number,by:number)=>{const l=other.projection.lateral,at=clamp(l+side*by,-edge,edge);return Math.abs(at-l)>2.4?at:clamp(l-side*by,-edge,edge);};
    const where=(other:RaceCar)=>{const b=other.body.translation(),dx=b.x-p.x,dz=b.z-p.z;return {ahead:dx*q.point.tx+dz*q.point.tz,side:dx*q.point.tz-dz*q.point.tx};};
    const onInside=(side:number)=>inside!==0&&Math.sign(-side)===inside;
    if(this.passing!==null){const other=cars[this.passing],at=other&&where(other);
      if(!at||!other.body.isEnabled()||at.ahead< -(CAR_LENGTH+1.5)||at.ahead>35||time>this.passUntil||(cornerNear&&(!onInside(at.side)||at.ahead>CAR_LENGTH-.5)))this.passing=null;}
    for(const other of cars){if(other===car||!other.body.isEnabled())continue;const {ahead,side}=where(other),gap=ahead-CAR_LENGTH,level=Math.abs(ahead)<CAR_LENGTH+1.5&&Math.abs(side)<4.5;
      if(level&&!straight&&(inside===0?ahead>0:ahead>(onInside(side)?CAR_LENGTH-.5:.5-CAR_LENGTH)))yieldTo=Math.min(yieldTo,other.forwardSpeed-2.5);
      if(other.id===this.passing)continue;
      if(level)line=clamp(other.projection.lateral-Math.sign(side||1)*3,-edge,edge);
      else if(straight&&this.passing===null&&gap>.5&&gap<28&&Math.abs(side)<4.5&&v>15&&other.forwardSpeed>DRAFT.minSpeed){
        // Too close for a tow (the bumper): ease off into the wake.
        if(car.draft<pullOut||gap>DRAFT.minGap+DRAFT.ease+1){line=other.projection.lateral;if(gap<DRAFT.minGap+.5)yieldTo=Math.min(yieldTo,other.forwardSpeed-1);}
        else {this.passing=other.id;this.passUntil=time+8;const l=other.projection.lateral,mine=q.lateral-l;this.passSide=inside||(Math.abs(mine)>.3?Math.sign(mine):l<0?1:-1);}
      }
      else if(ahead>0&&ahead<17&&Math.abs(side)<3.5)line=beside(other,side>=0?-1:1,this.style==='clean'?3.1:2.7);
    }
    if(this.passing!==null){
      const other=cars[this.passing],at=beside(other,this.passSide,3.2);
      const taken=cars.some(o=>{if(o===car||o===other||!o.body.isEnabled())return false;const {ahead}=where(o);return ahead>0&&ahead<17&&Math.abs(o.projection.lateral-at)<2.4;});
      if(taken)this.passing=null;else {this.passSide=Math.sign(at-other.projection.lateral)||this.passSide;line=at;}
    }
    // Small line error, not a stat advantage or speed rubber band.
    line+=Math.sin(time*.63+this.id*7)*(this.style==='fast'?.12:.32);
    this.offset+=(line-this.offset)*.035;
    const target=track.pose(q.s+look,this.offset),dx=target.x-p.x,dz=target.z-p.z;
    const error=angle(Math.atan2(dx,dz)-car.heading),distance=Math.max(2,Math.hypot(dx,dz));
    const yawRate=2*Math.max(4,v)*Math.sin(error)/distance;
    let steer=clamp(yawRate/Math.max(.3,steeringRate(v)),-1,1);
    if(Math.abs(error)>1.1)steer=clamp(error*1.5,-1,1);
    // Up to the top speed it has now: a tow's (or the catch-up help's) is used, not wasted.
    let desired=car.topSpeed;
    for(let ahead=0;ahead<=65;ahead+=3){const next=track.at(q.s+ahead),cornerSpeed=Math.min(desired,Math.sqrt(10.5/Math.max(.002,next.curve)));desired=Math.min(desired,Math.sqrt(cornerSpeed**2+2*12*Math.max(0,ahead-5)));}
    desired=Math.min(desired,Math.max(6,yieldTo));
    if(Math.abs(error)>.65)desired=Math.min(desired,12);
    if(Math.abs(error)>1.1)desired=7;
    if(q.distance>q.point.width/2)desired=Math.min(desired,12);
    if(v<1.2&&time>5)this.blocked+=1/60;else this.blocked=0;
    if(this.blocked>1.2){this.reverseUntil=time+1.3;this.blocked=0;}
    if(time<this.reverseUntil){steer=-Math.sign(error||1);return {throttle:0,brake:1,steer};}
    return {throttle:v<desired+.2?1:0,brake:v>desired+1.0?clamp((v-desired)/5,0,1):0,steer};
  }
}
