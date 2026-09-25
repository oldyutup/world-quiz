import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CHAT_MAX_LENGTH, type LobbySnapshot } from "./network/types";
import type { NetDiagnostics } from "./network/diagnostics";
import { linkDebugLines } from "./network/debugFormat";
import { CHAT_INTENT_MS, followMessages, followScroll, initialChatFollow, jumpToLatest } from "./chatFollow";
import { COSTUME_NAMES, COSTUME_SYMBOLS } from "./scene/visual/costumes";
import { modeListStep, modeListWidth, placeModeList } from "./modePicker";
import { MODE_NAMES, MODE_SELECTIONS, type ModeSelection } from "../../shared/party-lab/modes";

const MODE_HINTS: Readonly<Record<ModeSelection, string>> = {
  rooftop_brawl: "Yumruk, tut, kaldır. Son ayakta kalan kazanır.",
  barn_shootout: "Silah bul, nişan al. 2:30 sonunda en çok öldüren kazanır.",
  layer_chaos: "Bastığın karo kırılır, katman katman düş. En alttan düşmeyen kazanır.",
  color_chaos: "Hedef renge koş; diğer renkler düşer. Son ayakta kalan kazanır.",
  mixed: "Dört mod karışık sırayla; aynı mod art arda gelmez.",
};

/** Opt-in (`?partyDebug=1`) link/chat timing lines; refresh on their own clock while shown. */
function LinkDebug({ diagnostics }: { diagnostics: NetDiagnostics }) {
  const [, redraw] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => redraw(n => n + 1), 500);
    return () => clearInterval(timer);
  }, []);
  return <pre className="pl-net-debug">{linkDebugLines(diagnostics).join("\n")}</pre>;
}

/** Collapsed by default, out of the chat panel; stays open across rounds for this page session. */
let lobbyDebugOpen = false;
function LobbyDebug({ diagnostics }: { diagnostics: NetDiagnostics }) {
  const [open, setOpen] = useState(() => lobbyDebugOpen);
  const button = useRef<HTMLButtonElement>(null);
  return <div className="pl-lobby-debug" onKeyDown={event => {
    if (event.key !== "Escape" || !open) return;
    setOpen(lobbyDebugOpen = false);
    button.current?.focus();
  }}>
    <button ref={button} type="button" className="pl-button pl-quiet" aria-expanded={open} aria-controls={open ? "pl-lobby-debug-panel" : undefined}
      onClick={() => setOpen(lobbyDebugOpen = !open)}>Debug bilgileri</button>
    {open && <div id="pl-lobby-debug-panel" className="pl-debug-panel pl-lobby-debug-panel"><LinkDebug diagnostics={diagnostics} /></div>}
  </div>;
}

/**
 * One compact row: the selected mode, and for the host a button opening the mode list
 * (the server clears every Ready on a change, as before). Others see the choice only.
 */
function ModePicker({ selection, next, isHost, hostName, enabled, onMode }: {
  selection: ModeSelection; next: ModeSelection; isHost: boolean; hostName?: string; enabled: boolean; onMode?: (selection: ModeSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const canPick = isHost && enabled;
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useEffect(() => { if (!canPick) setOpen(false); }, [canPick]);
  // Placed before paint: width first (the hints wrap to it), then the height at that width.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const element = popover.current;
      if (!anchor || !element) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      element.style.width = `${modeListWidth(anchor, viewport)}px`;
      element.style.maxHeight = "none";
      const at = placeModeList(anchor, element.offsetHeight, viewport);
      Object.assign(element.style, { top: `${at.top}px`, left: `${at.left}px`, maxHeight: `${at.maxHeight}px` });
      element.dataset.side = at.above ? "top" : "bottom";
    };
    place();
    (options.current[MODE_SELECTIONS.indexOf(selection)] ?? options.current[0])?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node)) close(false); };
    // The page or the details column moved the trigger: close rather than float detached.
    // Other scrollers (the chat following a new message, the list itself) leave it open.
    const scrolled = (event: Event) => { if (event.target instanceof Node && event.target.contains(trigger.current)) close(false); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const who = isHost ? "Sen seçiyorsun" : `${hostName ? `Oda sahibi ${hostName}` : "Oda sahibi"} seçiyor`;
  return <section className="pl-mode" aria-labelledby="pl-mode-title">
    <div className="pl-mode-row">
      <div className="pl-mode-label"><h2 id="pl-mode-title">Oyun modu</h2><span>{who}</span></div>
      <div className="pl-mode-picker" ref={picker}>
        {isHost
          ? <button ref={trigger} type="button" className="pl-mode-trigger" disabled={!enabled} data-selection={selection}
            aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? "pl-mode-list" : undefined}
            onClick={() => setOpen(value => !value)}
            onKeyDown={event => { if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setOpen(true); } }}>
            <span className="pl-visually-hidden">Oyun modu: </span><b>{MODE_NAMES[selection]}</b>
            <svg className="pl-mode-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
          </button>
          : <span className="pl-mode-trigger is-static" data-selection={selection}><b>{MODE_NAMES[selection]}</b></span>}
        {open && <div ref={popover} className="pl-mode-popover">
          <div id="pl-mode-list" role="listbox" aria-labelledby="pl-mode-title" onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); close(true); return; }
            // Tab leaves from the trigger, so focus continues in page order (the list is gone by then).
            if (event.key === "Tab") { close(true); return; }
            const index = options.current.findIndex(option => option === document.activeElement);
            const step = modeListStep(event.key, Math.max(0, index), MODE_SELECTIONS.length);
            if (step === null) return;
            event.preventDefault();
            options.current[step]?.focus();
          }}>
            {MODE_SELECTIONS.map((option, index) => <button key={option} ref={element => { options.current[index] = element; }}
              type="button" role="option" aria-selected={selection === option} tabIndex={selection === option ? 0 : -1}
              className={`pl-mode-option${selection === option ? " is-selected" : ""}`} data-mode={option}
              onClick={() => { if (selection !== option) onMode?.(option); close(true); }}>
              <span><b>{MODE_NAMES[option]}</b><small>{MODE_HINTS[option]}</small></span>
              <span className="pl-mode-check" aria-hidden="true">{selection === option ? "✓" : ""}</span>
            </button>)}
          </div>
          <p className="pl-mode-popover-note">Mod değişince herkes yeniden hazır olur.</p>
        </div>}
      </div>
    </div>
    <p className="pl-mode-next" role="status" data-next-mode={next}>
      {selection === "mixed" ? <>Sıradaki tur: <b>{MODE_NAMES[next]}</b> · {MODE_HINTS.mixed}</> : MODE_HINTS[selection]}
    </p>
  </section>;
}

export default function PartyLobby({ lobby, onLeave, onChat, onReady, onMode, onControls, controlsRef, diagnostics, debug }: {
  lobby: LobbySnapshot; onLeave: () => void; onChat: (text: string) => boolean; onReady: (ready: boolean) => void; onMode?: (selection: ModeSelection) => void; onControls: () => void;
  controlsRef?: RefObject<HTMLButtonElement>; diagnostics?: NetDiagnostics | null; debug?: boolean;
}) {
  const [text, setText] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [copyFallback, setCopyFallback] = useState<"code" | "invite" | null>(null);
  const history = useRef<HTMLDivElement>(null);
  const follow = useRef(initialChatFollow());
  const readerIntent = useRef(-Infinity);
  const [unread, setUnread] = useState(0);
  const connected = lobby.status === "connected";
  const playersOnline = lobby.players.filter(player => player.connected);
  const readyCount = playersOnline.filter(player => player.ready).length;
  const ready = !!lobby.players.find(player => player.id === lobby.selfId)?.ready;
  const isHost = !!lobby.selfId && lobby.hostId === lobby.selfId;
  const host = lobby.players.find(player => player.id === lobby.hostId);
  const invite = new URL("/party-lab", window.location.origin);
  invite.searchParams.set("room", lobby.code);
  const pinToLatest = () => {
    const element = history.current;
    if (element) element.scrollTop = element.scrollHeight;
  };
  // Layout effect: the newest message is on screen in the same paint it is committed.
  useLayoutEffect(() => {
    const next = followMessages(follow.current, lobby.messages, lobby.selfId);
    follow.current = next.state;
    if (next.pin) pinToLatest();
    setUnread(next.state.unread);
    const last = lobby.messages[lobby.messages.length - 1];
    if (last) diagnostics?.chatRendered(last.id, performance.now());
  }, [lobby.messages, lobby.selfId, diagnostics]);
  // Size changes (window, notices, being re-shown after Controls) keep a follower pinned.
  useEffect(() => {
    const element = history.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (follow.current.following) pinToLatest(); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  async function copy(kind: "code" | "invite") {
    try {
      await navigator.clipboard.writeText(kind === "code" ? lobby.code : invite.href);
      setCopyFallback(null);
      setCopyStatus(kind === "code" ? "Oda kodu kopyalandı." : "Davet bağlantısı kopyalandı.");
    } catch {
      setCopyFallback(kind);
      setCopyStatus("Aşağıdaki alanı seçip elle kopyalayabilirsin.");
    }
  }

  return <div className="party-lab pl-room">
    <header className="pl-topbar">
      <span className="pl-brand">torble<span className="pl-brand-divider">/</span>party lab</span>
      <nav className="pl-room-nav" aria-label="Lobi menüsü">
        {debug && diagnostics && <LobbyDebug diagnostics={diagnostics} />}
        <button ref={controlsRef} className="pl-button pl-quiet" onClick={onControls}>Kontroller</button>
        <button className="pl-button pl-quiet" data-sfx="uiBack" onClick={onLeave}>Lobiden Ayrıl <span aria-hidden="true">↗</span></button>
      </nav>
    </header>
    <main className="pl-room-layout">
      <section className="pl-room-friends" aria-labelledby="pl-room-title">
        <h1 id="pl-room-title" className="pl-visually-hidden">Arkadaş lobisi</h1>
        <div className="pl-room-details">
          <div className="pl-room-invite">
            <div className="pl-room-code-row">
              <div><span className="pl-hint">Oda kodu</span><strong className="pl-room-code">{lobby.code}</strong></div>
              <button className="pl-button pl-join" aria-label="Oda kodunu kopyala" onClick={() => void copy("code")}>Kopyala</button>
            </div>
            <button className="pl-invite-link" onClick={() => void copy("invite")}><span aria-hidden="true">↗</span> Davet bağlantısını kopyala</button>
            <p className="pl-copy-status" role="status">{copyStatus}</p>
            {copyFallback && <div className="pl-copy-fallback">
              <label htmlFor="pl-invite">{copyFallback === "code" ? "Oda kodu" : "Davet bağlantısı"}</label>
              <input id="pl-invite" readOnly value={copyFallback === "code" ? lobby.code : invite.href} onFocus={event => event.target.select()} />
            </div>}
          </div>
          <ModePicker selection={lobby.selection} next={lobby.mode} isHost={isHost} hostName={host?.nickname} enabled={connected} onMode={onMode} />
          <div className="pl-room-roster-heading"><h2>Oyuncular</h2><span>{playersOnline.length} / 3</span></div>
          <ul className="pl-room-roster" aria-label="Lobideki oyuncular">
            {lobby.players.map(player => <li key={player.id}>
              <span className="pl-lobby-avatar" style={{ borderColor: player.color }} aria-hidden="true">{COSTUME_SYMBOLS[player.costumeId]}</span>
              <span className="pl-room-player"><b>{player.nickname}{player.id === lobby.selfId && <small>Sen</small>}{player.id === lobby.hostId && <small className="pl-host-tag">Oda sahibi</small>}</b><small className="pl-costume-name">{COSTUME_NAMES[player.costumeId]}</small></span>
              <span className={`pl-player-status${player.connected && player.ready ? " is-ready" : ""}`}>
                <span aria-hidden="true">{!player.connected ? "↻" : player.ready ? "✓" : "○"}</span>{" "}
                {player.connected ? (player.ready ? "Hazır" : "Hazır Değil") : "Yeniden bağlanıyor"}
              </span>
            </li>)}
            {Array.from({ length: Math.max(0, 3 - lobby.players.length) }, (_, index) => <li className="pl-empty-seat" key={`empty-${index}`}>
              <span className="pl-empty-avatar" aria-hidden="true">+</span><span>Bir arkadaşına yer var.</span>
            </li>)}
          </ul>
        </div>
        <footer className="pl-room-ready">
          <p className="pl-ready-summary" role="status">{!connected
            ? lobby.status === "reconnecting" ? "Yeniden bağlanılıyor…" : "Bağlantı kapandı. Lobiye tekrar katıl."
            : playersOnline.length < 2 ? "Başlamak için bir arkadaşını davet et."
            : `${readyCount} / ${playersOnline.length} oyuncu hazır`}</p>
          <button className={`pl-button pl-create pl-ready-button${ready ? " is-ready" : ""}`} data-sfx="uiConfirm" disabled={!connected} aria-pressed={ready}
            onClick={() => onReady(!ready)}>{ready ? "✓ Hazırsın" : "Hazır"}<span aria-hidden="true">{ready ? "Hazır Değilim" : "→"}</span></button>
          {connected && lobby.link === "degraded" && <p className="pl-link-warning" role="status">Bağlantı yavaş: sunucudan veri gecikiyor. Bağlantı kesilmedi.</p>}
        </footer>
      </section>
      <section className="pl-room-chat" aria-labelledby="pl-chat-title">
        <header className="pl-chat-heading"><h2 id="pl-chat-title">Oda Sohbeti</h2><p className="pl-hint">Son 40 mesaj. Oda kapanınca sohbet silinir.</p></header>
        <div className="pl-chat-body">
        <div className="pl-chat-history" role="log" aria-label="Sohbet mesajları" aria-live="polite" tabIndex={0} ref={history}
          onWheel={() => { readerIntent.current = performance.now(); }} onTouchMove={() => { readerIntent.current = performance.now(); }}
          onPointerDown={() => { readerIntent.current = performance.now(); }} onKeyDown={() => { readerIntent.current = performance.now(); }}
          onScroll={event => {
            follow.current = followScroll(follow.current, event.currentTarget, performance.now() - readerIntent.current < CHAT_INTENT_MS);
            setUnread(follow.current.unread);
          }}>
          {lobby.messages.length === 0 && <div className="pl-chat-empty"><span aria-hidden="true">“</span><p>İlk selam senden gelsin.</p><small>Tur başlamadan biraz sohbet?</small></div>}
          {lobby.messages.map(message => <div className={`pl-chat-message${message.playerId === lobby.selfId ? " is-self" : ""}`} key={message.id}>
            <div><b>{message.nickname}</b>{message.playerId === lobby.selfId && <span className="pl-chat-self">Sen</span>}
              <time dateTime={new Date(message.sentAt).toISOString()}>{new Date(message.sentAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</time></div>
            <p>{message.text}</p>
          </div>)}
        </div>
        {unread > 0 && <button type="button" className="pl-chat-jump" onClick={() => { follow.current = jumpToLatest(follow.current); setUnread(0); pinToLatest(); }}>
          <span aria-hidden="true">↓</span> {unread} yeni mesaj</button>}
        </div>
        <form className="pl-chat-compose" onSubmit={event => { event.preventDefault(); if (onChat(text)) setText(""); }}>
          <label htmlFor="pl-chat-message">Mesajın</label>
          <div className="pl-join-row"><input id="pl-chat-message" value={text} maxLength={CHAT_MAX_LENGTH}
            placeholder="Bir şeyler yaz…" autoComplete="off" disabled={!connected} aria-describedby="pl-chat-limit"
            onChange={event => setText(event.target.value)} />
            <button className="pl-button pl-join" disabled={!connected || !text.trim()}>Gönder</button></div>
          <p className="pl-hint" id="pl-chat-limit">{text.length} / {CHAT_MAX_LENGTH} · 5 saniyede en fazla 4 mesaj</p>
          <p className="pl-chat-notice" role="status">{lobby.notice}</p>
        </form>
      </section>
    </main>
  </div>;
}
