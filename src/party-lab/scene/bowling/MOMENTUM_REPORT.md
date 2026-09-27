# LOCAL Human Bowling: momentum, physical rack entry and editable geometry

2026-09-27. This report describes the current pass; the earlier reports remain intact as historical evidence. Local only, protocol **9**. No online Bowling, PartyRoom, lobby, Mixed, shared physics, other modes, commit, push or deployment changes.

## Preservation and scope

External pre-edit backup: `/private/tmp/bowling-momentum-backup-20260927/worktree.tgz` (complete working tree excluding `.git`, `node_modules`, and `dist`), with `tracked.patch` and `status.txt` beside it. It includes all previously untracked Bowling files and assets. Initial HEAD: `627a0ba`. The original tracked/untracked status, diff and last five commits were inspected before editing.

Changed Bowling-local files: `config.ts`, `game.ts`, `visual.ts`, `camera.ts`, `courseDriving.ts`, `BowlingPlayground.tsx`, `BowlingHud.tsx`, `../bowling.test.ts`; the four existing Bowling validators; new `scripts/validate-party-lab-bowling-momentum.ts`; this report. `ArenaScene.tsx` changes only the Bowling help sentence relative to the session-start version. Existing assets, CSS, car physics, clock, effects, audio and all previous reports are preserved.

## Measured cause and controls

The primary loss was explicit input-dependent drag, not the steering torque or a shared velocity clamp. Previously, each 1/60 s step computed `e = min(1, hypot(steer,pitch))`, `r = exp(-0.36*e*dt)`, then subtracted `(1-r)` times the pelvis horizontal velocity from **every** body. Full input retained only 69.77% per second, or 33.96% after three seconds, from this term alone. Even a 0.25 s tap retained only 91.39%. The subtraction preserved relative limb velocity but removed the player's translation very aggressively.

Passive Bowling linear damping is still 0.035/s; it accounts for about 3.44% loss per second. Shared control runs with zero posture/mobility, returning before balance, locomotion or hand assistance. Torque impulses change rotation and internal joint reactions, not a prescribed forward-speed target. The existing lateral budget can oppose **lateral** drift when exhausted; it does not intentionally brake forward travel. The 62 m/s safety cap remains and does not constrain normal launch/flight in these experiments. Ground damping/friction take effect after landing and cannot explain the airborne audit.

Previously W/S applied opposing pitch torque and ±0.5 m/s² vertical core correction with a 0.7 m/s absolute allowance, but no forward push. A/D already supplied the bounded lateral impulses and yaw/roll response retained here. Every direction paid the same severe explicit drag, which made otherwise useful controls feel like brakes.

Current explicit drag:

```
activeSeconds += effort * dt
k = effort * (0.018 + 0.032 * clamp((activeSeconds - 0.35) / 1.5, 0, 1))
retention = exp(-k * dt)
```

The first 0.35 input-seconds use 0.018/s; prolonged correction ramps smoothly to 0.05/s. Pausing input stops both drag and accumulation; it does not reset the allowance. At full input, idealized explicit retention is about 99.55% after 0.25 s, 98.08% after 0.9 s, and 89.15% after 3 s. These are integration explanations, not success thresholds or range clamps.

- **W:** positive torso/pelvis pitch torque, core forward acceleration 0.7 m/s² with a total 0.8 m/s forward allowance, plus 0.3 m/s² upward correction within the shared 0.45 m/s absolute pitch allowance. Small, finite and directed along launch heading. No second launch or indefinite lift.
- **S:** opposing pitch and modest downward core correction within that same 0.45 m/s allowance. No direct subtraction of forward velocity.
- **A/D:** retained yaw/roll torque and lateral acceleration 0.9 m/s²; lateral correction velocity capped at 0.8 m/s and total absolute correction travel at 1.65 m. Reversals share the same budget. Torso torque coefficients remain pitch 0.32, yaw 0.18, roll 0.28 impulse-units/s, with pelvis share 0.35 and articulated limb counter-torques. No guided orientation lock.

The original body posture, coherent launch rotation, loose joints, speed-driven launch and bounce/tumble/roll/slide remain.

## Same-state air-control audit

All rows drive the complete physical course to approximately 145 km/h and 24°, using the actual gauge/clock, then vary only air input. Initial launch and per-step velocities, horizontal speed, vertical speed, peak, first ground, air/total travel, class and score are saved for every row. `Vz@1` is mass-weighted forward velocity at the same 1.0 simulation-second observation; initial nominal forward velocity is 36.754 m/s (coherent launch COM is slightly different because of rotation). This avoids confusing pelvis tumble with net forward momentum.

| Input | Old Vz@1 | New Vz@1 | Old explicit loss | New explicit loss | Old air m | New air m | Range/reference | Class | Pins |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 35.68 | 35.68 | 0.00 | 0.00 | 123.79 | 123.79 | 100.0% | NEAR | 5 |
| W tap | 32.43 | 35.67 | 3.35 | 0.18 | 113.67 | 123.51 | 99.8% | NEAR | 5 |
| S tap | 32.42 | 35.51 | 3.36 | 0.18 | 111.86 | 122.46 | 98.9% | NEAR | 4 |
| A tap | 32.42 | 35.50 | 3.35 | 0.18 | 112.47 | 122.73 | 99.1% | MISS | 0 |
| D tap | 32.43 | 35.51 | 3.35 | 0.18 | 112.12 | 122.34 | 98.8% | MISS | 0 |
| W moderate | 25.76 | 35.58 | 10.12 | 0.71 | 95.12 | 124.50 | 100.6% | NEAR | 7 |
| A moderate | 25.79 | 34.96 | 10.07 | 0.70 | 93.00 | 120.71 | 97.5% | NEAR | 8 |
| D moderate | 25.83 | 35.01 | 10.07 | 0.70 | 93.06 | 120.77 | 97.6% | MISS | 0 |
| heavy W+A | 24.83 | 35.52 | 25.87 | 4.75 | 71.61 | 120.08 | 97.0% | NEAR | 6 |

Current full telemetry (velocity components x/y/z in m/s; distances in m):

| Input | Initial launch v | v after input¹ | Horizontal@1 | Vertical@1 | Air/total | Peak | First ground z |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | 1.00/17.65/36.75 | 0.96/7.11/35.68 | 35.69 | 7.11 | 123.79/144.87 | 17.25 | 151.67 |
| W tap | 1.00/17.65/36.75 | 0.99/14.80/36.60 | 35.69 | 7.19 | 123.51/145.16 | 17.37 | 151.40 |
| S tap | 1.00/17.65/36.75 | 0.98/14.65/36.43 | 35.52 | 7.04 | 122.46/153.97 | 17.17 | 150.34 |
| A tap | 1.00/17.65/36.75 | 1.21/14.73/36.42 | 35.52 | 7.11 | 122.73/176.95 | 17.27 | 150.59 |
| D tap | 1.00/17.65/36.75 | 0.76/14.73/36.43 | 35.52 | 7.11 | 122.34/178.35 | 17.27 | 150.24 |
| W moderate | 1.00/17.65/36.75 | 0.96/8.40/35.71 | 35.60 | 7.37 | 124.50/135.83 | 17.45 | 152.38 |
| A moderate | 1.00/17.65/36.75 | 1.71/8.14/35.09 | 35.01 | 7.11 | 120.71/150.62 | 17.36 | 148.55 |
| D moderate | 1.00/17.65/36.75 | 0.18/8.14/35.13 | 35.01 | 7.11 | 120.77/172.36 | 17.36 | 148.69 |
| heavy W+A | 1.00/17.65/36.75 | -0.03/-0.00/0.01 | 35.56 | 7.40 | 120.08/137.96 | 17.56 | 147.92 |

¹ Neutral uses the 1 s reference; taps use 0.25 s and moderate holds 0.9 s. The continuous 10 s request outlasts flight, so its “after input” observation is grounded; use Vz@1 and landing velocity in the JSON for the airborne comparison. Heavy input is intentionally no longer a range catastrophe. The score varies with physical orientation/line even when range is retained.

Raw matched audits: `baseline-complete/controls.json` and `final/controls.json` under the evidence directory. The baseline source was recovered from the pre-edit backup to add the common 1 s observation; the original audit taken **before tuning** remains in `baseline/`.

## One-use forward + upward Nudge

For each enabled part, `impulse = partMass × (1.8 × horizontalTravelUnitVector + (0, 2.6, 0))`. The direction comes from mass-weighted current horizontal travel, falling back to launch heading only if travel is zero. Existing velocity is never assigned/replaced by Nudge. There is no Nudge drag term, drag relief, damping change or velocity cancellation. The per-body total impulse magnitude is mass × 3.1623; forward/up components are mass × 1.8 and mass × 2.6 respectively.

The impulse adds exactly **1.8 m/s forward along travel** and **2.6 m/s upward**, within floating-point tolerance. The complete physics step also contains gravity/passive damping, so the immediate impulse telemetry is stored separately from the next step's result. A fresh press on the very first flight frame waits at most one fixed step for Rapier to re-enable collider mass; it is not consumed as a zero impulse. Tests cover immediate, early, middle, apex and late timing, plus repeated presses and landing lockout. HUD retains **NUDGE · HAZIR** and **NUDGE · KULLANILDI**.

Same 145 km/h / 24° experiment; rack height is pelvis height at the first head-pin-plane crossing, and may be after a pin hit:

| Nudge time s | Forward before→after | Vertical before→after | Peak m | Air m | Ground z | Rack y | Class | Pins |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | 17.25 | 123.79 | 151.67 | 1.62 | NEAR | 5 |
| 0.02 | 36.92 → 38.72 | 17.37 → 19.97 | 21.75 | 146.14 | 174.01 | 7.86 | OVERFLIGHT | 0 |
| 0.52 | 36.28 → 38.08 | 12.11 → 14.71 | 20.53 | 143.53 | 171.41 | 6.43 | OVERFLIGHT | 0 |
| 1.20 | 35.43 → 37.23 | 5.07 → 7.67 | 18.82 | 139.66 | 167.54 | 4.26 | OVERFLIGHT | 0 |
| 1.82 | 34.67 → 36.47 | -1.13 → 1.47 | 17.25 | 135.79 | 163.66 | 2.22 | AIRBORNE | 3 |
| 2.82 | 33.48 → 35.28 | -10.92 → -8.32 | 17.25 | 129.16 | 157.04 | 0.83 | NEAR | 5 |

Early Nudge can overfly a strong throw; the apex example converts this near recovery into airborne contact. Clean no-Nudge recipes also work. The timing is a choice, not a required upgrade.

## Course, enlarged pins and visible targeting

Rack stays at **130 m**, measured from effective lip z=29 to head pin z=159. Gravity stays **−10 m/s² airborne**, then the existing **−20 m/s² after first floor contact**. Launch speed gain remains 1.0, cap 62 m/s; real car cap remains 46 m/s (165.6 km/h), acceleration 7 m/s². Gauge stays **0→30→0**, 0.900 presentation seconds each direction, 0.4× bullet time, exact rendered-angle release, with no CSS needle lag. The car keeps moving during selection.

The obstructing center sign at x=0, y=5, z=139 is completely removed. The start gantry and side signage remain. The visible mesh and all three pin colliders share **1.25× uniform scale**, selected between the suggested bounds without changing the source GLB.

| Pin/deck property | Before | After |
| --- | --- | --- |
| Visual scale / height | 1.0 / 1.5 m | 1.25 / 1.875 m |
| Maximum body collider radius | .24 m | .30 m |
| Base cylinder radius / half-height | .135 / .10 m | .16875 / .125 m |
| Base cylinder center y | .10 m | .125 m |
| Middle hull y range / maximum radius | .20–.93 / .24 m | .25–1.1625 / .30 m |
| Upper hull y range / widest head radius | .93–1.50 / .125 m | 1.1625–1.875 / .15625 m |
| Mass | 1.6 | 3.125 (constant density, ×1.25³) |
| Mass shares base/middle/top | 30% / 50% / 20% | unchanged |
| Visible deck width × depth | 7 × 7 m | 7.5 × 8.75 m |
| Spacing / row depth | 1.12 / .970 m | 1.40 / 1.212 m |
| Scoring bounds x | ±3 m | ±3.75 m |
| Scoring bounds z | head−2 to head+5 | head−2.5 to head+6.25 |
| Friction / restitution | .38 / .12 | unchanged |
| Linear / angular damping | .12 / .22 | unchanged |

Rapier computes scaled center of mass and inertia from the uniformly scaled colliders and mass shares: COM height scales ×1.25 and inertia scales ×1.25⁵. Minimum inter-pin center distance 1.40 m exceeds the 0.60 m maximum body diameter, so there is no initial overlap. Thirty-second pin rest tests pass. The visible deck matches the authoritative bounds; no invisible oversized hitboxes, pin assists, score multipliers or automatic strikes were added.

An isolated 90-recipe experiment moved pin mass upward (20/45/35%) to examine upper-hit response. Airborne mean changed only 4.64→4.82 while medium recovery improved 5.50→6.00; it did not support a better airborne preference, so that experimental change was **not shipped**. The original mass distribution and friction/restitution/damping remain.

## Physical speed × angle region and robustness

The validator uses actual course driving, target-speed throttle/brake, current ramp-lip release geometry, and the real gauge. No launch velocity/position/angle injection. Targets 130–160 km/h are analysis samples, not success rules. Each cell below is diagnostic trajectory class and actual pins: A airborne, N near, M medium, L long, O overflight, S short, X miss. Simultaneous floor/pin contacts in the same 1/60 s step are conservatively classified as recovery. Classes never feed back into gameplay.

[Large visual map](/private/tmp/bowling-momentum/speed-angle-map.svg) · [CSV](/private/tmp/bowling-momentum/speed-angle-map.csv)

| km/h | 0° | 2° | 4° | 6° | 8° | 10° | 12° | 14° | 16° | 18° | 20° | 22° | 24° | 26° | 28° | 30° |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 130 | S/0 | S/0 | S/0 | S/0 | S/0 | S/0 | S/0 | L/0 | L/2 | L/3 | L/1 | L/3 | L/5 | M/6 | M/7 | M/6 |
| 135 | S/0 | S/0 | S/0 | S/0 | S/0 | S/0 | L/4 | L/2 | L/4 | L/2 | L/1 | M/5 | M/6 | M/6 | M/8 | N/4 |
| 140 | S/0 | S/0 | S/0 | S/0 | L/0 | L/4 | L/4 | L/4 | L/6 | L/3 | M/5 | M/5 | M/6 | N/6 | N/2 | N/4 |
| 145 | S/0 | S/0 | S/0 | L/2 | L/4 | L/4 | L/5 | L/6 | L/6 | M/7 | M/5 | M/6 | N/5 | N/5 | A/5 | O/0 |
| 150 | S/0 | L/0 | L/6 | L/4 | L/3 | L/6 | L/3 | L/5 | M/3 | X/0 | M/5 | N/4 | A/5 | A/2 | O/0 | O/0 |
| 155 | L/2 | L/3 | L/7 | L/6 | L/5 | L/4 | L/6 | L/5 | X/0 | M/7 | N/7 | A/5 | O/0 | O/0 | O/0 | O/0 |
| 160 | L/2 | L/3 | L/4 | L/7 | L/5 | L/4 | L/6 | X/0 | M/6 | N/5 | N/4 | O/0 | O/0 | O/0 | O/0 | O/0 |

73/112 combinations score at least one pin; broad medium/near/long recovery regions surround the more selective direct-air region. Several clean airborne recipes exist, and target-line variations produce airborne nine-pin hits. Angles affect only velocity direction and physical initial rotation. No branch grants success, collision help or scoring based on degrees.

Perturbations use complete approaches with the same driver policy and speed target. Minor release-position/speed differences from the discrete physical clock are retained; this is not an injected identical-state replay.


| Speed | Center angle | −3° | −2° | −1° | Center | +1° | +2° | +3° |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 135 | 28 | M/5 (110.0 m) | M/6 (112.9 m) | M/7 (115.8 m) | M/8 (117.1 m) | N/0 (119.4 m) | N/4 (121.3 m) | outside 0–30° |
| 145 | 25 | M/6 (117.3 m) | N/7 (120.4 m) | N/5 (123.8 m) | N/7 (126.0 m) | N/5 (129.3 m) | A/6 (131.9 m) | A/5 (133.5 m) |
| 155 | 21 | M/7 (115.8 m) | N/7 (120.7 m) | N/7 (124.3 m) | N/6 (128.5 m) | A/5 (132.3 m) | A/3 (136.0 m) | O/0 (140.1 m) |

At 145 km/h, all seven 22–28° perturbations score 5–7 pins. At 135 km/h, 29° happens to produce contact without a knockdown, while its range remains between its neighbors; it is not physically excluded. At 155 km/h, the +3° case naturally overflies. Thus small errors change trajectories gradually, but discrete collisions and chaotic pin chains can still change score sharply. No universal memorized angle guarantees a hit or strike.

## Airborne versus floor recovery

Ground contact **never invalidates a throw**. It changes the existing local gravity/damping phase, then physics continues through bounce, tumble, rolling and sliding. Scoring still depends only on sustained physical pin tilt or leaving the deck. Floor friction .36, body friction .20, body restitution .16 and landed damping .10 are unchanged.

Comparable no-Nudge 145 km/h full-course examples (different angle creates the entry type). Contact velocity is mass-weighted just before the first physical pin collision; energy is the sum of **translational** kinetic energy of all nine bodies, excluding rotational energy. Orientation is torso up-vector x/y/z. Segments count distinct solver-contact body parts over the rack interaction, not simultaneous hits or an impulse-strength threshold. Rack/ground positions are pelvis reference positions, and reported contact height is the contacting segment center:

| Angle | Entry | Ground gap m | Forward m/s | Vertical m/s | Energy | Torso up | Segments | Pins |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 28° | AIRBORNE | -2.39 | 31.15 | -19.31 | 2286 | 0.10/0.30/0.95 | 7 | 5 |
| 25° | NEAR | 4.46 | 25.64 | 0.78 | 1120 | -0.27/0.16/0.95 | 5 | 7 |
| 20° | MEDIUM | 21.22 | 24.70 | -7.05 | 1143 | -0.52/-0.29/0.81 | 7 | 5 |
| 14° | LONG | 41.97 | 19.26 | 0.04 | 632 | 0.10/0.16/0.98 | 8 | 6 |

The direct airborne row carries substantially greater energy and downward momentum, including a physical head hit around 1.64 m above the deck (upper visible pin region). Pelvis, torso, head, arms and legs appear in recorded rack contacts across runs. Airborne contact and multi-pin chain reactions are real rigid-body interactions.

**Measured limitation:** airborne entries are not statistically higher scoring than every floor recovery. Many glancing upper hits knock fewer pins than a centered sliding body. In the competent cohort, contact-conditioned means are about 3.32 airborne, 5.02 near, 5.10 medium and 5.27 long. These are different input/line/speed populations, not a causal comparison; the direct-air contact still has higher energy in the matched-speed example. Long recovery remains an effective strategy, not merely an emergency failure state. No artificial scoring hierarchy was imposed to make a table look better.

## Geometry authority and resilience

`COURSE` in `config.ts` owns start, downhill, obstacle zone, prep, ramp start/lip/height, rack, end bounds, road/lane width, pin scale and base spacing. It derives final approach, rack distance, deck and runout. `BOWLING` exposes derived getters for existing callers; it no longer duplicates these world-space numbers. `courseBoxes()`, `roadHulls()`, and `wallHulls()` generate the physical surfaces. Obstacle authored station values map into the configured obstacle zone. Rack bodies, visual scale/deck, scoring boundaries, barriers/markings, main course scenery, target camera, bot release and projection, and validators consume current anchors.

`FLIGHT` is an explicit independent Bowling physics profile. Moving a rack never changes gravity, speed gain, drag, Nudge or controls. The unit resilience test changes rack/end, ramp anchors, width and obstacle anchors, verifies generated positions/bounds/camera, and asserts unchanged physics. An isolated **rack +10 m** survey retains lip z=29, moves head to z=169, and runs the full dense map without changing validator coordinates:

| Rack distance | Airborne | Near | Medium | Long | Overflight | Short | Miss | Scoring cells | Mean pins |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 130 m | 4 | 10 | 17 | 45 | 12 | 21 | 3 | 73 | 2.97 |
| 140 m | 2 | 9 | 15 | 41 | 7 | 35 | 3 | 66 | 2.47 |

The serialized physics profiles are exactly equal across both surveys. The shipped rack remains 130 m; the temporary change exists only inside the comparison process. Raw maps include actual speed, angle, first ground position/gap, rack-plane height/velocities, class and score. `--rack-offset` is an explicit designer experiment, never runtime auto-normalization.

## 500 competent seeded throws

First 500 sequential seeds whose existing quality value is ≥.18; no outcome filtering or retries. Every bot drives the same car/obstacles, holds/releases the same gauge and uses the same body/pin physics. Mean actual eject speed is 160.97 km/h; zero flight or impact speed-cap events occurred. Bots now sample a broad 13–24° good / 8–28° average range and have a 45% pre-throw chance to plan a Nudge (174/500 actually fire before contact), because the former almost-always-Nudge/high-angle profile systematically overflew after the momentum fix. Bot angle and Nudge choices are fallible input profiles, not physics or scoring rules; actual speed, route and heading still vary.


| Entry class | Count | Share |
| --- | --- | --- |
| AIRBORNE | 37 | 7.4% |
| NEAR | 93 | 18.6% |
| MEDIUM | 69 | 13.8% |
| LONG | 114 | 22.8% |
| OVERFLIGHT | 157 | 31.4% |
| SHORT | 0 | 0.0% |
| MISS | 30 | 6.0% |

| Pins | Count | Share |
| --- | --- | --- |
| 0 | 192 | 38.4% |
| 1–3 | 110 | 22.0% |
| 4–6 | 89 | 17.8% |
| 7–9 | 103 | 20.6% |
| 10 | 6 | 1.2% |

Average **3.086 pins**; strike rate **1.2%**; any-pin-hit rate **61.6%**. The high-speed competent cohort has no short throws, but the dense low-angle/lower-speed region and keyboard cohort do. Reach and score remain distinct. Maximum part separation 1.816 m; zero invalid bodies, zero deck-penetration observations and zero reset retries. Shared-mode hashes stay unchanged.

## Headed Chrome keyboard validation

Automated human-like **real keydown/keyup events in headed Chrome**, not a claim of a human participant study. Each attempt starts at the summit and drives the whole course. No gameplay position, velocity, angle, score, clock or body injection. Debug access observes state; navigation starts a fresh trial. Digital driving decisions occur roughly every 65–91 ms; gauge release observations are faster. All attempts, including missed release windows, are retained.


| Keyboard scenario | Actual km/h | Angle | Nudge s | Air m | Class | Pins | Retries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1440-neutral | 144.3 | 27.8 | — | 131.7 | AIRBORNE | 5 | 0 |
| 1440-w-tap | 144.0 | 26.7 | — | 129.2 | NEAR | 6 | 0 |
| 1440-w-moderate | — | — | — | — | NO EJECT | 0 | 0 |
| 1440-s-tap | 144.2 | 26.7 | — | 127.6 | NEAR | 6 | 0 |
| 1440-a-tap | 149.0 | 23.9 | — | 128.1 | NEAR | 6 | 0 |
| 1440-d-tap | 148.9 | 23.9 | — | 126.2 | NEAR | 1 | 0 |
| 1440-wa-early | 134.1 | 26.7 | 0.47 | 131.2 | NEAR | 4 | 0 |
| 1440-wd-mid | 139.0 | 25.0 | 1.28 | 129.9 | NEAR | 10 | 0 |
| 1440-apex-second | 144.6 | 22.8 | 1.62 | 131.2 | AIRBORNE | 7 | 0 |
| 1440-late | 143.9 | 25.0 | 2.93 | 129.2 | NEAR | 9 | 0 |
| 1440-aggressive | 143.9 | 25.0 | — | 120.7 | NEAR | 1 | 0 |
| 1440-low | 144.1 | 3.9 | — | 43.1 | SHORT | 0 | 0 |
| 1440-medium | 144.2 | 17.9 | — | 101.1 | MEDIUM | 7 | 0 |
| 1440-high | 159.2 | 30.0 | — | 163.9 | OVERFLIGHT | 0 | 0 |
| 1440-short | — | — | — | — | NO EJECT | 0 | 0 |
| 1440-corrections | 149.2 | 25.0 | — | 130.1 | NEAR | 5 | 0 |
| 1366-neutral | 144.2 | 27.8 | — | 131.9 | AIRBORNE | 4 | 0 |
| 1366-w-tap | 144.2 | 26.7 | — | 129.4 | NEAR | 4 | 0 |
| 1366-w-moderate | 143.9 | 25.0 | — | 125.1 | NEAR | 2 | 0 |
| 1366-s-tap | 144.2 | 26.7 | — | 127.6 | NEAR | 8 | 0 |
| 1366-a-tap | — | — | — | — | NO EJECT | 0 | 0 |
| 1366-d-tap | 149.2 | 23.9 | — | 127.5 | NEAR | 1 | 0 |
| 1366-wa-early | 134.1 | 26.7 | 0.50 | 131.2 | NEAR | 3 | 0 |
| 1366-wd-mid | 139.1 | 25.0 | 1.20 | 131.7 | NEAR | 7 | 0 |
| 1366-apex-second | 144.2 | 22.8 | 1.68 | 129.0 | NEAR | 7 | 0 |
| 1366-late | 143.9 | 25.0 | 2.93 | 129.7 | NEAR | 6 | 0 |
| 1366-aggressive | 144.2 | 24.6 | — | 120.0 | NEAR | 1 | 0 |
| 1366-low | — | — | — | — | NO EJECT | 0 | 0 |
| 1366-medium | 145.6 | 17.8 | — | 102.6 | MISS | 0 | 0 |
| 1366-high | 158.9 | 29.9 | — | 163.2 | OVERFLIGHT | 0 | 0 |
| 1366-short | — | — | — | — | NO EJECT | 0 | 0 |
| 1366-corrections | 149.0 | 25.0 | — | 129.8 | NEAR | 8 | 0 |
| 1440-upper-pins | 144.0 | 28.9 | — | 133.5 | AIRBORNE | 5 | 0 |
| 1366-upper-pins | 144.1 | 28.9 | — | 132.9 | AIRBORNE | 7 | 0 |
| 1440-short-flight | 129.3 | 7.8 | — | 41.4 | SHORT | 0 | 0 |
| 1366-short-flight | 129.6 | 7.8 | — | 47.3 | SHORT | 0 | 0 |
| 1440-long-recovery | 144.2 | 11.7 | — | 76.3 | LONG | 7 | 0 |
| 1366-falling-gauge | 134.2 | 25.0 | — | 108.9 | MEDIUM | 3 | 0 |
| 1440-moderate-w | 143.9 | 25.1 | — | 125.6 | NEAR | 8 | 0 |
| 1366-early-second | 134.0 | 25.0 | 0.25 | 128.7 | NEAR | 5 | 0 |

Final upper-pin keyboard evidence: at 1440×900 the pelvis contacted the rack while airborne at segment-center height **1.557 m**, with COM forward velocity **30.587 m/s** and vertical velocity **−19.655 m/s**, scoring five pins. The 1366×768 companion scored seven. Supplementary low-angle throws flew 41.4/47.3 m before physical ground recovery and stayed short; the long-recovery trial scored seven; the falling gauge released correctly; moderate W scored eight. Second-Nudge attempts retained exactly one recorded activation time in every observed subsequent sample.

[1440 upper-pin approach](/private/tmp/bowling-momentum/keyboard-supplement/1440-upper-pins-rack.png) · [1366 upper-pin approach](/private/tmp/bowling-momentum/keyboard-supplement/1366-upper-pins-rack.png) · [falling-gauge input trace](/private/tmp/bowling-momentum/keyboard-supplement/results.json)

Final recorded cohort: 40 complete full-course attempts, 35 ejections; 0 browser exceptions. Evidence paths: `keyboard-v3/` and `keyboard-supplement/`. The preliminary interrupted batches are kept separately and excluded from final-code results.

## Performance, validation and limits

Browser measurements are rolling debug windows on this machine, not a hardware-independent guarantee. FPS includes renderer pacing; JS/frame covers the Bowling callback, not all GPU work. Some heavy validation processes overlapped the first viewport. No timing samples are discarded to hide spikes.


| Viewport | Flight samples | FPS median/min | JS mean ms/frame | Physics mean ms | p99 median/worst ms | Worst step ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | 383 | 60.0 / 59.7 | 0.528 | 0.345 | 0.900 / 1.900 | 26.30 |
| 1366×768 | 349 | 60.0 / 60.0 | 0.622 | 0.409 | 1.200 / 1.900 | 18.50 |

20 dynamic bodies remain (car + nine human segments + ten pins). No extra physics bodies were added. Larger pins rest stably, car high-speed driving is unchanged, ragdoll separation stays bounded and both physics validators and keyboard traces report no invalid resets. Discrete below-floor observations cannot prove the absence of every possible tunneling case, but none were detected in the 500-seed sweep and parity safety survey.

- Complete frontend + edge suite: **550/550 passed**, no skips/cancellations, including 40 Bowling tests.
- TypeScript app check and all five validator-script checks pass; production build passes. Existing Vite large-chunk advisory remains.
- Original experiment validator (300 competent), course validator (300), parity validator (500), reachability validator (500), new dense/robustness/500-seed validator, temporary rack-offset survey, pin-stability and geometry-resilience tests pass.
- `git diff --check` passes. Protocol remains 9.


| Existing mode | Unchanged SHA-256 |
| --- | --- |
| Rooftop Brawl | `8d89030cf2d5752364f82321950b42a6aa1100986c329955a5969c1876661de6` |
| Barn Shootout | `88562a77268129b7f9601a990678cd87037fe3e5e51d7b7d8e637c345de5fc94` |
| Layer Chaos | `ef1303cc5b33cf14a3e6fe7211d2ebbdc50ae0dc8a6f827d088530afe625a069` |
| Color Chaos | `818900429dd23650e989ef4545e55a70257bb90938a4e3453e048385c9fefea6` |
| Bomb Tag | `5be7de86b5f30dd9b1db691edf2463fc018fe13196fa63e7fb8306bdf05bf8d2` |
| Prop Hunt | `0c359d893dbb349c394cbfb640b3dbd299ac4791b7828a1004f504e84b076ed0` |

Remaining meaningful limits: upper-pin airborne contact requires a useful line and descent; its geometric window is naturally narrower than total rack reach. A centered floor recovery can outscore an airborne graze. Pin score is discontinuous even when trajectories change smoothly. Exact deterministic inputs remain repeatable. High-speed/high-angle Nudge can deliberately overfly. There are occasional physics-step spikes despite approximately 60 FPS. The automated keyboard cohort is not a human usability study. Extreme course redesigns still need explicit tuning and visual review; editable geometry is not a promise that every arbitrary layout is playable.

Reproduce from the repository root:

```sh
node --import tsx scripts/validate-party-lab-bowling-momentum.ts /private/tmp/bowling-check 500
node --import tsx scripts/validate-party-lab-bowling-momentum.ts /private/tmp/bowling-longer 0 --rack-offset 10
node --import tsx scripts/validate-party-lab-bowling-momentum.ts /private/tmp/bowling-impact 0 --impact
```

Each dense run writes JSON plus `speed-angle-map.csv` and `speed-angle-map.md`; the evidence directory also contains the rendered SVG map, raw old/new audits, impulse timing measurements, impact/robustness recipes, browser harness/screenshots, tests/build logs and regression hashes. Evidence root: `/private/tmp/bowling-momentum/`.
