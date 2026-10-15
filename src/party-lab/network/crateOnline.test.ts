import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {initializePhysics} from '../../../shared/party-lab/simulation/physics';
import {CrateRoundSimulation} from '../../../shared/party-lab/simulation/crateRound';
import {CrateRainGame} from '../../../shared/party-lab/simulation/craterain/game';
import {crateSection,crateTransforms,restoreCrates,restoreCratePlayers} from '../../../shared/party-lab/simulation/craterain/wire';
import {validateCrateInput} from '../../../shared/party-lab/network/crateInput';
import {InputMailbox,neutralIntent} from '../../../shared/party-lab/network/protocol';
import {SnapshotBuffer} from './gameStream';
import {CratePrediction} from '../scene/craterain/online';
import {FEET,IDLE} from '../../../shared/party-lab/simulation/craterain/config';
before(initializePhysics);
test('Crate input carries bounded movement only; stale stages/sequence and state claims cannot control crates or scores',()=>{
 const p={seq:0,round:1,stage:1,moveX:7,moveZ:7,jumpHeld:false,sprintHeld:true,punchHeld:false};
 assert.equal(validateCrateInput({...p,punchHeld:1}),null);const {punchHeld:_,...old}=p;assert.equal(validateCrateInput(old),null,'a packet without the punch is refused');
 assert.ok(Math.abs(Math.hypot(validateCrateInput(p)!.moveX,validateCrateInput(p)!.moveZ)-1)<1e-9);
 for(const extra of [{score:3},{crates:[]},{position:{x:4}},{winner:0}])assert.equal(validateCrateInput({...p,...extra}),null);
 assert.equal(validateCrateInput({...p,moveX:NaN}),null);
 const box=new InputMailbox();assert.ok(box.accept(p,1,0,'crate_rain'));assert.equal(box.accept(p,1,1,'crate_rain'),false);assert.ok(box.read(20).crate);assert.equal(box.read(301).crate,undefined);
 // A tap: its press and release packets reach the same server tick; the press is kept for one read.
 const tap=new InputMailbox();assert.ok(tap.accept({...p,seq:1,punchHeld:true},1,0,'crate_rain'));assert.ok(tap.accept({...p,seq:2},1,1,'crate_rain'));
 assert.equal(tap.read(2).crate?.punchHeld,true);assert.equal(tap.read(3).crate?.punchHeld,false);
});
for(const count of [2,3]as const)test(`Crate ${count}P complete authoritative match agrees with frozen local rules`,()=>{
 const s=new CrateRoundSimulation(undefined,71),g=new CrateRainGame(count,71);g.bots=false;const slots=count===2?[0,2]as const:[0,1,2]as const;s.start(slots);
 try{for(let tick=0;tick<10000&&s.phase!=='results';tick++){
  const input=Array.from({length:3},neutralIntent);s.step(input);g.step();g.step();
  assert.deepEqual(s.game.snapshot(),g.snapshot());assert.equal(s.game.invalidBodies,0);
 }
 assert.equal(s.phase,'results');assert.equal(s.game.history.length,3);assert.ok(s.game.history.every(r=>r.seconds<=20));
 }finally{s.dispose();g.dispose();}
});
test('Crate compact journal reconstructs warnings, falling and all fixed occupancy after loss or reconnect without duplicates',()=>{
 const g=new CrateRainGame(3,71),client=new CrateRainGame(3,71);g.bots=false;g.phase='playing';g.players.forEach(p=>p.body.setEnabled(false));
 try{for(let tick=0;tick<2400;tick++){
  g.step();if(tick%17!==0&&tick!==2399)continue;
  const w=crateSection(g,[0,1,2]);restoreCrates(client,w);const count=client.world.bodies.len();restoreCrates(client,w);
  assert.equal(client.world.bodies.len(),count);assert.deepEqual(client.cells.map(c=>c.layers),g.cells.map(c=>c.layers));
  assert.deepEqual(client.crates.map(c=>c.firstHit),g.crates.map(c=>c.firstHit));assert.equal(client.warnings.length,g.warnings.length);
  assert.ok(w.journal.length<=720);assert.equal(crateTransforms(g).length,84);
 }
 assert.equal(g.coverage().percent,100);assert.equal(client.coverage().percent,100);
 g.round++;g.resetRound();restoreCrates(client,crateSection(g,[0,1,2]));assert.equal(client.crates.length,0);assert.equal(client.world.bodies.len(),3);
 }finally{g.dispose();client.dispose();}
});
test('Crate sparse-seat reconnect restores authoritative eliminated body and departure cannot stall stages',()=>{
 const s=new CrateRoundSimulation();s.start([0,2]);s.remove(2);
 const client=new CrateRainGame(2,s.game.seed),buffer=new SnapshotBuffer();
 try{for(let t=0;t<1500&&s.phase!=='results';t++)s.step([]);
 const snap=s.snapshot([-1,-1,-1]);assert.ok(buffer.push(snap,0));restoreCrates(client,snap.crate!);restoreCratePlayers(client,snap.crate!,buffer.latest!.values);
 assert.equal(client.players[1].alive,false);assert.equal(client.players[1].body.isEnabled(),false);assert.equal(s.phase,'results');assert.deepEqual(s.game.wins,[3,0]);
 }finally{s.dispose();client.dispose();}
});

test('Crate punches are authoritative: the server matches local rules, the stun crosses the wire and stops predicted movement',()=>{
 const s=new CrateRoundSimulation(undefined,71),g=new CrateRainGame(2,71);g.bots=g.spawning=false;s.start([0,2]);s.game.spawning=false;
 const packet=(seq:number,punchHeld:boolean,moveX=0)=>({seq,round:s.roundId,stage:s.game.round,moveX,moveZ:0,jumpHeld:false,sprintHeld:false,punchHeld});
 const both=(seq:number,punch:boolean)=>{const intents=Array.from({length:3},neutralIntent);intents[0].crate=packet(seq,punch);intents[2].crate=packet(seq,false);s.step(intents);for(let k=0;k<2;k++)g.step(IDLE,[{...IDLE,punch},IDLE]);};
 const place=(game:CrateRainGame)=>{game.players[0].body.setTranslation({x:-3.5,y:FEET+.025,z:0},true);game.players[1].body.setTranslation({x:-2.45,y:FEET+.025,z:0},true);game.players.forEach(p=>{p.body.setLinvel({x:0,y:0,z:0},true);p.positionBefore=p.body.translation();});game.world.propagateModifiedBodyPositionsToColliders();};
 try{let seq=0;while(s.game.phase!=='playing')both(seq++,false);place(s.game);place(g);
  for(let t=0;t<30;t++){both(seq++,t<8);assert.deepEqual(s.game.snapshot(),g.snapshot());assert.equal(s.game.players[1].stun,g.players[1].stun);}
  assert.ok(s.game.players[1].stun>0,'the server stunned the punched player');
  // The client (seat 2) learns its stun from the snapshot; its own movement is held while stunned.
  const buffer=new SnapshotBuffer(),client=new CratePrediction(2,2,s.game.seed);
  try{const snap=s.snapshot([seq,-1,seq]);assert.ok(buffer.push(snap,0));client.reconcile(buffer.latest!,0);
   assert.ok(Math.abs(client.game.players[1].stun-s.game.players[1].stun)<1e-9);assert.equal(client.game.players[1].guard,0);
   const before=client.game.players[1].body.translation();for(let k=0;k<6;k++)client.step({...packet(seq+k,false,-1)},k*16);
   assert.ok(client.game.players[1].body.translation().x>=before.x-1e-3,'no walking back while stunned');
  }finally{client.dispose();}
  // After the stun: guarded on both sides, so the attacker's next punch cannot land.
  for(let t=0;t<70;t++)both(seq++,false);assert.equal(s.game.players[1].stun,0);assert.ok(s.game.players[1].guard>0);
  place(s.game);place(g);for(let t=0;t<30;t++)both(seq++,t<8);assert.equal(s.game.players[1].stun,0);assert.deepEqual(s.game.snapshot(),g.snapshot());
 }finally{s.dispose();g.dispose();}
});
