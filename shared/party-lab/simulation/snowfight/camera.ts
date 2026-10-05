import { add, mul, direction, clamp, type Vec } from './config.js';
import { castMap, inside, type Solid } from './map.js';
export const CAMERA = { distance: 5.2, shoulder: .65, pivot: 1.58, fov: 68, pitch: .16, minPitch: -.60, maxPitch: .78, sensitivity: .00225, radius: .23, anticipation: .34, restore: .28 } as const;
export interface CameraState { pivot: Vec | null; boom: number; position: Vec; forward: Vec; obstruction: boolean }
export const newCamera = (): CameraState => ({pivot:null,boom:CAMERA.distance,position:{x:0,y:3,z:5},forward:{x:0,y:0,z:-1},obstruction:false});
export function updateCamera(state: CameraState, solids: readonly Solid[], feet: Vec, yaw: number, pitch: number, crouch: boolean, dt: number) {
  pitch=clamp(pitch,CAMERA.minPitch,CAMERA.maxPitch);
  const target=add(feet,{x:0,y:crouch?1.00:CAMERA.pivot,z:0});
  if(!state.pivot)state.pivot={...target};
  const a=1-Math.exp(-dt/.045), ay=1-Math.exp(-dt/.095);
  state.pivot.x+=(target.x-state.pivot.x)*a;state.pivot.z+=(target.z-state.pivot.z)*a;state.pivot.y+=(target.y-state.pivot.y)*ay;
  // The shoulder and the entire boom are independently sphere-checked.
  const right={x:-Math.cos(yaw),y:0,z:Math.sin(yaw)};
  const shoulder=add(state.pivot,mul(right,Math.max(0,castMap(solids,state.pivot,right,CAMERA.shoulder,CAMERA.radius)-.025)));
  const forward=direction(yaw,pitch), back=mul(forward,-1);
  const safe=castMap(solids,shoulder,back,CAMERA.distance,CAMERA.radius);
  const predictive=solids.filter(s=>!inside(shoulder,s,CAMERA.radius+CAMERA.anticipation)||inside(shoulder,s,CAMERA.radius));
  const anticipate=castMap(predictive,shoulder,back,CAMERA.distance,CAMERA.radius+CAMERA.anticipation);
  const wanted=Math.max(.10,anticipate-.06), rate=wanted<state.boom?.06:CAMERA.restore;
  state.boom+=(wanted-state.boom)*(1-Math.exp(-dt/rate));
  state.boom=Math.max(0,Math.min(state.boom,Math.max(0,safe-.035)));
  state.position=add(shoulder,mul(back,state.boom));state.forward=forward;state.obstruction=safe<CAMERA.distance;
  return state;
}
