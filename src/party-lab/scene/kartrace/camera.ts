import RAPIER from '@dimforge/rapier3d-compat';
import { angle, GROUP, groups, type Vec } from './config';
export const VIEWS=[
  {label:'YAKIN',distance:6,height:2.2,ahead:5,fov:58},
  {label:'YAKIN-ORTA',distance:8,height:3.1,ahead:7,fov:58},
  {label:'ORTA',distance:10,height:4.2,ahead:8,fov:60},
  {label:'UZAK',distance:13,height:5.6,ahead:9,fov:62},
] as const;
export const cameraSession={preset:1};
export const newCamera=()=>({ready:false,heading:0,position:{x:0,y:0,z:0},target:{x:0,y:0,z:0},fov:58,boom:8});
export function updateCamera(state:ReturnType<typeof newCamera>,world:RAPIER.World,p:Vec,heading:number,speed:number,dt:number,preset=cameraSession.preset){
  const view=VIEWS[preset],snap=!state.ready||Math.hypot(p.x-state.target.x,p.z-state.target.z)>35;
  if(snap)state.heading=heading;else state.heading+=angle(heading-state.heading)*(1-Math.exp(-11*dt));
  const sin=Math.sin(state.heading),cos=Math.cos(state.heading),origin={x:p.x,y:Math.max(.9,p.y+.75),z:p.z};
  const wanted={x:p.x-sin*view.distance,y:Math.max(1.25,p.y+view.height),z:p.z-cos*view.distance};
  const dx=wanted.x-origin.x,dy=wanted.y-origin.y,dz=wanted.z-origin.z,len=Math.hypot(dx,dy,dz),dir={x:dx/len,y:dy/len,z:dz/len};
  let boom=len;
  for(const offset of [-.28,0,.28]){
    const o={x:origin.x+cos*offset,y:origin.y,z:origin.z-sin*offset};
    const hit=world.castRay(new RAPIER.Ray(o,dir),len,true,undefined,groups(GROUP.car,GROUP.wall));
    if(hit)boom=Math.min(boom,Math.max(.8,hit.timeOfImpact-.4));
  }
  state.boom=boom<state.boom||snap?boom:state.boom+(boom-state.boom)*(1-Math.exp(-5*dt));
  // Track the car without a trailing position spring: yaw smoothing provides comfort
  // without making a corner/collision move the vehicle off the bottom of the screen.
  state.position={x:origin.x+dir.x*state.boom,y:origin.y+dir.y*state.boom,z:origin.z+dir.z*state.boom};
  state.target={x:p.x+sin*(view.ahead+speed*.12),y:p.y+.5,z:p.z+cos*(view.ahead+speed*.12)};
  state.fov+=(view.fov+7*Math.min(1,speed/36.1)-state.fov)*(snap?1:1-Math.exp(-4*dt));state.ready=true;return state;
}
