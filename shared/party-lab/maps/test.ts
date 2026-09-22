import type { ArenaMap } from "./types.js";

/** The original temporary platform, kept for debugging in the local mode. */
export const PLATFORM = { width: 14, depth: 12, height: 1.2 };
export const BUMPERS = [
  { x: -3.2, z: -1.7, radius: 0.85, height: 1.4, color: "#ef9a87" },
  { x: 3.2, z: -1.7, radius: 0.85, height: 1.4, color: "#e9ce7d" },
  { x: 0, z: -3.7, radius: 1.05, height: 0.65, color: "#aaa2d9" },
] as const;

const halfX = PLATFORM.width / 2,
  halfZ = PLATFORM.depth / 2;

export const TEST_MAP: ArenaMap = {
  id: "test",
  name: "Test platformu",
  bounds: { minX: -halfX, maxX: halfX, minZ: -halfZ, maxZ: halfZ },
  colliders: [
    {
      role: "floor",
      shape: "box",
      center: { x: 0, y: -PLATFORM.height / 2, z: 0 },
      half: { x: halfX, y: PLATFORM.height / 2, z: halfZ },
    },
    ...BUMPERS.map((b) => ({
      role: "bumper" as const,
      shape: "cylinder" as const,
      center: { x: b.x, y: b.height / 2, z: b.z },
      radius: b.radius,
      halfHeight: b.height / 2,
      friction: 0.3,
      restitution: 0.3,
    })),
  ],
  // Equal-radius, equilateral spawns, clear of each other and the bumpers.
  spawns: [
    { x: 1.5, y: 1.6, z: 2.598 },
    { x: -3, y: 1.6, z: 0 },
    { x: 1.5, y: 1.6, z: -2.598 },
  ],
  lethalEdges: [
    { from: { x: -halfX, z: -halfZ }, to: { x: -halfX, z: halfZ }, outward: { x: -1, z: 0 } },
    { from: { x: halfX, z: -halfZ }, to: { x: halfX, z: halfZ }, outward: { x: 1, z: 0 } },
    { from: { x: -halfX, z: -halfZ }, to: { x: halfX, z: -halfZ }, outward: { x: 0, z: -1 } },
    { from: { x: -halfX, z: halfZ }, to: { x: halfX, z: halfZ }, outward: { x: 0, z: 1 } },
  ],
  bot: { home: { x: 0, z: 0 }, wander: { x: 0, z: 0, halfX: 2, halfZ: 1.5 } },
};
