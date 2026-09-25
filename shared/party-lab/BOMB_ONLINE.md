# Bomba Sende online (protocol 8)

`bomb_tag` is the fifth Party Lab online mode. The approved local `BombTagGame`, `BombRules`,
`BombTraps` and `BOMB_MAP` remain the single gameplay implementation; online play wraps them in
`BombRoundSimulation`. Rooftop, Barn, Layer and Color simulations contain no bomb branches.

## Authority and wire

The server owns Rapier, bodies, carrier, fuse, transfers, tag-back, traps, slowdown, blast,
elimination and result. A bomb input is intent only:

`seq, round, moveX, moveZ, jumpPressed, sprintHeld, punchPressed, viewTick`

`viewTick` is the server timeline the player saw. It is not a player or hit claim. Protocol 8 is
required because a protocol-7 client cannot render/predict the bomb and trap snapshot.

Every snapshot contains a compact `bomb` section:

- `t`: round tick
- `c`: carrier (`-1` none)
- `e`: absolute fuse end tick (`-1` inactive)
- `n`: absolute next-fuse tick (`-1` inactive)
- `p`, `b`: previous carrier and absolute tag-back expiry
- `a`: three armed-trap bits
- `x[3]`: absolute rearm ticks (`-1` while armed)
- `s[3]`: absolute per-player slow expiry (`-1` inactive)
- `f[3]`, `o[3]`, `r`: player flags, elimination ticks and result code

That one section restores a reconnect without replaying events. Prediction state is recipient-only:
velocities plus the shove fighter timers, carrier modifier and remaining trap-slow ticks.

## Fuse and transfer

The 14 s fuse is a whole-tick deadline. A transfer changes `c` only; `e` is unchanged. Explosion
is processed once by the server at zero. In a three-player round the next carrier is selected at
once, `n` is 2.5 s later, and the new 14 s fuse starts then.

The carrier's punch searches in 360 degrees. The nearest alive, non-protected candidate must pass:

- horizontal pelvis distance at most 1.30 m
- surface-height difference at most 0.65 m
- pelvis-height difference at most 1.0 m
- clear pelvis-to-pelvis static LOS
- clear chest-to-chest static LOS

A real ragdoll hand collision uses the same validation. A rejected pass may still produce the
physical shove. A successful server event is the only trigger for the 0.16 s client bomb arc.

## Conservative rewind

Bomb tags rewind at most 150 ms (nine 60 Hz poses). This covers the 100 ms interpolation buffer
plus ordinary one-way delay without turning a close hand-off into a ranged hit. The server stores
only pelvis and chest positions. Old ticks clamp to nine ticks; obviously future ticks are rejected.
Distance, surface and both static LOS checks run at the historical positions. The target is still
chosen by the server; current authoritative bodies receive the approved shove/stagger.

## Traps and prediction

The three shared map points are authoritative. Overlap is checked from server feet. An armed trap
slows one player to 0.50 for exactly 60 ticks, stays shut for 420 ticks, and does no damage. A player
with slow ticks remaining cannot spring another trap. The prediction rig replays the server's
carrier 1.15 multiplier and trap 0.50 multiplier; each snapshot reconciles those modifiers with the
same 300 ms small-correction stack as the other online modes.

## Mixed and reconnect

Mixed bags contain all five modes once. The next bag cannot begin with the mode that ended the
previous bag. The lobby always shows the server-owned next mode. A reserved reconnect keeps its
seat/body and receives carrier, fuse, tag-back, stagger, trap/slow and result state in its first
valid snapshot. A permanent leave is a forfeit.

## Pre-commit production bundle audit

Compared with `b051045` (online Color Chaos), using the same dependencies, Vite config
and environment. Sizes below are actual emitted file bytes; gzip is measured per file.

| Download | Before, bytes / gzip | Bomba Sende, bytes / gzip |
| --- | ---: | ---: |
| Shared arena chunk (`ColorHud` → `BombHud`) | 3,100,127 / 1,163,868 | 3,168,666 / 1,188,804 |
| Party Lab root JS | 391,738 / 127,858 | 392,508 / 128,102 |
| Initial Party Lab JS, including entry and Three.js | 1,249,634 / 359,717 | 1,250,405 / 359,963 |
| Initial Party Lab CSS | 44,062 / 8,605 | 49,548 / 9,481 |

Vite prints the shared chunk as 3,168.28 kB / 1,188.80 kB gzip. `BombHud` is its generated
name, not its main payload: it contains the existing `@dimforge/rapier3d-compat` 0.20.0
runtime, including a 2,694,936-byte base64 WASM string (2,021,200 decoded bytes), plus shared
arena simulation, GLTF loading, scenery and HUD code. Rapier's rendered module is about
2.86 MB; this was already in the `ColorHud` chunk before Bomba Sende.

The production manifest and Rollup module graph confirm:

- The page entry and Party Lab root have no static dependency on the shared arena chunk
  or Rapier. Initial JS module membership is unchanged; Three.js was already used by the
  lobby costume preview.
- `PartyLabRoot` still lazily imports `ArenaScene` and `OnlineArena`. The shared physics
  chunk is requested when one of those arenas opens, including Bomba Sende, Layer Chaos
  and Color Chaos. It is shared by arenas, not downloaded exclusively for Bomba Sende.
- Local playgrounds share the arena chunk; online mode components share `OnlineArena`,
  exactly as Layer Chaos and Color Chaos did previously. No eager arena import was added
  to the lobby or page entry, and no speculative splitting was applied.
- Total initial Party Lab JS + CSS increases by 6,257 bytes raw / 1,122 bytes gzip
  (about 0.30% gzip), from 368,322 to 369,444 gzip bytes. This is ordinary mode metadata,
  protocol handling, sounds and bomb HUD CSS, not an eager physics download.

## Pre-commit verification

- Complete frontend suite including edge, root mode-picker and costume-storage tests:
  **425/425** (the 418-test group plus five mode-picker and two costume-storage tests).
- Full server suite: **46/46**. Root TypeScript, server typecheck, server production build,
  frontend production build and whitespace checks pass.
- Built server with `NODE_ENV=production`: `/health` returns
  `{"ok":true,"service":"party-lab","protocol":8}`; `NET.version` is 8.
- Against `b051045`, Rooftop, Barn, Layer and Color each produce identical hashes over
  1,800 simulated ticks of snapshots, feedback events and recipient prediction state,
  excluding only the intentional snapshot protocol version change.
- Existing mode simulations, Barn traps and chat implementation are unchanged. The compact
  lobby retains its layout; only the bomb choice and five-mode hint are added. Normal online
  Bomba Sende keeps the debug panel hidden; debug controls require `?partyDebug=1`.
- Mixed tests cover all five modes exactly once per bag with no boundary repeat, including
  real-socket mode switches. Approved bomb tuning is unchanged by this audit.
