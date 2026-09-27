# Local Human Bowling: larger pins and fewer course balls

2026-09-27. Focused local-only pass. No commit, push, deployment, online Bowling, protocol change, or unrelated-mode edits. Protocol remains 9.

## 1–3. Scale comparison and selection

Previous scale: **1.25×** original asset. Tested **1.50×, 1.60× and 1.70×**, plus the previous size for comparison, in physical fixtures and headed Chrome. Selected **1.60×**, a **28% linear increase** over the previous pins. The upright visual silhouette is about 64% larger in projected area at the same distance.

1.50× was visibly better but less substantial. 1.60× gives a broad, recognizable target while keeping the complete scaled deck within the existing 10 m alley. 1.70× adds only 6.25% over 1.60× and requires a 10.2 m deck that extends into the side pads. The 1.60× choice preserves the lane and 130 m rack distance. All three experiments remained upright for ten seconds without initial overlap.

## 4–8. Coherent geometry and mass

| Property | Previous | Final |
| --- | --- | --- |
| Visual and physical height | 1.875 m | 2.400 m |
| Maximum collider radius | 0.300 m | 0.384 m |
| Base cylinder half-height / radius | 0.125 / 0.16875 m | 0.160 / 0.216 m |
| Base collider local center Y | 0.125 m | 0.160 m |
| Pin center spacing | 1.400 m | 1.792 m |
| Row depth | 1.21244 m | 1.55192 m |
| Resting minimum envelope gap | 0.800 m | 1.024 m |
| Rack envelope width × depth | 4.800 × 4.23731 m | 6.144 × 5.42375 m |
| Marked/scoring deck width × depth | 7.500 × 8.750 m | 9.600 × 11.200 m |
| Scoring X bounds | ±3.750 m | ±4.800 m |
| Scoring Z bounds | 156.500–165.250 m | 155.800–167.000 m |
| Mass per pin | 3.125 kg | 4.500 kg |
| Local center of mass Y | 0.668114 m | 0.855187 m |
| Principal inertia eigenvalues | 0.071858, 0.853566, 0.853566 | 0.169534, 2.013819, 2.013819 |

The same scale drives mesh instances, all three colliders, rack positions, painted deck, scoring bounds and physical contact survey height. The floor already covers the enlarged target; its 24 m width remains unchanged. Head pin stays at Z=159, ramp lip at Z=29, and body spawn clearance stays at 0.006 m. The rack grows proportionally, preserving its density and triangular formation. The marked deck is presentation over the existing physical floor, not a raised platform.

The two convex colliders retain their original twelve-sided ring profiles. Each pair below is local `(height, radius)` in metres; no oversized hitboxes were added.
| Shape | Previous rings | Final rings |
| --- | --- | --- |
| Lower body | (0.250, .16875), (.475, .29375), (.750, .300), (1.1625, .10625) | (.320, .216), (.608, .376), (.960, .384), (1.488, .136) |
| Neck/head | (1.1625, .10625), (1.400, .10625), (1.625, .15625), (1.7875, .11875), (1.875, .03125) | (1.488, .136), (1.792, .136), (2.080, .200), (2.288, .152), (2.400, .040) |

Keeping the old density would produce 6.5536 kg pins. That trial gave weaker chains and one late knockdown in the original 300-throw validator (seed 116, 7→8). Compared 3.125, 4.500 and 6.5536 kg at 1.60×. Selected 4.500 kg from physical impact behavior, not a target scoring percentage. Mass distribution remains 30% base, 50% body, 20% neck/head (1.35 / 2.25 / 0.90 kg); Rapier derives center of mass and inertia. Future geometry scaling remains density-based around this calibrated size. Friction, damping, restitution, CCD and scoring logic are unchanged.

## 9. Pin impacts and stability

All recipes drive from spawn using the real fixed-step clock, throttle/brake and angle gauge. No position/velocity injection or score assistance.
| Recipe | Actual entry | Pins | Contacting segment center Y |
| --- | --- | --- | --- |
| upper-centred-airborne | AIRBORNE | 9 | 1.868 m |
| centred-airborne | AIRBORNE | 6 | 1.338 m |
| glancing-left-airborne | AIRBORNE | 3 | 0.981 m |
| glancing-right-airborne | AIRBORNE | 5 | 0.691 m |
| near-recovery | NEAR | 6 | 1.111 m |
| medium-recovery | MEDIUM | 6 | 2.018 m |

Ten-second resting checks show no initial overlap, drift above 2 mm, spontaneous tilt, or unstable pin. The final 300-throw late-score audit has zero late knockdowns. The 500-seed survey has zero invalid ragdoll bodies and zero deck-penetration observations under its existing checks.

A stricter collider-support audit of the six impacts found no body tunneling or persistent sinking. It did detect five transient pin-floor compression samples over 4 cm: maximum 7.63 cm, at most two fixed steps (33 ms), resolving to at most 1.66 mm at completion. The old-size baseline reached 12.26 cm in the same recipes. An isolated extra-solver-iteration experiment did not improve this, so no solver change was applied. These are contact-solver transients, not a claim of mathematically zero interpenetration.

## 10–13. Every authored obstacle variant

Coordinates are world `(X, Z)` metres after existing barrier clamping; Y equals radius on this flat section. All retained radii are **exactly unchanged**, with the existing 1.35× ball scale. Counts refer to visible, collision-enabled balls; inactive reset slots remain in the six-slot arrays.
| Variant | Old → new count | Reduction | Retained positions |
| --- | --- | --- | --- |
| Split entry | 6 → 3 | 50% | (-2.3, -126); (2.2, -84); (-1.8, -42) |
| Late switch | 6 → 3 | 50% | (2.1, -126); (-2.2, -84); (2.1, -42) |
| Open shoulder | 5 → 3 | 40% | (-2.5, -126); (1.7, -84); (-2.3, -42) |
| Double centre | 5 → 3 | 40% | (0, -126); (-2.5, -84); (0, -42) |
| Wide rhythm | 5 → 3 | 40% | (2.7, -126); (-2.4, -84); (1.8, -42) |
| Tight finish | 6 → 3 | 50% | (-1.7, -126); (2.4, -84); (-2, -42) |

| Variant | All previous balls: ID = (X, Z; radius) |
| --- | --- |
| Split entry | ball-0=(-2.3, -126; 2.295); ball-1=(2.2, -84; 2.295); ball-2=(-1.8, -42; 2.2275); ball-3=(0, -15; 2.025); ball-4=(4.365, -126; 1.485); ball-5=(-4.4325, -84; 1.4175) |
| Late switch | ball-0=(2.1, -126; 2.43); ball-1=(-2.2, -84; 2.16); ball-2=(2.1, -42; 2.295); ball-3=(-1.3, -15; 2.025); ball-4=(-4.365, -126; 1.485); ball-5=(4.365, -84; 1.485) |
| Open shoulder | ball-0=(-2.5, -126; 2.16); ball-1=(1.7, -84; 2.295); ball-2=(-2.3, -42; 2.025); ball-3=(1, -15; 2.025); ball-5=(-4.5, -84; 1.35) |
| Double centre | ball-0=(0, -126; 2.43); ball-1=(-2.5, -84; 2.16); ball-2=(2.2, -42; 2.295); ball-3=(0, -15; 2.16); ball-5=(4.4325, -84; 1.4175) |
| Wide rhythm | ball-0=(2.7, -126; 2.295); ball-1=(-2.4, -84; 2.295); ball-2=(1.8, -42; 2.025); ball-3=(-1.5, -15; 1.89); ball-4=(-4.365, -126; 1.485) |
| Tight finish | ball-0=(-1.7, -126; 2.295); ball-1=(2.4, -84; 2.3625); ball-2=(-2, -42; 2.16); ball-3=(0.7, -15; 2.43); ball-4=(4.365, -126; 1.485); ball-5=(-4.365, -84; 1.485) |

In every variant, kept ball-0/1/2: the three primary driving decisions at Z=-126, -84 and -42. Removed ball-3 at Z=-15 because it repeats the preceding decision immediately before launch preparation. Removed all active ball-4/5 shoulder blockers because they duplicate the first two rows and visually close the alternate line. Already inactive shoulder slots remain inactive.

Double centre ball-2 moves from X=2.2 to X=0 at the same Z=-42 and radius 2.295 m. This retains two center threats at Z=-126 and -42 without keeping the late Z=-15 blocker. No other retained ball moves or changes size.

The three rows are 42 m apart, giving about 0.92–1.16 s between centers at 165–130 km/h. Each row contains only one major ball. There are at least 61.6 m clear from the last shell to ramp start, and 68.6 m to the lip. The original final-approach anchors remain intact. Opposite lateral arrangements, offset magnitudes, radii, and Double centre’s repeated center choice preserve variant differences.

## 14–15. Headed Chrome visual and driving checks

Real Google Chrome in headed mode, actual keyboard down/up events. Harnesses observe game state but do not write car positions, velocities, angle values, ragdoll poses or scores. The scale comparison changes only pin geometry before a fresh arena is created. The final cohort uses the selected source configuration. A temporary Chrome profile disables browser battery-saver throttling; no user profile or OS setting is changed.

At 1440×900 and 1366×768, the rack is visibly wider and taller than the previous size, retains separated pin silhouettes, and becomes a substantial target during the flight/close approach. At the unchanged 130 m driving distance it is still a distant rack, now with a broader, clearer silhouette. No zoom, camera, HUD or target-distance adjustment was used. Screenshots show three occasional large obstacles with clear road between them and an open final section.


| Keyboard run | Launch km/h | Ball contacts | Pins | Retry / missed eject |
| --- | --- | --- | --- | --- |
| 1440-variant-0 | 129.1 | 1 | 4 | 0 / False |
| 1440-variant-1 | 144.3 | 0 | 6 | 0 / False |
| 1440-variant-2 | 154.1 | 1 | 5 | 0 / False |
| 1440-variant-3 | 159.4 | 0 | 7 | 0 / False |
| 1440-variant-4 | 149.4 | 0 | 8 | 0 / False |
| 1440-variant-5 | 164.3 | 1 | 3 | 0 / False |
| 1366-variant-0 | 129.1 | 1 | 3 | 0 / False |
| 1366-variant-1 | 144.5 | 0 | 4 | 0 / False |
| 1366-variant-2 | 148.0 | 2 | 4 | 0 / False |
| 1366-variant-3 | 159.2 | 1 | 5 | 0 / False |
| 1366-variant-4 | 149.1 | 0 | 4 | 0 / False |
| 1366-variant-5 | 164.1 | 1 | 5 | 0 / False |
| variant-0-central | 148.7 | 2 | 7 | 0 / False |
| variant-0-glance | 149.1 | 2 | 5 | 0 / False |
| variant-1-central | 149.0 | 1 | 6 | 0 / False |
| variant-1-glance | 149.3 | 2 | 7 | 0 / False |
| variant-2-central | 149.0 | 1 | 6 | 0 / False |
| variant-2-glance | 149.2 | 2 | 7 | 0 / False |
| variant-3-central | 149.2 | 1 | 6 | 0 / False |
| variant-3-glance | 149.3 | 1 | 7 | 0 / False |
| variant-4-central | 149.3 | 1 | 4 | 0 / False |
| variant-4-glance | 149.2 | 2 | 4 | 0 / False |
| variant-5-central | 149.4 | 1 | 7 | 0 / False |
| variant-5-glance | 149.1 | 2 | 7 | 0 / False |
| variant-0-center-risk | 154.1 | 3 | 6 | 0 / False |
| variant-3-center-risk | 154.0 | 3 | 6 | 0 / False |


| Keyboard run | Launch km/h | Ball contacts | Pins | Retry / missed eject |
| --- | --- | --- | --- | --- |
| clean-variant-0 | 144.3 | 0 | 3 | 0 / False |
| clean-variant-1 | 144.0 | 0 | 5 | 0 / False |
| clean-variant-2 | 144.0 | 0 | 6 | 0 / False |
| clean-variant-3 | 144.3 | 0 | 3 | 0 / False |
| clean-variant-4 | 144.3 | 0 | 5 | 0 / False |
| clean-variant-5 | 144.3 | 0 | 3 | 0 / False |
| upper-airborne-1440 | 154.2 | 0 | 3 | 0 / False |
| upper-airborne-1366 | 153.9 | 0 | 4 | 0 / False |


| Keyboard run | Launch km/h | Ball contacts | Pins | Retry / missed eject |
| --- | --- | --- | --- | --- |
| airborne-contact-1440 | 155.0 | 0 | 5 | 0 / False |
| airborne-contact-1366 | 155.1 | 0 | 5 | 0 / False |


Across the final cohorts, **36 keyboard throws completed**, including actual airborne rack contacts at both resolutions (5 pins each), including an upper-pin contact at 1440×900. The reported contact height is the contacting ragdoll segment center, not a point on the pin surface. The main 26-run cohort completed with zero missed ejections, retries, browser exceptions, or invalid observed body states. It covers all six variants at both sizes, all six with direct and glancing contacts, and two center-risk lines. Deliberate impacts dropped speed from about 149 to 115–118 km/h; the open final road allowed recovery to about 149 km/h by launch. A second cohort verifies a zero-contact clean line in all six variants at 144.0–144.3 km/h, plus close airborne approach views at both resolutions. Those two approach throws landed just before physical contact, as recorded in their measurements. Driving traces and every impact are retained with screenshots under the evidence folder. Contact runs test recovery and the clean final approach; a collision is a deliberate outcome in these cases, not a requirement to pass without losing speed.


Visual evidence: [1440×900 airborne rack](/private/tmp/bowling-size-density-20260927-193732/airborne-keyboard/airborne-contact-1440-rack.png), [1366×768 airborne rack](/private/tmp/bowling-size-density-20260927-193732/airborne-keyboard/airborne-contact-1366-rack.png), [1366×768 driving course](/private/tmp/bowling-size-density-20260927-193732/final-keyboard/1366-variant-1-balls.png).

## 16. Existing 500-seed validation

Unmodified competent-seed selection, no outcome filtering and no percentage target. **500 throws**, **3.096 average pins**, **56.8% physical any-pin-contact rate (284/500)**, **56.2% scoring at least one pin (281/500)**, **0% strike rate**. These two hit rates differ because three contacts did not knock down a pin.
| Pins | Count | Share |
| --- | --- | --- |
| 0 | 219 | 43.8% |
| 1–3 | 37 | 7.4% |
| 4–6 | 151 | 30.2% |
| 7–9 | 93 | 18.6% |
| 10 | 0 | 0.0% |

| Trajectory class | Count | Share |
| --- | --- | --- |
| AIRBORNE | 57 | 11.4% |
| NEAR | 80 | 16.0% |
| MEDIUM | 65 | 13.0% |
| LONG | 82 | 16.4% |
| OVERFLIGHT | 188 | 37.6% |
| SHORT | 0 | 0.0% |
| MISS | 28 | 5.6% |

The lighter mass was selected before this final distribution. Good contact can take many pins, glances can take few, and overflights still miss. No automatic knockdown, fake strike, enlarged invisible target or scoring assistance exists. A zero-strike finite sample is reported as observed, not tuned away.

## 17. Performance

| Cohort / phase | Samples | FPS | Mean JS/frame ms | Mean physics ms | Worst step ms |
| --- | --- | --- | --- | --- | --- |
| final-keyboard drive | 536 | 59.0–60.4 | 0.336 | 0.251 | 28.100000023841858 |
| final-keyboard flight | 665 | 59.5–60.0 | 0.494 | 0.320 | 28.100000023841858 |

| Cohort / phase | Samples | FPS | Mean JS/frame ms | Mean physics ms | Worst step ms |
| --- | --- | --- | --- | --- | --- |
| clean-keyboard drive | 160 | 59.7–60.3 | 0.326 | 0.258 | 25 |
| clean-keyboard flight | 299 | 59.9–60.0 | 0.458 | 0.334 | 25 |

| Cohort / phase | Samples | FPS | Mean JS/frame ms | Mean physics ms | Worst step ms |
| --- | --- | --- | --- | --- | --- |
| airborne-keyboard drive | 40 | 59.8–60.3 | 0.303 | 0.252 | 25.699999928474426 |
| airborne-keyboard flight | 50 | 60.0–60.0 | 0.408 | 0.282 | 25.699999928474426 |


FPS uses existing rolling browser telemetry, not a universal hardware guarantee. JS timings measure the Bowling update, not complete GPU work. No new bodies, debris or per-frame effects were added. Existing 130/145/165 km/h direct/glancing ball-collision tests pass without tunneling or flipping. Raw browser traces preserve collision speed loss and subsequent recovery.

## 18. Tests, build and isolation

- Complete frontend + edge suite: **555 passed, 0 failed**, including 45 Bowling tests. One overloaded concurrent rerun caused two unrelated Barn timing tests to fail; a quiet complete rerun passes. No Barn code was changed.
- TypeScript: `npx tsc --noEmit` passes.
- Production build passes; existing >500 kB bundle advisory remains.
- Original Bowling validator: 300 competent throws, 60 poor-profile throws, 90 recipes, zero late knockdowns; passes.
- Course validator: 300 competent throws plus all six approach variants; passes.
- Parity, reachability and momentum validators: 500 seeds each; all pass.
- Pin impact, stability, sparse-course geometry and 130–165 km/h ball-collision checks pass. The contact-compression limitation above is explicitly measured.
- All six deterministic existing-mode hashes match their pre-existing baseline.
- `git diff --check` passes. Untracked Bowling files are separately checked for whitespace.
- No changes to car tuning, air control, Nudge, angle sweep, gravity, ragdoll, recovery, scoring rules, camera, HUD, PartyRoom, lobby, Mixed, protocol or unrelated modes. The removed central sign stays removed.

Initial visual harnesses were interrupted by source hot reload while choosing geometry/mass; those partial results are retained and excluded from the final cohort. No game workaround was added for a harness interruption.

| Existing mode | Unchanged SHA-256 |
| --- | --- |
| onlineRound | 8d89030cf2d5752364f82321950b42a6aa1100986c329955a5969c1876661de6 |
| barnRound | 88562a77268129b7f9601a990678cd87037fe3e5e51d7b7d8e637c345de5fc94 |
| layerRound | ef1303cc5b33cf14a3e6fe7211d2ebbdc50ae0dc8a6f827d088530afe625a069 |
| colorRound | 818900429dd23650e989ef4545e55a70257bb90938a4e3453e048385c9fefea6 |
| bombRound | 5be7de86b5f30dd9b1db691edf2463fc018fe13196fa63e7fb8306bdf05bf8d2 |
| Prop Hunt | 0c359d893dbb349c394cbfb640b3dbd299ac4791b7828a1004f504e84b076ed0 |

## 19. Files changed in this pass

- `src/party-lab/scene/bowling/config.ts`: pin scale/mass, sparse authored ball layouts.
- `src/party-lab/scene/bowling.test.ts`: ten-second pin stability and sparse-course regression checks.
- `src/party-lab/scene/bowling/SIZE_DENSITY_REPORT.md`: this report.

All pre-existing files were SHA-256 audited against session start. No pre-existing file disappeared. ArenaScene and all other prior uncommitted work retain their initial bytes. Existing pin assets, visual code and collider-generation code remain unchanged and consume the shared scale.

## 20. Backup and reproducible evidence

Backup: [`uncommitted.tar.gz`](/private/tmp/bowling-size-density-20260927-193732/uncommitted.tar.gz). It contains **all session-start modified and untracked work**. The same directory contains `tracked.diff`, `status.txt`, the full preservation manifest, geometry surveys, scale/mass experiments, validator JSON/logs, Chrome harnesses, screenshots, and raw keyboard traces.

Evidence directory: `/private/tmp/bowling-size-density-20260927-193732`. No commit, push or deployment.
