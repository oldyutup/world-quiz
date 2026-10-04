# Human Bowling online

## Protocol 12 release

The October 5, 2026 polish uses protocol **12** for the appended
`bowlingObstacles` lobby-schema field and the `obstacles` / `heldTicks` Bowling
snapshot fields. Client admission, snapshot validation and server health share
`NET.version`; protocol 11 clients are rejected. Frontend and server must deploy
from the same revision. Measurements are in
[the polish report](../../src/party-lab/scene/bowling/ONLINE_POLISH_REPORT.md).

`Engeller` defaults to `Kapalı`. Only the host can change it while waiting, and a
change clears Ready. Mixed retains this same room preference deterministically;
it never rolls a separate obstacle choice. The local arena exposes the same option
in its existing menu. Disabled obstacles have inactive meshes, disabled sensors,
no collision penalties and no bot avoidance. `Açık` uses the original six layouts.

Pin mass is now 5 kg and adjacent rack spacing is 3.456 m. Visual/collider scale,
shape-derived center of mass, friction, restitution and damping stay unchanged.
The head pin stays 170.5 m from the ramp lip. Flight, controls, scoring and course
parameters are unchanged. The pin change uses physical contacts only.

Bowling snapshots now include `obstacles` and `heldTicks`. The latter counts server
ticks already simulated with the last held input, so prediction does not replay
those elapsed durations a second time during TCP stalls. Car reconciliation resets
the rack only at a turn boundary, and warms its physics pipeline during loading.
Bowling uses a 150 ms interpolation reserve;
other modes retain their existing 100 ms default. Ragdolls and pins remain fully
server authoritative. Snapshot/input rates and pose packing are unchanged.

The sections below record the original protocol 10 launch, before this local polish.

Protocol **10** adds `human_bowling` / **İnsan Bowlingi**, for two or three occupied
seats. Prop Hunt still requires exactly three. Each Bowling match gives each player
three throws, alternating in ascending occupied-seat order, and totals the physical
pin score. Ties remain ties. The room returns to Ready after ten seconds of results.

## Local freeze and shared physics

The local checkpoint is `2138d2c` (`feat(party-lab): add Human Bowling`). Its current
implementation, rather than historical tuning reports, is the source of truth.
The five physical modules now live in `simulation/bowling`; the local import paths
re-export them. `BowlingGame` defaults to the original local bots. Only online
construction opts out of bots so every occupied seat consumes real player input.

Six complete seeded local replays before and after extraction have the same SHA-256:
`be46f4e6e98e2e280f8b2d4cfe0c0b07bbb39f8ea06d84a76f5485e001b2f471`.
Course geometry, rack, pin mass/shape/spacing, obstacles, acceleration, launch
eligibility, angle sweep, gravity, drag, controls, Nudge, scoring and settling are
unchanged. No visual asset was rebuilt for networking.

## Authority, clock and turns

`BowlingRoundSimulation` implements the existing room simulation interface. The
server owns the seed, seats, countdown/drive/flight/score/results phases, car,
nine-part loose ragdoll, ten independent pins, launch latch, Nudge latch and scores.
It uses the same Rapier game and `BowlingClock`: 240 Hz presentation increments,
scaled accumulation into fixed 60 Hz physics. Charge selection remains the
presentation-time 0° → 30° → 0° sweep. Release uses the server's charge clock.
No client supplies a launch angle or a collision/scoring result.

The original 18 s drive timeout and 13 s flight window plus up to 12 s pin-reaction
grace remain. A 65 s online throw watchdog bounds a stationary committed charge or
repeated invalid-body recovery. It does not accelerate a normal throw. A departing
seat's remaining drives are forfeited. A temporary disconnect keeps the room's
existing 15-second reconnect grace and seat; it clears inputs, never the physical
throw. The client keeps its scene, camera and eject-audio latch mounted across
a reconnect. A snapshot after a missed countdown reconstructs the reset rack.

Inputs include the match round and throw epoch. The room checks the active occupied
seat and phase before accepting them. Mailboxes are cleared when a throw completes.
The game's existing phase/latch guards prevent repeated eject, Nudge and scoring.

## Wire format and presentation

Bowling controls use a strict 29-byte packet: uint32 sequence, match round and throw;
four Float32 throttle/brake/steer/pitch values; and the held SPACE bit. The existing
session sequence, 60 Hz sending, backlog coalescing, stale-input timeout, dead-socket
recovery and 300 messages/s cap remain in force. V never enters the packet.
SPACE transitions that arrive between server ticks are retained in a bounded queue.

At the existing 20 Hz snapshot rate, driving sends one car pose (28 bytes). Once
ejected, poses are car + nine ragdoll parts + ten pins (560 bytes), each seven Float32
position/quaternion values. No joint metadata travels over the network. The small
self-contained state section carries score, flags, clocks, seed, seats, car controller
state, scenery state, velocity and the physical pin-down mask. It supports recovery
from any snapshot without replaying missed events.

Spectators use the existing `SnapshotBuffer` playout clock and interpolate positions
and quaternions. They do not step a scoring world. The active client predicts only
the car using the same Rapier car/course, `InputHistory` limits and `RigCorrection`.
Snapshots restore the car controller/body state and replay unacknowledged inputs.
Car correction distances scale with at most 120 ms of car travel (a one-metre
walking threshold is less than two ticks at top speed), while existing easing and
angle guards remain unchanged. Other modes keep the original thresholds.
The existing `FrameClock` drives presentation. The authoritative ragdoll/pins are
always rendered from snapshots, even on the active client.

The gauge extrapolates the authoritative presentation clock by at most one snapshot
interval, and locks to the actual server-selected angle on eject. Every observer
receives the same charging/slow-motion phase and tail state. Audio uses state
transitions: a false → true eject produces the existing cat cue once, while engine
sound follows the car state. Existing mute/background behavior remains.

The same Bowling playground, HUD, assets, effects and camera functions render local
and online play. Online HUD names come from occupied room seats. V remains a local
driving-camera choice, including for spectators. The Bowling arena and GLB/sky/dust
assets load only upon entering Bowling. The compact lobby picker uses the existing
host-only controls and resets Ready on a mode change.

## Mixed and regressions

Three-player Mixed uses a seven-mode shuffled bag; two-player Mixed uses six eligible
modes, excluding only Prop Hunt. Each eligible mode appears exactly once per bag,
with no repeated mode across the bag boundary. Changing eligibility creates a fresh
bag while retaining the last-played boundary exclusion.

All six existing online simulations match the checkpoint over 1,800 deterministic
input steps (excluding only the intentional protocol-version field):

| Mode | SHA-256 |
| --- | --- |
| Rooftop | `8d89030cf2d5752364f82321950b42a6aa1100986c329955a5969c1876661de6` |
| Barn | `88562a77268129b7f9601a990678cd87037fe3e5e51d7b7d8e637c345de5fc94` |
| Layer | `ef1303cc5b33cf14a3e6fe7211d2ebbdc50ae0dc8a6f827d088530afe625a069` |
| Color | `818900429dd23650e989ef4545e55a70257bb90938a4e3453e048385c9fefea6` |
| Bomb | `5be7de86b5f30dd9b1db691edf2463fc018fe13196fa63e7fb8306bdf05bf8d2` |
| Prop Hunt | `39a4615cd14e6d7b2d92729596cd9f7a8c2125bec7c76855558b0183b9832612` |

The separate 12,000-step local Prop Hunt hash is also unchanged:
`0c359d893dbb349c394cbfb640b3dbd299ac4791b7828a1004f504e84b076ed0`.

## Headed Chrome validation

Separate real Chrome processes completed both match sizes through actual input
handlers, full-course driving, manual SPACE release, physical pin contact and all
throws. Subsequent throws exercised WASD plus a second rejected Nudge attempt.

| Run | Resolution | Final totals | Ejects / Nudges per observer | Hard corrections / overflows |
| --- | --- | --- | --- | --- |
| 3 players, direct | 1366×768 | 3 / 5 / 3 | 9 / 6 | 0 / 0, all clients |
| 2 players, degraded + reconnect | 1440×900 | 2 / 4 | 6 / 4 | 0 / 0, both clients |

The degraded TCP proxy used 150 ms base RTT plus 0–40 ms jitter independently in
each direction (FIFO delivery). Three forced socket resets covered waiting/active
driving, flight, and score. Original session IDs/seats and authoritative scores
survived all three. Both clients reached results and Ready started a clean rematch.
No artificial packet loss was injected; connection loss was exercised explicitly.

Median frame rate was 59.9 FPS for drive, flight and score on active and spectator
clients at both sizes. Server tick averages were 0.446 ms (three players) and
0.423 ms (degraded two players); maxima were 12.95 / 9.42 ms. No invalid-body
recoveries occurred. At 20 Hz, the measured final snapshot message was 1,243 / 1,252
bytes. Aggregate degraded traffic, including reconnects/results, averaged 38,332 B/s
downstream and 2,233 B/s upstream for both clients combined. Inputs stay at 60 Hz
for the active player; there were no message-cap disconnects or prediction overflows.
Driving frame displacement p99 was approximately 0.85 m (about one
60 Hz frame at driving speed), with no backward step over 10 cm. Socket outages
freeze presentation and catch up on reconnect; they cannot provide continuous motion.

All six prior modes passed three-client headed startup/input/snapshot smoke checks
with protocol 10 and no browser errors. Bowling GLB requests were absent in the
lobby on every Bowling test client. Production build emits lazy OnlineBowlingArena
(2.43 kB) and BowlingPlayground (56.08 kB, 20.14 kB gzip) chunks.

## Final automated gates

The complete frontend/edge suite passes **592/592**, including 72 local Bowling
checks and 10 Bowling network/shared-physics cases. The complete server suite
passes **51/51**, including real-socket two/three-player Bowling reconnect tests.
Frontend TypeScript/production build and server TypeScript/build pass.

The Barn prediction harness now gives shot-echo expiry the same simulated clock
as its shot markers; it previously mixed simulated time with wall-clock test time.
The final full suite runs with two workers so existing microsecond benchmarks are
not distorted by an oversubscribed process pool. No benchmark limit was relaxed.

All six current Bowling validators passed their full default cohorts: main,
course, flight, momentum, parity and reachability. The online physical-match
benchmark measured p95/p99 tick costs of 0.202/0.399 ms (two players) and
0.168/0.260 ms (three players), with maximum encoded snapshots of 1,213/1,218 bytes.
`git diff --check` passed; no temporary evidence or credential files are included.
The complete pre-edit backup is
`/private/tmp/world-quiz-before-online-bowling-20260928-complete.tar.gz`.
Deployment status is verified separately after the production push. External raw
evidence is in `/private/tmp/bowling-live-20260928`.
