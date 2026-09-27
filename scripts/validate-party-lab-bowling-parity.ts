/** Physical-unit parity experiments. Every release uses the automatic gauge;
 * speed targets use throttle/brake, never body velocity or launch overrides. */
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {initializePhysics} from '../src/party-lab/scene/physics';
import {BowlingGame,IDLE_INPUT} from '../src/party-lab/scene/bowling/game';
import {BowlingClock} from '../src/party-lab/scene/bowling/clock';
import {BOWLING,FLIGHT,BULLET,botThrow,landingHalfWidth} from '../src/party-lab/scene/bowling/config';
import {courseSteering} from '../src/party-lab/scene/bowling/courseDriving';
import {PARTS} from '../src/party-lab/scene/ragdoll/config';
import {length,rotate} from '../src/party-lab/scene/ragdoll/math';
await initializePhysics();
const out=process.argv[2]??'/private/tmp/bowling-parity/final',count=Number(process.argv[3]??500);mkdirSync(out,{recursive:true});
const save=(name:string,data:unknown)=>writeFileSync(`${out}/${name}.json`,JSON.stringify(data,null,2));
const mean=(v:number[])=>v.reduce((a,b)=>a+b,0)/Math.max(1,v.length);
interface Shot {angle?:number;target?:number;nudge?:number;steer?:number;pitch?:number;duration?:number;seed?:number;direct?:boolean;}
function shot(o:Shot={}) {
 const g=new BowlingGame(2,o.seed??7281),clock=new BowlingClock();let armed=false,t50:number|null=null,t100:number|null=null,next=0,maxSpeed=0,peak=0,previousHits=0,firstAir=0,rotation=0,lastUp={x:0,y:1,z:0};
 const landmarks:number[]=[BOWLING.hillEnd,-140,-10,BOWLING.prepStart,22];const points:any[]=[],hits:any[]=[],samples:any[]=[],cost:number[]=[];let rack:any=null;
 const angle=o.angle??25;
 for(let i=0;i<12000&&g.score.turn===0;i++){
  const p=g.car.body.translation(),speed=g.car.speed;
  if(g.phase==='drive'){
   maxSpeed=Math.max(maxSpeed,speed);if(t50===null&&speed>=50/3.6)t50=g.driveTime;if(t100===null&&speed>=100/3.6)t100=g.driveTime;
   while(next<landmarks.length&&p.z>=landmarks[next]){points.push({z:landmarks[next++],time:g.driveTime,speed,kmh:speed*3.6,x:p.x});}
   const start=(BOWLING.rampLip-1)-speed*(angle-FLIGHT.angleMin)/FLIGHT.angleRate*BULLET.scale;if(p.z>=Math.max(BOWLING.prepStart+.4,start))armed=true;
  }
  const steering=o.direct?0:courseSteering(p,g.car.heading,speed,g.obstacles,g.car.stuntStates);
  const target=o.target===undefined?Infinity:o.target/3.6;
  const input=g.phase==='drive'?{...IDLE_INPUT,throttle:speed<target?1:0,brake:speed>target+.1?.55:0,steer:steering,eject:armed&&(!g.charging||g.chargeTime+1e-8<angle/FLIGHT.angleRate)}:{...IDLE_INPUT,steer:g.elapsed<(o.duration??0)?o.steer??0:0,pitch:g.elapsed<(o.duration??0)?o.pitch??0:0,eject:g.elapsed>=(o.nudge??Infinity)};
  const before=performance.now();clock.advance(g,1/120,input);cost.push(performance.now()-before);
  if(g.car.hitCount>previousHits){hits.push({z:p.z,before:speed,after:g.car.speed});previousHits=g.car.hitCount;}
  if(g.phase==='flight'&&g.ejected){const pelvis=g.character.body.translation(),v=g.character.body.linvel(),up=rotate(g.character.parts.torso.body.rotation(),{x:0,y:1,z:0});peak=Math.max(peak,pelvis.y);rotation+=Math.acos(Math.max(-1,Math.min(1,up.x*lastUp.x+up.y*lastUp.y+up.z*lastUp.z)));lastUp=up;
   if(rack===null&&pelvis.z>=BOWLING.headZ)rack={t:g.elapsed,p:{...pelvis},v:{...v},speed:length(v)};
   if(g.elapsed>=firstAir){samples.push({t:g.elapsed,p:{...pelvis},v:{...v},up:{...up},limb:{...g.character.parts.leftUpper.body.rotation()},drag:g.measurement?.dragLoss});firstAir+=.1;}
  }
 }
 assert.equal(g.score.turn,1);assert.equal(g.retries,0);assert.ok(PARTS.every(n=>Number.isFinite(g.character.parts[n].body.translation().y)));
 const sorted=cost.sort((a,b)=>a-b),result={options:o,t50,t100,maxSpeed,points,hits,rack,rotation,peak,measurement:g.measurements[0]??null,miss:g.missedEject,pins:g.lastPoints,samples,performance:{mean:mean(cost),p99:sorted[Math.floor(sorted.length*.99)],max:sorted.at(-1)}};g.dispose();return result;
}
const experiments={speed:[80,110,140,160].map(target=>shot({target})),angle:[10,15,20,25,30].map(angle=>shot({angle})),nudge:[undefined,.025,.7,1.65,2.8].map(nudge=>shot({target:140,nudge})),aerobatics:[{}, {steer:1,duration:.25},{steer:-1,duration:.25},{pitch:1,duration:.35},{pitch:-1,duration:.35},{steer:1,duration:10}].map(o=>shot(o)),obstacles:[shot({direct:true}),shot({})]};save('experiments',experiments);
const safety={maxPartSpeed:0,maxPartSeparation:0,invalid:0,deckPenetrations:0,carPenetrations:0};
const bots=[];for(let seed=0;bots.length<count;seed++){
 const profile=botThrow(seed,1,1);if(profile.quality<.18)continue;const g=new BowlingGame(2,seed),clock=new BowlingClock();g.score.turn=1;g.resetThrow();
 for(let i=0;i<9000&&g.score.turn===1;i++)clock.advance(g,1/60,IDLE_INPUT,undefined,()=>{
  const pelvis=g.character.body.translation(),car=g.car.body.translation();
  if(g.ejected)for(const n of PARTS){const b=g.character.parts[n].body,p=b.translation(),v=b.linvel();safety.maxPartSpeed=Math.max(safety.maxPartSpeed,length(v));safety.maxPartSeparation=Math.max(safety.maxPartSeparation,Math.hypot(p.x-pelvis.x,p.y-pelvis.y,p.z-pelvis.z));if(![p.x,p.y,p.z,v.x,v.y,v.z].every(Number.isFinite))safety.invalid++;if(Math.abs(p.x)<landingHalfWidth(p.z)-.2&&p.z>BOWLING.rampLip+1&&p.z<BOWLING.maxZ-2&&p.y<-.15)safety.deckPenetrations++;}
  if(car.z>BOWLING.hillEnd&&car.z<BOWLING.rampLip&&Math.abs(car.x)<5&&car.y<-.1)safety.carPenetrations++;
 });
 assert.equal(g.score.turn,2);assert.equal(g.retries,0);bots.push({seed,profile,pins:g.lastPoints,miss:g.missedEject,measurement:g.measurements[0]??null});g.dispose();if(bots.length%50===0)console.log('Competent throws',bots.length);
}save('bots',bots);
const recipes=[];for(let seed=0;seed<6;seed++)for(const angle of [10,15,20,25,30])for(const nudge of [undefined,1.5])recipes.push(shot({seed,angle,nudge}));save('recipes',recipes);
const measured=bots.flatMap(b=>b.measurement?[b.measurement]:[]);
const summary={safety,bots:{count:bots.length,bins:[bots.filter(b=>b.pins===0).length,bots.filter(b=>b.pins>=1&&b.pins<=3).length,bots.filter(b=>b.pins>=4&&b.pins<=6).length,bots.filter(b=>b.pins>=7&&b.pins<=9).length,bots.filter(b=>b.pins===10).length],average:mean(bots.map(b=>b.pins)),miss:bots.filter(b=>b.miss).length,speed:mean(measured.map(m=>m.carSpeed)),angle:mean(measured.map(m=>m.angle)),nudgeAt:mean(measured.flatMap(m=>m.nudgeAt===null?[]:[m.nudgeAt])),nudgeCount:measured.filter(m=>m.nudgeAt!==null).length,aerobatics:mean(measured.map(m=>m.aerobaticsSeconds)),capped:measured.filter(m=>m.airborneCapSteps>0).length},recipes:{count:recipes.length,strikes:recipes.filter(s=>s.pins===10).length,reach:recipes.filter(s=>s.rack).length,best:Math.max(...recipes.map(s=>s.pins))},experiments:Object.fromEntries(Object.entries(experiments).map(([k,rows])=>[k,rows.map(s=>({options:s.options,kmh:(s.measurement?.carSpeed??0)*3.6,air:s.measurement?.horizontalTravel,slide:s.measurement?.slideDistance,rack:s.rack,pins:s.pins,drag:s.measurement?.dragLoss,peak:s.peak,t50:s.t50,t100:s.t100}))]))};save('summary',summary);console.log(JSON.stringify(summary,null,2));
