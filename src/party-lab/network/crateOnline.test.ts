import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {initializePhysics} from '../../../shared/party-lab/simulation/physics';
import {CrateRoundSimulation} from '../../../shared/party-lab/simulation/crateRound';
import {CrateRainGame} from '../../../shared/party-lab/simulation/craterain/game';
import {crateSection,crateTransforms,restoreCrates,restoreCratePlayers} from '../../../shared/party-lab/simulation/craterain/wire';
import {validateCrateInput} from '../../../shared/party-lab/network/crateInput';
import {InputMailbox,neutralIntent} from '../../../shared/party-lab/network/protocol';
import {SnapshotBuffer} from './gameStream';
before(initializePhysics);
test('Crate input carries bounded movement only; stale stages/sequence and state claims cannot control crates or scores',()=>{
 const p={seq:0,round:1,stage:1,moveX:7,moveZ:7,jumpHeld:false,sprintHeld:true};
 assert.ok(Math.abs(Math.hypot(validateCrateInput(p)!.moveX,validateCrateInput(p)!.moveZ)-1)<1e-9);
 for(const extra of [{score:3},{crates:[]},{position:{x:4}},{winner:0}])assert.equal(validateCrateInput({...p,...extra}),null);
 assert.equal(validateCrateInput({...p,moveX:NaN}),null);
 const box=new InputMailbox();assert.ok(box.accept(p,1,0,'crate_rain'));assert.equal(box.accept(p,1,1,'crate_rain'),false);assert.ok(box.read(20).crate);assert.equal(box.read(301).crate,undefined);
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
