# Kartopu Çarpışması online — protocol 11

Snowball Brawl (`snowball_brawl`) is the eighth online mode, for **two or three
occupied seats**. The host selects it in the existing compact picker; changing
mode resets Ready. Prop Hunt still requires exactly three. There are no online
bot seats or Snowball lobby settings.

## Frozen local source

The rollback checkpoint is `c6ade3e` (`feat(party-lab): add Snowball Brawl`). Before
that commit, all 622 frontend/edge tests, TypeScript, production build and diff
checks passed. The complete working tree, including Git, untracked files and
ignored files, was archived and the archive inventory verified:

`/private/tmp/world-quiz-snowball-backup-20261004-211212/world-quiz-complete.tar.gz`

Archive SHA-256: `cab26fb1c825df069b51207daf7b19dd96df922e275f5506ca6e2267d537e61c`.

The current code, rather than earlier tuning reports, is authoritative. Four
unchanged modules (`config`, `game`, `bots`, `screenInput`) now live in
`simulation/snowball`; the local paths re-export them. Local bot logic, local
all-fall draws, movement, scoring, visuals and camera are preserved. Six seeded
local replays hash identically before/after extraction:
`152f8639e7cdcc928ad876847a2fa0193e135ccd1c4c52007141de0115ab4729`.

Approved constants remain: 10 m arena radius; 0.95 m spheres; mass 80; restitution
0.70; ball/floor friction 0.22; linear/angular damping 0.12/0.16; gravity 16;
acceleration/reverse 7.2; braking ceiling 12; useful-speed scale 11; turn rate 3.6;
steering grip/response 8.5/4.2. The fixed camera helper and 45° lens are unchanged.
W/S remain screen up/down and A/D screen left/right, independent of ball rotation.
V has no Snowball action or packet bit. Rooftop, Bowling and Prop Hunt cameras
are untouched.

## Authority and phases

`SnowballRoundSimulation` wraps the exact local Rapier game. The room's 60 Hz
callback executes **two 1/120 s physics substeps**, with the original 8 solver
iterations, CCD and floor contact rules. Each occupied player has one dynamic
sphere. The server owns spawns, bodies, linear/angular velocities, contacts,
shrink, eliminations, round wins and the match result. There are no hit bonuses,
fake knockback, stun or control lockouts.

The room uses its normal waiting → countdown → playing → results → waiting
lifecycle. Inside that match, Snowball runs countdown (3 s) → playing → roundOver
(3.5 s) → atomic reset/countdown, for exactly three rounds. A 0.9 s physical fall
grace remains. Match results stay visible for 10 s before the Ready lobby returns.
Internal round transitions do not consume another Mixed entry. The server clears
mailboxes at each internal phase/round change; input carries both match and round
epochs. Scores increment only on a playing → roundOver transition.

Spawns use the unchanged 55%-radius placement: opposed for 2P and 120° apart for
3P, rotated each round. Seat indices are mapped explicitly, including seats 0/2.

Elimination is the approved physical rule: centre below y=-3.5, or beyond the
initial radius plus 15 m as a runaway safeguard. The visible perimeter is not a
kill circle. The server shrinks its real cylinder at 0.45 m/s after 28 s and
0.9 m/s after 36 s, disabling it at zero radius. Snapshots carry actual collider
radius and authoritative elapsed time. Presentation interpolates those radii on
the remote body timeline; it never starts an independent shrink clock.

Online all-fall resolution is explicit: a surviving player wins; if everyone
falls during the grace period, the **latest authoritative 120 Hz elimination tick
wins**. Exact-tick ties choose the first tied occupied index in cyclic order
starting at `(matchSeed + round - 1) % playerCount`. This rotates priority across
rounds and never relies on iteration order or a client's clock. Forfeited players
are excluded. Equal final round-win totals remain a tied match, as locally.

## Inputs, prediction and snapshots

Inputs are ten bytes: uint32 sequence, uint32 match epoch, round byte and four
held W/A/S/D bits. The server validates exact size/keys/ranges, current alive
phase, round and the session's occupied seat. Position, velocity, owner, camera,
collision, score and winner claims are refused. Dead/inactive players cannot
drive. The existing 300 ms stale-input timeout, sequence high-water mark, 60 Hz
sender, backlog coalescing and 300 messages/s protection remain.

`SnowballPrediction` predicts motion with the shared motor and Rapier contacts.
Remote prediction bodies coast from their last authoritative velocities; unknown
remote inputs are not invented. Every authoritative update restores all bodies'
positions, rotations, linear/angular velocities, heading and support radius,
then replays bounded unacknowledged own inputs. It never steps the game scoring
or elimination state machine. Authoritative impact momentum therefore replaces
old predictions before replay. Render corrections use the existing rigid easing;
the rolling sphere's decorative rotation is not a ragdoll-facing snap constraint.

Other players render from the existing SnapshotBuffer interpolation clock.
FrameClock bounds catch-up work. Resets never interpolate across spawn teleports.
The shared playground/HUD render the existing visuals with room nicknames and the
appropriate local-player marker. Server contact events trigger the existing sound
and puff; these events never apply an impulse. Debug instrumentation remains
opt-in (`partyDebug=1` / `snowballDebug=1`), with no normal-play debug overlay.

At 20 Hz, each ball uses 28 transform bytes and 28 motion/controller bytes.
The small state section carries seats, seed, phase, round clock/radius, wins and
elimination ticks. There is no mesh, joint or camera metadata. Standalone encoded
snapshots measured 383 B (2P) / 444 B (3P); complete Colyseus messages measured
434–436 B (2P) / 495–497 B (3P), including recipient envelope and acknowledgements.

## Reconnect and disconnect

Existing same-session, same-seat reconnection is retained. An initial countdown
disconnect cancels that countdown and clears Ready; players Ready again after
returning. During a match, input becomes neutral immediately while the physical
ball, score, stage and shrink clock continue. The reserved seat lasts 15 s.
Expiry/intentional departure forfeits the current and subsequent rounds without
creating another sphere. Rejoining within grace never revives an eliminated ball.

Real socket tests cover initial countdown, active play, after elimination,
between rounds and match results, plus grace expiry, forged inputs, score
agreement and a fresh rematch. All retain identity/seat and body count without
duplicate scoring. The headed degraded run also reset both TCP connections and
restored both original seats while the active round continued.

## Validation

Full automated gates: **635/635 frontend/edge tests**, **55/55 server tests**,
frontend TypeScript/production build, server TypeScript/production build, and
`git diff --check`. Protocol-10 admission is explicitly rejected. Only historical
reports and that intentional mismatch test retain protocol-10 references.

Mixed tests check 100 complete bags for each player count: eight eligible modes
at 3P, seven at 2P (Prop Hunt excluded), Snowball exactly once, no duplicates or
missing modes and no repeat across bag boundaries. The existing real-socket mode
rotation/disposal test now covers eight modes.

Thirty-six shared-physics contact scenarios passed with zero invalid bodies.
Released frontal low/medium/full hits displaced the target by 0.376 / 1.748 /
3.221 m after 0.5 s. A head-on at ±7.732 m/s produced immediate velocities about
∓5.4 m/s. Side hits redirect, glancing contacts change both trajectories, and a
9.01 m/s edge hit physically eliminates the target. Counter-input remains
available immediately; no velocity reset conceals recoil.

Real headed Chrome processes used actual lobby controls and keyboard events,
without setting server poses or scores:

| Run | Resolution | Agreed final wins | Median FPS | Max correction, per client |
| --- | --- | --- | --- | --- |
| 2P direct | 1440×900 | 2 / 1 | 59.88 | 0.189 / 0.362 m |
| 3P direct | 1366×768 | 1 / 1 / 1 (draw) | 59.88 | 0.174 / 0.276 / 0.289 m |
| 2P degraded + reconnect | 1440×900 | 3 / 0 | 59.88 | 0.250 / 0.244 m |

Every run completed all three rounds, shrink, eliminations and reset/result flow,
returned to the Ready lobby and started Rooftop afterward. Chat passed. There
were no browser exceptions, hard corrections, prediction overflows or camera
pose/FOV drift. Snowball frame-callback JS averaged 0.35–0.50 ms; degraded p95
was 1.8 ms. Normal input sending peaked at 61 per rolling second, far below 300.

The TCP harness used **150 ms base RTT + independent 0–40 ms jitter each way**,
FIFO delivery, and one forced reset of both connections. Observed RTT averaged
about 200 ms. Both clients compared identically on **2,204 common authoritative
snapshots**, including poses, velocities, phase, radius, alive set and score.
Aggregate traffic for both clients, including matchmaking/results/reconnect and
the subsequent Rooftop startup, averaged 2,301 B/s up and 18,733 B/s down.

The degraded headed head-on reached **6.150 / 6.173 m/s** before contact. Two
snapshots later the balls were at approximately `(0,0.965,1.360)` and
`(0,0.965,-1.357)`, both alive, with the same authoritative result on both clients.
The direct head-on reached 5.871 / 5.827 m/s. The direct match's first round also
recorded an edge elimination; both clients awarded the same round win.

Separate deterministic prediction tests inject independent **2% input/snapshot
loss at 150 ms RTT + 0–40 ms jitter**, and **5% at 250 ms + 0–60 ms**. They restore
exact post-impact velocities and identical scores without hard corrections or
history overflows. This simulated message loss is distinct from the headed TCP
proxy (TCP does not expose packet loss as missing application messages).

Simulation tick avg/p95/p99: 2P 0.026/0.035/0.058 ms; 3P
0.026/0.038/0.080 ms. The observed 3-client room loop, including room work,
averaged 0.284 ms, maximum 0.939 ms; snapshot/send averaged 0.480 ms. All measured
invalid-body counts were zero. This is substantially cheaper than the previous
Bowling physical-match benchmark. Long transport outages can still freeze and
catch up; prediction cannot make a disconnected client authoritative.

## Existing-mode preservation

All seven existing modes also passed startup, rendering and keyboard-input
smokes in three real headed Chrome clients on protocol 11, with no browser
exceptions. Rooftop, Bowling and Prop Hunt camera implementations are unchanged.

All seven existing modes match the frozen baseline over 1,800 deterministic input
steps (excluding only the intentional snapshot protocol field):

| Mode | SHA-256 |
| --- | --- |
| Rooftop | `41754640feb21d39b62c0e8f89f2911a1ffaf2e52263c2d5a4837be3531a2e23` |
| Barn | `9300b3a0c119bf59164a1cec09a667f3389e693ad71464588f0d88c820f8bbe3` |
| Layer | `6f93909d2c94d1bfef0fcca49262b76d2ba868526983dc02a4ec8b6a6d052148` |
| Color | `a293282e4489c3cc5307892c0533e31dd7bccf98cd2d028e9d78fc5f339c5914` |
| Bomb | `8a412fd108d58f73cbb622c977b8ce90393dfd49e80e52f0c0906f375c602938` |
| Prop Hunt | `598a2cceef36a70ba9aea879679bc704fd761d685b9bbf0169a3bc24f075d44c` |
| Human Bowling | `c4954846b192657ea05f9bd53a83e3454eed1057fc20c0427896912d497b2ceb` |

Raw baseline/final hashes, browser traces/screenshots, network conditions,
collision measurements and test/build logs are outside the repository at
`/private/tmp/snowball-online-20261004`. Production deployment verification is
reported separately after the single combined frontend/server revision is pushed.
