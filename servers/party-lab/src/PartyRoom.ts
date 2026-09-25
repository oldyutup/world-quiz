import { initializePhysics } from "../../../shared/party-lab/simulation/physics.js";
import { OnlineRoundSimulation } from "../../../shared/party-lab/simulation/onlineRound.js";
import { BarnRoundSimulation } from "../../../shared/party-lab/simulation/barnRound.js";
import { LayerRoundSimulation } from "../../../shared/party-lab/simulation/layerRound.js";
import { ColorRoundSimulation } from "../../../shared/party-lab/simulation/colorRound.js";
import { BombRoundSimulation } from "../../../shared/party-lab/simulation/bombRound.js";
import { NO_COLOR } from "../../../shared/party-lab/simulation/colors/layouts.js";
import { newRoomCounters, type OnlineSimulation, type RoomCounters } from "../../../shared/party-lab/simulation/online.js";
import {
  DEFAULT_MODE_SELECTION,
  isModeSelection,
  MixedRotation,
  upcomingMode,
  type GameMode,
  type ModeSelection,
} from "../../../shared/party-lab/modes.js";
import {
  PLAYERS,
  type PlayerId,
} from "../../../shared/party-lab/simulation/players.js";
import {
  InputMailbox,
  NET,
  neutralIntent,
  validatePing,
  type OnlinePhase,
  type GameEvent,
  type PongPacket,
  type ServerDiagnostics,
} from "../../../shared/party-lab/network/protocol.js";
import { allowedOrigin } from "./origin.js";
import { LoopMetrics, processMetrics } from "./diagnostics.js";
import { randomUUID } from "node:crypto";
import {
  getMessageBytes,
  Protocol,
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
  MAX_MESSAGES_PER_SECOND,
  MAX_PLAYERS,
  nickname,
  PING_MIN_INTERVAL_MS,
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
    // Frontend and server deploy separately; a stale page must not join a room it cannot simulate.
    if (data.protocol !== NET.version) throw new Error("PROTOCOL_MISMATCH");
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

/** A mode's authoritative simulation, sharing the room's lifetime counters. */
export function createSimulation(mode: GameMode, counters: RoomCounters): OnlineSimulation {
  if (mode === "barn_shootout") return new BarnRoundSimulation(counters);
  if (mode === "layer_chaos") return new LayerRoundSimulation(counters);
  if (mode === "color_chaos") return new ColorRoundSimulation(counters);
  if (mode === "bomb_tag") return new BombRoundSimulation(counters);
  return new OnlineRoundSimulation(counters);
}
/** Events whose `inputSeq` lets the actor's client skip its own predicted presentation. */
const LOCAL_ECHO = new Set(["punchSwing", "shotgunFire", "smgFire"]);
/** Exact encoded snapshot size is measured this often (one extra encode per second). */
const SNAPSHOT_MEASURE_EVERY = 20;

export class PartyRoom extends Room<{ state: LobbyState }> {
  maxClients = MAX_PLAYERS;
  seatReservationTimeout = 10;
  state = new LobbyState();
  private limiters = new Map<string, ChatLimiter>();

  /** Tick/round/event/snapshot counters for the room's whole life (every simulation shares them). */
  readonly counters = newRoomCounters();
  game!: OnlineSimulation;
  /** The host's lobby choice, and the mode the next round will be played in. */
  selection: ModeSelection = DEFAULT_MODE_SELECTION;
  /** Mixed: all five modes once per cycle, shuffled, never the same mode twice in a row. */
  readonly rotation = new MixedRotation();
  upcoming: GameMode = upcomingMode(DEFAULT_MODE_SELECTION, this.rotation);
  /** Join order (the host is the earliest-joined connected player). */
  private joined = new Map<string, number>();
  private joinCounter = 0;
  /** Simulations built/disposed over the room's life (mode switches). */
  readonly simulations = { created: 0, disposed: 0 };
  private mailboxes = new Map<string, InputMailbox>();
  private events: GameEvent[] = [];
  private participants = new Set<string>();
  private lastPing = new Map<string, number>();
  private droppedAt = new Map<string, number>();
  readonly loop = new LoopMetrics(() => this.roomId);
  readonly metrics = {
    steps: 0,
    stepMs: 0,
    maxStepMs: 0,
    snapshots: 0,
    serializeMs: 0,
    snapshotBytes: 0,
    /** Exact encoded `snapshot` message (msgpack + Colyseus header), largest recipient, last measured. */
    snapshotWireBytes: 0,
    eventCount: 0,
    /** Encoded `feedback` bytes sent (for a per-second event traffic figure). */
    feedbackBytes: 0,
  };

  private syncGameState() {
    const game = this.game;
    this.state.phase = game.phase;
    this.state.round = game.roundId;
    this.state.seconds = game.seconds;
    this.state.winner = game.winner;
    this.state.selection = this.selection;
    this.state.mode = game.phase === "waiting" ? this.upcoming : game.mode;
    for (const p of this.state.players.values())
      p.participating =
        this.participants.has(p.id) && !!(game.mask & (1 << p.slot));
    this.syncHost();
  }
  /**
   * The host picks the mode. There was no host before: the room creator had no special
   * authority. Host = the earliest-joined player who is connected (the creator while
   * present); if nobody is connected, the earliest-joined. Leaving hands it on cleanly.
   */
  private syncHost() {
    let host = "",
      best = Infinity,
      fallback = "",
      fallbackOrder = Infinity;
    for (const p of this.state.players.values()) {
      const order = this.joined.get(p.id) ?? Infinity;
      if (p.connected && order < best) {
        best = order;
        host = p.id;
      }
      if (order < fallbackOrder) {
        fallbackOrder = order;
        fallback = p.id;
      }
    }
    this.state.hostId = host || fallback;
  }
  /** The simulation for this round's mode; a different mode disposes the old world first. */
  private ensureSimulation(mode: GameMode) {
    if (this.game?.mode === mode) return;
    this.game?.dispose();
    if (this.game) this.simulations.disposed++;
    this.game = createSimulation(mode, this.counters);
    this.simulations.created++;
  }
  private setSelection(selection: ModeSelection) {
    if (selection === this.selection) return;
    this.selection = selection;
    if (selection === "mixed") this.rotation.reset();
    this.upcoming = upcomingMode(selection, this.rotation);
    // A different game is a new decision: everyone confirms again.
    for (const p of this.state.players.values()) p.ready = false;
    this.syncGameState();
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
    this.ensureSimulation(this.upcoming);
    this.game.start(eligible.map((p) => p.slot as PlayerId));
    for (const input of this.mailboxes.values()) input.clear();
    this.syncGameState();
  }
  private tick() {
    const now = performance.now();
    // Measured before the lobby early-return so event-loop stalls show up in any phase.
    this.loop.tick(now);
    if (this.game.phase === "waiting") return;
    const before = this.game.phase;
    const intent = PLAYERS.map(() => neutralIntent());
    for (const [id, p] of this.state.players) {
      const input = this.mailboxes.get(id)!;
      if (this.game.phase !== "playing" || !p.connected || !p.participating)
        input.clear();
      else intent[p.slot] = input.read(now);
    }
    const events = this.game.step(intent).map((event) => {
      if (!LOCAL_ECHO.has(event.name)) return event;
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
    this.loop.step(ms);
    const phase = this.game.phase as OnlinePhase;
    if (before !== phase) {
      for (const input of this.mailboxes.values()) input.clear();
      if (phase === "waiting") this.resetReady();
      // Mixed: once a round is under way its mode is used up; the lobby shows the next one.
      if (phase === "playing" && this.selection === "mixed") {
        this.rotation.played();
        this.upcoming = this.rotation.next;
      }
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
      let predictionBytes = 0,
        wireBytes = 0;
      const measure = this.metrics.snapshots % SNAPSHOT_MEASURE_EVERY === 0;
      for (const client of this.clients) {
        const player = this.state.players.get(client.sessionId);
        if (!player?.connected) continue;
        const prediction = this.game.prediction(player.slot as PlayerId);
        const message = { ...snapshot, prediction };
        client.send("snapshot", message);
        predictionBytes = Math.max(
          predictionBytes,
          prediction.velocities.byteLength +
            (prediction.barn?.byteLength ?? 0) +
            (prediction.layers?.byteLength ?? 0) +
            (prediction.bomb?.byteLength ?? 0) +
            JSON.stringify({ ...prediction, velocities: undefined, barn: undefined, layers: undefined, bomb: undefined }).length
        );
        if (measure)
          wireBytes = Math.max(wireBytes, getMessageBytes.raw(Protocol.ROOM_DATA, "snapshot", message).byteLength);
      }
      this.metrics.snapshots++;
      this.metrics.serializeMs += performance.now() - start;
      this.loop.snapshot(performance.now() - start);
      this.metrics.snapshotBytes =
        predictionBytes +
        snapshot.transforms.byteLength +
        JSON.stringify({ ...snapshot, transforms: undefined }).length;
      if (measure && wireBytes) this.metrics.snapshotWireBytes = wireBytes;
      if (measure && snapshot.layers && this.game instanceof LayerRoundSimulation)
        this.game.section.bytes = getMessageBytes.raw(Protocol.ROOM_DATA, "layers", snapshot.layers).byteLength - getMessageBytes.raw(Protocol.ROOM_DATA, "layers", null).byteLength;
      if (measure && snapshot.colors && this.game instanceof ColorRoundSimulation)
        this.game.section.bytes = getMessageBytes.raw(Protocol.ROOM_DATA, "colors", snapshot.colors).byteLength - getMessageBytes.raw(Protocol.ROOM_DATA, "colors", null).byteLength;
      if (measure && snapshot.bomb && this.game instanceof BombRoundSimulation)
        this.game.section.bytes = getMessageBytes.raw(Protocol.ROOM_DATA, "bomb", snapshot.bomb).byteLength - getMessageBytes.raw(Protocol.ROOM_DATA, "bomb", null).byteLength;
      if (this.events.length) {
        if (measure || this.metrics.feedbackBytes === 0)
          this.metrics.feedbackBytes += getMessageBytes.raw(Protocol.ROOM_DATA, "feedback", this.events).byteLength;
        this.broadcast("feedback", this.events);
        this.events = [];
      }
    }
  }

  /** Colyseus hook: chat appended since the last patch leaves in this one. */
  onBeforePatch() {
    this.loop.patch(performance.now());
  }
  private log(event: string, client: Client, detail = "") {
    // Session IDs only: nicknames are user-chosen text and stay out of host logs.
    console.info(
      `[party-lab] room ${this.roomId} ${event} ${client.sessionId} phase=${this.game?.phase ?? "-"}${detail}`
    );
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
    this.ensureSimulation(this.upcoming);
    this.state.phase = "waiting";
    this.state.winner = -1;
    this.state.selection = this.selection;
    this.state.mode = this.upcoming;
    this.roomId = roomCodes.claim();
    this.state.code = this.roomId;
    this.setPrivate(true);
    this.setPatchRate(100);
    this.maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;
    processMetrics().rooms++;
    this.setFixedTimestep(() => this.tick(), NET.physicsHz);
    this.onMessage("input", (client, data: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (!p?.connected || !p.participating || this.game.phase !== "playing")
        return;
      this.mailboxes
        .get(client.sessionId)
        ?.accept(data, this.game.roundId, performance.now(), this.game.mode);
    });
    // Host only, lobby only: one of the modes or Mixed. Clears every Ready.
    this.onMessage("mode", (client, data: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (!p?.connected || this.game.phase !== "waiting" || !isModeSelection(data)) return;
      if (this.state.hostId !== client.sessionId) {
        client.send("notice", "MODE_HOST_ONLY");
        return;
      }
      this.setSelection(data);
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
        this.loop.chatReceived(performance.now());
      } catch {
        client.send("notice", "INVALID_CHAT");
      }
    });
    // Link diagnostics: echo the client's clock for RTT plus server time for offset.
    this.onMessage("ping", (client, data: unknown) => {
      const ping = validatePing(data),
        now = performance.now();
      if (
        !ping ||
        now - (this.lastPing.get(client.sessionId) ?? -Infinity) <
          PING_MIN_INTERVAL_MS
      )
        return;
      this.lastPing.set(client.sessionId, now);
      const pong: PongPacket = { id: ping.id, t: ping.t, s: Date.now() };
      if (ping.diag) pong.d = { ...this.loop.report(), ...this.roomReport() };
      client.send("pong", pong);
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
    this.joined.set(client.sessionId, ++this.joinCounter);
    this.state.players.set(client.sessionId, player);
    this.limiters.set(client.sessionId, new ChatLimiter());
    this.syncHost();
  }
  /** Per-room additions to the opt-in debug pong. */
  private roomReport() {
    const report: Partial<ServerDiagnostics> = {
      mode: this.game.mode,
      snapshotBytes: this.metrics.snapshotWireBytes,
      simulations: this.simulations.created,
    };
    if (this.game instanceof LayerRoundSimulation) {
      const field = this.game.field;
      let armed = 0;
      for (let id = 0; id < field.tiles.length; id++) if (!field.gone[id] && field.armTick[id] >= 0) armed++;
      report.layers = { sectionBytes: this.game.section.bytes, armed, gone: field.stats.gone, encodeUs: this.game.section.encodeMs * 1000 };
    }
    if (this.game instanceof ColorRoundSimulation) {
      const cycle = this.game.schedule.cycle;
      let present = 0,
        marked = 0,
        grey = 0;
      for (let id = 0; id < cycle.present.length; id++) {
        present += cycle.present[id];
        marked += cycle.warned[id];
        if (cycle.present[id] && cycle.colors[id] === NO_COLOR) grey++;
      }
      report.colors = { sectionBytes: this.game.section.bytes, cycle: cycle.index, present, marked, grey, encodeUs: this.game.section.encodeMs * 1000 };
    }
    if (this.game instanceof BarnRoundSimulation) {
      const r = this.game.rewind;
      report.rewind = {
        shots: r.shots,
        lastMs: r.lastMs,
        maxMs: r.maxMs,
        clampedOld: r.clampedOld,
        rejectedFuture: r.rejectedFuture,
        lookupUs: r.shots ? (r.lookupMs / r.shots) * 1000 : 0,
      };
    }
    if (this.game instanceof BombRoundSimulation) {
      const r = this.game.rewind;
      report.bomb = {
        sectionBytes: this.game.section.bytes,
        carrier: this.game.game.bomb.carrier ?? -1,
        armedTraps: this.game.game.traps.traps.filter((trap) => trap.armed).length,
        slowed: this.game.game.traps.slowed.filter((ticks) => ticks > 0).length,
        encodeUs: this.game.section.encodeMs * 1000,
      };
      report.rewind = {
        shots: r.tags,
        lastMs: r.lastMs,
        maxMs: r.maxMs,
        clampedOld: r.clampedOld,
        rejectedFuture: r.rejectedFuture,
        lookupUs: r.tags ? (r.lookupMs / r.tags) * 1000 : 0,
      };
    }
    return report;
  }

  async onDrop(client: Client, code?: number) {
    this.droppedAt.set(client.sessionId, performance.now());
    this.log("drop", client, ` code=${code ?? "-"}`);
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
    this.syncHost();
    // The reserved seat still counts toward maxClients.
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      /* Expiry is expected; Colyseus subsequently calls onLeave. */
    }
  }
  onReconnect(client: Client) {
    const dropped = this.droppedAt.get(client.sessionId);
    this.droppedAt.delete(client.sessionId);
    this.log(
      "reconnect",
      client,
      dropped === undefined ? "" : ` after=${Math.round(performance.now() - dropped)}ms`
    );
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
    this.mailboxes.get(client.sessionId)?.clear();
    this.syncHost();
  }
  onLeave(client: Client, code?: number) {
    this.log("leave", client, ` code=${code ?? "-"}`);
    this.lastPing.delete(client.sessionId);
    this.droppedAt.delete(client.sessionId);
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
    this.joined.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.syncGameState();
    this.limiters.delete(client.sessionId);
    this.tryStart();
  }
  onDispose() {
    if (this.game) processMetrics().rooms--;
    this.game?.dispose();
    if (this.game) this.simulations.disposed++;
    this.mailboxes.clear();
    this.events = [];
    roomCodes.release(this.roomId);
    this.limiters.clear();
    this.state.messages.clear();
    this.state.players.clear();
  }
}
