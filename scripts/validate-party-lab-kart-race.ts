/** Local-only physical validation: node --import tsx scripts/validate-party-lab-kart-race.ts
 * Optional RACE_BASELINE_DIR: pre-change backup root for matched old/new physics.
 * RACE_VALIDATION_OUT selects the external artifact folder. No browser or online writes. */
import {initializePhysics} from '../src/party-lab/scene/physics.ts';
import {RaceGame} from '../src/party-lab/scene/kartrace/game.ts';
import {RaceTrack} from '../src/party-lab/scene/kartrace/track.ts';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const baseline=process.env.RACE_BASELINE_DIR;
const OldCar=baseline?(await import(pathToFileURL(`${baseline}/src/party-lab/scene/kartrace/car.ts`).href)).RaceCar:null;
const OldTrack=baseline?(await import(pathToFileURL(`${baseline}/src/party-lab/scene/kartrace/track.ts`).href)).RaceTrack:null;
import {angle,IDLE} from '../src/party-lab/scene/kartrace/config.ts';
import {writeFileSync} from 'node:fs';
await initializePhysics();
const out:any={geometry:{old:OldTrack?new OldTrack().length:589.2140969876516,new:new RaceTrack().length,sections:new RaceTrack().sections},corners:[],handbrake:[],matches:[],collisions:[]};
const mean=(a:number[])=>a.reduce((s,x)=>s+x,0)/a.length;
const setSpeed=(c:any,p:any,v:number)=>c.body.setLinvel({x:p.tx*v/3.6,y:0,z:p.tz*v/3.6},true);
function fixture(old=false,wide=false){const g=new RaceGame(2,wide?{width:150}:{});g.phase='racing';g.bots=false;if(old){g.world.removeRigidBody(g.cars[0].body);g.cars[0]=new OldCar(g.world,g.track,0) as any;}g.cars[1].place(g.track.pose(350),0);return g;}
for(const old of (OldCar?[true,false]:[false]))for(const index of [1,3,9])for(const speed of [35,65,100])for(const offset of [-1.5,0,1.5]){
 const g=fixture(old),c=g.cars[0],section=g.track.sections[index],start=section.start-25,p=g.track.at(start);c.place(g.track.pose(start,offset),Math.atan2(p.tx,p.tz));setSpeed(c,p,speed);g.progress[0].started=true;g.progress[0].next=(Math.floor(start/(g.track.length/18))+1)%18;
 const slip:number[]=[],error:number[]=[],steer:number[]=[],speedLog:number[]=[];let grass=0,drive=IDLE,frames=0;
 for(let i=0;i<900;i++){if(i%6===0)drive=g.drivers[0].input(c,g.cars,g.track,g.time,g.progress[0]);g.step(drive);const v=c.body.linvel();slip.push(Math.abs(v.x*Math.cos(c.heading)-v.z*Math.sin(c.heading)));error.push(Math.abs(angle(c.heading-Math.atan2(c.projection.point.tx,c.projection.point.tz)))*180/Math.PI);steer.push(Math.abs(drive.steer));speedLog.push(c.speed*3.6);grass+=+c.grass;frames++;if(g.track.wrap(c.projection.s-start)>section.length+40&&i>30)break;}
 out.corners.push({tuning:old?'old':'new',name:section.name,entry:speed,offset,slipMean:mean(slip),slipMax:Math.max(...slip),headingMean:mean(error),headingExit:error.at(-1),exitError:c.projection.distance,exitSpeed:c.speed*3.6,steerMean:mean(steer),steerMax:Math.max(...steer),grass:grass/60,seconds:frames/60,invalid:g.invalid});g.dispose();
}
for(const hold of [0,.1,.4,1.5]){
 const g=fixture(false,true),c=g.cars[0],s=205,p=g.track.at(s),h=Math.atan2(p.tx,p.tz);c.place(g.track.pose(s),h);setSpeed(c,p,65);const slips:number[]=[],yaws:number[]=[],speeds:number[]=[];
 for(let i=0;i<90;i++){g.step({throttle:0,brake:0,steer:.5,handbrake:i<hold*60});const v=c.body.linvel();slips.push(Math.abs(v.x*Math.cos(c.heading)-v.z*Math.sin(c.heading)));yaws.push(Math.abs(c.body.angvel().y));speeds.push(c.speed);}
 const travel=speeds.reduce((a,b)=>a+b,0)/60,turn=Math.abs(angle(c.heading-h));out.handbrake.push({hold,yawDegrees:turn*180/Math.PI,radius:travel/turn,exitSpeed:c.speed*3.6,speedLoss:65-c.speed*3.6,slipMean:mean(slips),slipMax:Math.max(...slips),exitAlignment:angle(c.heading-Math.atan2(c.projection.point.tx,c.projection.point.tz))*180/Math.PI,maxYaw:Math.max(...yaws)});g.dispose();
}
for(const n of [2,3]as const){const g=new RaceGame(n);g.autoHuman=true;let grass=0;for(let i=0;i<9300&&g.phase!=='results';i++){g.step();grass+=+g.cars[0].grass;}out.matches.push({n,time:g.time,finishes:g.progress.map(p=>p.finish),laps:g.progress.map(p=>p.laps),grass:grass/60,stats:g.stats()});g.dispose();}
for(const timing of ['before','during','after']){const g=fixture(),[a,b]=g.cars;a.place({x:0,y:.64,z:40},0);b.place({x:-4,y:.64,z:41},.6);a.body.setLinvel({x:0,y:0,z:18},true);b.body.setLinvel({x:11,y:0,z:18},true);let impact=-1,maxYaw=0,maxSpeed=0;for(let i=0;i<120;i++){g.step({throttle:0,brake:0,steer:.25,handbrake:timing==='before'?i<15:timing==='during'?i<35:impact>=0&&i>impact&&i<impact+24});if(impact<0&&g.events.some(e=>e.kind==='impact'))impact=i;maxYaw=Math.max(maxYaw,...g.cars.map(c=>Math.abs(c.body.angvel().y)));maxSpeed=Math.max(maxSpeed,...g.cars.map(c=>c.speed));}out.collisions.push({timing,impact,maxYaw,maxSpeed,stats:g.stats()});g.dispose();}
function events(track:any){
 const runs:any[]=[];let run:any=null;
 for(let s=0;s<track.length;s+=.5){const a=track.at(s-.5),b=track.at(s+.5),curve=angle(Math.atan2(b.tx,b.tz)-Math.atan2(a.tx,a.tz)),sign=Math.abs(curve)>.018?Math.sign(curve):0;if(!sign)continue;if(run&&run.sign===sign&&s-run.end<6){run.end=s;run.angle+=curve*.5;}else{run={sign,start:s,end:s,angle:curve*.5};runs.push(run);}}
 return runs.filter(r=>Math.abs(r.angle)>20*Math.PI/180).map(r=>({...r,degrees:r.angle*180/Math.PI}));
}
out.geometry.cornerEvents={old:OldTrack?events(new OldTrack()):null,new:events(new RaceTrack())};
out.acceleration=[];
for(const old of (OldCar?[true,false]:[false])){const g=fixture(old,true),c=g.cars[0];c.place(g.track.pose(10),0);let fifty=0,hundred=0,top=0;for(let i=0;i<240;i++){g.step({...IDLE,throttle:1});const speed=c.speed*3.6;if(!fifty&&speed>=50)fifty=(i+1)/60;if(!hundred&&speed>=100)hundred=(i+1)/60;top=Math.max(top,speed);}out.acceleration.push({tuning:old?'old':'new',fifty,hundred,top});g.dispose();}
out.exposedContact=[];
for(const handbrake of [false,true]){const g=fixture(),[a,b]=g.cars,s=g.track.length*.48,p=g.track.at(s),h=Math.atan2(p.tx,p.tz);a.place(g.track.pose(s,0),h-Math.PI/2);b.place(g.track.pose(s,-4.8),h);a.body.setLinvel({x:-p.tz*28,y:0,z:p.tx*28},true);let minY=0;for(let i=0;i<180;i++){g.step({...IDLE,handbrake:i<24&&handbrake});minY=Math.min(minY,...g.cars.map(c=>c.body.translation().y));}out.exposedContact.push({handbrake,minY,stats:g.stats()});if(!handbrake)assert.ok(minY< -2);assert.ok(g.contacts>0);assert.equal(g.invalid,0);g.dispose();}
assert.ok(out.geometry.new>=550&&out.geometry.new<=620);assert.equal(out.geometry.cornerEvents.new.length,5);
for(const c of out.corners.filter((x:any)=>x.tuning==='new')){assert.equal(c.grass,0);assert.equal(c.invalid,0);}
for(const m of out.matches){assert.ok(m.finishes.every((t:any)=>t!==null));assert.ok(m.laps.every((n:number)=>n===3));assert.equal(m.stats.invalid,0);}
for(let i=1;i<out.handbrake.length;i++){assert.ok(out.handbrake[i].radius<out.handbrake[i-1].radius);assert.ok(out.handbrake[i].speedLoss>out.handbrake[i-1].speedLoss);}
const output=process.env.RACE_VALIDATION_OUT??'/private/tmp/kart-race-tuning';mkdirSync(output,{recursive:true});
writeFileSync(`${output}/measure.json`,JSON.stringify(out,null,2));
writeFileSync(`${output}/track.json`,JSON.stringify({old:OldTrack?new OldTrack().points:null,new:new RaceTrack().points},null,2));
console.log(JSON.stringify({geometry:out.geometry,handbrake:out.handbrake,matches:out.matches,collisions:out.collisions,grip:['old','new'].map(tuning=>{const cases=out.corners.filter((x:any)=>x.tuning===tuning);return {tuning,slip:mean(cases.map((x:any)=>x.slipMean)),exitError:mean(cases.map((x:any)=>x.exitError)),speed:mean(cases.map((x:any)=>x.exitSpeed)),grassCases:cases.filter((x:any)=>x.grass>0).length,heading:mean(cases.map((x:any)=>x.headingExit))};})},null,2));
