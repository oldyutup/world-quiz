import type { MovementInput } from '../intent.js';
import { NET, type GameSnapshot, type GameEvent, type OnlinePhase } from '../network/protocol.js';
import { snowballAxes } from '../network/snowballInput.js';
import { SnowballGame } from './snowball/game.js';
import { SNOWBALL as C, IDLE } from './snowball/config.js';
import { snowballScreenInput } from './snowball/screenInput.js';
import { snowballSection, snowballTransforms } from './snowball/wire.js';
import { newRoomCounters, type RoomCounters, type OnlineSimulation } from './online.js';
import type { PlayerId } from './players.js';

/** Latest physical elimination wins an all-fall. Exact-tick ties rotate priority
 * through occupied seats each round, seeded once by the authoritative match. */
export function snowballTie(out: readonly number[], excluded: ReadonlySet<number>, stage: number, seed: number) {
  const candidates=out.flatMap((t,i)=>!excluded.has(i)&&t>=0?[i]:[]);
  if (!candidates.length) return -1;
  const last=Math.max(...candidates.map(i=>out[i])), start=(seed+stage-1)%out.length;
  return candidates.filter(i=>out[i]===last).sort((a,b)=>(a-start+out.length)%out.length-(b-start+out.length)%out.length)[0];
}
/** Room runs at 60 Hz; each step executes the unchanged local 120 Hz Rapier game twice. */
export class SnowballRoundSimulation implements OnlineSimulation {
  readonly mode='snowball_brawl' as const;
  phase:OnlinePhase='waiting'; mask=0; game:SnowballGame;
  seats:PlayerId[]=[]; out:number[]=[]; readonly forfeits=new Set<number>(); private resultTime=0;
  constructor(readonly counters:RoomCounters=newRoomCounters(),private seed=731) { this.game=new SnowballGame(2, C.arenaRadius, seed);this.game.bots=false; }
  get tick(){return this.counters.tick;} get roundId(){return this.counters.round;}
  get seconds(){return this.phase==='countdown'?Math.max(0,Math.ceil(C.countdown-this.game.phaseTime)):this.phase==='results'?Math.max(0,10-this.resultTime):0;}
  get winner(){const wins=this.game.wins,max=Math.max(...wins),leaders=wins.flatMap((n,i)=>n===max?[i]:[]);return this.phase==='results'&&leaders.length===1?this.seats[leaders[0]]:-1;}
  start(slots:readonly PlayerId[]) {
    if(this.phase!=='waiting'||slots.length<2||slots.length>3||new Set(slots).size!==slots.length||slots.some(s=>!Number.isInteger(s)||s<0||s>2))return false;
    this.seats=[...slots].sort((a,b)=>a-b);this.mask=slots.reduce<number>((m,s)=>m|1<<s,0);this.forfeits.clear();this.out=slots.map(()=>-1);
    this.game.dispose();this.game=new SnowballGame(slots.length as 2|3,C.arenaRadius,this.seed++);this.game.bots=false;
    this.counters.round++;this.phase='countdown';this.resultTime=0;return true;
  }
  cancelCountdown(){if(this.phase==='countdown'){this.phase='waiting';this.mask=0;}}
  neutralize(_slot:PlayerId){/* Room mailbox clears; body, momentum and shrink clock survive. */}
  remove(slot:PlayerId){const i=this.seats.indexOf(slot);if(i>=0){this.forfeits.add(i);this.game.balls[i].alive=false;this.game.balls[i].body.setEnabled(false);}}
  accepts(slot:number,stage:number){const i=this.seats.indexOf(slot as PlayerId);return this.phase==='playing'&&this.game.phase==='playing'&&stage===this.game.round&&i>=0&&this.game.balls[i].alive&&!this.forfeits.has(i);}
  step(inputs:readonly MovementInput[]):GameEvent[] {
    this.counters.tick++;if(this.phase==='waiting')return [];
    if(this.phase==='results'){if((this.resultTime+=1/NET.physicsHz)>=10){this.phase='waiting';this.mask=0;}return [];}
    const events:GameEvent[]=[];
    for(let sub=0;sub<2;sub++){
      const g=this.game,stage=g.round,phase=g.phase,alive=g.balls.map(b=>b.alive);
      const intent=g.balls.map((b,i)=>{const p=inputs[this.seats[i]]?.snowball;if(!p||p.stage!==g.round||!this.accepts(this.seats[i],p.stage))return IDLE;const a=snowballAxes(p.keys),v=b.body.linvel();return snowballScreenInput(a.x,a.z,b.heading,Math.hypot(v.x,v.z));});
      g.step(IDLE,intent);
      for(let i=0;i<g.count;i++)if(alive[i]&&!g.balls[i].alive&&!this.forfeits.has(i))this.out[i]=g.tick;
      for(const hit of g.hits)events.push({id:++this.counters.event,round:this.roundId,tick:this.tick,name:'heavyBump',x:hit.x,intensity:Math.min(.8,hit.energy/16),snow:[Math.round(hit.x*100),Math.round(hit.y*100),Math.round(hit.z*100)]});
      if(phase!=='roundOver'&&g.phase==='roundOver'&&g.winner<0){const winner=snowballTie(this.out,this.forfeits,g.round,g.seed);g.winner=winner;if(winner>=0)g.wins[winner]++;}
      if(g.round!==stage){this.out.fill(-1);for(const i of this.forfeits){g.balls[i].alive=false;g.balls[i].body.setEnabled(false);}}
      if(this.phase==='countdown'&&g.phase!=='countdown')this.phase='playing';
      if(g.phase==='results'){this.phase='results';this.resultTime=0;break;}
    }
    return events;
  }
  snapshot(ack:number[]):GameSnapshot { return {v:NET.version,mode:this.mode,seq:++this.counters.snapshot,tick:this.tick,round:this.roundId,phase:this.phase,seconds:this.seconds,winner:this.winner,mask:this.mask,
    alive:this.game.balls.reduce((m,b,i)=>m|(b.alive?1<<this.seats[i]:0),0),states:[],meters:[],grips:[],ack,transforms:snowballTransforms(this.game),snowball:snowballSection(this.game,this.seats,this.out)}; }
  prediction(slot:PlayerId){return {slot,velocities:new Uint8Array(),controller:[]};}
  dispose(){this.game.dispose();}
}
