# Human Bowling course rebuild, local only

2026-09-27. No commit, push, deployment, protocol change or online Bowling. All prior uncommitted work was backed up before course edits. `ArenaScene.tsx` is byte-identical to the session-start version, including its approved uncommitted integration.

External backup: `/private/tmp/human-bowling-course-backup-20260927-123644/uncommitted.tar.gz`, with separate tracked diff and git status. Initial HEAD: `627a0ba`.

## 1–4. Research, observations, facts and inferred proportions

Primary visual evidence:

- [All School Gameplays, FlatOut 2: All Stunts](https://www.youtube.com/watch?v=cZ8lAE6iLns&t=76s), Bowling chapter. Inspected 1:18, 1:23–24, 1:26, 1:28, 1:31–32.
- [RetroDetect, original PS2 Bowling gameplay](https://www.youtube.com/watch?v=CkoPcujJRoU), inspected 0:01, 0:05–06, 0:08–11, 0:14 and 0:16, including frame advancement through the descent/exit.
- [Original FlatOut 2 PC manual, printed p8](https://cdn.cloudflare.steamstatic.com/steam/apps/2990/manuals/manual_en.pdf), verifies the established launch/aftertouch concept, supplies no course dimensions.

The videos show an elevated short staging road, steep sided descent, a convex rise at its exit, giant bowling-ball hazards, a clear marked approach, a low launch platform and a contrasting bowling alley in a stadium. Giant adjacent ski-jump-like ramps are stadium scenery, not the Bowling launch ramp. No barrel, tyre-stack or crate slalom was verified. Tall target signage is visible at the real game's spawn, while the low road itself is obscured. Balls change apparent positions across viewpoints, but the exact motion system and whether they break apart could not be established confidently. Neither source establishes authored round-to-round layout changes.

These are visual observations, not extracted level data. Every distance below is an inference, never an official FlatOut dimension. Vehicle scale assumes a full-size 4–5m coupe (LOW confidence); HUD speed and passage time provide cross-checks, with slow motion and imprecise landmark times limiting accuracy.

| FlatOut 2 inferred dimension | Estimate | Confidence | Evidence |
|---|---:|---|---|
| Road width | 10–14m, 5–7 car widths | MEDIUM | A1:26, B0:11, car/curb proportions |
| Starting height | 20–35m | LOW | A1:23, scaffold bays/road width |
| Plateau ahead of car | 8–18m | LOW | B0:01–06, vehicle lengths/acceleration |
| Downhill horizontal run | 50–85m | LOW | B0:06–09, HUD ~55→119→132km/h |
| Hill grade | Mean 20–30°, central 30–40° | LOW | Drop/run ranges and A1:23 perspective |
| Bottom transition | 8–20m | LOW | A1:24/B0:08–09 curvature |
| Exit rise | 0.5–1.5m over 8–16m | LOW | A1:24 raised road horizon, B0:09 pitch |
| Lower road to launch | 130–200m | LOW | B0:09–14 at ~132–160km/h, discounted launch slow motion |
| Large balls | 3–5m diameter, roughly 4–6 hazards visible across sequence | MEDIUM size / LOW count | A1:26, B0:10–11; occlusion limits count |
| Obstacle spacing | 20–40m | LOW | Perspective and passage timing |
| Clear final approach | 25–50m | LOW | A1:28/B0:14 and ~0.7–1.3s high-speed travel |
| Launch edge | 0–1.5m rise, 4–10m run, near road width | LOW | A1:28/B0:14; no tall ramp established |
| Launch-to-rack | 80–140m | LOW | A1:31–32/B0:16, alley/flight proportions |
| Pin height | 1.5–2.5m | LOW | Ragdoll/pin scale at a distance |
| Total spawn-to-backstop | 280–420m | LOW | Broad component estimates, not a survey |

The full feature/evidence/current/recommendation table was created **before editing geometry**, retained in [COURSE_RESEARCH.md](COURSE_RESEARCH.md). No Ultimate Carnage or fan recreation was used. The 1:26 PC seek eventually buffered; motion was not inferred from that frozen frame.

## 5–10. Old/new course, profile, reveal and kicker

The code baseline was 264m between bounds, despite the task's approximate 252m description. Measurements distinguish world bounds from playable spawn travel.

| Feature | Approved baseline | Final course |
|---|---:|---:|
| Course bounds | 264m | **330m** |
| Spawn to end | 248m | **318m** |
| Spawn to ramp lip | 127m | **207m** |
| Start elevation | 34m | **26m** |
| Start platform total / ahead of car | 20m / 4m | **20m / 8m** |
| Downhill horizontal length / drop | 76m / 34m | **58m / 26m** |
| Steepest grade | 51.5%, 27.2° | **57.78%, 30.02°** |
| Average downhill grade | 44.7%, 24.1° | **44.83%, 24.15°** |
| Bottom easing | 10m | **18m** |
| Hill foot to ramp start | 40m | **134m** |
| Post-hill bump | None | **12m long × 0.8m high** |
| Road width | 14m | **12m** |
| Target deck width | 14m | **10m** |
| Ramp run / rise | 7m / 1.6m | **7m / 1m** |
| Ramp lip to head pin | 100m | **90m** |

The 58m hill integrates an 8m eased crest, 32m sustained steep section and 18m eased compression. Height and tangent are continuous at the joins. Visual road and Rapier hulls share sampled vertices. The start plateau and existing low chase camera hide lower hazards; the descent progressively reveals the stadium and road. No camera rewrite was needed. Our spawn hides the target more fully than the source footage, a deliberate difference matching the requested progressive reveal.

The foot at z=-112 has 4m flat, then the sinusoidal hump from z=-108 to -96, then 118m level road to z=22. Thus there are **122m of level lower road plus the 12m hump**, within the 134m lower section. The road's sampled surface length from rear platform boundary to launch lip is **225.55m**; horizontal span is 219m.

Initial design used a 114m lower section. Driving probes showed overly compressed steering between large props, so 20m was added before browser validation. The final large-group gaps are 28/28/18m, retaining multiple choices without demanding a continuous racing slalom.

A genuine physics correctness issue appeared: the support spring could exert downward force and keep the car glued over a convex hump. Support now only pushes upward and ends when ride-height clearance exceeds 0.22m. This produces **~0.43s support loss** over the hump at 22m/s. Driver ejection remains exclusively the approved launch input. The car-only catcher remains 0.9m high and moves from z=37 to z=45, where the chassis has descended after the ramp. This keeps the target sight line open. This is the only changed CAR configuration value; acceleration, braking, speed cap and body coefficients are unchanged. Flight energy, gravity, angle sweep, drag, Nudge, scoring and body coefficients are unchanged.

## 11–13. Obstacles, roles and authored variants

The old 12 pin/crate props became **5–6 original spherical stunt props** in four groups at z=-84, -56, -28 and -10. Main diameters are 2.8–3.6m, shoulder props 2–2.2m. These reproduce the source's large themed lane occupancy, not an unverified barrel/crate pattern.

Each ball has a spherical chassis-overlap sensor. A contact removes `4.5 + 1.4 × radius` m/s (5.9–7.02m/s), adds 0.075 radians of heading disturbance, and disables its sensor for the remainder of the throw. The consequence persists in the actual car velocity; no artificial launch penalty or score override is applied. Chassis contacts with road walls remain Rapier contacts. Touches usually leave the attempt playable; one of six intentionally unsteered probe runs timed out after repeated prop/wall trouble.

Source ball destruction is unconfirmed. Party Lab deliberately uses hollow breakaway shells: **three authored cosmetic pieces per ball, 18 maximum**, updated for 1.4s, no new rigid bodies and no loose colliders. This is an original web-performance adaptation, not a claim about FlatOut destruction.

| Variant | Active props | Authored difference |
|---|---:|---|
| Split entry | 6 | Left primary + right shoulder, opposite second gate, left third, central finish |
| Late switch | 6 | Mirrored entry, tighter second placement, right third, left finish |
| Open shoulder | 5 | Missing entry shoulder, inward second ball, left third, offset finish |
| Double centre | 5 | Central first and last balls, offset intermediate groups |
| Wide rhythm | 5 | Wider alternation, missing second shoulder, smaller final ball |
| Tight finish | 6 | Full shoulders and larger 3.6m final ball |

Variant = `(matchSeed + round - 1) mod 6`. All players receive the same layout within a round; the next round moves to the next authored layout. Restarting identical seeds reproduces it. Terrain, hill, ramp and rack never change. Six sensor slots and eighteen visual slots are reused across all layouts, including disabled slots for missing props.

Bots read nearby unbroken props within roughly 1.55 seconds of forward travel, compare currently open lateral positions, and steer the dynamic car. They have no variant-to-path table, teleport, outcome lookup or perfect launch route. Existing seeded launch angle, throttle, aftertouch and Nudge profiles remain intact.

## 14–18. Road, final approach, ramp, target and venue

The **12m road** fits the estimated 10–14m source range and gives multiple lines while keeping barrier contact plausible. From the last prop's furthest edge to ramp start there are **30.2m minimum** to settle heading. From that edge to the angle-zone start there are 14.2m. The unchanged angle zone runs z=6…29: 16m flat plus 7m ramp, 23m total. At 22m/s, a 25° selection lasts about 0.526 presentation seconds and travels ~4.63m at 0.4× time. Obstacles are outside that decision area.

The 12m-wide ramp uses `height = t²(2−t)` over 7m, rises 1m, enters with zero grade and ends at an 8.13° lip tangent. Maximum ramp tangent is 10.78°. Its shape complements the existing angle input; no velocity boost is attached to the ramp.

The rack is **90m horizontally beyond the lip**, at arena floor elevation, 1m below the lip. The broad FlatOut estimate is 80–140m. This keeps it one coherent alley target while leaving about 3.4–3.7s average bot airtime for limited corrections and Nudge. Some trajectories land and slide; wrong angles or excessive drag still miss. The 1.5m physical pins, spacing, mass and scoring rules are unchanged.

The original venue uses teal road/structure paint, warm wooden deck, a contrasting pin pad, tall rear board, flags, light masts, enclosing stepped seating, scaffold sides, service paddock, tents and parked vehicles. Racing Kit scenery, Car Kit racer, Toy Car Kit service vehicles, Skyboxes sky and Particle Pack dust are used from the existing downloaded CC0 packs. Generated collision is independent of art. No FlatOut meshes, textures, logos, signs, UI or audio were copied.

## 19. Driving telemetry

Speeds are m/s; multiply by 3.6 for km/h. Clean and deliberate-hit runs below use the same seed 3 / Double centre layout and actual simulation input from spawn. No vehicle placement or velocity injection. Before/after samples straddle each group by 4m; instantaneous impact losses are listed separately.

| Landmark | Clean time (s) | Clean speed | Hit-run time (s) | Hit-run speed |
|---|---:|---:|---:|---:|
| Hill bottom | 6.78 | 22.02 | 6.78 | 22.00 |
| Group 1 before | 7.90 | 22.01 | 7.88 | 22.00 |
| Group 1 after | 8.25 | 22.00 | 8.37 | 15.70 |
| Group 2 before | 9.17 | 22.00 | 9.57 | 17.86 |
| Group 2 after | 9.55 | 22.00 | 10.22 | 12.24 |
| Group 3 before | 10.47 | 22.00 | 11.68 | 14.88 |
| Group 3 after | 10.82 | 22.00 | 12.20 | 15.81 |
| Group 4 before | 11.28 | 22.00 | 12.82 | 16.92 |
| Group 4 after | 11.65 | 22.01 | 13.48 | 11.33 |
| Launch zone entry | 12.20 | 22.00 | 14.47 | 13.10 |
| Near lip | 13.18 | 22.00 | 15.98 | 15.32 |

Eject speed: **22.00 clean vs 15.32 hit** (79.2 vs 55.1km/h). Instant contact speed changes: 22.00→15.01, 17.98→11.28, 17.13→10.43 m/s. Both reach hill bottom at 6.78s. The same 25° throw knocks 8 pins clean and 0 after those impacts. All twelve clean/direct probe records are in `course-driving.json`, including the one repeated-hit timeout.

## 20. Headed Chrome keyboard validation

Completed in real headed Chrome with Playwright `keyboard.down` / `keyboard.up`, at **1440×900 and 1366×768**. The harness steers from live position/heading and nearby obstacles; it never places the car, injects velocity, advances the simulation directly or forces a score. The 12-run sweep covered every authored variant at both sizes. All twelve unloaded over the kicker, reached the final approach without obstacle contact, supported moving SPACE angle selection and used the single Nudge. Short directional input on variant 4 produced 7 and 8 pins at the two sizes. Typical ~25° runs had ~3.5s of airborne correction time.

The spawn, descent, kicker, obstacle sequence, charging, flight and sliding screenshots were inspected. The plateau hides the lower route; the steep descent reveals the road and stadium; the hump gives a short chassis air moment; giant props create several lateral choices; the clear final section makes angle selection readable. HUD/control layout remains usable at both resolutions. The rack is small from the approach, framed by its wood lane and rear sign, then becomes readable in flight without enlarged pins.

Deliberate-hit keyboard run: three contacts, 15.32m/s eject, 0 pins and a short landing. A 12.6° throw landed early and slid 33.14m to take 1 pin. A 55° throw flew 5.85s and landed beyond the rack at z=125.4 for 0 pins. Sustained aerobatics lost 15.16m/s through existing drag, landed at z=90.2 and missed short. These are physical outcomes, without a guaranteed-strike adjustment.

After final catcher placement and art polish, both resolutions were repeated, followed by full two- and three-player matches. Final runs again confirmed actual hump unloading, moving angle selection and Nudge. All matches completed three throws per player, no retries and no browser exceptions.

| Final match | Throw scores, player order | Real elapsed seconds |
|---|---|---:|
| 2 players | 1, 3, 3 / 0, 0, 3 | 173.3 |
| 3 players | 2, 4, 3 / 0, 0, 3 / 1, 7, 0 | 256.5 |

The match screenshots capture the frame when the simulation enters results; the HUD can still show its previous published state. Completed throw arrays and the results phase are recorded in the raw run.

The first sweep's three-player setup hit a harness-only timeout after reselecting an already-selected player count. The harness was fixed to avoid dispatching that redundant select event; both complete matches were then rerun. No ArenaScene or approved menu behavior was changed. These are automated keyboard feel checks and visual inspection, not a human user study.

Evidence: [start](/private/tmp/bowling-course-validation/final-1440-spawn.png), [descent](/private/tmp/bowling-course-validation/final-1440-descent.png), [kicker](/private/tmp/bowling-course-validation/final-1440-kicker.png), [1366px approach](/private/tmp/bowling-course-validation/final-1366-angle.png), [two-player final simulation frame](/private/tmp/bowling-course-validation/results-2.png), [three-player final simulation frame](/private/tmp/bowling-course-validation/results-3.png), [all-variant raw run](/private/tmp/bowling-course-validation/browser-sweep-results.json), [final raw run](/private/tmp/bowling-course-validation/browser-final-results.json).

## 21. 300 competent seeded bot throws

Original profile quality >=0.18, seeds enumerated in order, no filtering by score. Useful speed means >=19m/s at eject. Harmed means at least one real prop contact with a measured immediate velocity and heading penalty; some early penalties recover before launch.

| Variant | Throws | Mean pins | Strikes | Contact-penalized | Useful speed | Missed eject |
|---|---:|---:|---:|---:|---:|---:|
| Split entry | 52 | 3.25 | 3 | 0 | 52 | 0 |
| Late switch | 48 | 2.75 | 1 | 0 | 48 | 0 |
| Open shoulder | 48 | 3.73 | 0 | 37 | 47 | 0 |
| Double centre | 49 | 4.08 | 5 | 38 | 49 | 0 |
| Wide rhythm | 50 | 3.32 | 3 | 0 | 50 | 0 |
| Tight finish | 53 | 3.77 | 3 | 0 | 53 | 0 |

Total: **300 throws, 3.49 pins average, 15 strikes (5%), 75 contact-penalized, 299 useful-speed launches, zero missed ejects/retries**.

| Pins | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Throws | 129 | 9 | 9 | 21 | 4 | 19 | 21 | 28 | 32 | 13 | 15 |

The layouts are not equally easy. Open shoulder generates more penalties and no strikes in this sample, but its mean is 3.73 pins and headed clean runs demonstrate an open viable line. Double centre also produces frequent impacts, with enough road to regain useful speed. This finite sample does not prove universal fairness or optimal play.

## 22. Performance

Final quiet headed Chrome runs at both requested sizes, sampled from the existing rolling diagnostics. JS/frame is Bowling's update work, not all browser/GPU rendering. Physics is the full simulation step including controllers and ray casts, not only Rapier's solver. Physics p99 below is the worst reported 1,200-step rolling p99; it is not a pooled percentile of the entire session. Values are milliseconds unless stated.

| Phase | Samples | FPS range | Mean JS/frame | Mean physics | Worst rolling physics p99 | Maximum step | Mean shell update |
|---|---:|---|---:|---:|---:|---:|---:|
| drive | 104 | 59.5–60.1 | 0.222 | 0.161 | 1.30 | 17.80 | 0.006 |
| flight | 94 | 60.0–60.0 | 0.419 | 0.229 | 0.90 | 17.80 | 0.009 |

The broader sweep measured 18–28 draw calls and 82,606–94,038 rendered triangles, depending on camera/visible costume and dust. The final world has **20 dynamic bodies and 291 colliders**. Shell breakup adds zero bodies/colliders and uses one instanced draw for at most 18 cosmetic pieces. During the intentional-hit run, shell update averaged **0.013ms**, with a largest reported rolling average of **0.018ms**; sampled FPS remained 60.0. The curated CC0 kit is 244,768 bytes.

Steady gameplay meets the 60 FPS target on this machine. A 17.8ms isolated simulation step occurred in final diagnostics (18.4ms in the broader sweep); the initial loading/warmup sample also dipped below 60. This does not establish that every frame is under 16.7ms or guarantee the same performance on other hardware. No heavy debris simulation was added.

## 23. Validation and scope protection

- Complete frontend + edge suite: **545 passed, 0 failed**, including 35 Bowling tests.
- TypeScript: pass via explicit `tsc --noEmit` and production build.
- Production build: pass; existing >500kB chunk advisory remains.
- Six deterministic simulation hashes match the prior baseline: Rooftop, Barn, Layer Chaos, Color Chaos, Bomb Tag and Prop Hunt.
- Protocol remains **9**. PartyRoom, online lobby, Mixed and all shared/server files remain unchanged.
- Full suite's existing chat integration fixture required localhost socket access outside the sandbox. No separate server suite was needed for this local course change.
- `git diff --check`: pass. Session-start ArenaScene verified byte-for-byte against the external archive.
- No commit, push or deployment.

Evidence: `/private/tmp/bowling-course-validation/` contains raw per-throw JSON, browser samples, screenshots, suite/build logs and hash results. Reproduce course survey/bots with `node --import tsx scripts/validate-party-lab-bowling-course.ts /private/tmp/bowling-course-recheck`.

## 24. Files changed in this task

- `bowling/config.ts`: course profile, sizes, six authored layouts and shared collision hulls.
- `bowling/car.ts`: spherical prop impacts, resettable sensors and non-tensile suspension support.
- `bowling/courseDriving.ts` (new): local obstacle-aware steering.
- `bowling/game.ts`: bot steering hookup, round layout reset, car catcher position.
- `bowling/visual.ts`: rebuilt stadium, road, target framing and CC0 placements.
- `bowling/stuntVisual.ts`: original instanced shell props and bounded cosmetic destruction.
- `bowling/BowlingPlayground.tsx`: round layout visuals, debug-only seed selection and destructible performance telemetry.
- `bowling/BowlingHud.tsx`: existing driving hint now says balls instead of crates.
- `bowling.test.ts`: updated geometry/regression checks and physical kicker test.
- `scripts/build-party-lab-bowling-kit.mjs`: Toy Car Kit service vehicle inclusion with palette colours baked into vertices; final kit is 244,768 bytes.
- `scripts/validate-party-lab-bowling.ts`: updated course-aware route and six-layout sweep.
- `scripts/validate-party-lab-bowling-course.ts` (new): survey, telemetry, 300-throw distribution.
- `public/party-lab/maps/bowling/bowling-kit.glb`, `CREDITS.txt`: rebuilt curated kit/provenance.
- `bowling/COURSE_RESEARCH.md`, `COURSE_REPORT.md` (new): evidence and report.

Existing uncommitted ArenaScene integration is untouched. FLIGHT and BULLET constants, camera, clock, audio and particle code match the external baseline. CAR changes only the map location of its catcher (37→45); all vehicle tuning constants are preserved. The game retains three throws per player and ten physical pins.

## 25. Meaningful remaining differences from FlatOut 2

Party Lab uses a slower car (22m/s cap versus observed source speeds approaching 44m/s), its already approved low-gravity flight and compact original art. Source dimensions are estimates, not extracted measurements. Our giant balls are fixed authored breakaway props, not a recreation of a verified moving-ball system. Three-shell destruction and six round layouts are original adaptations; their exact FlatOut equivalents were not established. The source's busy night stadium, animated crowd, giant adjacent stunt equipment, screens and pyrotechnics are simplified into a daylit CC0 venue. Our spawn hides the target more completely. All these differences are explicit rather than passed off as source facts.
