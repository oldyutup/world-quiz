# Local Human Bowling air-control polish

Scope: local Human Bowling only. Protocol **9**. No online Bowling, PartyRoom, lobby, Mixed, unrelated-mode changes, commit, push or deployment. All existing uncommitted work remains. Rack distance 130 m, 0–30° / 0.900 s gauge sweep, speed-based launch, reduced drag, one-use forward/up Nudge, loose ragdoll, physical recovery, 1.25× pins and course geometry system are preserved.

## Direction audit and final tuning

The old controls already used **car yaw frozen at ejection** (`airHeading`), not world-only axes, the camera, live car heading, torso orientation or pelvis orientation. That remains the final basis. Facing +Z down the lane, the world-up chase camera sees +X as left. A sends positive steering along `(cos(h), 0, −sin(h))`; D sends its negative, screen-right. Body tumble cannot change this direction. A/D torque is also resolved in the frozen launch basis, separately from trajectory impulses.

The weakness was conservative acceleration, velocity and displacement limits, plus subtle torque. Short taps accumulated little correction velocity; stronger holds soon ran out of the 1.65 m travel allowance. Different airtimes and launch headings made world-X movement appear inconsistent, but orientation did not reverse the controls. Camera following also keeps the body near the center of the screen; rack/lane alignment shows trajectory changes.


| Parameter | Before | Final |
| --- | --- | --- |
| Lateral acceleration | 0.9 m/s² | 1.8 m/s² |
| Correction velocity cap | 0.8 m/s | 1.8 m/s |
| Absolute correction travel budget | 1.65 m | 4.0 m |
| Torso yaw / roll impulse coefficients | 0.18 / 0.28 | 0.30 / 0.48 |
| W / S torso pitch coefficient | 0.32 / 0.32 | 0.40 / 0.72 |
| Vertical correction acceleration / impulse budget | 0.30 m/s² / 0.45 m/s | 0.60 m/s² / 0.80 m/s |
| W forward acceleration / impulse budget | 0.70 m/s² / 0.80 m/s | unchanged |
| Input drag | 0.018 → 0.05/s with sustained input | unchanged |
| Passive damping | 0.035/s | unchanged |

Experiments compared 1.4/1.4/3, 1.8/1.8/4 and 2.0/2.0/5 (acceleration/cap/budget). The middle setting provides a clear correction without the strongest setting's ~4.6 m displacement at three seconds. Core impulses remain distributed 55% torso / 45% pelvis by total ragdoll mass; joints carry the limbs. There is no position teleport. Independent limb torques and the loose articulated constraints remain.

The travel allowance counts absolute drift even after release. Once spent, the added correction velocity is removed. Reversing input cannot refill the budget. Ground collisions can subsequently alter motion, so the allowance is an airborne control budget, not a cap on all collision-driven displacement.

W retains a small finite forward push, mild upward influence and useful pitch. S adds **no forward braking impulse**: it gives stronger opposite pitch and bounded downward influence. Both still incur the existing small input drag. At one second, W and S shift torso-up orientation by 49.1° and 65.5° from neutral respectively, and COM height by approximately +0.29 / −0.29 m. A/D one-second holds change torso-up orientation by about 15–17°, alongside actual COM movement.

## Controlled launches

Same seed, full-course car driving, throttle/brake regulation and held/released SPACE gauge, with no launch velocity or pose injection. Actual launch is **144.9 km/h at 25.0°**. Input starts at ejection. Displacement is mass-weighted COM difference from neutral, projected onto the frozen launch lateral axis. Positive is A/left; negative is D/right. Velocity is measured at the end of the input hold. Forward retention is compared with neutral at one second. Rack X is the actual world-X pelvis coordinate at the head-pin plane, after any landing or pin contacts, so it is not a pure airborne steering metric. Air distance is the existing pelvis horizontal-travel measurement.


| Input (seconds) | COM Δ at 1 s, m | COM Δ at 3 s, m | Lateral v at release, m/s | Forward retained | Air distance, m | Rack X, m | Pins | Entry |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | +0.00 | +0.00 | -0.08 | 100.00% | 126.04 | -0.97 | 5 | NEAR |
| A 0.25 | +0.38 | +1.23 | +0.37 | 99.52% | 124.89 | +1.87 | 0 | MISS |
| D 0.25 | -0.38 | -1.23 | -0.53 | 99.52% | 124.58 | -2.33 | 1 | NEAR |
| A 0.5 | +0.66 | +2.36 | +0.81 | 99.05% | 124.38 | +2.03 | 3 | NEAR |
| D 0.5 | -0.66 | -2.35 | -0.97 | 99.05% | 124.28 | -3.79 | 0 | MISS |
| A 1 | +0.87 | +3.68 | +1.64 | 97.77% | 123.17 | +2.13 | 2 | NEAR |
| D 1 | -0.87 | -3.67 | -1.79 | 97.77% | 123.08 | -4.05 | 0 | MISS |

A 0.5 s hold now moves the COM about **2.36 m** by three seconds, versus about 1.18 m before; 1 s produces **3.67 m**, versus about 1.5 m before. Normal corrections retain 97.77–99.52% of neutral forward speed at one second. Air distance retains approximately 97.7–99.1%. The rack result remains sensitive to landing posture and pin contacts: steering into a better line does not guarantee a score.

The physics angle sweep covers **15°, 20°, 25°, 30° × 130, 145, 160 km/h × neutral/A/D**, with matched 0.5 s holds. Every pair retains the correct direction. At one second, world-X COM differences stay between +0.648 and +0.649 m for A and −0.662 and −0.664 m for D. Additional regression cases apply input at 0.05, 0.55 and 1.0 s to exercise different orientations at every angle.

## Giant course balls

Scale is **1.35×**. Active ball radii grow from **1.00–1.80 m to 1.35–2.43 m**, diameters from **2.00–3.60 m to 2.70–4.86 m**. Primary balls are now 3.78–4.86 m in diameter. Mesh instances and spherical Rapier overlap sensors both read the same authored radius. Their center height is road height + radius, keeping the bottom on the road. Reset recreates the sensor shape from that same value. Pins and rack physics were not edited.

Main-ball X positions and all row Z positions remain unchanged. Only shoulder balls are clamped inward to retain 0.15 m barrier clearance, moving **0.035–0.1675 m** where needed. No longitudinal spacing changes remain. An intermediate staggered layout was rejected after driving probes found awkward recovery turns. The final layout preserves the existing separated decision groups and open routes.

Breakaway contact still latches once, disables the sensor, animates three cosmetic shells and adds no debris bodies. The existing radius-dependent speed loss now ranges **18.075–22.935%**, previously **16.5–20.1%**; heading disturbance remains 0.075 radians, aggregate loss cap remains 55%. Geometry, visual scale and collision response therefore agree without replacing the established breakaway system.

Controlled chassis sweeps use actual 130/145/165 km/h velocities through the enlarged sensor, on the existing flat road. Avoidance produces zero hits; glancing and central contact produce exactly one hit. No tunneling, car flip, floor penetration or invalid body was detected. These isolated collision fixtures set initial car position/speed; the separate keyboard trials and course validators drive from spawn without such overrides.


| Speed target | Contact | Before → after contact, km/h | Hits |
| --- | --- | --- | --- |
| 130 | avoid | clean avoidance | 0 |
| 130 | glance | 129.61 → 99.82 | 1 |
| 130 | central | 129.65 → 99.85 | 1 |
| 145 | avoid | clean avoidance | 0 |
| 145 | glance | 144.65 → 111.41 | 1 |
| 145 | central | 144.69 → 111.44 | 1 |
| 165 | avoid | clean avoidance | 0 |
| 165 | glance | 164.69 → 126.85 | 1 |
| 165 | central | 164.73 → 126.88 | 1 |

All 300 competent throws in the course validator completed their launch, despite imperfect bot avoidance. The 500-seed survey below has no missed ejections. Enlarged obstacles remain recoverable, not automatic run failures.

## 500-seed validation

Same existing competent cohort: scan seeds in order and retain `botThrow(seed, 1, 1).quality >= .18` before any outcome is known. No bot aiming/skill tuning, score targets or outcome filtering were added. Bots drive the course and use the existing aftertouch/Nudge policy.


| Trajectory class | Count |
| --- | --- |
| AIRBORNE | 25 |
| NEAR | 63 |
| MEDIUM | 84 |
| LONG | 130 |
| OVERFLIGHT | 166 |
| SHORT | 8 |
| MISS | 24 |

| Score | Count |
| --- | --- |
| 0 | 198 |
| 1–3 | 57 |
| 4–6 | 110 |
| 7–9 | 121 |
| 10 | 14 |

Mean **3.588 pins**; strike rate **2.8%**; any-pin-hit rate **60.4%**. The prior survey was 1.2% strikes / 61.6% any hit. This pass changes both obstacles and air authority, so the survey is not an isolated causal comparison of steering strength. Zero invalid bodies, zero detected deck penetrations, zero retries; maximum part-center separation **1.911 m**. The parity validator also reports zero car penetrations and zero airborne speed-cap activations.

## Headed keyboard and visual checks

Headed Google Chrome, real Playwright keyboard down/up events, full-course launches at **1440×900 and 1366×768**. This is automated keyboard testing with screenshot review, not a human participant study. Gameplay state was observed only; the harness did not set launch velocity, angles, ragdoll pose or scores.


Current recorded keyboard cohort: **46 throws**, **46 ejections**, **0 retries**, **0 browser errors**.


At each size: neutral; 0.25/0.5/1 s A and D; delayed A while tumbling; D initiated when torso-up Y < −0.5; W; S; WA/WD/SA/SD; Nudge+A/D; A/D at 15°, 20° and 30° with approximately 135/145/160 km/h targets. The main controlled keyboard cases target 25°/145 km/h. Screenshots cover obstacle approach, early flight, later alignment, rack entry and result. The chase view visibly shifts rack alignment in the intended direction and shows distinct opposing body responses. Controls/instruments remain within both viewports.


[1440 A alignment](/private/tmp/bowling-air-polish/keyboard/1440-A-medium-aim.png) · [1440 D alignment](/private/tmp/bowling-air-polish/keyboard/1440-D-medium-aim.png) · [1366 A alignment](/private/tmp/bowling-air-polish/keyboard/1366-A-medium-aim.png) · [1366 D alignment](/private/tmp/bowling-air-polish/keyboard/1366-D-medium-aim.png) · [enlarged balls](/private/tmp/bowling-air-polish/keyboard/1440-neutral-balls.png)


| Viewport / case | Actual km/h | Angle | Pins | Retries |
| --- | --- | --- | --- | --- |
| 1440-neutral | 144.0 | 25.0 | 8 | 0 |
| 1440-A-short | 144.4 | 25.0 | 0 | 0 |
| 1440-D-short | 144.1 | 25.6 | 1 | 0 |
| 1440-A-medium | 144.2 | 25.7 | 1 | 0 |
| 1440-D-medium | 144.1 | 25.6 | 2 | 0 |
| 1440-A-long | 144.1 | 25.6 | 3 | 0 |
| 1440-D-long | 144.3 | 25.6 | 0 | 0 |
| 1440-A-tumbling | 144.3 | 25.6 | 1 | 0 |
| 1440-D-inverted | 144.0 | 25.6 | 0 | 0 |
| 1440-W | 144.1 | 25.6 | 2 | 0 |
| 1440-S | 144.3 | 25.6 | 7 | 0 |
| 1440-WA | 144.0 | 25.6 | 0 | 0 |
| 1440-WD | 144.2 | 25.6 | 0 | 0 |
| 1440-SA | 144.2 | 25.6 | 0 | 0 |
| 1440-SD | 144.2 | 25.6 | 0 | 0 |
| 1440-nudge-A | 144.3 | 25.6 | 0 | 0 |
| 1440-nudge-D | 144.5 | 25.6 | 0 | 0 |
| 1440-A15 | 134.2 | 15.6 | 0 | 0 |
| 1440-D15 | 133.9 | 15.6 | 1 | 0 |
| 1440-A20 | 144.1 | 20.0 | 0 | 0 |
| 1440-D20 | 144.3 | 20.0 | 2 | 0 |
| 1440-A30 | 159.1 | 30.0 | 0 | 0 |
| 1440-D30 | 159.2 | 29.9 | 0 | 0 |
| 1366-neutral | 144.1 | 25.6 | 7 | 0 |
| 1366-A-short | 144.1 | 25.6 | 0 | 0 |
| 1366-D-short | 143.9 | 25.6 | 2 | 0 |
| 1366-A-medium | 143.9 | 25.6 | 0 | 0 |
| 1366-D-medium | 144.1 | 24.6 | 0 | 0 |
| 1366-A-long | 144.1 | 25.6 | 1 | 0 |
| 1366-D-long | 144.2 | 25.6 | 0 | 0 |
| 1366-A-tumbling | 144.3 | 25.6 | 3 | 0 |
| 1366-D-inverted | 144.0 | 25.6 | 5 | 0 |
| 1366-W | 144.0 | 25.6 | 0 | 0 |
| 1366-S | 144.5 | 25.6 | 8 | 0 |
| 1366-WA | 144.0 | 24.6 | 1 | 0 |
| 1366-WD | 144.2 | 25.6 | 0 | 0 |
| 1366-SA | 144.3 | 25.6 | 0 | 0 |
| 1366-SD | 144.0 | 25.6 | 0 | 0 |
| 1366-nudge-A | 144.3 | 25.0 | 0 | 0 |
| 1366-nudge-D | 144.0 | 25.0 | 0 | 0 |
| 1366-A15 | 134.6 | 15.0 | 0 | 0 |
| 1366-D15 | 134.0 | 15.0 | 0 | 0 |
| 1366-A20 | 144.1 | 20.0 | 0 | 0 |
| 1366-D20 | 144.0 | 19.6 | 1 | 0 |
| 1366-A30 | 159.2 | 30.0 | 0 | 0 |
| 1366-D30 | 159.2 | 30.0 | 0 | 0 |

## Performance and regression

The long keyboard cohort initially ran at 60 FPS, then Chrome clamped to exactly 30 FPS as the laptop fell below 20% battery. Physics costs remained low. Chrome documents that Energy Saver reduces the refresh rate: [official explanation](https://developer.chrome.com/blog/memory-and-energy-saver-mode). A separate temporary test profile sets `performance_tuning.battery_saver_mode.state = 0`, using the [documented Chromium preference](https://chromium.googlesource.com/chromium/src/+/main/components/performance_manager/public/user_tuning/prefs.h). No user browser profile or OS power setting is modified. That follow-up removes screenshots from the measurement loop and reruns keyboard flight and contact scenarios at both sizes.


| Viewport | Flight samples | FPS median/min | JS ms/frame | Physics mean ms | Worst rolling p99 ms | Worst step ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | 172 | 60.0 / 60.0 | 0.589 | 0.397 | 1.40 | 22.00 |
| 1366×768 | 159 | 60.0 / 60.0 | 0.597 | 0.383 | 1.50 | 25.80 |

Follow-up: 14 completed keyboard attempts, 0 browser errors.


| Full-course collision case | Launch km/h after recovery | Contacts | Rack reached | Pins |
| --- | --- | --- | --- | --- |
| 1440-central-130 | 129.2 | 1 | True | 3 |
| 1440-glance-145 | 143.9 | 1 | True | 6 |
| 1440-central-165 | 164.0 | 2 | True | 0 |
| 1366-central-130 | 129.3 | 1 | True | 4 |
| 1366-glance-145 | 144.0 | 1 | True | 7 |
| 1366-central-165 | 134.5 | 3 | True | 4 |

Physics body/collider counts, mesh topology and draw-call count are unchanged by this pass. Measurements are local-machine rolling windows; no detected tunneling does not prove all possible collision states safe.

- Complete frontend + edge suite: **554/554 passed**, no skipped/cancelled tests, including **44 Bowling tests**.
- App TypeScript and all five Bowling validator TypeScript checks pass.
- Production build passes, with the existing Vite large-chunk advisory.
- Original Bowling validator (300), course (300), parity (500), reachability (500), momentum (500 plus matrix/robustness) and focused controls/angles sweep pass.
- `git diff --check` passes; protocol remains 9.
- Six deterministic mode hashes exactly match the saved baseline.


| Mode | Unchanged SHA-256 |
| --- | --- |
| onlineRound | 8d89030cf2d5752364f82321950b42a6aa1100986c329955a5969c1876661de6 |
| barnRound | 88562a77268129b7f9601a990678cd87037fe3e5e51d7b7d8e637c345de5fc94 |
| layerRound | ef1303cc5b33cf14a3e6fe7211d2ebbdc50ae0dc8a6f827d088530afe625a069 |
| colorRound | 818900429dd23650e989ef4545e55a70257bb90938a4e3453e048385c9fefea6 |
| bombRound | 5be7de86b5f30dd9b1db691edf2463fc018fe13196fa63e7fb8306bdf05bf8d2 |
| Prop Hunt | 0c359d893dbb349c394cbfb640b3dbd299ac4791b7828a1004f504e84b076ed0 |

## Files changed in this pass

- `src/party-lab/scene/bowling/config.ts`: bounded air tuning and coherent giant-ball scale/barrier clearance.
- `src/party-lab/scene/bowling/game.ts`: stronger physical pitch/yaw/roll response and explicit basis documentation.
- `src/party-lab/scene/bowling.test.ts`: direction/tumble, meaningful COM correction, sphere geometry and high-speed collision regressions.
- `scripts/validate-party-lab-bowling-momentum.ts`: matched COM/velocity snapshots, candidate tuning and angle sweep.
- `src/party-lab/scene/bowling/AIR_CONTROL_REPORT.md`: this report.

A before/after SHA-256 source/asset audit confirms no previously present files disappeared and only the four code/test files above differ from the session-start snapshot. Finder `.DS_Store` metadata also changed during the run and was left untouched; it is excluded from the source/asset comparison. In particular, ArenaScene, car physics, camera, HUD, visual renderer, pins/assets, clock, all previous reports and the other validators retain their initial bytes. New evidence is under `/private/tmp/bowling-air-polish/`.

Reproduce the focused numeric sweep:

```sh
node --import tsx scripts/validate-party-lab-bowling-momentum.ts /private/tmp/bowling-control-check 0 --polish
node --import tsx scripts/validate-party-lab-bowling-momentum.ts /private/tmp/bowling-seed-check 500
```

The evidence directory contains baseline/gentle/strong/controlled-final JSON, 500-seed and other validator results, collision fixtures, both keyboard harnesses and their raw per-part traces, screenshots, build/test logs, preservation hashes and mode hashes. The first five-run preview included one late SPACE release outside the launch zone; it is retained under `preview/` and excluded from the final keyboard cohort. The initial sandboxed frontend suite stalled on a local-server integration test; the complete rerun with local-port access passed.
