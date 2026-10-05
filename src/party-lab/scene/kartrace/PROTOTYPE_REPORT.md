ARABA YARIŞI · local track, grip and controls pass · 2026-10-05

Implemented directly in the current uncommitted working tree. Open **Party Lab → Yerel Test Arenası → Araba Yarışı**. Esc → Kontroller edits the current Race bindings. Esc → Oyuncu selects 2 or 3 seats. The existing local format is one human seat plus one/two bots.

[Before/after circuit plan](/private/tmp/kart-race-grip-20261005-193019/track-plan.svg) · [Physical experiments](/private/tmp/kart-race-grip-20261005-193019/measure.json) · [Headed races and performance](/private/tmp/kart-race-grip-20261005-193019/matches-browser.json) · [Keyboard/rebinding checks](/private/tmp/kart-race-grip-20261005-193019/feel-browser.json) · [Reload/pause check](/private/tmp/kart-race-grip-20261005-193019/persistence-browser.json)

**1. Old track length:** 589.214 m, measured from the backed-up current prototype.

**2. New track length:** 593.483 m along the sampled centerline, an increase of 4.269 m / 0.72%. The analytic tangent/arc design is 593.496 m; the 1.3 cm difference is chord sampling.

**3. Old meaningful corner count:** 8. Counted using the same reproducible method on both circuits: absolute curvature above 0.018/m; same-direction clusters merged across gaps shorter than 6 m; accumulated turn greater than 20°. This treats the two separated northern bending sections individually, and connected same-direction complex bends as one event. Total absolute heading change was approximately 1,040°, showing the repeated reversals even where an event contains several apexes.

**4. New meaningful corner count:** 5 by the same method, a 37.5% reduction. Total absolute heading change is 360°, with no hairpins or alternating technical sequence. Approximately 68% of the lap consists of actual straight centerline sections.

**5. Final corners, in lap order:**

| Event | Description | Radius | Heading change | Arc length |
|---|---|---:|---:|---:|
| 1 | Fast northern sweeper after the main straight | 38 m | 90° | 59.69 m |
| 2 | Broad eastern near-right-angle turn | 32 m | 79.88° | 44.61 m |
| 3 | Open southern sweep | 32 m | 60.65° | 33.87 m |
| 4 | Broad western return | 30 m | 64.25° | 33.64 m |
| 5 | Final park bend, the sole slower corner | 18 m | 65.22° | 20.49 m |

All join the straights tangentially. The final bend is tighter, but is far short of a hairpin. No corner requires handbrake.

**6. Major straights:** Main straight **130.48 m** (53.48 m approach to the line + 77 m after it); east straight **96.70 m**; southern diagonal **72.56 m**; north straight **60.21 m**; western link **41.24 m**. The main straight is long enough for sustained acceleration, reaching the existing 110 km/h cap and racing abreast. This replaces the interior switchbacks with usable distance.

**7. Width:** Base asphalt remains **10 m**, with **12 m** passing/grid zones on the main and east straights. The 2.12 m collision envelopes leave space for two or three cars. Several inner sections have open grass runoff; the approximately **56.4 m** outside ridge is physically exposed. Cars can still push each other onto grass or off the plateau. The collision fixture pushed the victim off the exposed edge and triggered the existing legal rescue.

**8. Old asphalt behavior:** Four support rays, ride-height spring, surface classification, engine and yaw response were audited. Lateral velocity damping of **9/s** was the principal looseness source: the chassis could yaw ahead of its travel direction, retaining outward slip. Surface detection already worked. The low ground/chassis collider friction is intentionally distinct from the controller's virtual tire grip.

**9. New asphalt behavior:** Asphalt lateral damping is **16/s**. Normal steering/yaw rate, input smoothing, suspension, mass, restitution, contact physics and surface classification are preserved. Sideways momentum decays progressively, never disappears in one step. Grass remains at **3.2/s**. Handbrake temporarily releases lateral stability; it does not change the camera or physical collision groups.

**10. Matched grip measurements:** Old RaceCar code was loaded from the exact pre-change backup and driven on the same new track as the new RaceCar. Three corners × 35/65/100 km/h entries × −1.5/0/+1.5 m line offsets = **27 trials per tuning**. Both use the same route follower, updated every 100 ms, with normal braking and no handbrake. Exit is sampled 15 m beyond the arc.

| Metric, mean across 27 trials | Old | New |
|---|---:|---:|
| Lateral slip | 0.671 m/s | 0.355 m/s |
| Exit heading error | 3.929° | 2.801° |
| Exit centerline error | 0.044 m | 0.095 m |
| Exit speed | 85.013 km/h | 84.943 km/h |
| Trials leaving asphalt | 0 / 27 | 0 / 27 |

Average lateral slip fell **47.1%**; exit heading error fell **28.7%**. Exit speed changed by less than 0.1 km/h. Centerline exit error increased by **5 cm**, remaining under 10 cm on average; the result is improved slip/alignment, not a claim that every metric improved. The observed off-road rate was 0% for both tunings in this finite assisted test set. It is not an estimate of an unaided human's crash probability.

Representative centerline-entry results below show low, medium and high entry speeds. Steering is the maximum normalized input magnitude; 1 means full steering. Slip is mean / peak m/s. All nine stayed on asphalt without handbrake.

| Corner | Entry km/h | Slip mean / peak | Exit heading error | Exit km/h | Max steering |
|---|---:|---:|---:|---:|---:|
| Hızlı kuzey yayı | 35 | 0.35 / 0.71 | 2.58° | 92.5 | 0.51 |
| Hızlı kuzey yayı | 65 | 0.39 / 0.68 | 2.51° | 92.0 | 0.49 |
| Hızlı kuzey yayı | 100 | 0.41 / 0.68 | 2.50° | 91.0 | 0.49 |
| Geniş doğu virajı | 35 | 0.32 / 0.69 | 2.33° | 87.6 | 0.52 |
| Geniş doğu virajı | 65 | 0.35 / 0.69 | 2.29° | 87.3 | 0.52 |
| Geniş doğu virajı | 100 | 0.37 / 0.68 | 2.39° | 87.9 | 0.51 |
| Son park virajı | 35 | 0.25 / 0.63 | 3.53° | 76.2 | 0.55 |
| Son park virajı | 65 | 0.28 / 0.63 | 3.48° | 74.2 | 0.54 |
| Son park virajı | 100 | 0.30 / 0.62 | 3.67° | 75.4 | 0.55 |

**11. Acceleration/top speed:** Unchanged **7.8 m/s²**, **110 km/h** engine cap, 240 kg. Matched old/new measurements are identical: **0–50 km/h 1.783 s; 0–100 km/h 3.567 s; peak 110.000 km/h**. Normal braking remains 18 m/s²; reverse remains capped at 6 m/s. No speed increase was needed.

**12. Steering:** Unchanged base yaw law `2.7 / (1 + |speed| / 18) × min(1, |speed| / 3)`, input smoothing 10/s, yaw response 9/s and bounded yaw acceleration 5 rad/s². No instant heading assignment, route snapping or scripted drift angle. Collisions still contribute real angular momentum. Grass keeps 70% normal steering authority. The four approved camera presets and camera code remain byte-for-byte unchanged.

**13. Handbrake physics:** A 12/s engagement/release ramp reduces asphalt lateral damping toward **4.8/s**, reduces yaw stabilization response from 9/s toward **4.5/s**, and permits up to **24%** extra steering yaw response as the rear becomes less stable. It adds **10 m/s²** braking at full engagement. Grass lateral damping can fall from 3.2/s to 1.6/s while held. This is a race-local arcade tire-release model using the existing velocity/yaw controller and Rapier contacts, not a separate wheel-by-wheel tire simulation. It neither zeroes velocity nor assigns a drift angle. Long holds lose speed and can over-rotate the line.

**14. Controlled handbrake experiment:** Same 65 km/h entry at the broad eastern corner, same 0.5 steering, no throttle/brake pedal, 1.5 s observation. A broad calibration road avoids barriers masking the response. Effective radius is traveled distance divided by accumulated yaw, not a fitted geometric circle. Exit alignment is heading relative to the route tangent.

| Hold | Effective radius | Yaw change | Speed loss | Peak slip | Exit alignment error |
|---|---:|---:|---:|---:|---:|
| 0.0 s | 29.14 m | 51.10° | 5.65 km/h | 0.64 m/s | 6.76° |
| 0.1 s | 26.95 m | 52.31° | 9.25 km/h | 0.63 m/s | 10.07° |
| 0.4 s | 21.11 m | 56.85° | 20.44 km/h | 1.17 m/s | 20.91° |
| 1.5 s | 11.91 m | 72.92° | 60.54 km/h | 1.86 m/s | 47.50° |

A tap adds about 1.2° yaw; 0.4 s adds about 5.7° and a noticeable slide; 1.5 s adds about 21.8° but leaves only 4.46 km/h and poor exit alignment. Handbrake before/during/after real side impacts remained finite, with peak yaw rates below 2.56 rad/s and no reset. An exposed-edge ram still moved the victim physically; pre-impact handbraking reduced the attacker's speed enough to avoid the fall in the paired case. It does not suppress contacts or discard collision impulses.

**15. Default handbrake:** **Space**. It is a default binding, not a gameplay key-code branch.

**16. Semantic integration:** Gameplay consumes `moveForward`, `moveBackward`, `moveLeft`, `moveRight`, `raceHandbrake`, `raceCamera`, `raceReset`. The Race adapter maps these into a private instance of the unchanged shared InputManager, preserving held-state, alias, edge, suspension and clear semantics. No Race action was added to the production input/network schema. The adapter's internal slots do not change another mode's actions.

**17. Controls architecture:** Shared movement bindings come from the existing `party-lab-controls-v1` profile and update through ArenaScene's existing `onBindings`. Race-only extras persist separately under `party-lab-race-controls-v1`. The Race settings panel reuses Party Lab's `captureBinding`, binding validation/labels, conflict handling and primary/secondary binding presentation. Keyboard and mouse aliases both work. A pre-existing shared profile using Space/V/R for movement keeps its movement bindings; conflicting Race extras resolve to unused visible keys without stealing another Race action's valid binding. The Race UI rejects newly introduced conflicts. Shared input source files and default profiles were not changed.

**18. Non-default validation:** Headed Chrome changed handbrake **Space → H**, accelerate **W → I**, left steering **A → J**, camera **V → C**, and reset **R → T**. Actual keyboard checks verified the original keys stopped triggering those actions and new keys worked. Defaults were restored and Space worked again. A separate reload check confirmed H persisted, Space remained inactive, pause froze race time, and restoration re-enabled Space. An initial fixed 200 ms post-resume assertion was sensitive to browser scheduling during build; the final check waits for the physical handbrake state after UI resume and passes.

**19. Dynamic help:** HUD, Race settings labels and the missed-checkpoint reset prompt read the current bindings. The headed check verified `H · El freni`, `I · Gaz`, `J · Sol`, `C · Kamera`, and `T · Sıfırla`. [Rebound settings screenshot](/private/tmp/kart-race-grip-20261005-193019/rebound-menu.png). There is no permanently printed Space/V/R Race gameplay hint.

**20. Complete default controls:**

| Action | Default | Optional alias |
|---|---|---|
| Gaz | W | ↑ |
| Fren / Geri | S | ↓ |
| Sol | A | ← |
| Sağ | D | → |
| El freni | Space | Configurable |
| Kamera | V | Configurable |
| Sıfırla | R | Configurable |
| Menü / duraklat | Esc, reserved UI action | — |

**21. Off-road:** Still **40% engine acceleration**, **52.8 km/h useful speed cap**, 3.2/s lateral grip and 70% steering authority. Excess speed drains progressively at 7 m/s², preserving the immediate collision impulse. The road/grass distinction is stronger because only asphalt grip increased. Headed cases cover off-road recovery, straight/before-corner/corner contacts and handbrake timing at both viewport sizes.

**22. Checkpoints/reset:** All **18 ordered gates** were rebuilt from the new centerline at approximately **32.97 m** spacing. Forward swept crossing, finite gate width/height, start arming, ordered laps, finish order, anti-cut and reverse protection are unchanged and tested. The fall/stuck/manual rescue code is unchanged: last earned gate, 1.15 s hold, 3 s cooldown, no unearned progress. The exposed section moved to the east straight; its actual fall/contact test passes.

**23. Bots:** Route samples, lookahead points and curvature preview are generated from the redesigned track. Bots accelerate to the same 110 km/h cap on long straights and brake for the five corners through the existing 65 m braking preview. They use the same RaceCar, mass, grip, engine and contacts. They do not use or require handbrake. Existing overtaking, blocked-reverse and missed-gate backtracking logic remains; complete 2P/3P headless races and the missed-gate recovery regression pass without resets.

**24–25. Headed complete races:** Visible Google Chrome, actual keydown/keyup input for the human seat, route-guided automated steering/braking. No `autoHuman` or accelerated stepping was used in these races. These are repeatable manual-style checks, not a claim that an unaided human has approved subjective feel. Both completed all three laps without handbrake, verified finish order and rematch, with zero invalid bodies/resets. Additional focused runs at **both 1440×900 and 1366×768** cover full throttle, normal brake/reverse, gentle/broad/slow corners, tap/moderate/long handbrake, straight and corner contact, grass recovery and rebinding.

| Race | Resolution | Finish order/times | Contacts | Position changes |
|---|---|---|---:|---:|
| 2P | 1440×900 | MAVİ 81.05 s, SEN 88.95 s | 17 | 2 |
| 3P | 1366×768 | MAVİ 79.60 s, SARI 88.82 s, SEN 90.53 s | 13 | 3 |

Start-grid traffic, side-by-side passes, contact, grass excursions and finish ranking are recorded in the traces. All racers finish inside the existing grace period. Learning ease still needs the user's own play impression; the objective layout and driving checks now show long recovery/acceleration windows.

**26. Performance:** Real-time headed frames, excluding the first 120 warmup frames. Physics timing measures `world.step`; JS timing measures the existing simulation/visual/camera frame callback. Straight-road rendering now removes redundant collinear vertices while retaining width transitions, arc geometry and the full physics centerline.

| Metric | 2P / 1440×900 | 3P / 1366×768 |
|---|---:|---:|
| Average FPS | 60.00 | 60.00 |
| Physics average / p99 / max, ms | 0.188 / 0.400 / 2.500 | 0.188 / 0.400 / 1.500 |
| JS average / p99, ms | 0.685 / 1.500 | 0.780 / 1.300 |
| Peak draw calls | 14 | 15 |
| Peak triangles | 22,506 | 22,592 |
| Dynamic bodies | 2 | 3 |
| Total colliders | 362 | 363 |
| Invalid bodies | 0 | 0 |
| Dropped simulation seconds | 0 | 0 |

Original report reference: 60.00 FPS, 14/15 peak calls, 23,832/23,918 peak triangles and 407/408 colliders. There are now 45 fewer colliders in each player-count configuration. Timing is a local sample, not a hardware-independent guarantee.

**27. Tests/builds:** **708/708 Party Lab frontend tests passed**, including all eight production modes and network prediction/session cases. This includes **30/30 Race tests** for geometry, checkpoints/order/laps/anti-cut, bot recovery, physical collisions, asphalt/grass, handbrake timing, binding/rebinding/help, reset, camera and full races. After the final input conflict/blur refinements, the focused Race suite passed again. TypeScript and the production build passed. `git diff --check` passed. Existing large-bundle warnings remain. The first sandboxed full run stalled on the existing chat socket test; the complete suite was then rerun with local socket access and passed. Physical experiment assertions and headed handling/rebinding/persistence/full-race checks pass.

Reproduce current physical tests: `node --import tsx scripts/validate-party-lab-kart-race.ts`. For matched old/new measurements, set `RACE_BASELINE_DIR` to the backup root below and `RACE_VALIDATION_OUT` to an external result directory. Browser harness and raw logs are in the linked artifact folder.

**28. Crate Rain:** All mode files and its validation script remain byte-for-byte identical to the current-turn baseline. Its existing ArenaScene branch is unchanged.

**29. Snowball Fight:** All mode files and its validation script remain byte-for-byte identical to the current-turn baseline. Its existing ArenaScene branch is unchanged. Together with Crate Rain, **23 protected files** were checked.

**30. Existing-mode regression:** Compared the **947-file current-turn manifest** and the existing **1,789-file source/asset baseline**. The latter differs only in ArenaScene, whose Race-only changes against this turn's baseline were separately reviewed. Bowling driving, camera/V presets, launch, Nudge, audio, input and physics are unchanged. Shared controls, PartyRoom, lobby, server, Mixed and protocol files are unchanged. **Protocol remains 12.** No online Race implementation, mode registration, commit, push, reset, checkout, stash, clean or deployment. [Hash results](/private/tmp/kart-race-grip-20261005-193019/regression-hashes.json).

**31. Files changed in this pass:**

- `src/party-lab/scene/ArenaScene.tsx`: Race binding state and Race-only UI/input props.
- Under `src/party-lab/scene/kartrace/`: `track.ts`, `config.ts`, `car.ts`, `RacePlayground.tsx`, `RaceHud.tsx`, `visual.ts`, `race.css`, `race.test.ts`, `PROTOTYPE_REPORT.md`.
- New Race-only files: `controls.ts`, `controls.test.ts`, `RaceControls.tsx`.
- `scripts/validate-party-lab-kart-race.ts`: updated physical experiments and geometry/grip/handbrake assertions.

`game.ts`, `rules.ts`, `bots.ts`, `camera.ts`, and `audio.ts` remain byte-for-byte unchanged; they consume the new track/vehicle data through their existing interfaces.

**32. Backup:** `/private/tmp/kart-race-grip-20261005-193019/backup/` contains the exact pre-change Race, Crate Rain and Snowball Fight trees, their validation scripts and ArenaScene. The parent folder contains the original binary git diff, SHA-256 manifest, review diff, measurements, logs and screenshots. The earlier complete 3.16 GB repository backup also remains available at `/private/tmp/world-quiz-pre-kart-20261005-175137/repository-complete.tar`; the current-turn backup captures the newer uncommitted Race work that postdates it.

**33. Remaining manual tuning questions:** Whether 16/s asphalt grip feels right on your keyboard; whether the 0.4 s handbrake's roughly 20 km/h loss is the preferred tradeoff; and whether the simple five-corner rhythm gives your group enough contact opportunities. Camera and reset penalty choices remain unchanged for a separate pass. These are subjective follow-up preferences, not failed validation checks.
