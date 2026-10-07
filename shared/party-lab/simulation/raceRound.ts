import type {MovementInput} from '../intent.js';
import {NET,type GameSnapshot,type OnlinePhase} from '../network/protocol.js';
import {RaceGame} from './kartrace/game.js';
import {IDLE,type DriveInput} from './kartrace/config.js';
import {raceSection,raceTransforms} from './kartrace/wire.js';
import {newRoomCounters,type RoomCounters,type OnlineSimulation} from './online.js';
import type {PlayerId} from './players.js';
import {seatRanks} from '../board/rules.js';
import {PLAYERS} from './players.js';
export class RaceRoundSimulation implements OnlineSimulation{
 readonly mode='kart_race' as const;phase:OnlinePhase='waiting';mask=0;game:RaceGame;seats:PlayerId[]=[];
 private forfeits=new Set<number>();private resultTime=0;private sequences:number[]=[];private held:number[]=[];private inputs:DriveInput[]=[];
 constructor(readonly counters:RoomCounters=newRoomCounters()){this.game=new RaceGame(2);this.game.bots=false;}
 get tick(){return this.counters.tick;}get roundId(){return this.counters.round;}get seconds(){return this.phase==='countdown'?Math.max(0,this.game.countdown):this.phase==='results'?Math.max(0,10-this.resultTime):0;}
 get winner(){const w=this.game.snapshot().winner;return this.phase==='results'&&w!==null?this.seats[w]:-1;}
 /** Board placements: the race order (finishers by time, then distance covered). */
 placements(){const order=this.game.snapshot().order.map(o=>o.id);return seatRanks(this.seats,this.seats.map((_,i)=>-order.indexOf(i)),PLAYERS.length);}
 start(slots:readonly PlayerId[]){if(this.phase!=='waiting'||slots.length<2||slots.length>3||new Set(slots).size!==slots.length||slots.some(s=>!Number.isInteger(s)||s<0||s>2))return false;
  this.seats=[...slots].sort((a,b)=>a-b);this.mask=slots.reduce<number>((m,s)=>m|1<<s,0);this.forfeits.clear();this.sequences=slots.map(()=>-1);this.held=slots.map(()=>0);this.inputs=slots.map(()=>({...IDLE}));
  this.game.dispose();this.game=new RaceGame(slots.length as 2|3);this.game.bots=false;this.counters.round++;this.phase='countdown';this.resultTime=0;return true;
 }
 cancelCountdown(){if(this.phase==='countdown'){this.phase='waiting';this.mask=0;}}neutralize(_slot:PlayerId){/* Physics momentum survives temporary connection loss. */}
 remove(slot:PlayerId){const i=this.seats.indexOf(slot);if(i>=0){this.forfeits.add(i);this.game.cars[i].body.setEnabled(false);}}
 step(inputs:readonly MovementInput[]){this.counters.tick++;if(this.phase==='waiting')return[];if(this.phase==='results'){if((this.resultTime+=1/60)>=10){this.phase='waiting';this.mask=0;}return[];}
  const g=this.game;this.inputs=this.seats.map((slot,i)=>{const p=inputs[slot]?.race,seq=p?.seq??-1;this.held[i]=seq===this.sequences[i]?this.held[i]+1:0;this.sequences[i]=seq;
   return p&&p.resetEpoch===g.progress[i].resets&&!this.forfeits.has(i)?{throttle:p.throttle,brake:p.brake,steer:p.steer,handbrake:p.handbrake,reset:p.reset}:IDLE;
  });g.step(IDLE,this.inputs);
  if(this.phase==='countdown'&&g.phase!=='countdown')this.phase='playing';
  if(g.phase==='results'||g.progress.every((p,i)=>p.finish!==null||this.forfeits.has(i))){g.phase='results';this.phase='results';this.resultTime=0;}return[];
 }
 snapshot(ack:number[]):GameSnapshot{return{v:NET.version,mode:this.mode,seq:++this.counters.snapshot,tick:this.tick,round:this.roundId,phase:this.phase,seconds:this.seconds,winner:this.winner,mask:this.mask,alive:this.mask,states:[],meters:[],grips:[],ack,transforms:raceTransforms(this.game),race:raceSection(this.game,this.seats,this.held,this.inputs)};}
 prediction(slot:PlayerId){return{slot,velocities:new Uint8Array(),controller:[]};}dispose(){this.game.dispose();}
}
