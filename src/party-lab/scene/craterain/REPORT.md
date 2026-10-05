# Crate Rain: 20-second local redesign

Validated 2026-10-06 in `/Users/enesk/Desktop/world-quiz`. Local only. No commit, push, deployment, online implementation, or protocol change.

**1. Arena.** The playable courtyard is **14 × 14 m**, with **100 playable cells** in a 10 × 10 grid. No excluded floor cells. The perimeter sits outside that footprint. Comparative deterministic runs filled all 81/100/121 cells in 12.6/14/15.4 m arenas. The 14 m court retains initial movement room for three players with a manageable 100-cell fill. The planning grid is not rendered.

**2. Crate size.** Every physical collider is **1.4 × 1.4 × 1.4 m**. Three paint/strap variants share the same dimensions. No growth, random scale, or gameplay rotation. Cosmetic battens extend slightly beyond the collider, as before.

**3. Falling/static architecture.** A warning creates one visible, position-controlled kinematic sensor body. A quadratic downward trajectory ends at the reserved supported position. An exact Rapier convex shape cast sweeps the cube and the player's actual capsule displacement through each 1/120-second step. A hit eliminates the player before a fixed crate can push the player through the floor.

**4. Landed physics.** At landing, the same body becomes `RigidBodyType.Fixed`, velocity is cleared, and its collider becomes solid. Landed crates never become dynamic. No bounce, sliding, tipping, collapse, impulses, wake-up, or sleeping-crate system. No body/collider replacement churn. Only player bodies remain dynamic.

**5. Static stacking.** Cells track fixed layer count and a falling reservation. Target center Y is `layers × 1.4 + 0.7`. One reservation per cell prevents intersecting drops. Every base cell must be actually occupied before stacking starts. Base support is analytical and immutable. Controlled drops exclude character bodies from support planning.

**6. Duration and result rule.** **3-second countdown → at most 20.000 seconds active → immediate round result.** One survivor wins immediately and earns one round win. Same-tick total elimination is a draw. At 20 seconds, multiple survivors draw and receive no round-win points; they are explicitly shown as survivors. No overtime. A three-second result display separates the three rounds. Pausing the local menu pauses active time.

**7. Accelerating schedule.** Landing deadlines are obtained by inverting a normalized occupancy curve, then scaled to the actual grid cell count. Warnings launch ahead of those deadlines. For this 100-cell arena:

| Landing window | New base crates | Mean base landings/s |
|---|---:|---:|
| 0–5 s | 8 | 1.6 |
| 5–10 s | 16 | 3.2 |
| 10–15 s | 28 | 5.6 |
| 15–18 s | 30 | 10.0 |
| 18–19.25 s | 18 | 14.4 |
| After full base, before 20 s | 6 stacked | Full 0.65 s warnings |

The final base rain is nine times the initial rate. Crates are selected from unoccupied, unreserved cells. Spatial separation between active warnings is preferred while empty alternatives remain. Final fill intentionally consumes the remaining holes. Late stacks have a 65% selection bias toward available cells within 3.5 m of survivors. No obsolete 35–60-second phases remain.

**8. Reproducible coverage.** Three seeds produced the same occupancy milestones. These are surviving-to-deadline fixtures; an early last-survivor finish legitimately stops accumulation.

| Active time | Occupied / playable base cells | Occupancy | Total crates spawned |
|---|---:|---:|---:|
| 0 s | 0 / 100 | 0% | 0 |
| 5 s | 8 / 100 | 8% | 10 |
| 10 s | 24 / 100 | 24% | 28 |
| 15 s | 52 / 100 | 52% | 58 |
| 18 s | 82 / 100 | 82% | 91 |
| 20 s | 100 / 100 | 100% | 106 |

Some spawned crates are still falling at intermediate times. The base finishes around **19.26 seconds**, including fixed-step quantization. [Coverage/physics evidence](/private/tmp/crate-rain-20s-20261005-234442/physics.json). The `coverage-coverage-*.png` screenshots use a **test-only overview camera** and collision-disabled observer players to make the whole 20-second coverage curve inspectable. Gameplay cameras are unchanged by that fixture.

**9. Final accumulation.** **106 total = 100 base + 6 stacked**, maximum **2 layers / 2.8 m**, zero falling crates left at the deadline. Crates persist until round reset. The 120-crate cap is safety headroom, not the pacing mechanism.

**10. Warnings and audio.** Total warning-to-supported-landing duration is `0.95 − 0.30 × clamp(t/18, 0, 1)` seconds: **0.95 / 0.867 / 0.783 / 0.700 / 0.650 / 0.650** at 0/5/10/15/18/20 s. Player-head contact occurs before ground landing: approximately **0.59 seconds** for a stationary center hit under the shortest warning. A visible incoming crate and growing/darkening physical shadow remain throughout. No red target squares. Falling audio prioritizes nearer warnings, with a 0.28-second global start interval; positional impacts have a 0.12-second interval and 0.20-second sound duration. Existing audio voice limits remain intact. Headed matches peaked at **5–7 total voices**, with no reported drops.

**11. Pointer lock.** Crate Rain now uses Party Lab's existing `bindLook(surface, 'lock', …, lockEnded)` on its viewport, matching Barn/Prop Hunt conventions. One gameplay click acquires lock. Subsequent relative pointer motion works with **no button held**. The existing Escape gate handles browser release and opens the local menu. Closing the menu does not automatically relock; a new gameplay click does. Final match results release lock so the restart button remains usable. No shared input implementation changed.

**12. Mac trackpad validation.** Headed macOS Google Chrome passed button-free relative pointer movement in both camera modes. A separate native Chrome check observed the browser's lock banner, native Escape release/menu opening, and fresh-click reacquisition. This exercises the input path used by a MacBook trackpad. **Physical finger-on-trackpad feel was not performed by the agent** and remains a hands-on check. [Native check](/private/tmp/crate-rain-20s-20261005-234442/native-chrome-check.json), [headed input evidence](/private/tmp/crate-rain-20s-20261005-234442/input-browser.json).

**13. Keyboard-only play.** Held arrows turn/look without pointer lock in both views. Movement, sprint, jump, and camera toggle remain semantic actions. Rapid W/A/S/D and all four diagonals passed with real browser keyboard input.

**14. Original stiffness.** `drive()` assigned the input direction directly to `heading`, and `visual.update()` copied that heading straight into mesh rotation. This produced one-frame 90°/180° changes. Mesh translation also copied raw fixed-step transforms. The old third-person camera combined an automatically turning view with a separately anchored movement basis, adding unnecessary changes in the perceived movement direction.

**15. Facing smoothing.** Visual facing follows actual horizontal velocity through shortest-arc, frame-independent exponential smoothing (`1 − exp(−18 × dt)`). Physics remains separate. Player translation interpolates between consecutive simulation transforms. Tests give equivalent angular results at 30/60/120 Hz and handle wraparound. Rapid headed eight-direction switching had maximum sampled yaw changes of **0.81 rad**, below a one-frame 90° snap, with no camera yaw oscillation.

**16. Physical movement.** Retained responsive acceleration **38 m/s² grounded / 17 m/s² airborne**, walk **5 m/s**, sprint **7.2 m/s**, normalized diagonals, **8.9 m/s** jump, coyote time, and jump buffering. No extra input delay was added to hide visual turning. Moving-platform velocity compensation and dynamic crush-pressure logic were removed.

**17. Third-person camera.** Stable 6 m horizontal boom, 2.25 m elevation, 66° FOV, interpolated horizontal follow, eased eye height, and 0.22 m sphere-cast collision. Obstruction pull-in is immediate; return eases outward. Camera yaw is controlled only by mouse/keyboard look, independently of character-facing animation. Falling sensors cannot yank the camera. Corridor/obstruction checks passed at 1440×900 and 1366×768.

**18. First person.** 1.30 m eye height, 78° FOV, no head bob. The followed third-person body is hidden. Pointer and keyboard pitch/yaw work in the same directions as third person. Walking, jumping, climbing, dodging, and close corridors passed.

**19. V/session persistence.** The selected view persists through round changes and local match restarts. A fresh page load restores third person. Held-toggle repeat is ignored. The selected view remains in the existing local ArenaScene state.

**20. Rebinding/help.** Crate-only overrides retain the existing shared binding inheritance, conflict resolution, storage, held aliases, and fresh-press logic. Headed tests rebound camera/move/look/sprint/jump, verified the old camera key stopped toggling, and verified current help labels. Shared control storage stayed untouched. Help now explains clicking once and moving without holding the trackpad.

**21. Static support.** Passed grounded standing, one-crate jump, adjacent seam traversal, two-level stepped climbing, four-layer deterministic support, edge/coyote jumps, and corridor/wall containment. Standing height stayed within 0.003 m in headed checks. Stationary crates are not attacks. Crouch is not a supported Crate Rain action and was not introduced.

**22–23. Full 2P/3P headed matches.** Four complete, three-round local matches used real Chrome key down/up input, one controlled seat, and the existing local bot seats. Both camera modes were covered at each seat count. All twelve rounds ended by early last survivor. A separate headed fixture validated two survivors drawing at exactly 20.000 seconds and an immediate early winner. Thirty additional seeded simulated rounds included full 20-second survivor draws.

| Seats | View | Active round durations, seconds | Match FPS | Peak crates |
|---|---|---|---:|---:|
| 2 | third | 13.642, 18.575, 18.050 | 60.00 | 99 |
| 2 | first | 5.208, 12.608, 17.250 | 60.00 | 81 |
| 3 | third | 15.925, 17.217, 18.208 | 60.00 | 94 |
| 3 | first | 12.900, 16.367, 18.033 | 60.00 | 91 |


[All headed match results](/private/tmp/crate-rain-20s-20261005-234442/all-headed-matches.json). The second 2P run exposed the final-results pointer-lock issue; it was fixed, and the separate locked-results/restart regression passed before the 3P runs. Camera mode persisted across those restarts.

**24. Performance.** Headed Chrome, 1440×900, device scale factor 1; actual gameplay renderer; three live dynamic players. Third-person measurements keep all three characters visible, FPS hides only the followed player. Six-second measurement windows follow fixture warm-up. JS/frame covers the Crate Rain frame callback; physics figures are per 120 Hz step. Browser timing resolution quantizes the tails. This is a local-machine measurement, not a hardware-wide FPS guarantee.

| View | Fixed crates | FPS | JS/frame avg ms | Physics avg / p99 / max ms | Dynamic / kinematic / fixed bodies | Draw calls | Triangles | Invalid |
|---|---:|---:|---:|---|---|---:|---:|---:|
| third | 20 | 60.00 | 0.460 | 0.040 / 0.200 / 0.300 | 3 / 0 / 20 | 38 | 20,830 | 0 |
| third | 40 | 60.00 | 0.387 | 0.033 / 0.200 / 0.800 | 3 / 0 / 40 | 38 | 22,750 | 0 |
| third | 60 | 59.99 | 0.386 | 0.035 / 0.200 / 0.200 | 3 / 0 / 60 | 38 | 24,670 | 0 |
| third | 80 | 60.00 | 0.399 | 0.036 / 0.200 / 0.200 | 3 / 0 / 80 | 38 | 26,590 | 0 |
| third | 100 | 60.00 | 0.385 | 0.031 / 0.200 / 0.200 | 3 / 0 / 100 | 38 | 28,510 | 0 |
| first | 20 | 60.01 | 0.316 | 0.031 / 0.200 / 0.200 | 3 / 0 / 20 | 27 | 15,096 | 0 |
| first | 40 | 60.01 | 0.327 | 0.028 / 0.100 / 0.200 | 3 / 0 / 40 | 27 | 17,016 | 0 |
| first | 60 | 60.00 | 0.346 | 0.032 / 0.200 / 0.200 | 3 / 0 / 60 | 27 | 18,936 | 0 |
| first | 80 | 60.00 | 0.344 | 0.031 / 0.100 / 0.200 | 3 / 0 / 80 | 27 | 20,856 | 0 |
| first | 100 | 60.00 | 0.369 | 0.032 / 0.200 / 0.200 | 3 / 0 / 100 | 27 | 22,776 | 0 |


There are also **five bodyless fixed environment colliders** (floor + four walls), so total colliders are fixed crates + 8. Zero dynamic crates, zero kinematic landed crates, zero invalid bodies, and zero tunneling in every row. Crates use three instanced draws; character geometry accounts for the additional calls. [Performance evidence](/private/tmp/crate-rain-20s-20261005-234442/perf-browser.json).

A separate Retina input scale of 2 (renderer capped at 1.5 DPR) with 100 fixed crates measured third: 60.00 FPS, 0.580 ms JS/frame, first: 59.99 FPS, 0.439 ms JS/frame. [Retina evidence](/private/tmp/crate-rain-20s-20261005-234442/retina-browser.json).

**25. Bots.** Think intervals tightened to 0.10–0.19 s; reaction delays remain around 0.20–0.31 s. Bots consider only already displayed warnings, fixed support heights, current safe destinations, and intermediate route heights. They use the same physical controller and can jump onto one-level rises. Seeded hesitation remains, and late warnings can beat their reactions. No future spawn list or hidden RNG knowledge is passed to them.

**26. Fairness.** **72** reproducible center-drop trials cover warnings 0.95/0.80/0.65 s, reactions 0.15/0.25/0.35/0.45 s, and six escape directions. **54 survived**. Every **0.15/0.25 s** reaction survived (36/36). At 0.80 s, 0.45 s reactions failed; at 0.65 s, 0.35/0.45 s reactions failed. Worst tested 0.25 s escape crossed the expanded square footprint by 0.617 s; rounded capsule/corner contact permits diagonal escape sooner than that conservative square bound. A centered player must clear about **1.02 m** on an open cardinal route. Direct, adjacent-miss, simultaneous-death, and extreme one-step sweep tests passed. Coverage runs peaked at **10 concurrent warnings**, never duplicate reserved cells; late adjacent cells may be only 1.4 m apart. This does **not** prove every late trapped position has an escape: choosing when to climb matters. No invisible or zero-warning gameplay drops were introduced.

**27. Validation.** Crate Rain plus complete shared input suite: **46/46**. Full frontend suite: **730/730**. Existing server suite: **57/57**. TypeScript and Vite production build pass (`npm run build`). Vite retains its existing large-chunk advisory. Headed input, climbing, rebindings, 2P/3P matches, timer results, native Escape lifecycle, coverage, performance, and reset checks pass. `git diff --check` and whitespace checks covering the untracked Crate Rain files pass. Twenty-five simulation resets and twelve headed resets return to baseline body/collider counts; headed resets retain **37 geometries / 4 textures**. No pending per-crate timers exist.

Reproduce with `npx tsx --test src/party-lab/scene/craterain/craterain.test.ts src/party-lab/input/*.test.ts`, `npx tsx scripts/validate-party-lab-crate-rain.ts`, and the [headed runner](/private/tmp/crate-rain-20s-20261005-234442/browser.mjs). Test modes are `input`, `extra`, `coverage`, `perf`, `matches`, and `matches3`. Full logs are in the evidence directory below.

**28. Protected modes/online.** Snowball Fight, Kart Race, Classic Bowling, their validation scripts, all shared/server/network files, PartyRoom, lobby, and Mixed remain byte-identical to the external baseline. Existing frontend/server regressions and headed smoke visits pass. The only additional ArenaScene change in this task is the Crate Rain-specific `onLockLost={lockEnded}` prop. **Production protocol remains 12.** No protected mode refactor. SHA-256 verification covers all 11 Snowball Fight, 17 Kart Race, and 13 Classic Bowling source files, and every baseline file outside the allowed change scope. [Preservation evidence](/private/tmp/crate-rain-20s-20261005-234442/preservation.json).

**29. Files changed in this task.** `src/party-lab/scene/ArenaScene.tsx` (one Crate-only prop); `scripts/validate-party-lab-crate-rain.ts`; and these files inside `src/party-lab/scene/craterain/`: `config.ts`, `game.ts`, `bots.ts`, `camera.ts`, `visual.ts`, `CrateRainPlayground.tsx`, `CrateRainHud.tsx`, `CrateControls.tsx`, `craterain.css`, `craterain.test.ts`, `REPORT.md`. `controls.ts` and `warnings.ts` remain byte-identical. Existing uncommitted work is retained.

**30. External backup/evidence.** [/private/tmp/crate-rain-20s-20261005-234442](/private/tmp/crate-rain-20s-20261005-234442). The pre-edit backup is `uncommitted-backup.tar.gz`; verification uses `before-sha256.json`, `tracked-before.diff`, and `status-before.txt`. No destructive Git operations were performed.

**31. Remaining manual-feel checks.** Physical MacBook trackpad sensitivity, subjective comfort of the 0.65-second final warnings, and whether early climbing feels too safe before the final stacks still benefit from your hands-on play. Automated headed movement and timing are verified; subjective human feel is not claimed as a measured pass. No implementation/test failures remain.
