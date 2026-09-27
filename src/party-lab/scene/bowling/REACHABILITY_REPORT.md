# Local Human Bowling: reachability and oscillating angle gauge

2026-09-27. Local implementation only. Protocol **9**. No commit, push, deployment, online Bowling, PartyRoom, lobby, or Mixed changes. Session-start uncommitted work is preserved.

**1. Rack distance: 170 m → 130 m.** The effective lip remains at z=29; the head pin moves from z=199 to z=159. Rack spacing, pin bodies, colliders, friction, restitution, knockdown rules, scoring, launch energy, gravity, car acceleration/top speed, Nudge, aerobatics drag, and the physical course approach remain unchanged. The existing rack pad/markings follow `headZ`; the runout remains available for overshoots.

**2. Why 130 m.** The controlled full-course matrix reaches at 135 km/h at 15°, 20°, 25°, and 30° without Nudge; all five tested angles reach at 145 km/h and above. Four of five 120 km/h throws stop short. The final headed keyboard batch confirms successful 134 km/h releases, including 7 pins at 25° on the falling pass. More distance was not justified by these results. High speed plus high angle can carry the body over the rack, so reachability does not imply a strike.

**3. Actual keyboard eject speeds.** These are real headed Chrome runs with Playwright keyboard events from the summit through the obstacles. No car/body velocity, position, angle, pin, score, or physics-clock injection was used. The driver uses digital steering/throttle/braking at roughly 65–91 ms decision intervals, and watches the rendered gauge at roughly 12 ms polling intervals. Target speed is not the measured speed; collisions and approach timing remain in the results. This is scripted human-like input, not a claim that a human operator played these runs.

Final batch: 20 approaches, 20 ejections. Actual km/h: **134.0 min / 134.3 P25 / 144.6 median / 154.2 P75 / 164.8 max**; mean 148.3.

| Actual eject km/h | Runs |
| --- | --- |
| Below 130 | 0 |
| 130–<145 | 12 |
| 145–<160 | 3 |
| 160+ | 5 |

**4–6. Angle range, timing and instrument.** Minimum **0°**, maximum **30°**. A linear triangular sweep takes **0.900 presentation seconds up**, **0.900 down**, and **1.800 seconds per complete cycle** (33⅓ degrees/second). It reverses continuously at each endpoint. At 25° there are opportunities at 0.75 s, 1.05 s, 2.55 s, 2.85 s, and so on. The fixed 240 Hz presentation clock is independent of 0.4× simulation time.

SPACE down enters bullet time; the car continues moving and steering works. SPACE up locks the current instrument angle and ejects once. Continuing beyond the valid ramp release area can still miss the throw. The bottom-left original Party Lab instrument has a curved arc, 5° ticks, 0° at its lower end, 30° at its upper end, a needle, a large rounded degree readout, and a subtle ↗/↘ direction cue with accessible text. The precise angle is retained internally; the numeric display rounds to whole degrees. During selection the HUD commits every rendered frame, with no CSS interpolation lag. Captured final-batch needle and simulation angles agree exactly.

**7. Controlled reachability matrix.** Each cell is one complete physical approach using throttle/brake speed regulation and course steering, without Nudge or air correction; no initial-state injection. Ejection is near z=28. Actual speed is within 0.20 km/h of the target. `R / n` means rack depth reached and n pins scored; `Short` means insufficient range and zero pins. Rack reach means crossing the head-pin z-plane or physically knocking a pin with a leading limb, independent of line or height. An airborne overflight can therefore be `R / 0`; this is not counted as a good hit.


| km/h | 10° | 15° | 20° | 25° | 30° |
| --- | --- | --- | --- | --- | --- |
| 120 | Short | Short | Short | Short | R / 3 |
| 135 | Short | R / 9 | R / 1 | R / 9 | R / 0 |
| 145 | R / 6 | R / 7 | R / 3 | R / 6 | R / 0 |
| 155 | R / 5 | R / 3 | R / 6 | R / 0 | R / 0 |
| 165 | R / 6 | R / 0 | R / 0 | R / 0 | R / 0 |

The useful angle changes with speed. At 145 km/h, 10°, 15°, 20°, and 25° score 6, 7, 3, and 6 respectively; 30° overflies for zero. At 155 km/h, the lower three angles score 5, 3, and 6, while 25–30° overfly. At 165 km/h the shallow 10° entry scores 6. Exactly 25° is not universally best.

Same-speed trajectory survey at approximately 145 km/h:

| Selected ° | Air time s | Air distance m | Peak y m | Slide m | Pins |
| --- | --- | --- | --- | --- | --- |
| 0.14 | 0.77 | 30.48 | 2.51 | 89.21 | 0 |
| 5.00 | 1.17 | 46.06 | 3.42 | 85.98 | 0 |
| 8.06 | 1.53 | 59.94 | 4.63 | 74.07 | 6 |
| 10.00 | 1.80 | 69.69 | 5.62 | 67.63 | 6 |
| 15.00 | 2.43 | 91.39 | 8.90 | 45.90 | 7 |
| 20.00 | 3.05 | 109.90 | 13.12 | 50.27 | 3 |
| 25.00 | 3.67 | 125.98 | 18.13 | 14.44 | 6 |
| 30.00 | 4.25 | 138.26 | 23.79 | 42.33 | 0 |

The nominal 0° test releases on the first available presentation tick, at 0.139°. Low angles touch down early and spend far more distance sliding; high angles spend longer airborne. Slide distance includes later tumble and deflection, and is not a straight-line range measurement.

**8. Nudge.** The one-use upward impulse is unchanged. At 120 km/h and 25°, Nudge at 1.2 simulation seconds changes the controlled result from short/0 pins to reached/2 pins: air distance **88.89 → 97.52 m**, and maximum forward position **156.88 → 162.11 m** (head pin z=159). It adds useful airtime without restoring forward energy. At 145 km/h and 25°, the same Nudge changes 6 pins into an overflight/0: it is useful when short, not a universal upgrade. The 135–145 km/h matrix reaches without it.

**9. Aerobatics and drag.** A/D and W/S remain active in flight, with the existing drag and bounded correction budgets. Controlled 145 km/h, 25° results:

| Input | Duration s | Air m | Slide m | Drag loss m/s | Reach | Pins |
| --- | --- | --- | --- | --- | --- | --- |
| None | 0.00 | 125.98 | 14.44 | 0.00 | yes | 6 |
| A/D brief | 0.22 | 116.05 | 47.36 | 2.73 | yes | 0 |
| W brief | 0.30 | 114.05 | 19.09 | 3.72 | yes | 7 |
| S brief | 0.30 | 112.46 | 24.41 | 3.72 | yes | 6 |
| A/D held | 3.67 | 70.62 | 3.00 | 25.53 | no | 0 |

Continuous correction reduces air distance from 125.98 m to 70.62 m and leaves the body short. A final headed keyboard throw at 164.3 km/h also stops short after 1.5 s of correction. No drag relief or forward-energy refill was added.

**10. Final 20 headed keyboard runs.** Rows 1–10 use 1440×900; rows 11–20 use 1366×768. Nudge is its actual simulation-time activation; air control is measured active duration. Distances are measured to first ground contact and during subsequent slide/tumble. Every approach, including poor entries and short throws, is retained.


| Run | Eject m/s | HUD km/h | Angle ° | Sweep | Nudge @ s | Air input s | Air m | Slide m | Reach | Pins |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 37.29 | 134 | 10.00 | rising | — | 0.00 | 56.95 | 69.47 | no | 0 |
| 2 | 37.29 | 134 | 15.00 | rising | 1.22 | 0.00 | 86.79 | 47.54 | yes | 6 |
| 3 | 37.25 | 134 | 20.00 | rising | — | 0.00 | 92.25 | 49.87 | yes | 2 |
| 4 | 37.24 | 134 | 25.00 | falling | — | 0.00 | 106.23 | 31.76 | yes | 7 |
| 5 | 37.26 | 134 | 30.00 | rising | — | 0.00 | 116.61 | 23.85 | yes | 6 |
| 6 | 40.17 | 145 | 19.44 | rising | — | 0.00 | 107.38 | 25.41 | yes | 10 |
| 7 | 40.09 | 144 | 15.00 | rising | — | 0.25 | 80.15 | 54.09 | yes | 5 |
| 8 | 40.09 | 144 | 19.86 | rising | 1.22 | 0.00 | 113.54 | 24.53 | yes | 10 |
| 9 | 40.08 | 144 | 25.00 | rising | — | 0.00 | 122.46 | 23.12 | yes | 6 |
| 10 | 40.01 | 144 | 30.00 | rising | — | 0.00 | 134.40 | 15.44 | yes | 3 |
| 11 | 42.74 | 154 | 10.00 | rising | — | 0.00 | 74.56 | 61.25 | yes | 10 |
| 12 | 42.83 | 154 | 15.00 | rising | — | 0.25 | 90.44 | 47.55 | yes | 6 |
| 13 | 42.76 | 154 | 20.00 | rising | 1.20 | 0.00 | 135.03 | 42.94 | yes | 7 |
| 14 | 40.15 | 145 | 25.00 | falling | — | 0.00 | 124.01 | 15.91 | yes | 7 |
| 15 | 40.25 | 145 | 30.00 | rising | — | 0.00 | 138.03 | 43.59 | yes | 0 |
| 16 | 45.77 | 165 | 10.00 | rising | — | 0.00 | 79.75 | 62.63 | yes | 7 |
| 17 | 45.64 | 164 | 15.00 | rising | — | 1.55 | 74.27 | 28.80 | no | 0 |
| 18 | 45.78 | 165 | 20.00 | rising | 1.22 | 0.00 | 146.18 | 53.94 | yes | 0 |
| 19 | 45.55 | 164 | 25.00 | rising | — | 0.00 | 153.57 | 41.10 | yes | 0 |
| 20 | 45.56 | 164 | 30.00 | rising | — | 0.00 | 172.82 | 20.77 | yes | 0 |

Final batch: **18/20 reach**, **3 strikes**, **0 physics retries**, **0 browser errors**. This small, deliberately varied exercise is not a population strike-rate estimate. The 500-seed cohort below is the strike-difficulty check. Run 6 intended 10° but released at 19.44° after a delayed gauge observation; its actual outcome remains in the table.

Additional final-code keyboard checks:

| Scenario | Actual km/h | Angle ° | Sweep | Nudge @ s | Air input s | Air m | Slide m | Reach | Pins |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| next-sweep-1440 | 134.17 | 10.56 | rising | — | 0.00 | 60.26 | 68.08 | no | 0 |
| next-25-1366 | 118.97 | 25.00 | rising | 1.20 | 0.00 | 94.88 | 37.23 | yes | 1 |
| low-5-1440 | 144.49 | 5.00 | rising | — | 0.00 | 39.39 | 87.18 | no | 0 |
| max-30-1366 | 153.87 | 29.44 | falling | — | 0.00 | 153.05 | 48.41 | yes | 0 |
| pitch-up-1440 | 143.98 | 24.86 | rising | — | 0.33 | 111.06 | 24.47 | yes | 8 |
| air-left-1366 | 144.67 | 25.00 | rising | — | 0.27 | 110.41 | 45.21 | yes | 0 |
| 120-no-nudge | 118.89 | 25.00 | rising | — | 0.00 | 87.20 | 39.76 | no | 0 |
| 120-nudge | 119.12 | 25.00 | rising | 1.20 | 0.00 | 96.08 | 35.87 | yes | 0 |

`next-sweep-1440`: held 2.117 presentation seconds; charging car moved from z=-4.00 to z=26.39 (30.39 m). Trace contains rising, falling, and the next rising pass; all charging samples retain 0.4× time scale.
`next-25-1366`: held 2.550 presentation seconds; charging car moved from z=-5.72 to z=26.87 (32.59 m). Trace contains rising, falling, and the next rising pass; all charging samples retain 0.4× time scale.

The supplementary key-up event observer confirms the actual ejected angle equals the rendered needle angle at release in all eight checks. At approximately 119 km/h, the paired keyboard throws are short without Nudge and reach rack depth with Nudge; neither scores, so the extra reach is not a scoring assist. The final-batch speedometer differs from measured km/h by at most 0.466, within whole-number rounding.

**11–13. 500 seeded competent bot throws and strike difficulty.** Seeds are selected solely by the existing pre-throw `quality >= .18` criterion; the first 500 qualifying seeds are retained, without outcome filtering. All six obstacle variants appear. Local bot angle profiles are constrained to the new 0–30° range; the cohort includes Nudge and air corrections. Mean eject speed is 160.97 km/h.

**Rack-depth reach: 493/500 (98.6%). Short: 7/500 (1.4%). Missed ejections: 0.** A matched comparison using the same new angle profiles and gauge with the old 170 m distance reaches 350/500 (70.0%), so the distance change improves this measure by 28.6 percentage points. This isolates rack distance; it is not a replay of the obsolete 0–90° gauge.


| Pins | Count | Share |
| --- | --- | --- |
| 0 | 270 | 54.0% |
| 1–3 | 82 | 16.4% |
| 4–6 | 62 | 12.4% |
| 7–9 | 61 | 12.2% |
| 10 | 25 | 5.0% |

**Strike rate: 5.0%.** 46.0% knock down at least one pin. The 54.0% zero-score share includes lateral misses, overflights, and short throws; the high longitudinal-reach rate does not conceal that distinction. No scoring aid, enlarged target, boosted pin chain reaction, or automatic strike rule was added.

**14. Performance and browser feel.** Headed Chrome with GPU/Metal enabled. Warm active-play samples from the final 20 runs; values are telemetry rolling-window samples, not an independent GPU profiler:

| Viewport | Samples | Median FPS | P5 FPS | Median physics avg ms | Worst rolling physics P99 ms | Max draw calls | Max triangles |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | 390 | 60.0 | 60.0 | 0.240 | 2.900 | 28 | 113222 |
| 1366×768 | 399 | 60.0 | 60.0 | 0.419 | 3.100 | 28 | 113222 |

Both instruments stay within both viewport bounds. Screenshot inspection confirms readable ticks, degree display, locked angle, pin result, and no HUD overlap. Rising 25°, falling 25°, full-cycle waits, low and maximum launches, Nudge, A/D and W/S, clean hits, weak hits, strikes and misses were exercised. No browser exceptions or physics retries in the final 20. Some validation/build work ran concurrently with those approaches; FPS captures those interruptions rather than filtering them out.

**15. Validation.** Complete frontend + edge suite: **548/548 pass**, no skipped/cancelled tests, including **38 Bowling tests**. TypeScript app check and validation-script check pass. Production build passes (existing Vite chunk-size advisory remains). `git diff --check` passes. Additional physical parity smoke: no invalid bodies, no deck/car penetrations; original experiment validator completes, recording a failed obstacle-heavy approach honestly instead of requiring every approach to eject.

All six deterministic hashes match session-start/prior verified baselines:

| Mode | SHA-256 |
| --- | --- |
| rooftop | 8d89030cf2d5752364f82321950b42a6aa1100986c329955a5969c1876661de6 |
| barnRound | 88562a77268129b7f9601a990678cd87037fe3e5e51d7b7d8e637c345de5fc94 |
| layerRound | ef1303cc5b33cf14a3e6fe7211d2ebbdc50ae0dc8a6f827d088530afe625a069 |
| colorRound | 818900429dd23650e989ef4545e55a70257bb90938a4e3453e048385c9fefea6 |
| bombRound | 5be7de86b5f30dd9b1db691edf2463fc018fe13196fa63e7fb8306bdf05bf8d2 |
| prophunt | 0c359d893dbb349c394cbfb640b3dbd299ac4791b7828a1004f504e84b076ed0 |

The first sandboxed complete-suite attempt stalled at its localhost chat-server setup. It was stopped and the complete suite was rerun successfully with localhost networking enabled. No server or lobby implementation was edited.

**16. Files changed in this task.**

- `src/party-lab/scene/bowling/config.ts`: 130 m rack, triangular 0–30° sweep, valid local bot angle profiles.
- `src/party-lab/scene/bowling/game.ts`: sweep direction and range/impact measurement telemetry.
- `src/party-lab/scene/bowling/BowlingPlayground.tsx`: every-frame synchronized gauge snapshots and direction telemetry.
- `src/party-lab/scene/bowling/BowlingHud.tsx`: original radial instrument, subtle direction cue, updated controls copy.
- `src/party-lab/scene/bowling/bowling.css`: remove needle interpolation delay; style the direction cue.
- `src/party-lab/scene/bowling.test.ts`: distance/range updates, endpoint reversal and return-pass release tests at multiple frame rates; visibility ray ignores invisible car-only catchers.
- `scripts/validate-party-lab-bowling-reachability.ts`: new reproducible full-course matrix, effects, 500-bot cohort, optional distance comparison.
- `scripts/validate-party-lab-bowling.ts`: valid angle recipes, timed endpoint release, honest failed-approach recording.
- `scripts/validate-party-lab-bowling-parity.ts`: valid angle recipes and timed endpoint release.
- `scripts/validate-party-lab-bowling-course.ts`: derive hold duration from the current angle rate.
- `src/party-lab/scene/bowling/REACHABILITY_REPORT.md`: this report.

`ArenaScene.tsx` is byte-identical to the session-start uncommitted version. Prior reports and assets remain. The session-start backup is `/private/tmp/bowling-reachability/before.tgz`; the initial tracked diff is `/private/tmp/bowling-reachability/before.diff`.

Reproduce the controlled experiment from the repository root:
```sh
node --import tsx scripts/validate-party-lab-bowling-reachability.ts /private/tmp/bowling-reachability-recheck 500
```
Visual evidence: [falling gauge at 1366×768](/private/tmp/bowling-reachability/supplement/next-25-1366-falling.png), [next upward pass](/private/tmp/bowling-reachability/supplement/next-25-1366-next-rise.png), [strike result](/private/tmp/bowling-reachability/final-keyboard/run-8-score.png).

Raw evidence: `/private/tmp/bowling-reachability/final/{matrix,effects,bots,summary}.json`, `final-keyboard/results.json`, `supplement/results.json`, browser screenshots beside those results, `frontend-edge-unrestricted.log`, `typescript-final.log`, `validator-typescript.log`, `build-final.log`, and the hash files. The headed harness and its input scenarios are `/private/tmp/bowling-reachability/browser.mjs` and `supplement.mjs` (uses the locally installed Playwright and Chrome). The preliminary 20-run batch is retained separately in `keyboard/results.json`, including its missed launch-window releases.
