import type {MovementInput} from '../intent.js';
import {NET,type GameSnapshot,type OnlinePhase} from '../network/protocol.js';
import {classicEventTime} from '../network/classicInput.js';
import {ClassicGame,type ClassicEvent} from './classicbowling/game.js';
import {positionAt,directionAt,powerAt} from './classicbowling/config.js';
import {classicTransforms,type ClassicWire} from './classicbowling/wire.js';
import {newRoomCounters,type RoomCounters,type OnlineSimulation} from './online.js';
import type {PlayerId} from './players.js';
import {seatRanks} from '../board/rules.js';
import {PLAYERS} from './players.js';
const selecting=(phase:string)=>['position','direction','power'].includes(phase);
export class ClassicRoundSimulation implements OnlineSimulation{
 readonly mode='classic_bowling' as const;phase:OnlinePhase='waiting';mask=0;game:ClassicGame;seats:PlayerId[]=[];epoch=0;phaseStart=0;
 private seed:number;private countdown=0;private resultTime=0;private forfeits=new Set<number>();private sequence:number[]=[];private eventId=0;private events:{id:number;kind:ClassicEvent}[]=[];
 constructor(readonly counters:RoomCounters=newRoomCounters(),seed=7281,readonly now:()=>number=Date.now){this.seed=seed;this.game=new ClassicGame(2,seed);this.game.bots=false;}
 get tick(){return this.counters.tick;}get roundId(){return this.counters.round;}get seconds(){return this.phase==='countdown'?this.countdown:this.phase==='results'?Math.max(0,10-this.resultTime):0;}
 get winner(){const w=this.game.score.winners;return this.phase==='results'&&w.length===1?this.seats[w[0]]:-1;}
 placements(){return seatRanks(this.seats,this.game.score.totals,PLAYERS.length);}
 start(slots:readonly PlayerId[]){if(this.phase!=='waiting'||slots.length<2||slots.length>3||new Set(slots).size!==slots.length||slots.some(s=>!Number.isInteger(s)||s<0||s>2))return false;
  this.seats=[...slots].sort((a,b)=>a-b);this.mask=slots.reduce<number>((m,s)=>m|1<<s,0);this.forfeits.clear();this.sequence=slots.map(()=>-1);this.game.dispose();this.game=new ClassicGame(slots.length as 2|3,++this.seed);this.game.bots=false;this.counters.round++;this.phase='countdown';this.countdown=3;this.epoch=0;this.events=[];this.eventId=0;this.resultTime=0;return true;
 }
 cancelCountdown(){if(this.phase==='countdown'){this.phase='waiting';this.mask=0;}}neutralize(_slot:PlayerId){}
 remove(slot:PlayerId){const index=this.seats.indexOf(slot);if(index>=0)this.forfeits.add(index);}
 step(inputs:readonly MovementInput[]){this.counters.tick++;if(this.phase==='waiting')return[];
  if(this.phase==='results'){if((this.resultTime+=1/60)>=10){this.phase='waiting';this.mask=0;}return[];}
  const now=this.now(),g=this.game;
  if(this.phase==='countdown'){this.countdown=Math.max(0,this.countdown-1/60);if(this.countdown<=0){this.phase='playing';this.phaseStart=now;}return[];}
  const before=g.phase,seat=g.score.seat,p=inputs[this.seats[seat]]?.classic;
  let select=false;
  if(selecting(g.phase)){
   g.time+=1/60;
   g.phaseTime=Math.max(0,(now-this.phaseStart)/1000);
   if(p&&p.seq>this.sequence[seat]){this.sequence[seat]=p.seq;select=p.pressed&&p.epoch===this.epoch&&!this.forfeits.has(seat);}
   if(select){const t=(classicEventTime(p!.eventTime,now,this.phaseStart)-this.phaseStart)/1000;
    if(g.phase==='position')g.position=positionAt(t);else if(g.phase==='direction')g.angle=directionAt(t);else g.power=powerAt(t);
    g.events.length=0;g.select();
   }else if(this.forfeits.has(seat)||g.phaseTime>=30){
    // A forfeited/idle seat cannot hold the room indefinitely. Zero pins, no client score.
    g.events.length=0;g.score.record(0);g.lastPins=0;g.message='SÜRE DOLDU';g.phase='feedback';g.phaseTime=0;g.events.push('score');
   }else g.advance(0);
  }else g.advance(1/60);
  for(const kind of g.events)this.events.push({id:++this.eventId,kind});if(this.events.length>24)this.events.splice(0,this.events.length-24);
  if(g.phase!==before){this.epoch++;this.phaseStart=now;}
  if(g.phase==='results'){this.phase='results';this.resultTime=0;}return[];
 }
 snapshot(ack:number[]):GameSnapshot{const g=this.game,w:ClassicWire={seats:this.seats,seed:this.seed,epoch:this.epoch,phaseStart:this.phaseStart,serverNow:this.now(),time:g.time,velocity:g.ball?Object.values(g.ball.linvel()):[0,0,0],state:{...g.snapshot(),bot:false},pinIds:g.pins.map(p=>p.id),down:g.pins.filter(p=>p.down).map(p=>p.id),ball:!!g.ball,events:this.events.map(e=>({...e}))};return{v:NET.version,mode:this.mode,seq:++this.counters.snapshot,tick:this.tick,round:this.roundId,phase:this.phase,seconds:this.seconds,winner:this.winner,mask:this.mask,alive:this.mask,states:[],meters:[],grips:[],ack,transforms:classicTransforms(g),classic:w};}
 prediction(slot:PlayerId){return{slot,velocities:new Uint8Array(),controller:[]};}dispose(){this.game.dispose();}
}
