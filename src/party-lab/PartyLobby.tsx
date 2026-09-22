import { useEffect, useRef, useState } from "react";
import { CHAT_MAX_LENGTH, type LobbySnapshot } from "./network/types";

export default function PartyLobby({ lobby, onLeave, onChat, onReady, onControls }: {
  lobby: LobbySnapshot; onLeave: () => void; onChat: (text: string) => boolean; onReady: (ready: boolean) => void; onControls: () => void;
}) {
  const [text, setText] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const history = useRef<HTMLDivElement>(null);
  const connected = lobby.status === "connected";
  const invite = new URL("/party-lab", window.location.origin);
  invite.searchParams.set("room", lobby.code);
  useEffect(() => {
    const element = history.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lobby.messages.length, lobby.messages[lobby.messages.length - 1]?.id]);

  async function copyInvite() {
    try { await navigator.clipboard.writeText(invite.href); setCopyStatus("Davet bağlantısı kopyalandı."); }
    catch { setCopyStatus("Bağlantıyı aşağıdaki alandan seçip kopyalayabilirsin."); }
  }

  return <div className="party-lab">
    <header className="pl-topbar">
      <span className="pl-brand">torble<span className="pl-brand-divider">/</span>party lab</span>
      <button className="pl-button pl-join" onClick={onControls}>Kontroller</button>
      <button className="pl-button pl-join" data-sfx="uiBack" onClick={onLeave}>Lobiden Ayrıl</button>
    </header>
    <main className="pl-room-layout">
      <section className="pl-room-friends" aria-labelledby="pl-room-title">
        <span className="pl-eyebrow">PARTY LAB / ARKADAŞ LOBİSİ</span>
        <h2 id="pl-room-title">Herkes burada mı?</h2>
        <div className="pl-room-invite">
          <span className="pl-hint">ODA KODU</span>
          <strong className="pl-room-code">{lobby.code}</strong>
          <button className="pl-button pl-join" onClick={() => void copyInvite()}>Davet Bağlantısını Kopyala</button>
          <label className="pl-hint" htmlFor="pl-invite">Davet bağlantısı</label>
          <input id="pl-invite" className="pl-invite-input" readOnly value={invite.href} onFocus={event => event.target.select()} />
          <p className="pl-hint" role="status">{copyStatus}</p>
        </div>
        <div className="pl-room-roster-heading"><h3>Arkadaşlar</h3><span>{lobby.players.filter(player => player.connected).length} / 3</span></div>
        <ul className="pl-room-roster" aria-label="Lobideki oyuncular">
          {lobby.players.map((player) => <li key={player.id}>
            <span className={`pl-lobby-avatar pl-avatar-${player.slot}`} aria-hidden="true">••</span>
            <span className="pl-room-player"><b>{player.nickname}</b>{player.id === lobby.selfId && <small>Sen</small>}
              <span>{player.connected ? (player.ready ? "Hazır" : "Hazır Değil") : "Bağlantı kesildi, yeri tutuluyor"}</span></span>
          </li>)}
          {Array.from({ length: Math.max(0, 3 - lobby.players.length) }, (_, index) => <li className="pl-empty-seat" key={`empty-${index}`}>Bir arkadaşına yer var.</li>)}
        </ul>
        <p className="pl-hint" role="status">{connected ? "Lobiye bağlısın." : lobby.status === "reconnecting" ? "Yeniden bağlanılıyor…" : "Bağlantı kapandı."}</p>
        <button className="pl-button pl-create" data-sfx="uiConfirm" disabled={!connected} aria-pressed={!!lobby.players.find(p=>p.id===lobby.selfId)?.ready}
          onClick={()=>onReady(!lobby.players.find(p=>p.id===lobby.selfId)?.ready)}>{lobby.players.find(p=>p.id===lobby.selfId)?.ready ? 'Hazır Değilim' : 'Hazır'}</button>
        <p className="pl-hint">En az 2 oyuncu gerekir. Bağlı herkes hazır olduğunda 3 saniyelik geri sayım başlar. Her turdan sonra yeniden hazır ol.</p>
      </section>
      <section className="pl-room-chat" aria-labelledby="pl-chat-title">
        <div className="pl-chat-heading"><h3 id="pl-chat-title">Oda sohbeti</h3><span className="pl-badge">GEÇİCİ</span></div>
        <p className="pl-hint">Son 40 mesaj. Oda kapanınca sohbet silinir.</p>
        <div className="pl-chat-history" role="log" aria-label="Sohbet mesajları" aria-live="polite" ref={history}>
          {lobby.messages.length === 0 && <p className="pl-chat-empty">İlk selam senden gelsin.</p>}
          {lobby.messages.map(message => <div className="pl-chat-message" key={message.id}>
            <div><b>{message.nickname}{message.playerId === lobby.selfId ? " (Sen)" : ""}</b>
              <time dateTime={new Date(message.sentAt).toISOString()}>{new Date(message.sentAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</time></div>
            <p>{message.text}</p>
          </div>)}
        </div>
        <form onSubmit={event => { event.preventDefault(); if (onChat(text)) setText(""); }}>
          <label htmlFor="pl-chat-message">Mesajın</label>
          <div className="pl-join-row"><input id="pl-chat-message" value={text} maxLength={CHAT_MAX_LENGTH}
            placeholder="Bir şeyler yaz…" autoComplete="off" disabled={!connected} aria-describedby="pl-chat-limit"
            onChange={event => setText(event.target.value)} />
            <button className="pl-button pl-join" disabled={!connected || !text.trim()}>Gönder</button></div>
          <p className="pl-hint" id="pl-chat-limit">{text.length} / 280 · 5 saniyede en fazla 4 mesaj</p>
        </form>
        <p className="pl-status" role="status">{lobby.notice || "Sohbet yalnızca bu odadaki arkadaşlarına görünür."}</p>
      </section>
    </main>
  </div>;
}
