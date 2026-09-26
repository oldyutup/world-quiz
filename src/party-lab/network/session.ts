import { encodePropInput, validatePropInput, type PropInputPacket } from "../../../shared/party-lab/network/protocol";
import type { PropSettings } from "../../../shared/party-lab/propSettings";
import type { PropOnlineEvent } from "../../../shared/party-lab/simulation/prophunt/wire";
import { GameStream } from "./gameStream";
import { LINK, NetDiagnostics } from "./diagnostics";
import {
  NET,
  normalizeMove,
  type AnyInputPacket,
  type BarnInputPacket,
  type BombInputPacket,
  type InputPacket,
  type LayerInputPacket,
  type GameSnapshot,
  type GameEvent,
  type PingPacket,
  type PongPacket,
} from "../../../shared/party-lab/network/protocol";
import {
  isGameMode,
  isModeSelection,
  type ModeSelection,
} from "../../../shared/party-lab/modes";
import { shoulderEye } from "../../../shared/party-lab/simulation/barn/aim";
import type { MovementInput } from "../input/types";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Client, Room } from "@colyseus/sdk";
import { selectedCostumeId, type SelectableCostumeId } from "../../../shared/party-lab/costumes";
import { createLobbyClient, lobbyError } from "./client";
import { admissionOptions } from "./admission";
import {
  CHAT_MAX_LENGTH,
  EMPTY_LOBBY,
  normalizeNickname,
  normalizeRoomCode,
  validNickname,
  validRoomCode,
  type ChatMessage,
  type LobbyPlayer,
  type LobbySnapshot,
  type LobbyState,
} from "./types";

type LobbyRoom = Room<unknown, LobbyState>;
const notices: Record<string, string> = {
  PROP_THREE_REQUIRED: "Saklambaç için 3 oyuncu gerekli.",
  CHAT_RATE_LIMIT:
    "Biraz yavaşla. 5 saniyede en fazla 4 mesaj gönderebilirsin.",
  INVALID_CHAT: "Mesajın 1–280 karakterlik düz metin olmalı.",
  INVALID_MESSAGE: "Bu işlem lobide desteklenmiyor.",
  MODE_HOST_ONLY: "Oyun modunu yalnızca oda sahibi seçebilir.",
};
/** Colyseus CloseCode.MAY_TRY_RECONNECT: the SDK fires onclose at once and reconnects. */
const MAY_TRY_RECONNECT = 4010;
const HEALTH_CHECK_MS = 250;

/** Opt-in overlay (`?partyDebug=1`), also in production: the lag reports come from real play. */
export function partyDebugEnabled() {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("partyDebug")
  );
}
const pageHidden = () => typeof document !== "undefined" && document.hidden;

export interface LobbySessionOptions {
  createClient?: () => Client;
  /** Ask the server for loop diagnostics in each pong. */
  debug?: boolean;
}

/** One in-memory session per mounted Party Lab root. No accounts or persisted tokens. */
export class LobbySession {
  private room: LobbyRoom | null = null;
  private snapshot: LobbySnapshot = { ...EMPTY_LOBBY };
  private generation = 0;
  private inputSeq = 0;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private pingId = 0;
  private lastHealthCheck = -1;
  private roundStart = { round: -1, seq: 0 };
  private lastInputAt = -Infinity;
  private heldJump = false;
  private heldPunch = false;
  private heldPickup = false;
  private heldWhistle = false;
  /** Barn: the last aim sent, reused by neutral packets so pausing never turns the body. */
  private lastAim = { yaw: 0, pitch: 0, eye: shoulderEye(0) };
  private chatIds = new Set<string>();
  readonly diagnostics = new NetDiagnostics();
  private readonly createClient: () => Client;
  private readonly debug: boolean;
  constructor(
    private readonly publish: (snapshot: LobbySnapshot) => void,
    readonly stream = new GameStream(),
    options: LobbySessionOptions = {}
  ) {
    this.createClient = options.createClient ?? createLobbyClient;
    this.debug = options.debug ?? false;
  }

  private update(change: Partial<LobbySnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    if (!this.disposed) this.publish(this.snapshot);
  }

  async connect(
    action: "create" | "join",
    rawNickname: string,
    rawCode: string,
    costumeId: SelectableCostumeId
  ) {
    if (this.disposed || this.room || this.snapshot.status === "connecting")
      return;
    const nickname = normalizeNickname(rawNickname);
    const code = normalizeRoomCode(rawCode);
    if (!validNickname(nickname) || (action === "join" && !validRoomCode(code)))
      return;
    const generation = ++this.generation;
    this.update({ ...EMPTY_LOBBY, status: "connecting" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const client = this.createClient();
      const pending =
        action === "create"
          ? client.create<LobbyState>("party_lab", admissionOptions("create", nickname, code, costumeId))
          : client.joinById<LobbyState>(code, admissionOptions("join", nickname, code, costumeId));
      // Late successful admissions must be released after timeout/unmount/cancel.
      void pending.then(
        (room) => {
          if (this.disposed || generation !== this.generation)
            void room.leave().catch(() => {});
        },
        () => {}
      );
      const room = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("CONNECT_TIMEOUT")), 12000);
        }),
      ]);
      if (this.disposed || generation !== this.generation) return;
      this.room = room;
      Object.assign(room.reconnection, {
        minUptime: 0,
        maxRetries: 10,
        minDelay: 500,
        maxDelay: 2000,
        maxEnqueuedMessages: 0,
      });
      this.diagnostics.reset();
      const current = () => !this.disposed && this.room === room;
      // Every server frame proves the socket is alive (lobby: patches + pongs).
      const heard = () => this.diagnostics.serverMessage(performance.now());
      let chatPrimed = false; // history present at join is not "received" now
      this.chatIds = new Set();
      const copyState = (state: LobbyState) => {
        if (!current() || !state?.players) return;
        const players: LobbyPlayer[] = [];
        const messages: ChatMessage[] = [];
        state.players.forEach((player) =>
          players.push({
            id: player.id,
            nickname: player.nickname,
            connected: player.connected,
            slot: player.slot,
            color: player.color,
            costumeId: selectedCostumeId(player.costumeId),
            ready: player.ready,
            participating: player.participating,
          })
        );
        const known = this.chatIds;
        this.chatIds = new Set();
        state.messages.forEach((message) => {
          messages.push({
            id: message.id,
            playerId: message.playerId,
            nickname: message.nickname,
            text: message.text,
            sentAt: message.sentAt,
          });
          this.chatIds.add(message.id);
          if (chatPrimed && !known.has(message.id) && message.playerId !== room.sessionId)
            this.diagnostics.chatReceived(message.id, message.sentAt, performance.now(), Date.now());
        });
        chatPrimed = true;
        // A fresh array/object every patch: React must never see a mutated message list.
        this.update({
          code: state.code,
          players,
          messages,
          phase: state.phase,
          round: state.round,
          seconds: state.seconds,
          winner: state.winner,
          propAmmo: state.propAmmo,
          propProximity: state.propProximity,
          selection: isModeSelection(state.selection) ? state.selection : "rooftop_brawl",
          mode: isGameMode(state.mode) ? state.mode : "rooftop_brawl",
          hostId: state.hostId ?? "",
        });
      };
      room.onStateChange((state) => {
        if (!current()) return;
        heard();
        copyState(state);
      });
      room.onMessage("snapshot", (game: GameSnapshot) => {
        if (!current()) return;
        const now = performance.now();
        heard();
        const accepted = this.stream.snapshots.push(game, now);
        this.diagnostics.snapshot(Number(game?.seq), accepted, now);
        if (accepted) this.update({ game });
      });
      room.onMessage("propEvent", (event: PropOnlineEvent) => { if (current()) this.stream.acceptPropEvent(event, !document.hidden); });
      room.onMessage("feedback", (events: GameEvent[]) => {
        if (!current()) return;
        heard();
        this.stream.acceptEvents(events, !pageHidden());
      });
      room.onMessage("notice", (code: string) => {
        if (!current()) return;
        heard();
        this.update({ notice: notices[code] ?? "İşlem tamamlanamadı." });
      });
      room.onMessage("pong", (pong: PongPacket) => {
        if (!current()) return;
        heard();
        if (
          pong &&
          [pong.id, pong.t, pong.s].every((v) => typeof v === "number" && Number.isFinite(v))
        )
          this.diagnostics.pong(pong, performance.now(), Date.now());
      });
      room.onDrop((code, reason) => {
        if (!current()) return;
        this.diagnostics.dropped(code, reason, performance.now());
        this.stream.clearPresentation();
        this.update({
          status: "reconnecting",
          game: null,
          link: "good",
          notice: "Bağlantı kesildi. Yeniden bağlanılıyor…",
        });
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          if (current()) {
            this.release();
            this.update({
              status: "disconnected",
              notice:
                "Yeniden bağlanılamadı. Lobiden çıkıp tekrar katılabilirsin.",
            });
          }
        }, 16000);
      });
      room.onReconnect(() => {
        if (!current()) return;
        clearTimeout(this.reconnectTimer);
        this.diagnostics.reconnected(performance.now());
        this.update({ status: "connected", link: "good", notice: "Yeniden bağlandın." });
        copyState(room.state);
        this.ping();
      });
      room.onLeave((code, reason) => {
        if (!current()) return;
        clearTimeout(this.reconnectTimer);
        this.stopTimers();
        this.diagnostics.closed(code, reason);
        this.room = null;
        this.update({
          status: "disconnected",
          link: "good",
          notice: "Odadan ayrıldın veya bağlantı süresi doldu.",
        });
      });
      room.onError(() => {
        if (current()) this.update({ notice: "Bağlantıda bir sorun oluştu." });
      });
      this.update({
        status: "connected",
        code: room.roomId,
        selfId: room.sessionId,
        notice: "",
      });
      heard();
      copyState(room.state);
      this.startTimers();
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.generation++;
        this.update({ ...EMPTY_LOBBY, notice: lobbyError(error) });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private startTimers() {
    this.stopTimers();
    this.lastHealthCheck = -1;
    this.ping();
    this.pingTimer = setInterval(() => this.ping(), NET.pingMs);
    this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_CHECK_MS);
  }
  private stopTimers() {
    clearInterval(this.pingTimer);
    clearInterval(this.healthTimer);
    this.pingTimer = this.healthTimer = undefined;
  }
  private ping() {
    const room = this.room;
    if (!room?.connection.isOpen || this.snapshot.status !== "connected") return;
    const packet: PingPacket = { id: ++this.pingId, t: performance.now() };
    if (this.debug) packet.diag = true;
    room.send("ping", packet);
  }
  /** Link quality from data freshness; a silently dead socket is recycled. */
  checkHealth(now = performance.now()) {
    const room = this.room;
    if (!room || this.snapshot.status !== "connected") return;
    // A late tick means this page was busy (arena load, GC, frozen tab); queued socket
    // events run after it, so data only *looks* late. Don't blame the link for that tick.
    const gap = this.lastHealthCheck >= 0 ? now - this.lastHealthCheck : 0;
    this.lastHealthCheck = now;
    if (gap > HEALTH_CHECK_MS * 2.4) return;
    if (this.diagnostics.dead(now)) {
      // Browsers can take minutes to notice a dead TCP path (Wi-Fi/NAT change). 4010 fires
      // onclose immediately and reuses the SDK's normal reconnection to the same seat.
      this.diagnostics.deadSocketResets++;
      room.connection.close(MAY_TRY_RECONNECT, "CLIENT_SILENCE");
      return;
    }
    const link = this.diagnostics.quality(now, this.snapshot.phase);
    if (link !== this.snapshot.link) this.update({ link });
  }

  setReady(ready: boolean) {
    if (this.room?.connection.isOpen && this.snapshot.status === "connected")
      this.room.send("ready", ready);
  }
  /** Host only (the server enforces it): the mode of the next rounds. Clears every Ready. */
  setMode(selection: ModeSelection) {
    if (
      this.room?.connection.isOpen &&
      this.snapshot.status === "connected" &&
      this.snapshot.phase === "waiting" &&
      isModeSelection(selection)
    )
      this.room.send("mode", selection);
  }
  setPropSettings(settings: Partial<PropSettings>) {
    if (this.room?.connection.isOpen && this.snapshot.status === "connected" && this.snapshot.phase === "waiting") this.room.send("propSettings", settings);
  }
  /** Inputs the server has not consumed yet (by the latest snapshot's ack). */
  private inputBacklog() {
    const game = this.snapshot.game;
    const self = this.snapshot.players.find((p) => p.id === this.snapshot.selfId);
    if (!game || !self || game.round !== this.roundStart.round) return 0;
    const ack = game.ack[self.slot];
    return this.inputSeq - (ack >= 0 ? ack : this.roundStart.seq - 1);
  }
  sendInput(intent: MovementInput): AnyInputPacket | null {
    if (
      !this.room?.connection.isOpen ||
      this.snapshot.status !== "connected" ||
      this.snapshot.phase !== "playing"
    )
      return null;
    const now = performance.now();
    const prop = this.snapshot.mode === "prop_hunt",
      barn = this.snapshot.mode === "barn_shootout" || prop,
      bomb = this.snapshot.mode === "bomb_tag",
      layers = this.snapshot.mode === "layer_chaos" || this.snapshot.mode === "color_chaos";
    this.heldJump ||= intent.jump;
    this.heldPunch ||= barn ? !!intent.attack : !!intent.punch;
    this.heldPickup ||= barn && !!intent.pickup;
    this.heldWhistle ||= prop && !!intent.whistle;
    // While input is not being acknowledged, 60/s would only queue up and arrive as one
    // burst. Send the newest state at 10/s and carry pressed edges into it.
    if (
      this.inputBacklog() > LINK.unackedInputs &&
      now - this.lastInputAt < LINK.stalledInputIntervalMs
    ) {
      this.diagnostics.inputsCoalesced++;
      return null;
    }
    const packet: AnyInputPacket = prop
      ? { ...this.barnPacket(intent), attackHeld: false, whistlePressed: this.heldWhistle }
      : barn
      ? this.barnPacket(intent)
      : bomb
      ? this.bombPacket(intent)
      : layers
      ? this.layerPacket(intent)
      : {
          seq: ++this.inputSeq,
          round: this.snapshot.round,
          moveX: intent.x,
          moveZ: intent.z,
          jumpPressed: this.heldJump,
          punchPressed: this.heldPunch,
          grabHeld: !!intent.grab,
          liftHeld: !!intent.lift,
        } satisfies InputPacket;
    this.heldJump = this.heldPunch = this.heldPickup = this.heldWhistle = false;
    if (this.roundStart.round !== packet.round)
      this.roundStart = { round: packet.round, seq: packet.seq };
    this.room.send("input", prop ? encodePropInput(packet as PropInputPacket) : packet);
    this.lastInputAt = now;
    this.diagnostics.input(now);
    return prop ? validatePropInput(encodePropInput(packet as PropInputPacket)) : packet;
  }
  /** Bomba Sende intent plus the authoritative remote timeline being viewed for capped rewind. */
  private bombPacket(intent: MovementInput): BombInputPacket {
    const move = normalizeMove(Number.isFinite(intent.x) ? intent.x : 0, Number.isFinite(intent.z) ? intent.z : 0);
    const viewTick = Number.isFinite(intent.viewTick) ? Math.max(0, Math.round(intent.viewTick!)) : 0;
    return {
      seq: ++this.inputSeq,
      round: this.snapshot.round,
      moveX: move.x,
      moveZ: move.z,
      jumpPressed: this.heldJump,
      sprintHeld: !!intent.sprint,
      punchPressed: this.heldPunch,
      viewTick,
    };
  }
  /**
   * Katman Kaosu / Renk Kaosu intent → wire packet: camera-relative movement normalised exactly as the
   * server does (so the local replay uses the server's numbers), jump and punch edges
   * (carried through coalescing), sprint held. Nothing else.
   */
  private layerPacket(intent: MovementInput): LayerInputPacket {
    const move = normalizeMove(Number.isFinite(intent.x) ? intent.x : 0, Number.isFinite(intent.z) ? intent.z : 0);
    return {
      seq: ++this.inputSeq,
      round: this.snapshot.round,
      moveX: move.x,
      moveZ: move.z,
      jumpPressed: this.heldJump,
      sprintHeld: !!intent.sprint,
      punchPressed: this.heldPunch,
    };
  }
  /**
   * Barn intent → wire packet. Movement is already camera-relative; the aim yaw is
   * normalised exactly as the server does, so the local replay and the authority see
   * the same numbers. A neutral intent (pause, hidden tab) keeps the last aim.
   */
  private barnPacket(intent: MovementInput): BarnInputPacket {
    const aim = this.lastAim;
    if (intent.facing !== undefined && Number.isFinite(intent.facing))
      aim.yaw = Math.atan2(Math.sin(intent.facing), Math.cos(intent.facing));
    if (intent.aimPitch !== undefined && Number.isFinite(intent.aimPitch))
      aim.pitch = Math.max(-1.2, Math.min(1.2, intent.aimPitch));
    const eye = intent.aimEye && [intent.aimEye.x, intent.aimEye.y, intent.aimEye.z].every(Number.isFinite) ? intent.aimEye : shoulderEye(aim.yaw);
    const limit = (v: number) => Math.max(-4, Math.min(4, v));
    aim.eye = { x: limit(eye.x), y: limit(eye.y), z: limit(eye.z) };
    const viewTick = intent.viewTick !== undefined && Number.isFinite(intent.viewTick) ? Math.max(0, intent.viewTick) : 0;
    return {
      seq: ++this.inputSeq,
      round: this.snapshot.round,
      moveX: intent.x,
      moveZ: intent.z,
      jumpPressed: this.heldJump,
      sprintHeld: !!intent.sprint,
      attackPressed: this.heldPunch,
      attackHeld: !!intent.attackHeld,
      pickupPressed: this.heldPickup,
      aimYaw: aim.yaw,
      aimPitch: aim.pitch,
      eyeX: aim.eye.x,
      eyeY: aim.eye.y,
      eyeZ: aim.eye.z,
      viewTick: Math.round(viewTick * 100) / 100,
    };
  }
  sendChat(text: string): boolean {
    if (
      !this.room?.connection.isOpen ||
      this.snapshot.status !== "connected" ||
      !text.trim() ||
      text.length > CHAT_MAX_LENGTH
    )
      return false;
    try {
      this.room.send("chat", text);
      this.update({ notice: "" });
      return true;
    } catch {
      this.update({
        notice: "Mesaj gönderilemedi. Bağlantı gelince tekrar dene.",
      });
      return false;
    }
  }
  private release() {
    clearTimeout(this.reconnectTimer);
    this.stopTimers();
    this.generation++;
    this.stream.reset();
    this.inputSeq = 0;
    this.roundStart = { round: -1, seq: 0 };
    this.heldJump = this.heldPunch = this.heldPickup = this.heldWhistle = false;
    this.lastAim = { yaw: 0, pitch: 0, eye: shoulderEye(0) };
    this.chatIds = new Set();
    const room = this.room;
    this.room = null;
    if (room) {
      room.reconnection.enabled = false;
      void room.leave().catch(() => {});
    }
  }
  leave() {
    this.release();
    this.update({ ...EMPTY_LOBBY });
  }
  dispose() {
    this.disposed = true;
    this.release();
  }
}

export function useLobbySession() {
  const [snapshot, setSnapshot] = useState<LobbySnapshot>(EMPTY_LOBBY);
  const session = useRef<LobbySession | null>(null);
  const [stream] = useState(() => new GameStream());
  const [debug] = useState(partyDebugEnabled);
  const [diagnostics, setDiagnostics] = useState<NetDiagnostics | null>(null);
  useEffect(() => {
    const local = new LobbySession(setSnapshot, stream, { debug });
    session.current = local;
    setDiagnostics(local.diagnostics);
    return () => {
      local.dispose();
      session.current = null;
    };
  }, []);
  const sendInput = useCallback(
    (input: MovementInput) => session.current?.sendInput(input),
    []
  );
  return {
    snapshot,
    stream,
    debug,
    diagnostics,
    sendInput,
    setReady: (ready: boolean) => session.current?.setReady(ready),
    setPropSettings: (settings: Partial<PropSettings>) => session.current?.setPropSettings(settings),
    setMode: (selection: ModeSelection) => session.current?.setMode(selection),
    connect: (action: "create" | "join", nickname: string, code: string, costumeId: SelectableCostumeId) =>
      session.current?.connect(action, nickname, code, costumeId),
    leave: () => session.current?.leave(),
    sendChat: (text: string) => session.current?.sendChat(text) ?? false,
  };
}
