# Kartopu Çarpışması — player collision tuning

Local-only pass, 2026-10-04. This supersedes only the collision restitution in earlier reports. Existing movement, camera, arena shrink and uncommitted work are preserved. Protocol remains **10**.

## 1–3. Audit, cause and selected settings

The only runtime change is sphere restitution **0.55 → 0.70**. Ball-to-ball material combination remains Rapier Average. Equal spheres therefore resolve at 0.70. The floor remains restitution 0 with the higher-priority Min rule, so this change does not introduce floor bounce.

| Setting | Before | After |
| --- | --- | --- |
| Sphere restitution | 0.55 | **0.70** |
| Sphere / floor friction | 0.22 / 0.22 | Unchanged |
| Floor restitution / combine | 0 / Min | Unchanged |
| Sphere radius / mass | 0.95 m / 80 kg | Unchanged |
| Linear / angular damping | 0.12 / 0.16 | Unchanged |
| Contact skin | 0.015 m | Unchanged |
| Solver / time step | 8 iterations / 120 Hz | Unchanged |
| CCD | Enabled, 4 substeps, 2 m soft prediction | Unchanged |

The old contact was correctly transferring momentum, but 0.55 normal restitution produced modest separation. The newly responsive counter-input could then recover from that separation quickly. Damping, friction and solver stability did not require a change: supported contacts in the tested useful-speed range had no measured sphere overlap. A 0.75 candidate increased initial separation by about 36%; 0.70's approximately **27%** increase met the moderate-recoil goal with less extra bounce. Normal impulse rises about **9.5%**, not 27%, because separation speed and total contact impulse are different quantities.

All drive constants remain: forward/reverse acceleration 7.2 m/s², braking ceiling 12 m/s², nominal speed scale 11 m/s, heading rate 3.6 rad/s, lateral grip 8.5 and response 4.2. No custom collision impulse, velocity assignment, cooldown, teleport, stun or force blend was added. The existing rolling torque controller is unchanged.

## 4–6. Controlled before/after measurements

The reproducible script is `scripts/test-party-lab-snowball-collisions.ts`. It runs the actual game and Rapier at 120 Hz, on the actual 10 m radius platform. Each version runs 12 fixtures with released input, immediate counter-input from both players, and defender-only counter-input: **36 cases per version**. Fixture positions, linear velocity and matching rolling spin are set before play only. All subsequent motion is physical.

First impact means a positive Rapier normal contact impulse, not merely a predictive solver contact. Pre/post velocity samples are consecutive physics ticks around that impulse. A = attacker; D = defender/opponent. Vectors below are **(X, Z) m/s**; full three-dimensional traces are in the external JSON. The equal-speed head-on test uses two moving opponents; side impact has a moving defender. “Full speed” starts at 9.15 m/s, matching the existing motor's measured useful terminal speed.

| Scenario | Pre A / D, both versions | Post A / D, old | Post A / D, new |
| --- | --- | --- | --- |
| low-frontal | (1.361, 0.000) / (0.000, 0.000) | (0.283, 0.000) / (1.031, 0.000) | (0.181, 0.000) / (1.133, 0.000) |
| medium-frontal | (5.363, 0.000) / (0.000, 0.000) | (1.132, 0.000) / (4.079, 0.000) | (0.730, 0.000) / (4.480, 0.000) |
| full-frontal | (9.010, 0.000) / (0.000, 0.000) | (1.898, 0.000) / (6.849, 0.000) | (1.223, 0.000) / (7.524, 0.000) |
| head-on | (7.732, 0.000) / (-7.732, 0.000) | (-4.254, 0.000) / (4.243, 0.000) | (-5.413, 0.000) / (5.402, 0.000) |
| side-hit | (9.010, 0.000) / (0.000, 5.416) | (1.832, 0.641) / (6.940, 4.792) | (1.148, 0.656) / (7.624, 4.777) |
| glancing | (8.912, 0.000) / (0.000, 0.000) | (5.943, 3.098) / (2.887, -3.024) | (5.694, 3.421) / (3.135, -3.347) |
| near-edge | (9.010, 0.000) / (0.000, 0.000) | (1.898, 0.000) / (6.849, 0.000) | (1.223, 0.000) / (7.524, 0.000) |

The following released-input table measures horizontal displacement from each sphere's own position immediately after the first impact. Each displacement cell lists **0.5 s / 1.0 s**; these are net displacement, not accumulated path length. Separation is relative velocity projected onto the line of impact. Falls are observed through 2.5 s after impact, so a later fall is not an instant center-arena elimination.

| Scenario | Separation m/s, old → new | A displacement .5s / 1s, old → new | D displacement .5s / 1s, old → new | Fell by 2.5s, old → new |
| --- | --- | --- | --- | --- |
| low-frontal | 0.748 → 0.952 | 0.224 / 0.439 → 0.186 / 0.369 | 0.338 / 0.636 → 0.376 / 0.707 | Neither → Neither |
| medium-frontal | 2.947 → 3.751 | 0.808 / 1.663 → 0.639 / 1.364 | 1.561 / 2.735 → 1.748 / 3.053 | Neither → Neither |
| full-frontal | 4.950 → 6.300 | 1.244 / 2.676 → 0.930 / 2.143 | 2.893 / 4.932 → 3.221 / 5.518 | Neither → Neither |
| head-on | 8.497 → 10.814 | 1.630 / 2.329 → 2.193 / 3.404 | 1.623 / 2.312 → 2.186 / 3.390 | Neither → Neither |
| side-hit | 5.015 → 6.383 | 1.258 / 2.722 → 0.949 / 2.192 | 3.764 / 6.816 → 4.023 / 7.254 | D → D |
| glancing | 2.987 → 3.801 | 3.356 / 6.550 → 3.314 / 6.470 | 1.619 / 2.883 → 1.805 / 3.201 | A → A |
| near-edge | 4.950 → 6.300 | 1.244 / 2.676 → 0.930 / 2.142 | 2.906 / 5.350 → 3.249 / 6.072 | D → D |
| weak-edge-tap | 0.748 → 0.952 | 0.224 / 0.439 → 0.186 / 0.369 | 0.338 / 0.636 → 0.376 / 0.707 | Neither → Neither |
| during-shrink | 4.950 → 6.300 | 1.244 / 2.676 → 0.930 / 2.143 | 3.077 / 5.555 → 3.424 / 6.090 | A, D → D |

At full speed the stationary defender's immediate X velocity rises **6.849 → 7.524 m/s**, while the attacker's drops **1.898 → 1.223 m/s**. Both pay a physical consequence. Medium hits produce clear displacement; weak taps still displace the defender less than 0.8 m over one second.

Side hits redirect the defender into the attacker's travel direction while slowing the attacker. Glancing contact changes both trajectories, with less normal separation than a centered full-speed ram: **3.801 versus 6.300 m/s**. Horizontal kinetic energy falls across these contacts; the material does not inject an explosive speed bonus. Released glancing attacks can still send the attacker off after overcommitting.

In the near-edge fixture (attacker X=4.5 m, defender X=7.5 m), both versions knock off an idle defender. With **both players immediately holding toward each other**, old restitution lets both recover, whereas 0.70 eliminates the defender and leaves the attacker alive. Moving this confrontation another 0.3 m outward makes continued attacker commitment capable of eliminating both. A defender acting alone can still recover from that farther-out fixture: geometry, continued pressure and input matter. The equal weak edge tap eliminates neither player.

All 72 controlled runs recorded **zero invalid bodies**. Active sphere overlap is zero at the tested useful speeds, including repeated contact during shrink. An intentionally extreme 65 m/s-per-ball CCD stress fixture has a transient **0.284 m penetration in both versions**; this is far above gameplay speed and is an existing solver limit, not improved by restitution. Disabled, eliminated spheres are excluded from overlap measurements because they no longer participate in contacts.

## 7–8. Input after impact

Counter-input does progressively absorb collision momentum. It does **not** cancel the first impulse on the next step. With both players countering, full-speed separation changes **6.300 → 6.112 m/s** on that next 8.33 ms step; equal-speed head-on changes **10.814 → 10.541 m/s**. Roughly 97% of the initial separation survives.

With continuous counter-input, equal-speed head-on displacement at 0.5 s rises from **0.343 / 0.336 m** to **0.808 / 0.801 m** for A/D. By one second both can already drive back toward contact. This gives readable recoil and immediate agency. **No post-impact blend or control lock was needed.** Movement, braking, steering and their response timing remain untouched.

The 20 m platform, equal ball size, fixed Rooftop-style camera, 28 s shrink start and 36 s shrink acceleration are unchanged. Bots retain their existing decisions, reaction delay and movement rules.

## 9. Headed Chrome results

Installed Google Chrome ran headed, with Playwright key-down/key-up events through the normal game loop, at **1440×900 and 1366×768**. This is automated keyboard play, not a claim of subjective human feel testing. Debug access establishes controlled starting states; full matches use normal countdowns, real elapsed time and unchanged bots.

Baseline and final each passed **20 controlled cases**, ten at each size: low bump, medium ram, full ram, equal-speed head-on with immediate counter-input, perpendicular hit, glancing hit, near-edge attack, defensive edge recovery, attacker overcommit, and contact during shrink. Each case produced physical contact and zero invalid bodies.

Low/medium/full center impacts stayed playable with both balls alive at the observation endpoint. The final near-edge attack eliminated the defender at both sizes; continued unbraked drive also carried the attacker beyond support and into a fall, so that case is not reported as a safe attacker win. The separate glancing-overcommit case eliminated the attacker while the opponent survived. Defensive edge counter-input recovered successfully at both sizes. Deep-shrink contact could eliminate both balls; the existing fall grace and draw rules still apply. Several contacts occurred again during recovery: there is no ghosting cooldown.

Four complete matches passed, including results, all round resets and replay into the next match's round-one countdown:

| Viewport | Match / keyboard policy | Round durations (s) | Average FPS |
| --- | --- | --- | ---: |
| 1440×900 | 2P / aggressive | 35.11 / 43.23 / 40.79 | 59.96 |
| 1440×900 | 3P / defensive | 35.31 / 43.82 / 43.16 | 59.87 |
| 1366×768 | 2P / defensive | 26.05 / 42.18 / 42.61 | 59.95 |
| 1366×768 | 3P / aggressive | 42.87 / 28.45 / 26.04 | 59.97 |

Across **31,659** sampled match frames, camera position, quaternion and FOV deltas were exactly zero. Platform framing and visible shrink remained readable in inspected screenshots. There were 25 offscreen living-ball samples during departure before elimination; the fixed view does not chase falling spheres. No camera or visual code was changed. There were no browser page errors.

The movement regression probe also reran 144 deterministic rounds using the existing aggressive, defensive and bot policies. All completed with valid bodies; mean duration was 34.464 s versus the saved previous 35.644 s. Direct-chase 3P rounds can still reach deep shrink; bots and timing were deliberately kept unchanged.

## 10. Performance

Measured on the local development server with debug sampling and screenshots enabled. These are approximately-60-FPS results, not a claim that every frame meets 16.7 ms. TypeScript/build work overlapped part of the 1440px runs; the later 1366px matches ran without that build load.

| Viewport / players | Local update JS avg (ms/frame) | Physics avg / p99 / max (ms/step) | Frame p99 / max (ms) | Peak draws / triangles | Dynamic bodies / invalid |
| --- | ---: | --- | --- | --- | --- |
| 1440 / 2P | 0.516 | 0.146 / 0.300 / 0.600 | 17.7 / 131.4 | 30 / 2140 | 2 / 0 |
| 1440 / 3P | 0.377 | 0.092 / 0.300 / 0.500 | 17.8 / 248.2 | 35 / 2694 | 3 / 0 |
| 1366 / 2P | 0.476 | 0.140 / 0.400 / 0.600 | 17.7 / 149.7 | 30 / 2140 | 2 / 0 |
| 1366 / 3P | 0.530 | 0.158 / 0.400 / 0.500 | 17.7 / 110.9 | 35 / 2694 | 3 / 0 |

No new runtime loop, event queue, geometry, particle, body or contact hook was introduced. Only a material constant changed. There were no solver explosions in the observed gameplay; the artificial 65 m/s penetration limitation is documented above.

## 11. Validation and preservation

- **30 Snowball tests passed**: rules/local isolation, fixed camera, input, movement, shrink, bots and five new collision tests.
- `npx tsc --noEmit` passed.
- `npm run build` passed. Existing Supabase mixed static/dynamic import and large-chunk warnings remain.
- `git diff --check` passed.
- The movement probe's forward/reverse acceleration, reversal, turn, coast and shrink outputs exactly match the saved pre-collision baseline to the reported 0.001 precision. Forward/reverse terminal speed remains **9.153 m/s**, full-speed stop **0.758 s / 3.298 m**, and meaningful reverse speed (1 m/s) **0.917 s**. Low/medium/high 90° trajectory responses remain **0.733 / 0.900 / 1.283 s**.
- SHA-256 comparison of **337 existing Party Lab files** found only `config.ts` and the movement test changed in this pass. Camera, input adapter, motor, bots, visuals, scoring, Rooftop, all other modes, online lists, Mixed, PartyRoom, server and protocol source remain byte-identical to the pass-start backup.
- The existing online-isolation test still asserts seven online modes and protocol **10**. No online implementation, commit, push or deployment occurred.

External backup: `/private/tmp/snowball-collision-20261004/before-collision.tar.gz`. The same directory contains the initial diff and source hashes, baseline/candidate/final Rapier JSON, movement verification, browser keyboard traces, screenshots and preservation check. These artifacts preserve the preexisting uncommitted work.

Reproduce the contact measurements:

```sh
npx tsx scripts/test-party-lab-snowball-collisions.ts /private/tmp/snowball-collisions.json
```

The optional third CLI argument selects an alternate Snowball module directory for a baseline. Historical reports remain unchanged and describe their respective earlier passes.

## 12. Files changed in this pass

- `src/party-lab/scene/snowball/config.ts` — restitution 0.55 → 0.70 and floor-combination comment; only runtime change.
- `src/party-lab/scene/snowball/movement.test.ts` — move the old restitution assertion out of the unchanged-movement test; collision material is now covered by the dedicated test.
- `src/party-lab/scene/snowball/collision.test.ts` — new physical contact, scaling, energy, counter-input, angle and edge regression tests.
- `scripts/test-party-lab-snowball-collisions.ts` — new reproducible 36-case measurement runner.
- `src/party-lab/scene/snowball/COLLISION_REPORT.md` — this report.

## 13. Growth and remaining tuning

**No growth added; it is not needed for this collision goal.** Equal-radius, equal-mass contact now gives more recoil, and the unchanged shrink already supplies late pressure. Growth would alter spacing, leverage and potentially mass/inertia, requiring a separate rebalance. It is only worth a later optional experiment if manual play identifies a specific missing experience; it should not be the next default change.

The remaining subjective check is whether 0.70 is the right amount of extra bounce for the user's hands. The selected value preserves counterplay and weak taps in the measured cases. Any further increase should be checked against edge survival and simultaneous falls rather than compensated by changing the now-good movement.
