# Phase 4B.2 — local articulated prediction and reconciliation

## Scope and checkpoint

Started from clean `party-game-prototype` at `1ec6e17` (working Phase 4B.1).
Inspected Git status/diff, packages, shared simulation, online rendering/input,
server mailbox/room/tests, and ONLINE/RAGDOLL/CONTROLS/AUDIO before editing.
No packages or lockfiles changed. No maps, art, combat tuning, account systems,
network authority changes, deployment, commit or push. The local bot arena remains
independent. `public/party-lab/audio/fall-cat.wav` is unchanged.

## Prediction and authority

`network/prediction/rig.ts` creates one isolated Rapier world with the same static
arena and **nine dynamic bodies/eight anatomical joints**. It uses shared
`control()`, grounded checks, jump cooldown, balance, facing, gait, speed caps and
physical punch arm drive. `world.ts` and `punchArmDrive()` were extracted without
changing their constants or behavior. There is no fake capsule and no client
`CombatSimulation`, grip manager, elimination detector or round authority.

Normal conscious locomotion, facing, grounded jump and alternating punch arm
motion respond locally. The server still decides every real transform, collision,
hit, impulse, KO, grip, lift/throw, fall and result. Clients still send only the
existing validated abstract input packet; replay durations never travel to the
server. A client's connection still selects its own slot.

No remote collision proxies are simulated. The prediction world collides with
the static arena only; other players remain rendered from server snapshots.
Temporary apparent overlap is possible before server collision corrections arrive.
This avoids inventing remote combat or speculative cross-ragdoll constraints.

## Acknowledgements, history and replay

Wire version is now **2**; frontend and server must be updated together.
Snapshots retain common 756-byte Float32 body poses and add a recipient-only
`prediction` section: slot, **216 Float32 velocity bytes** (nine linear/angular
XYZ pairs), and nine controller values (facing, gait, jump cooldown, next hand,
alternation cooldown, each punch's age/cooldown). Remote velocity state is not
duplicated. The snapshot's per-slot `ack` means latest sequence consumed by the
server tick, not merely received. Round-scoped ACKs start at -1.

The server mailbox retains edge actions until the next tick, records the original
punch-edge sequence even if a later held-state packet arrives first, and consumes
each edge once. Ordered packets arriving together after jitter are accepted;
the former 8 ms arrival-gap filter is removed. Strict validation, sequence/round
rejection, the 90 messages/s transport limit and 300 ms stale-input safety remain.

Each pending record stores the sent abstract packet, local tick duration and send
time. Acknowledged sequences are removed; remaining records replay from restored
authority at 60 Hz. Edges apply only on the first tick of their record. Duplicate
sequences cannot advance the rig, and replay emits no audio. Restoring velocities,
controller cooldowns and punch state before replay prevents cumulative edge effects.

History is bounded by 48 records **and 30 replay ticks (500 ms)**. Overflow or
snapshots older than 500 ms suspend prediction rather than extending uncertainty.
(Originally 18 ticks / 300 ms; widened after jitter measurements — see
[NETWORK.md](NETWORK.md).)
Disconnect, settings, hidden tabs and round changes clear input history and visual
correction. Reconnect requires a fresh authoritative snapshot and does not replay
old commands. Round reset also clears the local ACK and restores server spawn state.
World disposal is idempotent and React cleanup frees its bodies/joints.

## Reconciliation and special states

Every fresh snapshot restores all nine transforms, linear/angular velocities and
controller state before replay. Error severity uses the larger pelvis/torso
position error, with additional whole-rig displacement and pelvis angle guards.
Small corrections are one coherent rigid translation/rotation applied only to
rendered poses, preserving anatomical geometry. No corrective force is applied
to physics. The remaining visual offset eases to exactly zero over the tier's time.
Tiny and small offsets use a cubic that starts at the offset's current velocity: the
everyday ones come from the server using an input one tick earlier or later (~77 mm at
walking speed, then smaller ones on the next snapshots), and a new one continues the
motion of the one it replaces. The earlier quadratic ease moved at full correction
speed on its first frame (a 77 mm correction took 26% off that frame's step) and did
so again on each following snapshot. Medium offsets (stall recovery) keep the
quadratic, which converges faster and keeps later errors under the hard limit.

The everyday blend takes 300 ms (2026-09-24; it was 60 ms tiny / 120 ms small). While
walking, nearly every non-zero reconciliation is exactly one tick (77 mm walking, 107 mm
sprinting) and most are not real: when inputs reach the server right at its tick
boundary, the acknowledgement alternates between two inputs while the server has run the
same ticks, so one snapshot reads a tick ahead and a following one a tick behind (the
sign follows whether the newest input was already acknowledged). Headed Chrome, walking:
0–8 a second on localhost (it depends on the drifting send/tick phase), 3–9 a second at
70 ms RTT ±10 ms; every one exactly ±1 tick and followed by one of the other sign. Replay
itself is exact: all other snapshots correct 0 mm. Over 120 ms these moved the body ±20%
of walking speed in ~10 Hz surges, and the Barn chase camera, which follows the drawn
pelvis, moved the whole view with it. Over 300 ms opposite flips cancel and a lasting
one-tick shift changes the walk by at most ~8%. Measured per-frame step unevenness (RMS):
Barn walk/sprint/strafe/turn on localhost, pelvis 7.8–8.7% → 4.6–5.0% and camera
6.1–6.8% → 3.6–4.9%, the same as an open-loop run that never shows a correction (4.2–4.4%,
3.8–4.5%); at 70 ms RTT, Barn and Rooftop pelvis 7.3–11.2% → 2.0–5.2%. Input response,
hard corrections and both cameras are unchanged; the drawn body sits up to one tick from
the newest prediction a little longer.

| Error tier | Render correction |
| --- | --- |
| Position/angle/limb errors all below 0.0001 | None |
| Root error ≤0.015 m | 300 ms blend |
| Root error ≤0.15 m | 300 ms blend |
| Root error ≤1 m | 180 ms blend |
| Root >1 m, any part >1.25 m, pelvis angle >90°, nonfinite error | Immediate correction; no visual offset |

The physics rig is restored immediately in every tier; smoothing never leaves a
permanent physics offset. Severe divergence shows the restored-and-replayed rig
immediately. Invalid snapshot data or a nonfinite/stretched predicted rig disables
prediction and uses the authoritative renderer until a fresh valid restore.
Linear/angular caps remain 18 m/s and 20 rad/s.

Any daze, KO, recovery, incoming/outgoing grip, locally held Grab or Lift,
elimination, non-playing phase or disconnected/paused presentation disables
locomotion prediction. These states use the existing authoritative interpolation.
Movement, free-hand punches and escape intents still reach the server. Switching
to constrained presentation can visibly correct the pose; stable grips take
priority. Grab reaching and punch presentation during these conservative states
remain server-driven, with no speculative attachment or lift.

## Rates, camera and audio

| Rate | Phase 4B.1 | Phase 4B.2 |
| --- | --- | --- |
| Server physics | 60 Hz | 60 Hz |
| Input target | 30 Hz | 60 Hz |
| Snapshots | 20 Hz | 20 Hz |
| Remote interpolation buffer | 100 ms | 100 ms |

The browser frame loop accumulates fixed ticks, sends at most one packet per
frame, and predicts at most three ticks per frame. At 30 FPS it sends approximately
30 packets/s with two local ticks per record. A >250 ms frame stall clears intent
instead of creating a catch-up burst. Rendering FPS never controls server physics.

Presentation (2026-09-24; `scene/frameClock.ts`, `LocalPrediction.pose(dt, alpha)`):

- The local body is drawn between the tick before the newest predicted tick and the
  newest, `alpha` = the accumulator's leftover in ticks, as the local test arena always
  did. Drawing the newest tick alone gave frames with no step followed by frames with
  two whenever frame timing sat near a tick boundary: 45% of frames on a steady 60 Hz
  display (0/1/2 ticks = 74/178/75), a 30 FPS look, and above 60 Hz the body only
  moved on ~60 of every 360 frames.
- Frames advance by a smoothed step (mean of the last 8 frame intervals). In headed
  Chrome on macOS the times a page can read ran 15–19 ms apart on a 60 Hz panel with
  no dropped frame; moving by them stepped everything ±12% unevenly. Remote playback is
  sampled on the same clock. The debug overlay still reports raw frame times.
- The accumulator restarts at half a tick (round start, Esc menu closed, tab back), not
  0, so a steady display runs exactly one tick and one input per frame. A 2-tick input
  can be acknowledged when the server has used it for one tick, which cost a one-tick
  correction each time.

Measured (headed Chrome, M2, 60 Hz, one client, walking): local-body frame-to-frame jerk
5.6–6.9% → 1.1–1.6% mean (p95 18–50% → 2.9–4.4%), chase/overview camera 8.5–9.0% → 0.8–1.5%,
remote bodies ~10% → 3.1–3.4%; 0 frames without a step or with a double step.

Camera follow uses the presented local pelvis, including its prediction and
correction, with independent 120 ms exponential smoothing. Horizontal follow is
10% of root X/Z, capped at ±0.65 m; vertical follow is capped at 0.15 m. The original
overview remains readable. Reduced-motion preference disables this follow.
Existing tiny impact shake remains server-event-only and respects local settings.

Immediate local `punchSwing` is the only speculative gameplay sound. A successful
local playback is marked by round/slot/input sequence; the exact server swing echo
is suppressed. Room-lifetime semantic event ID deduplication remains intact.
Hits, head/body/limb classification, KO/recovery, grabs/lift/throw, elimination,
countdown and results remain authoritative. Prediction never triggers the cat WAV,
hit feedback or camera shake; replay is silent. Local audio settings are unchanged.

## Measurements

Deterministic transport simulation at 60 FPS, shared Rapier, 20 Hz snapshots,
fixed symmetric RTT, no packet loss. Input starts between ticks. Visible movement
means >0.002 m displacement from the last pre-input pose. These are simulated
latencies, not a high-speed camera or throttled-browser measurement. The older
ONLINE.md table used a different (>0.1 m) threshold and is not directly comparable.

| RTT | 4B.1-style 30 Hz input + interpolated local pose | 30 Hz predicted | Chosen 60 Hz predicted | Server response at 60 Hz |
| --- | --- | --- | --- | --- |
| 0 ms | 110 ms | 26 ms | 10 ms | 10 ms |
| 50 ms | 193 ms | 26 ms | 10 ms | 43 ms |
| 100 ms | 226 ms | 26 ms | 10 ms | 60 ms |
| 150 ms | 293 ms | 26 ms | 10 ms | 93 ms |

Predicted jump starts on the sampled prediction tick at every RTT. This does not
mean zero physical key-to-display latency; an actual input waits for the next
frame. 60 Hz removes up to one 16.7 ms send/sample interval and reduced measured
replay mismatch versus 30 Hz. Estimated JSON input payload rises from **3,453 to
6,933 B/s/client**, excluding transport framing.

At chosen 60 Hz, the four-second locomotion/jump/punch runs measured:

| RTT | Mean / maximum root correction error | Hard corrections | Peak pending records | Mean prediction step / reconciliation |
| --- | --- | --- | --- | --- |
| 0 ms | 0.00125 / 0.00266 m | 0 | 2 | 0.067 / 0.044 ms |
| 50 ms | 0.00189 / 0.00605 m | 0 | 6 | 0.055 / 0.190 ms |
| 100 ms | 0.00196 / 0.00371 m | 0 | 8 | 0.049 / 0.265 ms |
| 150 ms | 0.00210 / 0.00815 m | 0 | 12 | 0.042 / 0.397 ms |

There were 79–80 tiny corrections per run (roughly snapshot frequency). CPU figures
are local Node microbenchmarks and vary with JIT/load. Reconciliation includes
restore and replay. With ordered 0–80 ms delivery jitter, a 75 ms remote buffer held
its newest pose on 72/539 measured frames; 100 ms held on 0/539. Retain 100 ms and
20 Hz snapshots; no increased snapshot rate was needed.

The three-player server benchmark (1,800 steps) measured **0.273 ms/step** including
assertions and snapshot work, **0.024 ms** snapshot packing including three
personalized state sections, 27 dynamic bodies/24 joints and zero invalid bodies.
It emitted 199 events over 30 simulated seconds (~6.6/s); active grips vary 0–6,
with two-hand acquisition covered separately. A sampled recipient snapshot was
approximately **1,286 bytes / 25,720 B/s at 20 Hz**, versus ~942 / 18,840 in 4B.1.
These estimates combine binary bytes and JSON-sized metadata, not wire captures;
WebSocket/Colyseus framing, Schema, events and string lengths add overhead.

## Validation and browser checks

- **107/107** local/input/control/audio/ragdoll/combat/round/network tests passed.
- **20/20** server regressions passed, including real SDK/WebSocket clients,
  Ready, room/chat, own-slot authority, spoof rejection, reconnect/expiry,
  grips, physical contacts/KO/recovery, reset and exactly-once elimination.
- Added ACK/history/replay, duplicate edges, accepted/rejected jump, correction
  tiers/convergence/whole-rig safety, actual server collision convergence,
  actual grip and KO prediction gating, disconnect/stale/reset, invalid state,
  silent replay, swing echo deduplication and authoritative fall-event tests.
- `npx tsc --noEmit --incremental false`, frontend production build, server
  typecheck and server build all passed. Existing Vite large-chunk warning remains.
- Final Git diff/whitespace review found only Party Lab changes. No package,
  App.tsx/App.css, unrelated Torble system or WAV changes.

Chrome normal and Incognito clients on this Mac joined using the actual LAN
hostname `192.168.1.173`, readied, entered the same arena, exercised W/D, Space and
F, completed two rounds, returned to unready lobbies and entered the next round
with fresh prediction. Settings accepted F/Space without gameplay input and
returned to the arena with zero pending history. Local reference mode still
rendered its human and two bots after leaving the online room.

Observed online HUD: **~60 FPS**, **0.32–0.34 ms per prediction physics step**,
ACK turnaround **18–27 ms**, zero hard corrections in these short samples. One
sample averaged 0.003 m root correction error, maximum 0.070 m; a fresh-round
sample averaged 0.001 m, maximum 0.090 m after jump/settings interaction. These
are brief same-machine development observations, not GPU profiling or a low-end
PC guarantee. ACK turnaround includes server tick and snapshot waiting; it is not
a pure RTT measurement.

DEV-only diagnostics: add `?partyDebug=1` (or `&partyDebug=1` to an invite). The
footer reports FPS, prediction state, step cost, root error, average/max error,
correction/hard counts, pending inputs and ACK turnaround. Production shows no
debug overlay. Metrics do not leave the browser.

## Remaining verification and limitations

No Windows desktop was available to automation: the real two-computer test still
needs the user. Native browser input cannot reliably sustain simultaneous
Grab/Lift or measure exact input-to-photon latency. Authority tests cover these
physics paths; this is not a claim that the full live KO/grab/carry/throw/fall-cat
checklist was manually completed. Actual speaker timing and subjective correction
quality under contact still require playtesting. Safari was not revalidated in
this phase; its earlier rendering caveat remains in the historical report.

Normal locomotion RTT was simulated through 150 ms. Server collision convergence
and grip/KO fallback have dedicated tests, but sustained high-latency multi-player
contact and packet-loss conditions were not comprehensively measured. No remote
proxies means contact presentation may overlap before correction. Entering a grip
or KO returns to the 100 ms authoritative timeline and can visibly correct. These
mechanics intentionally remain latency-sensitive. Rapier solver caches are not
networked, so replay is approximate rather than bit-identical. Under >500 ms
snapshot/input uncertainty (originally 300 ms) prediction falls back safely. Do not add speculative
hit/grab outcomes to conceal those limits.

## LAN testing

From the repository root, in separate Mac terminals (dependencies already installed):

```sh
npm --prefix servers/party-lab run dev
npm run dev -- --host 0.0.0.0 --port 5173 --strictPort
```

Mac: `http://localhost:5173/party-lab?partyDebug=1`, or preferably the LAN URL for
sharing invites. Windows: `http://192.168.1.173:5173/party-lab?partyDebug=1` (replace
with the Mac's current Vite LAN address). Both Ready. The default WebSocket host
follows the page hostname at port 2567; leave `VITE_PARTY_LAB_SERVER_URL` unset
unless deliberately overriding it. Server still binds `0.0.0.0` with the existing
origin/session validation. See the server README for firewall/reconnect details.

## File inventory

Created:

- `shared/party-lab/PREDICTION.md`
- `shared/party-lab/simulation/{world,predictionState}.ts`
- `src/party-lab/network/prediction/{history,correction,rig,localPrediction}.ts`
- `src/party-lab/network/{prediction,predictionLatency}.test.ts`

Modified:

- `shared/party-lab/network/protocol.ts`
- `shared/party-lab/simulation/{physics,combat,onlineRound}.ts`
- `shared/party-lab/simulation/combat/punch.ts`
- `src/party-lab/network/{gameStream,session}.ts`, `network.test.ts`
- `src/party-lab/scene/OnlineArena.tsx`
- `servers/party-lab/src/PartyRoom.ts`
- `servers/party-lab/tests/{gameplay,simulation}.test.ts`
- `shared/party-lab/ONLINE.md`, `servers/party-lab/README.md`
- `src/party-lab/{scene/RAGDOLL,input/CONTROLS,audio/AUDIO}.md`
