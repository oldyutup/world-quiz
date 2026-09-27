/** Fixed-course Bowling-local flight calibration. Every sample drives the real
 * course/input clock; BOWLING_TUNING is an isolated-process comparison only.
 * Usage: npx tsx scripts/validate-party-lab-bowling-flight.ts OUTPUT [500]
 * --baseline: 20 requested before-tuning approaches; --matrix: dense grid only. */
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {initializePhysics} from '../src/party-lab/scene/physics';
import {BowlingGame,IDLE_INPUT,rackEntryClass} from '../src/party-lab/scene/bowling/game';
import {BowlingClock} from '../src/party-lab/scene/bowling/clock';
import {BOWLING,FLIGHT,BULLET,botThrow,landingHalfWidth} from '../src/party-lab/scene/bowling/config';
import {courseSteering} from '../src/party-lab/scene/bowling/courseDriving';
import {PARTS,RAGDOLL} from '../src/party-lab/scene/ragdoll/config';
import {rotate,length} from '../src/party-lab/scene/ragdoll/math';
await initializePhysics();
const out=process.argv[2]??'/private/tmp/bowling-flight-170/final',count=Number(process.argv[3]??500);
mkdirSync(out,{recursive:true});
// Course geometry is fixed for this calibration.
const save=(n:string,v:unknown)=>writeFileSync(`${out}/${n}.json`,JSON.stringify(v,null,2));
if(process.env.BOWLING_TUNING)Object.assign(FLIGHT,JSON.parse(process.env.BOWLING_TUNING));
function bodyState(g:BowlingGame){
 const bodies=PARTS.map(n=>g.character.parts[n].body),mass=bodies.reduce((s,b)=>s+b.mass(),0);
 const v=bodies.reduce((s,b)=>{const v=b.linvel(),m=b.mass()/mass;return {x:s.x+v.x*m,y:s.y+v.y*m,z:s.z+v.z*m};},{x:0,y:0,z:0});
 const com=bodies.reduce((s,b)=>{const p=b.translation(),m=b.mass()/mass;return {x:s.x+p.x*m,y:s.y+p.y*m,z:s.z+p.z*m};},{x:0,y:0,z:0});
 return {com,p:{...g.character.body.translation()},v,horizontal:Math.hypot(v.x,v.z),energy:bodies.reduce((s,b)=>s+.5*b.mass()*length(b.linvel())**2,0),orientation:rotate(g.character.parts.torso.body.rotation(),{x:0,y:1,z:0})};
}
interface Options {target?:number;angle?:number;pitch?:number;steer?:number;duration?:number;nudge?:number;seed?:number;bot?:boolean;name?:string;targetX?:number;start?:number;}
function shot(o:Options={}){
 const g=new BowlingGame(2,o.seed??7281),clock=new BowlingClock();if(o.bot){g.score.turn=1;g.resetThrow();}
 const turn=g.score.turn,angle=o.angle??24,target=(o.target??145)/3.6,segments=new Set<string>();
 let armed=false,rack:ReturnType<typeof bodyState>|null=null,firstPin:any=null,nudge:any=null,afterInput:any=null,initial:any=null,wasNudged=false;
 const snapshots:Record<string,ReturnType<typeof bodyState>>={};
 let atOne:any=null,groundTime: number|null=null,invalid=0,penetrations=0,maxSeparation=0,peakPinSpeed=0,peakSupportedBodySpeed=0,catcherContacts=0;const cost:number[]=[];
 for(let i=0;i<16000&&g.score.turn===turn;i++){
  const p=g.car.body.translation(),speed=g.car.speed;
  if(g.phase==='drive'&&p.z>=BOWLING.rampLip-1-speed*angle/FLIGHT.angleRate*BULLET.scale)armed=true;
  const input=g.phase==='drive'?{...IDLE_INPUT,throttle:speed<target?1:0,brake:speed>target+.1?.55:0,steer:courseSteering(p,g.car.heading,speed,g.obstacles,g.car.stuntStates,o.targetX??0),eject:armed&&(!g.charging||g.chargeTime+1e-8<angle/FLIGHT.angleRate)}:{...IDLE_INPUT,steer:g.elapsed>=(o.start??0)&&g.elapsed<(o.start??0)+(o.duration??0)?o.steer??0:0,pitch:g.elapsed>=(o.start??0)&&g.elapsed<(o.start??0)+(o.duration??0)?o.pitch??0:0,eject:g.elapsed>=(o.nudge??Infinity)};
  let before:ReturnType<typeof bodyState>|null=null,t=0;
  clock.advance(g,1/120,input,()=>{if(g.ejected)before=bodyState(g);t=performance.now();},()=>{
   cost.push(performance.now()-t);
   if(!g.ejected)return;
   const s=bodyState(g);initial??=s;
   for(const time of [.25,.5,1,1.5,2,2.5,3])if(g.elapsed>=time&&!snapshots[time])snapshots[time]=s;
   if(!atOne&&g.elapsed>=1)atOne=s;
   if(!afterInput&&g.elapsed>=(o.duration??1))afterInput=s;
   if(!rack&&s.p.z>=BOWLING.headZ)rack=s;
   if(g.nudgeUsed&&!wasNudged)nudge={time:g.measurement?.nudgeAt,before,after:s};wasNudged=g.nudgeUsed;
   if(g.landed&&groundTime===null)groundTime=g.elapsed;
   for(const pin of g.pins){
    const pos=pin.body.translation(),v=pin.body.linvel();
    if(![...Object.values(pos),...Object.values(v)].every(Number.isFinite))invalid++;
    if(pos.y> -3)peakPinSpeed=Math.max(peakPinSpeed,length(v));
   }
   for(const name of PARTS){const part=g.character.parts[name],pos=part.body.translation();
    if(pos.y> -3)peakSupportedBodySpeed=Math.max(peakSupportedBodySpeed,length(part.body.linvel()));
    if(![...Object.values(pos),...Object.values(part.body.linvel())].every(Number.isFinite))invalid++;
    maxSeparation=Math.max(maxSeparation,Math.hypot(pos.x-s.p.x,pos.y-s.p.y,pos.z-s.p.z));
    if(Math.abs(pos.x)<landingHalfWidth(pos.z)-.2&&pos.z>BOWLING.rampLip+1&&pos.z<BOWLING.maxZ-2&&pos.y<-.15)penetrations++;
    g.world.contactPairsWith(part.collider,other=>{
     if(other.translation().z===BOWLING.maxZ-1&&other.translation().y===1)g.world.contactPair(part.collider,other,m=>{if(m.numSolverContacts()>0)catcherContacts++;});
     if((other.collisionGroups()>>>16)!==4)return;g.world.contactPair(part.collider,other,m=>{if(m.numSolverContacts()>0){segments.add(name);firstPin??={time:g.elapsed,airborne:groundTime===null,state:before,contactHeight:pos.y,segment:name};}});
    });
   }
  });
 }
 assert.equal(g.score.turn,turn+1);assert.equal(g.retries,0);assert.equal(invalid,0);
 const m=g.measurements[0]??null,groundGap=m?.impactPoint?BOWLING.headZ-m.impactPoint.z:null;
 const category=m?rackEntryClass(m):'SHORT';
 const sorted=cost.sort((a,b)=>a-b);
 const result={options:o,launchHeading:g.airHeading,snapshots,initial,atOne,afterInput,nudge,rack,firstPin,segments:[...segments],groundGap,category,measurement:m,pins:g.lastPoints,safety:{invalid,penetrations,maxSeparation,peakPinSpeed,peakSupportedBodySpeed,catcherContacts},performance:{avg:cost.reduce((a,b)=>a+b,0)/cost.length,p99:sorted[Math.floor(sorted.length*.99)],max:sorted.at(-1)}};
 g.dispose();return result;
}

const brief=(s:ReturnType<typeof shot>)=>({speed:s.options.target,angle:s.options.angle,class:s.category,pins:s.pins,air:s.measurement?.horizontalTravel,ground:s.measurement?.impactPoint?.z,rack:s.measurement?.entry.rack?.body,firstPin:s.measurement?.entry.firstPin});
if(process.argv.includes('--rear')){
 const rear=[145,150,160,165].flatMap(target=>[22,26,30].flatMap(angle=>[undefined,.3].map(nudge=>shot({target,angle,nudge}))));
 save('rear',rear);console.log(JSON.stringify(rear.map(s=>({...brief(s),safety:s.safety}))));process.exit(0);
}
if(process.argv.includes('--baseline')){
 const matrix=[135,145,155,165].flatMap(target=>[10,15,20,25,30].map(angle=>shot({target,angle})));
 save('matrix',matrix);console.log(JSON.stringify(matrix.map(brief)));process.exit(0);
}
const matrix:ReturnType<typeof shot>[]=[];for(let target=130;target<=165;target+=5)for(let angle=0;angle<=30;angle+=2)matrix.push(shot({target,angle}));save('matrix',matrix);
const columns=['target_kmh','actual_kmh','angle_deg','air_distance_m','first_ground_z','rack_height_m','rack_forward_mps','rack_vertical_mps','class','pins'];
writeFileSync(`${out}/speed-angle-map.csv`,[columns.join(','),...matrix.map(s=>{
 const m=s.measurement,r=m?.entry.rack?.body;
 return [s.options.target,m&&m.carSpeed*3.6,m?.angle,m?.horizontalTravel,m?.impactPoint?.z,r?.position.y,r?.velocity.z,r?.velocity.y,s.category,s.pins].join(',');
})].join('\n'));
writeFileSync(`${out}/speed-angle-map.md`,[
 '| km/h | '+Array.from({length:16},(_,i)=>`${i*2}°`).join(' | ')+' |',
 '| --- | '+Array(16).fill('---').join(' | ')+' |',
 ...Array.from({length:8},(_,i)=>130+i*5).map(speed=>'| '+speed+' | '+matrix.filter(s=>s.options.target===speed).map(s=>s.category+'/'+s.pins).join(' | ')+' |'),
].join('\n'));
console.log(matrix.map(s=>[s.options.target,s.options.angle,s.category,s.pins].join(' ')).join('\n'));
if(process.argv.includes('--matrix'))process.exit(0);
const robustness=[{target:140,angle:27},{target:145,angle:25},{target:150,angle:23},{target:155,angle:21},{target:160,angle:20}].flatMap(o=>[-3,-2,-1,0,1,2,3].map(d=>shot({...o,angle:o.angle+d})));save('robustness',robustness);
const nudges=[135,140,145,150,160,165].flatMap(target=>[18,22,26,30].flatMap(angle=>[undefined,.3,1.2,2.8].map(nudge=>shot({target,angle,nudge}))));save('nudges',nudges);
const controls=[{},...[1,-1].flatMap(steer=>[.25,.5,1].map(duration=>({steer,duration}))),...[1,-1].map(pitch=>({pitch,duration:.5}))].map(o=>shot({target:150,angle:24,...o}));save('controls',controls);
const bots:ReturnType<typeof shot>[]=[];for(let seed=0;bots.length<count;seed++){if(botThrow(seed,1,1).quality<.18)continue;bots.push(shot({seed,bot:true}));if(bots.length%50===0)console.log('Competent throws',bots.length);}save('bots',bots);
const summary={geometry:{lip:BOWLING.rampLip,head:BOWLING.headZ,distance:BOWLING.headZ-BOWLING.rampLip,pinHeight:BOWLING.pinHeight},physics:{gravity:RAGDOLL.gravity*FLIGHT.gravityScale,...FLIGHT},count,bins:[bots.filter(b=>b.pins===0).length,bots.filter(b=>b.pins>=1&&b.pins<=3).length,bots.filter(b=>b.pins>=4&&b.pins<=6).length,bots.filter(b=>b.pins>=7&&b.pins<=9).length,bots.filter(b=>b.pins===10).length],average:bots.reduce((s,b)=>s+b.pins,0)/Math.max(1,count),categories:Object.fromEntries(['AIRBORNE','NEAR','MEDIUM','LONG','OVERFLIGHT','SHORT','MISS'].map(c=>[c,bots.filter(b=>b.category===c).length])),safety:{invalid:bots.reduce((s,b)=>s+b.safety.invalid,0),penetrations:bots.reduce((s,b)=>s+b.safety.penetrations,0),maxSeparation:Math.max(0,...bots.map(b=>b.safety.maxSeparation))}};save('summary',summary);console.log(JSON.stringify(summary,null,2));
