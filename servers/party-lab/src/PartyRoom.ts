import { capturePredictionState } from "../../../shared/party-lab/simulation/predictionState.js";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics.js";
import { OnlineRoundSimulation } from "../../../shared/party-lab/simulation/onlineRound.js";
import {
  PLAYERS,
  type PlayerId,
} from "../../../shared/party-lab/simulation/players.js";
import {
  InputMailbox,
  NET,
  neutralIntent,
  type OnlinePhase,
  type GameEvent,
} from "../../../shared/party-lab/network/protocol.js";
import { allowedOrigin } from "./origin.js";
import { randomUUID } from "node:crypto";
import {
  Room,
  ServerError,
  type Client,
  type AuthContext,
} from "@colyseus/core";
import { appendChat, ChatMessage, LobbyPlayer, LobbyState } from "./state.js";
import { normalizeRoomCode, roomCodes } from "./roomCodes.js";
import { selectedCostumeId, type SelectableCostumeId } from "../../../shared/party-lab/costumes.js";
import {
  ChatLimiter,
  chatText,
  MAX_PLAYERS,
  nickname,
  RECONNECT_SECONDS,
} from "./validation.js";

function options(value: unknown): {
  nickname: string;
  intent: "create" | "join";
  code?: string;
  costumeId: SelectableCostumeId;
} {
  if (!value || typeof value !== "object")
    throw new ServerError(400, "INVALID_ADMISSION");
  const data = value as Record<string, unknown>;
  try {
    if (data.intent !== "create" && data.intent !== "join")
      throw new Error("INVALID_ADMISSION");
    return {
      nickname: nickname(data.nickname),
      intent: data.intent,
      code: data.intent === "join" ? normalizeRoomCode(data.code) : undefined,
      costumeId: selectedCostumeId(data.costumeId),
    };
  } catch (error) {
    throw new ServerError(400, (error as Error).message);
  }
}

export class PartyRoom extends Room<{ state: LobbyState }> {
  maxClients = MAX_PLAYERS;
  seatReservationTimeout = 10;
  state = new LobbyState();
  private limiters = new Map<string, ChatLimiter>();

  game!: OnlineRoundSimulation;
  private mailboxes = new Map<string, InputMailbox>();
  private events: GameEvent[] = [];
  private participants = new Set<string>();
  readonly metrics = {
    steps: 0,
    stepMs: 0,
    maxStepMs: 0,
    snapshots: 0,
    serializeMs: 0,
    snapshotBytes: 0,
    eventCount: 0,
  };

  private syncGameState() {
    const game = this.game;
    this.state.phase = game.phase;
    this.state.round = game.roundId;
    this.state.seconds = game.phase === "waiting" ? 0 : game.round.seconds;
    this.state.winner = game.round.winner ?? -1;
    for (const p of this.state.players.values())
      p.participating =
        this.participants.has(p.id) && !!(game.mask & (1 << p.slot));
  }
  private resetReady() {
    this.participants.clear();
    for (const p of this.state.players.values()) p.ready = false;
    for (const input of this.mailboxes.values()) input.clear();
  }
  private tryStart() {
    if (this.game.phase !== "waiting") return;
    const eligible = [...this.state.players.values()].filter(
      (p) => p.connected
    );
    if (eligible.length < 2 || !eligible.every((p) => p.ready)) return;
    this.participants = new Set(eligible.map((p) => p.id));
    this.game.start(eligible.map((p) => p.slot as PlayerId));
    for (const input of this.mailboxes.values()) input.clear();
    this.syncGameState();
  }
  private tick() {
    if (this.game.phase === "waiting") return;
    const now = performance.now(),
      before = this.game.phase;
    const intent = PLAYERS.map(() => neutralIntent());
    for (const [id, p] of this.state.players) {
      const input = this.mailboxes.get(id)!;
      if (this.game.phase !== "playing" || !p.connected || !p.participating)
        input.clear();
      else intent[p.slot] = input.read(now);
    }
    const events = this.game.step(intent).map((event) => {
      if (event.name !== "punchSwing") return event;
      const id = [...this.state.players.values()].find(
        (p) => p.slot === event.actor
      )?.id;
      return {
        ...event,
        inputSeq: id ? this.mailboxes.get(id)?.processedPunchSeq : undefined,
      };
    });
    this.events.push(...events);
    this.metrics.eventCount += events.length;
    const ms = performance.now() - now;
    this.metrics.steps++;
    this.metrics.stepMs += ms;
    this.metrics.maxStepMs = Math.max(this.metrics.maxStepMs, ms);
    const phase = this.game.phase as OnlinePhase;
    if (before !== phase) {
      for (const input of this.mailboxes.values()) input.clear();
      if (phase === "waiting") this.resetReady();
    }
    this.syncGameState();
    if (
      this.game.tick % (NET.physicsHz / NET.snapshotHz) === 0 ||
      phase === "waiting"
    ) {
      const start = performance.now();
      const ack = PLAYERS.map((p) => {
        const id = [...this.state.players.values()].find(
          (v) => v.slot === p.id
        )?.id;
        const input = id ? this.mailboxes.get(id) : undefined;
        return input?.processedRound === this.game.roundId
          ? input.processedSeq
          : -1;
      });
      const snapshot = this.game.snapshot(ack);
      let predictionBytes = 0;
      for (const client of this.clients) {
        const player = this.state.players.get(client.sessionId);
        if (!player?.connected) continue;
        const prediction = capturePredictionState(
          this.game.physics.players[player.slot],
          this.game.combat.players[player.slot]
        );
        client.send("snapshot", { ...snapshot, prediction });
        predictionBytes = Math.max(
          predictionBytes,
          prediction.velocities.byteLength +
            JSON.stringify({ ...prediction, velocities: undefined }).length
        );
      }
      this.metrics.snapshots++;
      this.metrics.serializeMs += performance.now() - start;
      this.metrics.snapshotBytes =
        predictionBytes +
        snapshot.transforms.byteLength +
        JSON.stringify({ ...snapshot, transforms: undefined }).length;
      if (this.events.length) {
        this.broadcast("feedback", this.events);
        this.events = [];
      }
    }
  }

  // Validate before creating a room/reserving a seat, including direct SDK callers.
  static async onAuth(_token: string, data: unknown, context: AuthContext) {
    if (
      !allowedOrigin(context.headers.get("origin"), context.headers.get("host"))
    )
      throw new ServerError(403, "ORIGIN_REJECTED");
    return options(data);
  }

  async onCreate(data: unknown) {
    if (options(data).intent !== "create")
      throw new ServerError(400, "INVALID_ADMISSION");
    await initializePhysics();
    this.game = new OnlineRoundSimulation();
    this.state.phase = "waiting";
    this.state.winner = -1;
    this.roomId = roomCodes.claim();
    this.state.code = this.roomId;
    this.setPrivate(true);
    this.setPatchRate(100);
    this.maxMessagesPerSecond = 90;
    this.setFixedTimestep(() => this.tick(), NET.physicsHz);
    this.onMessage("input", (client, data: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (!p?.connected || !p.participating || this.game.phase !== "playing")
        return;
      this.mailboxes
        .get(client.sessionId)
        ?.accept(data, this.game.roundId, performance.now());
    });
    this.onMessage("ready", (client, data: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (
        !p?.connected ||
        typeof data !== "boolean" ||
        this.game.phase !== "waiting"
      )
        return;
      p.ready = data;
      this.tryStart();
    });
    this.onMessage("chat", (client, data: unknown) => {
      if (!this.state.players.get(client.sessionId)?.connected) return;
      const limiter = this.limiters.get(client.sessionId);
      if (!limiter?.take()) {
        client.send("notice", "CHAT_RATE_LIMIT");
        return;
      }
      try {
        const text = chatText(data);
        const player = this.state.players.get(client.sessionId)!;
        const message = new ChatMessage();
        Object.assign(message, {
          id: randomUUID(),
          playerId: client.sessionId,
          nickname: player.nickname,
          text,
          sentAt: Date.now(),
        });
        appendChat(this.state, message);
      } catch {
        client.send("notice", "INVALID_CHAT");
      }
    });
    this.onMessage("*", (client) => {
      client.send("notice", "INVALID_MESSAGE");
    });
  }

  onJoin(client: Client, data: unknown) {
    const admission = options(data);
    if (
      this.state.players.has(client.sessionId) ||
      this.state.players.size >= MAX_PLAYERS ||
      (admission.intent === "create"
        ? this.state.players.size !== 0
        : admission.code !== this.roomId)
    ) {
      throw new ServerError(400, "INVALID_ADMISSION");
    }
    const player = new LobbyPlayer();
    const slot = PLAYERS.find(
      (slot) =>
        ![...this.state.players.values()].some((p) => p.slot === slot.id)
    )!;
    Object.assign(player, {
      id: client.sessionId,
      nickname: admission.nickname,
      connected: true,
      slot: slot.id,
      color: slot.color,
      costumeId: admission.costumeId,
      ready: false,
      participating: false,
    });
    this.mailboxes.set(client.sessionId, new InputMailbox());
    this.state.players.set(client.sessionId, player);
    this.limiters.set(client.sessionId, new ChatLimiter());
  }

  async onDrop(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.connected = false;
      player.ready = false;
      this.mailboxes.get(client.sessionId)?.clear();
      this.game.neutralize(player.slot as PlayerId);
      if (this.game.phase === "countdown" && player.participating) {
        this.game.cancelCountdown();
        this.resetReady();
        this.syncGameState();
      }
      this.tryStart();
    }
    // The reserved seat still counts toward maxClients. No host authority exists.
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      /* Expiry is expected; Colyseus subsequently calls onLeave. */
    }
  }
  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
    this.mailboxes.get(client.sessionId)?.clear();
  }
  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player?.participating) {
      this.game.remove(player.slot as PlayerId);
      if (this.game.phase === "countdown") {
        this.game.cancelCountdown();
        this.resetReady();
      }
    }
    this.participants.delete(client.sessionId);
    this.mailboxes.delete(client.sessionId);
    this.syncGameState();
    this.state.players.delete(client.sessionId);
    this.limiters.delete(client.sessionId);
    this.tryStart();
  }
  onDispose() {
    this.game?.dispose();
    this.mailboxes.clear();
    this.events = [];
    roomCodes.release(this.roomId);
    this.limiters.clear();
    this.state.messages.clear();
    this.state.players.clear();
  }
}
