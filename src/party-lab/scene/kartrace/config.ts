/** Local circuit prototype. Deliberately absent from shared modes/protocol. */
export const RACE = { id: 'kart_race', label: 'ARABA YARIŞI', step: 1 / 60, countdown: 3, laps: 3, resetHold: 1.15, finishGrace: 22, timeout: 150 } as const;
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
