# Local Human Bowling: gameplay parity report

2026-09-27. Final physical-unit retune; no online Bowling, protocol change, PartyRoom/lobby/Mixed edits, commit, push or deployment.

## Research and complete difference audit

The [pre-implementation evidence table](PARITY_AUDIT.md) records mechanic, FlatOut evidence, fact versus inference, confidence, previous Party Lab behavior, and required change. It includes car, launch, flight, Nudge, landing, bowling, HUD, course rhythm, car classes and scoring differences.

Primary references independently checked:

- [Official FlatOut 2 PC manual, Steam app 2990](https://cdn.akamai.steamstatic.com/steam/apps/2990/manuals/manual_en.pdf): launch-area hold slows action and automatically increases angle; release sets launch; directional aerobatics; one small upward Nudge. No separate power control is documented.
- [J4cobLIVE Bowling / Kingpin footage](https://www.youtube.com/watch?v=REYK365FQ5E&t=68s): visibly 164 KMH and 20° at 1:10, separate left angle and right speed instruments. Edited instructional pauses prevent timing the underlying game from this clip's wall clock.
- [All School Gameplays, All Stunts](https://www.youtube.com/watch?v=cZ8lAE6iLns&t=76s): at 1:32, a tumbling driver with 32° / 159 KMH; at 1:37, nine pins down. The unchanged speed display at impact cannot establish body speed. This corroborates multi-second flight and physical tumbling.
- [Independent Bowling screenshot](https://www.virtueone.com/uploads/gallery_flatout2/2011-05-31_00135.jpg): inverted driver, 31°, 163 KMH, four-direction aerobatics and Nudge labels. Inspected visually; no pixels imported.
- [Grawl's 2006 walkthrough](https://gamefaqs.gamespot.com/pc/929089-flatout-2/faqs/44311): near-pin Nudge strategy and transcribed hints reporting an airspeed cost for aerobatics. Strategy is not an impulse formula.
- [Contemporary GamesRadar review](https://www.gamesradar.com/flatout-2-review/2/): fast approach, loose flailing driver, accuracy emphasis.

Verified controls and visible HUD values are distinguished from inferred dynamics. Exact FlatOut acceleration, SI scale, angle sweep rate, gravity, drag coefficients, body inertia and friction were not recovered. The following numerical values are **original Party Lab adaptations**. Stunt-versus-unlocked-racing-car descriptions are secondary corroboration; racing Rocket speed statistics were not used as Bowling targets. Nudge drag relief has no adequate support in the primary material and was removed.

## Car, course and release

A world unit remains one metre. The driving HUD displays horizontal chassis velocity × 3.6, with no speedometer multiplier or hidden distance scale. Full-throttle engine acceleration is 7 m/s² (previously 1.8); forward speed is capped at 46 m/s = 165.6 km/h (previously 22 m/s = 79.2 km/h). Small sideslip can make planar speed exceed the forward cap by hundredths of a m/s. Brake acceleration is 18 m/s²; coasting deceleration .65 m/s².

The grounded speed update is `forward += (7*throttle - 9.81*roadSlope - 18*brake - coast)*dt`, clamped to [0,46]. Downhill therefore contributes up to roughly 3.78 m/s² at the steepest grade. This remains a web-friendly arcade chassis: locked rotation, four suspension rays, authored yaw and Rapier vertical/contact motion; it is not a tire/drivetrain reconstruction. Vertical world gravity remains the project's 20 m/s², while the authored grade acceleration uses 9.81. Those are deliberate model coefficients, not a claim of fully Newtonian vehicle dynamics.

Measured clean 0–50 km/h: **1.98 s**; 0–100: **3.37 s**. Flat-ground analytic values for the engine alone would be 1.98 / 3.97 s, so the descent materially improves 0–100. Clean eject speed: **46.000 m/s (165.6 km/h)**.

| Course point | Drive time, s | Speed, m/s | km/h |
|---|---|---|---|
| Hill bottom | 4.95 | 43.50 | 156.60 |
| After hump | 5.57 | 46.00 | 165.61 |
| After obstacle section | 8.48 | 46.00 | 165.60 |
| Launch-zone entry | 8.53 | 46.00 | 165.61 |
| Ramp start | 9.18 | 46.00 | 165.60 |

Driving time excludes the countdown; physical simulation time slows during angle selection. Steering retains the speed-sensitive rate `1.5/(1+abs(speed)/9) * min(1,abs(speed)/3)` rad/s: about .245 rad/s (14.1°/s) at 46 m/s. Heading cannot instantly zig-zag with A/D. Obstacle sensors are breakaway contacts, not full dynamic balls: each hit removes `speed*(.12 + .045*radius)` from forward speed, with an aggregate 55% per-step ceiling, and deflects heading by .075 rad. At 46 m/s a 1.7 m ball costs approximately 9.04 m/s. Real keyboard collisions caused lost speed, heading disturbance and missed throws; recovery is possible on the remaining runway.

Course changes follow measured timing rather than simply moving the pins closer:

| Dimension | Before | Final |
|---|---|---|
| Start Z / plateau ahead | −178 / 8 m | −267 / 12 m |
| Downhill horizontal / drop | 58 / 26 m | 87 / 26 m |
| Crest / bottom easing | 8 / 18 m | 12 / 27 m |
| Hump length / rise | 12 / .8 m | 18 / .4 m |
| Obstacle rows, Z | −84, −56, −28, −10 | −126, −84, −42, −15 |
| Marked angle zone | Z 6–29, 23 m | Z −8–29, 37 m |
| Ramp length / rise | 7 / 1 m | 7 / 1 m |
| Lip to head pin | 90 m | 170 m |
| Course bounds length | 330 m | 505 m |
| Road / landing width | 12 / 10 m | 12 / 10 m |

Start to hill bottom takes 4.95 s; hill bottom to marked launch zone 3.57 s. At full speed, the zone is about .80 simulation seconds or 2.01 real seconds while entirely in 0.4× bullet time. A clean useful release reaches the rack around 4.5 simulation seconds later. Original footage supports the broad spatial rhythm and multi-second flight, but exact reference timing is not asserted from the sampled/edited video. The faster first prototype crossed the old rack in 2.2 seconds; that measurement motivated the longer flight section. The lowered, lengthened hump preserves a brief suspension unload without the long high-speed drift of the old hump. The car-only stop is now 6 m tall, so the chassis cannot jump over its old low barrier. It remains excluded from pin scoring.

## Angle instrument and launch formula

SPACE down inside the marked area starts 0.4× time and the automatic sweep. The car keeps moving. Angle is `min(90, 60*heldPresentationSeconds)` degrees: 0–90°, 60°/real second, .5 s to 30°, 1.5 s to 90°. Release immediately ejects; Up/Down never changes the pre-launch angle. Long holds can overshoot the useful window or pass the lip. The 60°/s rate is an explicit adaptation, not a measured FlatOut constant.

The original SVG semicircle at bottom left has ticks, a needle, readable degrees and low/high endpoints. Angle snapshots publish at ~20 Hz during selection; the needle interpolates over 70 ms. It locks after release. Reduced-motion preference disables interpolation. The complementary bottom-right `km/sa` display shows actual planar car speed while driving and labels actual body speed during flight. Unlike the frozen car-speed readout seen in reference impact frames, Party Lab's flight display is live body velocity.

For car velocity `(vx,vy,vz)`, heading `h`, selected angle `a`:

```
F = max(0, vx*sin(h) + vz*cos(h))
S = vx*cos(h) - vz*sin(h)
eject.x = sin(h)*F*cos(a) + cos(h)*S
eject.y = F*sin(a) + .15*vy
eject.z = cos(h)*F*cos(a) - sin(h)*S
```

The old 1.46 gain is now 1. Actual forward speed supplies launch energy; sideslip and a small measured ramp-rise contribution remain. No selectable power or minimum-speed repair exists. A 62 m/s safety ceiling is outside normal launch speeds and did not activate in the final 500 throws. Body parts also receive the coherent rotational velocity `omega × offset` rather than independent random kicks.

## Loose body, four-direction control, drag and Nudge

Conscious joint motors, posture assistance, walking and balance remain disabled after ejection. Anatomical joints and broad passive shoulder limits remain. Deterministic spin in the car's heading frame is `(1.1+.025*speed+.009*angle−.7*carPitch, .6*heading, .035*carVx+.3*carPitch)`. Every body gets that angular velocity and its corresponding rotational linear velocity. There is no random spin roll.

A/D (or left/right arrows) apply yaw/roll aerobatics; W/S (or up/down arrows) apply pitch aerobatics. Torque now acts on torso and pelvis. Core impulses are distributed 55% torso / 45% pelvis, and joints carry the limbs, replacing the old uniform trajectory-velocity shift. Modest opposing limb/torso torques retain flailing. Limits remain .9 m/s² lateral acceleration, .8 m/s lateral correction speed, 1.65 m total correction travel, .5 m/s² vertical correction and .7 m/s total pitch-velocity budget. Trajectory effects are deliberately smaller than the visible posture change.

Air-control effort is `min(1,hypot(steer,pitch))`. Each 1/60 s step subtracts the pelvis's horizontal velocity multiplied by `1−exp(−.36*effort*dt)` equally from each part. This preserves relative limb velocities while charging more drag for stronger or longer input. Passive linear damping is .035/s. Nudge never alters either term.

SPACE after release applies **one upward impulse of `partMass*2.6` to each part**, equivalent to +2.6 m/s vertical velocity (8.84 total impulse units for the 3.4 mass-unit ragdoll). No horizontal impulse, drag relief or recharge. Subsequent presses do nothing; ground/pin contact disables unused aerial Nudge. The HUD explicitly shows **NUDGE · HAZIR** or **NUDGE · KULLANILDI**. Tests verify the mass-weighted velocity increment and equal drag with/without Nudge.

## Landing, pins and stability

Bowling-only body friction is .20, lane friction .36, body restitution .16, airborne angular damping .10, post-contact linear damping .10. Gravity changes from 10 m/s² airborne to 20 m/s² after first ground contact. Horizontal momentum survives landing; early contact loses useful speed through repeated limb contacts, tumbling and sliding. Some limb-first impacts redirect momentum into a sizable bounce and can miss above the rack; this is a remaining arcade behavior, not a FlatOut coefficient match.

Ten pins retain their readable scale and existing physical tuning: 1.5 m high, 1.12 m spacing, mass 1.6 each, friction .38, restitution .12, linear damping .12 and angular damping .22. No pin retune or scoring assistance was needed. Central energy transfer matters; glancing or high passes often leave most pins standing.

All moving bodies retain CCD. Bowling uses one CCD substep and four additional solver iterations on the ragdoll. A controlled impact comparison found that two CCD substeps could produce light-hand velocity spikes; the final solver setup removed all observed linear clamps across 500 throws. Shared physics settings are untouched.

| Final 500-throw safety metric | Result |
|---|---|
| Maximum observed part speed | 61.08 m/s |
| Maximum part separation | 1.74 m |
| Invalid transforms | 0 |
| Body deck penetrations (< −.15 m inside deck) | 0 |
| Car deck penetrations | 0 |
| Linear speed clamps / invalid-body retries | 0 / 0 |

The 20 rad/s angular safety limit remains. No finite sample proves every possible input safe; these are the measured limits of this pass.

## Controlled experiments

All approach-speed trials use throttle/brake and normal driving, never injected velocity. All angle trials release the automatic gauge. Actual release angles are slightly quantized by the input sampling interval (25.5° for the nominal 25° series). Simulation seconds are reported, excluding the brief presentation-time slow-motion tail. “Air distance” is horizontal displacement to first ground contact. “Slide” is horizontal travel after that contact, including subsequent tumble/bounces, not exclusively frictional sliding. Crossing the rack plane high above pins is identified as an overflight, not a successful rack entry. Scores are individual deterministic outcomes, not averages.

### Speed: nominal 25° angle, no Nudge or aerobatics

| Target km/h | Actual m/s / km/h | Eject vx,vy,vz m/s | Air time s | Air m | Slide m | Rack | Pins |
|---|---|---|---|---|---|---|---|
| 80 | 22.29 / 80.2 | 0.46, 10.21, 20.11 | 2.20 | 43.06 | 18.67 | Short / miss | 0 |
| 110 | 30.61 / 110.2 | 0.68, 14.10, 27.62 | 2.90 | 76.79 | 32.20 | Short / miss | 0 |
| 140 | 38.93 / 140.1 | 0.76, 17.89, 35.13 | 3.62 | 119.83 | 47.61 | Short / miss | 0 |
| 160 | 44.47 / 160.1 | 0.73, 20.38, 40.13 | 4.08 | 153.05 | 38.62 | At rack (1.7 m high; 26.2 m/s) | 3 |

An immediate Nudge was also tested at 80 and 110 km/h; both still fell short. A poor approach cannot be repaired into a competitive throw.

### Angle: full-speed clean run, no Nudge

| Actual angle | Air time s | Peak m | Landing Z | Air / slide m | Rack | Pins |
|---|---|---|---|---|---|---|
| 10.00° | 2.03 | 6.48 | 117.28 | 89.3 / 88.3 | At rack (0.3 m high; 13.6 m/s) | 3 |
| 25.50° | 4.20 | 23.20 | 190.60 | 162.6 / 27.9 | At rack (1.0 m high; 29.1 m/s) | 3 |
| 40.50° | 6.00 | 47.00 | 218.53 | 190.5 / 1.8 | Over rack (19.6 m high; 37.5 m/s) | 0 |
| 70.50° | 8.53 | 92.28 | 142.91 | 114.9 / 15.1 | Short / miss | 0 |

### Nudge: identical 140 km/h approach, nominal 25°

| Timing (actual s) | Peak m | Air time s | Air / slide m | Rack | Pins |
|---|---|---|---|---|---|
| None | 17.68 | 3.62 | 119.8 / 47.6 | Short / miss | 0 |
| 0.03 | 22.21 | 4.10 | 134.6 / 39.1 | At rack (0.3 m high; 9.5 m/s) | 9 |
| 0.70 | 20.57 | 4.02 | 132.2 / 45.4 | At rack (0.3 m high; 10.3 m/s) | 1 |
| 1.67 | 18.12 | 3.90 | 128.6 / 46.3 | At rack (0.3 m high; 8.2 m/s) | 4 |
| 2.82 | 17.68 | 3.73 | 123.6 / 49.0 | At rack (0.3 m high; 5.7 m/s) | 3 |

Here early Nudge gives the largest range increase; late Nudge adds less range and produces a slower rack arrival. A late Nudge can improve contact height on a different line, as recommended in the contemporary guide, but it is not universally best. At full speed, an early Nudge can overshoot a throw that would score without it. Nudge is optional for viable full-speed throws.

### Aerobatics: same full-speed launch

At 1.0 simulation second, signed corrections and forward-speed loss are compared with no input. Torso up-vectors demonstrate actual orientation differences, independently of trajectory changes.

| Input | ΔX m | ΔY m | Forward loss m/s | Torso up X/Y/Z | Integrated drag loss m/s | Air m | Air distance lost m | Pins |
|---|---|---|---|---|---|---|---|---|
| None | 0.00 | 0.00 | 0.00 | 0.02/-0.94/0.35 | 0.00 | 162.61 | 0.00 | 3 |
| Left .25 s | 0.13 | 0.00 | 3.69 | 0.09/-0.93/0.36 | 3.79 | 147.80 | 14.81 | 10 |
| Right .25 s | -0.24 | -0.00 | 3.69 | -0.06/-0.93/0.36 | 3.79 | 148.27 | 14.34 | 1 |
| Up .35 s | -0.07 | 0.15 | 4.72 | 0.02/-0.99/0.13 | 4.89 | 145.01 | 17.60 | 0 |
| Down .35 s | -0.07 | -0.17 | 4.86 | 0.01/-0.77/0.63 | 4.90 | 142.60 | 20.01 | 7 |
| Continuous left | 0.27 | 0.01 | 12.26 | 0.19/-0.89/0.41 | 30.72 | 84.93 | 77.69 | 0 |

No input maximizes airborne distance in this series. Short corrections cost a modest fraction; continuous input loses almost half the range and misses. Later bounce/slide distances can reorder total travel, because physical body orientation changes the collision response. The one ten-pin controlled correction does not imply a generally repeatable strike across all course layouts.

## 500 seeded competent throws

Seeds are scanned in order, retaining the pre-existing competency definition `botThrow.quality >= .18` before any result is known. Bots drive the physical car, encounter normal obstacles, hold/release the same automatic gauge, use the same force/drag budgets, Nudge once and hit physical pins. No outcomes are filtered or injected. Bots use bounded analog input values; keyboard players approximate those through brief presses, so this is a physical difficulty survey, not a direct prediction of human success rates.

| Pins | Count | Percentage |
|---|---|---|
| 0 | 217 | 43.4% |
| 1–3 | 82 | 16.4% |
| 4–6 | 103 | 20.6% |
| 7–9 | 79 | 15.8% |
| 10 | 19 | 3.8% |

Average **3.050 pins**; average eject speed **44.55 m/s (160.4 km/h)**; average angle **27.24°**. Nudge used in 491/500 throws, mean timing 2.44 s. Mean aerobatics duration 0.508 s. Zero missed launches and zero invalid retries. The sample includes 285 average and 215 good profiles under the existing skill labels; good profiles alone averaged 3.74 pins with 12/215 strikes (5.6%).

A separate fixed-recipe survey used six layouts × five angles (18/22/25/28/32°) × no/1.5 s Nudge: 60 runs, zero strikes, best nine pins, 37 scoring throws. All crossed the head-pin plane; 35 entered within 2.3 m height and ±2.5 m lateral position. Thus “reach” alone is not confused with useful impact. Several angles score without Nudge. An exactly repeated state/input sequence remains deterministic and can repeat its outcome; preventing that would conflict with determinism. The tested difficulty claim is resistance to one forgiving recipe across layout and input variation.

## Headed Chrome, performance and final validation

Headed Google Chrome (Metal GPU) ran 34 individual keyboard throws plus four complete matches. Inputs were real `page.keyboard` down/up events and menu clicks; the harness read telemetry but never set body velocity, angle, scores or gameplay state. Both 1440×900 and 1366×768 covered clean acceleration, obstacle collision/recovery, moving SPACE selection, low/medium/excessive angles, all four aerobatics directions, continuous-drag failure, early/late Nudge and repeat attempts, early landing/long slide, pin entry, strike and gutter/miss. Both two- and three-player matches were completed at each resolution, including normal bot turns.

The supplemental no-obstacle-contact approaches reached 46.000 m/s (165.6 km/h), released at 25°, and scored three pins at 1440×900 and four at 1366×768 without Nudge. The original steering route hit one prop before recovering to full speed. Low-angle keyboard throws slid about 89 m after first contact; continuous correction reduced airborne travel to about 85 m and scored zero. Late Nudge produced six pins at both sizes. Slower approaches with Nudge scored six/seven. Excessive high-angle and gutter cases scored zero.

| Viewport | Players | Per-player three-round scores | Wall time | Retries |
|---|---|---|---|---|
| 1440×900 | 2 | 4/8/5; 0/0/10 | 147.0 s | 0 |
| 1366×768 | 3 | 9/8/5; 0/0/8; 3/5/0 | 229.1 s | 0 |
| 1366×768 | 2 | 6/8/5; 0/0/8 | 157.3 s | 0 |
| 1440×900 | 3 | 6/8/7; 0/0/10; 3/3/0 | 226.2 s | 0 |


Individual keyboard strikes: 1366-strike-attempt, 1440-strike-followup-3. Timing/line variation also produced seven or fewer pins from similar attempts; no score was forced.

Visual review of captured driving, selection, flight and sliding frames confirms an original semicircular angle instrument, large numeric degrees, distinct live speed and Nudge status, and no HUD overlap at either resolution. The gauge remains 272 px wide; its 70 ms interpolation follows the rising angle snapshots, while release freezes the selected value. Camera frames show the loose inverted/flailing body. Peripheral readability is a design assessment from these views, not a human usability study. Screenshots include `1366-strike-attempt-angle.png`, `1440-no-hit-clean-flight.png` and all four match-completion captures in the evidence directory.

One preliminary harness run was interrupted by a source-comment HMR reload; the interrupted case was rerun after freezing runtime source. Completed final cases had zero browser exceptions and zero recovery retries. All results here use the final one-CCD-pass/four-extra-iteration configuration.


### Performance measurement limits and results

These are debug-enabled local measurements, not a hardware-independent guarantee. Browser samples contain rolling averages (240 render frames, 1,200 physics steps), so averages below are means of those sampled windows, not raw global frame quantiles. JS covers the Bowling update callback and excludes total renderer/GPU work. FPS is the rolling frame-rate estimate.

| Viewport | Sampled FPS mean / minimum | JS update mean ms/frame | Physics mean ms/step | Median rolling physics p99 ms | Worst step ms |
|---|---|---|---|---|---|
| 1440 | 60.07 / 59.7 | 0.363 | 0.278 | 0.700 | 20.30 |
| 1366 | 60.07 / 59.3 | 0.385 | 0.291 | 0.800 | 18.80 |


4926 telemetry samples; 20 dynamic bodies, 396 colliders, up to 28 draw calls and 114,574 triangles. Worst observed rolling physics p99 was 20.30 ms. Occasional physics spikes exceeded a 16.7 ms frame budget, but the rolling FPS remained near 60; this is not a claim of zero frame-time spikes.

Rapier `timingCcd()` returned zero throughout this WASM build, so isolated CCD timing is unavailable—not evidence that CCD is free. An interleaved 24-pair CCD-on/off ablation, discarding four warm-up pairs, measured 27,320 steps per condition: enabled mean .0476 ms / p99 .1480 ms; disabled mean .0490 ms / p99 .1555 ms. Pre-impact flight means were .0672/.0691 ms. The difference is below timing noise; no measurable aggregate overhead was isolated. The shipped game always keeps CCD enabled. Combined with the 500-throw penetration, finite-body and clamp checks above, this supports the chosen stable 46 m/s region without claiming exhaustive safety.


### Required validation

- Complete frontend + edge suite: **545/545 passed**, no skips or cancellations. This includes the existing local/server integration coverage.
- Bowling regressions: **35/35 passed**.
- TypeScript (`npx tsc --noEmit`), standalone validator typecheck and production build passed; build 5.88 s. Existing large-chunk warnings remain.
- `git diff --check` passed. Initial backup inventory is intact; only the listed Bowling files differ from the session-start snapshot.
- No shared/server code changed, so a separate server-only change-validation run was unnecessary.
- All six existing deterministic mode hashes match their baselines:


| Mode | Unchanged SHA-256 |
|---|---|
| Rooftop | `8d89030cf2d5752364f82321950b42a6aa1100986c329955a5969c1876661de6` |
| Barn | `88562a77268129b7f9601a990678cd87037fe3e5e51d7b7d8e637c345de5fc94` |
| Layer Chaos | `ef1303cc5b33cf14a3e6fe7211d2ebbdc50ae0dc8a6f827d088530afe625a069` |
| Color Chaos | `818900429dd23650e989ef4545e55a70257bb90938a4e3453e048385c9fefea6` |
| Bomb Tag | `5be7de86b5f30dd9b1db691edf2463fc018fe13196fa63e7fb8306bdf05bf8d2` |
| Prop Hunt | `0c359d893dbb349c394cbfb640b3dbd299ac4791b7828a1004f504e84b076ed0` |

## Scope, files and remaining differences

External backup: `/private/tmp/human-bowling-before-parity-20260927.tgz`; original tracked patch: `/private/tmp/human-bowling-initial.diff`. Every file in that backup still exists. `ArenaScene.tsx` is byte-identical to the session-start uncommitted version. Bowling assets and all unrelated work were preserved.

Files changed in this pass:

- `config.ts`: real speed/acceleration, coherent course distances, angle/flight/Nudge/drag/landing coefficients and bot target ranges.
- `car.ts`: speed-proportional obstacle losses.
- `game.ts`: remove Nudge drag relief, deterministic launch rotation, core aerobatics impulses/torques, local impact solver settings and taller car-only stop.
- `camera.ts`: speed FOV range and low crest viewpoint recalibrated to the longer course.
- `visual.ts`: existing original scenery/markings aligned with the longer driving/landing sections and stop net.
- `BowlingHud.tsx`, `bowling.css`: original radial angle instrument, separate speed display and explicit Nudge state.
- `BowlingPlayground.tsx`: debug-only CCD profiling telemetry.
- `../bowling.test.ts`: adapt existing regressions to the new geometry/physics and verify removal of Nudge drag relief.
- New `PARITY_AUDIT.md`, `PARITY_REPORT.md`, and `scripts/validate-party-lab-bowling-parity.ts`.

Remaining meaningful differences: one simplified rotation-controlled car rather than FlatOut vehicle classes/drivetrain/damage; sensor breakaway props rather than full dynamic obstacles; nine-part stylized ragdoll and original mass/inertia/force coefficients; bounded correction budgets; changing airborne/ground gravity; occasional strong limb-first bounces; three raw-score local rounds rather than the reference's five-round/bonus structure; SPACE instead of CTRL; live body-speed HUD during flight; original Party Lab art/audio/UI. Exact reference angle rate, forces, metres and friction remain unknown. No proprietary assets, sounds, textures or artwork were copied.

Rooftop, Barn, Layer Chaos, Color Chaos, Bomb Tag and Prop Hunt remain unchanged. Protocol remains 9. No shared defaults, PartyRoom, online lobby or Mixed changes. No online Bowling, commit, push or deployment.

Reproduce the physical survey with:

```
node --import tsx scripts/validate-party-lab-bowling-parity.ts /private/tmp/bowling-parity-recheck 500
```

Raw measurements, Chrome screenshots, keyboard harness, solver comparison and validation logs are in `/private/tmp/bowling-parity/`. Prior Bowling reports describe earlier iterations; this report and `PARITY_AUDIT.md` describe this pass.
