# Barn Shootout combat

The rules are shared simulation: the local test arena and the online room server
(`simulation/barnRound.ts`, [BARN_ONLINE.md](../../BARN_ONLINE.md)) run the same
`BarnCombat`. The per-fighter parts (`tickFighter`, `startAttack`, `fighterDrive`) are
also what the client's prediction rig runs for its own fighter. Rooftop combat
(`simulation/combat.ts`, `combatConfig.ts`) is not used or changed.

## Architecture

| File | Role |
| --- | --- |
| `config.ts` | `BARN_COMBAT`: every tuning value below |
| `weapons.ts` | Disposable weapons: ammo, fire timing, falloff, pellet/round directions (pure) |
| `aim.ts` | Aim geometry (pure; also imported by the client session without Rapier) |
| `hitscan.ts` | Aim line and hitscan against the Rapier world (static geometry blocks, living parts are hit); online, characters from a historical view |
| `rewind.ts` | Lag compensation: per-tick hit-volume history and analytic ray/capsule tests (server) |
| `pickups.ts` | `PickupDirector`: active weapons, replacement timing and spot choice (pure) |
| `traps.ts` | Bear trap state and foot test (pure plus a read of the feet) |
| `combat.ts` | `BarnCombat`: health, attacks, damage, knockback, traps, pickups, death, respawn, drives |

Per fixed step `LocalRoundSimulation` (option `barnCombat`) calls
`barn.step(inputs, dt)` → `physics.step(effectiveInputs, drives)` → `barn.afterStep()`.
`step` resolves timers, respawns, traps, pickups and shots against the poses the
players saw. `afterStep` resolves punches from real hand contact, the rooftop's rule.
Presentation reads `shots`, `hits` and `notices` after each step. Nothing in React
state decides an outcome.

Input is intent only (`MovementInput`): `attack` (pressed), `attackHeld`, `pickup`
(pressed), `facing` (aim yaw), `aimPitch`, and `aimEye`. `aimEye` is a point on the
camera's crosshair line relative to the pelvis, clamped to 1.5 m from the reconstructed
shoulder point. There is no "I hit X" input. The simulation casts the crosshair line to
find the aim point, then fires from the shooter's torso toward it. Cover in front of the
body therefore stops the shot even when the camera sees past it; the crosshair turns into
a red X when that happens. The shot heads for the aim point even point-blank. It falls
back to the look direction only when the point is inside the shooter (< 0.35 m) or
behind them. The shooter and dead bodies are skipped by every ray.

## Rules and values

- **Health** 100, no regeneration, no pickups. Spawn protection 1 s (no damage, no
  traps), ended early by picking up or attacking.
- **No reload.** Weapons are power-ups. The last round removes the weapon and the owner is
  unarmed again. Picking up while armed swaps: the old weapon is destroyed, never dropped.
- **Shotgun**: 1 shell, 8 pellets × 15 HP (120 max). Cone half-angle 5.5°: one pellet
  near the centre and 7 on a ring at 55–100 % of the cone. Full damage to 4 m, linear to
  20 % at 12 m, then to 0 at 14 m (the ray range). Knockback is whole-body Δv of
  0.9 m/s per landed pellet × falloff, capped at 7 m/s, 25 % of it upward. Three or more
  pellets stagger for 0.3 s (posture 0.6, mobility 0.25).
- **SMG**: 10 rounds, held for automatic fire at an interval of 0.105 s (≈ 9.5 rounds/s;
  the remainder carries while held, nothing is banked while released). 14 HP per round to
  22 m, linear to 50 % at 35 m, nothing past 40 m. Spread 1.2° plus 0.45° per held round,
  capped at 3.2°, recovering 10°/s. Knockback 0.3 m/s whole-body plus 0.08 N·s at the
  struck part: a wobble. So 7 hits = 98 (2 HP left) and 8 hits kill.
- **Punch** (unarmed): the rooftop's physical arm strike (same timing and contact test),
  one at a time on a 0.5 s cooldown, alternating hands. 12 HP per landed hit (9 kill),
  1.2 m/s whole-body push plus a 0.15 m/s lift, 0.15 s mild stagger. No knockout meter.
- **Bear trap**: a foot within 0.45 m of an armed trap at floor level. 25 HP; 1.1 s held
  (no walking, sprinting or jumping; aiming and attacking still work). 85 % of the
  horizontal speed is removed at the snap so a runner stops on the trap. 0.2 s stagger
  (posture 0.75), rearm after 10 s. Spawn-protected and dead players never trigger it.
- **Death** at HP ≤ 0: the weapon is removed at once and the drive goes to full ragdoll
  (posture 0). The body stays in the world but is not a target. It cannot attack, pick up
  or trigger traps. Respawn after 2 s.
- **Respawn**: candidates ≥ 6 m from every living enemy when any exist. Then the best
  score: distance to the nearest living enemy (≤ 25 m), −10 per enemy with a chest line
  to the spot, −2/m inside 3 m of an active weapon, −3/m inside 2.5 m of an armed trap,
  −6 for the spot this player last used, plus 0–2 m of randomness. Never fails (the best
  imperfect spot is used). Full health, unarmed, 1 s protection, facing the spot's yaw.
- **Kill credit**: weapons and punches credit the attacker; a trap or physics-fault death
  credits the last other player who damaged the victim within 3 s, else nobody.
- **Idle anchor**: standing still, the controller steers back toward where the body came
  to rest (`CharacterDrive.anchor`, barn only): idle drift 2.2 m (0.85 m armed) per 30 s
  → < 0.01 m. Walking, sprinting, knockback slides and stops are unchanged (it only
  engages below 0.3 m/s); the rooftop never sets it.
- **Pickups**: E / right click, the nearest active pickup within 1.1 m (horizontal) and
  1 m of floor height. 3 active at once locally; online one per player (2 or 3). Requests
  for the same weapon in the same step: the nearer player takes it, an exact tie at random. A taken spot empties at once; a replacement
  appears 4 s later, chosen and telegraphed 0.8 s early.
  - Hard rules: not an occupied spot, not the spot just emptied, ≥ 3 m from every living
    player. They are relaxed only if nothing passes.
  - Score: distance from players plus distance from other weapons, −12/−6 for the two most
    recently emptied spots, plus a little randomness.
  - Kind: 50/50, except that the other kind is forced when all other weapons match.

## Measured (real ragdoll, scripted)

| Case | Result |
| --- | --- |
| Shotgun, centred, 1.2–3 m | 120 damage, always kills |
| 4 m / 5 m / 6 m | kills 7/8 / 4/8 / 0/8 (85–113 at 5 m, ~61 at 6 m) |
| 8 / 10 / 12 m | 27–37 / 6–18 / 3–9 |
| Surviving target, close clean shot | shoved 1.5–2.3 m (median 1.5), lowest uprightness 0.77, 0/48 fail to recover |
| SMG 10 rounds held at 6 m | 10 hits in 0.95 s, 0.14 m slide, uprightness ≥ 0.92 |
| Punch at 0.7–0.9 m | 75–100 % land; the target's uprightness stays ≥ 0.81 |
| Trap, walking or sprinting | 25 HP, held 1.10 s, 0.1 m slide, uprightness ≥ 0.70 |
| Armed idle drift | 0.57 m / 20 s (unarmed 1.47 m); sprint 6.39 m/s, uprightness ≥ 0.88 |
| Cost (node) | ray 3–6 µs; shotgun shot 9 rays ≈ 30 µs; SMG round 2 rays; step unchanged (~140 µs) |

Upper-floor facts: the ring's north-west corner (the old spawn S3) has no torso line from
any ground-floor spot; rails and the deck edge shield it and only a standing player's
head is reachable. S3 now stands on the ring's west side (see maps/MAPS.md). The 1 m rails stop shots from a player standing back from them. From directly
above a target, the camera's 35° pitch limit cannot reach it; open drop edges (D8, D11,
D12) at a few metres work both ways.

## Online (Phase 2)

Implemented; see [BARN_ONLINE.md](../../BARN_ONLINE.md): protocol 5 barn input packet
(intent only), `BarnRoundSimulation` on the server, lag compensation (≤ 250 ms rewind of
character hit volumes only), the barn prediction rig (movement, aim-facing, sprint, idle
anchor, trap hold, stagger, punches, own weapon cadence), compact snapshots and server-
confirmed hits.
