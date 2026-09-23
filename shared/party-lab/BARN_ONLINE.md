# Online Barn Shootout (Phase 2)

Barn Shootout is an online Party Lab mode next to Rooftop Brawl. Rooftop gameplay and the
network hardening in [NETWORK.md](NETWORK.md) are unchanged. The combat rules are in
[simulation/barn/COMBAT.md](simulation/barn/COMBAT.md), and the map in
[maps/MAPS.md](maps/MAPS.md).

## Protocol 5

`NET.version` goes from 4 to 5. The server can now run Barn rounds. A page built for
protocol 4 would render and predict the rooftop against barn poses, and a v4 server
rejects the new input packet. The join-time version check is the only guard against a
stale cached bundle landing in a Barn round. Frontend and server must be deployed
together. `/health` reports `"protocol":5`.

What changed on the wire:

- The lobby state gains `selection`, `mode` and `hostId`.
- Clients send a `mode` message; only the host's is accepted.
- The barn input packet is new.
- Every snapshot carries `mode`. Barn snapshots add a `barn` section, and the
  recipient's prediction state adds a Float64 `barn` block.
- Barn events carry `barn` detail: pellet ends, damage, the killer.

Rooftop packets, snapshots and events are otherwise the same.

## Modes, lobby, Mixed

- `modes.ts` defines `rooftop_brawl`, `barn_shootout`, `mixed` and `MODE_MAP`. Every
  round knows its mode from the server: the lobby state's `mode` and each snapshot's
  `mode`.
- **Host**: the earliest-joined connected player (the creator while present). There was
  no host before. If the host drops or leaves, the next earliest-joined connected player
  becomes host.
- Only the host can change the selection. A non-host gets `MODE_HOST_ONLY`. Any change
  clears every Ready.
- **Mixed**: the first round's mode is random. Once a round reaches play, the next one is
  the other mode. The lobby always shows the actual next mode ("Sıradaki tur").
- The room keeps one simulation. A different mode disposes the old Rapier world and
  builds the new one at round start. Ticks, round epochs, event IDs and snapshot
  sequences come from room-lifetime counters (`simulation/online.ts`), so clients see
  them stay monotonic across swaps.

## Server simulation

`simulation/barnRound.ts` `BarnRoundSimulation` is separate from the rooftop's
`OnlineRoundSimulation`. It builds the barn world, 2–3 active ragdolls, the shared
`BarnCombat`, contact feedback and a pose history. Phases run countdown 3 s → play 150 s
→ results 3.5 s. During the countdown the bodies stand on the start spawns with barn
drives. Physics faults count as deaths.

The server owns HP, alive/dead, weapons, ammo, cadence, spread, hits, obstruction, punch
contact, damage, knockback, traps, pickups, spawns, protection, kills, deaths, timer and
winner. A client only sends intent.

## Input packet (60 Hz)

`seq, round, moveX, moveZ` are world-space and camera-relative, with magnitude ≤ 1.
`jumpPressed, sprintHeld, attackPressed, attackHeld, pickupPressed` carry buttons.
`aimYaw, aimPitch, eyeX/Y/Z` carry the aim. `viewTick` is the server tick of the remote
poses on screen.

Validation uses strict keys and finite numbers. Yaw is normalised exactly as the client
does it, pitch is clamped to ±1.2, and the eye to ±4 m (the simulation bounds it to
1.5 m). Target, damage, hit, kill and HP fields are rejected. The attack edge keeps the
`viewTick` and sequence of the packet that carried it. A rooftop packet in a barn round
is refused, and the reverse too.

Size is 208 B in msgpack, about 12.5 KB/s up per client. The rooftop packet is 78 B.

## Snapshot (20 Hz)

Every snapshot has the common 756-byte pose block. The `barn` section is small integers
only:

- per fighter: flags (alive, present, staggered), HP, weapon, ammo, kills, deaths,
  respawn/protection/trap in deciseconds, and aim pitch in centiradians;
- active pickups `[spot, weapon]`;
- telegraphs `[spot, %]`;
- traps `[rearm ds, sprung ds]`.

Rooftop arrays are empty in barn snapshots.

Measured with the exact Colyseus encoder (msgpackr, no records):

| Item | Size |
| --- | --- |
| Barn `barn` section | 59 B |
| Barn snapshot with the recipient's prediction state | 1,310 B (wire message 1,410–1,411 B) |
| Rooftop snapshot (same method) | 1,179 B |
| Recipient prediction state | 216 B velocities + 176 B barn block (22 × Float64) |

Float64 because a 180° aim flick is resolved by the sign of a tiny facing difference. A
Float32 facing turned the replay the other way: one hard correction at 100 ms + jitter.

## Lag compensation

`simulation/barn/rewind.ts` keeps 24 ticks of every character's nine hit volumes
(position + quaternion), plus hittable flags and a life counter.

To resolve a shot:

1. The `viewTick` must be a tick the client could have seen: no later than the newest
   snapshot sent, and never in the future. An impossible tick resolves against the
   current poses (counted as `rejectedFuture`).
2. Older than 250 ms (15 ticks) is clamped to 250 ms (`clampedOld`).
3. Neighbouring ticks are blended, except across a respawn.
4. Rays are tested analytically against those capsules. Walls, decks, rails and cover
   come from the current Rapier world (`EXCLUDE_DYNAMIC`). Pickups and traps are never
   rewound.
5. A target must be alive both then and now, and protection is checked now.

Punches use current contact.

Cost: record + lookup about 1–9 µs per shot, rays 4.6 µs. Only shots rewind; the world is
never stepped back. At RTT ≳ 135 ms the needed view (RTT + 100 ms interpolation +
≤ 16 ms) passes 250 ms, so it is clamped by a few ticks.

## Local presentation and prediction

**Barn rig.** `network/prediction/barnRig.ts` uses nine bodies and eight joints in the
static barn. It runs the server's own per-fighter functions (`tickFighter`,
`startAttack`, `fighterDrive`), so aim-facing, sprint blend, idle anchor, trap hold,
stagger, arms, punches and the weapon's own ammo, cadence and bloom replay exactly.
`LocalPrediction` keeps its 500 ms / 30-tick window, correction tiers and backpressure,
and picks the rig by mode.

**Firing.** The local shot's muzzle flash, tracer, sound, view kick and HUD ammo show on
the frame after the key. The tracer ends at the drawn crosshair point. Its pellets use
local random spread against the static barn plus remote capsules as drawn; they get a
wall puff but never a body puff.

**Rounds shown once.** Each round is identified by (weapon life, round number). Every
round is presented once. A round that a replay reveals late is presented late. Each
presented round suppresses one server echo of that weapon (count-based dedupe in
`GameStream`). A predicted punch swing is deduplicated by input sequence, as on the
rooftop.

**Server-confirmed.** Damage, hit markers, kills, knockback and death come only from the
server. The shooter's own hits and damage events are released as soon as they arrive,
matching the HUD, which reads the newest snapshot. Everything else plays on the remote
timeline.

**Remote players.** They use the unchanged `SnapshotBuffer` (100 ms, a 0.5–2× follower,
snap only beyond 1 s). There is no barn-specific snapping.

## Other rules online

- **Pickups**: one per player (2 or 3). Contested requests in the same step go to the
  nearer player; an exact tie is random.
- **Kill credit**: a trap or fault death within 3 s of another player's hit goes to that
  player.
- **Respawn**: weighted choice (COMBAT.md), never failing.
- **S3**: moved 4.3 m south on the ring. The body is now reachable from 25 ground spots
  instead of 0.
- **Idle anchor**: drift < 0.01 m in 30 s instead of 0.85–2.2 m. The prediction replays
  it from Float64 anchor state.

## Reconnect and link quality

Same-seat SDK reconnect (15 s grace), degraded/slow states, dead-socket reset, input
coalescing and the flood cap are unchanged. The snapshot restores HP, weapon and ammo,
kills and deaths, and alive/dead, respawn and protection or trap timers. The room reuses
the same `Room` object and handlers.

Tested live, alive/unarmed, armed, dead with a respawn pending, and after kills: one
body, one player, one handler per message.

## Measurements

**Headless, real shared simulation** (`barnOnline.test.ts`, `barnPrediction.test.ts`):

- Lag compensation hits at 100/150/200/223/250 ms rewind with the target sprinting
  0.64–1.61 m away. Unrewound, every one misses.
- The 7→2 HP / 8th-kill sequence, a 10-round magazine and a one-shell shotgun behave
  through the packet → mailbox → simulation path.

Prediction, scripted over 8.5 s (walk, sprint, strafe while aiming, turn in place,
10 SMG rounds, jump). Every run had 0 duplicate shots:

| Link | Max correction | Hard | Largest frame step | Local / server shots |
| --- | --- | --- | --- | --- |
| RTT 0 | 0 m | 0 | 0.109 m | 10 / 10 |
| RTT 50 | 0.004 m | 0 | 0.109 m | 10 / 10 |
| RTT 100 | 0.026 m | 0 | 0.109 m | 10 / 10 |
| RTT 150 | 0.010 m | 0 | 0.109 m | 10 / 10 |
| 100 ± 60 ms | 0.28 m | 0 | 0.158 m | 10 / 10 |
| 150 ± 60 ms | 0.30 m | 0 | 0.136 m | 10 / 10 |
| RTT 70 + 300 ms stall | 0.97 m | 0 | 0.24 m | 10 / 10 |
| RTT 70 + 500 ms stall | window overflow → 1 hard | 1 | — | 10 / 10 |
| RTT 70 + 800 ms stall | window overflow | 2 | — | 10 / 10 |

Stalls past the 500 ms window suspend and restart prediction, the documented rooftop
behaviour.

**Real Chrome, real server, netem proxy** (2 and 3 clients):

- Key → visible own movement: 3–10 ms. Key → own muzzle, tracer and sound: 7–10 ms, at
  every RTT.
- Server shot echo: 17 / 87 / 123 / 160 ms at RTT 0 / 50 / 100 / 150, and 167 ms at
  100 ± 40 ms.
- Confirmed hit marker: 33 / 100 / 167 / 184 ms.
- Rewind: RTT + 100 ms.
- The link stayed "Sunucuya bağlı" for 300 and 500 ms stalls. At 800 ms it showed
  "Bağlantı yavaş" and was never "Yeniden bağlanılıyor". A connection reset reconnected
  in 535–602 ms to the same seat with state restored.

Server and client cost:

| Measure | Result |
| --- | --- |
| Server step (headless, 3 players, 60 s, 442 shots) | avg 0.19 ms, p99 0.39 ms, max 3.2 ms (JIT) |
| Snapshot build + encode, 3 recipients | 0.026 ms |
| Events | 1.3 KB/s |
| Live room loop | 0.6–0.8 ms avg, 3–5 ms max; event-loop p99 2–3 ms |
| Clients (headless Chrome, Metal) | 60 FPS, 27–47 draw calls, JS 0.5–0.9 ms/frame, prediction 0.13–0.29 ms/step |

Bandwidth on the TCP stream (proxy byte counters) is about 29 KB/s down and about
12.5 KB/s up per client.

**Rooftop**: a seeded 40 s run is bit-identical to production `bdb1582` (same sha256).
That covers local rooftop and test maps with bots, and a 3-player online authority run
with punch, grab and lift.

## Remaining before production

- **Only two to three real people over the real Railway link will tell.** None of this
  was measured over that link or on Windows or Safari, and none of it tests feel.
- **Uplink is 2.7× the rooftop's** (208 B/packet). It is fine for 2–3 players, and
  shorter keys or quantisation could halve it.
- **Stalls ≥ 300 ms while moving still end in one correction.** The server's latest-wins
  mailbox cannot apply late input, the same trade-off the rooftop measured. Past 500 ms,
  prediction suspends.
- **At RTT ≳ 135 ms, shots at moving targets resolve up to a few ticks early** because of
  the 250 ms rewind cap.
- **Spawn camera clearance is only static.** All six candidates pass the boom test in
  `barn.test.ts`; it is not recomputed per respawn.
