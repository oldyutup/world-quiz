# Saklambaç (Prop Hunt), local V1

One seeker, two hiders, in the forest camp "Orman Kampı" (`maps/propHunt.ts`). The hiders turn
into camp props; the seeker has 15 shots to find both. The ordinary props come from authored
scene recipes (`maps/propHuntScenes.ts`, dealt by `maps/propHuntLayout.ts`): each round keeps
about half of the camp as it was and redresses the rest, so the camp stays familiar but its exact
props and counts cannot be memorised; every 15 s of the search (60, 45, 30 and 15 s left) each
hidden hider whistles once; a seeker who lingers close to a hidden hider gets a vague hunch; the
seeker may play in first person (V); the result reveals every hider still hidden. Local play uses one human (either role, Esc menu "Rol") and two bots.
The same approved simulation also powers online protocol 9; see [PROP_ONLINE.md](../../PROP_ONLINE.md)
for server authority, three-player enforcement, room settings and reconnect behavior.
The rules below describe the unchanged local defaults.

The simulation (`game.ts`, `round.ts`, `disguise.ts`, `aim.ts`, `config.ts`) is shared code
with no browser dependency and deterministic for the same inputs, and is run by the online room wrapper. Rooftop, Barn, Katman Kaosu, Renk Kaosu and Bomba Sende are untouched (seeded
simulation hashes of all of them, local and online, match HEAD).

## Rules

| Rule | Value |
| --- | --- |
| Players | 3: one seeker, two hiders (slot 0 is the human; its role is chosen in the Esc menu) |
| Countdown | 3 s, everyone frozen, the roles shown |
| Hiding | 15 s. Hiders move and transform. The seeker is frozen, cannot shoot, and its screen is blacked out |
| Search | 75 s. The seeker hunts; hiders keep still (or move, slowly) |
| Results | 5 s, with every hider still hidden revealed where it was; then a fresh round with the same roles |
| Seeker wins | On the tick the second hider is found (also by the 15th, last shot) |
| Hiders win | When the search runs out with at least one hider not found, or at once when the seeker's last shot is spent with one still hidden ("Mermin bitti!"): the shot is resolved first |
| Ammo | 15 shots per round, one per shot. No reload, no pickups; there is no 16th |
| Shot | Hitscan, 0.55 s between shots, 40 m. A hider's prop or an undisguised hider's body: found. A decoy, a wall, glass, furniture: only the shot is lost |
| Found | Out until the next round (no respawn); the prop bursts into the character, then it spectates |
| Whistle | Every 15 s of the search — at 60, 45, 30 and 15 s left (never at 10 s) — each hider still hidden whistles once (slot order, 0.6 s apart) from its prop or body: a positional sound, no marker |
| Hunch | A hider still hidden within 5.5 m of the seeker (feet within 1.5 m, no wall, window, floor or roof between them) for 0.9 s in a row: one "Yakınlarda biri var..." pulse; rearm only after 1.25 s beyond 6.5 m of all living hiders. Never who, which prop, which way or how far |
| Seeker camera | The shoulder camera by default; V (or the Esc menu's "Kamera") swaps to first person and back. Hiders are always third person |
| Props | 60–68 decoys a round (≈ 64) from the scene recipes; 15–18 of the 20 families in play (each at least twice); 45–55% of the ordinary props change from one round to the next |

### Transforming (hiders)

- **E** copies the nearest decoy the hider could reach: its footprint within 1.8 m of the
  pelvis (horizontally), standing within 1.2 m of the hider's feet, and in plain sight: a line
  from the chest or the pelvis to its middle meets nothing else (no copying through walls,
  glass, floors or other props). Scenery (furniture, tents, woodpile, walls) is never copied:
  only the round's decoys (60–68, the 15–18 families in play), all hider-sized (no side under 0.45 m).
- Refused in the air, within 0.8 s of the last transform, or with no room (the shape is tried
  at the decoy's quarter turn, the hider's facing and the other turns, nudged up to 0.9 m to
  fit; it settles on whatever is under its whole footprint).
- **E** again steps back out, where a standing body fits (the spot or up to 0.6 m aside).
- The disguise uses the decoy family's gameplay shape exactly (the same box or cylinder the
  decoys use), drawn with the same kit model: side by side it is identical to a real one.

### The disguise's body (collider approach)

A disguised hider's ragdoll is retired (parked, as a found player is), and a **kinematic** body
with the family's shape takes its place, moved by Rapier's character controller:
- 2.3 m/s (walking is 4.6), eased at 12 m/s², turning at 3.2 rad/s toward where it goes (only if
  the turned shape fits). No jump, no sprint.
- Autostep 0.47 m (the lodge's 0.45 m floor from its 0.22 m entry steps; never the 0.6 m crate
  step at the woodpile), slopes up to 35° (the stair is 26.6°, the lean-to roof 22.6°), snaps
  to the ground within 0.3 m, falls off edges (the loft's drop gap) under 20 m/s² gravity.
- Pressed into a wall (a contact steeper than 35°), only the speed going into it is dropped, so
  it slides along; slopes and steps keep the speed.
- It rests on the highest point under its footprint, so a long prop pushed half over a low step
  or a log sits propped on it (that looks off, which is itself a tell).
- It is not a dynamic prop: no toppling, rolling or being pushed about. Ragdolls collide with it
  like with any kinematic body.
- Order per tick: transforms → disguise moves → physics step → the seeker's shot, so a shot
  sees the world as the step left it.

### The seeker's blaster

The Barn's aim model with this mode's camera: the crosshair line runs from the camera through a
shoulder point (1.0 m above the pelvis, 0.55 m right of the aim yaw); what it meets first is the
aim point, and the shot leaves the torso toward it, so cover in front of the body stops the shot
even when the crosshair is clear (the crosshair turns into a red X). The shot's first hit
decides: a hider's body part or disguise → found; a decoy → "bulletHit" puff, nothing else;
anything else → a spark on the world.

In first person (below) the crosshair line starts at the camera itself (the eye, 1.68 m over the
feet, on the body's axis) instead of the shoulder: that only decides the aim point. The shot is
the same simulation — `seekerIntent` → `fire` → `aim` — leaving the torso toward that point, so
looking over a crate or round a door jamb from the eye never lets the body shoot through it (the
red X shows it). Tests pin it: a stance where the eye sees a stump over a crate while the torso's
line meets the crate (the crate takes the shot, in both views), a wall stopping the shot, and
over 100+ aimed shots both views hitting the same prop (or missing it) at least 90% of the time,
from the same origin every time.

## Map: "Orman Kampı" (maps/propHunt.ts)

22 × 22 m (x, z −11…11), invisible 6 m walls at ±11 (≥ 1.5 m over every reachable top by them;
the lean-to roof at 3.05 m is the highest), the forest, fences, bushes and rocks drawn outside.
The longest walk from the seeker's spawn is ≈ 7 s. Zones (their scenes, then the average decoys a
round over 500 dealt rounds):
- **Lodge** (NW, 13 × 8.5 m, floor +0.45): great room with fireplace, couch, bookshelf; dining
  table and chairs; kitchen run along the north wall; bunk bed. Front door (porch), side door
  (yard), loft door (lean-to roof): 2.2 × 2.6 m. Clear height ≥ 3.0 m under the loft and in it.
  Windows are glass colliders: shots and copying stop on them. [dining table (2–5 chairs, the
  corner under the stair's top), great room, kitchen east wall, kitchen south wall; ≈ 10.2]
- **Loft** (5 × 7.9 m at +3.65): up the stair (26.6°, along the north wall), down the 2.2 m
  drop gap on its open side (a 1.0 m rail on the rest), or out of the loft door onto the lean-to
  roof. Its middle only takes props ≤ 1 m, so both sides keep ≥ 1.27 m. [bunk, north wall, middle, south wall; ≈ 5.0]
- **The stair** is drawn from its collider (`scene/prophunt/arena.ts`, `stairSteps`): 20 risers
  of 0.16 m on 0.32 m treads, every nose on the ramp's slope line (the ramp a body walks on is
  never more than one riser above a tread), the first riser rising from the lodge floor, the top
  tread running right to the loft's edge (whose deck edge is the last riser), board panels on both sides
  with darker stringers, a closed kitchen-facing end and floor underside inside the existing ramp volume, a threshold board and a newel post where it arrives. The kit's stair
  model (a steeper flight with its own 2 m landing, which floated off the loft) is gone.
- **Porch** (the lodge's south face, 3.1 m deep, +0.45, roofed at 3.4 m): 1.0 m rails
  vaultable both ways, open at the front steps and both ends. [west, east (small table and chairs); ≈ 6.0]
- **Lean-to + woodpile** (N): the walk-up route crate step 0.6 → woodpile 1.2 → lean-to roof
  1.8…3.05 → loft door 3.65, every rise 0.6 m (no jump needed). [the woodpile's top; ≈ 1.1]
- **Shed** (NE, 4.5 × 5.5 m): south door, west window. [back, west and east walls; ≈ 5.6]
- **Work yard** (E): the wagon, the chopping block (a fixed stump with the axe in it), barrels,
  sacks, crates, bins. [chopping block, wagon, east storage row, shed front, lean-to front, lodge
  side; ≈ 11.7]
- **Campfire plaza** (S of the lodge): the fire pit with 2–4 logs or stumps round it. [fire, edge; ≈ 5.3]
- **Tent camp** (SW): two tents against the boundary, camp gear, stumps, rocks, bushes. [tent 1,
  tent 2, camp nature; ≈ 6.1]
- **Picnic pavilion** (SE): two picnic tables under a gable roof (nothing between its east posts
  and the boundary: that strip is closed off by them). [chairs at the table ends, edge; ≈ 4.3]
- **Border**: bushes, saplings, rocks, logs and stumps along the south fence and the south-east
  corner, and the open field between the yard and the pavilion. [3 fence stretches, corner,
  field; ≈ 9.1]

101 static colliders in the map (4 boundary, 40 wall pieces, 7 glass panes, 18 furniture, …),
plus the round's decoys. The architecture, furniture, the fireplace, couch, bookshelf, kitchen,
fridge, dining table, bunk bed, picnic tables, wagon, campfire, tents and the chopping block never
move.

## Scene recipes and round layouts (maps/propHuntScenes.ts, maps/propHuntLayout.ts)

The ordinary decoys are never scattered: each corner of the camp is dressed by an authored
**scene**, and a round's layout is a stack of decisions,

    match seed → round → which scenes change → each changed scene's variant → its props

- **Scenes** (30): the dining table, the great room, the kitchen's east and south walls, the
  loft's bunk, north wall, middle and south wall, the porch's west and east ends, the woodpile's
  top, the shed's three walls, the chopping block, the wagon, the yard's storage row, the shed
  front, the lean-to front, the lodge side, the fire ring, the plaza's edge, the two tents, the
  camp's nature, the pavilion's chairs and edge, three stretches of the south fence, the
  south-east corner and the open field. Each owns a few **slots** (a floor, a size, what it backs
  onto, a semantic **context**) and 3–8 **variants**.
- **Variants** are recipes: items (a slot out of a short list, a family out of a short list,
  sometimes only by chance) and picks ("two to four of these seats"). Counts are never fixed:
  the table seats 2–5 (two a side, three on one side, now and then a lone chair pulled back),
  the shed holds 0–5 crates, the fire has 2–4 logs or stumps (plus gear), a fence stretch one to
  three bushes, rocks or saplings. A prop may sit anywhere along its slot's free length (a few
  steps: small natural offsets); a round prop takes any look.
- **Contexts** are the plausibility rules (`CONTEXT_FAMILIES`, with `FAMILY_SETTINGS` as a
  coarser check): living furniture indoors (chair, nightstand, dresser, armchair, side table,
  potted plant, backpack), crates and gear only in indoor corners, firewood by the hearth, a small
  table and chairs on the porch, chairs, gear and a trash can at the pavilion, storage in the shed
  and the yard (crates, barrels, sacks, gas tanks, bins, logs; the chopping stump), camp gear by
  the tents and the fire, nature along the edges. A dresser never stands by the fire, a bush
  never grows indoors, a bin never stands by the bunk bed.
- **No global "anti-cluster" rules**: three chairs at the table, crates side by side in the shed,
  logs round the fire, bushes along the fence are all normal, so a hider joining a group is not
  given away by a count. Only real clipping is refused: overlaps, and a squeeze (an open 0.6–1.15 m
  gap a body could be wedged in) between two tall props or against a wall — measured against the
  walls as they stand at body height (a wall's pieces around a window are one barrier) — and every
  route clearance (`ROUTE_CLEARANCES`: doors inside and out, the stair's foot, approach and top,
  the loft's walks, door and drop gap, the porch's walk, doorway, steps, exits and vault landing,
  the shed door, the crate step and woodpile route, the three spawns).
- **Families in play**: each round draws 15–18 of the 20 families (chairs, crates, logs and stumps
  always: the table, the storage, the fire and the chopping block need them); the others sit the
  round out (none at all), at most two rounds in a row. Every family in play has at least two
  decoys — never the only one of its kind — so a disguise is never "the one odd object". Over 500
  rounds every rotating family is in play in 72–84% of them.
- **Dealing a round** (`deal`, seeded mulberry32): the family pool; the scenes to change (every
  scene holding a family now out of play, then others at random, until they hold about half of
  last round's ordinary props); each changed scene re-dealt (another variant likelier, weighted
  toward what the round still needs — families short of two, the round's drawn total); a
  **repair** pass (a family in play short of two gets a scene that can hold it re-dealt with it;
  one still left with a single prop sits the round out instead: its prop goes); a **fill** pass
  (short of the round's total, a few changed scenes get their variant's optional items). A deal
  is taken if it has 60–68 decoys, every family 0 or 2+ (under its cap: chairs 13, crates 11, logs
  9, stumps 8, backpacks and bushes 6, others 5; the table's chairs and the fire's seats are never
  trimmed by a cap), 15–18 families in play, none out more than two rounds, and a change of
  45–55% (never outside 40–60%); up to 48 deals are tried.
- **Rounds** (`roundLayout(match, round, previous)`): round 0 is dealt fresh from the match
  seed; each later round from the one before it (recomputed from round 0 when not given). The same
  match seed always deals the same sequence: a room server would only send the match seed.
- **Numbers** (500 rounds: 10 matches × 50): 60–68 decoys, mean 63.9; families in play 15–18
  (15: 124, 16: 142, 17: 134, 18: 100 rounds); single-of-a-kind families 0; ordinary props
  changed per round median 50.0% (45.2–55.0%, every round in 45–55%); dining chairs 2–5 (10 / 35 /
  39 / 16%), shed crates 0–5 (3 / 22 / 45 / 24 / 6 / 0.2%), fire seats 2–4 (13 / 51 / 35%), fence
  bushes and rocks 1–10; a deal takes 1.5 ms (median; p95 5.3 ms, worst ≈ 11 ms; a match's first
  deal ≈ 23 ms while the slots' poses are checked and cached).
- `REFERENCE_LAYOUT` keeps the hand-placed V1 decoys as a fixed layout for tests
  (`PropHuntGame`'s `layout` option).

In the game, `applyLayout` removes last round's decoy colliders and adds this round's (decoy i
is `decoyHandles[i]`) at every reset, before the countdown's first physics step brings the
scene queries up to date.

## The result's reveal

When the round is decided, the game records every hider still hidden (`PropHuntGame.reveal`:
who, as what, its prop's bottom-centre or its feet, its turn); a found hider is never in it; it
is empty during the search and cleared at the next reset. For the 5 s of the result the arena
shows each of them: the prop (or the body) outlined in pulsing gold and filled faintly, drawn
through walls and roofs (the round is over), a column of light over it, and a label "Bulunamadı:
Player 2 · Sandalye" kept on screen over it; the result message lists the same lines. The view
turns gently to each of them in turn (2.4 s each) unless the player moves the mouse.

## The periodic whistle

Every `whistle.every` (15) s of the 75 s search — at exactly 60, 45, 30 and 15 s left
(`WHISTLE_TIMES`; none at the start, none at 10 s) — every hider still hidden gets one whistle
due, in slot order 0.6 s apart (one hider left: it alone); it sounds from where the hider is then
— its prop's middle, or its chest — and a hider found before its turn never whistles, then or
later. A round decided earlier stops them; each round starts the schedule again
(`PropHuntGame.whistles` counts each hider's whistles this round). It is a `whistle` game event
only: no cue in the shared sound list (online protocol untouched), no reveal, no marker, nothing
else changes.

The local arena plays it positionally (`scene/prophunt/whistle.ts`, `AudioManager.playSpatial`):
an equal-power PannerNode (left/right only — no HRTF front/back or height cues) with the inverse
distance model from 3 m (≈ −11 dB at 11 m, ≈ −16 dB at 20 m: always audible, never loud from
afar), only 60% of the sound panned and the rest centred, and a 900 Hz low-pass (and −3 dB) when
a wall or roof stands between it and the listener. The listener is the followed player's head,
facing where the camera looks. A rough clue ("upstairs", "the yard", "inside the lodge"),
never the exact prop.

Spawns: the seeker at the plaza's south edge facing north, the hiders just south of the porch,
3 m apart.

## Manual whistle (local taunt)

A living hider can press Q during hiding or search. It emits the same positional whistle
from the disguise’s middle or the body’s chest, with no visual marker. Each hider has a separate
8 s cooldown; a refused local attempt briefly shows “Islık hazır değil”. No movement, disguise,
ammo, timer or automatic schedule changes. Automatic 60/45/30/15 calls never check or consume
this cooldown. Bots never request manual whistles. Found hiders retain Q/E spectator controls.

The shared eight-action binding schema remains intact. This local auxiliary key defaults to Q
and uses the first free key (T, R, Y, …) if Q is already rebound; the compact controls hint shows
the actual key. No saved action is stolen. The manual request is a local `step` argument,
not a network input or protocol field.

## The hunch (proximity.ts)

Searching the right corner could still leave a handful of equally plausible props. When the
seeker is genuinely close to a hider still hidden, it gets one vague pulse:
- **Close** (`PROP_HUNT.proximity`): the hider's prop (its middle) or body within 5.5 m of the
  seeker's pelvis horizontally; their feet within 1.5 m of each other (the loft over the kitchen,
  the lean-to roof over the yard and the halfway stair never count); and in the same space — a
  line from the seeker's head to the hider's top, or from its chest to the hider's middle,
  crosses no architecture (walls, glass, floors, decks, the loft, roofs, the woodpile's bulk,
  tents, the boundary). Furniture, rails, posts, steps, the stair, the fire pit and props never
  stop it, so a crowd of chairs round a table does not make it unreliable. Pure geometry against
  the static map (Cyrus–Beck clipping of two segments, ≈ 0.3–0.8 µs a check; at most two hiders),
  no Rapier query, deterministic.
- **Timing** (`ProximitySense`): 0.9 s close in a row → one `near` event. No repeat while
  nearby, however long the seeker waits. Rearm only after staying horizontally beyond 6.5 m
  of every living hider for 1.25 s continuously, followed by a fresh approach and dwell.
  Walls or floor changes alone cannot rearm it. Two hiders still produce one pulse. Reset every round.
- **What it tells**: `{ type: "near", seeker }` and nothing else — no hider, prop, place,
  direction or distance (a server would send it to the seeker alone). The seeker sees "Yakınlarda biri var..." under the crosshair and an even warm glow round every edge of the screen, both gone
  within 2 s, and hears a soft two-beat heartbeat in the middle of the mix (no panning, no
  distance). No outline, marker, arrow, compass, number or glow on the prop; nothing stays on
  screen (no near/far state).
- Final tuning: trigger 5.5 m / 0.9 s, rearm beyond 6.5 m / 1.25 s.
- **Local option**: the seeker’s Esc menu has “Yakınlık ipucu”, Açık by default. Kapalı
  suppresses text, glow and heartbeat, including a currently playing cue. The simulation and
  latch keep running, so toggling cannot create sonar. Preserved across rounds/role changes,
  reset when leaving this arena; it never changes bot perception or hiders.

## Cameras (src/party-lab/scene/prophunt/propCamera.ts)

| | Seeker (shoulder, default) | Seeker, first person (V) | Hider (and its disguise) |
| --- | --- | --- | --- |
| Boom | 4.8 m | none: the eye, 1.68 m over the feet, 0.12 m ahead of the body's axis | 5.4 m |
| Rest pitch | 22° down (−20°…55°) | 8° down (−60°…65°) | 26° down (6°…60°) |
| FOV (vertical) | 60° | 70° | 62° |
| Shoulder | 0.55 m right | centred | centred |

Camera-relative movement, Pointer Lock (click) or drag look, the other modes' sensitivity. The
boom is pulled in by a sphere cast against the walls, props, roofs and ceilings (roof and gable
space are camera-only solids); under a low ceiling it first flattens, then shortens; it eases
back out over 0.3 s. A disguise's orbit pivot sits over the prop (low for a small one). The own
body or prop fades when the boom is shorter than 1.3 m.

**The seeker's first person** (`propFirstPersonPose`): V swaps views (unless V is bound to an
action; a held V swaps once; ignored while the Esc menu is open), and the Esc menu has the same
choice ("Kamera": Omuz üstü / Birinci şahıs) for the seeker only. Pointer Lock is untouched by
the swap. The choice lasts the arena visit (every round, and a role change and back); leaving the
arena resets it to the shoulder camera. The eye follows the body's own height (smoothed over
0.05 s: a jump lifts it, walking does not bob it) and never enters a wall, window, roof or prop:
the segment from the chest to the eye is swept with a 0.12 m sphere and the eye stops short
(pulled in at < 3% of standing spots and views). The local seeker's head, chest, pelvis, arms
and hands are not drawn (the camera is inside the head; looking down shows only the legs); nobody
else's body changes. The blaster becomes a view model low on the right (scale 0.42), drawn last
over a cleared depth buffer so a wall in front of the camera never cuts into it; the tracer
leaves its muzzle. The recoil kick is halved. Back to the shoulder, the boom eases out from 0.8 m.

## Bots (src/party-lab/scene/prophunt/bots.ts)

Navigation is Bomba Sende's grid (`BombNav`, 0.5 m cells, one node per standable surface) built
from this map. It now refuses jumps and drops through a wall or a pane (the Bomba Sende graph is
unchanged, hash-identical).

Bots use the round's layout only: `layoutNav(layout)` is the static camp grid with that
layout's decoys masked out (and a small extra cost on climb-only surfaces — the crate step, the
woodpile, the lean-to roof — so bots take the stair unless climbing saves a lot), and
`hideSpots(layout)` its hide spots; both are cached with the layout. A bot never keeps a spot,
a route or a memory from another layout, and the hider team's claims start over with each one.
A walker pushing against something for 1.2 s now always unsticks (a random step and a jump:
the V1 check read the input after it had been cleared, so it never fired).

**Hider bot**: hide spots come from this round's layout only (families in play, this round's
props): the same family's shape beside a decoy, touching it, and — preferred a little — an
**empty recipe spot**, where the camp's recipes put that kind of prop but this round did not,
with one of that kind the nearest prop to copy there, facing the same way (the empty seat at
the table, the gap in the shed's crate row). All on the same floor, clear of every prop, out of
the walkways in `KEEP_CLEAR` and the route clearances. Each zone offers its best spot
(structures, a recipe spot, blending with same-kind decoys and distance from the seeker score
up; plain view of the seeker's release point and the plaza score down), then a zone is drawn
with the better ones likelier (bot-vs-bot: lodge 29%, shed 23%, porch 18%, loft 11%, pavilion
10%, yard 6%, the rest 3%). It runs there, stops, and presses E like a player (the same reach and
sight rules). It keeps still; rarely, with the seeker far and out of sight, it slides to another
spot of its family. The two hiders never take spots within 3 m of each other, and their claims
start over every round.

**Seeker bot**: no omniscience, and no knowledge of the round's layout. It sees what a player
would — props (decoys and disguises alike: a kind of prop at a place) and bodies in a 0.85 rad
half-cone to 15 m with a clear line — and knows only what a regular could:
- the camp's logic: which spots the recipes put each kind of prop in (static, the same every
  round) and where a kind is plausible at all; the landmark chopping block;
- what it saw itself in earlier rounds of the match (kind and place, kept 2 rounds) — wrong as
  often as the layout moved on: a disguise where a prop of its kind stood last round looks
  familiar;
- what it sees this round: movement, the whistles, and its own hunch.
A prop's first impression: familiar (seen there last round: paranoia only); on a spot where its
kind belongs (no evidence by itself: noticed slowly, capped at 0.7 — a guess it only risks late
with shots to spare); off every such spot (noticed at the full rate); a kind the camp never puts
there (×3). A corner mostly just as it was last round but for one unfamiliar prop makes that
one "the odd one out" (full rate, uncapped: "was this here before?"). Suspicion is slower far
away and among same-kind props it has seen; a prop seen moving jumps to suspicion at once;
props near where it heard a whistle (±2.5 m, the floor right 70% of the time) get +0.45. A hunch
(the game's `near` event, the only thing it gets: never who or where) makes the props it has seen,
or sees in the next 6 s, on its floor within 3.8 m of where it stood suspects (+0.35 each, once per
hunch, beyond their caps), and it turns once all the way round (2.8 s) where it stands. It
never asks the game who is close (`hiderNear()` and the proximity geometry are not used by it). It
patrols 15 viewpoints (least recently checked first, a structure's viewpoint 8 points ahead,
half a point per metre of walk), inspects evidence first (a usual-spot prop only when nothing
else is suspicious) from ≈ 4 m, and shoots at suspicion 1.0, 0.6 in the last 22 s with at least
5 shots more than hiders left, and only at 1.6 with 2 or fewer to spare (an empty gun with a
hider hidden loses the round), with a small distance-scaled aim error.

Bot-vs-bot, 20 matches × 10 consecutive rounds (the same seeds each time):

| | Seeker wins | Finds | Shots (on decoys) | Search ends | Lost on an empty gun |
| --- | --- | --- | --- | --- | --- |
| One whistle at 10 s (the readability pass) | 9.5% | 0.74 | 9.4 (7.2) | 73.6 s | 0 |
| Whistles at 60/45/30/15 s, the bot ignoring its hunch | 37.5% | 1.23 | 9.1 (5.8) | 64.7 s | 4 of 200 |
| Whistles and the hunch (now) | 47% | 1.37 | 9.5 (5.4) | 59.2 s | 6 of 200 |

Now by round: round 1 25% (1.10 finds), rounds 2–4 50% (1.37), rounds 5+ 49% (1.42); the hunch
fires ≈ 1.8 times a round. 200 single rounds (a fresh seeker every round, no memory of earlier rounds): 31.5% (was 6.5%), 1.18 finds, 10.6 shots (6.9 on decoys), the search ends at 66.9 s. 0 physics faults; ≈ 0.06 ms per tick for the game and
all three bots (the hunch's check: under 1 µs). The whistles do most of it (four clues a round
instead of one late one); the hunch adds the last step, the choice between the few props close
by.

## HUD (immersive arena, Esc menu)

- Player cards with a role badge (ARAYAN / SAKLANAN) and a status: the seeker "Gözleri
  kapalı" / "Arıyor", hiders "Saklanıyor" / "Bulundu" (never a hint of where).
- Phase chip (Saklanma / Arama), the time left and a bar; a line for the role.
- Seeker: crosshair (a red X when the body's line is blocked), 15 ammo pips (3 rows of 5)
  "10/15", "Yeniden doldurma yok" / "Mermi bitti", hiders left; a black blindfold with the
  countdown while the hiders hide; the hunch ("Yakında biri var…" and an even edge glow, gone
  within 2 s); the controls line names V ("V kamera").
- Hider: "Kılık: Sandık" chip and the E prompt ("E: Sandık ol" when a decoy is in reach, a ring
  under it; "E: kılıktan çık" when disguised).
- Big calls ("BULUNDU!", "Boş!", "ARA!", "MERMİN BİTTİ!"), countdown, found and result messages
  (why the round ended — "Mermin bitti!" / "Arayanın mermisi bitti!" when the last shot is spent —
  and a "Bulunamadı: Player 2 · Sandalye" line per hider still hidden); the result's labels over
  them; found hiders spectate (Q / E switch).
- Debug only with `?propDebug=1`: the readout (and `data-prop` JSON for scripts) — including the
  round's layout (round, seed, id, decoy count, families in play, share changed since the last
  round, each scene's variant), the reveal, what the local seeker's crosshair would hit, each
  hider's whistles this round, the hunches felt (and rearm state), the camera view, its
  position and FOV, and whether the own head is drawn — H holds the bots, K skips the phase, G toggles the scenery
  and the decoys. Normal play shows none of it.

## Assets

`public/party-lab/maps/prop-hunt/prop-hunt-kit.glb` (1.62 MB, ≈ 0.6 MB gzipped): 56 nodes,
29.1k triangles, vertex colours only (one material, metalness 0, no textures), bottom-centre
pivots; the 20 transformable families are fitted to their gameplay shapes. Built from CC0
Quaternius packs (Medieval Village MegaKit, Stylized Nature MegaKit, Ultimate House Interior,
Survival, and the Barn's Medieval Village Pack barrel, bags and bench) by
`scripts/build-party-lab-prop-hunt-kit.mjs`; the raw packs stay outside the repository. See
`CREDITS.txt`. Shells (lodge, porch, loft, the stair, lean-to, shed, pavilion, ground, paths) are
generated in code (`scene/prophunt/arena.ts`); kit windows, door frames, shutters and railings
are decoration only. The round's decoys are one merged mesh of their own, rebuilt (a few ms)
when a layout is dealt; the kit's `Stair` node is no longer drawn (the next kit rebuild can
drop it).

## Performance (headed Chrome, Apple GPU, 1440×900 and 1366×768)

60 FPS (vsync). JS ≈ 1.9 ms per frame (p95 ≤ 3.0), GPU ≈ 1.6–1.9 ms per frame (timer query),
14–35 draw calls depending on the view, ≈ 150–165k triangles drawn (forest ≈ 71k), 101 static
colliders plus the round's 60–68 decoys, 0.4 ms per simulation step in the browser. A round
change (dealing ≈ 1.5 ms, the decoy mesh, the camera's solids, the bots' grid) no longer shows as
a long frame: the longest frame around a forced round change was 17.7 ms (it was 33–50 ms).
First person at the same spot in the lodge: 18 draw calls and ≈ 154k triangles (the shoulder
camera: 25 and ≈ 159k), frame p95 17.6 ms at 1440×900 and 18.2 ms at 1366×768 with vsync, the
same as the shoulder camera.

## Going online later (not done)

A `PropRoundSimulation` wrapping `PropHuntGame` (as `BombRoundSimulation` wraps the Bomba
Sende game), a protocol bump, lobby entry and Mixed membership. Snapshot needs: roles, phase,
ammo, per-hider disguise (family, position, yaw) or body, found flags, the match seed and the
round index (clients deal the same layouts from them: `roundLayout` is pure and chains from
round 0 — or send the round's layout), the result's reveal; the whistle is a confirmed event
with its position; the hunch is a server-side check whose `near` event goes to the seeker alone
(never who or where). The first-person camera needs nothing new: the seeker's input already
carries the aim-line point (bounded near the shoulder), and the shot is the same. The seeker's shot is
server-side hitscan; the disguise controller is deterministic but kinematic, so hiders predict
their own prop locally like a body.
