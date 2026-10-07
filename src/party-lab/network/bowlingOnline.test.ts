import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {Packr} from 'msgpackr';
import {initializePhysics} from '../../../shared/party-lab/simulation/physics';
import {BowlingRoundSimulation} from '../../../shared/party-lab/simulation/bowlingRound';
import {BowlingGame} from '../../../shared/party-lab/simulation/bowling/game';
import {BowlingClock} from '../../../shared/party-lab/simulation/bowling/clock';
import {BOWLING,FLIGHT,BULLET} from '../../../shared/party-lab/simulation/bowling/config';
import {courseSteering} from '../../../shared/party-lab/simulation/bowling/courseDriving';
import {NET,InputMailbox,neutralIntent,type GameSnapshot} from '../../../shared/party-lab/network/protocol';
import {validateBowlingInput,encodeBowlingInput,type BowlingInputPacket} from '../../../shared/party-lab/network/bowlingInput';
import {GAME_MODES,MixedRotation} from '../../../shared/party-lab/modes';
import {SnapshotBuffer} from './gameStream';
import {BowlingPrediction} from './prediction/bowlingRig';
import type {MovementInput} from '../../../shared/party-lab/intent';
before(initializePhysics);
const packr=new Packr({useRecords:false});
const packet=(seq=1,turn=0):BowlingInputPacket=>({seq,round:1,turn,throttle:1,brake:0,steer:0,pitch:0,space:false});
export function drive(g:BowlingGame,seq:number):BowlingInputPacket{
 const p=g.car.body.translation(),start=BOWLING.rampLip-1-g.car.speed*24/FLIGHT.angleRate*BULLET.scale;
 return {...packet(seq,g.score.turn),throttle:g.car.speed<150/3.6?1:0,brake:g.car.speed>150/3.6+.1?.55:0,steer:g.phase==='drive'?courseSteering(p,g.car.heading,g.car.speed,g.obstacles,g.car.stuntStates):0,pitch:0,space:g.phase==='drive'?p.z>=start&&(!g.charging||g.chargeTime<24/FLIGHT.angleRate):g.phase==='flight'&&g.score.round>1&&g.elapsed>.3&&g.elapsed<.5};
}
const inputs=(slot:number,p:BowlingInputPacket):MovementInput[]=>[0,1,2].map(i=>({...neutralIntent(),...(i===slot?{bowling:p}:{})}));
test('protocol 13 Bowling: 29-byte intent rejects state claims, bad flags, nonfinite values and stale epochs',()=>{
 assert.equal(NET.version,14);const p=packet();assert.deepEqual(validateBowlingInput(encodeBowlingInput(p)),p);
 for(const extra of [{score:10},{position:[0,0,0]},{angle:30},{pins:1023},{camera:2}])assert.equal(validateBowlingInput({...p,...extra}),null);
 assert.equal(validateBowlingInput({...p,throttle:NaN}),null);assert.equal(validateBowlingInput({...p,turn:9}),null);
 const b=encodeBowlingInput(p);b[28]=2;assert.equal(validateBowlingInput(b),null);
 const m=new InputMailbox();assert.ok(m.accept(p,1,0,'human_bowling'));assert.equal(m.accept(p,1,0,'human_bowling'),false);assert.equal(m.accept({...p,seq:2,round:2},1,0,'human_bowling'),false);
});
test('SPACE press/release between physics ticks survives mailbox coalescing; stale input neutralizes',()=>{
 const m=new InputMailbox();for(const [i,space] of [true,false,true,false].entries())assert.ok(m.accept({...packet(i+1),space},1,0,'human_bowling'));
 assert.deepEqual([0,1,2,3].map(()=>m.read(0).bowling?.space),[true,false,true,false]);assert.equal(m.read(301).bowling,undefined);
});
test('twelve-mode Mixed with three seats, eleven eligible modes with two: complete bags and no boundary repeat',()=>{
 for(const count of [2,3]){let seed=3;const r=new MixedRotation(()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32));r.setPlayers(count);const expected=GAME_MODES.filter(m=>count===3||m!=='prop_hunt');let last='';
 for(let bag=0;bag<100;bag++){const seen=[];for(let i=0;i<expected.length;i++){const next=r.next;assert.notEqual(next,last);seen.push(next);last=next;r.played();}assert.deepEqual(seen.sort(),[...expected].sort());assert.equal(seen.filter(m=>m==='human_bowling').length,1);}}
});
test('online physical first throw matches the approved shared local game at every tick',()=>{
 const sim=new BowlingRoundSimulation(undefined,7281),g=new BowlingGame(2,7281),clock=new BowlingClock();sim.start([0,2]);
 for(let tick=0;g.score.turn===0&&tick<5000;tick++){
  const p=drive(g,tick);sim.step(inputs(0,p));clock.advance(g,1/60,{throttle:p.throttle,brake:p.brake,steer:p.steer,pitch:p.pitch,eject:p.space});
  assert.deepEqual(sim.game.car.body.translation(),g.car.body.translation());assert.equal(sim.game.phase,g.phase);assert.equal(sim.game.angle,g.angle);assert.equal(sim.game.mask,g.mask);
 }
 assert.equal(g.score.turn,1);assert.deepEqual(sim.game.score.throws,g.score.throws);g.dispose();sim.dispose();
});
for(const seats of [[0,2],[0,1,2]] as const)test(`${seats.length}-player complete physical match: stable occupied seats, one eject/Nudge/score per throw, finite compact snapshots`,()=>{
 const s=new BowlingRoundSimulation(undefined,7281);assert.ok(s.start(seats));const times:number[]=[],sizes:number[]=[],order:number[]=[];let prevTurn=-1,ejects=0,nudges=0;
 for(let tick=0;tick<18000&&s.phase!=='results';tick++){
  const g=s.game;if(g.score.turn!==prevTurn){order.push(s.activeSeat);prevTurn=g.score.turn;}
  const wasEjected=g.ejected,wasNudged=g.nudgeUsed;const start=performance.now();s.step(inputs(s.activeSeat,drive(g,tick)));times.push(performance.now()-start);
  if(g.ejected&&!wasEjected)ejects++;if(g.nudgeUsed&&!wasNudged)nudges++;
  if(tick%3===0){const snap=s.snapshot([tick,tick,tick]);sizes.push(packr.pack(snap).length);const buffer=new SnapshotBuffer();assert.ok(buffer.push(snap,tick*1000/60));assert.ok(snap.transforms.length<=560);}
 }
 assert.equal(s.phase,'results');assert.equal(s.game.score.turn,seats.length*3);assert.deepEqual(s.game.score.throws.map(t=>t.length),seats.map(()=>3));assert.equal(s.game.retries,0);
 assert.equal(ejects,seats.length*3);
 assert.equal(nudges,seats.length*2);assert.ok(s.game.score.totals.some(n=>n>0));
 assert.deepEqual(order.slice(0,seats.length),[...seats]);
 const sorted=[...times].sort((a,b)=>a-b),maxBytes=Math.max(...sizes);
 console.log(JSON.stringify({bowlingPlayers:seats.length,throws:s.game.score.throws,totals:s.game.score.totals,winner:s.winner,stepAvgMs:times.reduce((a,b)=>a+b,0)/times.length,stepP95Ms:sorted[Math.floor(sorted.length*.95)],stepP99Ms:sorted[Math.floor(sorted.length*.99)],maxSnapshotBytes:maxBytes,maxDownstreamKBs:maxBytes*20/1024,inputBytes:29,inputHz:60,snapshotHz:20,retries:s.game.retries}));
 assert.ok(maxBytes<1600);s.dispose();
});
test('inactive/stale-turn input never moves active car; idle players and held stationary charge cannot stall match',()=>{
 const s=new BowlingRoundSimulation();s.start([0,2]);for(let i=0;i<127;i++)s.step([]);
 const z=s.game.car.body.translation().z;
 for(let i=0;i<30;i++)s.step(inputs(2,packet(i)));assert.ok(Math.abs(s.game.car.body.translation().z-z)<.1);
 for(let i=0;i<30;i++)s.step(inputs(0,{...packet(i),turn:1}));assert.ok(Math.abs(s.game.car.body.translation().z-z)<.1);
 for(let i=0;i<14000&&s.phase!=='results';i++)s.step([]);assert.equal(s.phase,'results');assert.deepEqual(s.game.score.totals,[0,0]);s.dispose();
 const charged=new BowlingRoundSimulation();charged.start([0,1]);for(let i=0;i<127;i++)charged.step([]);
 charged.game.car.body.setTranslation({x:0,y:.64,z:23},true);
 for(let i=0;i<4000&&charged.game.score.turn===0;i++)charged.step(inputs(0,{...packet(i),throttle:0,brake:1,space:true}));assert.equal(charged.game.score.turn,1);charged.dispose();
});
for(const [rtt,jitter] of [[100,30],[150,40]])test(`car prediction under ${rtt} ms RTT + ${jitter} ms jitter stays bounded without hard correction`,()=>{
 const sim=new BowlingRoundSimulation(undefined,7281);sim.start([0,1]);const prediction=new BowlingPrediction(0,7281,2),buffer=new SnapshotBuffer();
 const uplink:{at:number;p:BowlingInputPacket}[]=[],down:{at:number;s:GameSnapshot}[]=[];let latest=packet(),ack=-1,random=3;const delay=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return rtt/2+(random/2**32)*jitter;};
 for(let tick=0;tick<850&&sim.game.phase!=='flight';tick++){
  const now=tick*1000/60,p=drive(sim.game,tick);p.space=false;uplink.push({at:now+delay(),p});
  while(uplink[0]&&uplink[0].at<=now){latest=uplink.shift()!.p;ack=latest.seq;}
  sim.step(inputs(0,latest));if(tick%3===0)down.push({at:now+delay(),s:sim.snapshot([ack,-1,-1])});
  while(down[0]&&down[0].at<=now){const f=down.shift()!;buffer.push(f.s,now);prediction.reconcile(buffer.latest!,now);}
  prediction.step(p,now);prediction.visual(1/60);
 }
 console.log(JSON.stringify({bowlingPrediction:prediction.metrics}));assert.equal(prediction.metrics.overflows,0);assert.equal(prediction.metrics.hard,0);assert.ok(prediction.metrics.maxError<6,'ordinary latency must stay within car travel correction bounds');prediction.dispose();sim.dispose();
});

test('a spectator reconnecting after the next countdown reconstructs the reset rack',async()=>{
 const {BowlingOnlineController}=await import('../scene/bowling/online');
 const {GameStream}=await import('./gameStream');
 const server=new BowlingRoundSimulation(undefined,7281);server.start([0,1]);
 server.game.score.turn=1;server.game.resetThrow();server.game.phase='drive';server.phase='playing';
 const stream=new GameStream();stream.snapshots.push(server.snapshot([-1,-1,-1]),performance.now());
 const lobby={players:[{id:'watcher',slot:2}],selfId:'watcher',status:'connected',phase:'playing'} as unknown as import('./types').LobbySnapshot;
 const controller=new BowlingOnlineController({lobby,stream,sendInput:()=>null},7281,2),view=new BowlingGame(2,7281,true);
 view.score.turn=1;view.phase='score';view.ejected=true;view.pins[0].body.setTranslation({x:99,y:-10,z:99},false);
 controller.advance(view,1/60,{throttle:0,brake:0,steer:0,eject:false},false);
 assert.equal(view.phase,'drive');assert.equal(view.ejected,false);assert.deepEqual(view.pins[0].body.translation(),server.game.pins[0].body.translation());
 controller.dispose();view.dispose();server.dispose();
});


test('Bowling settings default off, reject state claims, and persist through every throw', async()=>{
 const {DEFAULT_BOWLING_SETTINGS,validBowlingSettings}=await import('../../../shared/party-lab/bowlingSettings');
 assert.deepEqual(DEFAULT_BOWLING_SETTINGS,{obstacles:false});
 for(const value of [null,[],{},true,{obstacles:1},{obstacles:true,score:10},Object.assign(Object.create({obstacles:true}),{score:10})])assert.equal(validBowlingSettings(value),false);
 for(const enabled of [false,true]){
  assert.ok(validBowlingSettings({obstacles:enabled}));
  const sim=new BowlingRoundSimulation(undefined,7281);sim.settings={obstacles:enabled};sim.start([0,1]);
  for(let turn=0;turn<6;turn++){
   sim.game.score.turn=turn;sim.game.resetThrow();
   assert.equal(sim.game.obstacles.filter(o=>o.active).length,enabled?3:0);
   assert.ok(sim.game.car.props.every((p,i)=>p.collider.isEnabled()===sim.game.obstacles[i].active));
   assert.equal(sim.snapshot([-1,-1,-1]).bowling!.obstacles,enabled);
  }
  sim.dispose();
 }
});

test('server-held input time is not replayed twice during TCP retransmission stalls',()=>{
 const run=(accountHeld:boolean)=>{
  const sim=new BowlingRoundSimulation(undefined,7281);sim.start([0,1]);
  const pred=new BowlingPrediction(0,7281,2),buffer=new SnapshotBuffer();
  const up:{at:number;packet:BowlingInputPacket}[]=[],down:{at:number;s:GameSnapshot}[]=[];
  let ack=-1,held=packet(),lastUp=0,lastDown=0,rng=12;
  const random=()=>((rng=(Math.imul(rng,1664525)+1013904223)>>>0)/2**32);
  for(let tick=0;tick<770;tick++){
   const now=tick*1000/60,p=packet(tick);
   lastUp=Math.max(lastUp,now+50+random()*40+(tick%139===90?180:0));up.push({at:lastUp,packet:p});
   while(up[0]?.at<=now){held=up.shift()!.packet;ack=held.seq;}
   sim.step(ack<0?[]:inputs(0,held));
   if(tick%3===0){const s=sim.snapshot([ack,-1,-1]);if(!accountHeld)s.bowling!.heldTicks=0;
    lastDown=Math.max(lastDown,now+50+random()*40+(tick%171===90?180:0));down.push({at:lastDown,s});}
   while(down[0]?.at<=now){const f=down.shift()!;buffer.push(f.s,now);}
   if(buffer.latest)pred.reconcile(buffer.latest,now);
   pred.step(p,now);pred.visual(1/60);
  }
  const metrics={...pred.metrics};pred.dispose();sim.dispose();return metrics;
 };
 const old=run(false),current=run(true);
 assert.ok(old.hard>0,'fixture reproduces the former hard snap');
 assert.equal(current.hard,0);assert.equal(current.overflows,0);
 assert.ok(current.maxError<old.maxError*.5);assert.ok(current.heldSteps>0);
});

test('Bowling prediction resets the rack only at a turn boundary',()=>{
 const sim=new BowlingRoundSimulation();sim.start([0,1]);const pred=new BowlingPrediction(0,sim.game.seed,2),buffer=new SnapshotBuffer();
 let resets=0;const reset=pred.game.resetThrow.bind(pred.game);pred.game.resetThrow=()=>{resets++;reset();};
 for(let tick=0;tick<240;tick++){
  const p=packet(tick);sim.step(inputs(0,p));
  if(tick%3===0){buffer.push(sim.snapshot([tick,-1,-1]),tick*1000/60);pred.reconcile(buffer.latest!,tick*1000/60);}
  pred.step(p,tick*1000/60);pred.visual(1/60);
 }
 assert.equal(resets,1);pred.dispose();sim.dispose();
});


test('protocol 13 snapshots accept the frozen Bowling setting and reject protocol 12',()=>{
 for(const enabled of [false,true]){
  const sim=new BowlingRoundSimulation(undefined,7281);sim.settings={obstacles:enabled};sim.start([0,1]);
  // Later preferences cannot mutate the current match, including subsequent throws.
  sim.settings.obstacles=!enabled;
  for(const turn of [0,1,5]){
   sim.game.score.turn=turn;sim.game.resetThrow();
   const snapshot=sim.snapshot([-1,-1,-1]);
   assert.equal(snapshot.v,14);assert.equal(snapshot.bowling!.obstacles,enabled);
   assert.equal(new SnapshotBuffer().push({...snapshot,v:12},0),false);
   assert.equal(new SnapshotBuffer().push(snapshot,0),true);
  }
  sim.dispose();
 }
});
