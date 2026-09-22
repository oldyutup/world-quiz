import type {
  GameSnapshot,
  OnlinePhase,
} from "../../../shared/party-lab/network/protocol";
import type { SelectableCostumeId } from "../../../shared/party-lab/costumes";
export interface LobbyPlayer {
  id: string;
  nickname: string;
  connected: boolean;
  slot: number;
  color: string;
  costumeId: SelectableCostumeId;
  ready: boolean;
  participating: boolean;
}
export interface ChatMessage {
  id: string;
  playerId: string;
  nickname: string;
  text: string;
  sentAt: number;
}
/** Structural view of the schema decoded by the SDK; no server runtime imports. */
export interface LobbyState {
  code: string;
  phase: OnlinePhase;
  round: number;
  seconds: number;
  winner: number;
  players: { forEach(callback: (player: LobbyPlayer) => void): void };
  messages: { forEach(callback: (message: ChatMessage) => void): void };
}
export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";
export interface LobbySnapshot {
  status: ConnectionStatus;
  code: string;
  phase: OnlinePhase;
  round: number;
  seconds: number;
  winner: number;
  selfId: string;
  players: LobbyPlayer[];
  messages: ChatMessage[];
  notice: string;
  game: GameSnapshot | null;
}
export const EMPTY_LOBBY: LobbySnapshot = {
  status: "idle",
  code: "",
  selfId: "",
  players: [],
  messages: [],
  notice: "",
  phase: "waiting",
  round: 0,
  seconds: 0,
  winner: -1,
  game: null,
};

export function normalizeNickname(value: string) {
  return value.trim().normalize("NFC");
}
export function validNickname(value: string) {
  return /^[\p{L}\p{N}_-]{3,16}$/u.test(value);
}
export function normalizeRoomCode(value: string) {
  return value.trim().toUpperCase();
}
export function validRoomCode(value: string) {
  return /^[A-HJ-NP-Z2-9]{6}$/.test(value);
}
export const CHAT_MAX_LENGTH = 280;
