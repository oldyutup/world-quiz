import RAPIER from '@dimforge/rapier3d-compat';
import { FIGHT as C, IDLE, seeded, add, sub, mul, unit, length, flight, clamp, leaders, type Vec, type FightInput } from './config';
import { makeMap, gatherSurface, safeSpawn, surfaceAt, type Solid } from './map';
import { FightBot, type BotSense } from './bots';
export interface Fighter {
  id:number;body:RAPIER.RigidBody;collider:RAPIER.Collider;hp:number;ammo:number;score:number;
  crouch:boolean;grounded:boolean;groundTime:number;gather:number;gatherBlocked:number;
  yaw:number;throwAt:number;flinch:number;respawnAt:number;protection:number;lastThrow:boolean;lastJump:boolean;
  lastHit:number;kos:number;respawns:number;gathers:number;throws:number;hits:number;previous:Vec;
}
export interface Ball {id:number;owner:number;p:Vec;previous:Vec;v:Vec;born:number;age:number}
export interface FightEvent { kind:'throw'|'pack'|'gather'|'impact'|'hit'|'ko'|'respawn'|'start'|'finish'|'jump'; p:Vec; actor:number; target?:number; head?:boolean }
export interface FightSnapshot {phase:'countdown'|'playing'|'results';seconds:number;elapsed:number;players:{hp:number;ammo:number;score:number;gather:number;respawn:number;protected:boolean;crouch:boolean}[];canGather:boolean;hitMarker:boolean;leaders:number[];lastHit:number}
export interface FightOptions {duration?:number;hp?:number;size?:number;speed?:number;gravity?:number}
const Q={x:0,y:0,z:0,w:1};
export class SnowFightGame {
  readonly world:RAPIER.World;readonly solids:Solid[];readonly players:Fighter[];readonly brains:FightBot[];
  readonly duration:number;readonly maxHp:number;readonly size:number;readonly speed:number;readonly gravity:number;
  phase:FightSnapshot['phase']='countdown';time=0;elapsed=0;countdown=0;balls:Ball[]=[];events:FightEvent[]=[];
  bots=true;autoHuman=false;physicsMs=0;invalidBodies=0;peakProjectiles=0;serial=0;
  totals={throws:0,hits:0,kos:0,respawns:0,gathers:0,blocked:0,expired:0,impacts:0};
  private nextBall=1;private disposed=false;private sphere=new RAPIER.Ball(C.ballRadius);
  constructor(readonly count:2|3,seed=71,options:FightOptions={}){
    if(count!==2&&count!==3)throw Error('Snowball Fight needs 2 or 3 seats');
    this.duration=options.duration??C.duration;this.maxHp=options.hp??C.hp;this.size=options.size??C.arenaSize;this.speed=options.speed??C.throwSpeed;this.gravity=options.gravity??C.ballGravity;
    this.solids=makeMap(this.size);this.world=new RAPIER.World({x:0,y:-C.gravity,z:0});this.world.timestep=C.step;
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(this.size/2,.4,this.size/2).setTranslation(0,-.4,0).setFriction(0));
    for(const s of this.solids)this.world.createCollider(RAPIER.ColliderDesc.cuboid(s.half.x,s.half.y,s.half.z).setTranslation(s.p.x,s.p.y,s.p.z).setFriction(0));
    const random=seeded(seed);this.brains=Array.from({length:count},(_,i)=>new FightBot(i,seeded(Math.floor(random()*1e9)),(['aggressive','cautious','mobile'] as const)[(seed+i)%3]));
    this.players=[];
    for(let i=0;i<count;i++){
      const p=i===0?{x:-.8,y:.025,z:8.3}:safeSpawn(this.solids,this.players.map(p=>p.body.translation()),i,this.size/2);
      const body=this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x,p.y,p.z).lockRotations().setCanSleep(false).setCcdEnabled(true));
      const collider=this.world.createCollider(RAPIER.ColliderDesc.capsule(C.height/2-C.radius,C.radius).setTranslation(0,C.height/2,0).setMass(C.mass).setFriction(0).setRestitution(0),body);
      this.players.push({id:i,body,collider,hp:this.maxHp,ammo:C.inventory,score:0,crouch:false,grounded:true,groundTime:1,gather:0,gatherBlocked:0,yaw:Math.atan2(-p.x,-p.z),throwAt:0,flinch:0,respawnAt:0,protection:0,lastThrow:false,lastJump:false,lastHit:-10,kos:0,respawns:0,gathers:0,throws:0,hits:0,previous:{...p}});
    }
    this.world.step();
  }
  sense(id:number):BotSense {
    const players=this.players.map(p=>({id:p.id,p:p.body.translation(),v:p.body.linvel(),hp:p.hp,crouch:p.crouch,protected:p.protection>this.time}));
    return {now:this.time,me:players[id],ammo:this.players[id].ammo,grounded:this.players[id].grounded,solids:this.solids,speed:this.speed,gravity:this.gravity,players,projectiles:this.balls.map(b=>({id:b.id,owner:b.owner,p:{...b.p},v:{...b.v},born:b.born})),half:this.size/2};
  }
  /** Camera ray chooses a world target; only the hand-to-target direction launches a ball. */
  aimPoint(origin:Vec,forward:Vec,owner=0):Vec {
    const hit=this.world.castRay(new RAPIER.Ray(origin,forward),45,true,undefined,undefined,undefined,this.players[owner].body);
    return add(origin,mul(forward,hit?Math.max(.2,hit.timeOfImpact):45));
  }
  hand(p:Fighter):Vec { const at=p.body.translation();return add(at,{x:Math.sin(p.yaw)*.40-Math.cos(p.yaw)*.34,y:p.crouch?.73:1.32,z:Math.cos(p.yaw)*.40+Math.sin(p.yaw)*.34}); }
  private sweep(o:Vec,delta:Vec,owner:number){return this.world.castShape(o,Q,delta,this.sphere,0,1,true,undefined,undefined,undefined,this.players[owner].body,c=>this.players.every(p=>p.collider.handle!==c.handle||p.hp>0));}
  throwBall(p:Fighter,aim:Vec) {
    if(p.hp<=0||p.ammo<=0||this.time<p.throwAt||this.balls.length>=C.ballCap)return false;
    p.ammo--;p.throws++;this.totals.throws++;p.throwAt=this.time+C.throwInterval;p.protection=0;p.gather=0;
    const origin=this.hand(p),center=add(p.body.translation(),{x:0,y:p.crouch?.73:1.32,z:0});
    this.events.push({kind:'throw',p:origin,actor:p.id});
    // Camera-peeking cannot move the hand through cover: check chest -> hand first.
    const blocked=this.sweep(center,sub(origin,center),p.id);
    if(blocked){this.totals.blocked++;this.events.push({kind:'impact',p:add(center,mul(sub(origin,center),blocked.time_of_impact)),actor:p.id});return true;}
    const v=mul(unit(sub(aim,origin)),this.speed);
    this.balls.push({id:this.nextBall++,owner:p.id,p:origin,previous:{...origin},v,born:this.time,age:0});
    this.peakProjectiles=Math.max(this.peakProjectiles,this.balls.length);return true;
  }
  private stance(p:Fighter,want:boolean){
    if(p.crouch===want)return;
    if(!want){
      // Only test the newly occupied head room, excluding ground and own collider.
      const at=add(p.body.translation(),{x:0,y:(C.height+C.crouchHeight)/2+.01,z:0});
      if(this.world.intersectionWithShape(at,Q,new RAPIER.Cuboid(C.radius-.02,(C.height-C.crouchHeight)/2-.02,C.radius-.02),undefined,undefined,p.collider,p.body))return;
    }
    p.crouch=want;const height=want?C.crouchHeight:C.height;
    p.collider.setShape(new RAPIER.Capsule(height/2-C.radius,C.radius));p.collider.setTranslationWrtParent({x:0,y:height/2,z:0});p.collider.setMass(C.mass);
  }
  private move(p:Fighter,i:FightInput){
    const at=p.body.translation(),v=p.body.linvel();p.previous={...at};p.yaw=Number.isFinite(i.yaw)?i.yaw:p.yaw;
    const floor=this.world.castRay(new RAPIER.Ray(add(at,{x:0,y:.15,z:0}),{x:0,y:-1,z:0}),.24,true,RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    p.grounded=!!floor&&v.y<.7;p.groundTime=p.grounded?p.groundTime+C.step:0;
    this.stance(p,i.crouch);
    const canGather=i.gather&&!i.sprint&&p.ammo<C.inventory&&this.time>=p.gatherBlocked&&gatherSurface(this.solids,at,p.grounded,this.size/2);
    if(canGather){
      if(p.gather===0)this.events.push({kind:'pack',p:at,actor:p.id});
      p.gather+=C.step;
      if(p.gather+1e-8>=C.gather){p.gather=0;p.ammo++;p.gathers++;this.totals.gathers++;this.events.push({kind:'gather',p:at,actor:p.id});}
    }else p.gather=0;
    const n=Math.max(1,Math.hypot(i.x,i.z)),speed=canGather?C.gatherSpeed:p.crouch?C.crouch:i.sprint?C.sprint:C.walk;
    const tx=clamp(i.x,-1,1)/n*speed,tz=clamp(i.z,-1,1)/n*speed;
    const dx=tx-v.x,dz=tz-v.z,d=Math.hypot(dx,dz),acc=p.grounded?(Math.hypot(i.x,i.z)>.05?C.acceleration:C.braking):C.airAcceleration;
    const limit=acc*C.step*(this.time<p.flinch?.35:1),f=Math.min(1,limit/Math.max(d,.001));
    p.body.applyImpulse({x:dx*f*C.mass,y:0,z:dz*f*C.mass},true);
    if(i.jump&&!p.lastJump&&p.grounded&&p.groundTime>=C.groundedReset&&!p.crouch&&!canGather){p.body.applyImpulse({x:0,y:(C.jump-v.y)*C.mass,z:0},true);p.grounded=false;p.groundTime=0;this.events.push({kind:'jump',p:at,actor:p.id});}
    p.lastJump=i.jump;
    if(i.throw&&!p.lastThrow&&!canGather)this.throwBall(p,i.aim??add(this.hand(p),{x:Math.sin(p.yaw)*30,y:2,z:Math.cos(p.yaw)*30}));
    p.lastThrow=i.throw;
  }
  private hit(ball:Ball,target:Fighter,point:Vec){
    if(target.hp<=0||target.protection>this.time)return;
    const at=target.body.translation(),head=point.y>at.y+(target.crouch?.78:1.43);
    target.hp--;target.lastHit=this.time;target.gather=0;target.gatherBlocked=this.time+.28;target.flinch=this.time+C.flinch;
    const energy=clamp(length(ball.v)/C.throwSpeed,.7,1.2),push=(head?2.25:1.85)*energy,d=unit(ball.v);
    target.body.applyImpulse({x:d.x*push*C.mass,y:Math.max(.08,d.y*.25)*C.mass,z:d.z*push*C.mass},true);
    this.players[ball.owner].hits++;this.totals.hits++;this.events.push({kind:'hit',p:point,actor:ball.owner,target:target.id,head});
    if(target.hp===0){target.kos++;target.respawnAt=this.time+C.respawn;target.collider.setEnabled(false);target.body.setEnabled(false);this.players[ball.owner].score++;this.totals.kos++;this.events.push({kind:'ko',p:point,actor:ball.owner,target:target.id});}
  }
  respawn(p:Fighter){
    const at=safeSpawn(this.solids,this.players.filter(e=>e.id!==p.id&&e.hp>0).map(e=>e.body.translation()),++this.serial,this.size/2);
    p.body.setEnabled(true);p.collider.setEnabled(true);p.body.setTranslation(at,true);p.body.setLinvel({x:0,y:0,z:0},true);
    p.hp=this.maxHp;p.ammo=C.inventory;p.respawnAt=0;p.protection=this.time+C.protection;p.gather=0;p.gatherBlocked=0;p.flinch=0;p.grounded=true;p.groundTime=.2;p.previous={...at};p.respawns++;this.totals.respawns++;
    this.stance(p,false);this.events.push({kind:'respawn',p:at,actor:p.id});
  }
  step(human:FightInput=IDLE){
    if(this.disposed)return;this.events=[];
    if(this.phase==='results')return;
    this.time+=C.step;
    if(this.phase==='countdown'){this.countdown+=C.step;if(this.countdown+1e-8>=C.countdown){this.phase='playing';this.events.push({kind:'start',p:this.players[0].body.translation(),actor:0});}return;}
    this.elapsed=Math.min(this.duration,this.elapsed+C.step);
    for(const p of this.players){
      if(p.hp<=0){if(this.time+1e-8>=p.respawnAt)this.respawn(p);continue;}
      const input=p.id===0&&!this.autoHuman?human:this.bots||p.id===0?this.brains[p.id].think(this.sense(p.id)):IDLE;
      this.move(p,input);
    }
    const start=performance.now();this.world.step();this.physicsMs=performance.now()-start;
    // Exact constant-gravity positions with a swept sphere for each fixed-tick segment.
    // Balls have no accumulating rigid bodies and cannot tunnel between samples.
    for(let j=this.balls.length-1;j>=0;j--){
      const b=this.balls[j],next=flight(b.p,b.v,C.step,this.gravity),delta=sub(next,b.p);b.previous={...b.p};
      const hit=this.sweep(b.p,delta,b.owner);b.age+=C.step;
      if(hit){
        const point=add(b.p,mul(delta,hit.time_of_impact)),target=this.players.find(p=>p.collider.handle===hit.collider.handle);
        if(target)this.hit(b,target,point);
        this.events.push({kind:'impact',p:point,actor:b.owner});this.totals.impacts++;this.balls.splice(j,1);
      }else if(b.age>=C.ballLife||next.y<-.5){this.balls.splice(j,1);this.totals.expired++;}
      else{b.p=next;b.v.y-=this.gravity*C.step;}
    }
    for(const p of this.players){const at=p.body.translation(),v=p.body.linvel();if(![at.x,at.y,at.z,v.x,v.y,v.z].every(Number.isFinite))this.invalidBodies++;}
    if(this.elapsed+1e-8>=this.duration){this.elapsed=this.duration;this.phase='results';this.balls=[];this.events.push({kind:'finish',p:this.players[0].body.translation(),actor:0});}
  }
  snapshot():FightSnapshot {return {phase:this.phase,seconds:Math.ceil(this.phase==='countdown'?C.countdown-this.countdown:this.duration-this.elapsed),elapsed:this.elapsed,players:this.players.map(p=>({hp:p.hp,ammo:p.ammo,score:p.score,gather:p.gather/C.gather,respawn:Math.max(0,p.respawnAt-this.time),protected:p.protection>this.time,crouch:p.crouch})),canGather:gatherSurface(this.solids,this.players[0].body.translation(),this.players[0].grounded,this.size/2),hitMarker:this.events.some(e=>e.kind==='hit'&&e.actor===0),leaders:leaders(this.players.map(p=>p.score)),lastHit:this.players[0].lastHit};}
  stats(){return {bodies:this.world.bodies.len(),colliders:this.world.colliders.len(),projectiles:this.balls.length,peak:this.peakProjectiles,invalid:this.invalidBodies,...this.totals};}
  floor(p:Vec){return surfaceAt(this.solids,p.x,p.z,p.y+.15).y;}
  dispose(){if(!this.disposed){this.disposed=true;this.balls=[];this.world.free();}}
}
