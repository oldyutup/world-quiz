import type { BowlingPhase } from './game';
import { BOWLING, COURSE, CAR, roadHeight } from './config';
export interface BowlingPoint { x: number; y: number; z: number; }
export const BOWLING_DRIVE_PRESETS = [
  { label: 'YAKIN', distance: 6, descentDistance: 3.8, height: 1.2, descentHeight: 2.5, lookAhead: 4.5, lookHeight: .7, fov: 58, speedFov: 6 },
  { label: 'YAKIN-ORTA', distance: 7, descentDistance: 4.8, height: .8, descentHeight: 2.6, lookAhead: 5, lookHeight: .7, fov: 58, speedFov: 10 },
  { label: 'ORTA', distance: 8, descentDistance: 5.9, height: .5, descentHeight: 2.65, lookAhead: 5, lookHeight: .7, fov: 58, speedFov: 13 },
  { label: 'UZAK', distance: 9, descentDistance: 7, height: .25, descentHeight: 2.7, lookAhead: 5, lookHeight: .7, fov: 58, speedFov: 16 },
] as const;
export const DEFAULT_BOWLING_DRIVE_PRESET = 1;
// Presentation state only. Survives keyed match restarts, resets on page reload.
export const bowlingCameraSession = { preset: DEFAULT_BOWLING_DRIVE_PRESET };
/** World-up chase: chassis pitch and body tumble never roll the horizon. */
export function bowlingCamera(phase: BowlingPhase, pelvis: BowlingPoint, impact: boolean, car: BowlingPoint = pelvis, heading = 0, speed = 0, aspect = 16/9, preset = DEFAULT_BOWLING_DRIVE_PRESET) {
  const forward={x:Math.sin(heading),z:Math.cos(heading)};
  if(phase==='drive'||phase==='countdown') {
    const reveal=Math.max(0,Math.min(1,(car.z-BOWLING.hillStart)/12));
    const framing=BOWLING_DRIVE_PRESETS[preset],behind=framing.distance+(framing.descentDistance-framing.distance)*reveal,z=car.z-forward.z*behind;
    const driveAhead=framing.lookAhead+speed*.14;
    // Low at the crest, terrain clearance on the steep descent. Never roll the
    // horizon with the chassis. The summit itself occludes the lower course.
    return {position:{x:car.x-forward.x*behind,y:Math.max(car.y+framing.height+(framing.descentHeight-framing.height)*reveal,roadHeight(z)+.95+.85*reveal),z},target:{x:car.x+forward.x*driveAhead,y:roadHeight(Math.min(BOWLING.rampLip,car.z+driveAhead))+framing.lookHeight+.4*reveal,z:car.z+forward.z*driveAhead},fov:framing.fov+framing.speedFov*Math.min(1,speed/CAR.maxSpeed)};
  }
  if(phase==='score'||phase==='results'||(impact&&pelvis.z>BOWLING.headZ-7)) {
    const framing=COURSE.pinScale/1.6*Math.max(1,.9/Math.max(.25,aspect));
    return {position:{x:8*framing,y:7*framing,z:BOWLING.headZ-8*framing},target:{x:0,y:BOWLING.pinHeight*.5,z:(COURSE.deck.minZ+COURSE.deck.maxZ)/2},fov:64};
  }
  const rackBlend=Math.max(0,Math.min(.65,(pelvis.z-(BOWLING.headZ-14))/18));
  return {position:{x:pelvis.x-forward.x*8,y:Math.max(2.5,pelvis.y+3.2),z:pelvis.z-forward.z*8},target:{x:(pelvis.x+forward.x*5)*(1-rackBlend),y:Math.max(.5,pelvis.y+.2)*(1-rackBlend)+BOWLING.pinHeight*.3*rackBlend,z:pelvis.z+6},fov:65+5*Math.min(1,speed/30)};
}
