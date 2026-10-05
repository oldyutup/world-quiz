/** LOCAL only. Deterministic coverage, collision fairness, matches, and fixed-body cost.
 * npx tsx scripts/validate-party-lab-crate-rain.ts /private/tmp/crate-rain-report.json */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { initializePhysics } from '../src/party-lab/scene/physics';
import { CrateRainGame } from '../src/party-lab/scene/craterain/game';
import { CRATE_RAIN as C, FEET, IDLE, waveAt } from '../src/party-lab/scene/craterain/config';
const distribution = (a: number[]) => { const b = a.slice().sort((a,b)=>a-b); return { avg: b.reduce((a,b)=>a+b,0)/b.length, p99: b[Math.floor(b.length*.99)], max: b.at(-1) }; };
await initializePhysics();
const coverage = [], dimensions = [], fairness = [], performanceRows = [], matches = [], resets = [];
for (const size of [12.6,14,15.4]) for (const seed of [17,71,193]) {
  const cells = Math.round(size / 1.4) ** 2, g = new CrateRainGame(3,seed,size,cells+6); g.phase='playing'; g.bots=false; g.players.forEach(p=>p.body.setEnabled(false));
  const samples=[g.coverage()], warnings: {time:number; duration:number; cell:number}[]=[]; let seen=0, peakWarnings=0, minSeparation=Infinity;
  for(let tick=1;tick<=2400;tick++){
    g.step();
    for(const w of g.warnings) if(w.id>=seen){warnings.push({time:w.since,duration:w.impactAt-w.since,cell:w.cell});seen=w.id+1;}
    peakWarnings=Math.max(peakWarnings,g.warnings.length);
    g.warnings.forEach((w,i)=>g.warnings.slice(i+1).forEach(v=>{minSeparation=Math.min(minSeparation,Math.hypot(w.x-v.x,w.z-v.z));}));
    if([600,1200,1800,2160,2400].includes(tick))samples.push(g.coverage());
  }
  const row={size,seed,samples,warnings,peakWarnings,minSeparation,stats:g.stats()};dimensions.push(row);if(size===14)coverage.push(row);
  assert.equal(g.coverage().percent,100);assert.equal(g.stats().kinematic,0);assert.equal(g.invalidBodies,0);assert.ok(g.elapsed<=20);g.dispose();
}
for(const duration of [.95,.8,.65])for(const reaction of [.15,.25,.35,.45])for(const direction of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1]]){
  const g=new CrateRainGame(2);g.phase='playing';g.bots=g.spawning=false;
  g.players[0].body.setTranslation({x:.7,y:FEET+.025,z:.7},true);g.players[1].body.setTranslation({x:-5.6,y:FEET+.025,z:-5.6},true);
  for(let i=0;i<30;i++)g.step();const start=g.elapsed;g.warn('cedar',.7,.7,duration);
  let escape=-1;for(let i=0;i<150&&g.phase==='playing';i++){
    g.step(g.elapsed-start<reaction?IDLE:{...IDLE,x:direction[0],z:direction[1],sprint:true});const at=g.players[0].body.translation();
    if(escape<0&&Math.max(Math.abs(at.x-.7),Math.abs(at.z-.7))>1.02)escape=g.elapsed-start;
  }
  const row={duration,reaction,direction,alive:g.players[0].alive,escapeAt:escape,hitAt:g.impacts[0]?(g.impacts[0].tick-30)*C.step:null};fairness.push(row);
  if(reaction<=.25)assert.ok(row.alive,JSON.stringify(row));g.dispose();
}
for(const count of [20,40,60,80,100]){
  const g=new CrateRainGame(3);g.phase='playing';g.bots=g.spawning=false;
  for(let i=0;i<count;i++){const c=g.cells[i];g.addCrate('cedar',c.x,.7,c.z);}
  g.players.forEach((p,i)=>{const c=g.cells[10+i*30];p.body.setTranslation({x:c.x,y:g.surface(c.x,c.z).y+FEET+.03,z:c.z},true);});
  const js=[],physics=[];for(let i=0;i<1440;i++){const start=globalThis.performance.now();g.step();if(i>120){js.push(globalThis.performance.now()-start);physics.push(g.physicsMs);}}
  performanceRows.push({count,js:distribution(js),physics:distribution(physics),stats:g.stats()});assert.equal(g.stats().fixed,count);assert.equal(g.stats().kinematic,0);assert.equal(g.invalidBodies,0);g.dispose();
}
for(const count of [2,3] as const)for(const seed of [17,71,193,281,997]){
  const g=new CrateRainGame(count,seed);let heading=0;
  for(let tick=0;tick<11000&&g.phase!=='results';tick++){
    const p=g.players[0],at=p.body.translation();if(tick%90===0)heading+=1.4;
    const danger=g.warnings.some(w=>g.elapsed-w.since>.25&&Math.hypot(w.x-at.x,w.z-at.z)<1.8);
    g.step({x:Math.abs(at.x)>5.6?-Math.sign(at.x):Math.sin(heading),z:Math.abs(at.z)>5.6?-Math.sign(at.z):Math.cos(heading),sprint:true,jump:p.grounded&&(danger||tick%130<8)});
  }
  matches.push({count,seed,phase:g.phase,rounds:g.history,stats:g.stats()});assert.equal(g.phase,'results');assert.equal(g.history.length,3);assert.ok(g.history.every(r=>r.seconds<=20));assert.equal(g.invalidBodies,0);g.dispose();
}
const g=new CrateRainGame(3);for(let i=0;i<25;i++){g.phase='playing';g.bots=g.spawning=false;for(const c of g.cells.slice(0,80))g.addCrate('cedar',c.x,i%2?.7:9.7,c.z);for(let tick=0;tick<20;tick++)g.step();g.resetRound();resets.push({bodies:g.world.bodies.len(),colliders:g.world.colliders.len(),crates:g.crates.length,warnings:g.warnings.length});}g.dispose();assert.ok(resets.every(r=>r.bodies===3&&r.colliders===8&&!r.crates&&!r.warnings));
const report={arena:C.arenaSize,crateSize:1.4,duration:C.maxRoundTime,coverage,dimensions,fairness,performance:performanceRows,matches,resets,warningCurve:[0,5,10,15,18,20].map(t=>({time:t,...waveAt(t)}))};
const output=process.argv[2]??'/private/tmp/crate-rain-20s-report.json';mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({output,coverage:coverage[0].samples,fairness:fairness.filter(f=>f.alive).length+'/'+fairness.length,performance:performanceRows,matches:matches.map(m=>({count:m.count,seed:m.seed,rounds:m.rounds})),reset:resets.at(-1)},null,2));
