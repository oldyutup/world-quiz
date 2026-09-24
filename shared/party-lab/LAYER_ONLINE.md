# Online Katman Kaosu (Phase 2)

Katman Kaosu (`layer_chaos`) is the third online Party Lab mode, next to Rooftop Brawl and
Barn Shootout, for 2–3 players. Its rules, map, camera and scenery are the approved local
ones ([simulation/layers/LAYERS.md](simulation/layers/LAYERS.md)) with no retuning. Rooftop and
Barn gameplay and the network hardening in [NETWORK.md](NETWORK.md) are unchanged.

## Protocol 6

`NET.version` goes from 5 to 6. A protocol-5 page would draw a layer round as the rooftop, and a
protocol-5 server rejects the layer input packet. The join-time version check refuses mismatched
pages ("Party Lab güncellendi"). Deploy Vercel and Railway together; `/health` must report
`"protocol":6`.

What changed on the wire:

- `modes.ts`: `layer_chaos` is a game mode (`MODE_MAP.layer_chaos = "layers"`). The lobby offers
  Çatı Kavgası, Ambar Çatışması, Katman Kaosu and Karışık.
- A new input packet for layer rounds.
- Layer snapshots add a `layers` section, and the recipient's prediction state adds a Float64
  `layers` block.
- Rooftop and Barn packets, snapshots and events are byte-for-byte the same apart from `v`.

## Mixed: three modes

`MixedRotation` (server-owned) plays every mode exactly once per cycle, in shuffled order. The
next cycle is reshuffled and never starts with the mode just played, so no mode repeats back to
back. The lobby shows the next round's mode ("Sıradaki tur") before Ready. That mode is used up
only once its round reaches play; a cancelled countdown keeps it. Choosing Mixed again starts a
fresh cycle. There is no voting.

## Server: `LayerRoundSimulation`

`simulation/layerRound.ts` sits behind the existing `OnlineSimulation` interface. The room swaps
simulations per mode as before; ticks, rounds, events and snapshot sequence come from the shared
`RoomCounters`.

It drives the same `LayerChaosGame` the local arena uses (moved to
`simulation/layers/game.ts`; the local seeded run is bit-identical). The server owns the physics
world, all 297 tile colliders, armTick/goneTick, the collapse schedule, punch legality and
contact, stagger, eliminations, alive count, winner/draw and the round clock.

Per playing tick, in this order:

1. The collapse schedule arms its tiles.
2. Tiles due go GONE.
3. Punch and stagger timers update, and new punches start.
4. Input.
5. Physics.
6. Punch contacts.
7. The hip-supported tile of each standing player arms.
8. Eliminations.
9. The winner is decided.

Phases:

- Countdown, 3 s: bodies are frozen and tiles are immune (inputs are dropped and change nothing,
  bit for bit).
- Play: the local timeline (45 s Hızlanıyor, 70 s Çöküş, 70/76/82/88 s layer collapses).
- Results, 3.5 s, then the lobby, where everyone Readies again (the Party Lab convention).
- Last alive wins. A simultaneous final elimination is a draw. Leaving is a forfeit (result
  code `forfeit`).

Spawns:

- Three players take the three approved L1 spawns.
- Two players take two of them. The layout is mirror-symmetric about the unused spawn, so both
  starts are equivalent. The unused spawn rotates every round, and the two players swap sides
  every other round.

## Input packet (60 Hz)

```
seq, round, moveX, moveZ, jumpPressed, sprintHeld, punchPressed
```

Movement is camera-relative world X/Z. The client normalises it exactly as the validator does
(`normalizeMove`), so the prediction replays the server's numbers. Validation uses strict keys:
tile, hit, elimination, winner, Barn aim and rooftop grab/lift fields are all refused. Jump and
punch are edges, and the punch keeps its sequence for the swing echo. Packets of another mode are
refused. Size: 86 B msgpack (5.2 KB/s). Measured TCP uplink including WebSocket framing and pings:
about 6.0 KB/s per client.

## Tile network state

Every snapshot carries the complete tile field. It is idempotent: a late joiner or a reconnect has
the exact field from its first snapshot, and there are no tile events to miss.

| Field | Content |
| --- | --- |
| `t` | Round tick: the next step's in play, the final one in results |
| `g` | GONE bitset, 297 bits = 38 bytes |
| `a` | Armed-but-standing tiles, 3 bytes each: id uint16 + age (`t − armTick` ≤ 78) |
| `f` | Per slot flags: in match, alive, body, staggered, forfeit |
| `o` | Per slot elimination tick |
| `r` | Result code |

A client derives every stage from this: SOLID, MARKED (collapse warning), WARN, CRACK, BREAK and
GONE. An armed tile's GONE tick follows from `breakTicks`; untouched tiles follow the fixed
collapse schedule. `LayerTileKnowledge` (`simulation/layers/wire.ts`) keeps the arm ticks it has
seen, so it can show a tile's last stages on a timeline behind the newest snapshot.

Measured:

- Section: 66–105 B (38 B bitset + 3 B per armed tile; at most 12 armed with three bots).
- Whole snapshot message on the wire, with the recipient's prediction state: 1,342–1,372 B.
  Barn is 1,410 B and Rooftop 1,179 B.
- Downlink: about 27.9 KB/s per client (TCP payload at the proxy).
- Section build: 15–31 µs.

## Prediction

`network/prediction/layerRig.ts` is the third rig behind the unchanged `LocalPrediction`: same
history, 500 ms / 30-tick window, correction tiers, 300 ms small-correction ease, interpolated
pose and frame clock. The rig has nine bodies and eight joints on its own copy of the 297 tile
colliders. It replays the server's own per-fighter step (`stepLayerFighter`: punch timers and
alternation, stagger posture/mobility/no jump, sprint) and the shared controller. Hits, arming,
eliminations and other players are never predicted. A local punch plays its swing at once (the
echo is deduplicated); pushes and staggers come from the server.

Tile colliders during replay: a tile is present iff the replayed tick is before its GONE tick
(GONE bit, armTick + break time, or the collapse schedule). The predicted body therefore drops
through a tile on the tick the server removes it and never stands on a removed tile.

One Rapier 0.20 trap: a collider that comes back (a replay starting before a GONE tick the
previous prediction had passed) is invisible to ray queries until the next world step. A
zero-length step with active joints throws the body around (158 m/s), so the rig takes that
step with its body disabled, then restores the body. With a forced resurrection on every restore
the average divergence changes from 1.070 to 1.094 mm.

Tiles are drawn on the followed body's timeline: the own predicted ticks while playing, the remote
(interpolated) ticks while spectating. The local player never sees their own tile vanish after
they have already fallen.

Measured (`layerPrediction.test.ts`, scripted 7 s: walk, a tile breaks and they fall to L2 with a
bounce, punch, sprint, running jump into an L2 window, fall again):

| Link | Max correction | Hard | Predicted fall tick vs server | Predicted GONE set = server |
| --- | --- | --- | --- | --- |
| RTT 0 | 0.068 m | 0 | same tick | 417/417 ticks |
| RTT 50 | 0.082 m | 0 | same tick | 414/414 |
| RTT 100 | 0.129 m | 0 | same tick | 412/412 |
| RTT 150 | 0.143 m | 0 | same tick | 408/408 |
| 100 ± 0–60 ms | 0.34 m | 0 | same tick | all |
| 150 ± 0–60 ms | 0.44 m | 0 | same tick | all |
| RTT 70 + 300 ms stall | 0.75 m | 0 | same tick | all |
| RTT 70 + 500 ms stall | 0.41 m | 0 (1 window overflow) | same tick | all |
| RTT 70 + 800 ms stall | 1.26 m | 1 (overflow) | — | all |

The largest corrections are landing impacts after a 5.5 m drop. Between impacts, rig and server
differ by about 0.7 mm per snapshot window. Frame pacing in Chrome while walking: per-frame step
unevenness is 0.2 % at 0 ms and 2.8 % at 70 ± 10 ms, with no frames without a step and no double
steps.

## Falls, elimination, spectating, reconnect

- **Falls** are physical only. The client uses the approved camera: `LayerFall` per character (the
  own body on predicted ticks, others on the remote timeline), a landing marker only while really
  falling, upper layers faded, and a boom of at least 3 m.
- **Elimination**: below the fall line the server marks the player out and disables the body.
  There is no respawn.
- **Spectating**: the eliminated player's last drawn pose keeps falling for 1.2 s. The camera
  then follows the nearest survivor; Q/E cycles through survivors, with the label
  "İzleniyor: <name> · Q / E değiştir". A late joiner spectates from its first snapshot.
- **Reconnect** uses the same seat and identity, one body and one handler. From the first snapshot
  it restores alive/eliminated, the body, stagger (snapshot flag and own prediction block), the
  round clock and the exact tile field. An eliminated player comes back still out, as a spectator.

## HUD and debug

A normal online player sees only:

- the menu button;
- the roster (name, "Sen", Oyunda / Düştü / Ayrıldı / Yeniden bağlanıyor / İzliyor);
- the elapsed clock;
- the countdown;
- the Hızlanıyor / Çöküş banner;
- "Düştün!", the spectator label and the winner/draw line;
- the look prompt;
- a 5 s controls line;
- connection chips only when something is wrong.

The large debug panel is absent. Its element is hidden and empty, and the Esc menu has no debug
entry. Automation reads a hidden `data-layers` attribute, as the Barn arena does with
`data-combat`.

With `?partyDebug=1` the Esc menu offers "Debug bilgileri":

- layer, tile counts, break time, which tile timeline is drawn;
- position, fall state and camera;
- FPS, draw calls, triangles, JS/frame, prediction cost and corrections;
- tile section and snapshot bytes;
- the network lines.

In the local arena, `?layerDebug=1` keeps P/T/G and the trace hook.

## Performance

**Server**, 3 players and all 297 tiles:

- Headless simulation with bots: step 0.147 ms average, p99 0.26 ms, max 1.2 ms.
- Snapshot build + encode for three recipients: 0.023 ms.
- Standalone compiled server on this MacBook, 40 s of play with 3 SDK clients at 60 Hz input
  (5 s windows):

| Measure | Result |
| --- | --- |
| Room step average | 0.34–1.67 ms |
| Room step max | 1.5–3.9 ms |
| Snapshot build + send | 0.42–0.53 ms |
| Event-loop p99 | 1.7–3.5 ms |
| CPU | 4–19 % |
| Heap | 23–31 MB |

The spread in the room step is macOS power management, not the game: the identical replay costs
0.2 ms per step when run flat out and 0.44–1.86 ms when paced at 60 Hz. Parked tiles cost nothing
(0.15–0.18 ms per step with 0–30 GONE). The scenery is client-only: the server build contains no
scenery code or kit.

**Client** (Chrome, Metal):

- 60 FPS headless and headed.
- 26–37 draw calls, 34–46k triangles.
- JS 0.56–0.59 ms per frame.
- Prediction 0.27–0.32 ms per step.

## Real browsers (Chrome, local server, netem proxy)

- **2 clients, 20/20 checks:** lobby selector order, chat before and after, countdown, identical
  tile states (70 common ticks, 0 differences), identical authoritative positions, prediction
  active, clock, Hızlanıyor and Çöküş banners on both, collapse rings identical, winner, Düştü,
  back to the lobby.
- **3 clients, 19/19 checks, headless and headed:** the three spawns, identical tiles and
  positions across three, normal online debug hidden and absent from the menu, the menu is not a
  pause, `partyDebug` panel, Düştün! → İzleniyor with Q/E, winner on all screens.
- **Bad network, 29/29 checks.** Both clients held identical tiles on every link: 88–103 common
  ticks each, 0 differences. None of the stalls showed a false disconnect: 500 and 800 ms stalls
  showed "Bağlantı yavaş", and the connection reset reconnected to the same seats. There were no
  hard corrections at 50/100/150 ms or 100 ± 40 ms. One 300 ms stall while walking produced 2 hard
  corrections per client (1.23 m): the known latest-wins mailbox trade-off (BARN_ONLINE.md).
- **Regression, 8/8:** Rooftop and Barn rounds (their arenas, intent moves the body, results,
  lobby), and Mixed Barn → Rooftop → Layer → Rooftop with each arena matching the announced mode.

## Remaining before production

- Only 2–3 real people over the Railway link will tell. Nothing here was measured over that link,
  on Windows or Safari, or for feel.
- A stall of 300 ms or more while moving can still end in one hard correction, and past 500 ms
  prediction suspends. This is the same trade-off as Rooftop and Barn.
- There are no remote collision proxies: pushes by other players appear as corrections (tested:
  soft).
- The server step on a real Railway CPU is not measured.
