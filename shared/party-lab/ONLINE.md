# Phase 4B.1 — authoritative local-development online arena

This is the historical Phase 4B.1 checkpoint report. **Current Phase 4B.2 behavior,
rates, protocol additions and validation are documented in [PREDICTION.md](PREDICTION.md).**
Server authority and the round/membership policies below remain in effect.

## Scope and checkpoint

Started from a clean `party-game-prototype` at `999b46a` (Party Lab audio feedback
and custom fall sound). Inspected local controls/audio/physics/rounds, server
Phase 4A room/chat/reconnect, tests and the supplied WAV before editing. No reset,
stash, commit, push, deployment, production hosting, new art/maps/minigames,
accounts, Supabase or unrelated Torble changes. Phase 4B.2 is not implemented.

## Authority and shared rules

`simulation/` contains the existing non-React Rapier, active balance, physical
punch contact/classification, knockout/recovery, grip/escape, lift/throw and round
rules. Local scene modules re-export these implementations; local orchestration
and bots remain browser-local and independent. The online renderer imports only
pure environment/body metadata and never creates an authoritative physics world.
`intent.ts` and `feedback/` have no DOM, Web Audio or React dependencies.

`OnlineRoundSimulation` composes the same physics/combat/contact observer and
round rules without bots. The server alone advances them and assigns slots 0–2.
Each rig retains nine dynamic bodies and eight anatomical joints. The world
allocates 27 bodies/24 joints; a two-person round enables only 18 bodies (the
unused rig is disabled), a three-person round enables all 27. Grips retain the
existing bounded spring forces, up to two independent hands per player; they are
not extra rigid anatomical joints. No combat constants or physics behavior were
retuned. The renderer uses existing colors/spawns and the same arena/camera.

The only dependency added is server `@dimforge/rapier3d-compat@0.20.0`, matching the
unchanged frontend version. Server TypeScript includes shared sources and builds
into `dist/servers/party-lab/src/` plus `dist/shared/party-lab/`; `npm start` follows
that layout. The compiled simulation was smoke-tested, including WASM startup.

## Protocol and rates

- Server: Colyseus `setFixedTimestep` at **60 Hz**, independent of browsers.
- Client input: **30 Hz**, abstract axes, jump/punch edges, grab/lift held flags,
  monotonic sequence and round epoch. No device codes, identity, transforms or
  result claims. The receiving connection selects its own slot.
- Strict finite/type/key validation rejects malformed/spoofed payloads; axes
  clamp to [-1,1], diagonal magnitude to 1. Old sequence/round packets are ignored.
  Edges are consumed once; repeated true states cannot replay them. Transport
  cap is 90 messages/s, 2048-byte payloads, plus a minimum 8 ms accepted-input gap.
- After **300 ms** without fresh input all intent becomes neutral, pending edges
  clear and grips release through normal shared combat. Visibility/focus/settings
  also neutralize input. No offline input queue is replayed on reconnect.
- Schema at **10 Hz** carries roster, stable ID/slot/nickname/color, Ready,
  connection/participation, round phase/number/time/result and existing chat.
- Custom `snapshot` messages at **20 Hz** carry sequence/tick/round, phase/time,
  winner, participant/alive bitmasks, consciousness/meter/grip arrays and per-slot
  input acknowledgements. Body poses are **756 little-endian Float32 bytes**:
  slot order × nine stable body indices × XYZ + quaternion XYZW. No verbose
  per-part object keys or redundant nickname strings at 20 Hz.
- `SnapshotBuffer` retains at most 12 frames, rejects old/malformed snapshots,
  renders **100 ms behind**, lerps XYZ and slerps every quaternion. Local and
  remote rigs both follow authority. No extrapolation, prediction or reconciliation.
  New round/roster resets interpolation; gaps hold the latest available pose.

The sample three-player payload estimate is **942 bytes**, about **18,840 B/s per
client** at 20 Hz, excluding WebSocket/Colyseus framing, Schema and event traffic.
This is an estimate (binary transform bytes plus JSON-sized metadata), not a packet
capture. Input packets are small 30 Hz objects. Acknowledgements/round epochs leave
room for future input replay without giving clients combat authority.

## Ready, rounds and membership

`waiting → countdown → playing → results → waiting`. At least two connected
players and every connected player's Ready flag are required. The creator has no
special authority. Countdown is three seconds and discards gameplay input.
Gameplay lasts at most 60 seconds; last survivor wins, with the existing 350 ms
final-fall grace for near-simultaneous draws. Results last 3.5 seconds, then everyone
must Ready again. HUD and lobby show the server's state.

Reset clears both grips, punch/cooldowns/alternation, stun/KO/recovery/protection,
held input, feedback contact history, body positions/quaternions/linear and angular
velocities. The next round starts conscious at deterministic slot spawns.

Late joins during countdown/play/results spectate and enter only a later Ready
round. Membership is tracked by session ID, not just slot: replacing a departed
player never inherits their active character. Fourth players remain rejected,
including while a reconnect seat is reserved.

Unexpected disconnect immediately neutralizes input, cancels active punches and
releases grips owned by that player. Their body remains vulnerable to physics and
other players for the existing **15-second** detected-disconnect grace. Reconnect
preserves ID/slot; expiry/explicit leave forfeits and disables the body, cleaning
incoming and outgoing grips. Disconnect during countdown cancels it and clears
Ready. A disconnected body can still fall normally; expiry alone is a forfeit,
not a physical fall and does not play the cat cue. Reload/closed tabs do not
persist reconnect credentials; the running SDK handles temporary connection loss.

## Authoritative presentation and audio

Simulation emits existing semantic gameplay events: swing, physical head/body/limb
hit, bumps/floor contact, grab/second hand, escape/break, lift, momentum release,
KO/recovery, jump/landing, physical elimination and countdown/start/winner/draw.
Each gets a room-lifetime monotonically increasing ID plus round/tick and existing
actor/target/world-X/intensity data. Events are batched with snapshots. Clients
cannot broadcast them; hit classification comes from actual server contact.

`GameStream` deduplicates IDs (including reconnect), aligns playback to the rendered
server tick and discards old-round events. Hidden/settings-paused presentation
consumes IDs without a backlog of sound on return. No speculative local swing is
added in this phase. Existing AudioManager still owns synthesis/WAV caching, master,
SFX, mute, panning and voice priorities; settings remain local. UI sounds stay local.
Only authoritative heavy local impacts trigger the existing tiny camera shake,
respecting each client's setting and reduced motion.

`fall-cat.wav` remains byte-for-byte unchanged and the primary `fall` cue. The
existing alive→eliminated transition emits once, regardless of continued falling
or snapshots; a new round can emit a new event. KO and floor contacts never emit
that cue. Failed WAV loading still falls back procedurally, without layering or
late replay. It is served at `/party-lab/audio/fall-cat.wav` and copied unchanged
into the production build.

## Validation and measurements

- **94/94** local/control/audio/ragdoll/combat/round/network tests passed.
- **20/20** server tests passed, including all existing Phase 4A regressions.
- Frontend `npx tsc --noEmit --incremental false`, production build, server
  typecheck and build passed. Vite reports its existing large-chunk warning.
- Real SDK/WebSocket peers test 1/2/3-player Ready gates, countdown input rejection,
  spoof rejection/own-session input, identical snapshots, edge/stale handling,
  late joins/fourth-player rejection, physical fall/winner/reset/event uniqueness,
  live-grip disconnect, reconnect, grace expiry, countdown cancellation and
  replacement-session isolation and automatic Ready reevaluation when an unready
  player departs. Pure tests cover snapshot ordering, deduplication,
  hidden/settings safety and LAN origin/endpoint behavior.
- The authoritative simulation tests exercise real contact/KO/recovery, two hands
  on the same opponent, lift, bounded release momentum, rig counts/finite poses and
  reset. Existing unchanged shared-rule tests cover head/body/limb differences,
  resistance, escape, vulnerable lift advantage, bot behavior and round draws.
- A 1,800-step scripted three-player run averaged **0.13–0.14 ms/step** including test
  assertions, **0.010 ms** snapshot packing, 199 feedback events over 30 simulated
  seconds (~6.6/s). It retained 27 bodies/24 joints, with zero invalid bodies.
  Active grip count varies 0–6; a dedicated acquisition test confirms two hands.
  This is a local microbenchmark, not sustained load/CPU-utilization profiling.

Three independent browser contexts (Safari, Chrome, Chrome Incognito on this Mac)
joined one room using LAN and loopback URLs. Roster/chat/Ready/countdown and online
arena entry were verified. Chrome showed the three colored articulated players;
Safari F/Space input was exercised. All returned to the lobby after the round with
Ready cleared and chat retained. Online HUD showed ~60 FPS and 0.06–0.09 ms/frame
for JS interpolation/transform preparation (not GPU render time). No Windows
machine was available. Automated server tests supply the reliable coverage for
sustained grab/lift/throw, KO, escape, elimination, reconnect and fourth admission;
native browser automation did not reproduce that entire combat checklist. Actual
speaker output, multi-computer latency, sustained controls and subjective smoothness
still require hands-on testing. Chrome local reference mode rendered bots,
eliminations, winner and subsequent rounds at ~60 FPS.

A later Safari local-mode check produced a blank canvas while HUD/physics kept
running. Its inspector showed repeated WebGL context lost/restored messages and
`shaderSource` receiving an invalid WebGLShader. A canvas sizing experiment did
not resolve it and was removed. A separate copy of the original checkpoint was
prepared under `/tmp` without touching the repository, but Safari diagnostic
automation timed out before comparison completed. It is not established whether
this is a pre-existing WebKit/GPU issue or a regression. Safari rendering remains
an unresolved verification issue; use Chrome for the first MacBook/Windows LAN
test. No physics or graphics quality was reduced to conceal it.

Simulated fixed RTT (not browser network throttling) with the real shared simulation:

| RTT | Punch accepted | Swing presented | Movement visible (>0.1 world unit) |
| --- | --- | --- | --- |
| 0 ms | 0 ms | 100 ms | 183 ms |
| 50 ms | 33 ms | 167 ms | 250 ms |
| 100 ms | 50 ms | 200 ms | 283 ms |

All timings are after input; movement includes existing physical acceleration and
100 ms interpolation. Results remained authoritative, and swing fired once.
Variable jitter/loss and subjective grab/ragdoll feel were not measured. Phase
4B.2 is recommended for local locomotion/jump prediction and reconciliation,
plus optional immediate harmless swing audio; keep contacts, KO, grips, lift/throw,
elimination and round results authoritative. No Phase 4B.2 work is included.

## Running on two computers

See [server README](../../servers/party-lab/README.md) for exact commands, LAN URLs,
overrides, origin policy and troubleshooting. The development page hostname
selects the game server hostname; there is no hardcoded loopback for LAN clients.

## File inventory

Created:

- `shared/party-lab/intent.ts`, `network/protocol.ts`, `ONLINE.md`.
- `shared/party-lab/feedback/{events,policy,sfx}.ts`.
- `shared/party-lab/simulation/{physics,environment,players,combat,combatConfig,feedback,roundLogic,onlineRound}.ts`.
- `shared/party-lab/simulation/ragdoll/{character,config,controller,math}.ts`.
- `shared/party-lab/simulation/combat/{grab,lift,punch,knockout}.ts`.
- `src/party-lab/network/{endpoint,gameStream,network.test,latency.test}.ts`.
- `src/party-lab/scene/OnlineArena.tsx`.
- `servers/party-lab/src/origin.ts`, `tests/{gameplay,simulation}.test.ts`.

Modified:

- Root `.env.party-lab.example` (Party Lab only).
- `servers/party-lab/{.env.example,README.md,package.json,package-lock.json,tsconfig.json,tsconfig.test.json}` and `src/{PartyRoom,index,server,state}.ts`.
- `src/party-lab/{PartyLabRoot,PartyLobby,ControlsSettings}.tsx`, `party-lab.css`.
- `src/party-lab/network/{client,session,types}.ts`.
- `src/party-lab/audio/{events,policy,sfx}.ts` compatibility exports, `feel.ts`, `AUDIO.md`.
- `src/party-lab/input/types.ts` compatibility export, `CONTROLS.md`.
- `src/party-lab/scene/Arena.tsx`, `RAGDOLL.md`; compatibility exports in
  `{physics,players,combat,combatConfig,feedback,roundLogic}.ts`,
  `ragdoll/{character,config,controller,math}.ts`, `combat/{grab,lift,punch,knockout}.ts`.

No root package versions, App.tsx/App.css, Torble games or fall-cat WAV content changed.
