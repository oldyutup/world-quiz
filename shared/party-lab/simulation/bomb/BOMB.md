# Bomba Sende (local and online)

A fast hot-potato chase for 2–3 players (local: 1 human + 1–2 bots). One bomb, one fuse.
Whoever holds it when the fuse runs out blows up. The last one standing wins.

Protocol 8 adds the server-owned `BombRoundSimulation`, lobby entry and five-mode Mixed rotation.
Rooftop, Barn, Katman Kaosu and Renk Kaosu are unchanged (seeded simulation
hashes of all of them, local and online, match HEAD).

## Rules

| Rule | Value |
| --- | --- |
| Players | 2 or 3 (Esc menu: "Oyuncu") |
| Countdown | 3 s, bodies frozen. The first carrier is picked at random and shown (an unlit bomb) |
| Fuse | 14 s, lit on the first playing tick |
| Passing | The carrier's punch (F) passes the bomb: the **tag** below, in any direction, or a real hand contact under the same rules |
| Tag | While the carrier's punch swings (0.35 s): the nearest rival within 1.30 m (pelvis to pelvis, horizontal) **on any side — no facing rule**, on the same surface (≤ 0.65 m apart) with pelvises ≤ 1.0 m apart, and with clear pelvis and chest lines through the arena's colliders |
| Slow traps | Three on the plaza ring. A foot on an armed one springs it on anyone (carrier or not): 0.50× speed for 1.0 s, no damage, no hold, jumping still works. Shut for 7.0 s, then armed again |
| Fuse on a pass | **Carries over: no reset, no refill.** The bomb keeps burning on the new carrier |
| Tag-back | The one who just passed it can't be tagged back for 1 s. The third player can be tagged at once |
| Receiver | Shoved about 0.8 m and staggered 0.35 s (slow, no jump): the passer's escape window |
| Carrier speed | ×1.15 while the fuse burns, walking and sprinting (never while staggered): 4.68 → 5.37 m/s walking, 6.52 → 7.49 m/s sprinting |
| Blast | At 0 the carrier is out. Everyone within 3 m is shoved away (4 m/s, a small hop) and staggered 0.5 s |
| After a blast | With 2+ players left, the next carrier (a random survivor) is shown at once; the new 14 s fuse lights 2.5 s later |
| Win | Last one standing. The last two out on the same tick is a draw |
| Round length | Fixed: 2 players 14 s, 3 players 30.5 s (two fuses and the gap). The 45 s cap is only a safety net |
| Falls | None possible (walled). A carrier who somehow left would hand the bomb on as after a blast |

Why the fuse carries over: it's the simplest rule to read (one timer, always counting
down), and it makes the last-second pass the whole game. A refill would stretch rounds and
blunt the panic. The 1 s tag-back rule stops instant ping-pong; the 2.5 s gap gives everyone
a head start from the next carrier, the same as the countdown does for the first.

Every landed punch shoves and staggers (Katman Kaosu's values, Bomba Sende's own tuning
object). A player without the bomb can punch the carrier away but never passes anything.
Sprint (Shift) is the shared ×1.4. No grab, lift, HP or knockout.

### The tag (Bomba Sende only)

Manual play found exact ragdoll-hand contact too demanding for passing the bomb, and then
aiming the ragdoll at a rival too. So in this mode F means "hand the bomb to whoever is
right next to me", in front, beside or behind.
- It is checked only while the carrier's punch swings (wind-up and active: 0.35 s), which is
  the existing punch animation and cooldown (0.6 s). Everyone within 1.30 m is a candidate;
  the nearest valid one takes it.
- Distance comes first. Only a rival already that close gets two static-geometry rays
  (pelvis line, chest line).
- The pelvis line stops a tag over a hop wall, AC unit or crate; the chest line stops one
  through a pocket wall; the surface rule stops floor ↔ catwalk or AC top.
- 1.30 m pelvis to pelvis leaves about half a metre between two bodies: a hand-off, never a
  throw. (The first tuning pass used 1.35 m with a 100° cone round the facing; the cone is
  gone, and the range came down a little with it.)
- A real hand contact passes under exactly the same rules, range included: a swing that
  reaches someone 1.4 m away shoves them but never hands the bomb on.
- The bomb arcs from the passer's head to the receiver's (0.16 s), so a tag behind you reads
  as a hand-off, not a teleport.
- It applies to every carrier, bots included, with the same rules.
- Katman Kaosu and Renk Kaosu have no tag, and their punch tuning is unchanged.

### Slow traps (Bomba Sende only)

Three flat traps (`BOMB_TRAPS`, maps/bomb.ts; `BombTraps`, traps.ts) put a little risk
into the open middle. They are the Barn's bear-trap model on Bomba Sende's own rules; the
Barn's damage, hold and 10 s rearm are not used (and are unchanged there).
- A foot at floor level within 0.45 m of an armed trap springs it, on anyone: carrier or
  runner, lit fuse or gap. The lowest slot springs first on a shared tick.
- The one caught moves at 0.50× their speed for exactly 1.0 s: walking 4.68 → 2.38,
  sprinting 6.52 → 3.30, a sprinting carrier 7.49 → 3.78 m/s (the drive's mobility, times
  the carrier's ×1.15). Half the speed goes at the snap, so it bites on the spot. No damage,
  no stagger, no hold; jumping still works and doesn't beat it (jump-spamming measured 0.50×).
  A sprinter loses about 3.2 m, a sprinting carrier about 3.7 m.
- The trap is shut for 7.0 s, then armed again (a player still on it then gets caught).
  While slowed, a player passes over another armed trap without springing it.
- Jumping over an armed trap clears it (taking off 1.2–2.1 m before it, walking or
  sprinting).
- A trap never passes, takes or burns the bomb.
- Sound: the Barn's trap snap (`trapSnap`, no new sound name), with the camera knock for the
  one caught.
- Look: a dark round mat with a yellow-and-black rim (0.60–0.74 m, bigger than where a foot
  springs it). Armed: open jaws and a soft pulsing glow on the rim. Sprung: the jaws snap
  shut with a jolt and dim; a white arc fills the rim over the 7 s; the jaws reopen in the
  last 0.3 s (open jaws are always armed), and the rim flashes when it is live again. The
  one caught wears an amber ring outside the carrier's red one, its arc the slow left, and
  the local player sees "TUZAK! Yavaşladın".

`BombRules` (rules.ts) is pure state in whole ticks: phase, carrier, fuse, immune,
immuneTicks, gapLeft. `BombTraps` (traps.ts) is too: armed, rearmIn per trap, slowed per
slot. `BombTagGame` (game.ts) drives both with the shared ragdoll physics, the shove punch
and Katman Kaosu's round, and is deterministic for a seed and inputs.

One playing step (round tick t):
1. The bomb: it lights on t = 0 and burns one tick. A blast retires the carrier and shoves
   everyone near, before physics.
2. The traps: shut ones count down and reopen, slows count down, then feet on an armed
   trap spring it (the snap takes half the victim's speed).
3. Punches and drives (the lit bomb's carrier gets mobility ×1.15; a slowed player ×0.5 of
   whatever they have).
4. Physics.
5. Punch contacts: the carrier's first landed punch passes the bomb (same rules as the tag).
   Failing that, while its punch swings, the tag (`tagPick`, any direction) passes it to the
   nearest valid rival, with the same shove and stagger, and spends the punch. A tag-back
   refusal is reported once per swing as `refused`, which is what shows "Geri pas yok!".
6. Eliminations decide the round.

## Map: "Oyun Parkı" (maps/bomb.ts)

A 20 × 20 m rooftop playground: x, z −10…10, floor at y 0. It is symmetric under a half turn
(x, z → −x, −z). The perimeter is a 1 m brick parapet with a glass guard up to 3.2 m. It is
one solid collider and stands ≥ 2 m above every standable top, so nobody can fall.

| Feature | Where (twin) | Size | Role |
| --- | --- | --- | --- |
| Open plaza | middle | ≈ 12 × 10 m, painted ring | the chase |
| L-wall pocket | NW (SE) | 2.0 m walls, legs 2.8 + 2.4 m | hiding corner; two 2 m exits along the walls |
| AC units | NE (crates SW) | 1.1 m, 2.4 × 1.0 and 2.5 × 1.4 m | juke corner (no hiding): two walking exits, plus hopping the front unit or jumping onto the back one |
| Catwalk | N (S) wall | 1.0 m deck, 6.6 × 1.8 m, 24° ramp at its W (E) end | high lane; jump on or drop off anywhere along its open side |
| Jump shortcut | catwalk end → AC unit (crate) top | 1.5 m gap at 1.0 → 1.1 m | a walking jump lands on the 2.5 m top; back up the same way |
| Hop wall | E (W) | 0.9 m, 6 m long | walk round either end or hop straight over |
| Slow traps | on the plaza ring: S (−0.25, 2.85), NW (−2.45, −1.45), E (2.85, −0.15) | flat, 0.74 m mats | risk in the middle; the only feature without a twin |

The traps make a loose triangle ≈ 2.85 m from the middle, each in a gap between the spawns
(angles 95°, 210°, 357°; ≥ 2.9 m from every spawn), 4.3–5.5 m apart, so there are lanes
between them. Every one is ≥ 3 m from walls, ramps, catwalks, hop walls, AC units and crates
(so off every landing) and ≥ 6 m from the pocket exits and jump shortcuts. With all three
treated as walls (0.9 m round each), nothing is cut off and no route between spawns or
corners gets more than 11% longer (tested at ≤ 15%).

Heights come from measuring the real ragdoll (scratch harness, then `bomb.test.ts`):
- A walker steps ≤ 0.65 m.
- Running jumps onto ledges: 1.0–1.1 m in 19 of 26 take-off distances, 1.3 m in 13–15.
- Hop over walls: ≤ 0.9 m in 23 of 26 take-off distances.
- Gaps at 1 m height: 1.5 m in 34–36 of 37 take-offs.
- Nothing ≥ 1.5 m above the surface in front of it is crossed (Rooftop's audit).

Walking speed is 4.68 m/s and sprint 6.52 m/s (a carrier: 5.37 / 7.49).

The tests drive the real ragdoll over all of it:
- the ramp;
- jumping onto a catwalk;
- both hop walls, both ways;
- both jump shortcuts, both ways;
- jump-spamming at a pocket wall;
- jump-spamming at the perimeter from every raised surface.

Spawns: three on a 5 m circle round the middle, 120° apart (8.7 m apart); two on opposite
sides (9.2 m apart).

## Bots (src/party-lab/scene/bomb/bots.ts, nav.ts)

Navigation is a 0.5 m grid built once from the colliders: a node per standable surface per
cell (floor, tops, ramp slope), 1,256 nodes built in ~50 ms. Its edges are:
- walk: up to 0.35 m per cell;
- jump: onto a top up to 1.15 m;
- drop: off a top;
- hop: over a blocker ≤ 1 m;
- leap: across a gap to a top at about the same height (the shortcuts).

There are no hand-placed waypoints. Dijkstra takes about 1 ms.

The state machine, reading only what a player sees:
- **chase** (lit bomb): the nearest rival by path distance, skipping one that is protected.
  Once close and in the open it goes straight at them with a little lead; otherwise it
  follows the route. It sprints and punches (tags) when a rival is in reach on any side
  (about 75% of chances).
- **stalk** (next carrier, fuse not lit): walks toward the nearest rival and waits about
  2 m off.
- **flee**: every ~0.3 s it picks a spot it reaches ≥ 1.5 m of path before the carrier
  (who is 15% faster), scored by the carrier's path distance (capped), its own distance,
  open ground and a bonus for its current spot. So it loops round cover instead of
  running into walls. It sprints while the carrier is near, sidesteps now and then when
  the carrier closes in, and sometimes shoves a carrier right in front of it.
- It takes jumps where its route needs them (a walking jump for the gap shortcuts) and
  unsticks itself (a random step and a jump) after 1.2 s without progress. Pressed against a
  hop wall it jumps (the far side can be 1.5 m off); before, it could stand there until the
  unstick move.
- It needs 0.2–0.45 s to react when the bomb changes hands.
- **Traps** (`TRAP` in bots.ts): it sees which traps are armed or shut, never when a shut one
  will reopen. Routes pay 1 m extra per grid node within 0.95 m of an armed trap (so they go
  round unless that is clearly longer), a flee spot is never on one, and a straight run (the
  close chase, string-pulling a route) doesn't cut across one — unless it is urgent: the
  rival within 2 m, or under 2 s on the fuse. A runner with the lit bomb within 3 m forgets
  the traps for half its route decisions (panic). So a carrier bot runs straight over a trap
  its rival stands just behind (1.9 m: 24/24 in the simulation), but from 2.5–4.5 m it goes
  round (1 spring in 72) and still tags.

Bot-only Monte Carlo (80 rounds each), with ×1.15, the 360° tag and the traps (the first
tuning pass, 100° cone and no traps, in brackets):

| Players | Passes per fuse | First carrier blows up first | Last-second passes (< 1 s) | Wins | Trap springs |
| --- | --- | --- | --- | --- | --- |
| 2 | 7.8 (7.2) | 49% (fair: 50%) | 46 in 80 fuses | 41 / 39 | 0.2 per round (11 carrier, 7 runner) |
| 3 | 5.5 (5.0) | 34% (fair: 33%) | 72 in 160 fuses | 25 / 32 / 23 | 0.4 per round (15 carrier, 16 runner, 2 in the gap) |

Trap-blind bots would have sprung 0.5 (2p) and 2.4 (3p) per round: they go round most of
them, not all. Bots spend only 10–14% of their time within 4.5 m of the middle (they flee to
open corners), which is why bot-only rounds meet the traps rarely. Both: 0 physics faults,
0 falls, about 0.1 unstick moves per bot per round.

Keyboard-driven carrier in headed Chrome (real WASD / Shift / Space / F keys, routing on the
same grid as the bots, 1 human + 2 bots, the nearest bot starting 3–6 m away), 12 open-play
chases plus 7 set-ups (both pockets, AC corner, crates, catwalk, shortcut, a 1.9 s fuse):

| | ×1.10, no assist | ×1.15 + assist |
| --- | --- | --- |
| Open-play chases tagged | 11/12, mean 3.7 s | 12/12, mean 2.7 s |
| F presses per tag | ≈ 3 (up to 11) | 1 |
| Distance at the pass | 0.45–1.13 m | 0.58–1.35 m |
| Last-second tag (1.9 s fuse) | blew up | tagged with 0.08 s left |

With the bots held still (debug H), a real F press through the pocket wall, round the AC or
crate corner, over a hop wall, from the floor up to the catwalk, or from 1.7 m away never
passed; going round, over or up and pressing again did.

**360° tag and traps (second tuning pass),** headed Chrome, 1 human (real keys only) + 2
bots, scenarios set up through `?bombDebug`:

| Case | Result |
| --- | --- |
| One F press, bots held: rival 1.0 m beside (left, right), behind, in front; 1.25 m behind | 5/5 passed (reach 1.00–1.26 m) |
| Rival 1.45 m in front, 1.5 m behind | no pass |
| Three close: 1.2 m in front, 0.9 m behind | the one behind took it |
| Beside the NW pocket wall (along it, inside the pocket) | passed |
| Through the pocket wall, over a hop wall, round the AC corner, floor → catwalk | no pass |
| Human carrier walks over a trap | caught, slowed, keeps the bomb, "TUZAK! Yavaşladın" |
| Runner bot caught by a trap, human carrier 3.2 m off (6 set-ups) vs the same with it shut | tagged 6/6 in 0.98 s mean vs 6/6 in 2.3 s |
| Runner caught, 1.6 s on the fuse | tagged with 0.82–0.88 s left |
| Carrier starts on a trap, 3.0 s on the fuse, runner 2.3 m off | passed with 0.95 s left |
| Open chases from the middle, all traps armed, the human routing round them (10) | 10/10 tagged, mean 2.2 s (9/10, 1.8 s in a first run); human carrier caught by a trap 2 times in 20 |
| Bait: human standing 1.1 m past a trap, carrier bot 1.9 m off across it | the bot ran over the trap 3/3 (from 3.0 m it went round 3/3) |
| Bait on the move: human runs past a trap with the carrier bot 1.9 m behind (12 each) | armed: bot caught 1/12, human escaped 4 s 2/12; shut: 0/12 escaped |

So the tag reads as a hand-off: every pass was ≤ 1.29 m, bodies next to each other. The
traps clearly help the carrier (a caught runner is tagged in under half the time). A human
can bait a bot, but with the carrier ×1.15 faster a caught bot only buys about 1.5 m net,
so escaping it still needs cover (the pocket, a hop wall) as well.

## Camera (src/party-lab/scene/bomb/bombCamera.ts)

A third-person chase camera, centred on the character:
- Boom 6.4 m, looking 30° down (orbit 20–50°), FOV 60°. That is a little farther and
  higher than Katman Kaosu's (5.6 m) so the arena reads round the player.
- Mouse or trackpad orbit through Pointer Lock or drag (the shared look controller).
  WASD is camera-relative, and the body turns toward where it walks.
- Sprinting eases the view out by up to 0.7 m and +3° FOV (0.6 s ease).
- The pivot rides at standing height over the surface last stood on and follows only 20%
  of a jump.
- Collision is a sphere cast against every collider, with the perimeter cut to its brick
  (the glass is see-through). Pulling in is immediate; easing out takes 0.35 s. A short
  boom fades the character.
- From every standable spot × 8 yaws the camera is never inside geometry, and the boom is
  under 3 m in fewer than 5% of samples (tested).

## HUD (immersive, Esc menu)

- **Player cards:** "BOMBA" (lit) or "Sıradaki" (next), "Korumalı", "Oyunda",
  "Patladı".
- **Bomb chip (top centre):** carrier ("Bomba sende!" on red when it's you), fuse timer
  d.d and bar. The timer turns red and pulses in the last 3 s. In the gap it shows who is
  next and the time until the new fuse.
- **Callouts:** "BOMBA SENDE!", "KURTULDUN!", "KAÇ!", "BOOM!", and small ones:
  "Geri pas yok!" and "TUZAK! Yavaşladın" (amber).
- **Off-screen pointer:** toward the carrier, or toward the nearest rival when you hold
  the bomb.
- **Red screen edge** while you hold it, faster in the last seconds.
- **Messages:** countdown (who has the bomb), "Patladın!" with the spectate label (Q/E),
  and results (winner, passes, time).
- **In the world:** the bomb over the carrier's head (the kit's model, a spark at the
  fuse, red glow and a swell in the last 3 s; on a pass it arcs over to the receiver in
  0.16 s), a red ring at the carrier's feet, a white ring on the protected player, an amber
  ring (its arc: the slow left) on a trapped player, the traps (see above), contact shadows,
  and the blast (a flash, a shock ring, a scorch mark; the body flies up).
- **Debug:** only with `?bombDebug=1`. The readout opens, and the Esc menu offers the debug
  toggle. Keys: P autopilot, K fuse −5 s, B take the lit bomb, H hold the bots still (to try the tag
  range and geometry by hand), G hide the kit props (a debug key that is also bound to a game
  action does nothing).
  Scripts read `data-bomb` on `.pl-bomb-debug` (traps: `[armed, seconds to rearm]` each,
  `slowed` seconds per slot, `trapLog` springs by carrier/runner).

## Assets

- **Gameplay geometry:** generated from the map data (arena.ts). One vertex-coloured Lambert
  mesh plus one transparent glass mesh, 2.1k triangles (the trap mats included), no textures.
- **Props:** `public/party-lab/maps/bomb/bomb-kit.glb` (125 KB, 3,478 triangles), built by
  `scripts/build-party-lab-bomb-kit.mjs` from the CC0 packs:
  - Quaternius Platformer Game Kit: `Bomb` (the carrier's bomb), `Cube_Crate` (the SW
    crates, stretched over their colliders), `Cloud_1–3` (far out, ≥ 28 m).
  - Kenney Nature Kit: `pot_large`, `plant_bushDetailed`, `flower_yellowA`,
    `flower_purpleA` (low planters on the roof ledge, outside the glass, ≤ 1.4 m).
  - Quaternius Toon Shooter Game Kit: `Bear Trap` (the traps' jaws, 0.79 × 0.93 m, 608
    triangles: the Barn's model, two-toned steel), read from the Barn's asset folder.
- The props are merged into two meshes; the traps are one instanced mesh (they move). Until
  the kit loads (or if it fails), plain boxes stand where the crates are and a simple steel
  ring stands in for each trap (the mats are part of the arena mesh, so a trap is never
  invisible).
- The AC units, parapet, glass, catwalks, ramps and hop walls are procedural. Kenney
  Platformer Kit and the Quaternius Ultimate Nature Pack were not needed.

## Going online later

The bomb is one small, fully server-decided state. A snapshot section would be carrier
(int8), phase (1 bit), fuse ticks (uint16), immune + immuneTicks (int8 + uint8): 5–6 bytes.
The traps add armed + rearm ticks per trap (3 × uint16) and slow ticks per slot (3 × uint8):
9 bytes. Passes, blasts and springs (`trapSnap`, as in the Barn) would arrive as feedback
events. A predicting client has to apply the slow (×0.5 mobility) from the snapshot as it
does the stagger. The input packet is the shared
shove-mode one (move, jump, sprint, punch), so Katman Kaosu's prediction block and rig
could be reused with the static map (no tile colliders).

Only the server decides passes. A predicting client may see its own punch land and must
wait for the snapshot to show the bomb move, as Katman Kaosu does with shoves today.
