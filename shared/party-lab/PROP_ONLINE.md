# Online Saklambaç — protocol 9

Saklambaç is the sixth real Party Lab mode. This change includes the approved local game
and its online integration. The 22 × 22 m Orman Kampı, routes, generated stair, semantic
scene recipes, local bots, camera tuning and local defaults are preserved.

## Room rules and roles

The compact picker contains Çatı Kavgası, Ambar Çatışması, Katman Kaosu, Renk Kaosu,
Bomba Sende, Saklambaç and Karışık. Under Saklambaç the host gets two small selectors:
Yakınlık ipucu (Açık/Kapalı, default Açık) and Arayan mermisi (5/10/15, default 15).
Guests see the stored settings as a read-only line. Independent field intents prevent a
quick second selection from restoring an older value of the other setting.

Only the connected host, while the room is waiting, can change settings. Unknown keys and
invalid values are rejected. Every actual change clears **all** Ready confirmations. Settings
are room schema state, survive mode changes/reconnect and are copied into the round by the
server. Gameplay input cannot supply ammo or proximity settings.

Prop Hunt requires all three distinct seats connected and Ready. With two players it stays in
the lobby and shows **Saklambaç için 3 oyuncu gerekli.** This also applies when Mixed's actual
next mode is Prop Hunt. Mixed uses one randomized six-mode bag, no repeats within a bag and
no identical modes across its boundary; the server publishes the actual next mode. It uses
the stored Prop Hunt settings without another prompt.

The room owns `PropRotation`: seat 0 → 1 → 2 → 0. The other two seats hide. Rotation and the
layout index advance once when the introduction finishes and hiding begins. A cancelled
introduction consumes neither. Other modes do not advance this cursor. Reconnection reserves
the same seat and does not assign a new role. A permanent departure forfeits that player's
current role; a newcomer cannot join the ongoing round and subsequently inherits the free
seat's place in the rotation. This is seat fairness, not a lifetime account history. A new
room starts at seat 0. No two seats can become seeker in the same round.

## Simulation and authority

`PropRoundSimulation` wraps the approved shared `PropHuntGame`, using PartyRoom's fixed
60 Hz scheduler, input mailboxes and lifetime round/tick/event counters. Snapshots are 20 Hz.
The online wrapper handles lobby transitions, role rotation, disconnect/forfeit and rewind.
The game runs 3 s introduction, 15 s hiding, 75 s search and 5 s result. After the result the
room returns to the lobby and needs fresh Ready confirmations.

The seeker wins immediately on finding the second hider. If search time expires or ammo
reaches zero while any hider survives, hiders win. The final shot is resolved **before** the
zero-ammo result. The seeker sees **Mermin bitti!** Ammo starts at the authoritative 5/10/15;
no reload or pickups. A permanent seeker departure awards hiders; the final hider departure
awards the seeker. Temporary network loss only clears input and preserves gameplay state.

E sends an interaction edge, without a target, family, position or success claim. The server
chooses the current layout's nearest valid decoy, checking living hider role, 1.8 m footprint
range, 1.2 m vertical tolerance, LOS, grounded state, 0.8 s cooldown and free collider volume.
E while disguised checks a valid standing exit, including the approved limited fit search.
Kinematic disguise colliders use the original family proxy, 2.3 m/s movement, no sprint or
jump, floor alignment and the approved slope/stair controller. Dynamic prop physics is not used.

The client restores the authoritative state and replays at most 30 unacknowledged **movement**
inputs. It never predicts a successful transform, shot, find, whistle, proximity pulse or result.
Small position corrections ease out as a bounded visual offset (100 ms exponential time
constant); offsets over 1 m and role/body transitions snap. These offsets never affect physics.
Other players use the existing bounded snapshot playout clock. The shoulder and 70° FPS
cameras remain presentation-only; V switches the seeker, hiders stay third person.

## Shots and rewind

The server retains ten 60 Hz pose frames and permits at most **150 ms** (nine ticks) of
rewind, deliberately less than Barn's 250 ms. `viewTick` is a bounded request to inspect
server-known history, never a target or hit claim. Old requests clamp to the cap; future
requests use the current world. Disguised shapes and undisguised body parts are historical;
current walls, glass, furniture and ordinary decoys still block both rays. Elimination and
family changes invalidate historical target shapes.

The camera selects an aim point through the approved bounded eye offset. The real ray leaves
the server's current torso toward that point. FPS cannot shoot over cover that blocks the
body. A decoy/environment hit spends one shot; a live hider hit finds that player. Mailbox
sequence/round checks and press consumption make duplicate or delayed packets idempotent.

## Layout and wire

The server creates a room-lifetime 32-bit seed and advances only the Prop Hunt layout index.
The approved deterministic scene generator still produces 60–68 decoys (about 64), 15–18
active families, at least two real decoys per active family, and roughly half-layout variation.
Fixed landmarks and scene semantics are unchanged. No client independently randomizes props.

A snapshot carries seed, layout index, layout hash and the active-family bitmask. Clients run
the shared generator and verify both hash and family mask. Reconstruction without a previous
snapshot recomputes the deterministic preceding sequence; an existing client reuses its prior
layout. Sixty-plus prop objects are **not** sent every snapshot. One authoritative snapshot
is sufficient to reconstruct the current map and game, including after a mode switch.

Prop Hunt input is exactly **41 payload bytes**, little-endian:

| Bytes | Contents |
| --- | --- |
| 0–7 | uint32 sequence and round |
| 8–39 | eight float32: move X/Z, aim yaw/pitch, bounded eye X/Y/Z, viewed server tick |
| 40 | jump, sprint, shoot, interact, whistle bits; unknown bits rejected |

The measured Colyseus input message is 50 bytes including message type/name and MessagePack
binary prefix; a masked WebSocket frame adds six bytes (56 total, excluding TCP/IP/TLS).
There is no target ID, family selection, hit/disguise/proximity/winner claim or client position.

Snapshots include the common body transforms plus phase/tick, seeker seat (other seats hide),
ammo and settings, alive mask/found ticks, disguise family/source-instance/XYZ/yaw/velocity/
grounded state, transform and manual-whistle cooldowns, shot cooldown, and outcome/reason.
Result survivor records are empty before results. Recipient-only prediction adds body
velocities and movement-controller state. Hidden render transforms are needed to draw the
props; this is not an anti-cheat visibility-culling system. Proximity events never add target
information to that state.

## Whistles, proximity and presentation

Automatic whistles occur at 60/45/30/15 search seconds remaining; living hiders are staggered
by 36 ticks (0.6 s). Found hiders are excluded. A living hider's Q/manual-whistle intent is
accepted only during search, once per eight seconds. It has an independent cooldown and
cannot change disguise, ammo, movement or the automatic schedule. Accepted whistle events
contain only event/round/tick and a half-metre-rounded audio origin, no player or disguise ID.
All clients receive the same event once. Past transient sounds are not replayed on reconnect.

When proximity is off, no server pulse, text or heartbeat exists. When enabled, the server
checks living hiders at 5.5 m, 0.9 s dwell, with the approved major-wall/glass/roof/floor/loft/
shed filtering. Doorways can connect spaces; furniture does not obstruct the clue. It sends
only `{eid, round, tick, type: "near"}` to the seeker. The client presents **Yakınlarda biri var...**
and a centred heartbeat without calculating proximity from hider positions.

After one pulse the latch rearms only beyond 6.5 m of **all** living hiders for 1.25 s.
Losing LOS alone does not rearm it. This latch lives on the server through reconnection;
no spatial proximity state needs to be sent to clients.

Only the server's result survivor list enables the five-second gold through-wall reveal,
names/disguise labels and automatic camera cycling (cancelled by camera movement).
A found hider follows the nearest surviving teammate, falling back to the seeker; Q/E cycle
watchable players. Q is a whistle only while a living hider. Normal online UI has no debug
panel. `?partyDebug=1` enables the existing Esc-menu debug toggle; `?propDebug=1` stays local.

## Validation and preservation

Validation was performed locally, with no push or deployment. Browser harnesses, screenshots,
profiles, raw assets, backup and timing logs stay outside the repository under `/private/tmp`.
Three **separate headed Chrome processes**, 1280 × 800, run the real lobby/keyboard/camera/
rendering and WebSocket stack. External test fixtures place players and fast-forward phases
for specific cases; no fixture endpoint or browser automation is shipped in the server.

The complete frontend/edge suite passes **510/510**. The complete server suite passes
**49/49**. Coverage includes the approved local mechanics/geometry plus strict input/settings,
three-seat gate, role rotation, deterministic reconstruction, all ammo choices and final-shot
ordering, historical shots/cap/occlusion, one-state prediction restore, whistles/privacy,
proximity, reconnect/leave, six-mode Mixed, chat and all five prior modes.

Root TypeScript, server typecheck/build, frontend production build and `git diff --check` are
required final gates. `/health` on the local production server returns protocol 9.

Five existing online simulations were compared against `90ea804` over 1,800 seeded input
steps, hashing snapshots (excluding the intentional version change) and events. All matched:

| Simulation | SHA-256 |
| --- | --- |
| Rooftop | `8d89030cf2d5752364f82321950b42a6aa1100986c329955a5969c1876661de6` |
| Barn | `88562a77268129b7f9601a990678cd87037fe3e5e51d7b7d8e637c345de5fc94` |
| Layer | `ef1303cc5b33cf14a3e6fe7211d2ebbdc50ae0dc8a6f827d088530afe625a069` |
| Color | `818900429dd23650e989ef4545e55a70257bb90938a4e3453e048385c9fefea6` |
| Bomb | `5be7de86b5f30dd9b1db691edf2463fc018fe13196fa63e7fb8306bdf05bf8d2` |

The approved local Prop Hunt was separately compared with the pre-edit external backup over
12,000 input steps including multiple rounds and whistles. Both produced
`0c359d893dbb349c394cbfb640b3dbd299ac4791b7828a1004f504e84b076ed0`.
The approved map, scene recipes, generated stair, local camera, local presentation and bots
are byte-identical to that backup. Shared game changes are opt-in online authority hooks,
recipient prediction and source-instance bookkeeping; local defaults are unchanged.

## Asset and chunk audit

The unused imported `Stair` was removed from the deterministic kit builder. All remaining
named nodes' geometry/accessor bytes were compared with the approved GLB and are unchanged.
The generated gameplay stair is unchanged. Two rebuilds agreed on SHA-256
`737a74dd38117e261306dc8cd263153f97eb90958bb92947838d8056b2a79412`.
The kit decreased from 1,659,612 to **1,634,564 bytes**, with no quantization. Raw CC0 packs
remain outside the repository; only the generated GLB, builder and credits are committed.

The kit is fetched lazily with the Prop Hunt scene; browser request inspection confirms no
kit request in the lobby. Compared with the pre-feature HEAD production build, the initial
PartyLabRoot chunk grows from 391.96 to about 399.06 kB (gzip 128.10 → 130.27 kB, +2.17 kB).
The online presentation is separately lazy-loaded (about 34 kB / 13 kB gzip) and shares its
larger scene/game chunk with local Prop Hunt. Existing large-chunk Vite warnings remain.

## Browser, network and performance results

All **52/52** checks passed in the final three-headed-Chrome run, with zero browser errors.
This included the host/guest settings flow, two-player gate, Ready invalidation, all ammo
choices, 1:2 roles, hiding, real E transform/movement/exit, shoulder/FPS, decoy and valid hider
shots, zero-ammo result, last-shot seeker win, both whistle schedules, cooldown, enabled/
disabled proximity, wall and loft rejection, hysteresis, survivor reveal, spectator Q/E,
rotation across successive rounds and simultaneous seeker/disguised-hider reconnect.

The existing TCP proxy exercised RTT 50, 100 and 150 ms; 100 ± 40 ms jitter; stalls of
300/500/800 ms; and a connection reset. Its unsigned per-direction jitter is configured as
base RTT 60 + 0–40 ms per direction for the 100 ± 40 ms case. Every condition preserved
roles, layout, disguise and consistent snapshot clocks. Each E edge transformed once; each
shot consumed one ammo. Whistle event IDs agreed across clients; near events contained no
identity or spatial fields and went only to the seeker. Stalls caused no disconnects. Reset
rejoined the same three session IDs/seats with the same ammo, roles and disguises.

Measured locally on this workstation; these are samples, not a cross-device FPS guarantee:

| Measurement | Result |
| --- | --- |
| Isolated 3-player simulation, 1,800 steps | 0.0593 ms average / 0.0900 ms p99 |
| Snapshot build + encode, isolated | 0.0176 ms average / 0.0678 ms p99 |
| Live room step (includes room work) | 0.792 ms average / 2.905 ms maximum |
| Live snapshot build/send | 0.286 ms average / 2.277 ms maximum |
| Live server CPU | 6.71% of one core, one room |
| Event loop delay | 2.509 ms p99 / 3.517 ms maximum |
| Three Chrome clients, sustained sample | each ≈60 FPS |
| Scene JS callback | 0.803–0.857 ms average, 1.6 ms sampled maximum |
| Recipient prediction step | 0.283–0.330 ms average, 0.6 ms sampled maximum |
| Draw calls / triangles in sampled views | 18–19 / 163,688–163,768 |
| Input | 41 payload / 50 Colyseus / 56 masked WebSocket bytes |
| Actual snapshot Colyseus message | 1,386–1,549 bytes, ≈1,452 average |
| Proxy traffic per client (three-client total divided by three) | 3.28 KiB/s up / 29.09 KiB/s down |

Traffic measurement includes WebSocket framing, state patches, pings and presentation events;
it excludes TCP/IP/TLS headers. Snapshot sizes vary with disguise and result state. The JS
measurement covers the scene callback, not all browser JavaScript or GPU time. Performance
samples were collected with the optional Esc debug panel open; it is absent in normal play.

## Commit file inventory

The complete local + online feature contains 71 files (39 new, 32 modified):

| Status | Path |
| --- | --- |
| Modified | `servers/party-lab/src/PartyRoom.ts` |
| Modified | `servers/party-lab/src/state.ts` |
| Modified | `servers/party-lab/tests/barnRoom.test.ts` |
| Modified | `servers/party-lab/tests/bombRoom.test.ts` |
| Modified | `servers/party-lab/tests/colorRoom.test.ts` |
| Modified | `shared/party-lab/NETWORK.md` |
| Modified | `shared/party-lab/ONLINE.md` |
| Modified | `shared/party-lab/intent.ts` |
| Modified | `shared/party-lab/maps/MAPS.md` |
| Modified | `shared/party-lab/maps/types.ts` |
| Modified | `shared/party-lab/modes.ts` |
| Modified | `shared/party-lab/network/protocol.ts` |
| Modified | `shared/party-lab/simulation/world.ts` |
| Modified | `src/party-lab/PartyLabRoot.tsx` |
| Modified | `src/party-lab/PartyLobby.tsx` |
| Modified | `src/party-lab/audio/AudioManager.ts` |
| Modified | `src/party-lab/network/barnOnline.test.ts` |
| Modified | `src/party-lab/network/bombOnline.test.ts` |
| Modified | `src/party-lab/network/colorOnline.test.ts` |
| Modified | `src/party-lab/network/gameStream.ts` |
| Modified | `src/party-lab/network/layerOnline.test.ts` |
| Modified | `src/party-lab/network/session.ts` |
| Modified | `src/party-lab/network/types.ts` |
| Modified | `src/party-lab/party-lab.css` |
| Modified | `src/party-lab/scene/ArenaChrome.tsx` |
| Modified | `src/party-lab/scene/ArenaScene.tsx` |
| Modified | `src/party-lab/scene/OnlineArena.tsx` |
| Modified | `src/party-lab/scene/arenaMenu.ts` |
| Modified | `src/party-lab/scene/barn.test.ts` |
| Modified | `src/party-lab/scene/bomb.test.ts` |
| Modified | `src/party-lab/scene/bomb/nav.ts` |
| Modified | `src/party-lab/scene/rooftop.test.ts` |
| New | `public/party-lab/maps/prop-hunt/CREDITS.txt` |
| New | `public/party-lab/maps/prop-hunt/prop-hunt-kit.glb` |
| New | `scripts/build-party-lab-prop-hunt-kit.mjs` |
| New | `servers/party-lab/tests/propRoom.test.ts` |
| New | `shared/party-lab/PROP_ONLINE.md` |
| New | `shared/party-lab/maps/propHunt.ts` |
| New | `shared/party-lab/maps/propHuntLayout.ts` |
| New | `shared/party-lab/maps/propHuntProps.ts` |
| New | `shared/party-lab/maps/propHuntScenes.ts` |
| New | `shared/party-lab/propSettings.ts` |
| New | `shared/party-lab/simulation/propRound.ts` |
| New | `shared/party-lab/simulation/prophunt/PROPHUNT.md` |
| New | `shared/party-lab/simulation/prophunt/aim.ts` |
| New | `shared/party-lab/simulation/prophunt/config.ts` |
| New | `shared/party-lab/simulation/prophunt/disguise.ts` |
| New | `shared/party-lab/simulation/prophunt/game.ts` |
| New | `shared/party-lab/simulation/prophunt/proximity.ts` |
| New | `shared/party-lab/simulation/prophunt/round.ts` |
| New | `shared/party-lab/simulation/prophunt/wire.ts` |
| New | `src/party-lab/network/prediction/propRig.ts` |
| New | `src/party-lab/network/propOnline.test.ts` |
| New | `src/party-lab/scene/OnlinePropArena.tsx` |
| New | `src/party-lab/scene/prophunt.test.ts` |
| New | `src/party-lab/scene/prophunt/OnlinePropHud.tsx` |
| New | `src/party-lab/scene/prophunt/OnlinePropView.tsx` |
| New | `src/party-lab/scene/prophunt/PropHuntHud.tsx` |
| New | `src/party-lab/scene/prophunt/PropHuntPlayground.tsx` |
| New | `src/party-lab/scene/prophunt/PropHuntScenery.tsx` |
| New | `src/party-lab/scene/prophunt/arena.ts` |
| New | `src/party-lab/scene/prophunt/bots.ts` |
| New | `src/party-lab/scene/prophunt/controls.ts` |
| New | `src/party-lab/scene/prophunt/game.ts` |
| New | `src/party-lab/scene/prophunt/propCamera.ts` |
| New | `src/party-lab/scene/prophunt/reveal.ts` |
| New | `src/party-lab/scene/prophunt/scenery.ts` |
| New | `src/party-lab/scene/prophunt/visuals.ts` |
| New | `src/party-lab/scene/prophunt/whistle.ts` |
| New | `src/party-lab/scene/prophuntLayout.test.ts` |
| New | `src/party-lab/scene/prophuntSeeker.test.ts` |
