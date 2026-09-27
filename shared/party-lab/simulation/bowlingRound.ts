import type { MovementInput } from '../intent.js';
import {NET,type GameSnapshot,type GameEvent,type OnlinePhase} from '../network/protocol.js';
import {BowlingGame,IDLE_INPUT} from './bowling/game.js';
import {BowlingClock} from './bowling/clock.js';
import {bowlingSection,bowlingTransforms} from './bowling/wire.js';
import {newRoomCounters,type RoomCounters,type OnlineSimulation} from './online.js';
import type {PlayerId} from './players.js';
/** The exact local Rapier game, with every occupied seat driven by room inputs. */
export class BowlingRoundSimulation implements OnlineSimulation {
 readonly mode='human_bowling' as const;
 phase:OnlinePhase='waiting'; mask=0; game:BowlingGame; clock=new BowlingClock();
 seats:PlayerId[]=[]; private forfeits=new Set<number>(); private resultTime=0; private throwTime=0; private throttle=0;
 constructor(readonly counters:RoomCounters=newRoomCounters(),private seed=7281){this.game=new BowlingGame(2,seed,true);}
 get tick(){return this.counters.tick;} get roundId(){return this.counters.round;}
 get activeSeat(){return this.seats[this.game.score.current]??-1;}
 get seconds(){return this.phase==='countdown'?Math.max(0,2.1-this.game.phaseTime):this.phase==='results'?Math.max(0,10-this.resultTime):0;}
 get winner(){const w=this.game.score.winners;return this.phase==='results'&&w.length===1?this.seats[w[0]]:-1;}
 start(slots:readonly PlayerId[]){
  if(this.phase!=='waiting'||slots.length<2||slots.length>3||new Set(slots).size!==slots.length||slots.some(s=>s<0||s>2))return false;
  this.seats=[...slots].sort((a,b)=>a-b);this.mask=slots.reduce<number>((m,s)=>m|1<<s,0);this.forfeits.clear();
  this.game.dispose();this.game=new BowlingGame(slots.length as 2|3,this.seed++,true);this.clock=new BowlingClock();
  this.counters.round++;this.phase='countdown';this.resultTime=this.throwTime=0;return true;
 }
 cancelCountdown(){if(this.phase==='countdown'){this.phase='waiting';this.mask=0;}}
 neutralize(_slot:PlayerId){/* The room clears the mailbox; the authoritative throw survives. */}
 remove(slot:PlayerId){if(this.mask&(1<<slot))this.forfeits.add(slot);}
 step(inputs:readonly MovementInput[]):GameEvent[]{
  this.counters.tick++;if(this.phase==='waiting')return [];
  if(this.phase==='results'){if((this.resultTime+=1/NET.physicsHz)>=10){this.phase='waiting';this.mask=0;}return [];}
  const g=this.game,turn=g.score.turn,p=inputs[this.activeSeat]?.bowling;
  const input=p&&p.turn===turn&&!this.forfeits.has(this.activeSeat)?{throttle:p.throttle,brake:p.brake,steer:p.steer,pitch:p.pitch,eject:p.space}:IDLE_INPUT;
  this.throttle=input.throttle;this.throwTime+=1/NET.physicsHz;
  // A committed stationary charge has no local timeout. Bound that exceptional
  // online stall without changing a normal throw's 18 s drive / 25 s settle rules.
  if(this.throwTime>65||this.forfeits.has(this.activeSeat)&&g.phase==='drive'){
    g.cancelCharge();g.missedEject=!g.ejected;g.phase='flight';g.finishThrow();
  }else this.clock.advance(g,1/NET.physicsHz,input);
  if(g.score.turn!==turn)this.throwTime=0;
  if(this.phase==='countdown'&&g.phase!=='countdown')this.phase='playing';
  if(g.phase==='results'){this.phase='results';this.resultTime=0;}
  return [];
 }
 snapshot(ack:number[]):GameSnapshot{
  return {v:NET.version,mode:this.mode,seq:++this.counters.snapshot,tick:this.tick,round:this.roundId,phase:this.phase,seconds:this.seconds,winner:this.winner,mask:this.mask,alive:this.mask,states:[],meters:[],grips:[],ack,transforms:bowlingTransforms(this.game),bowling:bowlingSection(this.game,this.clock,this.seats,this.throttle)};
 }
 prediction(slot:PlayerId){return {slot,velocities:new Uint8Array(),controller:[]};}
 dispose(){this.game.dispose();}
}
