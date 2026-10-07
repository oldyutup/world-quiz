import type {MovementInput} from '../intent.js';
import {NET,type GameSnapshot,type OnlinePhase} from '../network/protocol.js';
import {SnowFightGame} from './snowfight/game.js';
import {FIGHT as C,IDLE} from './snowfight/config.js';
import {newCamera,updateCamera} from './snowfight/camera.js';
import {fightSection,fightTransforms,type FightWire} from './snowfight/wire.js';
import {newRoomCounters,type RoomCounters,type OnlineSimulation} from './online.js';
import type {PlayerId} from './players.js';
import {seatRanks} from '../board/rules.js';
import {PLAYERS} from './players.js';
export class FightRoundSimulation implements OnlineSimulation{
 readonly mode='snowball_fight' as const;phase:OnlinePhase='waiting';mask=0;game:SnowFightGame;seats:PlayerId[]=[];
 private forfeits=new Set<number>();private resultTime=0;private cameras=Array.from({length:3},newCamera);private events:FightWire['events']=[];private event=0;private sequences:number[]=[];private held:number[]=[];
 constructor(readonly counters:RoomCounters=newRoomCounters(),private seed=71){this.game=new SnowFightGame(2,seed);this.game.bots=false;}
 get tick(){return this.counters.tick;}get roundId(){return this.counters.round;}
 get seconds(){return this.phase==='countdown'?Math.max(0,C.countdown-this.game.countdown):this.phase==='results'?Math.max(0,10-this.resultTime):0;}
 get winner(){const w=this.game.snapshot().leaders;return this.phase==='results'&&w.length===1?this.seats[w[0]]:-1;}
 placements(){return seatRanks(this.seats,this.game.players.map(p=>p.score),PLAYERS.length);}
 start(slots:readonly PlayerId[]){if(this.phase!=='waiting'||slots.length<2||slots.length>3||new Set(slots).size!==slots.length||slots.some(s=>!Number.isInteger(s)||s<0||s>2))return false;
  this.seats=[...slots].sort((a,b)=>a-b);this.mask=slots.reduce<number>((m,s)=>m|1<<s,0);this.forfeits.clear();this.sequences=slots.map(()=>-1);this.held=slots.map(()=>0);this.events=[];
  this.game.dispose();this.game=new SnowFightGame(slots.length as 2|3,++this.seed);this.game.bots=false;this.cameras=slots.map(newCamera);this.counters.round++;this.phase='countdown';this.resultTime=0;return true;
 }
 cancelCountdown(){if(this.phase==='countdown'){this.phase='waiting';this.mask=0;}}
 neutralize(_slot:PlayerId){/* Mailbox clears without recreating inventory or bodies. */}
 remove(slot:PlayerId){const i=this.seats.indexOf(slot);if(i>=0){this.forfeits.add(i);const p=this.game.players[i];p.hp=0;p.respawnAt=this.game.time+1e9;p.body.setEnabled(false);p.collider.setEnabled(false);}}
 step(inputs:readonly MovementInput[]){this.counters.tick++;if(this.phase==='waiting')return[];if(this.phase==='results'){if((this.resultTime+=1/60)>=10){this.phase='waiting';this.mask=0;}return[];}
  const g=this.game;
  const intents=this.seats.map((slot,i)=>{const p=inputs[slot]?.fight,f=g.players[i],seq=p?.seq??-1;this.held[i]=seq===this.sequences[i]?this.held[i]+1:0;this.sequences[i]=seq;
   if(!p||p.life!==f.respawns||this.forfeits.has(i)||f.hp<=0)return IDLE;
   const camera=updateCamera(this.cameras[i],g.solids,f.body.translation(),p.yaw,p.pitch,p.crouchHeld,C.step);
   return{x:p.moveX,z:p.moveZ,yaw:p.yaw,jump:p.jumpHeld,sprint:p.sprintHeld,crouch:p.crouchHeld,gather:p.gatherHeld,throw:p.throwPressed,aim:g.aimPoint(camera.position,camera.forward,i)};
  });g.step(IDLE,intents);
  for(const e of g.events)this.events.push({...e,id:++this.event});this.events=this.events.slice(-24);
  if(this.phase==='countdown'&&g.phase!=='countdown')this.phase='playing';if(g.phase==='results'){this.phase='results';this.resultTime=0;}return[];
 }
 snapshot(ack:number[]):GameSnapshot{return{v:NET.version,mode:this.mode,seq:++this.counters.snapshot,tick:this.tick,round:this.roundId,phase:this.phase,seconds:this.seconds,winner:this.winner,mask:this.mask,alive:this.game.players.reduce((m,p,i)=>m|(p.hp>0?1<<this.seats[i]:0),0),states:[],meters:[],grips:[],ack,transforms:fightTransforms(this.game),fight:fightSection(this.game,this.seats,this.seed,this.events,this.held)};}
 prediction(slot:PlayerId){return{slot,velocities:new Uint8Array(),controller:[]};}dispose(){this.game.dispose();}
}
