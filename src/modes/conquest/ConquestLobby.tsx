/**
 * ConquestLobby — 3-panel lobby skeleton for Kuşatma.
 *
 * Visual layout reuses `.wgg-grid` from WheelGroupGame: left = player
 * slots, middle = room status + invite + settings + actions,
 * right = LobbyChat. No gameplay logic yet; this is the waiting room.
 *
 * Settings (Harita / Oyuncu / Tur / Görünürlük) are editable selects for
 * the host and disabled read-only selects for non-host players. Changes
 * call `onUpdateSettings` which updates local state in ConquestMode; a
 * future Supabase persist layer plugs into that callback.
 *
 * Backend status: room state is local-only for Phase 2. Chat reuses the
 * shared duel_messages table via LobbyChat (room code is "K"-prefixed).
 */

import { useMemo, useState } from "react";
import LobbyChat from "../../components/LobbyChat";
import { playSound } from "../../lib/sound";
import { recallConquestClaim } from "./conquestClaim";
import {
  CONQUEST_MAPS,
  CONQUEST_MIN_PLAYERS,
  CONQUEST_PLAYER_COUNTS,
  CONQUEST_ROUND_COUNTS,
  CONQUEST_VISUAL_SLOTS,
  mapLabel,
} from "./types";
import type {
  ConquestMapId,
  ConquestMaxPlayers,
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRoomSettings,
  ConquestRoundCount,
  ConquestVisibility,
} from "./types";
import {
  CONQUEST_COLOR_LABEL,
  CONQUEST_COLOR_PALETTE,
  assignConquestPlayerColors,
} from "./conquestState";
import { buildConquestShareLink } from "./utils";

interface Props {
  roomCode:          string;
  hostName:          string;
  /** The current viewer's display name — used as the chat sender label. */
  myName:            string;
  /** The current viewer's player id — null for spectators (no picker shown). */
  myPlayerId:        string | null;
  settings:          ConquestRoomSettings;
  players:           ConquestPlayer[];
  isHost:            boolean;
  /** False for guest users — they can see chat but cannot write. */
  isLoggedIn:        boolean;
  onUpdateSettings:  (patch: Partial<ConquestRoomSettings>) => void;
  onChangeColor:     (color: ConquestPlayerColor) => void;
  onStart:           () => void;
  onLeave:           () => void;
}

export default function ConquestLobby({
  roomCode,
  hostName,
  myName,
  myPlayerId,
  settings,
  players,
  isHost,
  isLoggedIn,
  onUpdateSettings,
  onChangeColor,
  onStart,
  onLeave,
}: Props) {
  const [copied,      setCopied]      = useState(false);
  const [chatOpen,    setChatOpen]    = useState(false);
  const [playersOpen, setPlayersOpen] = useState(false);

  const shareLink = useMemo(() => buildConquestShareLink(roomCode), [roomCode]);

  const inviteMessage = useMemo(() => (
    `Torble'da Kuşatma oynayalım! 🛡️\n` +
    `Harita: ${mapLabel(settings.map)} · ${settings.rounds} Tur · ${settings.maxPlayers} oyuncu\n` +
    `Bölgeleri kuşatarak haritayı ele geçir.\n` +
    `Katılmak için tıkla:\n${shareLink}`
  ), [settings, shareLink]);

  function copyInvite() {
    const text = inviteMessage;
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      })
      .catch(() => {
        window.prompt("Linki kopyala:", shareLink);
      });
  }

  const canStart = players.length >= CONQUEST_MIN_PLAYERS;
  const visualSlotCount = Math.max(settings.maxPlayers, players.length);
  const totalRendered = Math.min(visualSlotCount, CONQUEST_VISUAL_SLOTS);

  /* True when at least one lower player-count option is forced disabled
   * because the room is already partially filled. */
  const playerCountCapped = players.length > CONQUEST_PLAYER_COUNTS[0];

  /* Resolved color per player.  Slot-based fallback covers legacy rows that
   * pre-date the picker.  Same map is used both in lobby chips and the
   * "taken" mask in the picker so the two views can never drift apart. */
  const resolvedColors = useMemo(() => assignConquestPlayerColors(players), [players]);
  const me            = myPlayerId ? players.find(p => p.id === myPlayerId) ?? null : null;
  const myColor       = me ? resolvedColors[me.id] : null;
  /* Build "taken by someone else" set on raw `player.color` (not the resolved
   * fallback) so a freshly-joined player whose row hasn't synced a color yet
   * doesn't accidentally lock out every other swatch. */
  const colorsTakenByOthers = useMemo(() => {
    const s = new Set<ConquestPlayerColor>();
    for (const p of players) {
      if (p.id === myPlayerId) continue;
      if (p.color) s.add(p.color);
    }
    return s;
  }, [players, myPlayerId]);

  function renderColorPicker(idPrefix: string) {
    if (!me) return null;
    return (
      <div className="cq-color-picker" role="group" aria-label="Rengini seç">
        <div className="cq-color-picker-head">
          <span className="cq-color-picker-title">🎨 Rengin</span>
          {myColor && (
            <span className="cq-color-picker-current" data-color={myColor}>
              <span className="cq-color-picker-current-dot" aria-hidden />
              {CONQUEST_COLOR_LABEL[myColor]}
            </span>
          )}
        </div>
        <div className="cq-color-swatch-row">
          {CONQUEST_COLOR_PALETTE.map(c => {
            const taken    = colorsTakenByOthers.has(c);
            const selected = c === myColor;
            return (
              <button
                key={`${idPrefix}-${c}`}
                type="button"
                className={
                  "cq-color-swatch"
                  + (selected ? " cq-color-swatch--selected" : "")
                  + (taken    ? " cq-color-swatch--taken"    : "")
                }
                data-color={c}
                disabled={taken && !selected}
                aria-pressed={selected}
                aria-label={CONQUEST_COLOR_LABEL[c] + (taken ? " (alındı)" : "")}
                title={taken && !selected ? `${CONQUEST_COLOR_LABEL[c]} — başka oyuncu seçti` : CONQUEST_COLOR_LABEL[c]}
                onClick={() => {
                  if (taken || selected) return;
                  playSound("click");
                  onChangeColor(c);
                }}
              >
                <span className="cq-color-swatch-dot" aria-hidden />
                {selected && <span className="cq-color-swatch-check" aria-hidden>✓</span>}
                {taken && !selected && <span className="cq-color-swatch-lock" aria-hidden>🔒</span>}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="duel-lobby">
      <div className="wgg-grid cq-lobby-grid">

        {/* ══ LEFT: Oyuncular ══ */}
        <div className="duel-lobby-card wgg-players-card cq-players-card">
          <div className="cq-players-head">
            <span className="cq-players-title">👥 Oyuncular</span>
            <span className="cq-players-count">
              {players.length}/{settings.maxPlayers}
            </span>
          </div>

          <div className="wgg-player-list">
            {Array.from({ length: totalRendered }, (_, i) => {
              const p = players[i] ?? null;
              const isClosed = i >= settings.maxPlayers;
              if (!p) {
                if (isClosed) {
                  return (
                    <div key={`closed-${i}`} className="wgg-slot-closed" aria-disabled="true">
                      <span className="wgg-slot-closed-icon" aria-hidden="true">🔒</span>
                      <span className="wgg-slot-closed-label">Kapalı slot</span>
                    </div>
                  );
                }
                return (
                  <div key={`empty-${i}`} className="cq-slot-empty">
                    <span className="cq-slot-empty-dot" />
                    <span className="cq-slot-empty-label">Boş slot</span>
                  </div>
                );
              }
              const color = resolvedColors[p.id];
              const isMe  = p.id === myPlayerId;
              return (
                <div
                  key={p.id}
                  className={"duel-player-chip cq-player-chip" + (p.isHost ? " cq-player-chip--host" : "") + (isMe ? " cq-player-chip--me" : "")}
                  data-color={color}
                >
                  <div className="cq-player-chip-main">
                    <span className="duel-player-dot cq-player-chip-dot" />
                    <span className="cq-player-name">{p.name}</span>
                    {isMe && <span className="cq-player-you-tag">sen</span>}
                    {p.isHost && <span className="duel-tag host">👑</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {renderColorPicker("desktop")}

          {players.length < CONQUEST_MIN_PLAYERS && (
            <div className="cq-wait-chip" role="status">
              En az {CONQUEST_MIN_PLAYERS} oyuncu gerekli — {CONQUEST_MIN_PLAYERS - players.length} bekleniyor
            </div>
          )}
        </div>

        {/* ══ MIDDLE: Oda durumu + ayarlar + aksiyon ══ */}
        <div className="duel-lobby-card wgg-middle-card cq-middle-card">
          <div className="cq-status-wrap">
            <div className={"cq-status-chip" + (isHost ? " cq-status-chip--host" : "")}>
              {isHost ? "ODA HAZIR" : "Odaya Katıldın"}
            </div>
            <div className="cq-room-code-big">{roomCode}</div>
            <div className="cq-room-code-hint">
              6 haneli kod — arkadaşlarına ver
            </div>
          </div>

          <div className="cq-invite-block">
            <button
              className={"btn cq-invite-btn" + (copied ? " cq-invite-btn--copied" : "")}
              onClick={copyInvite}
              type="button"
            >
              {copied ? "✓ Davet mesajı kopyalandı!" : "📋 Davet Mesajını Kopyala"}
            </button>
            <input
              className="duel-link-input cq-link-input"
              readOnly
              value={shareLink}
              onFocus={e => e.target.select()}
            />
          </div>

          {/* ── Editable settings (selects for host, disabled for guests) ── */}
          <div className="cq-settings-selects" role="group" aria-label="Kuşatma oda ayarları">
            <div className="duel-select-wrap">
              <label className="duel-select-label">🗺️ Harita</label>
              <div className="duel-select-box">
                <select
                  className="duel-select"
                  value={settings.map}
                  disabled={!isHost}
                  style={{ opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                  onChange={e => onUpdateSettings({ map: e.target.value as ConquestMapId })}
                >
                  {CONQUEST_MAPS.map(m => (
                    <option key={m.id} value={m.id}>{m.icon} {m.label}</option>
                  ))}
                </select>
                <span className="duel-select-caret">▾</span>
              </div>
            </div>

            <div className="duel-select-wrap">
              <label className="duel-select-label">👥 Oyuncu</label>
              <div className="duel-select-box">
                <select
                  className="duel-select"
                  value={settings.maxPlayers}
                  disabled={!isHost}
                  style={{ opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                  onChange={e => onUpdateSettings({ maxPlayers: Number(e.target.value) as ConquestMaxPlayers })}
                >
                  {CONQUEST_PLAYER_COUNTS.map(n => (
                    <option key={n} value={n} disabled={n < players.length}>
                      {n} Kişi
                    </option>
                  ))}
                </select>
                <span className="duel-select-caret">▾</span>
              </div>
            </div>

            <div className="duel-select-wrap">
              <label className="duel-select-label">🔄 Tur</label>
              <div className="duel-select-box">
                <select
                  className="duel-select"
                  value={settings.rounds}
                  disabled={!isHost}
                  style={{ opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                  onChange={e => onUpdateSettings({ rounds: Number(e.target.value) as ConquestRoundCount })}
                >
                  {CONQUEST_ROUND_COUNTS.map(r => (
                    <option key={r} value={r}>{r} Tur</option>
                  ))}
                </select>
                <span className="duel-select-caret">▾</span>
              </div>
            </div>

            <div className="duel-select-wrap">
              <label className="duel-select-label">🔓 Görünürlük</label>
              <div className="duel-select-box">
                <select
                  className="duel-select"
                  value={settings.visibility}
                  disabled={!isHost}
                  style={{ opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                  onChange={e => onUpdateSettings({ visibility: e.target.value as ConquestVisibility })}
                >
                  <option value="public">🌐 Açık Oda</option>
                  <option value="private">🔒 Gizli Oda</option>
                </select>
                <span className="duel-select-caret">▾</span>
              </div>
            </div>
          </div>

          {isHost && playerCountCapped && (
            <p className="cq-player-count-warn" role="status">
              Oyuncu sayısı mevcut oyuncu sayısından ({players.length}) düşük olamaz.
            </p>
          )}

          <div className="cq-spacer" />

          <div className="cq-actions">
            {isHost && (
              <button
                type="button"
                className={canStart ? "btn btn-accent cq-start-btn" : "btn btn-ghost cq-start-btn"}
                disabled={!canStart}
                onClick={() => { playSound("click"); onStart(); }}
                title={canStart ? "Oyunu başlat" : `En az ${CONQUEST_MIN_PLAYERS} oyuncu gerekli`}
              >
                🚀 Oyunu Başlat
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost cq-leave-btn"
              onClick={() => { playSound("click"); onLeave(); }}
            >
              ← Lobiden Çık
            </button>
          </div>

          {!isHost && (
            <p className="cq-host-note">
              Sadece ev sahibi <strong>{hostName}</strong> başlatabilir.
            </p>
          )}
        </div>

        {/* ══ RIGHT: Sohbet ══ */}
        <div className="wgg-chat-card cq-chat-card">
          {isLoggedIn && myPlayerId ? (
            <LobbyChat
              roomCode={roomCode}
              playerName={myName || hostName}
              mobileSheetOpen={chatOpen}
              onMobileSheetOpenChange={v => { setChatOpen(v); if (v) setPlayersOpen(false); }}
              hideMobileFab={chatOpen || playersOpen}
              sendMode="conquest"
              playerId={myPlayerId}
              claimToken={recallConquestClaim(myPlayerId) ?? ""}
            />
          ) : (
            <div className="cq-chat-guest">
              <span className="cq-chat-guest-icon" aria-hidden>💬</span>
              <p className="cq-chat-guest-msg">
                Sohbete yazmak için giriş yapmalısın.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ════ MOBİL: Oyuncular FAB ════ */}
      {!chatOpen && !playersOpen && (
        <button
          type="button"
          className="wgg-players-fab"
          aria-label="Oyuncuları aç"
          onClick={() => { playSound("click"); setPlayersOpen(true); setChatOpen(false); }}
        >
          <span>👥</span>
          <span>Oyuncular</span>
          <span className="wgg-players-fab-badge">{players.length}/{settings.maxPlayers}</span>
        </button>
      )}

      {/* ════ MOBİL: Oyuncular bottom-sheet ════ */}
      {playersOpen && (
        <div className="wgg-ps-backdrop" onClick={() => setPlayersOpen(false)}>
          <div className="wgg-ps-sheet" onClick={e => e.stopPropagation()}>
            <div className="wgg-ps-handle" />
            <header className="wgg-ps-header">
              <span className="wgg-ps-title">
                <span>👥</span>
                <span>Oyuncular</span>
              </span>
              <span className="cq-players-count">
                {players.length}/{settings.maxPlayers}
              </span>
              <button
                type="button"
                className="wgg-ps-close"
                aria-label="Kapat"
                onClick={() => setPlayersOpen(false)}
              >
                ✕
              </button>
            </header>
            <div className="wgg-ps-list">
              {Array.from({ length: totalRendered }, (_, i) => {
                const p = players[i] ?? null;
                const isClosed = i >= settings.maxPlayers;
                if (!p) {
                  if (isClosed) {
                    return (
                      <div key={`m-closed-${i}`} className="wgg-slot-closed">
                        <span className="wgg-slot-closed-icon" aria-hidden="true">🔒</span>
                        <span className="wgg-slot-closed-label">Kapalı slot</span>
                      </div>
                    );
                  }
                  return (
                    <div key={`m-empty-${i}`} className="wgg-ps-empty-slot">
                      <span className="wgg-ps-dot-empty" />
                      <span>Boş slot</span>
                    </div>
                  );
                }
                const color = resolvedColors[p.id];
                const isMe  = p.id === myPlayerId;
                return (
                  <div
                    key={p.id}
                    className={"duel-player-chip cq-player-chip" + (p.isHost ? " cq-player-chip--host" : "") + (isMe ? " cq-player-chip--me" : "")}
                    data-color={color}
                  >
                    <div className="cq-player-chip-main">
                      <span className="duel-player-dot cq-player-chip-dot" />
                      <span className="cq-player-name">{p.name}</span>
                      {isMe && <span className="cq-player-you-tag">sen</span>}
                      {p.isHost && <span className="duel-tag host">👑</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            {renderColorPicker("mobile")}
            {players.length < CONQUEST_MIN_PLAYERS && (
              <div className="wgg-ps-warning">
                En az {CONQUEST_MIN_PLAYERS} oyuncu gerekli.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
