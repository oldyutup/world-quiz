import RAPIER from '@dimforge/rapier3d-compat';
import { GROUP, IDLE, NAMES, RACE, groups, yaw, type DriveInput, type Vec } from './config.js';
import { RaceTrack } from './track.js';
import { RaceCar } from './car.js';
import { RacingBot } from './bots.js';
import { advance, missedCheckpoint, newProgress, raceOrder, wrongWay } from './rules.js';

export interface RaceOptions { scale?:number; width?:number; maxSpeed?:number; laps?:number }
export interface RaceSnapshot { phase:'countdown'|'racing'|'results';countdown:number;time:number;lap:number;laps:number;position:number;count:number;speed:number;grass:boolean;wrong:boolean;missed:boolean;resetting:boolean;finalLap:boolean;order:{id:number;name:string;finish:number|null;laps:number}[]; winner:number|null; camera?:string }
export class RaceGame {
  readonly world:RAPIER.World;
  readonly track:RaceTrack;
  readonly cars:RaceCar[];
  readonly progress;
  readonly drivers:RacingBot[];
  readonly queue=new RAPIER.EventQueue(true);
  readonly laps:number;
  readonly lapAt:number[];
  phase:RaceSnapshot['phase']='countdown';countdown=RACE.countdown as number;time=0;firstFinish:number|null=null;
  bots=true;autoHuman=false;physicsMs=0;contacts=0;invalid=0;events:{kind:'start'|'lap'|'finish'|'reset'|'impact';id:number;intensity:number}[]=[];
  private resetHeld=false; private networkResetHeld:boolean[]=[];private disposed=false;
  constructor(readonly count:2|3,options:RaceOptions={}){
    if(count!==2&&count!==3)throw new Error('Race supports 2–3 local racers');
    this.laps=options.laps??RACE.laps;this.track=new RaceTrack(options.scale,options.width);this.world=new RAPIER.World({x:0,y:-20,z:0});this.world.timestep=RACE.step;
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(this.track.land.flatMap(p=>[p.x,p.y,p.z])),new Uint32Array(this.track.landIndices)).setFriction(.08).setCollisionGroups(groups(GROUP.ground,GROUP.car)));
    for(const b of this.track.barriers)this.world.createCollider(RAPIER.ColliderDesc.cuboid(.28,b.height/2,b.length/2).setTranslation(b.x,b.height/2,b.z).setRotation(yaw(b.yaw)).setFriction(.12).setRestitution(.12).setCollisionGroups(groups(GROUP.wall,GROUP.car)));
    for(const t of this.track.trees)this.world.createCollider(RAPIER.ColliderDesc.cylinder(3.8*t.scale,1.05*t.scale).setTranslation(t.x,3.8*t.scale,t.z).setFriction(.12).setCollisionGroups(groups(GROUP.wall,GROUP.car)));
    for(const z of [40,67])this.world.createCollider(RAPIER.ColliderDesc.cuboid(3.4,3.1,3.4).setTranslation(-15,3.1,z).setCollisionGroups(groups(GROUP.wall,GROUP.car)));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(2.5,2,2.5).setTranslation(-22,2,17).setCollisionGroups(groups(GROUP.wall,GROUP.car)));
    const finish=this.track.at(0),finishYaw=Math.atan2(finish.tx,finish.tz);
    for(const side of [-1,1]){const off=side*(finish.width/2+1);this.world.createCollider(RAPIER.ColliderDesc.cuboid(.175,3,.175).setTranslation(finish.x+finish.tz*off,3,finish.z-finish.tx*off).setRotation(yaw(finishYaw)).setCollisionGroups(groups(GROUP.wall,GROUP.car)));}
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(finish.width/2+1,.95,.08).setTranslation(finish.x,5.7,finish.z).setRotation(yaw(finishYaw)).setCollisionGroups(groups(GROUP.wall,GROUP.car)));
    this.cars=Array.from({length:count},(_,i)=>new RaceCar(this.world,this.track,i,options.maxSpeed));
    this.lapAt=this.cars.map(()=>-10);this.progress=this.cars.map(newProgress);this.drivers=this.cars.map((_,i)=>new RacingBot(i,i===0?'fast':i===1?'aggressive':'clean'));
    this.world.step();
  }
  resetCar(id:number){
    const p=this.progress[id],car=this.cars[id];if(this.time-p.lastReset<3||p.finish!==null)return false;
    const last=(p.next-1+this.track.checkpoints.length)%this.track.checkpoints.length;
    const s=p.started?this.track.checkpoints[last].s-2:-7;
    let at:Vec=this.track.pose(s),chosen=s,best=-Infinity;
    search: for(const back of [0,5,10])for(const offset of [0,-2.5,2.5]){
      const q=this.track.pose(s-back,offset),clear=Math.min(...this.cars.filter(c=>c!==car).map(c=>Math.hypot(c.body.translation().x-q.x,c.body.translation().z-q.z)));
      if(clear>best){best=clear;at=q;chosen=s-back;}if(clear>5)break search;
    }
    const t=this.track.at(chosen);car.place(at,Math.atan2(t.tx,t.tz));p.hold=RACE.resetHold;p.lastReset=this.time;p.resets++;p.stuck=p.wrongDwell=p.rightDwell=0;p.wrong=false;this.drivers[id].reverseUntil=0;
    this.drivers[id].recovering=null;
    this.events.push({kind:'reset',id,intensity:.4});return true;
  }
  /** Bounded client replay: all chassis make physical contact; no checkpoint/score/reset decisions. */
  predictStep(inputs:readonly DriveInput[]){
    this.cars.forEach((c,i)=>c.step(this.progress[i].finish!==null?{...IDLE,brake:c.forwardSpeed>.4?1:0}:inputs[i]??IDLE,this.progress[i].hold>0));
    this.world.step();
  }
  step(input:DriveInput=IDLE,overrides?:readonly DriveInput[]){
    this.events=[];if(this.phase==='results')return;
    const dt=RACE.step;
    if(this.phase==='countdown'){
      this.countdown=Math.max(0,this.countdown-dt);
      this.cars.forEach(c=>c.step(IDLE,true));this.world.step();
      if(this.countdown<=0){this.phase='racing';this.events.push({kind:'start',id:0,intensity:1});}return;
    }
    this.time+=dt;
    if(overrides)this.cars.forEach((_,i)=>{const held=!!overrides[i]?.reset;if(held&&!this.networkResetHeld[i])this.resetCar(i);this.networkResetHeld[i]=held;});
    else {if(input.reset&&!this.resetHeld)this.resetCar(0);this.resetHeld=!!input.reset;}
    const before=this.cars.map(c=>c.speed);
    for(const [i,c]of this.cars.entries()){
      const p=this.progress[i];p.hold=Math.max(0,p.hold-dt);
      const drive=overrides?overrides[i]??IDLE:i===0&&!this.autoHuman?input:this.bots?this.drivers[i].input(c,this.cars,this.track,this.time,p):IDLE;
      c.step(p.finish!==null?{...IDLE,brake:c.forwardSpeed>.4?1:0}:drive,p.hold>0);
    }
    const start=performance.now();this.world.step(this.queue);this.physicsMs=performance.now()-start;
    this.queue.drainCollisionEvents((a,b,on)=>{if(!on)return;const car=this.cars.find(c=>c.collider.handle===a||c.collider.handle===b);if(!car)return;const other=a===car.collider.handle?b:a;if(this.world.getCollider(other)?.collisionGroups()>>>16===GROUP.ground)return;this.contacts++;this.events.push({kind:'impact',id:car.id,intensity:Math.min(1,Math.max(.15,(before[car.id]-car.speed)/12))});});
    for(const [i,c]of this.cars.entries()){
      const p=this.progress[i],at=c.body.translation(),v=c.body.linvel();
      if(![at.x,at.y,at.z,v.x,v.y,v.z].every(Number.isFinite)){this.invalid++;this.resetCar(i);continue;}
      if(p.finish!==null)continue;
      const oldLap=p.laps;
      advance(p,this.track,c.previous,at,this.time,this.laps);
      if(p.laps>oldLap){this.lapAt[i]=this.time;this.events.push({kind:p.finish!==null?'finish':'lap',id:i,intensity:1});}
      if(p.finish!==null){this.firstFinish??=this.time;continue;}
      const q=this.track.project(at);c.projection=q;
      wrongWay(p,v.x*q.point.tx+v.z*q.point.tz,dt);
      const rotation=c.body.rotation(),up=1-2*(rotation.x**2+rotation.z**2);
      const attempting=overrides?!!(overrides[i]?.throttle||overrides[i]?.brake):i!==0||this.autoHuman||input.throttle>0||input.brake>0;
      if(p.hold===0&&((c.speed<.7&&(c.grass||attempting))||up<.3))p.stuck+=dt;else p.stuck=0;
      if(at.y< -3||p.stuck>3.8||q.distance>60)this.resetCar(i);
    }
    if(this.progress.every(p=>p.finish!==null)||(this.firstFinish!==null&&this.time-this.firstFinish>RACE.finishGrace)||this.time>=RACE.timeout)this.phase='results';
  }
  snapshot(self=0):RaceSnapshot{
    const order=raceOrder(this.progress,this.track,this.cars.map(c=>c.projection.s)),me=this.progress[self];
    return {phase:this.phase,countdown:Math.ceil(this.countdown),time:this.time,lap:Math.min(this.laps,me.laps+1),laps:this.laps,position:order.indexOf(self)+1,count:this.count,speed:this.cars[self].speed*3.6,grass:this.cars[self].grass,wrong:me.wrong,missed:missedCheckpoint(me,this.track,this.cars[self].projection.s),resetting:me.hold>0,finalLap:me.laps===this.laps-1&&this.time-this.lapAt[self]<2.5,order:order.map(id=>({id,name:NAMES[id],finish:this.progress[id].finish,laps:this.progress[id].laps})),winner:this.firstFinish===null?null:order[0]};
  }
  stats(){return {dynamic:this.world.bodies.len(),colliders:this.world.colliders.len(),invalid:this.invalid,contacts:this.contacts,resets:this.progress.map(p=>p.resets)};}
  dispose(){if(this.disposed)return;this.disposed=true;this.queue.free();this.world.free();}
}
