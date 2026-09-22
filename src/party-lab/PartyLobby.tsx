import { useEffect, useRef, useState, type RefObject } from "react";
import { CHAT_MAX_LENGTH, type LobbySnapshot } from "./network/types";
import { COSTUME_NAMES, COSTUME_SYMBOLS } from "./scene/visual/costumes";

export default function PartyLobby({ lobby, onLeave, onChat, onReady, onControls, controlsRef }: {
  lobby: LobbySnapshot; onLeave: () => void; onChat: (text: string) => boolean; onReady: (ready: boolean) => void; onControls: () => void;
  controlsRef?: RefObject<HTMLButtonElement>;
}) {
  const [text, setText] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [copyFallback, setCopyFallback] = useState<"code" | "invite" | null>(null);
  const history = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const connected = lobby.status === "connected";
  const playersOnline = lobby.players.filter(player => player.connected);
  const readyCount = playersOnline.filter(player => player.ready).length;
  const ready = !!lobby.players.find(player => player.id === lobby.selfId)?.ready;
  const invite = new URL("/party-lab", window.location.origin);
  invite.searchParams.set("room", lobby.code);
  const lastMessage = lobby.messages[lobby.messages.length - 1];
  useEffect(() => {
    const element = history.current;
    if (element && (followMessages.current || lastMessage?.playerId === lobby.selfId)) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lastMessage?.id, lastMessage?.playerId, lobby.selfId]);

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
        <button ref={controlsRef} className="pl-button pl-quiet" onClick={onControls}>Kontroller</button>
        <button className="pl-button pl-quiet" data-sfx="uiBack" onClick={onLeave}>Lobiden Ayrıl <span aria-hidden="true">↗</span></button>
      </nav>
    </header>
    <main className="pl-room-layout">
      <section className="pl-room-friends" aria-labelledby="pl-room-title">
        <div className="pl-room-details">
          <header className="pl-room-heading">
            <span className="pl-eyebrow">Arkadaş lobisi</span>
            <h1 id="pl-room-title">Herkes burada mı?</h1>
            <p>Arkadaşlarını davet et, hazır ol, kapış.</p>
          </header>
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
          <div className="pl-room-roster-heading"><h2>Oyuncular</h2><span>{playersOnline.length} / 3</span></div>
          <ul className="pl-room-roster" aria-label="Lobideki oyuncular">
            {lobby.players.map(player => <li key={player.id}>
              <span className="pl-lobby-avatar" style={{ borderColor: player.color }} aria-hidden="true">{COSTUME_SYMBOLS[player.costumeId]}</span>
              <span className="pl-room-player"><b>{player.nickname}{player.id === lobby.selfId && <small>Sen</small>}</b><small className="pl-costume-name">{COSTUME_NAMES[player.costumeId]}</small></span>
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
          <p className="pl-hint">En az 2 kişi. Herkes hazır olunca 3 saniye içinde başlar.</p>
        </footer>
      </section>
      <section className="pl-room-chat" aria-labelledby="pl-chat-title">
        <header className="pl-chat-heading"><h2 id="pl-chat-title">Oda Sohbeti</h2><p className="pl-hint">Son 40 mesaj. Oda kapanınca sohbet silinir.</p></header>
        <div className="pl-chat-history" role="log" aria-label="Sohbet mesajları" aria-live="polite" tabIndex={0} ref={history}
          onScroll={event => { const el = event.currentTarget; followMessages.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
          {lobby.messages.length === 0 && <div className="pl-chat-empty"><span aria-hidden="true">“</span><p>İlk selam senden gelsin.</p><small>Tur başlamadan biraz sohbet?</small></div>}
          {lobby.messages.map(message => <div className={`pl-chat-message${message.playerId === lobby.selfId ? " is-self" : ""}`} key={message.id}>
            <div><b>{message.nickname}</b>{message.playerId === lobby.selfId && <span className="pl-chat-self">Sen</span>}
              <time dateTime={new Date(message.sentAt).toISOString()}>{new Date(message.sentAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</time></div>
            <p>{message.text}</p>
          </div>)}
        </div>
        <form className="pl-chat-compose" onSubmit={event => { event.preventDefault(); if (onChat(text)) { followMessages.current = true; setText(""); } }}>
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
