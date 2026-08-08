/**
 * RouteDuelLobby.tsx — Rota Duel oda lobisi (presentational).
 *
 * Düzen Çark Online 1v1 lobisiyle aynı iskelet (.duel-lobby-with-chat
 * .duel-1v1-room-layout): solda büyük oda paneli (ODA HAZIR + 6 haneli kod +
 * Linki Kopyala / Arkadaş Davet Et + davet linki + Oyuncular + Oda Ayarları +
 * Oyunu Başlat / Lobiye Dön), sağda gerçek LobbyChat paneli.
 *
 * Zümrüt tema: RouteDuelGame kökü data-theme="dark-space" taşır → mevcut
 * [data-theme="dark-space"] .duel-* kuralları (zv-token ailesi) paneli koyu
 * zümrüt + turkuaz CTA'ya çevirir; yeni renk sistemi İCAT EDİLMEZ.
 *
 * Yalnız görsel/etkileşim katmanı: tüm ayar/başlatma mutasyonları parent'tan
 * gelen callback'lerle sunucu-otoriter RPC'lere gider.
 */
import LobbyChat from "../LobbyChat";
import { GuestTag } from "../GuestTag";
import { PlayerAvatar } from "../PlayerAvatar";
import { PlayerProfileTrigger } from "../PlayerProfileTrigger";
import { LobbyInviteBar } from "../LobbyInviteBar";
import {
  ROUTE_DUEL_ROUND_OPTIONS,
  ROUTE_DUEL_LENGTH_OPTIONS,
  routeDuelChatKey,
  type RouteDuelRoom,
  type RouteDuelPlayer,
  type RouteDuelLength,
} from "../../lib/routeDuelShared";

interface RosterProfile {
  avatarId?: string | null;
}

interface Props {
  room: RouteDuelRoom;
  players: RouteDuelPlayer[];
  myId: string;
  myClaimToken: string;
  isHost: boolean;
  playerName: string;
  shareLink: string;
  inviteMessage: string;
  rosterProfiles: Map<string, RosterProfile>;
  errorMsg: string | null;
  onUpdateSetting: (next: { total_rounds?: number; route_length?: RouteDuelLength }) => void;
  onStart: () => void;
  onLeave: () => void;
}

export default function RouteDuelLobby({
  room,
  players,
  myId,
  myClaimToken,
  isHost,
  playerName,
  shareLink,
  inviteMessage,
  rosterProfiles,
  errorMsg,
  onUpdateSetting,
  onStart,
  onLeave,
}: Props) {
  return (
    <div className="duel-lobby">
      <div className="duel-lobby-with-chat duel-1v1-room-layout">
        <div className="duel-lobby-card duel-1v1-room-card">
          <h2 className="duel-lobby-title" style={{ fontSize: 22, margin: "0 0 14px" }}>
            {isHost ? "Oda Hazır" : "Odaya Katıldın"}
          </h2>

          {/* Oda kodu */}
          <div className="duel-room-code-block" style={{ margin: "0 0 12px" }}>
            <span className="duel-room-code" style={{ fontSize: 36, letterSpacing: "0.15em" }}>
              {room.code}
            </span>
            <p className="duel-room-code-hint" style={{ fontSize: 12, marginTop: 4 }}>
              6 haneli kod — arkadaşına ver
            </p>
          </div>

          {/* Davet */}
          <LobbyInviteBar
            inviteMessage={inviteMessage}
            shareLink={shareLink}
            roomCode={room.code}
            mode="routeDuel"
            roomUrl={`/?routeDuel=${room.code}`}
          />

          <div
            className="duel-link-preview"
            style={{ marginBottom: 10 }}
            onClick={e => {
              const el = e.currentTarget.querySelector("input") as HTMLInputElement | null;
              el?.select();
            }}
          >
            <input
              className="duel-link-input"
              readOnly
              value={shareLink}
              onFocus={e => e.target.select()}
            />
          </div>

          {/* Oyuncular + Ayarlar */}
          <div className="duel-wait-middle" style={{ marginTop: 8 }}>
            <div className="duel-wait-players-box">
              <div className="duel-wait-section-title">Oyuncular</div>

              <div className="duel-players-list duel-wait-players">
                {players.map(p => {
                  const isMe = p.id === myId;
                  const isPlayerHost = p.id === room.host_player_id;
                  return (
                    <div
                      key={p.id}
                      className={"duel-player-chip has-avatar" + (isMe ? " mine" : "")}
                    >
                      <PlayerProfileTrigger profileId={p.profile_id} as="span" className="duel-player-id">
                        <PlayerAvatar
                          avatarId={rosterProfiles.get(p.profile_id ?? "")?.avatarId}
                          username={p.name}
                          size="sm"
                          highlight={isPlayerHost}
                          className="duel-player-avatar"
                        />
                        <span className="duel-player-name">{p.name}</span>
                      </PlayerProfileTrigger>
                      <div className="duel-player-tags">
                        {isMe && <span className="duel-tag">Sen</span>}
                        {!p.profile_id && <GuestTag />}
                        {isPlayerHost && <span className="duel-tag host">👑</span>}
                      </div>
                    </div>
                  );
                })}

                {players.length < 2 && (
                  <div className="duel-player-chip waiting">
                    <span className="duel-player-dot waiting" />
                    <span>Rakip bekleniyor...</span>
                  </div>
                )}
              </div>

              <p style={{ margin: "10px 0 0", fontSize: 12, opacity: 0.65, textAlign: "center" }}>
                {isHost
                  ? players.length < 2
                    ? "Rakibin katılması bekleniyor..."
                    : "Oyunu başlatmanız bekleniyor"
                  : "Ev sahibi oyunu başlatacak..."}
              </p>
            </div>

            <div className="duel-wait-settings-lift">
              <div className="duel-room-settings-box duel-wait-settings-compact">
                <div className="duel-room-settings-title">⚙️ Oda Ayarları</div>

                <div className="duel-room-settings-grid">
                  <label className="duel-room-setting-field">
                    <span>Tur Sayısı</span>
                    <select
                      value={room.total_rounds}
                      disabled={!isHost}
                      onChange={e => onUpdateSetting({ total_rounds: Number(e.target.value) })}
                    >
                      {ROUTE_DUEL_ROUND_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="duel-room-setting-field">
                    <span>Rota Uzunluğu</span>
                    <select
                      value={room.route_length}
                      disabled={!isHost}
                      onChange={e => onUpdateSetting({ route_length: e.target.value as RouteDuelLength })}
                    >
                      {ROUTE_DUEL_LENGTH_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <p
                  className="duel-room-settings-note"
                  style={{ margin: "10px 0 0", fontSize: 11, opacity: 0.6, textAlign: "center", lineHeight: 1.3 }}
                >
                  {isHost
                    ? "Ayarları buradan değiştirebilirsiniz"
                    : "Yalnızca oda sahibi değiştirebilir"}
                </p>
              </div>
            </div>
          </div>

          {/* Aksiyonlar */}
          {isHost ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 18,
                marginTop: 14,
                width: "100%",
                maxWidth: 610,
                marginLeft: "auto",
                marginRight: "auto",
                boxSizing: "border-box",
              }}
            >
              <button
                className="btn btn-accent duel-start-btn"
                onClick={onStart}
                disabled={players.length < 2}
                title={players.length < 2 ? "Rakip bekleniyor" : "Oyunu başlat"}
                style={{
                  width: "100%",
                  maxWidth: "none",
                  justifySelf: "stretch",
                  minHeight: 46,
                  fontSize: 15,
                  marginTop: 0,
                  borderRadius: 14,
                  fontWeight: 800,
                  letterSpacing: "0.02em",
                  boxSizing: "border-box",
                  opacity: players.length < 2 ? 0.6 : 1,
                }}
              >
                🚀 Oyunu Başlat
              </button>
              <button
                className="btn btn-ghost"
                onClick={onLeave}
                style={{
                  width: "100%",
                  maxWidth: "none",
                  justifySelf: "stretch",
                  minHeight: 46,
                  fontSize: 14,
                  borderRadius: 14,
                  fontWeight: 700,
                  opacity: 0.85,
                  boxSizing: "border-box",
                }}
              >
                ← Lobiye Dön
              </button>
            </div>
          ) : (
            <div
              style={{
                marginTop: 14,
                width: "100%",
                maxWidth: 610,
                marginLeft: "auto",
                marginRight: "auto",
                boxSizing: "border-box",
              }}
            >
              <button
                className="btn btn-ghost btn-sm"
                onClick={onLeave}
                style={{
                  width: "100%",
                  maxWidth: "none",
                  minHeight: 46,
                  fontSize: 14,
                  borderRadius: 14,
                  fontWeight: 700,
                  opacity: 0.85,
                  boxSizing: "border-box",
                }}
              >
                ← Lobiye Dön
              </button>
            </div>
          )}

          {errorMsg && <p className="duel-error">{errorMsg}</p>}
        </div>

        {/* Sağ panel: gerçek LobbyChat (mod-izole 'route_duel:<code>' anahtarı;
            geçmiş + realtime + yazma yolu hepsi aynı namespaced key'te). */}
        <div className="duel-wait-chat-align">
          <LobbyChat
            roomCode={routeDuelChatKey(room.code)}
            playerName={playerName.trim()}
            sendMode="route_duel"
            playerId={myId}
            claimToken={myClaimToken}
          />
        </div>
      </div>
    </div>
  );
}
