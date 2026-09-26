# Party Lab arena maps

## Architecture

- `types.ts`, `rooftop.ts`, `test.ts`, `index.ts` are pure data shared by the
  authoritative server, the client prediction rig and the local reference mode.
  `createArenaWorld(map)` (simulation/world.ts) builds Rapier colliders only from
  this data; nothing is derived from rendered meshes or the GLB.
- Online, every round names its game mode and each mode its map (`modes.ts`
  `MODE_MAP`): Rooftop Brawl → `rooftop` (`ONLINE_ARENA_MAP_ID`, used by
  `OnlineRoundSimulation` and `PredictionRig`), Barn Shootout → `barn`
  (`BarnRoundSimulation`, `BarnPredictionRig`). Changing an online map requires bumping
  `NET.version` (now 5; 5 added the Barn mode) so stale clients reject snapshots instead
  of predicting on the wrong geometry.
- Local mode defaults to `DEFAULT_ARENA_MAP_ID` (rooftop); the original platform
  (`test`) stays selectable from the local arena header for debugging.
- Spawns are map data (`map.spawns[slot]`); `PLAYERS` keeps slot identity only.
  Reset and fault recovery restore to the map's spawns, facing `spawnYaw(map, slot)`:
  the map's optional `spawnYaws`, else the origin (rooftop and test have none).
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

## Barn ("Ambar") — Barn Shootout, layout (local only)

`barn.ts`: a four-wing barn, 35 m across — a 13 m hub (x, z −6.5…6.5) and a 9 m wide
wing reaching 11 m out on each side (floor y 0, +Z = south, the entrance wing). The
wings are around corners from each other, and each wing's mouth has one side closed by
a tall piece in a pinwheel (north: crates; east: the hay steps' top; south: the stairs'
top; west: the ramp's top), with a tiered hay pile (1.6 m, 2.4 m top) in the middle of
the hub under the void. Props keep their Phase 1 sizes (crates, bales, barrels, stall
boards, rails, risers, treads); only the space grew. 61 static colliders: floor, 12 wall
blocks (the solid outside the cross, 6.5 m — 3.5 m above the upper floor), 8 decks and
the east landing, 4 columns, 10 rails, 2 wedges, 4 hay steps, 16 cover boxes, 3 barrels.

Wing identities: north — hay store under the hayloft, a bale tower, crates in the mouth,
a covered aisle under the north catwalk; south — the entrance yard (Big Barn's doors,
stairs up to the ring, a crate block); east — stalls under the east catwalk, hay steps
along the north wall; west — storage crates, the main ramp along the south wall.

Upper floor (3.0 m, decks 0.2 m thick, open underneath): a 2.5 m ring around an 8 × 8 m
void over the hub, broken for 4 m over the south wing's mouth; a catwalk up the north
wing's east side to the hayloft over its end; a catwalk over the east wing's stalls out
to the end wall. ~175 m², about 30% of the ground floor. Only the void's four corners
stand on posts, 0.6 m square: measured with the real character, 0.3 m posts left the
ragdoll leaning below 0.6 upright in half of random approaches (an arm wraps round),
0.6 m about as rarely as a crate. Three routes up, one per side, each rising toward the
hub: the west ramp and the south stairs (26.6° wedges; the stairs draw 0.15 m steps
over theirs), the east hay steps (0.6 m risers onto a solid landing). Every open deck
edge is either railed (1 m, about a third of it) or one of 13 marked drops (`DROPS`,
drawn with straw-coloured edge boards): the void's open NE corner and SW side, the
ring's broken ends, over the north/west/east wing mouths, the catwalks' open stretches,
the hayloft's front gap. Upstairs cover is one bale stack per branch.

Six respawn candidates with explicit yaws (`spawnYaws`: shared physics faces a slot's
spawn that way, other maps keep facing the origin): one per wing on the ground, facing
the hub, plus the ring's west side and the east catwalk. Start slots S1/S2/S3 (south
yard, east wing, ring) are ≥ 15 m apart and hidden from each other; of all 15 pairs only
the two upstairs ones on the ring and the catwalk see each other. S3 was the ring's NW
corner, where the rails left only a standing player's head reachable from the ground
floor (torso/pelvis from 0 of 419 ground spots, real hitscan); it moved 4.3 m south along
the ring (−5.25, 3, −1), where the west wing (open D7 edge) and the hub's south side
(void's west opening) reach the body from 25 spots — any part from 107. Seven weapon spots
(one per wing, the risky one under the void, the hayloft and the east catwalk's end)
and two bear traps on optional cut-throughs (the stall aisle under the east catwalk, the
west wing's north lane) — previews only.

Measured (same method old → new; scratch analysis, 1 m grid, chest-to-chest rays):
ground points seen from a point, mean 61% → 41%, best spot 80% → 67% (the hub);
opposite wings see 7% (N↔S) and 1% (E↔W) of each other, side wings ≤ 1%.
`barn.test.ts` keeps these checked: wing ↔ opposite/side < 10%, no deep-wing point sees
two other wings ≥ 25%, and the ring's inner edge is seen from ≥ 45% of the hub floor.
Real-character traversal: wing end ↔ wing end 6.7–6.8 s (the 23 m barn's longest run
was ~4.3 s), ground → ring 2.2 s (ramp, stairs) / 3.8 s (hay steps).

Local mode runs the barn untimed (`LocalRoundOptions.explore`) with Barn Shootout
combat (`barnCombat`: health, disposable weapons on the `WEAPON_SPOTS`, working `TRAPS`,
death and respawn over the `SPAWN_CANDIDATES` — see `simulation/barn/COMBAT.md`).
Slots 1–2 are passive target dummies holding their home spot with sub-turning input
(idle ragdolls creep ~1 m per 20 s on every map), resting 1.5 s after a hit so the
knockback reads, and moving home to wherever they respawn. The footer readout adds
draw calls, triangles, statics, boom, aim, yaw/pitch, position (`data-position`),
combat ray cost and a JSON combat state (`data-combat`) for walkthrough scripts.

Camera (`scene/arenas/barnCamera.ts`, barn only — rooftop keeps its fixed camera):
third-person chase camera over the right shoulder. Pivot 1.05 m above the pelvis,
4.2 m boom, 0.45 m shoulder offset, 65° FOV, rest pitch 10° down, aim pitch −30°…+35°
(the boom follows downward pitch fully and upward pitch at 0.6×). Yaw is the aim and
the body's facing (`MovementInput.facing`, turn rate `RAGDOLL.aimTurnSpeed`); WASD is
camera-relative. Collision is a sphere cast (0.22 m, grown convex solids) against every
shared collider plus camera-only solids for the shell (the wall mass outside the cross
up to the roof, each wing's gable roof, a cap at the hub's eave). Under a low ceiling
(a deck overhead, the roof near the eaves) a rising boom keeps its length and drops
toward level first — bisected, so it moves continuously — and is only then pulled in:
looking down under a deck squeezed the boom below 1.5 m in ~90% of cases, now ~24%.
Pulling in is immediate, easing out takes ~0.3 s; a short boom cranes up to 1 m and
fades the local character. Boom under 1.5 m in ~21% of all standable spots × yaws ×
pitches (the 23 m barn: 16.5%; the wings are narrower). Look input (`input/look.ts`):
Pointer Lock after a click in the arena (default; Esc releases) or drag-to-look.

Visuals: the shell is generated in `buildBarn.ts` (one vertex-coloured mesh: planked
walls with a timber frame and a deck-level ledger, gable roofs with rafters and collar
ties above the camera's reach, the hub's clerestory and pyramid roof, floors, decks with
undersides and fascia, ramp, stairs, landing, columns; a second mesh for the glowing
window panes). `public/party-lab/maps/barn/barn-kit.glb` (≈ 250 KB, untextured) from
`scripts/build-party-lab-barn-kit.mjs` holds the props and Big Barn's two doors, which
hang flattened on the boarded south end wall. `barn.test.ts` casts view rays from
player and camera positions to keep the shell closed. See `CREDITS.txt` next to the GLB.

## Katman Kaosu ("Katmanlar") — local and online

`layers.ts`: four stacked fields of flush 2 m hex tiles (85 / 79 / 78 / 55 = 297) at
16.5 / 11 / 5.5 / 0 m. The tiles break, so they are gameplay state, not map colliders:
`LAYERS_MAP` has no static colliders and is not in `ARENA_MAPS` (its id is the separate
`TileArenaId`); the tile field (`simulation/layers/tiles.ts`) adds one convex prism
collider per tile and disables it when the tile goes. The local arena lists it after the
static maps; online it is `MODE_MAP.layer_chaos` (protocol 6). Rules, camera and numbers:
`simulation/layers/LAYERS.md`; online: `../LAYER_ONLINE.md`.

## Renk Kaosu ("Renkler")

`colors.ts`: one field of 85 flush 2 m hex tiles (Katman Kaosu's L1 disc) at y = 0. Its
tiles drop and come back, so like Katman Kaosu's they are gameplay state: `COLORS_MAP` has
no static colliders and is not in `ARENA_MAPS` (`TileArenaId` "colors"); the colour tile
field (`simulation/colors/field.ts`) owns one prism collider per tile. The local arena lists
it; online it is `MODE_MAP.color_chaos` (protocol 7). Rules and numbers:
`simulation/colors/COLORS.md`; online: `../COLOR_ONLINE.md`. Its background is generated
geometry (no asset file).

## Oyun Parkı ("bomb") — Bomba Sende, local and online

`bomb.ts`: a 20 × 20 m walled rooftop playground (x, z −10…10, floor y 0), symmetric under a
half turn. The perimeter is a 1 m brick parapet with a glass guard to 3.2 m (one collider,
≥ 2 m over every standable top), so nothing is lethal. Inside:
- an open plaza in the middle;
- two 2.0 m L-wall pockets (NW, SE; two 2 m exits each);
- an AC-unit corner (NE) and a crate corner (SW), 1.1 m, hop-able;
- two 1.0 m catwalks along the N and S walls with 24° ramps;
- two jump shortcuts (a 1.5 m gap from each catwalk's end to the corner's 2.5 m top);
- two 0.9 m hop walls (E, W);
- three slow traps (`BOMB_TRAPS`), flat on the floor in a loose triangle on the plaza ring:
  gameplay state, not colliders (`simulation/bomb/traps.ts`), and the one thing without a
  half-turn twin.

19 static colliders. The map is not in `ARENA_MAPS` (the rooftop test pins its keys): its
id is `ModeArenaId` "bomb"; online it is `MODE_MAP.bomb_tag` (protocol 8), while the
local arena lists it after the tile modes. Rules, numbers, bots and camera:
`simulation/bomb/BOMB.md`; online architecture: `../BOMB_ONLINE.md`.

## Orman Kampı ("prophunt") — Saklambaç, local and online

`propHunt.ts` (+ `propHuntProps.ts`, the 20 transformable families and the furniture sizes):
a 22 × 22 m forest camp (x, z −11…11) with invisible 6 m boundary walls. A log lodge (13 × 8.5 m,
floor +0.45) with a loft (+3.65; stair, drop gap, loft door), a roofed porch with vaultable 1.0 m
rails, a lean-to with a walk-up woodpile route to the loft door, a shed, a work yard, a campfire
plaza, a tent camp against the SW boundary and a picnic pavilion. Doors 2.2 × 2.6 m; windows are
glass colliders. `PROP_HUNT_MAP` holds the architecture, furniture and landmarks only (101 static
colliders); the decoys change every round: `propHuntScenes.ts` holds the camp's 30 authored
scenes (slots with a semantic context, variants with variable counts) and `propHuntLayout.ts`
deals 60–68 decoys a round from them (the disguises' exact shapes; 15–18 of the 20 families in
play, each at least twice; about half of the camp kept from the round before), never into the
route clearances (`ROUTE_CLEARANCES` in `propHunt.ts`), and the game swaps their colliders at
each reset. A fixed chopping block (a stump with the axe in it) stands by the wagon. The lodge stair's steps are generated from its ramp collider. The id is `ModeArenaId`
"prophunt"; online `MODE_MAP.prop_hunt` selects it (protocol 9). Layout, rules, bots and
numbers: `simulation/prophunt/PROPHUNT.md`.

## Assets

`public/party-lab/maps/rooftop/rooftop-kit.glb` (≈178 KB) is generated from the
CC0 Downtown City MegaKit (Standard) by `scripts/build-party-lab-rooftop-kit.mjs`;
the raw pack stays outside the repository. See `CREDITS.txt` next to the GLB.

`public/party-lab/maps/layers/layers-kit.glb` (≈217 KB, vertex-coloured, untextured)
is Katman Kaosu's background scenery only (clouds, floating islands, ruins, grass hex
columns), built from CC0 Quaternius and Kenney packs by
`scripts/build-party-lab-layers-kit.mjs`; no gameplay tile or collider comes from it.

`public/party-lab/maps/bomb/bomb-kit.glb` (≈ 125 KB, vertex-coloured, untextured) holds Bomba
Sende's props only: the bomb, the crates (stretched over their colliders), the slow traps'
jaws (the Barn's bear trap model, recoloured), ledge planters and clouds. It is built from
CC0 Quaternius and Kenney packs by `scripts/build-party-lab-bomb-kit.mjs`. The rest of the playground (floor, walls, AC units,
catwalks, ramps, hop walls, glass) is generated from `bomb.ts`.

`public/party-lab/maps/prop-hunt/prop-hunt-kit.glb` (≈ 1.62 MB, vertex-coloured, untextured)
holds Saklambaç's props, furniture, tents, trees and window/door trims: 56 models from CC0
Quaternius packs (and the Barn's barrel, bags and bench), built by
`scripts/build-party-lab-prop-hunt-kit.mjs`. The 20 transformable families are fitted to their
gameplay shapes. The camp's buildings, ground and the lodge stair are generated from
`propHunt.ts` (the kit's `Stair` node is no longer drawn; the next kit rebuild can drop it).
