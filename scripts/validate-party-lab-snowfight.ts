/** Local-only reproducible experiments. Run: npx tsx scripts/validate-party-lab-snowfight.ts */
import { initializePhysics } from '../src/party-lab/scene/physics';
import { SnowFightGame, type FightOptions } from '../src/party-lab/scene/snowfight/game';
import { FIGHT as C, IDLE, type FightInput } from '../src/party-lab/scene/snowfight/config';
await initializePhysics();
const run=(g:SnowFightGame,s:number,i=IDLE)=>{for(let n=0;n<Math.round(s/C.step);n++)g.step(i);};
function fixture(options:FightOptions={}){const g=new SnowFightGame(2,71,options);g.bots=false;g.phase='playing';g.players.forEach((p,i)=>{p.body.setTranslation({x:i?12:0,y:.025,z:i?12:0},true);p.body.setLinvel({x:0,y:0,z:0},true);});run(g,.3);return g;}
const movement=[];
for(const [name,input] of [['walk',{...IDLE,x:1}],['sprint',{...IDLE,x:1,sprint:true}],['crouch',{...IDLE,x:1,crouch:true}],['gather',{...IDLE,x:1,gather:true}]] as [string,FightInput][]){
  const g=fixture(),p=g.players[0];p.ammo=0;let peak=0,full=0;
  for(let i=0;i<36;i++){g.step(input);const v=p.body.linvel().x;peak=Math.max(peak,v);if(!full&&v>({walk:4.39,sprint:6.59,crouch:2.19,gather:.64}[name]??0))full=(i+1)*C.step;}
  let stop=0;for(let i=0;i<120;i++){g.step({...IDLE,crouch:input.crouch});if(Math.abs(p.body.linvel().x)<.05){stop=(i+1)*C.step;break;}}
  movement.push({name,speed:peak,toFull:full,stop,colliderHeight:2*(p.collider.halfHeight()+p.collider.radius())});g.dispose();
}
const jump=fixture();let peak=0,air=0;jump.step({...IDLE,jump:true});for(let n=0;n<90;n++){jump.step();peak=Math.max(peak,jump.players[0].body.translation().y);if(!jump.players[0].grounded)air+=C.step;}movement.push({name:'jump',height:peak,airtime:air});jump.dispose();
const projectiles=[];
for(const speed of[14,18,22])for(const gravity of[6,8.5,11])for(const range of[5,10,15,20]){
  const t=range/speed,drop=.5*gravity*t*t;
  // Aim up to put the ballistic centre back at launch height, low branch.
  const reachable=gravity*range<=speed*speed;
  if(!reachable){projectiles.push({speed,gravity,range,levelFlight:t,levelDrop:drop,walkLead:4.4*t,sprintLead:6.6*t,reachable:false,hit:false});continue;}
  const angle=.5*Math.asin(gravity*range/(speed*speed));
  const g=fixture({speed,gravity});g.players[0].body.setTranslation({x:0,y:.025,z:12},true);g.players[1].body.setTranslation({x:range-10,y:.025,z:-.7},true);g.world.step();
  const origin={x:-10,y:1.0,z:-.7};g.balls.push({id:999,owner:0,p:origin,previous:{...origin},v:{x:Math.cos(angle)*speed,y:Math.sin(angle)*speed,z:0},born:g.time,age:0});
  let actual=0;while(g.balls.length&&actual<3){g.step();actual+=C.step;}
  projectiles.push({speed,gravity,range,levelFlight:t,levelDrop:drop,walkLead:4.4*t,sprintLead:6.6*t,elevationDegrees:angle*180/Math.PI,aimedFlight:actual,hit:g.players[1].hp===2,invalid:g.invalidBodies});g.dispose();
}
const pacing=[];
const variants:[string,FightOptions][]=[['baseline',{}],['hp2',{hp:2}],['hp4',{hp:4}],['75s',{duration:75}],['90s',{duration:90}],['24m',{size:24}],['30m',{size:30}],['14m/s',{speed:14}],['22m/s',{speed:22}]];
for(const [variant,options]of variants)for(const count of[2,3]as const)for(const seed of[71,193,419]){
  const g=new SnowFightGame(count,seed,options);g.autoHuman=true;let empty=0,active=0,crouch=0,gather=0,dead=0;const phys:number[]=[];
  for(let n=0;n<6000&&g.phase!=='results';n++){
    g.step();if(g.phase==='playing'){phys.push(g.physicsMs);for(const p of g.players){active++;if(p.ammo===0)empty++;if(p.crouch)crouch++;if(p.gather>0)gather++;if(p.hp===0)dead++;}}
  }
  phys.sort((a,b)=>a-b);pacing.push({variant,count,seed,phase:g.phase,scores:g.players.map(p=>p.score),stats:g.stats(),emptyShare:empty/active,crouchShare:crouch/active,gatherShare:gather/active,koShare:dead/active,physics:{avg:phys.reduce((a,b)=>a+b,0)/phys.length,p99:phys[Math.floor(phys.length*.99)],max:phys.at(-1)}});g.dispose();
}
console.log(JSON.stringify({movement,projectiles,pacing},null,2));
