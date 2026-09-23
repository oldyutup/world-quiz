# Phase 3D — original local audio and game feel

Initial checkpoint: clean `party-game-prototype` at `cae1bc0`. Controls, nine-body
ragdolls, combat, bots, rounds and room/chat were inspected first. All 63 baseline
local tests passed. This phase changes only `src/party-lab/`.

## Online compatibility (Phase 4B.2)

Pure event definitions, recipes and policy now live under `shared/party-lab/feedback/`;
existing audio modules re-export them. Web Audio, preferences and WAV decoding stay
browser-only. Online plays server-confirmed semantic events with room-lifetime IDs,
round/tick timing and existing spatial positions through the same AudioManager.
Deduplication never derives a fall sound from snapshots. `fall-cat.wav` remains the
primary physical-elimination cue, once per event, with procedural fallback and no
layering. Hidden tabs/settings discard presentation events while retaining their
ID high-water mark. See [ONLINE.md](../../../shared/party-lab/ONLINE.md).

Ordinary local predicted punch motion can now play an immediate `punchSwing`.
Only successfully played swings are marked by round/slot/input sequence; the
matching authoritative swing echo is suppressed. Replay is silent. Hits, KO,
grabs, lift, throw, jump/landing, elimination and results remain server events.
Prediction never plays the cat WAV or triggers impact camera shake. The WAV,
audio settings, recipes and AudioManager are unchanged. See
[PREDICTION.md](../../../shared/party-lab/PREDICTION.md).

## Architecture and synthesis

`PartyAudio` owns one lazy `AudioManager` per Party Lab root. Physics, combat,
grips and rounds emit typed `FeedbackEvent` values without browser/audio nodes or
device bindings. `LocalRoundSimulation` forwards them after each step. The
read-only `PhysicsFeedback` observer uses actual Rapier contact manifolds. No
forces, combat rules, targeting, bot behavior or network messages were added.

The procedural sounds are original code-authored recipes: sine harmonics, filtered seeded
noise, pitch ramps, wobble and short attack/release envelopes. Short mono PCM is
generated lazily at 22,050 Hz and cached. Two subtle duration/filter/noise variants
combine with ±4% playback pitch/gain variation. There are no downloaded samples,
proprietary assets, base64 blobs or background music in that synthesis palette.

The `fall` cue now primarily uses the user-supplied
`public/party-lab/audio/fall-cat.wav`, fetched from `/party-lab/audio/fall-cat.wav`.
The first audio-unlock gesture starts a single fetch/decode in parallel with
context resume, before the arena countdown. The decoded buffer is reused across
rounds/arena visits and plays at its original pitch through the existing gain,
pan and priority-limited voice path. It replaces, rather than layers with, the
procedural fall cue. Loading/decoding failure (or an unusually early fall while
loading) uses the procedural cue immediately; loading completion never replays it.
Disposal aborts the request and ignores stale decode results.

The existing alive-to-eliminated physics transition emits `fall` exactly once
per actor, with reset allowing it again next round. Audio retains the per-actor
cooldown but exempts fall from the shared category throttle so simultaneous human
and bot eliminations each play. Ordinary KO, floor contact, jump and landing keep
their separate sounds. Existing mute/volume/voice-limit rules still apply.

| Semantic cue | Character and trigger |
| --- | --- |
| `punchSwing` | Airy whoop after an accepted physical arm punch |
| `bodyHit` | Rounded low thump on confirmed torso/pelvis contact |
| `headHit` | Brighter resonant rubber bonk on head contact |
| `limbHit` | Small arm/leg tap |
| `lightBump`, `heavyBump` | Small bup or chunky low rubber impact |
| `floorFlop` | Filtered plop on meaningful torso/pelvis floor contact |
| `grab`, `secondGrab` | Squish on acquisition, stronger rising second-hand cue |
| `gripBreak` | Pop/slip on escape, overload or distance break |
| `lift` | Quiet rising stretch when successful lift begins |
| `release`, `throw` | Tiny release or stronger momentum-dependent whoosh |
| `fall` | Custom cat WAV on falling elimination; procedural wobble fallback |
| `knockout`, `recovery` | Separate wobbling KO accent and rising recovery boing |
| `jump`, `landing` | Accepted springy hop and actual soft landing |
| `countdown`, `roundStart` | Rising 3/2/1 tones and small three-tone GO cue |
| `winner`, `draw` | Original 1.45-second arpeggio or neutral comic cadence |
| `uiClick`, `uiConfirm`, `uiBack` | Quiet Party Lab button feedback |

Misses emit swing only. Holding a grip is silent. The second hand cue requires
the same target. Lift starts when existing quality exceeds 0.3; simultaneous
two-hand cues are merged and a 1.2-second cooldown prevents repeated strain.
Only the last released hand emits release/throw: torso speed below 2.5 selects
release; otherwise throw, with clamped speed/10 intensity. Round/KO/elimination
grip cleanup produces no fake throws. Recovery plays once on KO → RECOVERING.

Barn Shootout cues (local barn only; the rooftop never emits them), with previews in
settings: `weaponPickup` (two-note click), `shotgunFire` (heavy noise boom, priority 2),
`smgFire` (short noise pop, 50 ms gate for ≈ 9.5 rounds/s), `bulletHit` (thwack per
struck target per shot, intensity = damage / 60), `weaponEmpty` (click-poof when the
last round removes the weapon), `trapSnap`, `death` and `respawn`. Punches reuse
`punchSwing` and the part hit cues. `CameraFeel` also shakes on heavy `bulletHit`,
`trapSnap` and `death` involving the local player.

## Intensity, spam prevention and performance

- Punch intensity: existing part-weighted impact power / knockout head threshold
  (58), clamped to 0–1. Collision intensity: clamp(max(closing speed / 8, impulse / 3)).
- LIGHT <0.35, MEDIUM 0.35–0.70, HEAVY ≥0.70. Gain scales continuously; heavy
  environmental collisions select a deeper recipe. Head/body/limb recipes differ.
- Contact eligibility: closing speed ≥1.1, impulse ≥0.045, manifold separation
  ≤0.025. Resting contacts remain silent.
- Pair cooldown 240 ms; character/environment group cooldown 220 ms. Floor head
  and body have separate slots, allowing bonk + flop. Maximum two generic collision
  cues per step; old pair/group entries expire and reset clears observer state.
- Confirmed punch suppresses generic same-player-pair contact for 180 ms. Landing
  suppresses redundant non-head floor cues in the same step. Landing requires
  airborne time >120 ms and real descent >1.3; peak descent is retained because
  active support may slow the pelvis before feet regain ground.
- Per-actor/category semantic cooldowns add protection. **16 simultaneous short
  voices maximum**. KO/countdown/start/winner/draw can evict lower-priority voices.
  Ended sources and gain/pan nodes disconnect. No long-running oscillators.
- Gain changes are smoothed; output uses fixed headroom and a compressor.
  Simple world-X stereo pan is capped at ±0.65; UI/previews remain centered.
  StereoPanner-unavailable browsers fall back to mono.

## Lifecycle and settings

Party Lab pointer/key gestures create/resume the context. Locked/unavailable
audio fails silently without a backlog. Arena exit stops voices and reuses the
same context on re-entry. Settings pause gameplay and stop old effects; explicit
previews still work. Backgrounding stops/suspends audio; the next gesture resumes
it. Root cleanup removes its single visibility listener, disconnects nodes and
closes the context. Disposal is idempotent/reusable for StrictMode. No global
pointer/key listeners are added.

**Kontroller** now includes **Master Ses**, **Efekt Sesleri**, **Sessiz**,
**Kamera Sarsıntısı** and all-cue previews. Audio fields are disabled during binding
capture. LocalStorage key **party-lab-audio-v1** uses this validated schema:

```json
{"version":1,"settings":{"master":80,"sfx":85,"muted":false,"cameraShake":true}}
```

Volumes are 0–100; gain multiplies master × SFX × fixed headroom. Mute/zero stops
active voices. Invalid/unsupported storage falls back to defaults. Storage failure
keeps session settings working and shows a warning. Controls storage is separate.

Existing flashes/KO stars remain. Heavy impacts involving the human add a 150 ms
camera offset, max 0.022 world units (0.035 for KO), squared decay, no accumulation.
Light/medium contacts do not shake. Preference or OS reduced-motion disables it.
Results get a small CSS pulse, also respecting reduced motion. No postprocessing.

## Validation and browser evidence

- **87/87 local tests** (63 baseline + 24 added): input/controls, ragdoll, combat,
  bots, rounds, soak, synthesis, settings, mute, intensity, cooldowns, voice priority,
  lifecycle/disposal, camera bounds and actual physics-event integration.
- **11/11 server regression tests**. Server source unchanged.
- `npx tsc --noEmit --incremental false`: passed.
- `npm run build -- --outDir /tmp/party-lab-phase3d-build`: passed. Existing Vite
  large-chunk and mixed static/dynamic import warnings remain.
- `git diff --check`: passed; only Party Lab files changed.

Safari at `127.0.0.1:5174/party-lab` verified default display, slider changes,
mute suppression, camera toggle, custom preference persistence after reload,
body/winner preview scheduling and Safari's active-audio indicator. Test settings
were restored to 80/85, unmuted, shake on. F then normal click produced alternating
left/right punches. Arena right-click did not open the browser context menu.
Settings paused gameplay while previews worked. Rendering, bot combat, later
countdowns and repeated arena entry remained operational.

Short active-play HUD samples: **60 FPS, 0.9–1.3 ms physics/step**, 27 bodies,
24 anatomical joints. This is one machine, not a low-end benchmark.

Speaker output cannot be auditioned through this automation. Perceptual head/body
differences, weak/strong balance, every live cue, sustained grab/lift/throw input,
and physical MacBook two-finger holding still need human listening/playtesting.
Repeated entry smoke checks are not a heap-leak audit; fake-context tests cover
ownership/node cleanup. Collision detection uses linear closing velocity and
manifold impulse rather than a separate angular contact-point velocity model.
Tune recipes/policy rather than combat. Prioritize head/KO layering, collapse
density, lift subtlety, throw strength and the jingle on speakers/headphones.

## Changed files

Created: `audio/{AudioManager.ts,AudioSettings.tsx,PartyAudio.tsx,events.ts,feel.ts,
policy.ts,settings.ts,sfx.ts,synth.ts,audio.test.ts,AUDIO.md}` and
`scene/{feedback.ts,feedback.test.ts}`.

Modified: `PartyLabRoot.tsx`, `ControlsSettings.tsx`, `party-lab.css`,
`scene/{ArenaScene.tsx,combat.ts,combat/grab.ts,localRound.ts,physics.ts,RAGDOLL.md}`.

API references: [AudioContext.resume](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume)
and [StereoPannerNode](https://developer.mozilla.org/en-US/docs/Web/API/StereoPannerNode).
