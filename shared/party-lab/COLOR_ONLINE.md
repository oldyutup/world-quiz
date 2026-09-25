# Online Renk Kaosu (Phase 2)

Renk Kaosu (`color_chaos`) is the fourth online Party Lab mode, next to Rooftop Brawl, Barn
Shootout and Katman Kaosu, for 2–3 players. Its rules, layouts, timing, Daralma, camera and
presentation are the approved local ones ([simulation/colors/COLORS.md](simulation/colors/COLORS.md))
with no retuning. The other three modes and the network hardening in [NETWORK.md](NETWORK.md)
are unchanged.

## Protocol 7

`NET.version` goes from 6 to 7. A protocol-6 page cannot draw or predict a colour round, and a
protocol-6 server refuses the mode. The join-time version check refuses mismatched pages
("Party Lab güncellendi"). Deploy Vercel and Railway together; `/health` must report
`"protocol":7`.

What changed on the wire:

- `modes.ts`: `color_chaos` is a game mode (`MODE_MAP.color_chaos = "colors"`). The lobby's
  compact picker offers Çatı Kavgası, Ambar Çatışması, Katman Kaosu, Renk Kaosu and Karışık.
- Colour snapshots add a `colors` section.
- The input packet and the recipient's prediction block are Katman Kaosu's, shared (both are
  "shove modes": the same fighter, the same intent).
- Rooftop, Barn and Katman Kaosu packets, snapshots and events are byte-for-byte the same
  apart from `v`. Seeded runs of all three (and of local Renk Kaosu) hash identically before
  and after, with `v` excluded.

## Mixed: four modes

`MixedRotation` (server-owned) plays every mode exactly once per cycle, in shuffled order. The
next cycle is reshuffled and never starts with the mode just played, so no mode repeats back
to back. The lobby shows the next round's mode ("Sıradaki tur") before Ready. That mode is used
up only once its round reaches play; a cancelled countdown keeps it. Choosing Mixed again
starts a fresh cycle. There is no voting.

## Server: `ColorRoundSimulation`

`simulation/colorRound.ts` sits behind the existing `OnlineSimulation` interface. The room swaps
simulations per mode as before; ticks, rounds, events and snapshot sequence come from the shared
`RoomCounters`. Nothing Renk Kaosu-specific was added to the other simulations.

It drives the same `ColorChaosGame` the local arena uses. The game gained `begin(slots)` for
the room's seats (any two or three of the three), and the schedule now takes the player count
per round. The local seeded runs are bit-identical. The server owns:

- the Rapier world and all 85 tile colliders;
- the colour layout (the approved banks, symmetries and palettes), the target (the shuffle bag),
  the cycle, its phase and every tick;
- drop and restore ticks, the below-floor rule, present / marked / grey tiles and the Daralma
  stage;
- punch legality and contact, stagger, eliminations, alive count, winner/draw, the final drop
  and the round clock.

Each round draws a fresh seed. Per playing tick, in order:

1. The schedule's target / drop / restore. Colliders change before physics. On a restore, hips
   below the floor are out first.
2. Punch and stagger timers update, and new punches start.
3. Input.
4. Physics.
5. Punch contacts.
6. Eliminations.
7. The winner is decided.

Phases:

- Countdown, 3 s: bodies frozen, every tile standing, cycle 1's colours visible. Inputs change
  nothing (tested bit for bit).
- Play: the approved schedule.
- Results, 3.5 s, then the lobby, where everyone Readies again.
- Last alive wins. A simultaneous final elimination is a draw. Leaving is a forfeit (result
  code `forfeit`). 125 s remains only the safety net.

Spawns are the approved ones: three players at 120° on ring 3, two players on opposite sides
(12 m), in seat order. The opening layout for two players is half-turn symmetric, so both
starts are equivalent.

## Input packet (60 Hz)

Katman Kaosu's packet, validated with strict keys:

```
seq, round, moveX, moveZ, jumpPressed, sprintHeld, punchPressed
```

- Colour, target, tile, safe-tile, drop, restore, layout, hit, elimination and winner claims are
  refused, as are Barn aim fields and rooftop grab/lift fields.
- Packets of another mode are refused.
- Size: 86 B msgpack (5.2 KB/s). Measured TCP uplink at the proxy, including framing and pings:
  5.2–5.5 KB/s per client.

## Colour network state

Every snapshot carries the whole cycle. It is self-contained and idempotent: a reconnect or a
late joiner has the exact floor from its first snapshot, and there are no tile events.

| Field | Content |
| --- | --- |
| `t` | Round tick: the next step's in play, the final one in results |
| `n` | Cycle (1-based) |
| `k` | Its ticks [start, announce, drop, restore] |
| `h` | The cycle's target colour (0–3) |
| `p` | Tiles there this cycle: bitset, 85 bits = 11 B |
| `g` | Of those, grey (no colour, never the target, gone at this drop): 11 B |
| `m` | Marked, "DARALIYOR" (coloured now, grey next cycle): 11 B |
| `c` | Colour per tile, 2 bits each: 22 B |
| `f`, `o`, `r` | Per-slot flags (in match, alive, body, staggered, forfeit), elimination ticks, result code |

Standing rule on round tick τ of the cycle:

- the target colour always stands;
- every other tile of `p` stands before `drop`;
- from `restore` on, the tiles that had a colour this cycle stand.

A client needs nothing else to know every collider for the whole prediction window, the
restore included. The next drop is at least 2.1 s after a restore.

**Validation.** Everything but the colours and the target follows from `n`: the ticks, which
tiles are there, grey and marked. The client (`decodeColorSnapshot`) checks this against the
rules it was built with and refuses a section that disagrees. A stale or mismatched page never
draws or predicts another floor. Clients never choose layouts.

**The target and its timing.** The target is in the section from the cycle's start (the
restore), and every screen reveals it on the announce tick of its own timeline. So a
predicting player gets the full reaction time on their own timeline, however far their
prediction runs ahead of the newest snapshot. A modified client could read the target up to
the 0.9 s preview early. That is accepted for a friends-only game, and it is the only thing the
early send exposes.

Sizes:

- Section: 106–118 B msgpack (the key names included).
- Whole snapshot message with the recipient's prediction block: 1,376–1,390 B. Katman Kaosu is
  1,342–1,372 B, Barn 1,410 B and Rooftop 1,179 B.
- Downlink: 26.5–27.9 KB/s per client (TCP payload at the proxy).
- Section build: 12–97 µs in the paced room; about 8 µs flat out (whole snapshot 0.008–0.011 ms).

## Prediction

`network/prediction/colorRig.ts` is the fourth rig behind the unchanged `LocalPrediction`: same
history, 500 ms / 30-tick window, correction tiers, 300 ms small-correction ease, interpolated
pose and frame clock. It has nine bodies and eight joints on its own copy of the 85 tile
colliders. It replays the server's own per-fighter step (`stepLayerFighter` with Renk Kaosu's
shove tuning: punch timers and alternation, stagger posture/mobility/no jump, sprint) and the
shared controller. Hits, other players and fall eliminations are never predicted. A local punch
swings at once (the echo is deduplicated); pushes and staggers come from the server.

**Colliders during replay.** Every replayed tick gets exactly the server's colliders
(`ColorFieldKnowledge.standing`). The predicted body therefore:

- keeps its momentum grace;
- drops through a tile on the tick the server removes it;
- is caught by a target edge on the same ticks as the server's body.

A restore from a snapshot first sets the colliders the server had after its last step (tick
t − 1), queries included. Then each step sets tick τ's colliders at its start, as the server
does: a returning collider is seen by that tick's contacts, and by ray queries only from the
next tick. The Katman Kaosu Rapier fix is reused (`tileQueries.ts`, now shared by both rigs): a
tile brought back by a restore is refreshed with a timestep-0 step while the body is disabled.

**The below-floor rule** runs in the rig on the same tick as on the server: hips below the floor
on a restore tick means out. The rig then stops (`out`) instead of closing the returning
colliders around the body. The screen starts the own fall from the last drawn pose, and the
server's snapshot confirms it. If the server disagrees on the boundary, the body is shown again.

**What the screen draws.** Tiles, target, timer and the "MAVİ!" call follow the followed body's
timeline: the own predicted ticks while playing, the remote (interpolated) ticks while
spectating. `ColorFieldKnowledge` keeps the last four cycles, so a timeline behind the newest
snapshot still draws its own cycle and the tiles rising back.

Measured (`colorPrediction.test.ts`, three players, every slot a bot; slot 0 predicted through
the link). Slot 0 survives three drops and restores, punches and jumps, then walks onto a wrong
colour in cycle 4 and falls.

| Link | Max correction (away from other bodies) | Hard | Fall tick predicted / server | Predicted colliders = server |
| --- | --- | --- | --- | --- |
| RTT 0 | 0.067 m (0.067) | 0 | 1021 / 1021 | 1053/1053 ticks |
| RTT 50 | 0.126 m (0.049) | 0 | 1020 / 1020 | 1050/1050 |
| RTT 100 | 0.241 m (0.045) | 0 | 1020 / 1020 | 1048/1048 |
| RTT 150 | 0.343 m (0.053) | 0 | 1021 / 1021 | 1044/1044 |
| 100 ± 0–60 ms | 0.439 m | 0 | same tick | 895/895 |
| 150 ± 0–60 ms | 0.421 m (0.312) | 0 | same tick | 886/886 |
| RTT 70 + 300 ms stall | 0.241 m (0.044) | 0 | same tick | 1043/1043 |
| RTT 70 + 500 / 800 ms stall | 0.241 m | 0 (1 window overflow) | same tick | all |
| RTT 70 + 300 ms stall over a drop, while running | 1.31 m | 2 | same tick | all |

- The larger corrections come from the bots brushing past slot 0. The rig has no other bodies,
  the same trade-off as the other modes. Away from them the error is about 5 cm.
- A stall over a drop while running: the server never got those inputs, so its body did not
  run, and the player falls. The server decides and the prediction snaps to it. This is the
  known latest-wins mailbox trade-off ([BARN_ONLINE.md](BARN_ONLINE.md)).

## Drop, grace, restore, Daralma, final drop

- **Exact drop.** Non-target colliders go on the drop tick; the target's never goes. Tested on
  every tick of 45 s of play, and against the reconstruction from every snapshot for 40 ticks
  ahead (31,713 tick checks). Rigs restored from snapshots 2, 1 and 0 ticks before the drop and
  1 after drop the same colliders on the same tick. The body follows the server's within 1 cm
  and falls on the server's tick.
- **Momentum grace online** (server decides; the rig agrees in every case; saved runs within
  1 cm of the server):
  - walking, measured short of the target's edge at the drop tick: 0.3 and 0.9 m saved, 1.4 and
    1.9 m fall;
  - sprinting: 0.9 and 1.4 m saved, 2.0 and 2.4 m fall.

  This matches the approved ≈ 1.1 m walking / ≈ 1.6 m sprinting.
- **Restore.** Every collider in `p` minus `g` comes back on the restore tick with the next
  cycle's layout. Hips below the floor on that tick are out on that tick, on the server and in
  the rig.
- **Daralma**, over the wire:
  - the coloured field goes 85 → 73 → 61 → 43 → 31 → 19 → 7 → 4 → 0;
  - cycle 19 (70.5 s) marks the rim's 12 tiles, which still play;
  - cycle 20 shows them grey, and cycle 21 has them gone for good;
  - the four-tile stage has one tile per colour.
- **Final drop.** Cycle 32 has no colour (SON!); the four grey tiles drop at 119.4 s. The server
  decides each elimination tick and the winner; the same tick is a draw.

## Falls, spectating, reconnect

- **Eliminated players spectate:** 1.2 s on the own fall, then the nearest survivor; Q/E cycles
  through survivors with the label "İzleniyor: <name> · Q / E değiştir".
- **Reconnect** keeps the same seat and identity, one body and one handler. From the first
  snapshot it restores:
  - alive/eliminated and the body;
  - stagger (snapshot flag and prediction block);
  - the cycle, its phase and target;
  - the exact layout, present / marked / grey tiles and the Daralma stage;
  - the round clock.
- An eliminated player comes back still out, as a spectator. A late joiner watches with the full
  floor.

## HUD and debug

A normal online player sees only:

- the menu button;
- the roster (name, "Sen", Oyunda / Düştü / Ayrıldı / Yeniden bağlanıyor / İzliyor);
- "Tur N";
- the target chip: swatch + symbol, name, "Bu renge geç!" / "Yerinde kal!", reaction timer and
  bar; in the final drop "SON!" and "Hepsi düşüyor · en son düşen kazanır";
- the big "MAVİ!" call and "DARALIYOR!";
- the countdown, "Düştün!", the spectator label and the winner/draw line;
- the look prompt;
- the 5 s controls line;
- connection chips only when something is wrong.

The local HUD's target chip is shared (`ColorTargetChip`).

The debug panel is hidden and the Esc menu has no debug entry. Automation reads a hidden
`data-colors` attribute.

With `?partyDebug=1` the Esc menu offers "Debug bilgileri":

- target, cycle, phase, time left, which timeline is drawn;
- tiles per colour, present / grey / marked, stage;
- position and fall state;
- FPS, draw calls, triangles, JS/frame, prediction cost, corrections and restored tiles;
- section and snapshot bytes;
- the network lines.

Locally, `?colorDebug=1` keeps P/T/G.

## Performance

**Server**, 3 players and all 85 tiles:

- Headless simulation: step 0.11–0.15 ms average, p99 0.17–0.22 ms. Snapshot build 0.008–0.011 ms.
- Compiled server on this MacBook, 45 s with three SDK clients at 60 Hz input (5 s windows):

| Measure | Result |
| --- | --- |
| Room step average | 0.59–1.34 ms |
| Room step max | 1.9–8.1 ms |
| Snapshot build + send | 0.58–0.82 ms |
| Event-loop p99 | 2.4–3.1 ms |
| CPU | 4–14 % |
| Heap | 22–32 MB |

The spread is macOS power management; Katman Kaosu measured 0.34–1.67 ms on the same machine.

**Client** (Chrome, Metal, headless and headed):

- 60 FPS.
- 22 draw calls, 19.4k triangles.
- JS 0.45–0.53 ms per frame.
- Prediction 0.28 ms per step (0.04–0.06 ms in Node).

The production build's lazily loaded arena chunk is 3.10 MB (+48 KB). Rollup now names it
after `ColorHud`; the lobby still does not load it until an arena opens.

## Real browsers (Chrome, local server, netem proxy)

- **2 clients, 23/23 checks, full round:**
  - lobby order, chat before and after, compact picker, the guest sees the choice;
  - countdown with cycle 1's colours and no target;
  - normal online debug hidden and absent from the menu; the `partyDebug` entry present;
  - identical cycle, target and floor on all 2,255 common snapshot ticks, and identical layout,
    present and marked tiles for all 30 cycles;
  - prediction active; target chip and call shown; DARALIYOR on both screens;
  - the same winner on both screens; back to the lobby.

  Headed: 16/16 (short run), 60 FPS.
- **3 clients, 6/6:** 120° spawns; the fallen player sees "Düştün!", then "İzleniyor: … · Q / E
  değiştir", and Q/E switches between the two survivors; identical floors on all three; the same
  winner on all three.
- **Bad network, 17/17.** Both clients held identical floor, target and cycle on every link:
  50 / 100 / 150 ms, 100 ± 40 ms, 300 / 500 / 800 ms stalls, and a connection reset.
  - No false disconnect: only the 800 ms stall showed "Bağlantı yavaş".
  - The reset showed "Yeniden bağlanılıyor" and came back to the same seats.
  - No hard correction on any link in the browser.
- **Regression, 17/17:** Rooftop, Barn and Katman Kaosu rounds (their own arenas, input moves the
  body, result, lobby). Karışık Barn → Rooftop → Renk → Katman: one cycle with all four modes,
  each arena the announced mode.
- **Local arena:** `?colorDebug=1` renders the target chip and timer and opens the debug panel.

## Remaining before production

- Only 2–3 real people over the Railway link will tell. Nothing here was measured over that
  link, on Windows or Safari, or for feel.
- The real browser rounds reached the four-tile finale (cycle 30) but not the final drop. SON
  and the final drop are covered by simulation, wire and HUD code shared with the approved
  local arena, not by a browser run.
- A stall of 300 ms or more while running to the target can make a player fall (their inputs did
  not arrive) and ends in a hard correction. This is the same trade-off as the other modes.
- The target is sent from the cycle's start (for exact reaction time on every timeline); a
  modified client could read it up to 0.9 s early.
- There are no remote collision proxies: pushes and contacts by other players appear as
  corrections (soft, ≤ 0.44 m measured).
- The server step on a real Railway CPU is not measured.
