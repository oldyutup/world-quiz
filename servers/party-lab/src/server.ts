import { allowedOrigin } from "./origin.js";
import { createServer } from "node:http";
import { createEndpoint, createRouter, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { NET } from "../../../shared/party-lab/network/protocol.js";
import { PartyRoom } from "./PartyRoom.js";

/** Liveness for the host's health check. No rooms, players or configuration. */
const health = createEndpoint("/health", { method: "GET" }, async () =>
  Response.json(
    { ok: true, service: "party-lab", protocol: NET.version },
    { headers: { "Cache-Control": "no-store" } }
  )
);

export function createPartyServer() {
  const httpServer = createServer();
  const server = new Server({
    transport: new WebSocketTransport({
      server: httpServer,
      maxPayload: 2048,
      // Protocol-level ping every 3 s; a socket with two unanswered pings is terminated
      // on the third check, i.e. after 6–9 s without any pong. Browsers answer pings
      // natively (not throttled with the tab). The seat is then held RECONNECT_SECONDS.
      pingInterval: 3000,
      pingMaxRetries: 2,
      verifyClient: (info: {
        origin: string;
        req: { headers: { host?: string } };
      }) => allowedOrigin(info.origin, info.req.headers.host),
    }),
    greet: false,
    gracefullyShutdown: false,
  });
  // Served on the same port as matchmaking/WebSockets; Colyseus adds its own routes to this router.
  server.router = createRouter({ health });
  server.define("party_lab", PartyRoom);
  return { server, httpServer };
}
