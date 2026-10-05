/** Reproducible 3-seat simulation/serialization benchmark; clients supply semantic test-driver input. */
import {writeFileSync} from 'node:fs';
import {cpus} from 'node:os';
import {getMessageBytes,Protocol} from '../servers/party-lab/node_modules/@colyseus/core/build/index.mjs';
import {initializePhysics} from '../shared/party-lab/simulation/physics';
import {CrateRoundSimulation} from '../shared/party-lab/simulation/crateRound';
import {FightRoundSimulation} from '../shared/party-lab/simulation/fightRound';
import {RaceRoundSimulation} from '../shared/party-lab/simulation/raceRound';
import {ClassicRoundSimulation} from '../shared/party-lab/simulation/classicRound';
import {neutralIntent,NET} from '../shared/party-lab/network/protocol';
const stat=(a:number[])=>{const sorted=[...a].sort((a,b)=>a-b);return{n:a.length,avg:a.reduce((a,b)=>a+b,0)/a.length,p95:sorted[Math.floor((a.length-1)*.95)],p99:sorted[Math.floor((a.length-1)*.99)],max:sorted[sorted.length-1]};};
await initializePhysics();let now=10000;const rows=[];
for(const kind of ['crate','fight','race','classic']){
 const s=kind==='crate'?new CrateRoundSimulation():kind==='fight'?new FightRoundSimulation():kind==='race'?new RaceRoundSimulation():new ClassicRoundSimulation(undefined,7280,()=>now);
 s.start([0,1,2]);const g=s.game,sim:number[]=[],physics:number[]=[],snapshot:number[]=[],payload:number[]=[],input:number[]=[];
 const original=g.world.step.bind(g.world);g.world.step=(...args:Parameters<typeof original>)=>{const a=performance.now();original(...args);physics.push(performance.now()-a);};
 let ticks=0;
 try{for(;ticks<30000&&s.phase!=='results';ticks++){
  now+=1000/60;const intents=Array.from({length:3},neutralIntent);
  if(s instanceof CrateRoundSimulation){const g=s.game;g.players.forEach((p,i)=>{const at=p.body.translation(),d=g.botBrains[i].think({...at,grounded:p.grounded,elapsed:g.elapsed,half:g.half,warnings:g.warnings.filter(w=>!w.landed).map(w=>({...w,radius:.7})),height:(x,z)=>g.surface(x,z).y,clear:()=>true});intents[i].crate={seq:ticks,round:s.roundId,stage:g.round,moveX:d.x,moveZ:d.z,jumpHeld:d.jump,sprintHeld:d.sprint};});}
  else if(s instanceof FightRoundSimulation){const g=s.game;g.players.forEach((p,i)=>{const d=g.brains[i].think(g.sense(i)),at=p.body.translation(),aim=d.aim??{x:0,y:1,z:0};intents[i].fight={seq:ticks,round:s.roundId,life:p.respawns,moveX:d.x,moveZ:d.z,yaw:Math.atan2(aim.x-at.x,aim.z-at.z),pitch:-Math.atan2(aim.y-(at.y+(p.crouch?1:1.58)),Math.hypot(aim.x-at.x,aim.z-at.z)+5.2),jumpHeld:d.jump,sprintHeld:d.sprint,crouchHeld:d.crouch,gatherHeld:d.gather,throwPressed:d.throw};});}
  else if(s instanceof RaceRoundSimulation){const g=s.game;g.cars.forEach((c,i)=>{const d=g.drivers[i].input(c,g.cars,g.track,g.time,g.progress[i]);intents[i].race={seq:ticks,round:s.roundId,resetEpoch:g.progress[i].resets,throttle:d.throttle,brake:d.brake,steer:d.steer,handbrake:!!d.handbrake,reset:!!d.reset};});}
  else {const g=s.game,key=g.phase;if(s.phase==='playing'&&(key==='position'||key==='direction'||key==='power')){const t=g.plan[key];intents[g.score.seat].classic={seq:ticks,round:s.roundId,epoch:s.epoch,pressed:now-s.phaseStart>=t*1000,eventTime:s.phaseStart+t*1000};}}
  const a=performance.now();s.step(intents);sim.push(performance.now()-a);
  if(ticks%3===0){const b=performance.now(),snap={...s.snapshot([ticks,ticks,ticks]),prediction:s.prediction(0)};payload.push(getMessageBytes.raw(Protocol.ROOM_DATA,'snapshot',snap).byteLength);snapshot.push(performance.now()-b);const p=intents[0].crate??intents[0].fight??intents[0].race??intents[0].classic;if(p)input.push(getMessageBytes.raw(Protocol.ROOM_DATA,'input',p).byteLength);}
 }
 const stats=g.stats();if(stats.invalid!==0||s.phase!=='results')throw Error(`${kind}: invalid/incomplete`);
 rows.push({mode:s.mode,seconds:ticks/60,simulationMs:stat(sim),physicsMs:stat(physics),snapshotEncodeMs:stat(snapshot),snapshotBytes:stat(payload),downKBps:stat(payload).avg*NET.snapshotHz/1000,inputBytes:stat(input),upKBps:stat(input).avg*NET.inputHz/1000,stats,result:s.snapshot([])});
 }finally{s.dispose();}
}
const report={cpu:cpus()[0]?.model,protocol:NET.version,physicsHz:NET.physicsHz,snapshotHz:NET.snapshotHz,inputHz:NET.inputHz,rows};
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,rows:rows.map(({result,...row})=>row)},null,2));
