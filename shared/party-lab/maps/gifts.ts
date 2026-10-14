import { GIFT } from "../simulation/gifts/config.js";
import type { ArenaCollider, ArenaMap, Vec2, Vec3 } from "./types.js";

/**
 * "Hediye Avlusu" — Hediye Kapmaca's round walled yard (local and online). One physics map
 * for 2 and 3 players: everything solid turns onto itself every 60° (the wall's 36
 * segments, the pile's round stand in the middle, six low obstacles between the homes), so
 * the yard is exactly symmetric whichever homes are used. Homes are flat (no collider):
 * 3 players get three 120° apart, 2 players two opposite ones, all `homes.distance` from
 * the middle.
 *
 * Angles use the body's yaw convention: a point at angle a, distance d is (sin a·d, cos a·d),
 * so angle 0 is +Z (toward the default camera).
 */
const A = GIFT.arena;
export const GIFT_STAND = 0.78;

/** Angle of seat `seat`'s home in a match of `players` (seat 0 at +Z). */
export const homeAngle = (players: number, seat: number) => (2 * Math.PI * seat) / (players === 2 ? 2 : 3);
export const polar = (angle: number, distance: number): Vec2 => ({ x: Math.sin(angle) * distance, z: Math.cos(angle) * distance });
/** Centre of seat `seat`'s home. */
export const homeCenter = (players: number, seat: number): Vec2 => polar(homeAngle(players, seat), GIFT.homes.distance);
/** The six obstacles (60° apart, 30° off every home of either player count). */
export const GIFT_DECOR: readonly Vec2[] = Array.from({ length: GIFT.decor.count }, (_, i) =>
  polar(GIFT.decor.offset + (2 * Math.PI * i) / GIFT.decor.count, GIFT.decor.distance)
);
/** Pelvis spawn of seat `seat`: in the middle of its home, facing the pile. */
export function giftSpawn(players: number, seat: number): Vec3 {
  const c = homeCenter(players, seat);
  return { x: c.x, y: 0.9, z: c.z };
}
export const giftSpawnYaw = (players: number, seat: number) => homeAngle(players, seat) + Math.PI;

function wall(): ArenaCollider[] {
  const { thickness, height, segments } = A.wall,
    r = A.radius + thickness / 2,
    // Each segment a little longer than its chord, so neighbours overlap and leave no gap.
    half = r * Math.tan(Math.PI / segments) + 0.08;
  return Array.from({ length: segments }, (_, i) => {
    const angle = (2 * Math.PI * i) / segments,
      p = polar(angle, r);
    return { role: "parapet", shape: "box", center: { x: p.x, y: height / 2, z: p.z }, half: { x: half, y: height / 2, z: thickness / 2 }, yaw: angle } as const;
  });
}

export const GIFT_MAP: ArenaMap = {
  id: "gift_grab",
  name: "Hediye Avlusu",
  bounds: { minX: -A.radius, maxX: A.radius, minZ: -A.radius, maxZ: A.radius },
  colliders: [
    { role: "floor", shape: "box", center: { x: 0, y: A.slabBottom / 2, z: 0 }, half: { x: A.floor, y: -A.slabBottom / 2, z: A.floor } },
    ...wall(),
    { role: "pedestal", shape: "cylinder", center: { x: 0, y: GIFT.pedestal.height / 2, z: 0 }, radius: GIFT.pedestal.radius, halfHeight: GIFT.pedestal.height / 2 },
    ...GIFT_DECOR.map((p): ArenaCollider => ({ role: "decor", shape: "cylinder", center: { x: p.x, y: GIFT.decor.height / 2, z: p.z }, radius: GIFT.decor.radius, halfHeight: GIFT.decor.height / 2 })),
  ],
  spawns: [giftSpawn(3, 0), giftSpawn(3, 1), giftSpawn(3, 2)],
  spawnYaws: [giftSpawnYaw(3, 0), giftSpawnYaw(3, 1), giftSpawnYaw(3, 2)],
  lethalEdges: [],
  bot: { home: { x: 0, z: 0 }, wander: { x: 0, z: 0, halfX: 5, halfZ: 5 } },
};

/** Circles bots and the box landing keep clear of: the stand and the obstacles (radius without clearance). */
export const GIFT_SOLIDS: readonly { x: number; z: number; r: number }[] = [
  { x: 0, z: 0, r: GIFT.pedestal.radius },
  ...GIFT_DECOR.map((p) => ({ x: p.x, z: p.z, r: GIFT.decor.radius })),
];

/**
 * Where a box thrown toward (x, z) comes to rest: inside the wall, off the stand and the
 * obstacles (pushed straight out of whichever it would sit in).
 */
export function restingPoint(x: number, z: number): Vec2 {
  const size = GIFT.box.size,
    edge = A.radius - size * 0.75;
  let d = Math.hypot(x, z);
  if (d > edge) {
    x *= edge / d;
    z *= edge / d;
  }
  for (const s of GIFT_SOLIDS) {
    const dx = x - s.x,
      dz = z - s.z,
      clear = s.r + size * 0.75;
    d = Math.hypot(dx, dz);
    if (d >= clear) continue;
    const ux = d > 1e-6 ? dx / d : 0,
      uz = d > 1e-6 ? dz / d : 1;
    x = s.x + ux * clear;
    z = s.z + uz * clear;
  }
  return { x, z };
}
