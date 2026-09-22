# Party Lab server (Phase 4B.2)

Independent, single-process Node.js + Colyseus lobby and authoritative Rapier
gameplay for 2–3 real players. No Supabase, accounts, database or host authority.
See [ONLINE.md](../../shared/party-lab/ONLINE.md) for the simulation, protocol,
measurements, file inventory and verification limits.
See [PREDICTION.md](../../shared/party-lab/PREDICTION.md) for current input
acknowledgements, local prediction, bandwidth and latency measurements.

## Run locally

Node **22+** is required (verified on Node 24.15.0). From the Torble repository:

```sh
npm --prefix servers/party-lab ci
npm --prefix servers/party-lab run dev
```

In another terminal, from the repository root:

```sh
npm ci
npm run dev -- --host 0.0.0.0 --port 5173 --strictPort
```

MacBook host: open **http://localhost:5173/party-lab**, or use the LAN URL
printed by Vite. Windows on the same Wi-Fi/LAN: open
**http://192.168.1.173:5173/party-lab** (the Mac's address measured during this
implementation; replace it if Vite prints a different address). Create/join the
same room and have everyone press **Hazır**. No software installation is needed
on Windows beyond its browser. Use the LAN URL on the Mac as well when sharing
invite links; a localhost invite only works on that computer.

The frontend development default follows the page hostname: a page at
`http://192.168.1.173:5173` connects to `ws://192.168.1.173:2567`.
Localhost/127.0.0.1 also work. Leave `VITE_PARTY_LAB_SERVER_URL` unset for this
behavior. An explicit root `.env.local` override always wins; remove a stale
loopback override before LAN testing and restart Vite.

Server defaults are `HOST=0.0.0.0`, `PORT=2567`. Optional server settings go in
`servers/party-lab/.env`. Both TCP ports 5173 and 2567 must be reachable from
Windows; allow the Node processes on the Mac's local-network firewall if needed.
No router port forwarding is required. Guest Wi-Fi client isolation can block LAN
peers. Nothing is deployed by these commands. For an installed checkout, skip `ci`.

Matchmaking and WebSocket upgrades validate browser origins. Development allows
the same hostname as the requested server (plus interchangeable loopback names)
on Vite ports 5173/5174/5175/4173. Set `PARTY_LAB_ALLOWED_ORIGINS` to a comma-separated
list of exact origins for other setups. Production requires that allowlist and
an explicit frontend endpoint. Non-browser SDKs without Origin still require
Colyseus seat reservations/reconnect credentials. These are local development
policies, not a finished public hosting/admission-abuse system.

For a compiled long-lived process:

```sh
npm --prefix servers/party-lab run build
npm --prefix servers/party-lab start
```

## Protocol and policies

- SDK `create("party_lab", { intent: "create", nickname })` creates a real room.
- Server-generated room IDs are six characters from
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. No I/O/0/1. Codes are claimed synchronously
  in this process, collision-checked, and released on disposal. This allocator
  must be replaced with an atomic shared allocator before multi-process hosting.
- Join with `joinById(code, { intent: "join", code, nickname })`. Codes are trimmed
  and uppercased on both sides. Rooms are private (no public room listing).
- `/party-lab?room=ABC234` prefills the code only. Joining requires a nickname
  and an explicit action. Nicknames use NFC, 3–16 Unicode letters/numbers/_/-.
  Duplicate nicknames are allowed: identity is Colyseus's generated session ID.
- `maxClients = 3` includes pending seat reservations and reconnecting users.
  The room also validates its roster before admitting a player. A reconnecting
  seat is never handed to a fourth player. Initial reservations expire after 10s.
- Unexpected disconnect: `connected=false`, reserve the seat for **15s** after
  detection. Heartbeats run every 3s with two retries. A running SDK retries with
  bounded backoff; successful recovery keeps the same identity and state.
- Explicit leave removes the player immediately. Creator departure has no
  special effect. No host election is needed. Empty rooms automatically dispose
  after outstanding reservations expire; roster and chat are cleared.
- Reconnect credentials stay in SDK memory only and are never logged by our
  code or stored in local/session storage. Reload/closed tabs do not restore a
  session: the old seat expires within the grace policy, then join again.
- Schema patches at 100ms synchronize room code, roster, ready/round state and
  chat history. Compact custom messages carry 20 Hz articulated snapshots with
  processed-input acknowledgements and recipient-only velocity/controller state.
  Remote players are interpolated; ordinary local locomotion is predicted and
  reconciled without client combat authority.
- `chat` accepts a **string**, at most **280 UTF-16 code units**. Trim/NFC,
  normalize line breaks/tabs, reject empty/control/bidi-spoofing input. HTML-like
  text stays literal; React renders text nodes, not HTML or Markdown.
- **4 chat attempts per sliding 5s per session**, including invalid messages.
  **40** messages retained, oldest evicted. Sender ID, nickname, message ID, and
  timestamp are server supplied. No message persistence or body logging.
- Unknown message types are rejected with a fixed notice. Transport payloads
  cap at **2048 bytes**; Colyseus additionally caps client traffic at 90 messages/s (normal input is at most 60 Hz).
- Local Phase 3 arena is still available from the landing page, with bots and
  rounds unchanged. Leave the online lobby to enter it. Online has no bots.

## Dependencies

Pinned runtime: `@colyseus/core@0.18.15`, `@colyseus/ws-transport@0.18.2`,
`@colyseus/schema@5.0.33`, `express@5.2.1`, `@dimforge/rapier3d-compat@0.20.0`.
The transport imports Express even though its peer metadata calls it optional.
Test SDK: `@colyseus/sdk@0.18.3`; tooling: `tsx@4.22.3`, `typescript@5.9.3`,
`@types/node@25.6.0`. Root frontend adds only `@colyseus/sdk@0.18.3`.
Both lockfiles pin resolved transitive dependencies; unrelated root versions stay unchanged.

References checked for this implementation:
[Room lifecycle](https://docs.colyseus.io/room/lifecycle),
[reconnection](https://docs.colyseus.io/room/reconnection),
[schema definitions](https://docs.colyseus.io/state/schema).

## Verification

```sh
npm --prefix servers/party-lab run typecheck
npm --prefix servers/party-lab test
npm --prefix servers/party-lab run build
npx tsc --noEmit --incremental false
node --import tsx --test src/party-lab/input/*.test.ts src/party-lab/audio/*.test.ts src/party-lab/scene/*.test.ts src/party-lab/network/*.test.ts
npx vite build --outDir /tmp/party-lab-build
```

Tests bind an ephemeral loopback port and use real independent SDK/WebSocket
clients. They cover concurrent capacity, fourth-player rejection, malformed
admission, duplicate display names, shared roster/chat, rate limits, bounded
history, creator departure, empty-room disposal, automatic/manual reconnection,
expired/duplicate reconnect tokens, and reserved-seat expiry (takes ~17 seconds).

Manual check: open four Party Lab tabs; create in one, invite/code-join two;
compare rosters and exchange chat; fourth join must fail. Leave the creator and
verify two remain. Close a participant tab to see the disconnected seat expire.
Finally return to the landing page and enter the local three-bean arena.

This is a local foundation. In-memory data is lost on restart. Internet hosting,
TLS, deployment-wide admission abuse controls and multi-process scaling are
deliberately undecided. Phase 4B.2 predicts only local locomotion/jump and harmless
punch presentation; constrained combat states continue to follow authority.
