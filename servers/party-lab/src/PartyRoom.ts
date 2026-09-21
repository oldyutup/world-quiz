import { randomUUID } from "node:crypto";
import { Room, ServerError, type Client } from "@colyseus/core";
import { appendChat, ChatMessage, LobbyPlayer, LobbyState } from "./state.js";
import { normalizeRoomCode, roomCodes } from "./roomCodes.js";
import { ChatLimiter, chatText, MAX_PLAYERS, nickname, RECONNECT_SECONDS } from "./validation.js";

function options(value: unknown): { nickname: string; intent: "create" | "join"; code?: string } {
  if (!value || typeof value !== "object") throw new ServerError(400, "INVALID_ADMISSION");
  const data = value as Record<string, unknown>;
  try {
    if (data.intent !== "create" && data.intent !== "join") throw new Error("INVALID_ADMISSION");
    return { nickname: nickname(data.nickname), intent: data.intent,
      code: data.intent === "join" ? normalizeRoomCode(data.code) : undefined };
  } catch (error) { throw new ServerError(400, (error as Error).message); }
}

export class PartyRoom extends Room<{ state: LobbyState }> {
  maxClients = MAX_PLAYERS;
  seatReservationTimeout = 10;
  state = new LobbyState();
  private limiters = new Map<string, ChatLimiter>();

  // Validate before creating a room/reserving a seat, including direct SDK callers.
  static async onAuth(_token: string, data: unknown) { return options(data); }

  onCreate(data: unknown) {
    if (options(data).intent !== "create") throw new ServerError(400, "INVALID_ADMISSION");
    this.roomId = roomCodes.claim();
    this.state.code = this.roomId;
    this.setPrivate(true);
    this.setPatchRate(100);
    this.maxMessagesPerSecond = 10;
    this.onMessage("chat", (client, data: unknown) => {
      if (!this.state.players.get(client.sessionId)?.connected) return;
      const limiter = this.limiters.get(client.sessionId);
      if (!limiter?.take()) { client.send("notice", "CHAT_RATE_LIMIT"); return; }
      try {
        const text = chatText(data);
        const player = this.state.players.get(client.sessionId)!;
        const message = new ChatMessage();
        Object.assign(message, { id: randomUUID(), playerId: client.sessionId, nickname: player.nickname, text, sentAt: Date.now() });
        appendChat(this.state, message);
      } catch { client.send("notice", "INVALID_CHAT"); }
    });
    this.onMessage("*", client => { client.send("notice", "INVALID_MESSAGE"); });
  }

  onJoin(client: Client, data: unknown) {
    const admission = options(data);
    if (this.state.players.has(client.sessionId) || this.state.players.size >= MAX_PLAYERS ||
      (admission.intent === "create" ? this.state.players.size !== 0 : admission.code !== this.roomId)) {
      throw new ServerError(400, "INVALID_ADMISSION");
    }
    const player = new LobbyPlayer();
    Object.assign(player, { id: client.sessionId, nickname: admission.nickname, connected: true });
    this.state.players.set(client.sessionId, player);
    this.limiters.set(client.sessionId, new ChatLimiter());
  }

  async onDrop(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = false;
    // The reserved seat still counts toward maxClients. No host authority exists.
    try { await this.allowReconnection(client, RECONNECT_SECONDS); }
    catch { /* Expiry is expected; Colyseus subsequently calls onLeave. */ }
  }
  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
  }
  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.limiters.delete(client.sessionId);
  }
  onDispose() {
    roomCodes.release(this.roomId);
    this.limiters.clear();
    this.state.messages.clear();
    this.state.players.clear();
  }
}
