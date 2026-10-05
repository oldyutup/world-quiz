import RAPIER from '@dimforge/rapier3d-compat';
import { PerspectiveCamera, Vector3 } from 'three';
import { clamp, FEET, type Input } from './config';
import type { CrateRainGame } from './game';
export type CrateView = 'third' | 'first';
export const nextCrateView = (view: CrateView): CrateView => view === 'third' ? 'first' : 'third';
export const CRATE_CAMERA = Object.freeze({ distance: 6, elevation: 2.25, eye: 1.30, thirdFov: 66, firstFov: 78, near: 0.06, radius: 0.22, turnSpeed: 1.65, pitchSpeed: 1.12, mouseSensitivity: 0.003 });
const ROT = { x: 0, y: 0, z: 0, w: 1 };
const wrap = (n: number) => Math.atan2(Math.sin(n), Math.cos(n));
export const viewMovement = (input: Input, yaw: number): Input => ({ ...input, x: input.x * Math.cos(yaw) + input.z * Math.sin(yaw), z: -input.x * Math.sin(yaw) + input.z * Math.cos(yaw) });
/** Ground-level, unshaken camera; collision is a swept sphere, never transparency. */
export class CrateCamera {
  yaw = 0; pitch = 0; distance: number = CRATE_CAMERA.distance; hiddenPlayer = false;
  private round = -1; private subject = -1;
  private eyeY = 0; private ball = new RAPIER.Ball(CRATE_CAMERA.radius);
  reset(g: CrateRainGame) {
    const p = g.players.find(p => p.alive) ?? g.players[0], at = p.body.translation();
    this.yaw = Math.atan2(at.x, at.z); this.pitch = 0;
    this.eyeY = at.y - FEET + CRATE_CAMERA.eye; this.distance = CRATE_CAMERA.distance; this.round = g.round; this.subject = p.id;
  }
  steer(input: Input & { yaw: number; pitch: number }, view: CrateView, dt: number, mouse = { dx: 0, dy: 0 }): Input {
    const yawDelta = input.yaw * CRATE_CAMERA.turnSpeed * dt - mouse.dx * CRATE_CAMERA.mouseSensitivity;
    this.yaw = wrap(this.yaw + yawDelta);
    this.pitch = clamp(this.pitch + input.pitch * CRATE_CAMERA.pitchSpeed * dt + mouse.dy * CRATE_CAMERA.mouseSensitivity, view === 'third' ? -1.55 : -1.3, 0.95);
    // Both views use the camera basis. Character visual turning never steers it.
    return viewMovement(input, this.yaw);
  }

  update(camera: PerspectiveCamera, g: CrateRainGame, view: CrateView, dt: number, alpha = 1) {
    const player = g.players[0].alive ? g.players[0] : g.players.find(p => p.alive) ?? g.players[0];
    if (g.round !== this.round || player.id !== this.subject) this.reset(g);
    const at = player.body.translation(), eye = at.y - FEET + CRATE_CAMERA.eye;
    this.eyeY += (eye - this.eyeY) * (1 - Math.exp(-22 * dt));
    // Smoothing never drags the eye below the capsule's usable upper half.
    this.eyeY = clamp(this.eyeY, eye - 0.22, eye + 0.22);
    const pivot = new Vector3(player.positionBefore.x + (at.x - player.positionBefore.x) * alpha, this.eyeY, player.positionBefore.z + (at.z - player.positionBefore.z) * alpha);
    const forward = new Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    let tilt = this.pitch;
    if (view === 'third') {
      const boom = forward.clone().multiplyScalar(-CRATE_CAMERA.distance); boom.y = CRATE_CAMERA.elevation;
      const length = boom.length(), direction = boom.clone().normalize();
      const hit = g.world.castShape(pivot, ROT, direction, this.ball, 0.02, length, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, collider => !g.players.some(p => p.collider.handle === collider.handle));
      const safe = hit ? Math.max(0, hit.time_of_impact - 0.06) : length;
      // Pull in immediately; ease back out only along the freshly checked clear ray.
      this.distance = Math.min(safe, this.distance + dt * 5);
      camera.position.copy(pivot).addScaledVector(direction, this.distance);
      tilt += Math.atan2(CRATE_CAMERA.elevation, CRATE_CAMERA.distance);
      this.hiddenPlayer = this.distance < 1.15;
    } else { camera.position.copy(pivot); this.hiddenPlayer = true; }
    const fov = view === 'third' ? CRATE_CAMERA.thirdFov : CRATE_CAMERA.firstFov;
    if (camera.fov !== fov || camera.near !== CRATE_CAMERA.near) { camera.fov = fov; camera.near = CRATE_CAMERA.near; camera.updateProjectionMatrix(); }
    camera.lookAt(camera.position.x + forward.x * Math.cos(tilt), camera.position.y - Math.sin(tilt), camera.position.z + forward.z * Math.cos(tilt));
    camera.updateMatrixWorld();
    return { player: player.id, position: pivot, forward };
  }
}
