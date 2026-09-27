# LOCAL Human Bowling: researched, implemented and measured

2026-09-27. Final rules are original Party Lab approximations of documented FlatOut 2 control principles. Research detail and confidence: [FLATOUT_RESEARCH.md](FLATOUT_RESEARCH.md).

## 1. Research findings

The [official PC manual, p. 8](https://cdn.akamai.steamstatic.com/steam/apps/2990/manuals/manual_en.pdf) establishes hold-to-increase-angle, slow motion, release-to-eject, directional aerobatics and one upward Nudge. No independent power selector is documented or visible in the reviewed gameplay. Treating car speed as launch energy is an inference; no proprietary formula was recovered.

[FlatOut 2 Bowling footage](https://www.youtube.com/watch?v=REYK365FQ5E) was visually inspected in headed Chrome: runway at 0:44, launch at 1:09, airborne advice at 1:28, rack approach at 3:25. It shows five rounds and a 150-point perfect-score target. Its author demonstrates a repeatable strike strategy. Exact scoring bonuses, surface friction and real-world dimensions were not established. The [2006 walkthrough](https://gamefaqs.gamespot.com/pc/929089-flatout-2/faqs/44311) also recommends late Nudge near pins.

The [secondary drag description](https://en.wikipedia.org/wiki/FlatOut_2#Ragdoll_physics) reports aerobatics slowing flight and Nudge reducing drag. Confidence is medium: the manual does not specify drag and the description provides no numeric evidence. Our exact drag/Nudge constants are adaptations. No Ultimate Carnage evidence was needed.

Not copied: assets, logos, sounds, textures, proprietary code, exact physics constants, vehicle classes/upgrades, career, online play, five-frame/bonus scoring. Existing Party Lab assets and Kenney art remain byte-for-byte intact.

## 2. Old versus new

| Mechanic | Old local implementation | New local implementation |
|---|---|---|
| Launch energy | Independent charge added 0.6–14 m/s | Measured car velocity × fixed 1.46 conversion; no power variable |
| Angle | Manual arrows, 12–55° | Automatic 5–75° sweep while SPACE held |
| Preparation | Could start anywhere | Valid press in marked z=6–29 area; car keeps moving |
| Slow motion | 0.4× fixed-step presentation | Retained, coupled to angle selection |
| Aerobatics | Up to 4.8 m correction, nearly free | Torso/limb torques plus capped distributed correction |
| Drag | No input-dependent loss | Exponential horizontal speed loss while correcting |
| Nudge | None | One +2.1 m/s upward impulse; brief drag relief |
| Obstacles | 1.7/0.75 m/s hits; quick recovery | 5.5/2.5 m/s hits, heading disturbance, slower recovery |
| Course routes | Both inner bypasses open in all layouts | One visible inner branch blocked, mirrored by seed |
| Rack/ground | 0.5 kg pins, 0.85 m spacing, long forgiving slide | 1.6 kg pins, 1.12 m spacing, greater ground friction |
| Difficulty | User reported frequent simple strikes | 1/300 seeded competent strikes; measured sensitivity below |

## 3. Final controls

- Drive: W throttle, S brake, A/D or Left/Right steering.
- In yellow launch zone: press and hold SPACE to sweep angle under slow motion; release to eject immediately.
- Air: A/D or Left/Right steer/roll/yaw; W/S or Up/Down influence pitch. Release driving keys if no aerobatics are desired.
- Press SPACE again while airborne: one Nudge. HUD shows HAZIR, KULLANILDI or UÇUŞ BİTTİ.
- Esc: pause. Opening the menu clears held launch input without ejecting on resume.

## 4. Final launch model

Let f be actual velocity projected onto car heading, s its lateral component, θ selected angle, h car heading. F=1.46×max(0,f).

```
vx = sin(h) × F × cos(θ) + cos(h) × s
vy = F × sin(θ) + 0.15 × carVerticalVelocity
vz = cos(h) × F × cos(θ) − sin(h) × s
```

Safety cap: 44 m/s. No independent boost input. Car maximum: 22 m/s; acceleration: 1.8 m/s² plus downhill gravity. Less than 2 m/s cannot eject. Zero horizontal approach supplies zero forward launch energy. Gravity is 9 m/s² airborne (shared −20 × local .45); normal shared gravity returns after landing. All nine rigid bodies retain coherent launch spin, loose joints and independently moving limbs.

## 5. Angle and bullet time

θ=min(75, 5 + 38×held real seconds), with 0.4× simulation time during preparation. At 22 m/s, the full sweep lasts 1.84 real seconds while the car advances roughly 16.2 m. 25° takes about .526 real seconds. Angle, position, speed and heading all matter. Manual preselection is removed. An early hold outside the zone must be released and pressed again inside. Release beyond z=30 is rejected; continuing to the catcher records a missed throw.

Rapier timestep stays 1/60. The existing 240 Hz presentation accumulator schedules fixed steps; the .15 s hold + .3 s easing tail after ejection remains. Equal-step trajectory regression passes.

## 6. Aerobatics and exact drag

Effort e=min(1,hypot(lateral,pitch)). Each 1/60 s step removes horizontal flight-reference velocity according to retention exp(−0.24×e×dt). The pelvis velocity is the reference; the same delta applies to each body, preserving relative limb velocities. At full effort this alone retains 78.66% per second, or 48.68% after three seconds. Passive linear damping remains .035. The reported drag-loss metric is the sum of these per-step horizontal speed removals, not total speed change due to gravity/contacts.

Lateral acceleration .9 m/s²; correction velocity cap .8 m/s; cumulative absolute correction allowance 1.65 m. Pitch acceleration .5 m/s² with .7 m/s total impulse budget. Controls stop at impact. Torso torque impulses per step: pitch .12×dt, yaw .10×dt, roll .15×dt times their inputs. Arm/leg counter-torques retain the existing loose oscillation and add input response. These are physical body rotations, not a rigid projectile pose.

Controlled airborne travel: no aerobatics **90.75 m**, mild .35 input for .6 s **86.83 m**, continuous full input **63.28 m**. Full correction loses **15.11 m/s** through explicit drag and scores zero.

## 7. Nudge

One per throw, on a fresh SPACE press after ejection, before impact. Distributed upward impulse is body mass ×2.1, adding 2.1 m/s to each body. No forward boost or restored lost speed. For .45 simulation seconds, active aerobatics drag is multiplied by .45 (55% reduction); passive damping is unchanged. Repeated presses cannot add another impulse. A press after landing is unavailable. Timing changes height/contact, and can waste the opportunity or worsen the score.

## 8. Course and rack

Retained 264×24 m arena, 34 m starting hill, 76 m descent, launch lip z=29 and head pin z=129. These are Party Lab dimensions, not asserted FlatOut dimensions. Measured useful flights last about 3.3 seconds; high-angle flights about 5.9 seconds. There is enough time for corrections/Nudge without moving the rack closer.

Twelve breakaway props remain. The front offset crate moves inward to ±2.8 m, visibly blocking one inner bypass per layout. Good bots read the authored open route; average bots choose it 85% of the time, with separate angle/target/timing errors. A crate costs 5.5 m/s and .055 rad heading disturbance; decorative pin costs 2.5 m/s and .025 rad, away from contact. Aggregate loss caps at 10 m/s per step. Sensors latch once; no new dynamic obstacle bodies or random launch forces. Lower acceleration prevents instant recovery.

Lane friction .36; body friction .40; landed damping .16. Early contact still bounces/tumbles/slides, but spends energy before the rack. Pin mass 1.6 kg, spacing 1.12 m; original physical colliders and tilt/out-of-bounds scoring stay in use. No artificial strike rejection or outcome cap.

## 9. Controlled experiments

All runs drive the real car and use held/released launch input through BowlingClock. No teleport, direct angle assignment, forced velocity or forced score. Except deliberate brake/obstacle variants, the angle trials reach the same measured ejection state. Coordinates/metres and velocity/m/s; times are simulation seconds unless specified.

| Run | Car m/s | Angle ° | Release (x,y,z) m | Initial velocity (x,y,z) m/s | Hits |
|---|---:|---:|---|---|---:|
| low-angle | 21.89 | 12.28 | (-2.49, 1.97, 27.91) | (0.77, 7.60, 31.22) | 0 |
| baseline | 21.89 | 25.27 | (-2.49, 1.97, 27.91) | (0.71, 14.44, 28.89) | 0 |
| high-angle | 21.89 | 55.03 | (-2.49, 1.97, 27.91) | (0.45, 26.99, 18.31) | 0 |
| mild-aerobatics | 21.89 | 25.27 | (-2.49, 1.97, 27.91) | (0.71, 14.44, 28.89) | 0 |
| aggressive-aerobatics | 21.89 | 25.27 | (-2.49, 1.97, 27.91) | (0.71, 14.44, 28.89) | 0 |
| early-nudge | 21.89 | 25.27 | (-2.49, 1.97, 27.91) | (0.71, 14.44, 28.89) | 0 |
| apex-nudge | 21.89 | 25.27 | (-2.49, 1.97, 27.91) | (0.71, 14.44, 28.89) | 0 |
| late-nudge | 21.89 | 25.27 | (-2.49, 1.97, 27.91) | (0.71, 14.44, 28.89) | 0 |
| obstacle-hit | 12.66 | 25.27 | (-2.25, 2.03, 27.98) | (-1.34, 8.31, 16.67) | 4 |
| low-speed | 11.37 | 25.27 | (-2.50, 1.98, 27.73) | (0.37, 7.46, 15.00) | 0 |

| Run | Aero input s | Explicit drag loss m/s | Nudge at s | Air time s | Air distance m | Post-contact travel m | Pins |
|---|---:|---:|---:|---:|---:|---:|---:|
| low-angle | 0.00 | 0.00 | — | 1.97 | 59.86 | 33.03 | 0 |
| baseline | 0.02 | 0.00 | — | 3.30 | 90.75 | 24.45 | 3 |
| high-angle | 0.00 | 0.00 | — | 5.88 | 98.33 | 4.91 | 3 |
| mild-aerobatics | 0.60 | 1.37 | — | 3.30 | 86.83 | 21.94 | 0 |
| aggressive-aerobatics | 3.30 | 15.11 | — | 3.30 | 63.28 | 10.00 | 0 |
| early-nudge | 0.02 | 0.00 | 0.12 | 3.72 | 101.11 | 4.80 | 8 |
| apex-nudge | 0.02 | 0.00 | 1.52 | 3.55 | 97.13 | 12.94 | 7 |
| late-nudge | 0.02 | 0.00 | 2.92 | 3.37 | 92.39 | 14.60 | 8 |
| obstacle-hit | 0.00 | 0.00 | — | 2.10 | 34.34 | 8.99 | 0 |
| low-speed | 0.02 | 0.00 | — | 1.92 | 28.27 | 9.36 | 0 |

Post-contact travel includes subsequent bounce, tumble and slide, not only flat sliding. Air distance is planar displacement to first ground contact; direct pin contact can occur before it. Tiny sub-.01 drag in nominal neutral runs comes from the release-frame driving input before the next sampled neutral input. Baseline mild input is .35 for .6 s; aggressive input stays at 1 until impact. Values are not estimates from footage.

## 10. Seeded bot distribution

Exactly 300 competent profiles selected only by seeded quality ≥.18, never by result. Profiles vary target, route, throttle, release point, angle, correction duration and Nudge timing. Bots operate the same held launch, car, ragdoll, drag, Nudge and pin rules as the player. No launch/score overrides. 120 extra physics steps after scoring found **zero lost late knockdowns**. No retries.

| Pins | Throws | Share |
|---|---:|---:|
| 0 | 85 | 28.33% |
| 1–3 | 55 | 18.33% |
| 4–6 | 87 | 29.00% |
| 7–9 | 72 | 24.00% |
| 10 | 1 | 0.33% |

Mean **3.723 pins**. Average profiles: 169 throws, mean **2.337**. Good profiles: 131 throws, mean **5.511**. Separately measured 60 bad profiles all scored zero: intentionally poor speed/timing/control can entirely miss this rack.

A fixed left-route recipe sweep (4 courses ×5 angles ×3 Nudge choices) yielded **2 strikes /60**, both on the open branch. The wrong branch loses speed. A tighter 21-case timing sweep around the successful clean recipe yielded **3 strikes**, other scores 4–9. Exact successful input remains deterministic and repeatable; the evidence supports a narrow skill window, not an impossible-to-learn game.

## 11. Headed Chrome results

Real keydown/keyup input through headed Chrome at 1440×900 and 1366×768. Automated keyboard trials with visual screenshot review, not a human participant study. Debug access observes state and resets trials; it does not set launch, flight or pin results. Both sizes verified the angle-only meter, bullet scale, movement while choosing angle, clean/obstacle/slow runs, low/high angles, excessive aerobatics and early/apex/late Nudge. All scenario trials resolved without retries.

| Keyboard run | 1440×900 score / air distance | 1366×768 score / air distance |
|---|---|---|
| clean | 6 pins / 88.6 m | 6 pins / 88.6 m |
| obstacle | 0 pins / 33.5 m | 0 pins / 33.6 m |
| slow | 0 pins / 27.0 m | 0 pins / 27.0 m |
| low-angle | 0 pins / 61.1 m | 0 pins / 61.1 m |
| high-angle | 3 pins / 97.2 m | 3 pins / 97.3 m |
| aggressive | 0 pins / 62.4 m | 0 pins / 62.8 m |
| early-nudge | 9 pins / 101.4 m | 8 pins / 99.7 m |
| apex-nudge | 7 pins / 95.5 m | 6 pins / 95.7 m |
| late-nudge | 8 pins / 89.8 m | 2 pins / 92.1 m |

Completed matches: 2 players: [[7, 6, 5], [0, 7, 4]]; 3 players: [[0, 5, 3], [1, 3, 7], [6, 6, 4]]. Final-bundle confirmation: 3 players: [[5, 6, 4], [4, 0, 7], [0, 0, 9]]

Repeated 26° + 1.5 s Nudge keyboard recipe, three runs at each size: **8, 2, 5, 5, 3, 9**. Automated timing/line corrections are more precise than an ordinary first-time player's. This is not a population strike-rate estimate.

Supplement also exercises pause/cancel/resume and a second SPACE press after Nudge; raw checks: [supplement-results.json](/private/tmp/bowling-flatout-validation/supplement-results.json). Visuals: [1440 angle](/private/tmp/bowling-flatout-validation/1440-clean-angle.png), [1366 flight](/private/tmp/bowling-flatout-validation/1366-clean-flight.png), [final HUD](/private/tmp/bowling-flatout-validation/1366-repeat-0-flight.png).

## 12. Performance

Headed Chrome, local machine, final-bundle telemetry where available. Figures summarize rolling frame/physics telemetry during flight; they are not a GPU benchmark or hardware-independent guarantee. Median and range of reported samples:

| Metric | Median | Range |
|---|---:|---:|
| FPS | 60.000 | 60.000–60.000 |
| JS frame work, ms | 0.365 | 0.181–0.568 |
| Physics step average, ms | 0.224 | 0.144–0.285 |
| Rolling physics p99, ms | 0.600 | 0.400–0.800 |
| Draw calls | 21.000 | 21.000–29.000 |
| Triangles | 43622.000 | 43330.000–49809.000 |

Dynamic body count remains 20 (car +9 ragdoll +10 pins). Correction/Nudge add no bodies or effects allocations. No physics-cap events in the controlled normal flight cases. Ragdoll stability guards remain.

## 13. Tests/builds/regressions

- Complete frontend +edge suite: **544 passed, 0 failed**, including 34 Bowling tests. Final log: [tests-verified.log](/private/tmp/bowling-flatout-validation/tests-verified.log).
- `npx tsc --noEmit`: passed. The standalone measurement script also passes an explicit TypeScript check (ES2022 / bundler resolution).
- `npm run build`: passed. Existing large-chunk advisory remains; no build error.
- `git diff --check`: passed.
- No shared/server change, so additional server validation was not required.
- Six deterministic before/after hashes exactly equal:

| Mode | SHA-256 |
|---|---|
| onlineRound | `8d89030cf2d5752364f82321950b42a6aa1100986c329955a5969c1876661de6` |
| barnRound | `88562a77268129b7f9601a990678cd87037fe3e5e51d7b7d8e637c345de5fc94` |
| layerRound | `ef1303cc5b33cf14a3e6fe7211d2ebbdc50ae0dc8a6f827d088530afe625a069` |
| colorRound | `818900429dd23650e989ef4545e55a70257bb90938a4e3453e048385c9fefea6` |
| bombRound | `5be7de86b5f30dd9b1db691edf2463fc018fe13196fa63e7fb8306bdf05bf8d2` |
| Prop Hunt | `0c359d893dbb349c394cbfb640b3dbd299ac4791b7828a1004f504e84b076ed0` |

Protocol remains **9** (`shared/party-lab/network/protocol.ts:21`). Rooftop, Barn, Layer Chaos, Color Chaos, Bomb Tag, Prop Hunt simulations untouched. No PartyRoom, lobby, Mixed, online Bowling, commit, push or deployment changes.

## 14. Files and preservation

Session baseline backed up externally before changes: `/private/tmp/human-bowling-before-flatout-20260927-114626/worktree.tar.gz`, plus diff/status/SHA-256 manifest. All 22 baseline files recoverable. Twelve unchanged files/assets match the backup byte-for-byte.

Changed this session:
- `src/party-lab/scene/bowling/config.ts`: parameters, seeded profiles, route blocker, angle sweep.
- `game.ts`: speed/angle launch, drag, physical aerobatics, Nudge, measurements.
- `car.ts`: meaningful speed/heading collision cost.
- `BowlingPlayground.tsx`: controls and snapshot wiring.
- `BowlingHud.tsx`: remove power, automatic angle and Nudge wording.
- `src/party-lab/scene/ArenaScene.tsx`: only the Bowling control-help sentence differs from the session baseline; all prior integration preserved.
- `src/party-lab/scene/bowling.test.ts`: retain geometry/scoring/stability coverage, replace obsolete power tests with new control/drag/Nudge regressions.
- `scripts/validate-party-lab-bowling.ts`: controlled experiments, 300 competent profiles, 60 bad profiles, 60 fixed recipes and late-pin verification.
- `HUMAN_BOWLING.md`, `STUNT_TUNING.md`: historical content retained, current-rule pointer added.
- New `FLATOUT_RESEARCH.md` and this report.

Existing map GLB, sky/dust art, kit builder, visual/camera/audio/effects implementations and Bowling CSS preserved.

Reproduce measurements: `npx tsx scripts/validate-party-lab-bowling.ts /private/tmp/bowling-verification 300`. Full per-throw evidence: [verified folder](/private/tmp/bowling-flatout-validation/verified). Baseline/after hashes, browser traces, PNGs, test/build logs and timing-sensitivity JSON live in the [evidence folder](/private/tmp/bowling-flatout-validation).

## 15. Remaining differences and limits

Party Lab keeps three raw-pin throws /30 for short local matches; FlatOut footage shows five rounds and a 150 target. Speed scale, body/pin proportions, launch conversion, gravity, angle range/rate, drag, friction and obstacle loss are independently tuned. We do not claim numerical physics equivalence. No manual formula or footage calibration establishes 100 actual metres. The original's repeatable expert strike technique is not copied as an automatic scoring rule. Exact successful inputs can still repeat; measured nearby inputs, varied routes and keyboard trials demonstrate the added skill requirement. Human first-time strike rates require actual user playtesting beyond these headed keyboard trials.
