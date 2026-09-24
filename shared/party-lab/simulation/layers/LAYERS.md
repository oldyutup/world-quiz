# Katman Kaosu (`layer_chaos`)

The rules, map, camera and presentation of Katman Kaosu. The local arena ("Katman
Kaosu", 1 human + 1–2 bots) runs them in the browser; online (protocol 6: server
authority, tile network state, prediction, spectating) is described in
[../../LAYER_ONLINE.md](../../LAYER_ONLINE.md). Both drive the same shared
`LayerChaosGame`; the tuning below is unchanged online.

## Files

| Where | What |
| --- | --- |
| `shared/party-lab/maps/layers.ts` | Hex grid, the four audited layouts (297 tiles), spawns, `LAYERS_MAP` (no static colliders) |
| `simulation/layers/config.ts` | `LAYER_CHAOS` tuning, whole-tick conversions (`LAYER_TICKS`), `breakTicks`, `schedulePhase` |
| `simulation/layers/timeline.ts` | `TileTimeline`: the tile state machine without physics, `TileView` (what visuals, camera and fall rules read) |
| `simulation/layers/game.ts` | `LayerChaosGame`: one playing step in the approved order; local arena and server share it |
| `simulation/layers/wire.ts` | Online tile section encode/decode, `LayerTileKnowledge` (a client's tile state on any tick) |
| `simulation/layers/tiles.ts` | `TileField`: the timeline plus one convex prism collider per tile (disabled and parked when GONE) |
| `simulation/layers/trigger.ts` | `supportingTile`: hips ray, feet fallback |
| `simulation/layers/brawl.ts` | `LayerBrawl`: shove punch + stagger (no health) |
| `simulation/layers/round.ts` | `LayerRound`: countdown / play / results, last alive wins, same-tick draw |
| `src/party-lab/scene/layers/` | Local arena: bots, camera, fall rule, instanced tile visuals, background scenery, playground, HUD (`game.ts` re-exports the shared game) |
| `src/party-lab/scene/layers.test.ts` | Deterministic tests (rules, camera, scenery layout and kit) |
| `scripts/build-party-lab-layers-kit.mjs` | Builds `public/party-lab/maps/layers/layers-kit.glb` (scenery only) |

## Map

Hex tiles 2.0 m flat to flat (corner radius 2/√3 ≈ 1.155 m), 0.5 m deep, flush (0 m
physical gap; the 6 cm groove is rendering only). Axial (q, r): centre
x = 2·(q + r/2), z = √3·r. Four layers, walking surfaces 16.5 / 11 / 5.5 / 0 m:

- L1 Taç — every cell within 9.2 m of the middle: 85 tiles.
- L2 Pencere — L1 minus three inner windows (ring 2) and three rim notches (ring 4), all
  between the spawns: 79.
- L3 Petek — L1 minus the hub and six windows on ring 2: 78.
- L4 Çekirdek — every cell within 7.3 m: 55.

Spawns: L1 cells 3 steps toward slots 0/1/2 — (6, 0), (−3, ±5.196) — pelvis 17.4 m,
facing the middle. The elimination line is the shared `RAGDOLL.fallY` (−5 m).

## Rules (all in 60 Hz round ticks; tick 0 = first playing tick)

- Countdown 3 s: bodies step with idle input, nothing arms. Results 3.5 s, then a
  fresh round (tiles, bodies, punches reset).
- Arming: after each playing step, every living player's supporting tile arms if
  untouched. Support = the pelvis ray the controller's stand-up support uses
  (`RAGDOLL.supportRange` 0.97 m, walkable normal), not while in a jump's rising phase
  (jump cooldown, or pelvis rising ≥ 2 m/s); only if the hips find nothing, a toe ray of
  either leg. Hands, arms, head and torso are never probed. No grace period.
- Duration fixed at first arming: 78 ticks (1.30 s); 63 (1.05 s) for tiles armed from
  45 s; 48 (0.80 s) from 70 s. More players on a tile change nothing.
- Stages: WARN < 31%, CRACK < 69%, BREAK < 100% of the duration; GONE on `goneTick`,
  processed at the start of that tick before physics: the collider is disabled and
  parked at y −1000 (a disabled collider still answers ray queries until the next world
  step; parked, it does not — so the controller's support ray is exact too). No rigid
  body is ever created for a broken tile.
- Collapse (anti-stall): layer k's outermost ring is MARKED at 70 / 76 / 82 / 88 s, each
  next ring inward 1.2 s later; a MARKED tile arms 1.0 s after its mark, only if still
  untouched. The last tile (L4's centre) arms at 93.8 s and goes at 94.6 s; everyone is
  out by ~95.4 s. 100 s is a safety cap (draw).
- Round: last alive wins on the tick it happens (no fall grace); the last players out on
  the same tick draw.
- Punch (Punch binding): cooldown 0.6 s, alternating hands, lands by real hand contact
  (rooftop/Barn rule). Hit: whole-body Δv 3.0 m/s horizontal + 0.3 m/s up and a 0.35 s
  stagger (posture 0.7, mobility 0.25, no jump). A hit during a stagger pushes but does
  not extend it. No health, knockout meter, grab, lift, weapons or traps.
- Sprint: Lift binding (Shift) → `MovementInput.sprint` (×1.4, 0.25 s blend, shared
  controller). Jump physics unchanged.

## Camera (`scene/layers/layerCamera.ts`)

Elevated chase camera, no shoulder offset: pivot 0.9 m over the pelvis, boom 5.6 m, rest
pitch 30° down, pitch 18°–55°, 60° vertical FOV. Mouse/trackpad orbit through
`input/look.ts` (Pointer Lock or drag); WASD camera-relative; the body turns toward its
movement. Collision samples the boom through every layer slab above the pivot (holes let
it through): the pitch is lowered first (bisection), then the boom shortens, never below
3 m. Standing anywhere, lowering alone keeps ≥ 3 m (tested); only a body falling past a
layer needs less, and the camera then keeps 3 m and passes through that (faded) layer.
Layers above the followed character fade to 0.3. A body that falls out is watched from
L4's level for 1.2 s, then the nearest survivor is followed (Q / E cycle, "İzleniyor: …").

**Jumping vs falling between layers** (`scene/layers/fall.ts`, per character, per tick).
A jump is airborne, comes down at up to ≈ 6.6 m/s and may cross a hole, so none of those
means "falling". A body falls between layers while descending (> 1 m/s) when its pelvis is
more than 2.2 m over the layer surface below it (higher than a jump's 1.74 m apex: it has
dropped past its layer, or is under the last one), or below 0.6 m (standing ≈ 0.78 m) over
a hole with no intact tile of that layer within 0.5 m (closer, a short jump can still catch
the far tile's edge and climb up; measured ≤ 0.45 m). The fall ends when the body stops
descending (< 0.5 m/s) near a layer, which becomes its ground.
- Normal play (jumps included): the pivot rides at standing height over the ground layer
  plus 15% of the pelvis above it (a jump lifts the view 0.14 m, within the 0.17 m
  headroom under an intact layer, so the pitch never drops), eased through two 0.06 s
  stages. No landing marker, no look-down.
- Falling between layers: the pivot follows the drawn pelvis (0.03 s), the landing marker
  shows the first intact tile below (red: nothing below), and the camera looks half way
  toward it (≤ 3 m).

## Rendering (`scene/layers/tileVisuals.ts`)

One InstancedMesh per layer (4 draw calls for 297 tiles, 44 triangles each), one pooled
InstancedMesh for falling pieces, a landing marker. Per-instance colour, matrix and a
`tileState` attribute drive the shader: cracks drawn procedurally on the top, rim glow
(warm when armed, red while MARKED), alpha for pieces. Stage feedback is never colour
alone: WARN pulses its rim; CRACK turns orange, shows cracks and sinks 3 cm; BREAK turns
red-orange, cracks more, sinks 10 cm, shakes and tilts; MARKED shivers; GONE falls,
tumbles, shrinks and fades for 0.6 s. Generated geometry only, no textures, no assets.

## Scenery: "Gök Petekleri" (`scene/layers/skyScenery.ts`)

Client-only background: the stack floats high in the sky. No collider, rigid body,
shadow or per-frame update; the simulation (and a server) never sees it. Pieces come
from `layers-kit.glb` (≈ 217 KB, 16 nodes, 7.3k triangles: CC0 Quaternius Platformer
Game Kit, Kenney Nature Kit and Platformer Kit; see `CREDITS.txt` next to it), baked by
the build script to vertex colours from one pastel palette (metalness 0, no textures).
All placed pieces merge into two meshes (solid, clouds): +2 draw calls, ≈ 15k triangles.

- Cloud sea: six flattened clusters (12 clouds) poking through the haze floor, tops ≤ −1.2 m.
- Six floating islands 50–90 m out: rock platform over an upside-down boulder; one tree,
  one bush, a broken column, an obelisk and a stone ring on top.
- Three ruined landmark columns (50 m, between the spawns: each spawn looks across the
  crown toward one) with a violet pennant each; two broken stumps in the cloud sea.
- Six tilted grass hex columns 40–50 m out (a honeycomb echo, clearly not tiles).

Readability rules, checked by tests: every vertex ≥ 30 m from the axis (the camera never
leaves ≈ 17 m, so scenery can never come between it and a tile or player, sit under a
hole or clip it); cloud sea and stumps below the last layer; island and hex tops ≥ 1.5 m
from every walking height. Distance, fog and a per-piece mix toward the sky colour keep
it pale; the tiles stay the strongest thing on screen. A missing kit leaves the plain sky.

## Arena chrome

Katman Kaosu opens in the immersive arena layout shared with online Rooftop and Barn
(`scene/ArenaChrome.tsx`): the arena fills the window (≈ 96–97 % on laptop/desktop sizes),
and only gameplay HUD sits on it: the menu button, roster and clock, the countdown / "Düştün!"
/ result message, the anti-stall banner, the spectator label ("İzleniyor: … · Q / E
değiştir"), the click-to-look prompt when needed, and a controls line for the first 5 s of
play (again after visiting Controls). The Esc menu holds Oyuna Dön, Kontroller, Ses, Bakış,
Harita (other local test maps, which keep their header/footer test layout), Oyuncu (2 or
3), Tam Ekran, Debug bilgileri and Lobiye Dön. It is not a pause: only the player's input
stops; the round, bots and tiles go on behind it.

## Debug

Local arena (below). Online, ordinary players see no debug readout at all; with
`?partyDebug=1` the Esc menu offers "Debug bilgileri" (see LAYER_ONLINE.md).

The readout (layer, alive, round time, tile counts by stage, break time, collapse
phase/ring, position, camera, FPS, physics ms, draw calls, triangles, enabled colliders)
lives in the Esc menu's debug panel: collapsed by default, open at start with
`?layerDebug=1` or `?partyDebug=1`. It is always written, and mirrored as JSON in
`data-layers` on `.pl-layer-debug`, so scripts read it with the panel closed. With
`?layerDebug=1`: P hands slot 0 to a bot (autopilot), T skips the round clock 10 s ahead,
G hides/shows the background scenery (readability and cost A/B), and a script that sets
`window.__layerTrace = []` gets one row per rendered frame (pelvis, vertical speed,
grounded, jump cooldown, fall state, marker, pivot and camera height, pitches, boom).
