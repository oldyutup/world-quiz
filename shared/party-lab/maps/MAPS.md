# Party Lab arena maps

## Architecture

- `types.ts`, `rooftop.ts`, `test.ts`, `index.ts` are pure data shared by the
  authoritative server, the client prediction rig and the local reference mode.
  `createArenaWorld(map)` (simulation/world.ts) builds Rapier colliders only from
  this data; nothing is derived from rendered meshes or the GLB.
- `ONLINE_ARENA_MAP_ID` (rooftop) is the only online map. `OnlineRoundSimulation`
  and `PredictionRig` both use it. Changing the online map requires bumping
  `NET.version` (now 4; 4 added link diagnostics) so stale clients reject snapshots instead of predicting
  on the wrong geometry.
- Local mode defaults to `DEFAULT_ARENA_MAP_ID` (rooftop); the original platform
  (`test`) stays selectable from the local arena header for debugging.
- Spawns are map data (`map.spawns[slot]`); `PLAYERS` keeps slot identity only.
  Reset and fault recovery restore to the map's spawns, facing the origin.
- Local bots read `botArena(map)`: lethal edge segments (nearest one = carry
  direction, 0.85 m retreat margin), obstacle footprints with a cheap look-ahead
  slide (no navmesh), a home point and a wander box.
- Rendering: `src/party-lab/scene/Arena.tsx` switches on the map id. The rooftop
  visuals (`scene/arenas/`) mirror the shared layout constants and are visual only.

## Rooftop ("Çatı")

14 × 11 m roof (x −7…7, z −6.5…4.5, floor y 0), 10 static colliders: roof slab
(down to −4.6 m, vertical faces only), back wall, raised wall course behind the
stairs/deck, access building (3.1 m, the kit door frame is 3 m), raised deck
(1 m), stairs as one convex wedge (26.6°), two 1.78 × 1.2 × 0.7 m condensers
(Prop_ACUnit × 2) and two 0.3 m curbs with an open 4 m centre gap. Spawns form a
5.2 m equilateral triangle: (−2.6, 1.3), (2.6, 1.3), (0, −3.2); slots 0/1 mirror.

Edge language, from measured ragdoll behaviour:

| Edge | Where | Behaviour |
| --- | --- | --- |
| Open (hazard stripes) | left, right, centre front, deck's right side | lethal |
| 0.3 m curb | front flanks | stops punch knockback; shoves and carry-drops still lethal |
| 1.6 m brick wall | back (1.6 m above the deck behind it) | safe, including jump-spam |

The Phase 1 audit planned a 1.2 m wall; angled jump-spam got over 1.2 m in 19/30
trials (the stand-up support lifts a pelvis that clears the top onto it), 1.3 m
7/30, 1.4 m 5/30, 1.5–1.8 m 0/30. `rooftop.test.ts` checks the wall with
straight and angled attempts.

Visual only: a haze plane at y −4.2 (80% opaque, bodies fade before the
shared elimination at y −5), fog, a skyline behind the safe wall, and lower
buildings beside/in front of the drops sunk below the haze and the elimination
height so nothing near a drop looks landable.

## Assets

`public/party-lab/maps/rooftop/rooftop-kit.glb` (≈178 KB) is generated from the
CC0 Downtown City MegaKit (Standard) by `scripts/build-party-lab-rooftop-kit.mjs`;
the raw pack stays outside the repository. See `CREDITS.txt` next to the GLB.
