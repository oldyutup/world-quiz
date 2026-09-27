# Human Bowling parity audit, 2026-09-27

Written before implementation. Existing uncommitted files backed up externally in `/private/tmp/human-bowling-before-parity-20260927.tgz`; tracked patch in `/private/tmp/human-bowling-initial.diff`.

Sources independently reopened this pass:

- M: [FlatOut 2 official PC manual](https://cdn.akamai.steamstatic.com/steam/apps/2990/manuals/manual_en.pdf), Rag Doll Mini-Games / Launch, Aerobatics & Nudge. This is app 2990, not Ultimate Carnage.
- V: [J4cobLIVE Bowling footage](https://www.youtube.com/watch?v=REYK365FQ5E&t=68s), viewed in headed Chrome. At 1:10: visible 164 KMH, 20°, left radial angle instrument and right speed instrument. At 0:48: obstacle approach and warning about deflected car heading. Edited explanatory freeze frames prevent using video wall time as continuous simulation time.
- G: [Grawl's 2006 walkthrough](https://gamefaqs.gamespot.com/pc/929089-flatout-2/faqs/44311), Bowling and transcribed gameplay hints. Recommends Nudge near pins; aerobatics reduce airspeed. Timing recommendation is strategy, not a force specification.
- R: [Contemporary GamesRadar review](https://www.gamesradar.com/flatout-2-review/2/): fast mostly straight runway, flailing loose driver, accuracy emphasis.
- S: [Stunt Class](https://flatout.fandom.com/wiki/Stunt_Class) and [Rocket](https://flatout.fandom.com/wiki/Rocket): corroboration only. Stunt and unlocked racing versions differ. Their racing top-speed claims cannot establish Bowling speed.

| Mechanic | FlatOut 2 evidence | Fact / inference | Confidence | Current Party Lab | Change required |
|---|---|---|---|---|---|
| Launch-zone speed | V visible 164 KMH at 20° | Observed HUD fact; SI scale unknown | High HUD, low actual SI | 22 m/s hard cap = 79.2 km/h | Real 35–46 m/s chassis trials; honest ×3.6 HUD |
| Acceleration | R fast run; no measured curve | Qualitative fact, numerical inference | Medium | 1.8 m/s² engine plus grade | Measure 0–50/100, hill and zone; improve engine |
| Stunt car differences | S distinguishes stunt/racing Rocket | Secondary report | Low/medium | One original stunt car | Keep one; do not use bonus-car speed stats |
| Steering | M car aims general direction; V prop deflection | Fact; rate unknown | High/low | 1.5/(1+speed/9) yaw rate | Verify at high speed, preserve finite response |
| Obstacles | V visible bowling balls and heading disturbance | Fact; collision coefficients unknown | High/low | Sensor breakaways, flat ~7 m/s loss | Scale energy loss with speed; swept safety |
| Course rhythm | V plateau, descent, props, approach, distant rack | Visual fact; metres/times unverified | High/low | 207 m drive, 90 m lip-to-rack | Measure seconds before scaling; retain rack initially |
| Bullet time | M starts holding in launch area | Fact | High | Valid-zone rising edge, 0.4× | Preserve; exact ratio is adaptation |
| Angle selection | M auto increase, release locks/ejects | Fact | High | 5–75°, 38°/presentation second | Start at visible 0°, wider high-angle failure range; tune rate explicitly as adaptation |
| Independent power | M only documents angle | Absence in documented controls; energy law inferred | High/medium | No selector, but 1.46× velocity gain | Remove gain; redirect actual velocity |
| Horizontal launch energy | M car aims; V fast approach | Inference, engine formula unavailable | Medium | Forward speed × gain × cos(angle), sideslip retained | Unit gain, preserve measured sideslip/ramp motion |
| Initial pose/spin | R loose flailing, V body approach | Visual fact; angular constants unknown | High/low | Fixed .5 rad lean, mostly fixed spin | Deterministic speed/angle/pitch/yaw-derived rotation field |
| Joints/motors | No original motor specification | Unknown | Low | Zero posture/mobility already disables conscious motors; passive limits retained | Keep anatomical joints, no upright stabilization |
| Left/right aerobatics | M four directions | Fact | High | Equal whole-body velocity shifts plus small torso torque | Torso/pelvis impulses, visible roll/yaw, finite trajectory budget |
| Up/down aerobatics | M four directions | Fact | High | Tiny pitch torque and uniform vertical velocity change | Stronger bounded pitch torque, modest core force |
| Drag | G transcribed hints say aerobatics reduce speed | Reported gameplay fact; formula inferred | Medium/high | exp(-.24 × effort × dt), Nudge relief | Preserve duration/intensity tradeoff; measure no/light/heavy |
| Nudge input/once | M launch key, once per launch | Fact | High | SPACE, +2.1 m/s upward all masses | Keep once and upward only; make readiness obvious |
| Nudge magnitude/timing | M small upward force; G near pins | Fact qualitative; timing strategy | High/medium | +2.1 m/s, early/late tests limited | Measure five timings, tune modest change |
| Nudge drag relief | Not supported by M or G | Unverified secondary claim | Low | .45 drag multiplier for .45 s | Remove entirely |
| Landing | R flailing; no coefficients available | Qualitative fact / tuning inference | Medium/low | .4 body friction, .16 impact damping, .16 restitution | Bowling-only momentum-preserving slide trials |
| Rack reach/speed | V distant rack; no calibrated metres or m/s | Visual fact / unknown units | Medium/low | Frequently short, 90 m from lip | Fix speed/energy/gravity first, measure multiple viable recipes |
| Pin energy/strike | G late Nudge strategy; V perfect-score guide | Fact strategy, no distribution evidence | Medium | Ten physical 1.6 mass pins, 1.12 spacing | Test 500 competent human-rule bots, adjust only if needed |
| Angle HUD | V left radial arc, numeric angle, sweeping needle | Observed fact | High | Left horizontal bar | Original radial instrument with degree readout |
| Speed HUD | V separate right instrument, KMH | Observed fact | High | Left speed above bar | Right speed, actual km/sa |
| Match format | V five rounds/perfect 150 target | Observed fact; bonus rules not fully audited | High/low | Three rounds, 2/3 players, raw /30 | Deliberate short local match adaptation |

No source recovers exact FlatOut gravity, drag law, friction, acceleration curve, angular velocity, body/rack scale, or angle sweep rate. Values selected below are Party Lab adaptations, not claimed recovered constants. A deterministic recipe can always repeat a deterministic result; difficulty is assessed across courses, timing, speeds and aim variation, not by promising impossibility of repeating a strike.

## Additional observations and resulting scale decision

After the initial audit, independently inspected [All School Gameplays, All Stunts](https://www.youtube.com/watch?v=cZ8lAE6iLns&t=76s): Bowling approach at 1:27, airborne 32° / 159 KMH at 1:32, nine pins down at 1:37. The speed readout remains 159 at impact, so it is not evidence of actual body speed at the rack. Four-direction arrows and Nudge availability remain visible in flight. These sampled frames establish a multi-second flight but do not recover exact launch time or a calibrated velocity curve.

Also visually inspected the [independent 163 KMH / 31° Bowling screenshot](https://www.virtueone.com/uploads/gallery_flatout2/2011-05-31_00135.jpg). The inverted driver visibly corroborates tumbling; screenshot descriptions calling it an airborne car are inaccurate. Original source pixels were not imported into the game.

The first real-speed prototype crossed the old rack in ~2.2 seconds. After testing the unchanged rack first, the final lane was lengthened from 90 to 170 metres lip-to-head-pin, with flight gravity changed from 9 to 10 m/s² and the 1.46 ejection gain removed. This produces measured ~4–5 second useful rack approaches. It is a timing adaptation, not a claim that FlatOut's physical lane is 170 metres.
