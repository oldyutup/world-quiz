# Party Lab — friends-only deployment

```
Browser ── https://torble.com/party-lab ──► Vercel
                                            ├─ middleware.ts (private gate, /party-lab only)
                                            └─ static SPA → src/party-lab (isolated root)
Browser ── wss://<service>.up.railway.app ─► Railway: one Node process
                                            (Colyseus + authoritative Rapier, in-memory rooms)
```

Nothing here deploys automatically. The normal Torble site is unchanged: Party Lab is not
linked anywhere, the middleware runs only for `/party-lab` and `/party-lab/`, and every
other route is served exactly as before.

## 1. Secret

```sh
openssl rand -hex 32
```

64 hex characters (URL-safe). Put it only into Vercel's `PARTY_LAB_ACCESS_SECRET`. Never
commit it, never put it in a `VITE_` variable (those are copied into the public JS bundle),
and never into `.env*` files that get committed. The gate refuses secrets shorter than 32
characters or containing anything but `A-Z a-z 0-9 _ -`, and then admits nobody.

## 2. Railway (realtime server)

The server compiles `../../shared/party-lab` (the single physics/map source). Railway's
**Root Directory** uploads only that directory, so it must stay **empty (repository root)**;
`servers/party-lab` as Root Directory fails with missing `shared/` files. The config file
keeps every command scoped to the server package, and nothing from the root Torble app is
installed or built.

1. New Project → Deploy from GitHub repo → this repository. Branch: the branch that
   contains Party Lab (`party-game-prototype` today; `main` once merged).
2. Service → Settings:
   - Root Directory: *(empty)*
   - Config as code → Railway Config File: `/servers/party-lab/railway.json`
3. Service → Variables:

   | Variable | Value | Purpose |
   | --- | --- | --- |
   | `RAILPACK_INSTALL_CMD` | `npm ci --prefix servers/party-lab --include=dev` | Install only the server's lockfile (dev deps are needed for `tsc`). |
   | `RAILPACK_NODE_VERSION` | `24` | Node version the server is tested on (needs ≥ 22). |
   | `NODE_ENV` | `production` | Enables the production origin policy. |
   | `PARTY_LAB_ALLOWED_ORIGINS` | `https://torble.com,https://www.torble.com` | Exact browser origins allowed to matchmake and open WebSockets. No trailing slash. |

   Do not set `PORT` (Railway injects it) or `HOST` (defaults to `0.0.0.0`).
4. Deploy. `railway.json` supplies:
   - build: `npm --prefix servers/party-lab run build`
   - start: `npm --prefix servers/party-lab start`
   - health check: `GET /health`, restart on failure, watch paths `servers/party-lab/**` and `shared/party-lab/**`
   - one replica (default). Do not add replicas/regions: rooms and room codes live in one process's memory.
5. Settings → Networking → **Generate Domain**. If asked for a port, use the one in the log
   line `Party Lab authoritative server listening at ws://0.0.0.0:<PORT>`.
6. Check `https://<domain>/health` → `{"ok":true,"service":"party-lab","protocol":7}`.
   The protocol must match the deployed frontend: deploy Railway and Vercel together
   when it changes. Settings to confirm (single replica, no App Sleeping, region, logs)
   are listed in [NETWORK.md](../../shared/party-lab/NETWORK.md#railway-verify-manually-nothing-was-changed-remotely).
   The log also prints `Party Lab browser origins: https://torble.com, https://www.torble.com`.

The process exits at startup (so the deploy fails and the old one keeps running) if
`NODE_ENV=production` has no allowlist or an allowlist entry is not an exact origin.

## 3. Vercel (frontend + gate)

Project → Settings → Environment Variables (Production; add Preview only if you test previews):

| Variable | Value | Purpose |
| --- | --- | --- |
| `VITE_PARTY_LAB_SERVER_URL` | `wss://<domain from step 2.5>` | Public game-server URL, baked into the Party Lab chunk at build time. Must be `wss://` (or `https://`) on an HTTPS page. |
| `PARTY_LAB_ACCESS_SECRET` | output of `openssl rand -hex 32` (mark Sensitive) | Server-side only. Invite secret and HMAC key for access cookies. |
| `PARTY_LAB_ACCESS_VERSION` | `1` (optional) | Mixed into the cookie signature. Change it to revoke cookies but keep the link. |

Environment variables apply to new deployments only: redeploy after any change.
The Party Lab code must be on Vercel's production branch (it is not on `main` yet). Merge
it only after the variables exist; before that the gate fails closed (404 for everyone).

## 4. Order

1. Generate the secret (keep it private).
2. Railway service → variables → deploy → domain → `/health` OK.
3. Vercel variables (with the Railway `wss://` URL).
4. Bring Party Lab to Vercel's production branch → production deploy.
5. Run the checklist below, then send links.

## 5. Links to send

- `https://torble.com/party-lab?access=<SECRET>`
- Room invite for someone who has never opened Party Lab:
  `https://torble.com/party-lab?room=ABC123&access=<SECRET>`

The gate sets the cookie and redirects (303) to `/party-lab` or `/party-lab?room=ABC123`.
Only `access` is removed; `room` and every other parameter stay, so the room code is
prefilled as before. Already-admitted browsers can use the normal in-game invite link
(`/party-lab?room=ABC123`). The cookie is per host: use `torble.com` consistently
(`www.torble.com` is a separate cookie jar).

## 6. Access model

- `GET /party-lab?access=<correct>` → `Set-Cookie: party_lab_access=<expiry>.<HMAC>`;
  `HttpOnly; Secure; SameSite=Lax; Path=/party-lab; Max-Age=2592000` (30 days), then 303.
- The cookie holds an expiry and `HMAC-SHA256(secret, "party-lab-access|<version>|<expiry>")`,
  never the secret. It is not readable by page scripts, not sent to other Torble paths, and
  independent of Torble accounts (Party Lab stays nickname-only).
- Missing/wrong secret, bad/expired/forged cookie → `404` page "Bu test şu anda davetle
  kullanılabilir." (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`); an invalid
  cookie is cleared. A valid cookie with a stale `access` value just redirects to the clean URL.
- Secret comparison is constant-time over SHA-256 digests; cookie verification uses
  `crypto.subtle.verify`.
- Search: gate responses and all `/party-lab` responses carry `X-Robots-Tag: noindex, nofollow`
  (`vercel.json`); the Party Lab page also adds `<meta name="robots" content="noindex, nofollow">`.
  Nothing is added to a sitemap or robots.txt (listing the path there would advertise it).

## 7. Revoke

| Goal | Do | Effect |
| --- | --- | --- |
| Revoke everything | New `PARTY_LAB_ACCESS_SECRET`, redeploy | Old links **and** all issued cookies stop working (the cookie HMAC is keyed by the secret). |
| Revoke cookies, keep the link | Bump `PARTY_LAB_ACCESS_VERSION` (1→2), redeploy | Everyone must reopen the access link. |
| Close Party Lab now | Delete `PARTY_LAB_ACCESS_SECRET`, redeploy | Fails closed: nobody can enter. |
| End running matches | Restart or remove the Railway service | Rooms are in memory; the web gate does not disconnect open WebSockets. |

## 8. Make Party Lab public later

Delete `middleware.ts` and `edge/`, remove `"middleware.ts", "edge"` from the root
`tsconfig.json` `include`, remove the two `/party-lab` `X-Robots-Tag` entries from
`vercel.json` and the robots `<meta>` effect in `src/party-lab/PartyLabRoot.tsx`, then delete
the `PARTY_LAB_ACCESS_*` variables. No gameplay or server change. Linking Party Lab from the
Torble UI is a separate decision.

## 9. Verification checklist

```sh
curl -s https://<domain>/health
curl -sI https://torble.com/party-lab | grep -iE '^HTTP|x-robots|cache-control'   # 404, noindex, no-store
curl -sI "https://torble.com/party-lab?access=wrong" | head -1                     # 404
curl -sI "https://torble.com/party-lab?room=ABC123&access=<SECRET>" | grep -iE '^HTTP|^location|^set-cookie'
# 303, location: /party-lab?room=ABC123, set-cookie: party_lab_access=...; HttpOnly; Secure; SameSite=Lax
curl -sI https://torble.com/ | grep -i x-robots                                    # nothing: Torble unchanged
```

In a browser: private window → `/party-lab` shows the invite-only text; the access link
opens Party Lab at the clean URL; DevTools → Cookies shows `party_lab_access` (HttpOnly,
Secure, Lax, path `/party-lab`); create a room (DevTools → Network → WS to `wss://<domain>`);
a second browser uses the room+access link, sees the prefilled code and joins; both press
**Hazır**; the rooftop round plays; reopening `/party-lab` later works; `https://torble.com/`
looks exactly as before.

## 10. Local development

Vite (`npm run dev`, `vite preview`) never runs Vercel middleware, so `/party-lab` stays open
on localhost and LAN exactly as before; there is no bypass code in the gate, so production
has no bypass. The server's local defaults are unchanged (`HOST=0.0.0.0`, `PORT=2567`,
same-host origin policy). Gate tests: `node --import tsx --test edge/*.test.ts`.
`vercel dev` would run the gate locally (requires a linked Vercel project).

## 11. Known limitations

- The gate protects the page, not the realtime server. The Railway URL is public inside
  the Party Lab JS chunk; browsers on other sites are rejected by the origin allowlist, but
  a non-browser client can still create rooms or join one whose code it knows. Rooms are
  private and unlisted. A signed admission ticket from Vercel to Railway would close this.
- Bundled JS/CSS/audio assets are public files; only the page entry is gated.
- The secret appears in the invite message, the first visit's browser history and Vercel
  request logs (query string). Rotate it when the test ends.
- One in-memory process: a redeploy/restart ends every room. Redeploying the frontend or
  server separately is safe: an open page from an older build that tries to join a server with a
  different protocol gets "Party Lab güncellendi. Sayfayı yenileyip tekrar dene."
- Railway health checks run at deploy time only.
