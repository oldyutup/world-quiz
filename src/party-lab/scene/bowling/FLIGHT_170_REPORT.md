# Human Bowling — fixed 170.5 m flight calibration

Local only. Protocol **9**. The only gameplay change is `FLIGHT.gravityScale: .5 → .35`. Rack lip **z=29**, head pin **z=199.5**, distance **170.5 m**, pin height **7.2 m**, pin mass **13.5 kg**, spacing **4.032 m**, car tuning, obstacles, scenery, controls, scoring and online code are unchanged. Existing uncommitted work is preserved. No commit, push or deployment.

**1. Root cause and before-tuning measurements.** The former 10 m/s² airborne gravity spent the available height too quickly for this longer course. At 145 km/h, 20–30° first landed 62.0–33.5 m before the head pin; recovery consumed the forward energy. None of those three scored. At 155 km/h only the 30° sample scored, after ground recovery. The 165/30° sample was the only airborne pin contact in the requested 20-shot baseline.

Every baseline and final simulation drives from the actual start through the authored obstacles, regulates speed with throttle/brake, and holds/releases the real angle gauge through BowlingClock. No car teleport, injected launch velocity, forced angle, forced pin result, or reroll. Baseline was completed before any source tuning.

| Target km/h | Actual km/h | Angle ° | Air m | First ground z | Rack y | Rack vz | Rack vy | Class | Pins |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 135 | 135.20 | 10.00 | 61.46 | 89.76 | — | — | — | SHORT | 0 |
| 135 | 134.89 | 15.00 | 80.21 | 107.88 | — | — | — | SHORT | 0 |
| 135 | 135.20 | 20.00 | 96.83 | 125.12 | — | — | — | SHORT | 0 |
| 135 | 135.20 | 25.00 | 110.76 | 139.05 | — | — | — | SHORT | 0 |
| 135 | 134.89 | 30.00 | 120.97 | 148.63 | — | — | — | SHORT | 0 |
| 145 | 144.94 | 10.00 | 69.63 | 97.63 | — | — | — | SHORT | 0 |
| 145 | 144.94 | 15.00 | 91.28 | 119.29 | — | — | — | SHORT | 0 |
| 145 | 144.94 | 20.00 | 109.51 | 137.50 | — | — | — | LONG | 0 |
| 145 | 144.94 | 25.00 | 126.15 | 154.14 | 0.30 | 7.80 | -0.01 | LONG | 0 |
| 145 | 144.94 | 30.00 | 138.05 | 166.05 | 2.07 | 3.72 | 2.80 | LONG | 0 |
| 155 | 155.21 | 10.00 | 79.21 | 107.15 | — | — | — | SHORT | 0 |
| 155 | 155.21 | 15.00 | 102.79 | 130.73 | 0.31 | 1.38 | -0.03 | LONG | 0 |
| 155 | 155.21 | 20.00 | 124.48 | 152.41 | 0.34 | 12.72 | 0.54 | LONG | 0 |
| 155 | 155.21 | 25.00 | 142.91 | 171.56 | 0.31 | 2.57 | 0.25 | MEDIUM | 0 |
| 155 | 155.21 | 30.00 | 156.61 | 184.54 | 0.68 | 21.12 | 0.62 | MEDIUM | 2 |
| 165 | 165.26 | 10.00 | 89.06 | 117.13 | 0.43 | 7.93 | -0.42 | LONG | 0 |
| 165 | 165.26 | 15.00 | 114.75 | 142.81 | 2.60 | 12.58 | -6.74 | LONG | 0 |
| 165 | 165.26 | 20.00 | 140.12 | 168.18 | 0.31 | 2.78 | 1.38 | LONG | 1 |
| 165 | 165.26 | 25.00 | 160.08 | 188.13 | 3.77 | 26.36 | 2.53 | NEAR | 4 |
| 165 | 165.26 | 30.00 | 174.50 | 202.57 | 3.36 | 8.14 | -4.10 | AIRBORNE | 2 |

Positions are metres; velocities are m/s. Rack values are the actual pelvis head-plane crossing, after any earlier collision. A leading hand can hit a pin without the pelvis crossing, so a missing rack sample does not mean no contact. `Air m` is horizontal displacement to first ground contact; if no ground is reached it is displacement at throw completion, **not a predicted landing range**. Pin collisions can change that distance.

**2–5. Explicit tuning values.**

| Value | Before | After |
| --- | --- | --- |
| Airborne gravity | −10 m/s² (.50 × −20) | −7 m/s² (.35 × −20) |
| Ground gravity | −20 m/s² | unchanged |
| Launch forward transfer | 1.00 × car forward velocity | unchanged |
| Ramp vertical transfer | 0.15 × actual ramp velocity | unchanged |
| Nudge Δv, forward / up | 1.8 / 2.6 m/s | unchanged |
| Passive airborne linear damping | 0.035/s | unchanged |
| Ground-contact damping | 0.10/s | unchanged |
| Active aerobatics drag | 0.018/s, rising toward 0.050/s with sustained effort | unchanged |
| Air acceleration / lateral cap / travel budget | 1.8 m/s² / 1.8 m/s / 4 m | unchanged |
| Car acceleration / maximum speed | 7 m/s² / 46 m/s | unchanged |

The profile is a fixed Bowling-local constant, independent of rack distance, current range, angle, pin contact or score. No added forward launch energy. Gravity remains reduced while airborne and returns to the existing normal value at physical ground contact. The 0–30° oscillating gauge, one-use SPACE Nudge, frozen-launch-yaw WASD semantics, loose joints, physical pins and ground recovery remain intact.

**6. Useful human region.** **145–155 km/h** is the main band. Start near **145/25–27°**, **150/23–25°**, or **155/19–23°**, without Nudge. Lower angles offer recovery entries; higher ones move contact up the pin bodies and eventually pass above them. At 135–140 km/h good angle/Nudge timing matters more. At 160–165 km/h use less angle (roughly 18–21°); high angles are intentionally risky. These are measured starting recipes, not guaranteed pin counts. Lateral aim and release position still matter.

**7. Dense speed × angle map.** 128 full-course no-Nudge approaches: 130–165 km/h in 5 km/h steps, 0–30° in 2° steps. Each cell is entry class + physical pin score.

`A` AIRBORNE: real pin contact before ground. `N` NEAR: pin contact after landing ≤12 m before the head plane. `M` MEDIUM: landing 12–30 m before it. `L` LONG: landing >30 m before it. `O` OVERFLIGHT: no pin contact and an airborne rack-plane pelvis above pin height +1 m. `S` SHORT: no rack reach/contact. `X` MISS: rack depth reached without contact and without that overflight condition. Classification is diagnostic only. Contact does not guarantee sufficient pin tilt to score.

| km/h | 0° | 2° | 4° | 6° | 8° | 10° | 12° | 14° | 16° | 18° | 20° | 22° | 24° | 26° | 28° | 30° |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 130 | S0 | S0 | S0 | S0 | S0 | S0 | S0 | S0 | S0 | S0 | L0 | L0 | L0 | M0 | M0 | M0 |
| 135 | S0 | S0 | S0 | S0 | S0 | S0 | S0 | S0 | L0 | L0 | L0 | M1 | M1 | M0 | N0 | N0 |
| 140 | S0 | S0 | S0 | S0 | S0 | S0 | S0 | L0 | L0 | L0 | M0 | M1 | M1 | N1 | A0 | A2 |
| 145 | S0 | S0 | S0 | S0 | S0 | S0 | L0 | L0 | L0 | M0 | M1 | N2 | N1 | A3 | A2 | A1 |
| 150 | S0 | S0 | S0 | S0 | L0 | L0 | L0 | L0 | L0 | M1 | N1 | A0 | A5 | A1 | O0 | O0 |
| 155 | S0 | S0 | S0 | L0 | L0 | L0 | L1 | L0 | M1 | N3 | A0 | A4 | A1 | O0 | O0 | O0 |
| 160 | S0 | S0 | S0 | L0 | L0 | L0 | L1 | M1 | M1 | A0 | A5 | A1 | O0 | O0 | O0 | O0 |
| 165 | S0 | S0 | L0 | L0 | L0 | L0 | L1 | M1 | N2 | A4 | A3 | O0 | O0 | O0 | O0 | O0 |

Detailed air distance, first ground position and rack-plane height/velocities: [final CSV](/private/tmp/bowling-flight-170/final/speed-angle-map.csv).

**8. No-Nudge recipes and angle tolerance.** The seven samples at each of 145/25°±3°, 150/23°±3° and 155/21°±3° **all contacted pins**. Each group includes at least four airborne entries and five scoring throws. The wider lower-angle recovery behavior is preserved; no scoring reward is tied to angle.

| Target | Angles, −3° through +3° | Classes | Pins |
| --- | --- | --- | --- |
| 140 km/h / 27° | 24, 25, 26, 27, 28, 29, 30 | M, N, N, N, A, A, A | 1, 0, 1, 0, 0, 2, 2 |
| 145 km/h / 25° | 22, 23, 24, 25, 26, 27, 28 | N, N, N, A, A, A, A | 2, 0, 1, 2, 3, 3, 2 |
| 150 km/h / 23° | 20, 21, 22, 23, 24, 25, 26 | N, N, A, A, A, A, A | 1, 0, 0, 3, 5, 3, 1 |
| 155 km/h / 21° | 18, 19, 20, 21, 22, 23, 24 | N, N, A, A, A, A, A | 3, 4, 0, 4, 4, 2, 1 |
| 160 km/h / 20° | 17, 18, 19, 20, 21, 22, 23 | N, A, A, A, A, A, O | 1, 0, 4, 5, 3, 1, 0 |

The transition changes contact height and landing position gradually. Pin counts are naturally discontinuous because limb contact, pin tilt and pin-to-pin collisions are physical.

**9. Nudge rescue.** At 135/26°, no Nudge gave MEDIUM recovery/0 pins. The unchanged Nudge at 1.2 s gave airborne contact at **4.09 m**, forward velocity **29.7 m/s**, and **2 pins**. Early 0.3 s Nudge gave airborne contact/3 pins; waiting until 2.8 s gave NEAR/0. At 145/22°, the late 2.8 s Nudge changed a recovery entry into airborne contact at 3.07 m/2 pins. No impulse is added after the one allowed use.

**10. Nudge overflight.** At 145/26°, no Nudge gave airborne contact/3 pins; Nudge at 0.3 s cleared the rack at pelvis height **18.5 m**, 0 pins. At 150/26°, no Nudge gave airborne contact/1 pin; 0.3 s Nudge cleared it at **23.2 m**, 0 pins. The force is identical in rescue and overflight examples.

**11. Overflight frequency.** The main 30 headed attempts include **4/30 (13.3%)** overflights: both deliberate 165/30° throws and both early-Nudge 150/26° throws. There were **0 overflights in the 21 launched normal no-Nudge 145–160 km/h cases** (one additional normal attempt missed its release window). These scenarios were chosen to exercise useful play and failure modes, so this is not a human population estimate. The unchanged 500-seed bot policy is a separate, near-maximum-speed cohort: **188/500 (37.6%)** overflight, including **83/280 (29.6%)** without Nudge and **105/220 (47.7%)** with Nudge. That bot policy was not retuned; it averages 164.92 km/h and often uses excessive angle/Nudge for the new gravity.

**12. Airborne rack impacts and rear safety.** Pre-first-contact, mass-weighted forward/vertical velocities avoid confusing tumble or impact loss with approach momentum. Representative full-course no-Nudge samples:

| km/h | ° | Contact height m | Forward m/s | Vertical m/s | Pins |
| --- | --- | --- | --- | --- | --- |
| 145 | 26 | 3.75 | 30.40 | -16.98 | 3 |
| 145 | 27 | 5.51 | 30.05 | -16.72 | 3 |
| 150 | 23 | 3.87 | 32.59 | -15.99 | 3 |
| 150 | 24 | 5.89 | 32.26 | -15.69 | 5 |
| 155 | 22 | 6.52 | 34.18 | -14.75 | 4 |
| 160 | 20 | 5.44 | 36.06 | -14.35 | 5 |
| 165 | 18 | 3.66 | 37.89 | -13.86 | 4 |

Focused rear stress: **24 throws**, including **17 overflights**, produced zero invalid values, zero surveyed floor penetrations, maximum limb/pelvis separation **1.49 m**, maximum pin speed while above y=−3 of **8.76 m/s**, and maximum ragdoll-part speed above y=−3 of **48.18 m/s**. A 145/22° early-Nudge airborne graze physically hit the rear catcher (7 solver-contact observations). High overflights can clear the existing 2 m physical catcher and leave the finite floor; the existing out-of-bounds/settling lifecycle resolves those misses. The catcher is **not a tall invisible wall**, and its geometry was not enlarged. No new overflight trigger, score penalty, teleport or assist was added.

Across the 500 seeds: zero invalid/retry events, zero sampled floor penetrations, maximum part separation **1.79 m**, and zero launch/airborne cap events before impact. Eleven throws used the existing speed guard later (including continued off-course falling while pins settled); this is not reported as “zero cap events.” Raw measurements preserve those counts.

**13. Headed keyboard results.** Google Chrome, headed, real keyboard down/up events, 1440×900 and 1366×768. Inputs use a roughly 55–79 ms driving/air-control cadence and a faster gauge check. State is observed for telemetry and steering; no gameplay state/velocity/angle/score is written. Each attempt starts at the top of the full course. This is automated keyboard testing, not a human participant study. All 30 primary attempts are retained, including the missed launch. Four supplementary attempts bring the total to **34 attempts / 33 launches**.

| # | Attempt | km/h | ° | Nudge s | Class | Pin contact y | Pins | Retries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1440-145-22 | 143.99 | 21.67 | — | MEDIUM | 3.86 | 2 | 0 |
| 2 | 1440-145-25 | 144.10 | 25.00 | — | NEAR | 1.31 | 1 | 0 |
| 3 | 1440-145-28 | 143.97 | 27.78 | — | AIRBORNE | 2.79 | 1 | 0 |
| 4 | 1440-150-20 | — | — | — | MISS | — | 0 | 0 |
| 5 | 1440-150-22 | 149.20 | 21.67 | — | NEAR | 0.85 | 1 | 0 |
| 6 | 1440-150-24 | 148.95 | 23.89 | — | AIRBORNE | 3.32 | 0 | 0 |
| 7 | 1440-150-26 | 149.27 | 25.56 | — | AIRBORNE | 4.22 | 1 | 0 |
| 8 | 1440-160-20 | 158.85 | 20.00 | — | AIRBORNE | 4.55 | 4 | 0 |
| 9 | 1440-165-30 | 163.90 | 30.00 | — | OVERFLIGHT | — | 0 | 0 |
| 10 | 1440-135-26-base | 134.12 | 25.69 | — | MEDIUM | 0.15 | 0 | 0 |
| 11 | 1440-135-26-rescue | 134.33 | 25.56 | 1.25 | AIRBORNE | 2.00 | 2 | 0 |
| 12 | 1440-150-26-nudge | 149.67 | 25.56 | 0.33 | OVERFLIGHT | — | 0 | 0 |
| 13 | 1440-150-WA | 148.94 | 23.89 | — | AIRBORNE | 2.78 | 3 | 0 |
| 14 | 1440-150-SD | 148.92 | 24.03 | — | AIRBORNE | 1.47 | 2 | 0 |
| 15 | 1440-145-falling | 143.98 | 26.11 | — | AIRBORNE | 2.86 | 2 | 0 |
| 16 | 1366-145-22 | 144.65 | 21.53 | — | MEDIUM | 2.28 | 4 | 0 |
| 17 | 1366-145-25 | 143.97 | 25.00 | — | AIRBORNE | 0.96 | 0 | 0 |
| 18 | 1366-145-28 | 144.31 | 27.78 | — | AIRBORNE | 3.61 | 3 | 0 |
| 19 | 1366-150-20 | 148.85 | 20.56 | — | NEAR | 5.72 | 3 | 0 |
| 20 | 1366-150-22 | 149.17 | 21.67 | — | NEAR | 0.65 | 4 | 0 |
| 21 | 1366-150-24 | 149.26 | 23.89 | — | AIRBORNE | 3.34 | 2 | 0 |
| 22 | 1366-150-26 | 149.38 | 25.56 | — | AIRBORNE | 7.41 | 5 | 0 |
| 23 | 1366-160-20 | 159.74 | 20.00 | — | AIRBORNE | 4.73 | 4 | 0 |
| 24 | 1366-165-30 | 164.19 | 30.00 | — | OVERFLIGHT | — | 0 | 0 |
| 25 | 1366-135-26-base | 134.22 | 25.56 | — | MEDIUM | 6.94 | 1 | 0 |
| 26 | 1366-135-26-rescue | 134.21 | 25.56 | 1.20 | AIRBORNE | 3.04 | 1 | 0 |
| 27 | 1366-150-26-nudge | 149.12 | 25.56 | 0.33 | OVERFLIGHT | — | 0 | 0 |
| 28 | 1366-150-WA | 148.96 | 23.89 | — | AIRBORNE | 1.75 | 0 | 0 |
| 29 | 1366-150-SD | 148.95 | 24.44 | — | AIRBORNE | 1.57 | 4 | 0 |
| 30 | 1366-145-falling | 144.16 | 26.11 | — | AIRBORNE | 2.02 | 4 | 0 |
| 31 | 150-20-retry | 149.22 | 20.00 | — | MEDIUM | 0.29 | 0 | 0 |
| 32 | 135-rescue-second-press | 134.03 | 25.56 | 1.20 | AIRBORNE | 2.97 | 3 | 0 |
| 33 | 165-18-upper | 164.20 | 17.78 | — | AIRBORNE | 2.05 | 1 | 0 |
| 34 | 150-24-neutral-performance | 149.06 | 23.89 | — | AIRBORNE | 3.68 | 2 | 0 |

Both ~134 km/h rescue pairs changed from ground recovery to airborne entry. The 1440 pair improved 0→2 pins; the 1366 pair remained 1→1 while changing entry type. The extra repeated-SPACE rescue scored 3; its recorded Nudge activation remained single-use. WA and SD taps still produced real airborne impacts with forward momentum. At 150/24° in controlled shots, A/D retained **99.5%** of neutral forward velocity after 0.25 s input, **99.0%** after 0.5 s, and **97.7–97.9%** after 1 s; W/S 0.5 s retained **100.0% / 99.0%**.

All 34 attempts had zero physics retries and zero browser exceptions; all instrument bounds fit. The missed release occurred at z=30.20 (past z=29) while reading 20° and is a launch-timing error, not a short flight. The supplementary earlier-release retry reached the rack by recovery. Screenshots were inspected for airborne rack approach and visible overflight: [airborne approach](/private/tmp/bowling-flight-170/keyboard/1366-150-24-rack.png), [overflight](/private/tmp/bowling-flight-170/keyboard/1440-165-30-rack.png).

**14. 500-seed distribution.** First 500 sequential seeds satisfying the existing pre-throw `botThrow(seed,1,1).quality >= .18`; no outcome filtering or rerolls. All six obstacle variants; same car, course, clock, Nudge, ragdoll and pins.

| Pins | Throws |
| --- | --- |
| 0 | 248 |
| 1–3 | 209 |
| 4–6 | 41 |
| 7–9 | 2 |
| 10 | 0 |

Mean **1.158 pins**. Entry counts: AIRBORNE **128**, NEAR **39**, MEDIUM **62**, LONG **83**, OVERFLIGHT **188**, SHORT **0**, MISS **0**. All 500 reached rack depth or real contact. Zero strikes is an observed result, not a cap or forced difficulty. This pass improves the human flight envelope; it does not optimize the pre-existing bot strategy or giant-pin mass/scoring.

**15. Performance.** Rolling debug measurements during flight, including screenshot and tool activity. Some primary trials overlapped the survey/build; supplemental trials ran after the large survey. No slow samples were discarded.

| Metric | 30 primary attempts | 4 supplemental attempts |
| --- | --- | --- |
| FPS, median / minimum | 60.0 / 59.2 | 60.0 / 59.7 |
| Physics average, median / highest rolling average | 0.535 / 0.798 ms | 0.381 / 0.552 ms |
| Physics p99, median / highest rolling p99 | 1.50 / 1.90 ms | 1.20 / 1.40 ms |
| Largest recorded physics step | 19.6 ms | 17.8 ms |
| Bowling JS/frame, median / highest average | 0.776 / 1.084 ms | 0.560 / 0.742 ms |
| Draw calls, median / maximum | 19 / 27 | 19 / 26 |

No new bodies, colliders, per-frame effects or allocations were introduced by the gravity constant. Occasional physics-step spikes remain; rolling FPS is not a hardware-independent guarantee.

**16. Tests and builds.** Bowling suite **50/50 passed**, including new full-approach neighboring-angle and Nudge risk/reward regressions. The old landing-energy fixture used 25° at full speed, which now overflies; it now compares 8°/16° recovery and stops waiting when flight ends. Production **`npm run build` passed** (existing chunk-size advisory). Final **`npx tsc --noEmit` passed**. The standalone flight validator also passes strict TypeScript checking. Online code was not changed or exercised through a server.

**17. Files changed in this pass.**

- `src/party-lab/scene/bowling/config.ts`: gravity .50→.35 and explanatory comment.
- `src/party-lab/scene/bowling.test.ts`: full-course envelope/Nudge regressions and bounded updated landing fixture.
- `scripts/validate-party-lab-bowling-flight.ts`: reusable baseline, dense grid, ±1/2/3°, Nudge, controls, 500-seed and rear-stability survey.
- `src/party-lab/scene/bowling/FLIGHT_170_REPORT.md`: this report.

Existing `ArenaScene.tsx`, all other pre-existing Bowling files/assets/reports, geometry, obstacle layouts, shared/online files and protocol remain unchanged. The before/after hash audit is [preservation.json](/private/tmp/bowling-flight-170/preservation.json).

Evidence: [baseline](/private/tmp/bowling-flight-170/baseline/matrix.json), [dense grid](/private/tmp/bowling-flight-170/final/matrix.json), [perturbations](/private/tmp/bowling-flight-170/final/robustness.json), [Nudge survey](/private/tmp/bowling-flight-170/final/nudges.json), [500 seeds](/private/tmp/bowling-flight-170/final/bots.json), [rear stress](/private/tmp/bowling-flight-170/rear/rear.json), [30 keyboard attempts](/private/tmp/bowling-flight-170/keyboard/results.json), [4 supplemental attempts](/private/tmp/bowling-flight-170/supplement/results.json), [tests](/private/tmp/bowling-flight-170/unit.log), [build](/private/tmp/bowling-flight-170/build.log).
