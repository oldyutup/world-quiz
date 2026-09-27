/** Original local simulation experiments. No outcome filtering or assisted launches. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { initializePhysics } from '../src/party-lab/scene/physics';
import { BowlingGame, IDLE_INPUT, updatePin } from '../src/party-lab/scene/bowling/game';
import { BowlingClock } from '../src/party-lab/scene/bowling/clock';
import { courseSteering } from '../src/party-lab/scene/bowling/courseDriving';
import { BOWLING, FLIGHT, BULLET, botThrow } from '../src/party-lab/scene/bowling/config';
await initializePhysics();
const output=process.argv[2]??'/private/tmp/bowling-flatout-validation';
const count=Number(process.argv[3]??300);
mkdirSync(output,{recursive:true});
const save=(name:string,data:unknown)=>writeFileSync(join(output,name+'.json'),JSON.stringify(data,null,2));
export function runShot(angle=25,air=0,airDuration=0,nudgeAt=Infinity,direct=false,brake=false,seed=7281) {
 const g=new BowlingGame(2,seed),clock=new BowlingClock();
 let started=false;
 for(let tick=0;tick<12000&&g.score.turn===0;tick++) {
  const p=g.car.body.translation();
  const steer=direct?0:courseSteering(p,g.car.heading,g.car.speed,g.obstacles,g.car.stuntStates);
  const start=BOWLING.rampLip-1-g.car.speed*(angle-FLIGHT.angleMin)/FLIGHT.angleRate*BULLET.scale;
  if(g.phase==='drive'&&p.z>=start)started=true;
  clock.advance(g,1/120,g.phase==='drive'?{...IDLE_INPUT,throttle:brake&&p.z>6?0:1,brake:brake&&p.z>6?.5:0,steer,eject:started&&(!g.charging||g.chargeTime+1e-8<angle/FLIGHT.angleRate)}:{...IDLE_INPUT,steer:g.elapsed<airDuration?air:0,eject:g.elapsed>=nudgeAt});
 }
 assert.equal(g.score.turn,1);assert.equal(g.retries,0);// A collision-heavy approach can legitimately fail to reach the launch zone.
 const result={...g.measurements[0],pins:g.lastPoints,missedEject:g.missedEject,duration:g.durations[0]};g.dispose();return result;
}
const experiments=[
 ['low-angle',12,0,0,Infinity,false,false],['baseline',25,0,0,Infinity,false,false],['high-angle',30,0,0,Infinity,false,false],
 ['mild-aerobatics',25,.35,.6,Infinity,false,false],['aggressive-aerobatics',25,1,20,Infinity,false,false],
 ['early-nudge',25,0,0,.1,false,false],['apex-nudge',25,0,0,1.5,false,false],['late-nudge',25,0,0,2.9,false,false],
 ['obstacle-hit',25,0,0,Infinity,true,false],['low-speed',25,0,0,Infinity,false,true],
] as const;
const shots=experiments.map(([name,angle,air,duration,nudge,direct,brake])=>({name,...runShot(angle,air,duration,nudge,direct,brake)}));save('experiments',shots);
const bots=[];
for(let seed=1;bots.length<count;seed++){
 const profile=botThrow(seed,1,1);if(profile.quality<.18)continue;
 const g=new BowlingGame(2,seed),clock=new BowlingClock();g.score.turn=1;g.resetThrow();
 for(let i=0;i<9000&&g.score.turn===1;i++)clock.advance(g,1/60);
 assert.equal(g.score.turn,2);assert.equal(g.retries,0);
 const points=g.lastPoints;for(let i=0;i<120;i++){g.world.step();g.pins.forEach(p=>updatePin(p,BOWLING.step));}
 bots.push({seed,profile,points,laterPoints:g.knocked,measurement:g.measurements[0]??null,duration:g.durations[0]});g.dispose();
 if(bots.length%50===0)console.log('Measured',bots.length,'competent throws');
}
save('bots',bots);
const badBots=[];
for(let seed=1;badBots.length<60;seed++){
 const profile=botThrow(seed,1,1);if(profile.quality>=.18)continue;
 const g=new BowlingGame(2,seed),clock=new BowlingClock();g.score.turn=1;g.resetThrow();
 for(let i=0;i<9000&&g.score.turn===1;i++)clock.advance(g,1/60);
 assert.equal(g.score.turn,2);assert.equal(g.retries,0);
 badBots.push({seed,profile,points:g.lastPoints,measurement:g.measurements[0]??null});g.dispose();
}
save('bad-bots',badBots);
// Fixed recipe sweep: full throttle, the same route/target, no air correction.
// Six authored courses, five common angles, three Nudge choices. No scoring hacks.
const recipes=[];
for(const seed of [7280,7281,7282,7283,7284,7285])for(const angle of [10,15,20,25,30])for(const nudge of [Infinity,.1,1.5]){
 const shot=runShot(angle,0,0,nudge,false,false,seed);recipes.push({seed,angle,nudge:Number.isFinite(nudge)?nudge:null,...shot});
}
save('recipes',recipes);

const distribution=(rows:typeof bots)=>({count:rows.length,zero:rows.filter(b=>b.points===0).length,oneToThree:rows.filter(b=>b.points>=1&&b.points<=3).length,fourToSix:rows.filter(b=>b.points>=4&&b.points<=6).length,sevenToNine:rows.filter(b=>b.points>=7&&b.points<=9).length,strike:rows.filter(b=>b.points===10).length,average:rows.reduce((n,b)=>n+b.points,0)/rows.length});
const summary={badBots:{count:badBots.length,average:badBots.reduce((s,b)=>s+b.points,0)/badBots.length,strikes:badBots.filter(b=>b.points===10).length},recipes:{count:recipes.length,strikes:recipes.filter(b=>b.pins===10).length,best:Math.max(...recipes.map(b=>b.pins))},bots:distribution(bots),bySkill:['average','good'].map(skill=>({skill,...distribution(bots.filter(b=>b.profile.skill===skill))})),lateKnockdowns:bots.filter(b=>b.points!==b.laterPoints).length,experiments:shots.map(s=>({name:s.name,speed:s.carSpeed,angle:s.angle,z:s.releasePosition?.z,missedEject:s.missedEject,air:s.horizontalTravel,slide:s.slideDistance,pins:s.pins,drag:s.dragLoss,nudge:s.nudgeAt}))};
save('summary',summary);console.log(JSON.stringify(summary,null,2));
assert.equal(summary.lateKnockdowns,0);
