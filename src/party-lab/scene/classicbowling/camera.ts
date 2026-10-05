import { Vector3, type PerspectiveCamera } from 'three';
import type { ClassicGame } from './game';
/** Translation only, fixed pitch/yaw throughout: no chase orbit or zoom pulses. */
export const CLASSIC_CAMERA = { behind: 6.4, height: 3.35, fov: 46, maxTrack: 7.5, rate: 2.4 } as const;
export function classicCamera() {
  let track = 0, ready = false;
  const look = new Vector3();
  return {
    update(camera: PerspectiveCamera, game: ClassicGame, delta: number, reducedMotion = false) {
      const p = game.ball?.translation();
      const forward = p && ['rolling', 'feedback'].includes(game.phase) ? Math.max(0, Math.min(CLASSIC_CAMERA.maxTrack, p.z * .76)) : 0;
      const target = reducedMotion ? 0 : forward;
      track = ready ? track + (target - track) * (1 - Math.exp(-CLASSIC_CAMERA.rate * delta)) : target; ready = true;
      camera.position.set(0, CLASSIC_CAMERA.height, -CLASSIC_CAMERA.behind + track);
      look.set(0, .05, 5.3 + track); camera.lookAt(look);
      if (camera.fov !== CLASSIC_CAMERA.fov) { camera.fov = CLASSIC_CAMERA.fov; camera.updateProjectionMatrix(); }
    },
  };
}
