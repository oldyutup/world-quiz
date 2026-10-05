import { IDLE, add, sub, unit, distance, clamp, type FightInput, type Vec } from './config';
import { clearLine, inside, gatherSurface, type Solid } from './map';
export type Personality = 'aggressive' | 'cautious' | 'mobile';
export interface SeenPlayer { id: number; p: Vec; v: Vec; hp: number; crouch: boolean; protected: boolean }
export interface SeenBall { id: number; owner: number; p: Vec; v: Vec; born: number }
export interface BotSense { now: number; me: SeenPlayer; ammo: number; grounded: boolean; solids: readonly Solid[]; speed: number; gravity: number; players: SeenPlayer[]; projectiles: SeenBall[]; half: number }

/** Perceives only released, visible balls. No throw input, aim intent or future events. */
export function perceivableBalls(s: BotSense, yaw: number) {
  const eye=add(s.me.p,{x:0,y:s.me.crouch?.85:1.5,z:0});
  return s.projectiles.filter(b=>b.owner!==s.me.id && b.born<=s.now && distance(eye,b.p)<15 &&
    (b.p.x-eye.x)*Math.sin(yaw)+(b.p.z-eye.z)*Math.cos(yaw)>-.5 && clearLine(s.solids,eye,b.p));
}

/** Small deterministic grid search, replanned at reaction speed, never every frame. */
function route(solids: readonly Solid[], from: Vec, goal: Vec, half: number): Vec[] {
  if(clearLine(solids,add(from,{x:0,y:.65,z:0}),add(goal,{x:0,y:.65,z:0}),.4))return[goal];
  const spacing=1.25, limit=Math.floor((half-1)/spacing), width=limit*2+1;
  const cell=(p:Vec)=>[clamp(Math.round(p.x/spacing),-limit,limit),clamp(Math.round(p.z/spacing),-limit,limit)];
  const [sx,sz]=cell(from),[gx,gz]=cell(goal), key=(x:number,z:number)=>(x+limit)*width+z+limit;
  const open=[[sx,sz]], prev=new Map<number,number>(), points=new Map<number,Vec>();
  const start=key(sx,sz);prev.set(start,-1);points.set(start,{x:sx*spacing,y:0,z:sz*spacing});
  let end=start,best=Infinity;
  for(let i=0;i<open.length && i<625;i++){
    const [x,z]=open[i],k=key(x,z),d=(x-gx)**2+(z-gz)**2;
    if(d<best){best=d;end=k;}if(d===0)break;
    for(const [dx,dz]of[[1,0],[-1,0],[0,1],[0,-1]]){
      const nx=x+dx,nz=z+dz,n=key(nx,nz),p={x:nx*spacing,y:.75,z:nz*spacing};
      if(Math.abs(nx)>limit||Math.abs(nz)>limit||prev.has(n)||solids.some(s=>inside(p,s,.44)))continue;
      prev.set(n,k);points.set(n,{...p,y:0});open.push([nx,nz]);
    }
  }
  const out:Vec[]=[];while(end!==start&&prev.has(end)){out.unshift(points.get(end)!);end=prev.get(end)!;}return out;
}

export class FightBot {
  readonly personality: Personality;
  private nextThink=0;private nextThrow=0;private nextJump=0;
  private route:Vec[]=[];private goal:Vec|null=null;
  private seen=new Map<number,number>();private aim:Vec|undefined;private yaw=Math.PI;
  private target:SeenPlayer|undefined;private dodgeUntil=0;private dodge={x:0,z:0};
  private restocking=false;private wander=0;private error={x:0,y:0,z:0};
  constructor(readonly id:number,private random:()=>number,personality?:Personality){this.personality=personality??(['mobile','aggressive','cautious'] as const)[id%3];}
  think(s:BotSense):FightInput{
    const out={...IDLE,yaw:this.yaw,aim:this.aim};
    if(s.ammo===0||(s.ammo===1&&this.personality==='cautious'))this.restocking=true;
    if(s.ammo>=3)this.restocking=false;
    if(s.me.hp<=0)return out;
    const eye=add(s.me.p,{x:0,y:1.4,z:0});
    const visible=perceivableBalls(s,this.yaw),ids=new Set(visible.map(b=>b.id));
    for(const id of this.seen.keys())if(!ids.has(id))this.seen.delete(id);
    for(const b of visible){
      if(!this.seen.has(b.id))this.seen.set(b.id,s.now);
      if(s.now-this.seen.get(b.id)!<.21)continue;
      const dx=s.me.p.x-b.p.x,dz=s.me.p.z-b.p.z,vv=b.v.x*b.v.x+b.v.z*b.v.z;
      const t=(dx*b.v.x+dz*b.v.z)/Math.max(vv,1);
      if(t>.06&&t<.65&&Math.hypot(dx-b.v.x*t,dz-b.v.z*t)<.8&&this.dodgeUntil<s.now && this.random()<.36){
        const side=this.random()<.5?-1:1,n=Math.sqrt(vv);this.dodge={x:-b.v.z/n*side,z:b.v.x/n*side};this.dodgeUntil=s.now+.34;
      }
    }
    if(s.now>=this.nextThink){
      this.nextThink=s.now+.24+this.random()*.10;
      const enemies=s.players.filter(p=>p.id!==this.id&&p.hp>0);
      const seen=enemies.filter(p=>clearLine(s.solids,eye,add(p.p,{x:0,y:p.crouch?.7:1.25,z:0})));
      this.target=seen.sort((a,b)=>distance(a.p,s.me.p)-distance(b.p,s.me.p))[0];
      const target=this.target??enemies.sort((a,b)=>distance(a.p,s.me.p)-distance(b.p,s.me.p))[0];
      if(target){
        const d=distance(target.p,s.me.p),t=Math.min(1.1,d/s.speed);
        // Delayed sampled velocity, partial lead, and refreshed error, never exact interception.
        if(s.now>this.nextThrow-.2)this.error={x:(this.random()-.5)*.85,y:(this.random()-.5)*.3,z:(this.random()-.5)*.85};
        this.aim=add(add(target.p,{x:target.v.x*t*.78,y:(target.crouch?.67:1.15)+s.gravity*t*t*.53,z:target.v.z*t*.78}),this.error);
        this.yaw=Math.atan2(this.aim.x-s.me.p.x,this.aim.z-s.me.p.z);
        const low=this.restocking;
        if(!this.goal||distance(s.me.p,this.goal)<1||this.wander<s.now){
          this.wander=s.now+2.4+this.random()*1.8;
          if(low){
            const covers=s.solids.filter(b=>b.kind==='bank'&&b.half.y>.4).map(b=>{
              const away=unit(sub(b.p,target.p));return {x:b.p.x+away.x*(b.half.x+1),y:0,z:b.p.z+away.z*(b.half.z+1)};
            }).filter(p=>gatherSurface(s.solids,{...p,y:.025},true,s.half));
            this.goal=covers.sort((a,b)=>distance(a,s.me.p)-distance(b,s.me.p))[0]??s.me.p;
          }else{
            const range=this.personality==='aggressive'?6.3:this.personality==='mobile'?8.5:9.5;
            const a=Math.atan2(s.me.p.x-target.p.x,s.me.p.z-target.p.z)+(this.random()-.5)*1.5;
            this.goal={x:clamp(target.p.x+Math.sin(a)*range,-s.half+2,s.half-2),y:0,z:clamp(target.p.z+Math.cos(a)*range,-s.half+2,s.half-2)};
          }
        }
        this.route=route(s.solids,s.me.p,this.goal,s.half);
      }
    }
    out.yaw=this.yaw;out.aim=this.aim;
    while(this.route.length&&Math.hypot(this.route[0].x-s.me.p.x,this.route[0].z-s.me.p.z)<.55)this.route.shift();
    const waypoint=this.route[0];
    if(waypoint){const d=unit(sub(waypoint,s.me.p));out.x=d.x;out.z=d.z;}
    const low=this.restocking;
    const nearCover=s.solids.some(b=>b.kind==='bank'&&b.half.y>.4&&Math.abs(b.p.x-s.me.p.x)<b.half.x+1.5&&Math.abs(b.p.z-s.me.p.z)<b.half.z+1.5);
    if(low&&gatherSurface(s.solids,s.me.p,s.grounded,s.half)&&(!waypoint||nearCover||!this.target||s.ammo===0)){
      out.x=out.z=0;out.gather=true;out.crouch=nearCover;
    }else out.sprint=!!waypoint&&(low||this.personality==='mobile'||!this.target);
    if(!out.gather&&this.target&&!this.target.protected&&s.ammo>0&&s.now>=this.nextThrow){
      out.throw=true;this.nextThrow=s.now+(this.personality==='aggressive'?.85:1.2)+this.random()*.45;out.sprint=false;
    }
    if(s.now<this.dodgeUntil){out.x=this.dodge.x;out.z=this.dodge.z;out.sprint=true;out.gather=false;out.crouch=false;}
    if(!out.gather&&waypoint&&s.grounded&&s.now>this.nextJump){
      const blocked=!clearLine(s.solids,add(s.me.p,{x:0,y:.4,z:0}),add(s.me.p,{x:out.x*1.1,y:.4,z:out.z*1.1}),.35);
      if(blocked||s.now<this.dodgeUntil){out.jump=true;this.nextJump=s.now+2.5+this.random()*3;}
    }
    return out;
  }
}
