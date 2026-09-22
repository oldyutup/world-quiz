import { schema, t, type SchemaType } from "@colyseus/schema";
import { CHAT_HISTORY_LIMIT } from "./validation.js";

export const LobbyPlayer = schema(
  {
    id: t.string(),
    nickname: t.string(),
    connected: t.boolean(),
    slot: t.number(),
    color: t.string(),
    costumeId: t.string(),
    ready: t.boolean(),
    participating: t.boolean(),
  },
  "LobbyPlayer"
);
export type LobbyPlayer = SchemaType<typeof LobbyPlayer>;

export const ChatMessage = schema(
  {
    id: t.string(),
    playerId: t.string(),
    nickname: t.string(),
    text: t.string(),
    sentAt: t.number(),
  },
  "ChatMessage"
);
export type ChatMessage = SchemaType<typeof ChatMessage>;

export const LobbyState = schema(
  {
    code: t.string(),
    phase: t.string(),
    round: t.number(),
    seconds: t.number(),
    winner: t.number(),
    players: t.map(LobbyPlayer),
    messages: t.array(ChatMessage),
  },
  "LobbyState"
);
export type LobbyState = SchemaType<typeof LobbyState>;

export function appendChat(state: LobbyState, message: ChatMessage) {
  state.messages.push(message);
  while (state.messages.length > CHAT_HISTORY_LIMIT) state.messages.shift();
}
