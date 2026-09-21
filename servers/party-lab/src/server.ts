import { createServer } from "node:http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { PartyRoom } from "./PartyRoom.js";

export function createPartyServer() {
  const httpServer = createServer();
  const server = new Server({
    transport: new WebSocketTransport({ server: httpServer, maxPayload: 2048, pingInterval: 3000, pingMaxRetries: 2 }),
    greet: false,
    gracefullyShutdown: false,
  });
  server.define("party_lab", PartyRoom);
  return { server, httpServer };
}
