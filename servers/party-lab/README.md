# Party Lab lobby server (Phase 4A)

Independent, single-process Node.js + Colyseus lobby. No Supabase, accounts,
database, Rapier, positions, game simulation, or host authority.

## Run locally

Node **22+** is required (verified on Node 24.15.0). From the Torble repository:

```sh
npm --prefix servers/party-lab ci
npm --prefix servers/party-lab run dev
```

In another terminal, from the repository root:

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 5173
```

Open **http://127.0.0.1:5173/party-lab**. The lobby server is
**ws://127.0.0.1:2567**; HTTP matchmaking uses the same host/port.
Vite may choose another port if 5173 is occupied; use its printed URL.
For an installed checkout, skip the `ci` commands.

Server defaults work without an env file. To override them, copy this directory's
`.env.example` to `.env` and run commands from this directory. `HOST` defaults to
loopback; nothing is deployed or publicly exposed by these instructions.

Frontend: optionally copy the `VITE_PARTY_LAB_SERVER_URL` entry from root
`.env.party-lab.example` into root `.env.local`, then restart Vite. Only development
has a localhost fallback. Production without a configured endpoint shows a clear
unavailable message; the local arena remains usable. No hosting choice is made.

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
- Schema patches at 100ms synchronize only room code, roster, and chat history.
  The browser takes immutable snapshots on state changes, never per render frame.
- `chat` accepts a **string**, at most **280 UTF-16 code units**. Trim/NFC,
  normalize line breaks/tabs, reject empty/control/bidi-spoofing input. HTML-like
  text stays literal; React renders text nodes, not HTML or Markdown.
- **4 chat attempts per sliding 5s per session**, including invalid messages.
  **40** messages retained, oldest evicted. Sender ID, nickname, message ID, and
  timestamp are server supplied. No message persistence or body logging.
- Unknown message types are rejected with a fixed notice. Transport payloads
  cap at **2048 bytes**; Colyseus additionally caps client traffic at 10 messages/s.
- Local Phase 3 arena is still available from the landing page, with bots and
  rounds unchanged. Leave the online lobby to enter it. Online gameplay is disabled.

## Dependencies

Pinned runtime: `@colyseus/core@0.18.15`, `@colyseus/ws-transport@0.18.2`,
`@colyseus/schema@5.0.33`, `express@5.2.1`.
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
node --import tsx --test src/party-lab/scene/*.test.ts
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
TLS/origin policy, deployment-wide admission abuse controls, and multi-process
scaling are deliberately undecided. Physics networking belongs to a later phase.
