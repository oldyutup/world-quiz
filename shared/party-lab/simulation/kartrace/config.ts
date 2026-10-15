/** Approved circuit and chassis rules shared by local play, prediction and server. */
export const RACE = { id: 'kart_race', label: 'ARABA YARIŞI', step: 1 / 60, countdown: 3, laps: 3, resetHold: 1.15, finishGrace: 22, timeout: 150,
  /** A checkpoint counts up to this far (m) beyond the asphalt edge: two wheels on the grass, a barrier scrape or a cut apex all count. */
  gateMargin: 5,
  /** Passing a checkpoint's line this far (m) beyond the asphalt edge, or a later checkpoint, is a miss ("KONTROL NOKTASINI KAÇIRDIN"). */
  missReach: 30,
  /** The later checkpoints a miss is noticed on (a shortcut across the infield comes back through one of them). */
  missLookahead: 5,
} as const;
/**
 * Rüzgâr alma (slipstream). A car in the narrow cone behind another (`minDistance`–`maxDistance` m
 * behind it along its heading, centre to centre; within ±(`halfWidth` + `widen` × (distance −
 * minDistance)) m sideways; headings within `maxHeading` rad; both at least `minSpeed` m/s) for
 * `charge` s starts to build a tow: 0 → 1 in `build` s. Out of the cone it fades 1 → 0 in `fade` s.
 * A full tow raises the top speed by `speedBonus` and the acceleration by `accelBonus`.
 */
export const DRAFT = {
  minDistance: 3, maxDistance: 14, halfWidth: 1.5, widen: 0.064, maxHeading: 20 * Math.PI / 180, minSpeed: 55 / 3.6,
  charge: 0.6, build: 1.5, fade: 0.8,
  speedBonus: 0.12, accelBonus: 0.35,
} as const;
/**
 * Yakalama yardımı: only the last car still racing, when its race distance behind the car ahead of
 * it is over `from` m; full at `full` m. Adds `speedBonus` top speed and `accelBonus` acceleration
 * (on top of a tow).
 */
export const CATCH_UP = { from: 40, full: 120, speedBonus: 0.05, accelBonus: 0.10 } as const;
// Current Bowling DNA: 240 kg, 0.64 m ride height, four support rays, 18 m/s² brake.
export const CAR = { mass: 240, rideHeight: .64, acceleration: 7.8, brake: 18, coast: .65, maxSpeed: 110 / 3.6, reverse: 6, grip: 16, grassGrip: 3.2 } as const;
export const HANDBRAKE = { grip: 4.8, brake: 10, yawGain: 1.24, yawResponse: 4.5 } as const;
export interface Vec { x: number; y: number; z: number }
export interface DriveInput { throttle: number; brake: number; steer: number; handbrake?: boolean; reset?: boolean }
export const IDLE: DriveInput = { throttle: 0, brake: 0, steer: 0 };
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export const angle = (n: number) => Math.atan2(Math.sin(n), Math.cos(n));
export const yaw = (n: number) => ({ x: 0, y: Math.sin(n / 2), z: 0, w: Math.cos(n / 2) });
export const headingOf = (q: { x: number; y: number; z: number; w: number }) => Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
export const steeringRate = (speed: number) => 2.7 / (1 + Math.abs(speed) / 18) * Math.min(1, Math.abs(speed) / 3);
export const GROUP = { ground: 1, car: 2, wall: 4 };
export const groups = (member: number, filter: number) => (member << 16) | filter;
export const COLORS = ['#ed6a51', '#3b9bb9', '#e3b644'];
export const NAMES = ['SEN', 'MAVİ', 'SARI'];
