# KLASİK BOWLING · local prototype validation

Validated 2026-10-05 against the existing **uncommitted working tree**, HEAD `4636788`. Local Test Arena only. Protocol **12**. No commit, push, deployment, online registration, Mixed change, or server change.

Open `http://127.0.0.1:5211/party-lab`, choose **Yerel Test Arenası → Klasik Bowling**. The development server is left running for manual testing. Esc exposes player count, controls and audio settings.

**1. Real bowling geometry research.** The USBC manual, pages 5, 19, 30, 37 and 39, supplies the geometry below. Its gutter installation drawing distinguishes typical installation depth from the required minimum. [Primary source: USBC equipment specifications](https://bowl.com/getmedia/3b4c11d8-0140-489a-9359-9be064776e7e/23_263-APRIL-23-ES-Manual-Update_1.pdf). The triangular 1–2–3–4 arrangement is also explained in [USBC Level I coaching material](https://images.bowl.com/bowl/media/legacy/internap/bowl/coaching/pdfs/Level%20IScript.pdf).

| Dimension | Real standard | Party Lab adaptation |
|---|---|---|
| Lane width | 41½ ±½ in, nominal 1.0541 m | 1.50 m |
| Foul line to head pin | 60 ft, 18.288 m | 10.50 m |
| Gutters | 9¼ ±¼ in wide; ≥1⅞ in central depth | 0.34 m wide; 0.19 m deep |
| Pin height / belly diameter | 15 in / nominal 4.766 in | 0.47625 m / 0.151 m |
| Adjacent pin centres | 12 in, 0.3048 m, equilateral triangle | 0.381 m; rows 1, 2, 3, 4 |
| Pin mass | 3 lb 6 oz–3 lb 10 oz, about 1.53–1.64 kg | 1.58 kg |
| Ball diameter / maximum mass | 8.500–8.595 in / 16 lb | 0.270 m / 6.50 kg |

**2. Adaptation rationale and assets.** Ball, pin and rack proportions are approximately 1.25× real size. The lane is shorter and somewhat wider for readable browser play and useful straight-ball lines. Deeper simple U-shaped gutters keep the ball physically contained. The existing verified CC0 pin/kit pipeline and procedural audio were inspected. This mode uses its own small lathed pin silhouette, matching convex hulls, procedural room geometry and sounds; no asset pack or proprietary game art was imported. Human Bowling's scaling, physics, camera and audio are not imported.

**3. Match rules.** One human plus one or two bots. Three frames per player. Deterministic frame-by-frame seat order A→B or A→B→C. Highest total wins; tied leaders share a draw.

**4. Frame, roll and scoring rules.** At most two rolls per frame, each knocked pin worth one point. A first-roll strike ends the frame immediately. Second-roll scores only the remaining pins. Strike and spare both total 10, open frames total actual pinfall. Maximum match score is **30**, with no future-frame bonuses or final-frame bonus balls.

**5. Camera.** Fixed third-person lane view: position `(0, 3.35, -6.40)`, target `(0, 0.05, 5.30)`, vertical FOV **46°**, near/far **0.05/65 m**. During the throw, position and target translate together by `clamp(ball.z × 0.76, 0, 7.5)` with exponential smoothing rate **2.4/s**. Pitch, yaw and FOV stay constant. The 1.05-second setup-return phase begins the smooth return; there is no orbit, shake or chase rotation. Reduced-motion preference disables forward tracking.

**6. Lane.** 1.50 m wide, launch/foul line at z=0, head pin z=10.50, deck ends z=11.65. One active lane, two decorative lanes, ball returns, benches, signage, rear machinery and ceiling light strips. Only the active lane has physical pins.

**7. Gutters.** Each channel is 0.34 m wide and 0.19 m below the lane. Box floor, lane side and outer wall form a recessed channel; rear kickbacks and pit are also simple boxes. No instant ball deletion, teleport, gutter scoring bonus or hidden bumper. A gutter classification requires the ball to physically drop into a channel before pin contact, including late entry alongside the rack. All sampled classified gutter throws scored zero.

**8. Ball.** One dynamic Rapier sphere, radius **0.135 m**, mass **6.5 kg**. Its visual finger holes are decorative and introduce no asymmetric physics.

**9. Pins.** Height **0.47625 m**, maximum radius **0.0755 m**, mass **1.58 kg**, centres **0.381 m** apart; row separation ≈0.329956 m. Two 12-sided convex hulls plus a tiny **0.048×0.016×0.048 m** flat foot provide stable contact. Masses are 1.10/0.30/0.18 kg; computed centre of mass is ≈**0.188 m above the base**. Render and hull profiles share the same silhouette. Seeded pinsetter tolerance is only ±1.5 mm in x/z and ±0.02 rad yaw; no tilt, overlaps, or post-release randomness. A 20-second untouched-rack test verifies stability. An early unstable convex-only/cylinder base was corrected before final sampling.

**10. Position sweep.** **±0.56 m**, constant 1.6593 m/s, **0.675 s edge-to-edge / 1.35 s cycle**. Speed doubled from the previous 0.8296 m/s (1.35 s edge-to-edge / 2.7 s cycle). Starts at centre, reverses indefinitely. Ball edge remains 5.5 cm inside the lane at extreme setup positions.

**11. Direction sweep.** **±6.5°**, **0.825 s edge-to-edge / 1.65 s cycle**, 15.758°/s. Speed doubled from the previous 7.879°/s (1.65 s edge-to-edge / 3.3 s cycle). The initial ±12° idea would send too much of this short lane's gauge into gutters; ±6.5° retains useful inward lines and clear risk. Internal +X projects to screen-left; HUD signs and the flat aiming arrow are corrected to screen coordinates.

**12. Power sweep.** **35–100%**, **1.5 s low-to-high / 3 s cycle**, 43.333 percentage points/s. Repeats indefinitely, with a useful nonzero minimum.

**13. Power to velocity.** Exactly `speed = 4 + 5.5 × (power − 35) / 65` m/s, clamped to the displayed range. Minimum **4 m/s**, maximum **9.5 m/s**. Smooth linear mapping, no strike boost. Forward angular velocity matches rolling speed/radius; vertical-axis spin is zero on release.

**14. Three-phase state machine.** `POSITION → fresh select → DIRECTION → fresh select → POWER → fresh select → ROLLING → physical settling/scoring → FEEDBACK → RETURN → next setup`. One press consumes one semantic action edge. Held keys, browser repeats and overlapping binding aliases cannot skip phases. Gauges use presentation delta; physical motion uses fixed 120 Hz steps. Very late selections and several complete gauge cycles work.

**15. Rebinding.** Uses the existing Party Lab `jump` action, default Space, through `bindKeyboard`/`InputManager`. Current primary/secondary binding labels appear in the HUD. Classic's controls panel labels it **Seç / At** and uses the existing binding capture/conflict/persistence path. This is the shared jump binding, explicitly stated in the panel. Headed test changed it to Q: old Space did nothing; Q advanced all three phases; default Space restored. Shared input code and other modes' action consumers are unchanged.

**16. Ball/lane physics.** Gravity 9.81 m/s²; fixed **120 Hz**, six solver iterations in this world only. Ball friction **0.16**, restitution **0.035**, linear damping **0.018**, angular damping **0.025**. Lane friction **0.12**, restitution **0.05**; gutter floor friction **0.18**, restitution **0.02**. Angular damping plus contact friction supply rolling resistance. Only the ball enables CCD, with two maximum CCD substeps. No lateral drift force, hook control, post-release steering, launch-parameter score lookup or corrective impulse.

**17. Pin physics.** Free dynamic bodies tip, slide and hit one another. Hull friction **0.24**, restitution **0.22**, linear/angular damping **0.22/0.30**; foot restitution **0.05**. Physical kickback restitution **0.35** can return pins by collision. No scripted chain-reaction force. Maximum **11 dynamic bodies**. Normal full-rack setup: **10 bodies / 39 colliders** (30 pin + 9 fixed). Active throw adds one sphere collider/body.

**18. Strike/spare detection and settling.** A pin is down after tilt exceeds **45°**, it leaves the deck bounds, or its base drops below −0.09 m, continuously for **0.18 s**. A one-step wobble is rejected. Pin motion is quiet below 0.15 m/s linear and 0.8 rad/s angular speed for **0.35 s**. Resolve no earlier than **1.6 s** after first pin contact, with **2.8 s** settling maximum and **7 s** total-roll safety timeout. Untouched misses start settling after passing the deck/stopping. STRIKE/SPARE derives solely from the physical down mask and frame roll number. Original procedural release, rolling, gutter, impact and result sounds reuse the existing bounded audio pool; pause/unmount stops only Classic's voices.

**19. Second roll.** Remove down pins; respot only surviving pin IDs upright at their standard rack spots with the same small pinsetter tolerance. This avoids unstable partially leaning carry-over while preserving the actual spare layout. Ball is removed and setup repeats. All ten pins return only after strike or second roll.

**20. Bots.** Plans select times on the same three repeating gauges, then call the same selection/launch code. Position/direction timing jitter and minimum delays scale with their respective sweep periods to preserve the original planned selection/error distribution; power timing is unchanged. Straight, angled and power tendencies are implemented; normal bot seats favour angled/high-power play. The 500-throw sample rotates all three tendencies. Position, aiming and timing errors vary; power is imperfect; spare targets are selected from surviving physical pins. Bots receive no extra ball energy, spin or pin assistance.

**21. Original position experiments.** Headed variants tested ±0.42 m/1.5 s, ±0.56 m/1.8 s, ±0.60 m/2.2 s. Measured extrema confirmed the actual live configuration, with real keyboard choices scoring 9, 8 and 10 respectively (illustrations, not a statistical ranking). The chosen middle range preserves a 5.5 cm ball-edge margin; its original 3.6-second cycle was subsequently shortened to 2.7 seconds, then 1.35 seconds after manual timing feedback (see §10). At fixed 78% power, seven starts across the entire final width aimed towards the centre scored **7, 7, 8, 9, 8, 9, 9**. Both edges and centre are useful.

**22. Angle experiments.** At x=0 and 78% power, −6.5°…+6.5° in 0.5° increments produced a broad useful region, with outer angles missing. Representative physical scores below; angles here use internal world coordinates. Full paths, gutter flags, entry positions and scores are in `simulation-summary.json` / `dense.json`.

| Angle | −6.5 | −3.5 | −3 | −2 | −1 | −0.5 | 0 | +0.5 | +1 | +2 | +3 | +3.5 | +6.5 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Pins | 0 | 1 | 3 | 6 | 7 | 9 | 9 | 10 | 7 | 7 | 4 | 1 | 0 |

Small angle changes yield continuous pre-impact positions; collision outcomes can still change discretely. The strongest observed pocket was additionally tested over 100 different rack seeds: **67 strikes**, scores 9–10. With small position/angle/power timing perturbations: **40 strikes**, scores 7–10, average 9.07. A ten-seed preliminary pocket run had been 10/10; the expanded sample did not support treating it as guaranteed. Identical seed and inputs remain deterministic by design.

**23. Power experiments.** Same centre/straight throw and rack seed:

| Power | Launch m/s | Time to first pin, s | Impact m/s | Pins |
|---|---:|---:|---:|---:|
| 35% | 4.000 | 2.658 | 3.788 | 8 |
| 55% | 5.692 | 1.850 | 5.475 | 9 |
| 78% | 7.638 | 1.375 | 7.406 | 9 |
| 100% | 9.500 | 1.108 | 9.256 | 8 |

Higher power adds real energy but does not guarantee more pins. Headed left/low, centre/medium, right/inward/high, gutter/high-end, weak-side and pocket throws scored **9, 8, 10, 0, 1, 10**. Node tests also exercise the exact 100% endpoint; real-keyboard high-end choices are naturally timing-limited.

**24. Dense sample.** **756** deterministic throws: 7 lateral positions × 27 angles × 4 powers, using final physics. This deliberately includes risky outer lines, so it is not a predicted player score distribution.

**25. Competent seeded sample.** **500 first throws** after final physics tuning, generated through the same three-phase bot timing model. Second rolls were simulated on their true remaining racks.

| Pins | Dense sample, 756 | Competent first throws, 500 |
|---|---:|---:|
| 0 | 328 | 13 |
| 1–3 | 151 | 17 |
| 4–6 | 119 | 93 |
| 7–9 | 138 | 315 |
| 10 | 20 | 62 |

**26. Rates.** Dense mean **2.899**, strikes **2.65%**, gutters **38.36%**. Competent mean **7.326**, strikes **12.4%**, gutters **2.0%**. **180/438 spare conversions (41.10%)**. Final gutter rate includes late entry alongside the rack; the early preliminary rate counted only entry before the head pin. All 108 dense trajectories aimed through the central ±0.18 m had physical pin contact; no observed central ball tunnelling. All simulation validation assertions passed.

**27. Headed 2P match.** Chrome **1440×900**, real keyboard, 103.4 s. Sen **30**, Misket **28**, winner Sen. Human frame results: strike; gutter followed by spare; strike. First-roll strike skips, remaining-rack play, totals, winner and A→B each frame all asserted.

**28. Headed 3P match.** Chrome **1366×768**, real keyboard, 171.6 s. Sen **27**, Misket **29**, Limon **26**, winner Misket. Human frames 7+2, 0+8, 9+1. A→B→C across all three frames and raw-score totals asserted. These were actual timed key presses, with no score/velocity/state injection. Additional accelerated lifecycle soaks are identified separately below.

**29. Camera validation.** Screenshots inspected for setup, both side starts, direction/power selection, normal roll, gutter, physical pinfall, spare layout and result. Final setup at 1366×768 has ball centre y≈554 px, HUD top y≈579 px, leaving the entire ball visible. Final larger viewport has ≈38 px centre-to-HUD clearance. Camera rotation is mathematically and unit-test verified constant throughout tracking/return. Menu pause is stable. Q rebinding, quick taps, held/repeated Space and >2 sweep cycles all passed headed checks. No page errors in any Classic browser run.

**30. Performance and stability.** Headed Chrome on this machine, not a low-end-device claim. Final scene: **44 draw calls**, **16,693 triangles**, **7 geometries / 1 texture**, no new downloaded assets. Final main-thread CDP JavaScript average **1.794 ms/frame**, total main-thread task time **2.320 ms/frame** over 1895 frames. Average rendering ≈**60.00 FPS**. Physics batches normally include two 120 Hz steps per display frame.

| Measurement | Average ms | p99 ms | Maximum ms |
|---|---:|---:|---:|
| Final display frame | 16.666 | 17.900 | 30.800 |
| Final game callback JS | 0.581 | 3.600 | 29.400 |
| Final physics batch | 1.319 | 3.900 | 29.300 |
| 2P whole-match physics | 1.545 | 5.800 | 11.800 |
| 3P whole-match physics | 1.407 | 5.500 | 8.900 |

The final short capture contained one ≈30.8 ms frame/29.3 ms physics outlier; it did not sustain a lower frame rate. Full-match average frame times were 16.666 ms at both resolutions.

Twelve seeded automatic full matches (six 2P, six 3P), eight initial browser restarts and a further **24 full browser match/restart cycles** completed. Each reset returned to **10 bodies, 39 colliders, 7 geometries, 1 texture, zero active voices**, with no invalid body. After initial JIT/renderer warm-up, forced-GC heap measurements for cycles 11–24 stayed **33.24–33.59 MiB**, ending 33.44 MiB. No accumulating body/collider/audio/GPU resources observed. The accelerated soak intentionally runs simulation faster than presentation and is not used for FPS claims.

**31. Tests/builds.** All **729 tests** in the full Party Lab frontend run passed (including the first 21 Classic tests). The final focused Classic suite has **22/22 passing**, including the subsequently added physical strike/spare full-match regression. Existing server suite **57/57** passes, server TypeScript passes, production `npm run build` passes, and `git diff --check` passes. Build retains Vite's non-fatal large-chunk warning. The lazy Classic playground is about 19 kB uncompressed / 7.7 kB gzip. No package or dependency changes.

**32. Protected-mode regression.** SHA-256 comparison against the pre-edit working tree: **3,620 existing source/asset/config files checked**, zero missing; only **ArenaScene.tsx** differs. Its exact incremental diff was reviewed and consists of Classic's local menu/branch/HUD/player count wiring. Existing uncommitted integration remains intact. Local headed startup/switch smokes covered Crate Rain, Snowball Fight, Kart Race, Human Bowling, Snowball Brawl, Rooftop, Barn, Layers, Colors, Bomb and Prop Hunt. Existing frontend/server regressions cover production modes; no live production room was changed or used for Classic testing. PartyRoom, lobby, Mixed, online mode registry/rotation, protocol and all shared controls/physics are byte-identical to baseline.

**33. Crate Rain unchanged.** All existing Crate Rain source, tests and validator files match the original working-tree hashes; its ArenaScene branch and props are preserved.

**34. Snowball Fight unchanged.** All existing Snowball Fight source, tests and validator files match the original working-tree hashes; its forced-lock handling and integration are preserved.

**35. Kart Race unchanged.** All existing Kart Race source, tests and validator files match the original working-tree hashes; bindings, camera, physics and integration are preserved.

**36. Human Bowling unchanged.** All Human Bowling local/shared/server code, verified asset pipeline, audio, camera, assets and tests match baseline. No giant pin, car/ejection or stunt-flight implementation is reused.

**37. Files changed by this task.** Existing file: `src/party-lab/scene/ArenaScene.tsx`. New validator: `scripts/validate-party-lab-classic-bowling.ts`. New isolated directory `src/party-lab/scene/classicbowling/` contains:

- `ClassicPlayground.tsx`, `ClassicHud.tsx`, `ClassicControls.tsx`, `classic.css`
- `config.ts`, `rules.ts`, `game.ts`, `bot.ts`
- `visual.ts`, `camera.ts`, `audio.ts`, `classic.test.ts`
- This `REPORT.md`

**38. Backup.** Complete external repository copy, including `.git`, dependencies, ignored and untracked files: `/private/tmp/classic-bowling-backup-20261005-210207/world-quiz`. Adjacent `status.txt`, `diff.txt`, `log.txt` and `manifest.json` preserve the required pre-edit inspection and hashes. Baseline was never reset, checked out, stashed or cleaned.

**39. Remaining tuning questions for manual play.** No known blocking validation failure remains. Subjective choices to evaluate: whether ±6.5° aiming and the 1.5-second power sweep feel comfortable; whether the normal bot seats should be a little less accurate; whether 2.8-second pin settling feels lively enough; whether to shorten forward camera travel further. Test lower-powered hardware before promising the same FPS there. Official bonus scoring, hook/spin, online integration and Mixed remain outside V1.

Evidence is preserved in `/private/tmp/classic-bowling-validation/`: `dense.json`, `bots-500.json`, `simulation-summary.json`, `pocket-neighborhood.json`, browser JSON/screenshots, `protected-hashes.json`, `classic-only.diff`, and test/build logs. The reproducible repository validator runs with `npx tsx scripts/validate-party-lab-classic-bowling.ts`; `?classicDebug=1` enables readouts for local validation only.

### Timing follow-up validation (2026-10-05)

Position and direction are 33⅓% faster with unchanged ranges; power remains unchanged. Headed Chrome at 1440×900 and 1366×768 passed real Space-key left/centre/right choices, missed-pass recovery, held/repeated-key suppression, and low/medium/high-power throws. Full 2P and 3P matches completed with correct seat order and totals (26–28 and 26–30–29), averaging 60 FPS. Gutters, normal hits, strikes and spares were verified across both viewports; the smaller-viewport strike used a separate real-keyboard throw.

All 22 Classic tests, TypeScript, production build and whitespace checks passed. The simulation validator passed 756 fixed-input throws, 500 bot attempts and 12 complete matches. All 756 fixed-input measurements, including paths and pinfall, exactly matched the prior baseline. Across 9,000 seeded bot plans, planned position/angle selections matched the old error distribution to floating-point precision; power timing matched exactly. Only config.ts, bot.ts, classic.test.ts and this report changed in this follow-up. All other existing work is preserved, including protected local prototypes, online modes and protocol 12. No commit, push or deployment.

### Second timing follow-up: double the current speed (2026-10-05)

Using the immediately preceding implementation as the baseline, position changed from 1.35 to 0.675 seconds edge-to-edge (1.35-second full cycle), and direction from 1.65 to 0.825 seconds (1.65-second full cycle). Both are exactly 2× faster and still reverse indefinitely. Ranges remain ±0.56 m and ±6.5°. Power remains 35–100%, 1.50 seconds low-to-high, with the same velocity mapping. The existing bot timing scaling automatically follows the new periods: 9,000 seeded plans produced exactly the same selected position, angle and power as the preceding implementation.

A headed synchronization probe exposed the existing 30 Hz HUD lag and next-frame selection offset. The Classic-only adapter now commits the setup HUD alongside each rendered frame and locks the displayed sample on a human selection edge. Shared keyboard/rebinding code, bot stepping and physical simulation are unchanged. The exact selected values, formatted HUD labels and meter readings were checked with real keyboard events.

Headed Chrome passed at 1440×900 and 1366×768: left/centre/right position and direction; deliberately missed passes and later recovery; held/repeated Space; rapid fresh presses; low/medium/high power; gutters, normal hits, strikes and spares. All 66 tested human selections exactly matched their displayed frame sample, and all 1,482 sampled HUD readings matched the current game value. Complete 2P and 3P matches finished at 60 FPS with correct turn order, scoring and winners (28–30 and 29–28–27). The daemon restart interrupted one earlier match run; the complete match validation was rerun successfully.

All 22 Classic tests, TypeScript, production build and git diff --check passed. Compared with the saved pre-request hashes, only config.ts, ClassicPlayground.tsx, classic.test.ts and this report changed. All other existing work, protected local prototypes, online modes and protocol 12 are unchanged. No commit, push or deployment. Evidence: /private/tmp/classic-bowling-double-20261005/.
