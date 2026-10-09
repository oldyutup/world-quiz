import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { isUIInput } from "../input/device";
import { CHAT_MAX_LENGTH, type ChatMessage, type LobbySnapshot } from "../network/types";
import { CHAT_NOTICE_MS, ChatArrivals, chatLayoutVars, chatLines, nextFade, opensChat, type ChatPlace } from "./gameChat";

interface ArenaChatState {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The arena's Esc menu is open: Enter belongs to its buttons, the chat stays shut. */
  menuOpen: boolean;
  reportMenu: (open: boolean) => void;
  arrivals: ChatArrivals;
}
const ArenaChatContext = createContext<ArenaChatState | null>(null);

/** Null outside an online room (the local arena has no chat). */
export const useArenaChat = () => useContext(ArenaChatContext);

/**
 * Mounted for the whole room session, so a line sent in the lobby is still fresh in the arena.
 * `synced`: the room's first state has arrived (until then the history is not known yet).
 */
export function ArenaChatProvider({ messages, synced, children }: { messages: readonly ChatMessage[]; synced: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [arrivals] = useState(() => new ChatArrivals());
  // During render: the overlay reads arrival times in this same pass.
  useMemo(() => arrivals.observe(messages, performance.now(), synced), [arrivals, messages, synced]);
  const reportMenu = useCallback((value: boolean) => {
    setMenuOpen(value);
    if (value) setOpen(false);
  }, []);
  const value = useMemo(() => ({ open, setOpen, menuOpen, reportMenu, arrivals }), [open, menuOpen, reportMenu, arrivals]);
  return <ArenaChatContext.Provider value={value}>{children}</ArenaChatContext.Provider>;
}

function useCoarsePointer() {
  const [query] = useState(() => (typeof window.matchMedia === "function" ? window.matchMedia("(pointer: coarse)") : null));
  const [coarse, setCoarse] = useState(() => !!query?.matches);
  useEffect(() => {
    if (!query) return;
    const update = () => setCoarse(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [query]);
  return coarse;
}

/**
 * After the press that closed the chat: that press (its mouse events and its click) never
 * reaches the game, so it neither punches, fires, counts as a press nor takes the pointer
 * lock. The next press does. A mouse's own events follow its pointerup in the same task; a
 * tap's click comes after the touch ends, so it is waited for a little longer.
 */
function swallowPress(pointerType: string) {
  const stop = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
  };
  const mouse = pointerType === "mouse";
  const types = mouse ? (["mousedown", "click"] as const) : (["click"] as const);
  const done = () => {
    for (const type of types) window.removeEventListener(type, stop, true);
    window.removeEventListener("pointerup", released, true);
  };
  const released = () => setTimeout(done, 0);
  for (const type of types) window.addEventListener(type, stop, { capture: true, once: true });
  if (mouse) window.addEventListener("pointerup", released, { capture: true, once: true });
  setTimeout(done, mouse ? 1000 : 600);
}

const ChatIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3A1.5 1.5 0 0 1 4 11.5v-6Z" />
  </svg>
);

/**
 * In-game chat (see gameChat.ts). Enter opens it, Enter sends and closes, Esc closes without
 * sending (and never reaches the Esc menu). A tap outside closes it, keeping the draft. On
 * touch screens a small button opens it and the field sits at the top of the screen, which
 * the on-screen keyboard leaves visible, so the page is never pushed up under it.
 */
export default function ArenaChat({ lobby, onChat, place }: { lobby: LobbySnapshot; onChat: (text: string) => boolean; place: ChatPlace }) {
  const chat = useArenaChat()!;
  const { open, setOpen, menuOpen, arrivals } = chat;
  const touch = useCoarsePointer();
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const [, redraw] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const now = performance.now();
  const lines = chatLines(lobby.messages, lobby.players, lobby.selfId, (id) => arrivals.at(id), now, open);
  // A notice already there when the arena opened is old news (it was shown in the lobby).
  const notice = useRef<{ text: string; at: number }>({ text: lobby.notice, at: -Infinity });
  if (notice.current.text !== lobby.notice) notice.current = { text: lobby.notice, at: now };
  const noticeShown = !!notice.current.text && now - notice.current.at < CHAT_NOTICE_MS;
  // One redraw when the next line fades or the notice expires.
  useEffect(() => {
    const fade = nextFade(lines, (id) => arrivals.at(id), performance.now(), open);
    const expiry = noticeShown ? notice.current.at + CHAT_NOTICE_MS - performance.now() : null;
    const wait = [fade, expiry].filter((v): v is number => v !== null).reduce((a, b) => Math.min(a, b), Infinity);
    if (!Number.isFinite(wait)) return;
    const timer = setTimeout(() => redraw((n) => n + 1), Math.max(0, wait) + 30);
    return () => clearTimeout(timer);
  });
  // Closing on unmount: the room was left, or Controls opened over the arena.
  useEffect(() => () => setOpen(false), [setOpen]);
  // Enter opens; capture phase, so a game that bound Enter never sees this press.
  useEffect(() => {
    if (open || menuOpen) return;
    const key = (event: KeyboardEvent) => {
      if (!opensChat(event, isUIInput(event.target))) return;
      event.preventDefault();
      event.stopPropagation();
      setFailed(false);
      setOpen(true);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open, menuOpen, setOpen]);
  useLayoutEffect(() => {
    if (open) field.current?.focus({ preventScroll: true });
  }, [open]);
  // A press anywhere else closes it (the draft stays); that press is not game input.
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      event.stopPropagation();
      event.preventDefault();
      swallowPress(event.pointerType);
      setOpen(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [open, setOpen]);
  const close = () => setOpen(false);
  const style = useMemo(() => chatLayoutVars(place) as CSSProperties, [place]);
  const connected = lobby.status === "connected";
  return (
    <div className="party-lab pl-game-chat-root">
      <div
        ref={root}
        className="pl-game-chat"
        data-party-controls
        data-chat-place={place}
        data-open={open}
        data-touch={touch}
        style={style}
        // Inside the chat a press never moves focus off the field (that would close it).
        onMouseDown={(event) => {
          if (open && event.target !== field.current) event.preventDefault();
        }}
      >
        <ol className="pl-game-chat-lines" role="log" aria-live="polite" aria-label="Oyun sohbeti">
          {lines.map((line) => (
            <li key={line.id} data-shown={line.shown} data-self={line.self}>
              <span>
                <b style={{ color: line.color }}>{line.name}</b> {line.text}
              </span>
            </li>
          ))}
        </ol>
        {(noticeShown || (open && failed)) && (
          <p className="pl-game-chat-notice" role="status">
            {open && failed ? "Bağlantı bekleniyor; mesaj gönderilemedi." : notice.current.text}
          </p>
        )}
        {open ? (
          <form
            className="pl-game-chat-compose"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draft.trim()) {
                setDraft("");
                close();
                return;
              }
              if (onChat(draft)) {
                setDraft("");
                setFailed(false);
                close();
              } else setFailed(true);
            }}
          >
            <input
              ref={field}
              value={draft}
              maxLength={CHAT_MAX_LENGTH}
              enterKeyHint="send"
              autoComplete="off"
              spellCheck={false}
              aria-label="Sohbet mesajı"
              placeholder={connected ? "Mesajını yaz…" : "Bağlantı bekleniyor…"}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Typing is chat only: no game listener (window, bubble phase) sees these keys.
                event.stopPropagation();
                if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  setDraft("");
                  close();
                }
              }}
              onBlur={(event) => {
                if (!root.current?.contains(event.relatedTarget as Node | null)) close();
              }}
            />
            {touch && (
              <button type="submit" className="pl-game-chat-send" aria-label="Gönder">
                Gönder
              </button>
            )}
            {!touch && <small className="pl-game-chat-keys">Enter gönder · Esc kapat</small>}
          </form>
        ) : (
          touch && (
            <button
              type="button"
              className="pl-game-chat-toggle"
              aria-label="Sohbeti aç"
              onClick={() => {
                // Synchronously, inside the tap: iOS opens the keyboard only for a focus made there.
                flushSync(() => {
                  setFailed(false);
                  setOpen(true);
                });
                field.current?.focus({ preventScroll: true });
              }}
            >
              <ChatIcon />
            </button>
          )
        )}
      </div>
    </div>
  );
}
