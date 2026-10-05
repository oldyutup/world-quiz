import type {SnowFightGame,FightSnapshot,FightEvent} from './game.js';
export const FIGHT_FIELDS=['hp','ammo','score','crouch','grounded','groundTime','gather','gatherBlocked','yaw','throwAt','flinch','respawnAt','protection','lastThrow','lastJump','lastHit','kos','respawns','gathers','throws','hits'] as const;
export interface FightWire {
  seats:number[]; seed:number; phase:FightSnapshot['phase']; time:number; elapsed:number; countdown:number;
  players:number[][]; balls:number[][]; events:(FightEvent&{id:number})[]; held:number[];
}
export function fightTransforms(g:SnowFightGame){const bytes=new Uint8Array(g.count*28),view=new DataView(bytes.buffer);g.players.forEach((p,i)=>{const v=p.body.translation();[v.x,v.y,v.z,0,0,0,1].forEach((n,j)=>view.setFloat32((i*7+j)*4,n,true));});return bytes;}
export function fightSection(g:SnowFightGame,seats:number[],seed:number,events:FightWire['events'],held:number[]):FightWire{
  return {seats,seed,phase:g.phase,time:g.time,elapsed:g.elapsed,countdown:g.countdown,held:[...held],events:[...events],players:g.players.map(p=>{const v=p.body.linvel();return[v.x,v.y,v.z,...FIGHT_FIELDS.map(k=>Number(p[k]))];}),balls:g.balls.map(b=>[b.id,b.owner,b.p.x,b.p.y,b.p.z,b.v.x,b.v.y,b.v.z,b.born,b.age])};
}
export function restoreFight(g:SnowFightGame,w:FightWire,poses:ArrayLike<number>){
  g.phase=w.phase;g.time=w.time;g.elapsed=w.elapsed;g.countdown=w.countdown;g.events=[];
  g.players.forEach((p,i)=>{
    const a=w.players[i],o=i*7;g.restoreStance(i,!!a[6]);
    FIGHT_FIELDS.forEach((k,j)=>Object.assign(p,{[k]:['crouch','grounded','lastThrow','lastJump'].includes(k)?!!a[j+3]:a[j+3]}));
    p.body.setEnabled(p.hp>0);p.collider.setEnabled(p.hp>0);p.body.setTranslation({x:poses[o],y:poses[o+1],z:poses[o+2]},true);p.body.setLinvel({x:a[0],y:a[1],z:a[2]},true);p.previous=p.body.translation();
  });
  g.balls=w.balls.map(b=>({id:b[0],owner:b[1],p:{x:b[2],y:b[3],z:b[4]},previous:{x:b[2],y:b[3],z:b[4]},v:{x:b[5],y:b[6],z:b[7]},born:b[8],age:b[9]}));
  g.world.propagateModifiedBodyPositionsToColliders();
}
