# Kartopu Çarpışması — movement and late-round pressure

Local tuning pass, 2026-10-04. Protocol stays **10**. This supersedes the movement/shrink values in the earlier prototype and camera reports; those reports and all preexisting uncommitted work are preserved.

## 1. Old movement constants

| Parameter | Before | After |
| --- | ---: | ---: |
| Forward motor acceleration | 6.2 m/s² | 7.2 m/s² |
| Reverse motor acceleration | 3 m/s² | 7.2 m/s² |
| Counter-input/braking ceiling | 6 m/s² | 12 m/s² |
| Forward nominal speed scale | 11 m/s | 11 m/s |
| Reverse nominal speed scale | 3 m/s | 11 m/s |
| Base heading rate | 2.6 rad/s | 3.6 rad/s |
| Maximum lateral steering acceleration | 3.8 m/s² | 8.5 m/s², reduced above 5 m/s |
| Lateral velocity response coefficient | 1.8 /s | 4.2 /s |
| Sphere radius / mass | 0.95 m / 80 kg | Unchanged |
| Ball/floor friction | 0.22 / 0.22 | Unchanged |
| Ball restitution | 0.55 | Unchanged |
| Linear / angular damping | 0.12 / 0.16 | Unchanged |

The 120 Hz step, rolling torque controller, gravity, CCD, solver settings and sphere collider remain unchanged.

## 2. Why it felt sluggish

There were two separate problems. Reverse used a much weaker motor and a hard 3 m/s nominal speed scale: measured terminal reverse speed was only **2.652 m/s**, compared with **8.912 m/s** forward. Opposite input first spent about 1.4 seconds cancelling full forward motion, then accelerated slowly into this low reverse limit.

Steering also stopped applying lateral correction as soon as the control heading reached its target. With the fixed screen-direction adapter, heading could settle while the actual velocity still pointed diagonally. At 5 m/s, heading reached 90° in 0.958 s, but velocity needed 6.8 s just to reach 80°. Increasing heading rate alone would not fix that drift.

## 3–4. Final drive, braking and steering

Forward and reverse now share the same acceleration and nominal speed scale. When commanded travel opposes the velocity component along the control axis, the motor applies a bounded counter-force. It blends from 12 m/s² at at least 1.5 m/s of opposing travel down to the normal 7.2 m/s² drive around zero. Velocity crosses zero physically; no position or velocity is assigned.

Holding a direction keeps lateral correction active after heading alignment. Releasing every direction disables this correction and preserves the existing coast. Lateral acceleration is capped at `8.5 / (1 + max(0, speed - 5) × 0.12)`; heading rate remains speed-dependent at `3.6 / (1 + speed × 0.12)`. High-speed turns stay wider.

The 14 m/s² brake candidate stopped faster but reduced the room for collision consequences. The selected 12 m/s² candidate retains about 3.3 m of stopping distance from terminal speed, with materially faster reversal than the baseline. Broader bot steering/risk variants were also rejected after they produced more late-round stalemates.

## 5–7. Before/after control measurements

These use the real Rapier body and the live screen-input adapter, at a deterministic 1/120 s step. Straight-line measurements use an isolated large test floor to avoid falling before a measurement finishes; the actual game arena remains **20 m across**. “Stop” means original-axis speed falls below 0.1 m/s. A 90° direction change means velocity is within 10° of the requested direction. A meaningful 180° reversal requires at least 1 m/s in the opposite direction. This measures trajectory, not just heading.

| Measurement | Before | After |
| --- | ---: | ---: |
| Rest → 3 m/s forward | 0.592 s | 0.508 s |
| Rest → 5 m/s forward | 1.183 s | 1.008 s |
| Rest → 8 m/s forward | 3.275 s | 2.633 s |
| Measured forward terminal speed, 15 s drive | 8.912 m/s | 9.153 m/s |
| Measured reverse terminal speed | 2.652 m/s | 9.153 m/s |
| Full forward → stop | 1.392 s / 5.849 m | 0.758 s / 3.298 m |
| Full forward → 1 m/s reverse | 1.842 s | 0.917 s |
| Full forward → 3 m/s reverse | Never reaches 3 m/s | 1.275 s |
| Full reverse → 1 m/s forward | 0.592 s, from 2.652 m/s | 0.917 s, from 9.153 m/s |
| Same 8 m/s entry → stop | 1.258 s / 4.766 m | 0.667 s / 2.539 m |
| Same 8 m/s entry → meaningful 180° reversal | 1.708 s | 0.833 s |
| 5 m/s entry → meaningful 180° reversal | 1.275 s | 0.592 s |
| 90° direction change at 2 m/s | 2.975 s | 0.733 s |
| 90° direction change at 5 m/s | 6.800 s | 0.900 s |
| 90° direction change at 8 m/s | More than 8 s | 1.283 s |
| Release at 5 m/s: 3 s coast | 12.404 m; 3.372 m/s remains | Identical |
| Release at 8 m/s: 3 s coast | 19.844 m; 5.395 m/s remains | Identical |

Forward terminal speed rises only **2.7%**. The much larger change is timely braking and velocity redirection. Reverse-to-forward is now symmetrical at the same starting speed; comparing the two old/new reverse terminal speeds directly would hide that improvement.

## 8. Collision momentum comparison

Identical starting states and no motor input produce identical before/after collision measurements to 0.001 m/s. No mass, radius, restitution, contact solver or collision impulse logic changed.

| Test | Pre-contact X speeds, attacker / opponent | Post-contact X speeds, before **and** after |
| --- | --- | --- |
| Medium hit on stationary opponent | 5.730 / 0 | 1.203 / 4.352 m/s |
| Fast hit on stationary opponent | 9.729 / 0 | 2.052 / 7.398 m/s |
| Equal-speed head-on | 9.739 / −9.739 | −5.351 / 5.351 m/s |

A glancing hit also preserves the same deflection: attacker `(6.359, 3.362)` and opponent `(3.190, −3.288)` in X/Z m/s. These four experiments recorded zero invalid bodies and zero reported overlap. A player holding counter-input can now recover sooner after impact; that is the intended movement change, not an extra knockback impulse or a weaker collision.

## 9–11. Physical shrink schedule and visibility

Previously the platform stayed full-size until 38 s, then lost 0.8 m of radius each second, reaching zero at 50.5 s.

Now the existing small warning appears at **25 s**. The full-size opening lasts **28 s**. Radius then decreases at **0.45 m/s** until **36 s**, followed by **0.9 m/s**. The function is continuous at both transitions.

| Round time | Radius | Diameter |
| --- | ---: | ---: |
| 0–28 s | 10 m | 20 m |
| 30 s | 9.1 m | 18.2 m |
| 32 s | 8.2 m | 16.4 m |
| 35 s | 6.85 m | 13.7 m |
| 36 s | 6.4 m | 12.8 m |
| 38 s | 4.6 m | 9.2 m |
| 40 s | 2.8 m | 5.6 m |
| 42 s | 1 m | 2 m |
| About 43.11 s | 0 m | No support remains |

The existing white edge ring and complete ice platform retreat together with the Rapier cylinder, using the same `game.radius`. No new geometry, particles, art or large warning was added. The existing physical shape update cadence is retained. Crossing the edge does not eliminate a player; gravity must still carry the sphere below the unchanged −3.5 m threshold (or the existing distant failsafe).

## 12. Round duration comparison

The same seeds, reaction intervals, player counts and control policies were run before/after: **144 rounds per version**, 24 in each group. The “aggressive” keyboard policy approaches rivals; “defensive” circles and recovers inward. Bot-only games include the same delayed bot decisions for slot zero. They are repeatable stress policies, not substitutes for subjective human play.

| Players / policy | Before mean | After mean |
| --- | ---: | ---: |
| 2P aggressive | 47.066 s | 37.089 s |
| 2P defensive | 47.703 s | 36.692 s |
| 2P bots | 37.983 s | 29.353 s |
| 3P aggressive | 47.722 s | 41.830 s |
| 3P defensive | 49.726 s | 38.158 s |
| 3P bots | 41.276 s | 30.742 s |
| **All 144 rounds** | **45.246 s** | **35.644 s** |

The longest selected run was 44.125 s versus 51.233 s before. In ordinary bot matches, 31/48 rounds ended before radius dropped below 5 m. The direct-chase 3P policy still needed deep shrink in 19/24 rounds: that remains the main pacing limitation. Earlier gradual shrink contains this case without forcing every opening into a small arena. No further scoring, growth or collision rules were added to conceal that limitation.

## 13. Bots during shrink

The original aggression/caution, aim error, attack reset behavior and 0.24/0.32 s reaction intervals remain. Bots use exactly the same new drive forces as the human.

The safety margin is now capped at 45% of the remaining radius. Previously a fixed 3.2 m margin could classify even the center of a small disk as unsafe, discouraging attacks. Bots also allow for the currently retreating edge over 0.32 s, using the public round clock and current velocity. They do not simulate future collisions. A deterministic test verifies that a center bot still targets a rival at 2.5 m radius and that an outward edge bot attempts to recover.

## 14–15. Headed Chrome and performance

Baseline and final controlled runs use installed **headed Google Chrome**, real key down/up events and the normal render/physics loop, at **1440 × 900** and **1366 × 768**. Debug access only sets reproducible starting states. Full matches run in real time without advancing the clock manually.

All 24 final controlled cases passed: W acceleration, W→S, S→W at matched high speed and at the old reverse terminal speed, low/medium/high A/D correction, 90°/180° turns, near-edge recovery, lining up a ram, contact after reversal and fast head-on contact. At 1440 × 900, observed 8 m/s stop time fell from about 1.25 s to 0.65 s; medium-speed velocity reached 80° in about 0.88 s. The equivalent baseline did not reach that angle within the 2.2 s case. Browser timings have roughly one-frame sampling precision.

At the same outward 6 m/s edge entry, maximum X fell from 8.80 m to 7.45 m; both recoveries stayed alive. The final reverse-then-ram case made contact inside its 2.5 s window; the baseline did not. Sphere spin remains visible, and camera position/orientation/FOV remain fixed.

| Viewport | Match | Round durations | Average FPS |
| --- | --- | --- | ---: |
| 1440 × 900 | 2P aggressive | 35.46 / 43.95 / 42.92 s | 59.96 |
| 1440 × 900 | 3P defensive | 43.51 / 43.86 / 43.20 s | 59.95 |
| 1366 × 768 | 2P defensive | 43.57 / 43.92 / 42.54 s | 59.96 |
| 1366 × 768 | 3P aggressive | 43.13 / 24.27 / 35.47 s | 59.96 |

All four matches reached results after three rounds, and replay returned to round-one countdown. The 3P aggressive match included a pre-shrink knockout at 24.27 s and another ending during gentle shrink at 35.47 s. Defensive rounds reliably reached visible shrink and resolved. No browser page errors or invalid bodies were recorded.

Measured local update JS averaged **0.41–0.53 ms/frame**. Rapier stepping averaged **0.118–0.159 ms**, p99 **0.3–0.4 ms**, maximum **1.9 ms**. Peak draw calls/triangles were **30 / 2,140** for 2P and **35 / 2,694** for 3P, with exactly 2 or 3 dynamic bodies. Frame-time p99 was **17.8 ms**; the screenshot-enabled automation runs also contained isolated maximum intervals of **127–153.5 ms**, so these are average-60-FPS results, not a claim that every frame met 16.7 ms.

Across **33,847** sampled match frames, camera position, rotation and FOV deltas were zero. No new rendering work or camera behavior was introduced. A few falling-ball samples left the fixed view before elimination; the camera was deliberately not made to chase them.

## 16. Validation and preservation

- 25 Snowball rules, physics, camera, movement, shrink and bot tests passed.
- 42 Rooftop/input regression tests passed.
- TypeScript and production build passed. The build retains the existing large-chunk warning.
- `git diff --check` passed.
- Fixed camera helper, camera component, screen-input adapter, visuals, CSS and scoring state-machine code remain unchanged.
- Other modes, online lists, Mixed, PartyRoom, server and protocol are unchanged. No commit, push or deploy.

Backup of all existing uncommitted Party Lab source: `/private/tmp/snowball-movement-pressure-20261004/before-tuning.tar.gz`. Source hashes, baseline diff, candidate measurements, final JSON, keyboard traces and screenshots are in that same external directory.

## 17. Files changed in this pass

- `src/party-lab/scene/snowball/config.ts` — drive constants and continuous two-stage shrink.
- `src/party-lab/scene/snowball/game.ts` — bounded counter-input and sustained active lateral steering, within `drive` only.
- `src/party-lab/scene/snowball/bots.ts` — shrinking-arena safety margin and retreat allowance.
- `src/party-lab/scene/ArenaScene.tsx` — Snowball menu timing text only.
- `src/party-lab/scene/snowball.test.ts` — updated shrink expectations.
- `src/party-lab/scene/snowball/camera.test.ts` — updated finite-braking assertion; camera tests unchanged.
- `src/party-lab/scene/snowball/movement.test.ts` — new response, coast, shrink/collider and bot tests.
- `scripts/test-party-lab-snowball-movement.ts` — reproducible before/after movement, collision and 144-round pacing experiment.
- `src/party-lab/scene/snowball/MOVEMENT_PRESSURE_REPORT.md` — this report.

## 18. Growth later?

**Not implemented.** Equal growth might be worth a separate optional experiment for spectacle and increasing crowding, but it is not the next recommended fix. It changes contact radius, mass/inertia and edge leverage simultaneously, making it harder to preserve the now-measured response. The physical shrink already supplies clear escalating pressure. Any future growth experiment should compare against this equal-size baseline and requires the requested approval first.
