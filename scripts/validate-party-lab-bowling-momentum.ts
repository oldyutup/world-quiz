/** Bowling-local physical survey. All samples drive the course with the real input clock.
 * Optional rack offset is applied BEFORE importing config in an isolated process. */
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {initializePhysics} from '../src/party-lab/scene/physics';
import {BowlingGame,IDLE_INPUT,rackEntryClass} from '../src/party-lab/scene/bowling/game';
import {BowlingClock} from '../src/party-lab/scene/bowling/clock';
import {BOWLING,COURSE,FLIGHT,BULLET,botThrow,landingHalfWidth} from '../src/party-lab/scene/bowling/config';
import {courseSteering} from '../src/party-lab/scene/bowling/courseDriving';
import {PARTS,RAGDOLL} from '../src/party-lab/scene/ragdoll/config';
import {rotate,length} from '../src/party-lab/scene/ragdoll/math';
await initializePhysics();
const out=process.argv[2]??'/private/tmp/bowling-momentum/final',count=Number(process.argv[3]??500),audit=process.argv.includes('--audit');
mkdirSync(out,{recursive:true});
// Explicit geometry experiment, never a physics adjustment. Restore on process exit.
if(process.argv.includes('--rack-offset'))COURSE.headZ+=Number(process.argv[process.argv.indexOf('--rack-offset')+1]);
const save=(n:string,v:unknown)=>writeFileSync(`${out}/${n}.json`,JSON.stringify(v,null,2));
type Vec={x:number;y:number;z:number};
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
 let atOne:any=null,groundTime: number|null=null,invalid=0,penetrations=0,maxSeparation=0;const cost:number[]=[];
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
   for(const name of PARTS){const part=g.character.parts[name],pos=part.body.translation();
    if(![...Object.values(pos),...Object.values(part.body.linvel())].every(Number.isFinite))invalid++;
    maxSeparation=Math.max(maxSeparation,Math.hypot(pos.x-s.p.x,pos.y-s.p.y,pos.z-s.p.z));
    if(Math.abs(pos.x)<landingHalfWidth(pos.z)-.2&&pos.z>BOWLING.rampLip+1&&pos.z<BOWLING.maxZ-2&&pos.y<-.15)penetrations++;
    g.world.contactPairsWith(part.collider,other=>{if((other.collisionGroups()>>>16)!==4)return;g.world.contactPair(part.collider,other,m=>{if(m.numSolverContacts()>0){segments.add(name);firstPin??={time:g.elapsed,airborne:groundTime===null,state:before,contactHeight:pos.y,segment:name};}});});
   }
  });
 }
 assert.equal(g.score.turn,turn+1);assert.equal(g.retries,0);assert.equal(invalid,0);
 const m=g.measurements[0]??null,groundGap=m?.impactPoint?BOWLING.headZ-m.impactPoint.z:null;
 const category=m?rackEntryClass(m):'SHORT';
 const sorted=cost.sort((a,b)=>a-b);
 const result={options:o,launchHeading:g.airHeading,snapshots,initial,atOne,afterInput,nudge,rack,firstPin,segments:[...segments],groundGap,category,measurement:m,pins:g.lastPoints,safety:{invalid,penetrations,maxSeparation},performance:{avg:cost.reduce((a,b)=>a+b,0)/cost.length,p99:sorted[Math.floor(sorted.length*.99)],max:sorted.at(-1)}};
 g.dispose();return result;
}
if(process.argv.includes('--polish')){
 const controls=[{name:'none'},...[.25,.5,1,10].flatMap(duration=>[{name:`A ${duration}`,steer:1,duration},{name:`D ${duration}`,steer:-1,duration}]),{name:'W',pitch:1,duration:1},{name:'S',pitch:-1,duration:1}].map(o=>shot({angle:25,...o}));
 const angles=[130,145,160].flatMap(target=>[15,20,25,30].flatMap(angle=>[0,1,-1].map(steer=>shot({target,angle,steer,duration:.5}))));
 for(let i=0;i<angles.length;i+=3){
  const [neutral,left,right]=angles.slice(i,i+3),base=neutral.snapshots[1].com;
  assert.ok(left.snapshots[1].com.x>base.x+.2,'A must move left in chase view');
  assert.ok(right.snapshots[1].com.x<base.x-.2,'D must move right in chase view');
 }
 save('polish',{physics:FLIGHT,controls,angles});console.log(JSON.stringify(controls.map(s=>({name:s.options.name,atOne:s.atOne,air:s.measurement?.horizontalTravel,rack:s.measurement?.entry.rack,pins:s.pins,category:s.category})),null,2));process.exit(0);
}
if(process.argv.includes('--impact')){
 const recipes=[];
 for(const target of [140,145,150,155,160])for(const angle of [20,22,24,26,28,30])for(const targetX of [-1,0,1])recipes.push(shot({target,angle,targetX}));
 save('impact-recipes',recipes);console.log(JSON.stringify(recipes.filter(s=>s.category==='AIRBORNE').map(s=>({options:s.options,pins:s.pins,entry:s.measurement?.entry})),null,2));process.exit(0);
}
const controls=[{name:'none'},{name:'W tap',pitch:1,duration:.25},{name:'S tap',pitch:-1,duration:.25},{name:'A tap',steer:1,duration:.25},{name:'D tap',steer:-1,duration:.25},{name:'W moderate',pitch:1,duration:.9},{name:'A moderate',steer:1,duration:.9},{name:'D moderate',steer:-1,duration:.9},{name:'heavy W+A',pitch:1,steer:1,duration:10}].map(o=>shot(o));save('controls',controls);
const nudges=[undefined,0,.5,1.2,1.8,2.8].map(nudge=>shot({nudge}));save('nudges',nudges);
if(audit){console.log(JSON.stringify(controls.map(s=>({input:s.options.name,initial:s.initial?.v,after:s.afterInput?.v,air:s.measurement?.horizontalTravel,drag:s.measurement?.dragLoss,category:s.category,pins:s.pins})),null,2));process.exit(0);}
const matrix=[];for(let speed=130;speed<=160;speed+=5)for(let angle=FLIGHT.angleMin;angle<=FLIGHT.angleMax;angle+=2)matrix.push(shot({target:speed,angle}));save('matrix',matrix);
const fields=['target_kmh','actual_kmh','angle','first_ground_z','ground_gap','rack_height','rack_forward_mps','rack_vertical_mps','class','pins'];
const csv=matrix.map(r=>{const m=r.measurement,e=m?.entry.rack;return [r.options.target,m&&m.carSpeed*3.6,m?.angle,m?.impactPoint?.z,r.groundGap,e?.body.position.y,e?.body.velocity.z,e?.body.velocity.y,r.category,r.pins].join(',');});
writeFileSync(`${out}/speed-angle-map.csv`,[fields.join(','),...csv].join('\n'));
const angles=[...new Set(matrix.map(r=>r.options.angle))],speeds=[...new Set(matrix.map(r=>r.options.target))];
writeFileSync(`${out}/speed-angle-map.md`,[
 `Rack ${BOWLING.headZ-BOWLING.rampLip} m; cell = diagnostic entry class / physical pins. No angle scoring rules.`,
 `| km/h | ${angles.map(a=>a+'°').join(' | ')} |`, `| --- | ${angles.map(()=>'---').join(' | ')} |`,
 ...speeds.map(speed=>`| ${speed} | ${matrix.filter(r=>r.options.target===speed).map(r=>r.category+'/'+r.pins).join(' | ')} |`)
].join('\n'));
const robustness=[{target:135,angle:28},{target:145,angle:25},{target:155,angle:21}].flatMap(o=>[-3,-2,-1,0,1,2,3].filter(d=>o.angle+d<=FLIGHT.angleMax).map(d=>shot({...o,angle:o.angle+d})));save('robustness',robustness);
const bots=[];for(let seed=0;bots.length<count;seed++){if(botThrow(seed,1,1).quality<.18)continue;bots.push(shot({seed,bot:true}));if(bots.length%50===0)console.log('Competent throws',bots.length);}save('bots',bots);
const summary={geometry:{lip:BOWLING.rampLip,head:BOWLING.headZ,distance:BOWLING.headZ-BOWLING.rampLip,pinHeight:BOWLING.pinHeight},physics:{gravity:RAGDOLL.gravity*FLIGHT.gravityScale,...FLIGHT},count,bins:[bots.filter(b=>b.pins===0).length,bots.filter(b=>b.pins>=1&&b.pins<=3).length,bots.filter(b=>b.pins>=4&&b.pins<=6).length,bots.filter(b=>b.pins>=7&&b.pins<=9).length,bots.filter(b=>b.pins===10).length],average:bots.reduce((s,b)=>s+b.pins,0)/Math.max(1,count),categories:Object.fromEntries(['AIRBORNE','NEAR','MEDIUM','LONG','OVERFLIGHT','SHORT','MISS'].map(c=>[c,bots.filter(b=>b.category===c).length])),safety:{invalid:bots.reduce((s,b)=>s+b.safety.invalid,0),penetrations:bots.reduce((s,b)=>s+b.safety.penetrations,0),maxSeparation:Math.max(0,...bots.map(b=>b.safety.maxSeparation))}};save('summary',summary);console.log(JSON.stringify(summary,null,2));
