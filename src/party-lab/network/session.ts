import { useEffect, useRef, useState } from "react";
import type { Room } from "@colyseus/sdk";
import { createLobbyClient, lobbyError } from "./client";
import { CHAT_MAX_LENGTH, EMPTY_LOBBY, normalizeNickname, normalizeRoomCode, validNickname, validRoomCode,
  type ChatMessage, type LobbyPlayer, type LobbySnapshot, type LobbyState } from "./types";

type LobbyRoom = Room<unknown, LobbyState>;
const notices: Record<string, string> = {
  CHAT_RATE_LIMIT: "Biraz yavaşla. 5 saniyede en fazla 4 mesaj gönderebilirsin.",
  INVALID_CHAT: "Mesajın 1–280 karakterlik düz metin olmalı.",
  INVALID_MESSAGE: "Bu işlem lobide desteklenmiyor.",
};

/** One in-memory session per mounted Party Lab root. No accounts or persisted tokens. */
export class LobbySession {
  private room: LobbyRoom | null = null;
  private snapshot: LobbySnapshot = { ...EMPTY_LOBBY };
  private generation = 0;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly publish: (snapshot: LobbySnapshot) => void) {}

  private update(change: Partial<LobbySnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    if (!this.disposed) this.publish(this.snapshot);
  }

  async connect(action: "create" | "join", rawNickname: string, rawCode: string) {
    if (this.disposed || this.room || this.snapshot.status === "connecting") return;
    const nickname = normalizeNickname(rawNickname);
    const code = normalizeRoomCode(rawCode);
    if (!validNickname(nickname) || (action === "join" && !validRoomCode(code))) return;
    const generation = ++this.generation;
    this.update({ ...EMPTY_LOBBY, status: "connecting" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const client = createLobbyClient();
      const pending = action === "create"
        ? client.create<LobbyState>("party_lab", { nickname, intent: "create" })
        : client.joinById<LobbyState>(code, { nickname, code, intent: "join" });
      // Late successful admissions must be released after timeout/unmount/cancel.
      void pending.then(room => {
        if (this.disposed || generation !== this.generation) void room.leave().catch(() => {});
      }, () => {});
      const room = await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("CONNECT_TIMEOUT")), 12000);
      })]);
      if (this.disposed || generation !== this.generation) return;
      this.room = room;
      Object.assign(room.reconnection, { minUptime: 0, maxRetries: 10, minDelay: 500, maxDelay: 2000, maxEnqueuedMessages: 0 });
      const current = () => !this.disposed && this.room === room;
      const copyState = (state: LobbyState) => {
        if (!current() || !state?.players) return;
        const players: LobbyPlayer[] = [];
        const messages: ChatMessage[] = [];
        state.players.forEach(player => players.push({ id: player.id, nickname: player.nickname, connected: player.connected }));
        state.messages.forEach(message => messages.push({ id: message.id, playerId: message.playerId, nickname: message.nickname, text: message.text, sentAt: message.sentAt }));
        this.update({ code: state.code, players, messages });
      };
      room.onStateChange(copyState);
      room.onMessage("notice", (code: string) => { if (current()) this.update({ notice: notices[code] ?? "İşlem tamamlanamadı." }); });
      room.onDrop(() => {
        if (!current()) return;
        this.update({ status: "reconnecting", notice: "Bağlantı kesildi. Yeniden bağlanılıyor…" });
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          if (current()) { this.release(); this.update({ status: "disconnected", notice: "Yeniden bağlanılamadı. Lobiden çıkıp tekrar katılabilirsin." }); }
        }, 16000);
      });
      room.onReconnect(() => {
        if (!current()) return;
        clearTimeout(this.reconnectTimer);
        this.update({ status: "connected", notice: "Yeniden bağlandın." });
        copyState(room.state);
      });
      room.onLeave(() => {
        if (!current()) return;
        clearTimeout(this.reconnectTimer);
        this.room = null;
        this.update({ status: "disconnected", notice: "Odadan ayrıldın veya bağlantı süresi doldu." });
      });
      room.onError(() => { if (current()) this.update({ notice: "Bağlantıda bir sorun oluştu." }); });
      this.update({ status: "connected", code: room.roomId, selfId: room.sessionId, notice: "" });
      copyState(room.state);
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.generation++;
        this.update({ ...EMPTY_LOBBY, notice: lobbyError(error) });
      }
    } finally { clearTimeout(timer); }
  }

  sendChat(text: string): boolean {
    if (!this.room?.connection.isOpen || this.snapshot.status !== "connected" || !text.trim() || text.length > CHAT_MAX_LENGTH) return false;
    try {
      this.room.send("chat", text);
      this.update({ notice: "" });
      return true;
    } catch {
      this.update({ notice: "Mesaj gönderilemedi. Bağlantı gelince tekrar dene." });
      return false;
    }
  }
  private release() {
    clearTimeout(this.reconnectTimer);
    this.generation++;
    const room = this.room;
    this.room = null;
    if (room) { room.reconnection.enabled = false; void room.leave().catch(() => {}); }
  }
  leave() { this.release(); this.update({ ...EMPTY_LOBBY }); }
  dispose() { this.disposed = true; this.release(); }
}

export function useLobbySession() {
  const [snapshot, setSnapshot] = useState<LobbySnapshot>(EMPTY_LOBBY);
  const session = useRef<LobbySession | null>(null);
  useEffect(() => {
    const local = new LobbySession(setSnapshot);
    session.current = local;
    return () => { local.dispose(); session.current = null; };
  }, []);
  return { snapshot,
    connect: (action: "create" | "join", nickname: string, code: string) => session.current?.connect(action, nickname, code),
    leave: () => session.current?.leave(),
    sendChat: (text: string) => session.current?.sendChat(text) ?? false,
  };
}
