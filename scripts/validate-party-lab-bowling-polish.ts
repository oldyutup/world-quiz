/** Reproducible physical fixtures and competent full-course throws. No scoring assistance. */
import {writeFileSync,mkdirSync} from 'node:fs';
import {initializePhysics} from '../shared/party-lab/simulation/physics';
import {BowlingGame,IDLE_INPUT,bowlingBodyState,updatePin} from '../shared/party-lab/simulation/bowling/game';
import {BowlingClock} from '../shared/party-lab/simulation/bowling/clock';
import {BOWLING,COURSE,botThrow} from '../shared/party-lab/simulation/bowling/config';
import {courseSteering} from '../shared/party-lab/simulation/bowling/courseDriving';
import {PARTS} from '../shared/party-lab/simulation/ragdoll/config';
import {rotate,length} from '../shared/party-lab/simulation/ragdoll/math';
await initializePhysics();
const out=process.argv[2]??'/private/tmp/bowling-polish-20261004',count=Number(process.argv[3]??0);
mkdirSync(out,{recursive:true});
const configs=[
 {name:'baseline',mass:13.5,friction:.38,restitution:.12,angular:.22,spacing:.84},
 {name:'mass10',mass:10,friction:.38,restitution:.12,angular:.22,spacing:.84},
 {name:'mass8',mass:8,friction:.38,restitution:.12,angular:.22,spacing:.84},
 {name:'mass6',mass:6,friction:.38,restitution:.12,angular:.22,spacing:.84},
 {name:'mass8-transfer',mass:8,friction:.30,restitution:.18,angular:.14,spacing:.84},
 {name:'mass8-compact',mass:8,friction:.38,restitution:.12,angular:.22,spacing:.78},
 {name:'mass6-compact',mass:6,friction:.38,restitution:.12,angular:.22,spacing:.78},
 {name:'mass8-compact-transfer',mass:8,friction:.30,restitution:.18,angular:.14,spacing:.78},
 {name:'mass8-close',mass:8,friction:.38,restitution:.12,angular:.22,spacing:.74},
 {name:'mass6-close',mass:6,friction:.38,restitution:.12,angular:.22,spacing:.74},
 {name:'mass8-compact-stable',mass:8,friction:.38,restitution:.12,angular:.22,spacing:.78,solver:4},
 {name:'mass6-close-stable',mass:6,friction:.38,restitution:.12,angular:.22,spacing:.74,solver:4},
 {name:'mass6-lowdamp',mass:6,friction:.38,restitution:.12,angular:.08,spacing:.74,solver:4},
 {name:'mass6-transfer',mass:6,friction:.3,restitution:.22,angular:.08,spacing:.74,solver:4},
 {name:'mass8-lowdamp',mass:8,friction:.38,restitution:.12,angular:.08,spacing:.74,solver:4},
 {name:'mass6-wide-lowdamp',mass:6,friction:.38,restitution:.12,angular:.08,spacing:.78,solver:4},
 {name:'mass6-balanced',mass:6,friction:.38,restitution:.12,angular:.12,spacing:.74,solver:4},
 {name:'mass6-balanced-defaultsolver',mass:6,friction:.38,restitution:.12,angular:.12,spacing:.74},
 {name:'mass6-spacing72',mass:6,friction:.38,restitution:.12,angular:.12,spacing:.72},
 {name:'mass6-angular10',mass:6,friction:.38,restitution:.12,angular:.10,spacing:.74},
 {name:'mass6-bounce18',mass:6,friction:.38,restitution:.18,angular:.12,spacing:.74},
 {name:'mass6-tight-originaldamp',mass:6,friction:.38,restitution:.12,angular:.22,spacing:.72},
 {name:'mass6-spacing70',mass:6,friction:.38,restitution:.12,angular:.22,spacing:.70},
 {name:'mass6-spacing68',mass:6,friction:.38,restitution:.12,angular:.22,spacing:.68},
 {name:'mass5-spacing74',mass:5,friction:.38,restitution:.12,angular:.22,spacing:.74},
 {name:'mass5-spacing72',mass:5,friction:.38,restitution:.12,angular:.22,spacing:.72},
 {name:'mass55-spacing72',mass:5.5,friction:.38,restitution:.12,angular:.22,spacing:.72},
 {name:'mass5-spacing70',mass:5,friction:.38,restitution:.12,angular:.22,spacing:.70},
];
function tune(g:BowlingGame,c:typeof configs[number]){g.pins.forEach((p,i)=>{p.body.setAngularDamping(c.angular);p.body.setAdditionalSolverIterations(c.solver??0);for(let n=0;n<p.body.numColliders();n++){const col=p.body.collider(n);col.setMass(c.mass*[.3,.5,.2][n]);col.setFriction(c.friction);col.setRestitution(c.restitution);}p.body.recomputeMassPropertiesFromColliders();const pos=p.body.translation();p.body.setTranslation({x:pos.x*c.spacing/COURSE.basePinSpacing,y:pos.y,z:BOWLING.headZ+(pos.z-BOWLING.headZ)*c.spacing/COURSE.basePinSpacing},true);});}
const fixtures=[
 {name:'weak-glancing',x:2.8,y:.7,v:14,heading:.12},
 {name:'medium-offcenter',x:1.6,y:1.5,v:27,heading:0},
 {name:'strong-ground',x:0,y:1.05,v:42,heading:0},
 {name:'strong-airborne',x:0,y:2.8,v:42,heading:0},
 {name:'upper-airborne',x:0,y:5.5,v:42,heading:0},
 {name:'excellent-pocket',x:.7,y:2.8,v:46,heading:0},
 {name:'high-energy-misaligned',x:5.8,y:2,v:48,heading:.18},
];
function floorDepth(g:BowlingGame){let min=0;for(const p of g.pins){for(let j=0;j<p.body.numColliders();j++){const c=p.body.collider(j),q=c.rotation(),t=c.translation(),shape=c.shape as any; if(Math.abs(t.x)>COURSE.deck.maxX||t.z<COURSE.deck.minZ||t.z>BOWLING.maxZ-2)continue;
 if(shape.vertices){const v=shape.vertices;for(let k=0;k<v.length;k+=3)min=Math.min(min,t.y+rotate(q,{x:v[k],y:v[k+1],z:v[k+2]}).y);}
 else {const up=rotate(q,{x:0,y:1,z:0});min=Math.min(min,t.y-Math.abs(up.y)*shape.halfHeight-shape.radius*Math.sqrt(Math.max(0,1-up.y**2)));}
 }}return -min;}
function controlled(c:typeof configs[number],f:typeof fixtures[number]){
 const g=new BowlingGame(2,7281,true);if(!process.argv.includes('--current'))tune(g,c);for(let i=0;i<120;i++)g.world.step();
 const audit={mass:g.pins[0].body.mass(),com:g.pins[0].body.localCom(),inertia:g.pins[0].body.principalInertia()};
 g.phase='drive';g.launchCommitted=true;g.angle=0;g.car.heading=f.heading;g.car.body.setTranslation({x:f.x,y:f.y-1.05,z:BOWLING.headZ-5},true);g.car.body.setLinvel({x:Math.sin(f.heading)*f.v,y:0,z:Math.cos(f.heading)*f.v},true);g.eject();
 const pinOf=new Map<number,number>();g.pins.forEach((p,i)=>{for(let j=0;j<p.body.numColliders();j++)pinOf.set(p.body.collider(j).handle,i);});
 let first:any=null,lastSecondary=0,peakAngular=0,maxPenetration=0,persistentPenetration=0,invalid=0;const initial=new Set<number>(),secondary=new Set<string>(),times:number[]=[],knockTimes:number[]=[],seenDown=new Set<number>();
 for(let step=0;step<1800&&g.score.turn===0;step++){
  const before=bowlingBodyState(g.character),t=performance.now();g.step(IDLE_INPUT);times.push(performance.now()-t);
  for(const n of PARTS)g.world.contactPairsWith(g.character.parts[n].collider,other=>{const i=pinOf.get(other.handle);if(i===undefined)return;g.world.contactPair(g.character.parts[n].collider,other,m=>{if(!m.numSolverContacts())return;first??={time:g.elapsed,velocity:before.velocity,speed:length(before.velocity),energy:before.kineticEnergy};if(g.elapsed-first.time<.1)initial.add(i);});});
  g.pins.forEach((p,i)=>{peakAngular=Math.max(peakAngular,length(p.body.angvel()));if(!Number.isFinite(p.body.translation().y))invalid++;if(p.down&&!seenDown.has(i)){seenDown.add(i);knockTimes.push(g.elapsed);}for(let j=0;j<p.body.numColliders();j++)g.world.contactPairsWith(p.body.collider(j),other=>{const k=pinOf.get(other.handle);if(k===undefined||k===i)return;g.world.contactPair(p.body.collider(j),other,m=>{if(m.numSolverContacts()&&Math.max(length(p.body.linvel()),length(g.pins[k].body.linvel()))>.15){secondary.add([Math.min(i,k),Math.max(i,k)].join('-'));lastSecondary=g.elapsed;}});});});
  const depth=floorDepth(g);maxPenetration=Math.max(maxPenetration,depth);if(g.elapsed>10)persistentPenetration=Math.max(persistentPenetration,depth);
 }
 const extra=[];for(let i=0;i<180;i++){g.world.step();g.pins.forEach(p=>updatePin(p,BOWLING.step));extra.push(floorDepth(g));}
 const r={fixture:f.name,config:c.name,audit,first,initial:[...initial],secondary:[...secondary],pins:g.lastPoints,laterPins:g.knocked,peakAngular,chainDuration:first?Math.max(0,lastSecondary-first.time):0,lastKnock:knockTimes.at(-1),maxPenetration,persistentPenetration,restPenetration:Math.max(...extra.slice(-60)),invalid,retries:g.retries,step:stats(times)};g.dispose();return r;
}
function stats(a:number[]){a=[...a].sort((a,b)=>a-b);return {avg:a.reduce((x,y)=>x+y,0)/a.length,p95:a[Math.floor(a.length*.95)],p99:a[Math.floor(a.length*.99)],max:a.at(-1)};}
const candidates=process.argv.includes('--candidate')?configs.filter(c=>c.name===process.argv[process.argv.indexOf('--candidate')+1]):configs;
const controlledResults=candidates.flatMap(c=>fixtures.map(f=>controlled(c,f)));writeFileSync(`${out}/controlled.json`,JSON.stringify(controlledResults,null,2));
console.log(controlledResults.map(r=>[r.config,r.fixture,r.pins,r.secondary.length,Math.round(r.maxPenetration*1000)]));
if(count){
 const rows=[];let random=739;
 const next=()=>((random=(Math.imul(random,1664525)+1013904223)>>>0)/2**32);
 for(let seed=1;rows.length<count;seed++){
  const profile=botThrow(seed,1,1);if(profile.quality<.18)continue;
  const recipes=process.argv.includes('--recipes'),candidate=candidates.length===1?candidates[0]:null;
  const g=new BowlingGame(2,seed,recipes),clock=new BowlingClock();g.score.turn=1;g.resetThrow();
  // Clean-course fixture, the same disabled sensors/active flags as the setting.
  if(recipes){g.obstacles.forEach(o=>o.active=false);g.car.reset();}
  if(candidate&&!process.argv.includes('--current'))tune(g,candidate);
  const speed=41+next()*5,targetX=(next()-.5)*3.6,nudge=next()<.25?.6+next():Infinity;
  const angle=17.5+(46-speed)*.9+(next()-.5)*6-(Number.isFinite(nudge)?3:0);
  let peakPinSpeed=0,maxDepth=0;
  for(let i=0;i<9000&&g.score.turn===1;i++){
   if(!recipes){clock.advance(g,1/60);continue;}
   const p=g.car.body.translation(),chargeStart=28-g.car.speed*angle/(30/.9)*.4;
   const input=g.phase==='drive'?{throttle:g.car.speed<speed?1:0,brake:g.car.speed>speed+.15?.4:0,steer:courseSteering(p,g.car.heading,g.car.speed,g.obstacles,g.car.stuntStates,targetX),pitch:0,eject:p.z>=chargeStart&&(!g.charging||g.chargeTime<angle/(30/.9))}:{...IDLE_INPUT,eject:g.elapsed>=nudge};
   clock.advance(g,1/60,input);
   if(g.ejected){for(const pin of g.pins)peakPinSpeed=Math.max(peakPinSpeed,length(pin.body.linvel()));if(i%3===0)maxDepth=Math.max(maxDepth,floorDepth(g));}
  }
  const points=g.lastPoints;for(let i=0;i<120;i++){g.world.step();g.pins.forEach(p=>updatePin(p,BOWLING.step));}
  rows.push({seed,skill:profile.skill,recipe:recipes?{speed,targetX,angle,nudge}:null,points,laterPoints:g.knocked,retries:g.retries,peakPinSpeed,maxDepth,restDepth:floorDepth(g),m:g.measurements[0]??null});g.dispose();if(rows.length%50===0)console.log('Throws',rows.length);
 }
 const summarize=(r:typeof rows)=>({count:r.length,bins:[r.filter(x=>x.points===0).length,r.filter(x=>x.points>=1&&x.points<=3).length,r.filter(x=>x.points>=4&&x.points<=6).length,r.filter(x=>x.points>=7&&x.points<=9).length,r.filter(x=>x.points===10).length],average:r.reduce((s,x)=>s+x.points,0)/r.length,anyPinHit:r.filter(x=>x.m?.entry.firstPin).length,late:r.filter(x=>x.points!==x.laterPoints).length,retries:r.reduce((s,x)=>s+x.retries,0),maxDepth:Math.max(...r.map(x=>x.maxDepth)),maxRestDepth:Math.max(...r.map(x=>x.restDepth)),peakPinSpeed:Math.max(...r.map(x=>x.peakPinSpeed))});
 writeFileSync(`${out}/throws.json`,JSON.stringify(rows,null,2));const summary={all:summarize(rows),air:summarize(rows.filter(x=>x.m?.entry.firstPin?.airborne)),ground:summarize(rows.filter(x=>x.m?.entry.firstPin&&!x.m.entry.firstPin.airborne))};writeFileSync(`${out}/throw-summary.json`,JSON.stringify(summary,null,2));console.log(summary);
}
