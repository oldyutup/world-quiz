# Local Human Bowling audio polish

Scope: local presentation/audio only. Existing uncommitted work was retained.
No changes to car/launch physics, gravity, course, pins, controls, scoring, Rooftop,
online simulation, or protocol (still 9). No commit, push, or deployment.

## Existing Rooftop cat cue

- Exact asset: `public/party-lab/audio/fall-cat.wav`, URL `/party-lab/audio/fall-cat.wav`.
- Existing `AudioManager.playSfx({ name: 'fall' })` uses its decoded `fallBuffer`,
  playback rate **1**, the existing fall recipe gain, voice policy and shared limiter.
- WAV: 154,530 bytes, stereo, 44,100 Hz, 0.87576 seconds.
- SHA-256: `81c720be8cde3bf20c2068b93c176d104033a6fcd8dc2dbdcdc0c41620b2a6d5`.
- Existing provenance in `src/party-lab/audio/AUDIO.md`: **user-supplied**. No
  additional license claim is made. No new/downloaded asset or dependency was added.
- Shared physics emits Rooftop's cue on actual falling elimination. That trigger,
  manager, volume, asset, and Rooftop logic are byte-for-byte unchanged.
- Bowling observes the **false → true `g.ejected` transition**, set at the end of a
  successful `BowlingGame.eject()` after ragdoll initialization. It sends `fall`
  with the current actor, centered, at the same default intensity as Rooftop.
  This replaces Bowling's old `throw` cue; there is no layered imitation.
- The latch follows resets and is consumed even while muted/hidden; nothing is
  queued for later playback. Angle selection, failed input, missed launches,
  holding/repeating Space and Nudge cannot retrigger the cue.
- The existing preload/fallback behavior is preserved: a failed or exceptionally
  late WAV load uses the shared procedural fall fallback once, never a delayed replay.

## Before: exact audit

One sawtooth oscillator → one low-pass biquad → gain → a separate AudioContext's
output. Low-pass cutoff **360 Hz**, default Q **1**; gain **0.035 × master × SFX**
(default settings: 0.0238). Gain was constant across idle, load, coast and speed.

Frequency: **35 + 5 × horizontal speed in m/s**, with no clamp; the existing car
maximum of 46 m/s produces **265 Hz**, and 160 km/h produces **257.22 Hz**.
The oscillator initially used WebAudio's **440 Hz default**, until the first
frame began its downward smoothing. There was no throttle, rumble or noise layer.

Updates occurred once per rendered `useFrame`, after fixed simulation updates,
not at each physics substep. Frequency used `setTargetAtTime` with an 80 ms time
constant; active gain used 40 ms, silence 10 ms. There were no intentional hard
pitch jumps in driving, but a fresh unlock could produce a descending startup
sweep, and disposal stopped/closed immediately without a release fade.

The principal irritation was a continuously dominant tracked fundamental in the
roughly **180–265 Hz high-speed range**, with residual saw harmonics in the low
mids and little changing texture. Filtering had already removed most treble, so
this was not evidence of a dominant 2–4 kHz whistle. A constant load-independent
gain and a lack of road/wind texture made speed read mainly as oscillator pitch.

## After: procedural engine

| Layer/control | Implementation and limits |
| --- | --- |
| Engine body | Custom periodic wave with six declining sine harmonics: 1, .45, .22, .1, .045, .02. Fundamental **42–118 Hz**. |
| Body filter | Low-pass **320–600 Hz**, Q .5. |
| Engine pulse | Sine **14–31 Hz**, amplitude modulation ±14%; never routed directly to the output. |
| Low rumble | Quiet sine **26–49 Hz**, gain .085 before output. |
| Road | One generated two-second mono noise loop, high-pass 65 / low-pass 240 Hz, Q .5. Gain 0–.035 with speed. |
| Wind | Same noise source, high-pass 180 / low-pass 650 Hz, Q .5. Gain 0–.11, quadratic rise above 82.8 km/h. |
| Final filter | Low-pass **900 Hz**, Q .5, on the whole engine mix. |
| Output | **.05 × master × SFX**; body gain .24–.40 and the other quiet layer gains precede it. |

Let `s = clamp(speed / 46, 0, 1)`, `r = s^0.7`, `t = clamp(throttle, 0, 1)`:

- Body frequency = `42 + 62r + 14t` Hz; body gain = `.24 + .07r + .09t`.
- Body cutoff = `320 + 180r + 100t` Hz.
- Rumble = `26 + 23r` Hz; pulse = `14 + 17r` Hz.
- Road gain = `.035s`; wind gain = `.11 × max(0, (s-.5)/.5)^2`.

Real car speed and player throttle drive these values. Bots read the same pure,
deterministic `botThrow` throttle selection used by the existing simulation.
Countdown has zero load. Slow motion does not multiply audio pitch. Release
reduces engine pitch/load while road and wind remain tied to actual speed.

Pitch/filter smoothing is **180 ms**, body load gain **120 ms**, road/wind gain
**220 ms**, startup gain **80 ms**. Eject/inactive gain release is **25 ms**
(~95% down in 75 ms); blur/disposal use **15 ms**. These are time constants.

## Mix and lifecycle

At default settings, Chromium OfflineAudioContext renders measured:

| State | Old RMS dBFS | New RMS dBFS |
| --- | ---: | ---: |
| Idle | -38.57 | -45.09 |
| 30 km/h, throttle | -38.55 | -41.97 |
| 100 km/h, throttle | -38.60 | -41.21 |
| 165 km/h, throttle | -38.65 | -40.71 |
| 165 km/h, coast | -38.65 | -42.73 |

Highest new peak across these cases: **-33.01 dBFS**, safely below clipping.
At 165 km/h, energy above 1 kHz dropped from **0.08088% to 0.00720%** (~91%
reduction). Engine release was below the 16-bit comparison render's noise floor
at 150 ms. These are signal measurements, not a subjective listening assessment.

Only trusted key/pointer gestures unlock Bowling's context. Repeated gestures
and throws reuse **three oscillators (including the modulation oscillator) and
one looping noise source**. No sources or buffers are allocated per frame/throw.
Mute respects Party Lab master/SFX settings. Blur/visibility changes silence the
engine and require a subsequent trusted gesture to re-enable it. There is no
background replay queue.

On unmount/replay, the captured old graph fades, every source receives a stop at
100 ms, every node disconnects, and its context closes at 120 ms. Old cleanup
cannot close a replacement graph. Bowling exit also stops the shared one-shot
voices through the existing manager; the Party Lab manager itself stays reusable.

## Validation

- Relevant audio, Bowling and Rooftop tests: **106 passed, 0 failed**.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed; Vite's existing large-chunk warning remains.
- `git diff --check`: passed.
- Baseline SHA-256 comparison: only `audio.ts` and `BowlingPlayground.tsx` changed
  among pre-existing Party Lab/shared/server/public files.
- Real Chrome keyboard gameplay covered idle, low-speed acceleration, downhill,
  100+ and 140–165 km/h (observed 165.64), throttle release, obstacle collision
  (observed ~165.64 → 130.70 km/h), angle-selection slow motion, successful eject,
  repeated Space, Nudge, consecutive players and round reset. An extended
  three-player run observed eight successful ejections: eight loaded-WAV plays,
  exactly one per turn, with one persistent engine graph. A separate completed
  two-player match observed six more successful turns with one cat each.

- Real held-key Nudge plus repeated Space: passed, with no extra cat play.
- Pause, mute/unmute, player-count restart, completed-match **Bir daha oyna**
  replay, and leaving Bowling: passed. Old contexts closed and only one new
  engine graph existed after reset/replay. No browser application exceptions.
- Focus validation with Playwright's forced-focus emulation disabled recorded
  trusted blur/focus events: gain reached **0**, remained **0** after focus
  returned, then rose only after a trusted keypress.
- Harness corrections: zero-duration key taps initially failed to exercise
  Nudge; a 90 ms press verified it. A 250-second run ended before its expected
  ninth throw (eight valid cat plays, no duplicate). The shorter full match
  verified the actual replay button. Default Playwright forced-focus emulation
  initially suppressed blur; disabling it verified the real behavior. These
  were harness limitations; no gameplay/audio fix was needed for them.

Validation artifacts and old/new comparison WAVs are in
`/private/tmp/bowling-audio-pass/`.

Files in this pass:

- `src/party-lab/scene/bowling/audio.ts`
- `src/party-lab/scene/bowling/BowlingPlayground.tsx`
- `src/party-lab/scene/bowling/audio.test.ts` (new)
- `src/party-lab/scene/bowling/AUDIO_REPORT.md` (new)
