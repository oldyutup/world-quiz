# Kartopu Çarpışması: local prototype report

2026-10-04. Baseline: `e5f26aa` (online Human Bowling). This is an uncommitted local prototype. Open `/party-lab`, choose **Yerel Test Arenası**, then **Harita → Kartopu Çarpışması**. Use **Esc → Oyuncu** for 2 or 3 slots. One human controls slot 1; bots fill the other slots.

## 1. Reference research sources

Research preceded implementation. Public descriptions and a gameplay screenshot were inspected. No video timing measurements or proprietary source/physics data were available; the report does not infer exact reference coefficients from a still image.

- [Publisher-provided description on Nintendo](https://www.nintendo.com/en-gb/Games/Nintendo-Switch-download-software/Pummel-Party-2569713.html): identifies **Snowy Spin** as the knock-opponents-into-the-abyss minigame.
- [Snowy Spin wiki](https://pummel-party.fandom.com/wiki/Snowy_Spin) and [Steam community guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2066443349): reproduce the in-game description of a slippery platform, elimination-order scoring, and three rounds. Community transcriptions, not developer implementation documentation.
- [Wroxe's Turkish guide](https://wroxe.com/pummel-party-nasil-oynanir/): explicitly reports growth while moving. Its [Snowy Spin gameplay screenshot](https://wroxe.com/wp-content/uploads/2021/05/Pummel-Party-Snowy-Spin-1024x576.jpg) was downloaded **outside the repository** and visually inspected for shape, player representation, environment and camera framing.
- [Rebuilt Games' Steam patch notes](https://store.steampowered.com/news/posts/?appids=880940&enddate=1576778847&feed=steam_community_announcements): v1.4.1 added a maximum per-round time to Snowy Spin. This supports the existence of a time safeguard, not a claim about its exact present duration.

## 2. FACT / INFERENCE / PARTY LAB ADAPTATION

| Topic | Evidence and confidence | Party Lab adaptation |
| --- | --- | --- |
| Arena | **FACT, screenshot:** approximately circular, irregular polygonal snowy/icy platform above a canyon; exposed perimeter. Exact scale/collider/crown unknown. | Flat 20 m disk, no obstacles or hidden walls. |
| Player representation | **FACT, screenshot:** bulky snowballs with coloured character parts protruding; characters appear enclosed in the balls, rather than riding wheeled vehicles. | Player directly controls a single snowball; band, patch, number and name identify it. |
| Movement, acceleration, turning | **FACT, description:** slippery movement and bumping opponents. **INFERENCE:** inertia makes approach and recovery matter. Exact acceleration, input basis and turning curves are unverified. | Force/torque driven rolling, independent heading, gradual acceleration and steering. |
| Collision, momentum, knockback | **FACT, stated objective:** physical-looking contact knocks rivals off. **INFERENCE:** approach speed/angle matter. Equal masses, conservation model and any reference hit multipliers are unknown. | Equal masses, Rapier contact solution, no bonus knockback impulses. |
| Growth/shrink | **FACT about the secondary source:** Wroxe explicitly describes growing while moving. **Unverified:** exact growth rate, cap, mass effect, hit shrinkage or loss mechanics. | No growth or size changes in V1. |
| Jump/dash | Not established by the inspected screenshot/descriptions. Absence is not asserted as a reference fact. | Neither exists. |
| Elimination | **FACT, descriptions:** leaving the platform/falling into the abyss eliminates players. Exact trigger volume unknown. | Actual support loss, gravity, below-platform elimination. |
| Rounds | **FACT, transcribed in-game description:** 3 rounds, scoring by elimination order. | 3 rounds, 1 point to each round's last survivor; draws award none. |
| Hazards | **FACT, screenshot:** exposed cliff and snow scenery. No other moving hazard can be confirmed from the still. Official patch documents a time limit. | Late physical platform shrink, clearly labelled as our addition. |
| Camera | **FACT, screenshot:** high, oblique, shared arena view. Dynamic tracking/zoom cannot be established from the still. | Third-person heading chase, V for wider view, overview after elimination. |
| Pacing | No reliable reference seconds-per-round measurement. | Target 20–50 s, measured local data below. |

The screenshot supports visual facts only. Movement coefficients, collision response and pacing in this report's remaining sections are measured **Party Lab** behavior, not reverse-engineered Pummel Party values.

## 3. Final gameplay rules

- Local ID `snowball_brawl`; visible title **Kartopu Çarpışması**.
- 2 or 3 players: one keyboard-controlled human plus 1 or 2 local bots.
- Three-second countdown, active play, 0.9 s final-fall grace, 3.5 s round result.
- Three rounds even if someone already leads by two. Last survivor earns one round win; simultaneous final falls draw. Most wins takes the match; tied match scores stay tied.
- All players reset with equal bodies and rotated, evenly spaced spawns. Scores persist between rounds; **Yeniden oyna** starts a fresh match.
- Esc menu pauses this mode. Inputs clear on blur/visibility loss; hidden tabs do not advance it. No punches, grabs, weapons, jumping, boosting or dashing.

## 4. Arena dimensions

**20 m diameter / 10 m radius**, flat top at y=0. Physical cylindrical slab is 1.3 m thick. Visual lower ice cliff is decorative and has no collider. White perimeter marks the actual support boundary. No convex crown, bumps, holes, obstacles or collision-bearing decoration. Distant low-poly snow peaks sit below/outside the play surface.

## 5. Sphere radius and mass

Every player: **0.95 m radius, 80 simulation kg**, one authoritative dynamic spherical body and one ball collider. The decorative band, patch, overhead number/name, shadow and direction marker add no bodies. Real angular inertia comes from the sphere collider. The pure spawn helper accepts up to eight slots for future reuse; the playable constructor/UI remain 2/3 only.

## 6. Friction, restitution, damping and solver

| Parameter | Final value |
| --- | --- |
| Ball / ice friction | 0.22 / 0.22, default average combination |
| Ball / ball restitution | 0.55 |
| Ball / floor restitution | 0, floor uses minimum combine rule |
| Linear / angular damping | 0.12 / 0.16 |
| Gravity | 16 m/s² |
| Fixed step | 1/120 s |
| Solver iterations / maximum CCD substeps | 8 / 4 |
| CCD / soft CCD prediction | enabled / 2 m |
| Ball contact skin | 0.015 m |
| Collision groups | Normal solid contacts for every ball and floor; no ghosting cooldown |

Rapier uses a single Coulomb friction coefficient rather than separate static and dynamic coefficients; the comparison therefore varies that coefficient and both damping values. See [Rapier's JavaScript friction documentation](https://rapier.rs/docs/user_guides/javascript/collider_friction/).

Controlled surface comparison, starting with an 8 m/s rolling ball on an enlarged test floor:

| Variant | Friction | Linear / angular damping | 3 s coast, m | Speed after coast, m/s | Brake distance, m |
| --- | --- | --- | --- | --- | --- |
| looser | 0.12 | 0.06 / 0.08 | 21.79 | 6.57 | 5.00 |
| selected | 0.22 | 0.12 / 0.16 | 19.84 | 5.39 | 4.75 |
| grippier | 0.38 | 0.22 / 0.3 | 17.06 | 3.86 | 4.38 |

The selected middle setting retains momentum while giving more recoverable braking than the looser variant. The grippier variant loses considerably more speed without input.

## 7. Acceleration and useful speed

Commanded thrust starts at **6.2 m/s²**, fading linearly with forward speed toward an 11 m/s thrust envelope. This is not a velocity clamp. Actual measured sustained useful speed is **8.91 m/s** after damping/contact losses. A bounded torque motor encourages physical rolling; it applies torque impulses without assigning body rotation or angular velocity during play. Braking uses a 6 m/s² command, then transitions to limited reverse influence (3 m/s² command, approximately 3 m/s reverse thrust envelope).

Measured: 0→5 m/s in **1.183 s**, 0→8 m/s in **3.275 s**. A full straight run is intentionally dangerous on the 20 m platform.

## 8. Steering and controls

**W** accelerates; **S** brakes existing motion, then reverses. **A/D** turn left/right consistently. Heading changes at `2.6 / (1 + 0.12 × speed)` radians/second; steering grip is bounded to 3.8 m/s². Actual trajectory follows gradually rather than being assigned the heading. Releasing all keys preserves meaningful coast. Sphere orientation never determines input direction.

Heading-relative control was exercised with real W/A/S/D inputs in both camera distances. The chase camera follows that same heading; a sphere's changing quaternion cannot flip left/right. A separate fixed-world/camera-relative controller was not implemented as a second gameplay variant. The practical choice is the stable heading basis, based on readable turning, visible rolling and V-view tests rather than a claim of a formal user preference study.

## 9. Collision and knockback behavior

All contact impulses come from Rapier. There are no teleports, hit-strength bonuses, impact cooldowns or temporary non-solid balls. Movement adds continuous bounded drive/steering torque and force; it does not special-case collision partners. A medium/high attacker transfers most of its forward velocity to a stationary target while slowing itself. Equal head-on attacks recoil both players. Side/glancing contacts deflect both; the glancing experiment eliminates the attacker. Rolling spin can exchange energy with the floor after contact.

## 10. Edge and elimination behavior

Balls physically roll off the disk and fall. Input authority stops once the sphere has lost meaningful surface support; there is no air recovery or invisible barrier. Elimination is **centre y < −3.5 m**. A distant recovery safeguard also eliminates at distance > initial radius + 15 m (25 m in this arena), far outside the visible edge. Normal falls reach the vertical threshold first.

A ball at x=6.3 m moving outward at 5 m/s survived when S was held, while the same unbraked setup fell. The 0.9 s final-fall grace allows simultaneous physical falls to resolve as draws. Eliminated balls disappear after the physical fall, the score row says **Düştü**, and the human sees **Düştün · Kalan oyuncuları izliyorsun** with an arena overview.

**Audio choice:** reuse existing procedural impact/countdown/winner cues. Do not call the generic fall cue, which currently routes to the Rooftop cat WAV. This prototype's fall is communicated visually, with no cat sound and no new audio asset.

## 11. Growth decision

Not implemented. The secondary reference description reports growth, but exact tradeoffs were not verified. Equal-size/equal-mass contacts are the first prototype's priority. Current measurements already expose useful speed/angle/edge decisions, so adding size, mass and handling changes would complicate collision tuning without playtest evidence of improvement.

## 12. Secondary action decision

No gameplay secondary action. Momentum, braking, steering, approach angle and recovery provide the current agency. V changes camera distance only. No evidence from the tested base loop justified a jump, dash or boost.

## 13. Anti-stall

Initial conservative bots and slow shrink produced 60+ second rounds, so anti-stall is justified by measurements. A warning appears at **35 s**. At **38 s**, the actual floor and matching visual edge shrink at **0.8 m radius per second**. At 50.5 s all support is gone if the round has not already resolved. Players still eliminate by falling, never by crossing a timer-driven kill ring. Shrink is local deterministic fixed-step state, not wall-clock timing or an online server feature.

## 14. Bot AI

Poyraz is the more aggressive rammer; Tipi brakes earlier and limits sustained attack speed. Reactions are sample-and-hold at approximately **0.24 / 0.32 s**, with deterministic aim error, nearest-live-opponent acquisition, modest current-velocity lead and edge recovery based on present motion. Bots briefly circle away to create a new approach instead of shoving forever; these windows are staggered by slot/seed. They use exactly the human movement function and physical coefficients. No future physics, teleports, mass advantage or hidden boost.

## 15. Camera and player readability

Default: 54° FOV, approximately 15–16.5 m behind and 11–12 m above the stable heading. A smoothed, centre-biased target keeps the nearby platform readable. **V** toggles one wider 23 m / 20 m view. Human elimination switches to a centre overview; it does not follow the falling body down the valley. No Bowling camera dependency or pointer lock.

Numbers/names and coloured bands identify every ball; the human also has a ground ring and direction marker. Only off-screen live rivals receive numbered edge markers. HUD shows round, survivors and round wins; the concise controls appear during countdown and remain available in Esc → Kontroller. No permanent debug block; optional `?snowballDebug=1` exposes console instrumentation only.

## 16. Visuals and asset audit

Existing Party Lab geometry and the curated Prop Hunt/Bowling kits and their credit files were inspected. The latter document Quaternius nature assets and Kenney Prototype/Particle/Skybox assets, but importing those bundles was unnecessary for this small scene.

All new game visuals are original generated Three.js geometry/materials: faceted balls, coloured torus bands/patches, disk/ice cliff, white rim, distant snow peaks, procedural name textures and 48 pooled point particles. Collision puffs use at most ten recycled points per burst. No downloaded pack, texture, rig, model or new audio is added. The reference screenshot stays outside the repository and is never loaded by the game.

## 17. Collision experiments

Reproducible with `npx tsx scripts/test-party-lab-snowball.ts /tmp/snowball-experiments.json`. Final 20 m arena, two equal masses, no control input after setup, maximum observation 4 s (or completed round). Rolling initial angular velocity matches translation. Velocity cells show **(x,z), attacker / defender**, in m/s, immediately before/after first detected impact. Displacements are horizontal distances from setup to observation end, in m. “in” means not eliminated by that observation time, not a guarantee of eventual survival.

| Case | Pre-impact velocity A / B | Post-impact velocity A / B | Displacement A/B, m | Outcome A/B | Max geometric overlap, m |
| --- | --- | --- | --- | --- | --- |
| A stationary / medium | (5.73, 0.00) / (0.00, 0.00) | (1.20, 0.00) / (4.35, 0.00) | 7.78/8.38 | in/in | 0.000 |
| B stationary / high | (9.73, 0.00) / (0.00, 0.00) | (2.05, 0.00) / (7.40, 0.00) | 11.97/12.61 | in/out | 0.000 |
| C head-on | (9.74, 0.00) / (-9.74, 0.00) | (-5.35, 0.00) / (5.35, 0.00) | 3.68/3.54 | in/in | 0.000 |
| D perpendicular | (7.71, 0.00) / (0.00, 4.82) | (1.26, 2.85) / (6.25, 2.05) | 11.47/13.94 | in/out | 0.000 |
| E glancing | (9.63, 0.00) / (0.00, 0.00) | (6.35, 3.36) / (3.19, -3.29) | 17.54/8.25 | out/in | 0.000 |
| F edge defender | (9.73, 0.00) / (0.00, 0.00) | (2.05, 0.00) / (7.40, 0.00) | 7.73/6.48 | in/out | 0.000 |
| G both at edge | (0.00, 7.84) / (0.00, -4.90) | (-1.97, -1.58) / (1.95, 4.42) | 4.40/4.39 | in/out | 0.000 |
| CCD stress | (64.55, 0.00) / (-64.55, 0.00) | (-35.47, 0.00) / (35.47, 0.00) | 21.20/21.13 | out/out | 0.286 |

A–G: **0 invalid bodies, no tunneling or solver explosions**. The additional 65 m/s-per-ball stress case is far outside normal useful speed; CCD catches and reverses both balls, with a **0.286 m transient sampled penetration** before separation. This is an extreme-speed limitation, not hidden as a clean overlap result. There was no pass-through or unbounded velocity growth. Vertical velocity and exact samples are retained in the external JSON.

## 18. Control experiments

Acceleration/coast/brake experiments use a larger test floor so an edge does not censor measurements. Ordinary play uses the 20 m disk.

| Experiment | Result |
| --- | --- |
| 0 → 5 m/s | 1.183 s |
| 0 → 8 m/s | 3.275 s |
| Sustained thrust, 15 s | 8.912 m/s |
| Release at sustained speed, coast 3 s | 22.108 m |
| Release from 8 m/s, coast 3 s | 19.843 m |
| S from 8 m/s to <0.3 m/s | 1.192 s; 4.748 m |
| Start 2 m/s; D only until heading turns 90° | 0.733 s; position (0.230, −1.202) m; speed 1.163 m/s; actual trajectory turned 29.13° |
| Start 8 m/s; D only until heading turns 90° | 1.100 s; position (1.396, −7.226) m; speed 4.943 m/s; actual trajectory turned 25.08° |

The final two rows explicitly distinguish **heading** from **velocity direction**: turning the aim 90° does not instantly rotate existing momentum. Browser runs also exercised combined W+D, braking, release, and camera changes.

## 19. Arena-size comparison

12 deterministic seeds × 3 rounds × 2 player counts × 4 diameters = **288 simulated rounds**. The human slot uses the same sampled bot helper for this comparison; this is a pacing benchmark, not 288 human playtests. Duration includes final-fall grace, excludes intro and round results.

| Diameter, m | Players | Mean, s | Median, s | Range, s | Shrink needed | Draws |
| --- | --- | --- | --- | --- | --- | --- |
| 18 | 2 | 30.40 | 31.91 | 9.18–50.11 | 15/36 | 8/36 |
| 18 | 3 | 36.94 | 44.12 | 10.67–49.98 | 20/36 | 10/36 |
| 20 | 2 | 36.20 | 46.20 | 10.60–50.96 | 20/36 | 10/36 |
| 20 | 3 | 39.48 | 42.80 | 12.30–51.08 | 21/36 | 11/36 |
| 22 | 2 | 39.99 | 46.60 | 10.89–52.00 | 25/36 | 14/36 |
| 22 | 3 | 44.36 | 51.04 | 8.73–52.05 | 27/36 | 17/36 |
| 26 | 2 | 45.44 | 51.77 | 12.95–54.82 | 29/36 | 10/36 |
| 26 | 3 | 48.29 | 52.71 | 8.03–54.76 | 32/36 | 17/36 |

**20 m selected:** more maneuvering room than 18 m, shorter 3-player rounds and less dependence on shrink than 22/26 m. At 20 m the means are 36.2 s (2P) / 39.5 s (3P), medians 46.2 / 42.8 s. The small number of 10–12 s early knockouts is acceptable; occasional late rounds reach about 51 s including grace.

## 20. Headed Chrome results

Google Chrome ran headed, with Playwright sending browser keyboard down/up events. Controlled cases seed initial body positions/velocities through the opt-in debug object; all subsequent movement/contact uses live physics and actual keyboard input. Full matches advance in real time, with keyboard-only steering decisions sampled about every 230 ms; no simulation fast-forward or outcome injection.

| Players | Viewport | Active round durations, s | Final scores | Completion |
| --- | --- | --- | --- | --- |
| 2 | 1440×900 | 50.61, 48.52, 49.80 | 1 / 0 | results |
| 3 | 1366×768 | 49.69, 40.03, 49.31 | 3 / 0 / 0 | results |

Low-speed bump, full-speed approach, side hit, glancing hit, equal head-on, successful S edge recovery and unbraked self-elimination all executed. The ram cases registered solid contacts; no ghosting. The two-player match included two physical draws and one human win. Both matches completed all three rounds, reset between rounds, and successfully used **Yeniden oyna**.

Additional cross-checks: 3P at 1440×900 and 2P at 1366×768; V toggles 0→1→0 in both, including immediately after menu resume. Esc freezes elapsed time and displays the correct pause notice; mode-specific Controls omits Rooftop bindings. All seven existing local modes were mounted in headed Chrome and returned a canvas without page errors, then switched back to snowball. Zero page exceptions across these runs.

Screenshots and scripts: `/private/tmp/snowball-prototype-20261004/` (`final-1440-3p.png`, `final-1366-2p.png`, `case-*.png`, `match-*.png`, `full-matches.mjs`, `browser-final-qa.json`, `browser-results.json`).

## 21. Performance

No CPU/GPU throttling, DPR 1 in headed desktop Chrome. Full-match measurements yielded approximately **60.00 FPS** at both required sizes. Chrome CDP ScriptDuration averaged **1.516 ms/frame** for 2P and **1.244 ms/frame** for 3P over the full match (includes app/framework script, separate from the game callback below). CDP total task time was 1.998 / 1.684 ms/frame.

Short warm validation windows, 8 seconds each; time cells are **average / p99 / maximum**, in ms. Draw calls/triangles are peak sampled counts, bodies are allocated dynamic spheres / invalid bodies:

| Players / viewport | FPS | Game JS/frame | Rapier step | Draw calls / triangles | Bodies / invalid |
| --- | --- | --- | --- | --- | --- |
| 3 / 1440×900 | 60.00 | 0.105 / 0.200 / 0.500 | 0.026 / 0.100 / 0.300 | 34 / 2684 | 3 / 0 |
| 2 / 1366×768 | 59.99 | 0.230 / 0.900 / 7.900 | 0.069 / 0.300 / 0.400 | 31 / 2150 | 2 / 0 |

Full-match frame p99: 17.8 ms for both; maximum 18.5 ms (2P), 28.5 ms (3P). Full-match Rapier p99 0.3 ms, maximum 0.4 / 0.6 ms. No fixed-step time was dropped during those measured matches. Zero gameplay-speed tunneling/explosions; out-of-range CCD stress limitation is reported in section 17. These are this machine's measurements, not a guarantee on all devices; sub-0.1 ms browser samples are timer-resolution limited.

Final off-screen-marker/result UI validation (1440×900, 3P, after the table's cross-checks): both hidden rivals produced numbered direction indicators, the result screen and replay worked, and there were no page errors. Peak scene count was **36 draw calls / 2,704 triangles**. The final window measured 60.01 FPS; game JS average/p99/max 0.596/1.100/8.300 ms and Rapier average/p99/max 0.145/0.300/7.100 ms. The isolated 7.1 ms physics wall-time outlier is retained rather than omitted; frame maximum was 18.0 ms and invalid bodies stayed zero. See `final-overlay-qa.json`, `offscreen-markers.png` and `result-final.png` outside the repo. The last result screenshot uses a staged UI state; it is separate from the two real-time full-match logs.

## 22. Tests and build

- **593/593 Party Lab frontend/deterministic/regression tests passed**, covering existing modes, network/protocol expectations, input, audio, cameras and physics, including the 13 new snowball tests.
- The 13 snowball tests were rerun after the final arena-bound default cleanup: **13/13 passed**.
- New coverage: config/local-only exclusion, spawn spacing/inward heading, physical edge/elimination thresholds, winner/draw, countdown, equal mass/one collider/CCD, simultaneous falls, scoring/reset/full match, deterministic bot helper/edge braking, late shrink, acceleration/coast/brake, head-on collision, speed-dependent transfer and edge recovery.
- `npx tsc --noEmit`: passed. `npm run build` (TypeScript + Vite): passed. Existing Vite large-chunk warning remains; this adds a separately lazy-loaded playground.
- `git diff --check`: passed.
- No Railway server was started or changed. Frontend regression tests exercise shared/online simulations and protocol invariants; this is not a new online implementation or a production multiplayer test.

Commands used:

```sh
npx tsx --test src/party-lab/scene/*.test.ts src/party-lab/scene/bowling/*.test.ts src/party-lab/network/*.test.ts src/party-lab/input/*.test.ts src/party-lab/audio/*.test.ts src/party-lab/*.test.ts
npx tsx --test src/party-lab/scene/snowball.test.ts
npx tsx scripts/test-party-lab-snowball.ts /tmp/snowball-experiments.json
npx tsc --noEmit
npm run build
git diff --check
```

## 23. Files changed and isolation

Modified:
- `src/party-lab/scene/ArenaScene.tsx`: local selector, isolated lazy playground, local player count/HUD/replay, local control text.
- `src/party-lab/scene/ArenaChrome.tsx`: optional control-content and menu-note props. Existing callers retain their original controls/text and behavior.

Added:
- `src/party-lab/scene/snowball/config.ts`
- `src/party-lab/scene/snowball/bots.ts`
- `src/party-lab/scene/snowball/game.ts`
- `src/party-lab/scene/snowball/visual.ts`
- `src/party-lab/scene/snowball/SnowballPlayground.tsx`
- `src/party-lab/scene/snowball/SnowballHud.tsx`
- `src/party-lab/scene/snowball/snowball.css`
- `src/party-lab/scene/snowball/REPORT.md`
- `src/party-lab/scene/snowball.test.ts`
- `scripts/test-party-lab-snowball.ts`

No changes under `shared/`, `servers/`, online mode lists, `PartyRoom`, `PartyLobby`, online arenas, Mixed rotation, dependencies or assets. **Protocol remains 10; seven online modes remain.** No commit, push, deployment, reset, checkout, stash, clean or unrelated-work discard was performed.

## 24. Backup

Before implementation, `git status`, `git diff`, `git log --oneline -10` showed a clean working tree at `e5f26aa`.

**`/private/tmp/snowball-prototype-20261004/baseline-e5f26aa.tar.gz`**: complete Git archive of the clean tracked baseline, approximately 483 MiB, outside the repository. Initial status and diff are beside it. Archived ArenaScene, ArenaChrome and protocol files were byte-compared with HEAD and matched. Browser screenshots, JSON measurements and test/build artifacts also live in that external directory. The archive does not include Git history, ignored files, secrets or dependencies; the clean tracked tree is the backed-up source baseline.

## 25. Remaining issues and manual tuning questions

- The deliberately imperfect bots still sometimes settle into low-speed shoving and require late shrink. At the selected size, shrink activated in 20/36 duel rounds and 21/36 three-player benchmark rounds. Manual preference on more aggressive/less cautious bots is the main next tuning input.
- Physical double falls are genuine draws: 10/36 duel and 11/36 three-player benchmark rounds. The human-style 2P run had two draws; this keeps the last-survivor rule honest but can yield a 1–0 match after three rounds. No arbitrary tie-break was added.
- Default chase versus V overview is a preference to assess manually. Very close aligned balls can overlap their overhead labels; coloured bands and off-screen numbered indicators preserve identity/direction. No splitscreen or extra human keyboard mapping exists.
- At 65 m/s per ball (over seven times useful speed), a brief 0.286 m overlap was measured despite successful CCD response. Normal 5–10 m/s contact experiments had zero measured geometric overlap. Revisit substepping/contact prediction before introducing future speed boosts.
- Reference growth and exact reference controls/hazards remain incompletely verified. No unsupported growth rates, jump/dash claims or proprietary physics constants are represented as facts.
- This is a desktop keyboard prototype. It has no online, touch/gamepad, growth or secondary-action implementation. Player feel should now be evaluated manually before extending scope.
