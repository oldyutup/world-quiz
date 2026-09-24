# Network reliability and realtime chat (Rooftop online)

Audit and fixes made before Online Barn (the wire version is now **5**: Barn Shootout
went online without changing anything below — see [BARN_ONLINE.md](BARN_ONLINE.md)).
Rooftop gameplay (movement, Punch, Grab,
Lift, KO, elimination, camera, bots, local mode) and all combat constants are
unchanged. Current prediction details stay in [PREDICTION.md](PREDICTION.md);
[ONLINE.md](ONLINE.md) is the historical 4B.1 report.

## Paths (as audited)

| # | Path | Where |
| --- | --- | --- |
| 1 | WebSocket/Colyseus connection: HTTP matchmake, then one WebSocket per room | `session.ts` `connect()` → `@colyseus/sdk` `Client.create/joinById`; server `server.ts` (`WebSocketTransport`), `PartyRoom.onAuth/onJoin` |
| 2 | Input send: one packet per rendered frame that owes ≥1 fixed tick (≤60/s) | `OnlineArena` `useFrame` → `session.sendInput` → `room.send("input")` → `InputMailbox.accept` (latest wins, edges ORed) |
| 3 | Snapshot receive: custom `snapshot` message every 3rd 60 Hz tick (20 Hz) outside the lobby | `PartyRoom.tick` → `client.send("snapshot")` → `session` → `SnapshotBuffer.push` → `OnlineArena` `sample()` / `LocalPrediction.reconcile` |
| 4 | Heartbeat/stale detection | Server: ws protocol ping every 3 s, terminate after 2 unanswered (6–9 s). Client: **none before this change**; now 1 Hz app ping + 250 ms health check |
| 5 | Connection-lost UI | Only on an actual socket close (`room.onDrop`) → "Bağlantı kesildi. Yeniden bağlanılıyor…" |
| 6 | Reconnect grace | Server `onDrop` → `allowReconnection(client, 15 s)`; seat, slot and body kept, input neutralized |
| 7 | Reconnect attempt | SDK auto-reconnect on close codes 1001/1005/1006/4010; 10 tries, 0.5–2 s backoff; session gives up after 16 s |
| 8 | Room rejoin | Same `Room` object reused (`skipHandshake`), full state resent; handlers are registered once per room, so no duplicates |
| 9–11 | Chat send / broadcast / receive | `sendChat` → `room.send("chat")` → `ChatLimiter` + `chatText` → `appendChat` into Schema `messages` (bounded 40) → next state patch (≤100 ms) → SDK `onStateChange` |
| 12 | React rendering | `copyState` builds **new** `players`/`messages` arrays every patch → `setSnapshot` → `PartyLobby` |

## Root causes found

### Chat "appears only after I send" — UI scroll-follow, not delivery

Measured, not assumed: over real sockets every peer's decoded state held each message
4–100 ms after sending, including 70 messages past the 40 cap, and across 6
drop/reconnect cycles with messages sent during the drop (0 mismatches). React state
was never mutated in place (`copyState` allocates new arrays; now asserted by test).

The lobby kept a `followMessages` ref that **every** scroll event rewrote with
`distance < 48 px`, and auto-scrolled only if that flag was set **or the newest message
was the reader's own**. In real Chrome:

- one mouse-wheel notch up (100 px) → the friend's next message rendered 176 px below
  the fold with no indication; the reader's own send force-scrolled and "revealed" it;
- past the 40-message cap, removing the top message made the browser's scroll anchoring
  emit a scroll event that flipped the flag off without any reader action (an incoming
  message was left 75 px below the fold).

Fix (`chatFollow.ts`, `PartyLobby.tsx`, CSS): `overflow-anchor: none` on the log; only a
reader-initiated scroll (wheel/touch/key/pointer within 1 s) can stop following, any
scroll that reaches the end resumes it; pinning happens in a layout effect (same paint);
a ResizeObserver keeps a follower pinned when the log is re-shown or resized; unseen
incoming messages are counted into a **"↓ N yeni mesaj"** button. Still event-driven, no
polling. Chat stays Schema-based (≤100 ms patch cadence is fine for chat).

### Random "connection lost" after lag — Colyseus flood guard tripped by legitimate bursts

`maxMessagesPerSecond = 90` with 60 Hz input. Colyseus counts in a **fixed 1 s window**
and, when exceeded, detaches the client silently (no more snapshots, input ignored,
player shown disconnected) and closes the socket with **4002** only after the 15 s
reconnect grace. The SDK never reconnects from 4002, so the player forfeits. A ~1 s
uplink stall queues ~60 inputs that TCP then delivers together with the live stream:
measured **91 in one window** → detached, frozen for 14 s, then `leave 4002`.

Fix: cap 300 (still a flood guard; a 350-message burst is still detached — tested), and
the client coalesces input to 10/s (newest state, pressed edges kept) while more than
30 inputs (~0.5 s) are unacknowledged, so even multi-second stalls cannot approach it.

### Stutter/rubber-banding under jitter — prediction window too small

With the pending-input window at 300 ms / 18 ticks and 300 ms snapshot staleness, RTT
150 + 0–60 ms jitter overflowed, and RTT 200 + 0–80 ms suspended prediction 19 times in
8 s, each snapping the local rig 1.3–1.7 m back to the delayed authoritative pose.
500 ms / 30 ticks: zero suspends and ≤0.16 m frame steps up to RTT 300 + 60 ms jitter or
RTT 150 + 150 ms jitter (≈20 replay ticks per snapshot worst case, 6–8 at 70 ms RTT).
Stalls ≥300 ms still correct once afterwards when input changed during the stall: the
latest-wins server mailbox cannot apply inputs late. Raising the server's 300 ms
stale-input threshold showed no benefit in the same harness, so it is unchanged.

### Remote players teleporting after short stalls — playout clock jumped

TCP releases a stall's snapshots as one burst and the render clock jumped to the new
target: 300/500/800 ms stalls skipped 183/383/683 ms of motion in one frame. The clock
now follows the same target at 0.5–2× (snap only beyond 1 s; 24-frame buffer): max
per-frame step 13–17 ms, ±80 ms jitter skips 67 → 3 ms, fewer held frames, ~15 ms lower
mean presentation latency. It never extrapolates past the newest snapshot.

## Thresholds before → after

| Item | Before | After |
| --- | --- | --- |
| Colyseus message cap | 90/s (fixed window, silent detach + 4002) | 300/s; client coalesces to 10/s after 30 unacked inputs |
| Client stale/degraded detection | none (UI said "Sunucuya bağlı" while frozen) | DEGRADED if no snapshot for 500 ms in arena phases, no server message for 2.5 s, or two consecutive RTT samples >350 ms; held 1.5 s; a late health tick (client busy) is never blamed on the link |
| Silent dead socket | browser TCP timeout (can be minutes) | 10 s of total silence → `close(4010)` → normal SDK reconnect to the same seat |
| Connection-lost UI | on socket close | unchanged (a real close is a real failure); stalls now show "Bağlantı yavaş … Bağlantı kesilmedi" |
| Prediction pending window / snapshot staleness | 300 ms / 18 ticks, 300 ms | 500 ms / 30 ticks, 500 ms |
| Remote interpolation delay | 100 ms, jump to target, 12 frames | 100 ms, 0.5–2× follower, snap >1 s, 24 frames |
| Server stale input → neutral | 300 ms | 300 ms (unchanged) |
| Server ws keepalive | 3 s × 2 (6–9 s) | unchanged (documented) |
| Reconnect grace / client give-up | 15 s / 16 s, SDK 10 tries 0.5–2 s | unchanged |
| App ping | none | 1/s, ~30 B; server loop stats only with `?partyDebug=1` |
| Wire version | 3 | 4 (new `ping`/`pong`; mismatched deploys are refused at join) |

## Diagnostics

`?partyDebug=1` (development **and** production, opt-in; nothing by default) shows in
the lobby and arena, refreshed every 0.5 s:

- `net`: RTT current/avg/jitter/max (last 20 pings), clock offset;
- `snap`: snapshots/s, age, longest interval (5 s), sequence gaps, rejected duplicates,
  inputs/s and coalesced inputs;
- `link`: drops, reconnects, dead-socket resets, last close code/reason, last outage,
  server silence;
- `client`: max frame time, long tasks (Chromium);
- `srv` (from pong): fixed-step avg/max, max gap between steps, catch-up steps, snapshot
  build+send, event-loop delay p99/max (net of the 10 ms sampling interval), GC max, CPU %,
  heap, rooms;
- `chat`: server→client latency (clock-offset corrected), client→screen, server
  receive→patch.

Server logs (Railway): `drop <session> code=<n>`, `reconnect … after=<ms>`,
`leave … code=<n>`, and a warning for any 5 s window with a step >8 ms, a step gap
>100 ms, event-loop delay >100 ms or GC >50 ms. Nicknames are never logged.

Read a lag report as: RTT spike → `net`; freeze with fresh RTT → `snap` age/gaps; server
at fault → `srv` gap/loop delay; client hitch → `client` frame/long task; correction
→ footer `düzeltme …/sert`; disconnect → `link` close code.

## Measurements

- Server loop, live 3-player match with SDK clients in the same process: step
  **1.28 ms avg / 4.47 ms max**, snapshot build+send 0.56 ms, against a 16.67 ms budget.
  Browser run (server alone): step 0.2–0.4 ms avg, ≤2.4 ms max; event-loop delay p99
  ~1.4 ms; CPU 1–6 %; heap 26–32 MB. One 20 ms step appears at round start (logged).
  CPU cannot plausibly explain multi-hundred-ms lag.
- Production path from this Mac: ICMP to the Railway edge 54.7 ms (±3); HTTP through
  edge→origin p50 71 / p99 77 ms (one earlier batch had a 565 ms outlier). Origin is
  close to the edge (European region), so region is not the problem for Turkey.
- Chat: SDK peers 70–100 ms (one patch interval); real sessions 96–100 ms to all three;
  3 real Chrome clients send→visible p50 67 / p95 116 / max 122 ms, 0 missed across
  A→B, B→A, rapid A→B→A, past the cap, during Ready changes and with Controls open;
  RTT 100 + 40 ms jitter 158–249 ms; client receive→screen 2–4 ms.
- Real Chrome live match through `scripts/netem-proxy.mjs`: RTT 50/100/150, 0–60 ms
  jitter and 300 ms stalls kept "Sunucuya bağlı" with 0 hard corrections; 500–800 ms
  stalls showed "Bağlantı yavaş" and recovered; a TCP reset reconnected to the same seat
  in ~590 ms mid-match. A 2.2 s arena-load stall (software WebGL) no longer shows as a
  slow link.

## Bad-network testing

```sh
npm --prefix servers/party-lab run dev                     # :2567
node servers/party-lab/scripts/netem-proxy.mjs --listen 2600 --target 127.0.0.1:2567 --rtt 100 --jitter 30
VITE_PARTY_LAB_SERVER_URL=ws://127.0.0.1:2600 npm run dev -- --port 5174   # then /party-lab?partyDebug=1
curl 'http://127.0.0.1:2601/stall?ms=600'   # or /set?rtt=150&jitter=40, /drop, /status
```

## Railway (verify manually; nothing was changed remotely)

- **Region**: measured timings indicate Europe; confirm in Service → Settings → Region
  (EU West suits Turkey; do not add regions).
- **Replicas: exactly 1.** Rooms and codes live in one process's memory.
- **Serverless / App Sleeping: off.** A sleeping service drops sockets and cold-starts.
- Restart policy `ON_FAILURE` (10 retries) and health check `GET /health` →
  `{"ok":true,"service":"party-lab","protocol":6}` (this change shipped 4; Online Barn made it 5, online Katman Kaosu 6).
- Deploys/restarts end every room: avoid deploying during play.
- Metrics: CPU (a vCPU pinned near 100 % would show as `srv` step gaps), memory
  (steady ~30 MB heap), network egress, and the logs above (`drop code=1006` = network
  loss, `1001` = tab closed/navigated, `4010` = client-side recovery).
- Deploy frontend (Vercel) and server (Railway) together: a client refuses a server with
  another protocol and vice versa ("Party Lab güncellendi" message).

## Verdict

Primarily **app bugs** (chat scroll-follow; flood-guard disconnects after ordinary
stalls; prediction/playout thresholds that turned normal jitter and short stalls into
teleports; no stale/degraded state), amplified by **normal network variability**
(Wi-Fi jitter/stalls on players' side). Railway region/CPU are not implicated by the
measurements; its sleep/replica settings still need a manual check.
