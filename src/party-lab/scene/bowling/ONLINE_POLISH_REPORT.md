# Human Bowling online polish

The original measurements below are preserved. The protocol 12 release validation
section at the end supersedes the original pass's deployment status.

October 5, 2026. Local work in `/Users/enesk/Desktop/world-quiz`, based on
`6a5baee`. No commit, push, protocol bump or production deployment is part of this
pass. The initial working tree was clean and already contained protocol 11 and
Snowball online code. This differs from the supplied description of production
protocol 10 and uncommitted local Snowball work. That pre-existing state was
preserved; production was not contacted or changed.

## Performance findings

Network correction stutter was reproducible while rendering stayed near 60 FPS.
The original degraded two-client run made five hard corrections, with a largest
car error of 9.90 m. The server advances held input while TCP delays newer input;
the old predictor then replayed those already-consumed durations again. The
Bowling-only `heldTicks` field lets reconciliation subtract that repeated time.
An identical deterministic stall trace reduces maximum correction from 4.96 m to
1.39 m and hard corrections from one to zero.

Two additional CPU costs were measured. Reconciliation unnecessarily rebuilt
ragdoll joints and reset/woke the whole rack at every 20 Hz snapshot. It now resets
only at the turn boundary. The prediction world's first physics step also caused
an approximately 80–84 ms physics spike at 4× CPU slowdown, when the first player
started driving and when a spectator became the next driver. That one-time private
world initialization now runs during arena loading, before play is marked ready.
The first authoritative driving snapshot still resets/restores the car normally.

Bowling's interpolation reserve is 150 ms, up from 100 ms. Replaying the same
recorded network arrivals reduced held spectator frames from 141 to 68. It adds
50 ms of remote presentation reserve; local car prediction still uses the newest
authoritative state. Long TCP stalls can still exhaust the buffer. Other modes
retain their original interpolation delay and behavior.

The network proxy uses 100 ms base RTT plus independent 0–40 ms jitter in each
direction. It models modest packet loss as 1% of TCP chunks incurring a 180 ms
retransmission delay, preserving bytes and ordering. This is a TCP head-of-line
retransmission model, not literal IP packet dropping. Flight and pins always use
server snapshots; no local scoring or authoritative ragdoll simulation was added.

The final normal, 4× CPU and Retina runs all have zero frames over 33 ms, including
the first drive and the next player's turn. The final degraded run has one 33.2 ms
frame during angle selection (Bowling update 0.6 ms), and no sustained FPS loss.
It has zero hard corrections, maximum error 2.081 m, and zero history overflows.
Two earlier fixed-network runs also had zero hard corrections, with maxima
1.462 / 1.292 m. Network timing varies between live runs; the identical-trace
regression above isolates the replay fix independently of that variation.

| Final headed profile | Obstacles | Driving FPS active / spectators | Bowling driving JS active / spectators ms/frame |
| --- | --- | --- | --- |
| 2 players, 1440×900 | Off | 60.00 / 60.00 | 0.736 / 0.202 |
| 3 players, 1366×768 | Off | 60.00 / 60.00 / 60.00 | 0.540 / 0.158 / 0.142 |
| 2 players, 1366×768 | Off | 60.00 / 60.00 | 0.578 / 0.157 |
| 3 players, 1440×900 | Off | 60.01 / 60.00 / 60.00 | 0.573 / 0.156 / 0.163 |
| 2 players, 1440×900, 4× CPU | Off | 60.02 / 60.00 | 1.369 / 0.286 |
| 2 players, 1440×900, device DPR 2 | Off | 60.00 / 60.00 | 0.615 / 0.163 |
| 2 players, 1440×900, degraded network | On | 60.00 / 60.01 | 0.963 / 0.185 |

On was also checked directly in two-player 1440×900 and three-player 1366×768
rooms, before the final first-step warmup. Those runs exposed the first-step hitch;
they are retained as evidence rather than described as hitch-free final runs.
All observers agreed on authoritative scores and obstacle flags. There were no
browser exceptions. Each online run follows a full first throw through the next
player's turn; complete two/three-player matches are additionally covered by tests.

Detailed phases below are the final three-player 1366×768 run, active player / first
spectator. Frame-time averages are approximately 16.67 ms throughout. The spectator
becomes the next driver during the reset row. The second spectator is included in
the full CSV/JSON evidence.

| Phase | FPS A / S | Frame p95 / p99 A ms | Frame p95 / p99 S ms | JS mean A / S ms | Physics mean A / S ms | Render CPU mean A / S ms |
| --- | --- | --- | --- | --- | --- | --- |
| Driving | 60.00 / 60.00 | 17.7 / 18.0 | 17.7 / 17.8 | .540 / .158 | .201 / 0 | .384 / .419 |
| Angle selection | 59.90 / 60.00 | 17.3 / 17.7 | 17.8 / 17.8 | .314 / .167 | .086 / 0 | .290 / .340 |
| Flight | 60.01 / 60.00 | 17.7 / 18.4 | 17.7 / 18.2 | .248 / .160 | 0 / 0 | .349 / .378 |
| First impact, first 0.2 s | 59.78 / 59.88 | 17.9 / 17.9 | 17.8 / 17.8 | .218 / .133 | 0 / 0 | .209 / .308 |
| Pin chain, next 3.3 s | 60.02 / 60.01 | 17.7 / 18.1 | 17.7 / 17.9 | .247 / .168 | 0 / 0 | .361 / .386 |
| Settling | 60.00 / 60.00 | 17.7 / 18.0 | 17.7 / 18.1 | .219 / .145 | 0 / 0 | .364 / .392 |
| Score and next turn | 59.99 / 60.01 | 17.7 / 18.9 | 17.7 / 18.0 | .146 / .245 | 0 / .035 | .409 / .420 |

Frames strictly over 16.7 ms, as active count/total and spectator count/total:
driving 234/550 and 239/550; angle 9/21 and 6/15; flight 119/270 and 120/270;
first impact 6/11 and 7/12; chain 87/199 and 86/198; settling 439/1032 and
434/1032; reset 120/257 and 117/258. Every over-33-ms count is zero. The 16.7 ms
threshold includes ordinary variation around a 60 Hz display interval.

At 4× CPU, phase FPS for the active player is 60.02 / 60.02 / 60.00 / 59.85 /
59.99 / 60.00 / 60.01 in the same order. Driving JS p99 is 3.8 ms; the largest
in-play physics sample is 11 ms, down from 84.2 ms before warmup. The spectator's
largest physics sample is 2.2 ms, down from 84.4 ms at its first turn. The final
trace contains 13 minor GCs (maximum 4.288 ms), no major GC, and no over-33-ms
frames on either client. Whole-browser CDP ScriptDuration averages 3.07 / 2.78
ms per captured frame; the phase table measures Bowling's update separately.

Normal in-play renderer CPU averages are about 0.21–0.62 ms/frame. Rendering uses
roughly 17–22 draws and 103k–109k triangles through driving/impact, with fewer
visible draws on some reset views. Actual canvases are 1422×882 and 1348×750 at
DPR 1. The device-DPR-2 case renders at the existing cap of 1.5, 2133×1323 pixels.
No DPR cap, shadow, asset, material or effect quality was changed. CPU render
submission time is measured; GPU timer results are unavailable. CPU throttling
does not emulate an older GPU, so these tests cannot rule out friends' GPU limits.

The authoritative server remains unthrottled. Across the final seven profiles:

| Server phase | Tick mean range ms | Highest run p95 ms | Highest run p99 ms |
| --- | --- | --- | --- |
| Driving | .177–.350 | .778 | 1.979 |
| Angle selection | .093–.309 | 2.568 | 2.978 |
| Flight | .342–.739 | 1.460 | 4.041 |
| First pin impact | .363–1.364 | 4.489 | 4.489 |
| Chain reaction | .406–1.204 | 2.820 | 6.176 |
| Settling | .308–1.063 | 1.856 | 3.414 |
| Score/reset | .009–.021 | .036 | .745 |

The largest chain tick is 11.175 ms; settling has one 16.488 ms tick. There is an
isolated 63.873 ms startup/countdown sample (that run's countdown p99 15.154 ms).
This is a co-located development server and browser measurement, not a production
server trace. No sustained server-physics bottleneck or pin-impact frame collapse
was reproduced, and no gameplay solver quality was reduced.

Snapshots remain 20 Hz and active inputs 60 Hz. Driving already sends only the
28-byte car transform; flight sends 560 bytes for car, ragdoll and ten pins.
Final complete snapshot messages are approximately 618–632 bytes in driving and
1217–1250 bytes in flight/impact. Per-client downstream is about 12.7–13.0 kB/s
driving and 24.7–25.4 kB/s in flight, plus transport overhead. Message rates are
about 21/s down, 61/s up for the active player, and 1/s up for spectators, including
ping traffic. There was no measured bandwidth saturation, so pose packing and
settled-body replication were left intact.

In the final degraded run, snapshot gaps are active p95/p99/max 77.9/89.2/246 ms
and spectator 79.2/95.3/245.3 ms. The active car has about 20 reconciliation checks
per second: mean error .320 m, p95 .970 m, p99 1.489 m, max 2.081 m; none is a
hard correction. Spectators do no car reconciliation during another player's
throw. Measured playout backlog averages about 77–124 ms by phase, versus
34–58 ms in the baseline network run. Final spectator holds are 20 frames in
driving (longest 117 ms), zero in flight/first impact/chain, and 25 while settling
(longest 117 ms). Baseline spectator counts are 30 / 23 / 0 / 41 / 43, with a
183 ms chain hold. Live proxy schedules differ; the recorded-arrival comparison
and deterministic correction regression supply the controlled comparisons.

Full per-case/per-client/per-phase FPS, frame/JS/physics percentiles, render CPU,
draw counts, triangles, resolution, threshold counts, message sizes/rates,
corrections, gaps and backlog are in
`/private/tmp/bowling-polish-20261004/phase-metrics.csv` and `phase-metrics.json`.

## Obstacle preference

`Engeller · Kapalı / Açık` uses the existing compact mode-settings style. The
default is `Kapalı`. The host can change it in the waiting lobby; guests see a
read-only summary. Invalid and guest changes are rejected by the server, changes
clear Ready, and in-game changes are rejected. The setting is copied into the
authoritative Bowling simulation and included in snapshots.

Mixed retains the room's current Bowling preference, including across other
selected modes. It defaults off and never chooses obstacles randomly. The local
arena exposes the same option in its existing menu and uses the same shared game.
Changing the local option restarts that local game, as other local mode settings do.

Off disables all six ball slots: meshes, collision sensors, slowdown/heading
penalties and obstacle avoidance. On retains the original six seeded layouts and
collision behavior. Road geometry and the launch approach are unchanged. Tests
cover every throw reset, authority, Ready reset and deterministic Mixed behavior.

## Pin audit and tuning

| Property | Before | Final |
| --- | --- | --- |
| Visual and collider scale | 4.8× | unchanged |
| Height / maximum diameter | 7.2 / 2.304 m | unchanged |
| Colliders | one cylinder, two convex hulls | unchanged |
| Mass | 13.5 kg | 5 kg |
| Mass distribution | 30% base / 50% body / 20% top | unchanged |
| Center of mass above base | 2.56556 m | unchanged |
| Adjacent center spacing | 4.032 m | 3.456 m |
| Friction | 0.38 | unchanged |
| Restitution | 0.12 | unchanged |
| Linear / angular damping | 0.12 / 0.22 | unchanged |
| Solver / CCD configuration | existing defaults | unchanged |

The ragdoll weighs 3.4 kg total. Each original pin weighed almost four times the
whole ragdoll. Lower mass helped, but the wide rack also limited secondary
contacts. Masses 10, 8 and 6 kg, several nearby spacings, lower friction, greater
restitution, lower angular damping and extra solver iterations were compared.
Lower damping produced late knockdowns in some samples; extra solver iterations
did not consistently improve compression. Neither was retained.

The final 5 kg / 3.456 m combination improves ground recovery and normal impacts
without requiring a still tighter rack. Its mass is below the suggested 6–10 kg
starting range because the measured 6 kg candidate's ground-recovery average was
2.628 pins; 5 kg gives 3.464 on the same 500 throws. The final rack remains
separated: the widest diameters have 1.152 m of adjacent clearance. No enlarged
hitboxes, score multipliers, strike rules or extra knockdown impulses were added.

The head pin remains at z=199.5 m, 170.5 m from the ramp lip. Car acceleration/top
speed, gravity, launch eligibility, angle gauge, Nudge, WASD, audio, camera presets,
sky/palette/course, scoring thresholds and reaction windows are unchanged.

## Controlled impacts

These use the actual nine-body ragdoll and shared fixed-step Rapier simulation.
The body is placed at a measured rack-arrival state, then all contact, transfer,
rotation and scoring are physical. Velocities below are measured at first contact;
the misaligned throw misses the rack. Initial-contact IDs are zero-based.

| Fixture | Contact speed before → final m/s | Initially contacted before → final | Secondary contact pairs before → final | Pins before → final | Peak angular speed before → final rad/s | Chain duration before → final s |
| --- | --- | --- | --- | --- | --- | --- |
| Weak glancing | 8.74 → 9.37 | 5 → 5 | 0 → 0 | 0 → 0 | 1.08 → 1.56 | 0 → 0 |
| Medium off-center | 27.02 → 27.02 | 0 → 0,2 | 4 → 5 | 1 → 3 | 2.37 → 3.85 | 24.13 → 7.05 |
| Strong centered ground | 42.07 → 42.07 | 0 → 0 | 3 → 11 | 0 → 7 | 0.92 → 3.13 | 13.15 → 5.55 |
| Strong centered airborne | 42.07 → 42.07 | 0 → 0 | 8 → 13 | 4 → 10 | 2.76 → 6.56 | 4.00 → 5.13 |
| Upper airborne | 42.05 → 42.05 | 0 → 0 | 5 → 7 | 3 → 6 | 4.65 → 7.13 | 3.40 → 1.85 |
| Excellent pocket | 46.06 → 46.06 | 0 → 0,2 | 6 → 14 | 3 → 10 | 2.47 → 5.07 | 4.95 → 5.10 |
| High energy, badly aligned | no contact | none | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |

Secondary pairs count unique pin pairs with solver contacts and a moving pin.
Chain duration extends to the last such contact, including settling contacts;
it is not the time of the last scored knockdown. The final centered airborne
strike reaches ten at 4.017 s and the pocket strike at 3.117 s.

## Five hundred full-course throws

The before/after runs use the same deterministic input cohort, with no outcome
filtering. A competent driving controller targets 41–46 m/s, lateral targets
within ±1.8 m, varied legal gauge release, and a single Nudge in 25% of recipes.
Every throw drives the full course, charges/releases normally and resolves actual
flight/contacts. Obstacles are off in both cohorts. The physical controlled
fixtures above are separate from these 500 throws.

| Pins scored | Before count | Final count | Final share |
| --- | --- | --- | --- |
| 0 | 87 | 15 | 3.0% |
| 1–3 | 346 | 188 | 37.6% |
| 4–6 | 65 | 172 | 34.4% |
| 7–9 | 2 | 118 | 23.6% |
| 10 | 0 | 7 | 1.4% |

Average: **2.004 → 4.586**. Any pin contact: **97.4% → 97.6%**.
Strikes remain uncommon, with seven different full-course recipes producing ten.
No desired strike percentage was used as an acceptance target.

Final direct-airborne arrivals: 292 throws, average 5.527, six strikes (2.05%).
Their bins are 3 / 67 / 114 / 102 / 6. Final ground-recovery arrivals: 196 throws,
average 3.464, one strike (0.51%); bins 0 / 121 / 58 / 16 / 1. Twelve throws miss
the rack. Before tuning, airborne/ground averages were 2.625 / 1.214.

All 500 final throws have zero invalid-body recoveries and zero score changes
after the scoring window. Peak observed pin speed is 18.46 m/s. Initial rest is
stable and colliders do not overlap. Brief hard-impact compression still occurs:
the sampled worst world-plane depth is 17.4 cm, versus 12.2 cm before. Maximum
settled world-plane depth is 1.07 cm, versus 1.38 cm before; the visible floor is
3 cm below that plane, so settled pins remain above it. This does not claim zero
transient compression. Per-tick replays of the three deepest cases confirm peaks
17.40 / 14.83 / 13.73 cm. Each has only two physics ticks above 10 cm; the longest
continuous interval above 5 cm is 83 ms. Their final-second depths are at most
6.2 / 4.6 / 3.6 mm, with no invalid-body recovery.

Reproduce the final cohort with:

```sh
npx tsx scripts/validate-party-lab-bowling-polish.ts /private/tmp/bowling-final 500 --recipes --candidate mass5-spacing72 --current
```

## Headed browser checks

Headed Chrome completed real W/SPACE keyboard driving at 1440×900 and 1366×768.
Off produced no obstacle hits and all ball sensors were disabled; acceleration,
ramp approach, launch and pin contact completed. On produced two actual ball
collisions at both sizes. The local setting and online host/guest layouts were
visually inspected at both sizes.

Browser physical arrival fixtures produced the same results at both resolutions:
weak 0, off-center 3, ground 8, centered airborne 9, upper rack 6, pocket strike 10,
bad alignment 0. These fixtures use eight unchanged fixed physics steps per render
frame to shorten observation, and do not supply scores or contact impulses. Small
differences from fresh-world offline fixtures reflect the existing world's contact
history. Their results are reported separately rather than treated as identical.

The online profiler uses legal input packets through the real controller and
server, with separate headed Chrome processes for active player and spectators.
Its driving automation is not a claim of human keyboard play. The local keyboard
checks above separately exercise real input handlers.

## Validation and preservation

The final frontend/edge suite passes 639/639. One Bowling test's old assumption
that a marginal ground hit must score exactly zero was updated to the requested
weak-hit range 0–3; its unchanged Nudge/airborne/overflight checks still pass.
The full server suite passes 56/56, including the Bowling setting authority test
and the existing Snowball regressions. Frontend TypeScript and production build,
server test TypeScript and server production build all pass. The frontend build
retains the existing large-chunk warning. `git diff --check` passes.

All 33 tracked Snowball-named files match their pre-task SHA-256 hashes exactly.
No Snowball physics, camera, tests, online code or assets were edited. Shared
changes only add Bowling settings and an optional interpolation argument whose
default is unchanged. Deterministic Rooftop, Barn, Layer, Color, Bomb, Prop Hunt
and local Snowball hashes all match the pre-task baseline. The local Snowball
hash covers six complete seeded matches (two and three players):
`152f8639e7cdcc928ad876847a2fa0193e135ccd1c4c52007141de0115ab4729`.
Bowling's hash changes as expected for its new settings/wire behavior.

Evidence is under `/private/tmp/bowling-polish-20261004`: before/after raw headed
traces, per-phase timing/bandwidth/correction metrics, screenshots, GC trace,
controlled fixtures, all 500 before/after throws, deterministic hashes and gate
logs. `final-current-500` is the exact final physics cohort; earlier candidate
folders are experiments, not final results.

## Files changed

- Shared preference and simulation: `shared/party-lab/bowlingSettings.ts` (new),
  `shared/party-lab/simulation/bowlingRound.ts`, and
  `shared/party-lab/simulation/bowling/{config,game,car,wire}.ts`.
- Server authority/schema/tests: `servers/party-lab/src/{PartyRoom,state}.ts`
  and `servers/party-lab/tests/bowlingRoom.test.ts`.
- Lobby plumbing/UI: `src/party-lab/{PartyLabRoot,PartyLobby}.tsx` and
  `src/party-lab/network/{types,session}.ts`.
- Prediction/interpolation/tests: `src/party-lab/network/gameStream.ts`,
  `src/party-lab/network/prediction/bowlingRig.ts`, and
  `src/party-lab/network/bowlingOnline.test.ts`.
- Local option, rendering/debug and physics tests: `src/party-lab/scene/ArenaScene.tsx`,
  `src/party-lab/scene/bowling/BowlingPlayground.tsx`,
  `src/party-lab/scene/bowling/{online,visual}.ts`, and
  `src/party-lab/scene/bowling.test.ts`.
- Reproducible physics benchmark: `scripts/validate-party-lab-bowling-polish.ts` (new).
- Documentation: `shared/party-lab/BOWLING_ONLINE.md` and this report (new).

There are 24 changed/new files: 21 tracked edits and three new files. No asset,
package, deployment configuration, protocol-version or Snowball file changed.

## Protocol 12 release validation — October 5, 2026

Release baseline: `6a5baeedf06022f947b67cfbbb8db492b43558e9`, which already deployed
Snowball online under protocol 11. A complete external archive, including `.git`,
untracked polish, dependencies and local files, was made before release edits:
`/private/tmp/bowling-release-20261005/world-quiz-complete-before-release.tar.gz`.
Archive SHA-256: `edd02592bb6d2e6000d672f8f420ac4cabfced5df3671c8b915acf969ea17f2f`.

`NET.version` is now **12**. It gates client admission and snapshots and is returned
by `/health`. The appended Colyseus `LobbyState.bowlingObstacles: boolean` is the
room's authoritative preference, initialized to false (Kapalı). Only a connected
host in the waiting lobby may send the exact `{ obstacles: boolean }` message.
Invalid, guest, countdown and in-game updates are rejected. A real value change
clears every Ready flag; a no-op preserves Ready. At match start the room copies
the setting into the Bowling simulation; the constructed game's value stays fixed
through all throws. Mixed retains the same room preference across mode changes.
Every Bowling snapshot contains the frozen `obstacles` flag and `heldTicks`.
Reconnect restores the serialized setting, same seat and live match state.

Release integration changed no approved Bowling production implementation other
than the shared protocol constant. Pin mass remains 5 kg, spacing 3.456 m, scale
4.8, head pin z=199.5 m. Prediction prewarm, held-input time accounting, 150 ms
Bowling interpolation and turn-boundary rack reset remain intact.

Final gates: frontend/edge 640/640; server 57/57; frontend TypeScript and production
build; server TypeScript and production build; diff whitespace check. All eight
recorded simulation hashes match the approved polish, including Bowling and
Snowball. All Snowball gameplay, local/online implementation and assets remain
byte-identical. Of 33 Snowball-named tracked files, 30 are entirely unchanged;
three test files update only the common protocol assertions/titles and old-client
rejection expectation. No Snowball behavior or tuning changed.

The headed 4× CPU check measured 60.07 / 60.01 driving FPS, zero frames over 33 ms,
zero hard corrections, and maximum in-play prediction physics 10.8 / 2.0 ms.
The 84 ms first-step hitch did not recur. The representative degraded TCP run
(100 ms RTT, 0–40 ms jitter each direction, 1% 180 ms retransmission delays) measured
60.00 / 60.00 driving FPS, zero hard corrections, max correction 1.336 m, zero
history overflows, and approximately 20 Hz snapshots. This run exercised driving
through its timeout and the next turn; full launches and scoring are separately
verified by complete headed matches. Intentional reconnect intervals are excluded
from steady-state performance measurements.

The full two-player Kapalı headed match completed all six throws and returned to
the lobby. Both clients reported throws `[[8,5,9],[10,6,8]]`, totals **22–24**.
Host toggling cleared Ready in both directions; a guest packet was rejected, and
same-seat reconnect preserved the setting and current turn. Normal full-match FPS
was 59.98 / 60.00 with zero hard corrections and only turn-boundary prediction
rack resets. Three isolated host frames measured 33.1–34.4 ms (Bowling update
0–0.6 ms); the guest had none over 33 ms. No sustained regression appeared.

The full three-player Açık headed match started from Mixed with the host's current
preference, completed all nine throws, and returned to the lobby. Every client
reported `[[6,5,4],[7,2,6],[5,5,9]]`, totals **15–15–19**. The guest's unauthorized
setting message produced the host-only notice. Reconnect retained the setting,
identity and turn. All three rendered the same obstacles and observed the actual
first ball collision, reducing speed from 46 to approximately 35.8 m/s. Full-match
FPS was 60.00 on all three clients, with no frames over 33 ms, no hard corrections,
and rack resets only when that client became the driver in a new turn.

All eight modes passed final headed startup/movement smokes on protocol 12, using
the ordinary local URL with no debug UI. Final production builds were rerun after
all protocol assertion updates. The secret-pattern scan and accidental temporary
file audit found no issues.

Release evidence is under `/private/tmp/bowling-release-20261005`. Complete headed
match results and subsequent production deployment evidence are recorded there. Both production
services must be healthy on the same pushed revision before production success
is reported. The known brief impact compression (up to 17.4 cm for two physics
ticks in the original 500-throw cohort) remains documented above; no retuning was
made for it. CPU throttling is not an older-GPU simulation.
