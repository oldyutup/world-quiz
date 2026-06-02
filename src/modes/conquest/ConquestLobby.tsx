/**
 * ConquestLobby — 3-panel lobby skeleton for Kuşatma.
 *
 * Visual layout reuses `.wgg-grid` from WheelGroupGame: left = player
 * slots + bonus panel, middle = room status + invite + settings + actions,
 * right = LobbyChat. No gameplay logic yet; this is the waiting room.
 *
 * Settings (Harita / Oyuncu / Tur / Görünürlük / Bonus Dağıtımı) are
 * editable for the host and disabled read-only for non-host players. Map /
 * Oyuncu / Tur / Görünürlük persist via `onUpdateSettings`; Bonus Dağıtımı
 * is ephemeral lobby state broadcast through `onChangeBonusDistribution`
 * (see ConquestMode.tsx + conquestLobbyBroadcast.ts).
 *
 * Bonus panel is always rendered in the left card.  In "Oy ile Seç" it is a
 * voting UI (selected glow, vote badges, cap/remaining).  In "Rastgele" it
 * collapses to a read-only chip list of the bonuses that may roll in — same
 * tooltips, no interactivity, no vote state.
 *
 * Color picking is inline: the small dot next to your name acts as the
 * swatch.  Tapping your OWN dot opens a compact popover anchored beneath
 * that dot (not a tall block under the player list).
 *
 * Backend status: room state for map/round/visibility/maxPlayers persists in
 * conquest_rooms.  Bonus mode + votes ride a separate broadcast channel and
 * are not yet wired into match start.  Chat reuses the shared duel_messages
 * table via LobbyChat (room code is "K"-prefixed).
 */

import { useEffect, useMemo, useState } from "react";
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
  ConquestBonusDistribution,
  ConquestMapId,
  ConquestMaxPlayers,
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRegionBonusType,
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
import {
  VOTEABLE_BONUS_POOL,
  voteBonusCountForPlayers,
} from "./bonusPool";
import type { ConquestLobbyVotes } from "./conquestLobbyBroadcast";
import { tallyVotes } from "./conquestLobbyBroadcast";

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
  bonusVotes:        ConquestLobbyVotes;
  /** Players who have clicked "Lobiye Dön" after a finished match. Only
   *  meaningful when `rematchMode` is true; in a fresh lobby this list may
   *  still legitimately be empty even if some players are around. */
  readyPlayerIds:    string[];
  /** Explicit "this lobby is a post-match rematch lobby" flag driven by
   *  ConquestMode (derived from the canonical room.gameplay_state, not from
   *  the broadcast-driven readyPlayerIds). When false the lobby behaves as a
   *  normal waiting room: every present player counts as active, the counter
   *  is `X/Y` (not "Hazır X/Y"), and no chip gets the "Sonuç ekranında" tag.
   *  When true only `readyPlayerIds` count as active. */
  rematchMode:       boolean;
  /** True for non-host viewers after a finished match when they've
   *  signalled ready-for-next.  Drives a small "waiting for host"
   *  hint under the start area. */
  waitingForHost?:   boolean;
  onUpdateSettings:  (patch: Partial<ConquestRoomSettings>) => void;
  onChangeBonusDistribution: (mode: ConquestBonusDistribution) => void;
  onToggleBonusVote: (bonusType: ConquestRegionBonusType) => void;
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
  bonusVotes,
  readyPlayerIds,
  rematchMode,
  waitingForHost = false,
  onUpdateSettings,
  onChangeBonusDistribution,
  onToggleBonusVote,
  onChangeColor,
  onStart,
  onLeave,
}: Props) {
  const [copied,      setCopied]      = useState(false);
  const [chatOpen,    setChatOpen]    = useState(false);
  const [playersOpen, setPlayersOpen] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  /* Surfaces the "Oyuncu sayısı mevcut oyuncu sayısından düşük olamaz"
   * warning ONLY after the host actively tries to pick a capacity below
   * the current player count. Auto-clears so it never becomes ambient
   * lobby noise. */
  const [capacityWarn, setCapacityWarn] = useState<number | null>(null);
  /* Mobile-only: tapping a bonus chip opens a detail card instead of voting
   * directly.  Vote / Oyu Kaldır lives inside that card.  Desktop ignores
   * this state — its chips keep direct-click voting + hover tooltip. */
  const [mobileBonusDetail, setMobileBonusDetail] = useState<ConquestRegionBonusType | null>(null);

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

  /* Rematch mode is driven by the explicit prop from ConquestMode (which
   * derives it from the canonical room.gameplay_state.phase === "finished"
   * — see ConquestMode.tsx). We intentionally do NOT infer it from
   * `readyPlayerIds.length > 0` here: that inference made a brand-new lobby
   * flip into rematch mode whenever stale per-room ephemeral state leaked
   * across rooms (e.g. host leaves a finished room and creates a new one,
   * carrying the previous ready set in component state). The lobby simply
   * trusts the prop now. In a non-rematch lobby every present player is
   * active regardless of readyPlayerIds; in a rematch lobby only players
   * whose ids appear in readyPlayerIds count as active. */
  const readySet  = useMemo(() => new Set(readyPlayerIds), [readyPlayerIds]);
  const isRematch = rematchMode;
  const isPlayerReady = (p: ConquestPlayer) => !isRematch || readySet.has(p.id);
  const activePlayers = useMemo(
    () => isRematch ? players.filter(p => readySet.has(p.id)) : players,
    [players, readySet, isRematch],
  );
  const activeCount = activePlayers.length;
  const canStart = activeCount >= CONQUEST_MIN_PLAYERS;
  const startBlockedHelper = !canStart
    ? `Yeni oyun için en az ${CONQUEST_MIN_PLAYERS} aktif oyuncu gerekli.`
    : null;
  const countLabel = isRematch
    ? `Hazır ${activeCount}/${settings.maxPlayers}`
    : `${players.length}/${settings.maxPlayers}`;
  const visualSlotCount = Math.max(settings.maxPlayers, players.length);
  const totalRendered = Math.min(visualSlotCount, CONQUEST_VISUAL_SLOTS);

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

  // ── Bonus voting derived values ────────────────────────────────────────
  const bonusMode      = settings.bonusDistribution ?? "random";
  const voteCap        = voteBonusCountForPlayers(players.length);
  const myVotes        = myPlayerId ? (bonusVotes[myPlayerId] ?? []) : [];
  const myVoteSet      = useMemo(() => new Set(myVotes), [myVotes]);
  const tally          = useMemo(() => tallyVotes(bonusVotes), [bonusVotes]);
  const remainingVotes = Math.max(0, voteCap - myVotes.length);

  /* Inline color popover — closes on outside click / Esc.  Because the
   * popover is rendered inline next to *your* chip dot and that chip can
   * be present in both the desktop list and the mobile sheet at the same
   * time, we use selector-based hit-testing rather than a single ref. */
  useEffect(() => {
    if (!colorPickerOpen) return;
    function onDocClick(ev: MouseEvent) {
      const t = ev.target as Element | null;
      if (!t) return;
      if (t.closest(".cq-color-popover")) return;
      if (t.closest(".cq-player-chip-dot-btn")) return;
      setColorPickerOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setColorPickerOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [colorPickerOpen]);

  /* Close mobile bonus detail on outside tap / Esc.  Taps on another chip
   * are allowed through so the detail can swap target instead of close+reopen. */
  useEffect(() => {
    if (!mobileBonusDetail) return;
    function onDocClick(ev: MouseEvent) {
      const t = ev.target as Element | null;
      if (!t) return;
      if (t.closest(".cq-mbonus-card")) return;
      if (t.closest(".cq-mbonus-chip")) return;
      setMobileBonusDetail(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMobileBonusDetail(null);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [mobileBonusDetail]);

  /* Close the detail card whenever the sheet itself closes — otherwise the
   * card silently reopens at the same bonus next time the sheet is opened. */
  useEffect(() => {
    if (!playersOpen) setMobileBonusDetail(null);
  }, [playersOpen]);

  /* Auto-clear the capacity warning so it doesn't linger if the host
   * walks away or picks a valid value afterwards. */
  useEffect(() => {
    if (capacityWarn === null) return;
    const t = setTimeout(() => setCapacityWarn(null), 4000);
    return () => clearTimeout(t);
  }, [capacityWarn]);

  /* If the room state catches up (e.g. someone leaves) so the rejected
   * choice would now be valid, drop the warning silently. */
  useEffect(() => {
    if (capacityWarn !== null && players.length <= capacityWarn) {
      setCapacityWarn(null);
    }
  }, [players.length, capacityWarn]);

  function renderColorPopover() {
    if (!colorPickerOpen || !me) return null;
    return (
      <div
        className="cq-color-popover"
        role="dialog"
        aria-label="Rengini seç"
        onClick={e => e.stopPropagation()}
      >
        <div className="cq-color-popover-head">
          <span className="cq-color-popover-title">🎨 Rengini seç</span>
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
                key={`pop-${c}`}
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
                  setColorPickerOpen(false);
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

  function renderPlayerChip(p: ConquestPlayer, opts: { keyPrefix: string }) {
    const color = resolvedColors[p.id];
    const isMe  = p.id === myPlayerId;
    const ready = isPlayerReady(p);
    const passive = isRematch && !ready;
    const dotInteractive = isMe;
    return (
      <div
        key={`${opts.keyPrefix}-${p.id}`}
        className={
          "duel-player-chip cq-player-chip"
          + (p.isHost ? " cq-player-chip--host" : "")
          + (isMe    ? " cq-player-chip--me"   : "")
          + (passive ? " cq-player-chip--inactive" : "")
        }
        data-color={color}
        aria-disabled={passive || undefined}
      >
        <div className="cq-player-chip-main">
          <span className="cq-player-name">{p.name}</span>
          {isMe && <span className="cq-player-you-tag">sen</span>}
          {p.isHost && <span className="duel-tag host">👑</span>}
          {isRematch && ready && (
            <span className="cq-player-status-tag cq-player-status-tag--ready">Hazır</span>
          )}
          {passive && (
            <span className="cq-player-status-tag cq-player-status-tag--idle">Sonuç ekranında</span>
          )}
        </div>
        {dotInteractive ? (
          <span className="cq-player-chip-dot-wrap">
            <button
              type="button"
              className="cq-player-chip-dot-btn"
              aria-label="Rengini değiştir"
              aria-haspopup="dialog"
              aria-expanded={colorPickerOpen}
              title="Rengini değiştir"
              data-color={color}
              onClick={() => {
                playSound("click");
                setColorPickerOpen(v => !v);
              }}
            >
              <span className="duel-player-dot cq-player-chip-dot" />
              <span className="cq-player-chip-dot-edit" aria-hidden>✎</span>
            </button>
            {colorPickerOpen && renderColorPopover()}
          </span>
        ) : (
          <span
            className="duel-player-chip-dot-static"
            data-color={color}
            aria-hidden
          >
            <span className="duel-player-dot cq-player-chip-dot" />
          </span>
        )}
      </div>
    );
  }

  function renderBonusPanel(keyPrefix: string) {
    const isVoting = bonusMode === "vote";
    const title    = isVoting ? "🗳️ Bonus Oylaması" : "🎁 Bu Maçtaki Bonuslar";
    return (
      <div
        className={"cq-bonus-vote" + (isVoting ? "" : " cq-bonus-vote--readonly")}
        role="group"
        aria-label={isVoting ? "Bonus oylaması" : "Maçtaki bonuslar"}
      >
        <div className="cq-bonus-vote-head">
          <span className="cq-bonus-vote-title">{title}</span>
          {isVoting && (
            <span className="cq-bonus-vote-meta">
              Seçilecek bonus: <strong>{voteCap}</strong>
              <span className="cq-bonus-vote-sep">·</span>
              Kalan oy: <strong>{remainingVotes}</strong>
            </span>
          )}
        </div>
        <div className="cq-bonus-vote-grid">
          {VOTEABLE_BONUS_POOL.map(entry => {
            if (!isVoting) {
              /* Read-only chip — title attribute keeps the hover tooltip,
               * no badge / glow / cap / click behaviour. */
              return (
                <div
                  key={`${keyPrefix}-ro-${entry.type}`}
                  className="cq-bonus-vote-chip cq-bonus-vote-chip--readonly"
                  data-category={entry.category}
                  title={`${entry.label} — ${entry.description}`}
                >
                  <span className="cq-bonus-vote-icon" aria-hidden>{entry.icon}</span>
                  <span className="cq-bonus-vote-label">{entry.label}</span>
                </div>
              );
            }
            const count    = tally.get(entry.type) ?? 0;
            const selected = myVoteSet.has(entry.type);
            const disabled = !myPlayerId || (!selected && remainingVotes <= 0);
            return (
              <button
                key={`${keyPrefix}-${entry.type}`}
                type="button"
                className={
                  "cq-bonus-vote-chip"
                  + (selected ? " cq-bonus-vote-chip--selected" : "")
                  + (disabled ? " cq-bonus-vote-chip--disabled" : "")
                }
                data-category={entry.category}
                disabled={disabled}
                aria-pressed={selected}
                title={`${entry.label} — ${entry.description}`}
                onClick={() => {
                  if (!myPlayerId) return;
                  if (!selected && remainingVotes <= 0) return;
                  playSound("click");
                  onToggleBonusVote(entry.type);
                }}
              >
                <span className="cq-bonus-vote-icon" aria-hidden>{entry.icon}</span>
                <span className="cq-bonus-vote-label">{entry.label}</span>
                {count > 0 && (
                  <span className="cq-bonus-vote-badge" aria-label={`${count} oy`}>{count}</span>
                )}
              </button>
            );
          })}
        </div>
        {isVoting && !myPlayerId && (
          <p className="cq-bonus-vote-hint" role="status">
            Oy vermek için odaya katılmalısın.
          </p>
        )}
        {!isVoting && (
          <p className="cq-bonus-vote-hint" role="status">
            Bonuslar maç başında rastgele dağıtılır.
          </p>
        )}
      </div>
    );
  }

  /* ── Mobile bonus panel ────────────────────────────────────────────
   * Lives inside the players bottom-sheet on phones.  Differences from
   * the desktop panel:
   *   - Compact chip-row (flex-wrap pills, no scrolling container).
   *   - Tapping a chip opens an inline detail card (icon + name +
   *     description + vote button in vote mode), never votes directly.
   *   - In "random" mode the card is read-only — no vote affordance.
   *   - Only one detail card open at a time; tapping a different chip
   *     swaps the card instead of closing.
   */
  function renderMobileBonusPanel() {
    const isVoting    = bonusMode === "vote";
    const title       = isVoting ? "🗳️ Bonus Oylaması" : "🎁 Bu Maçtaki Bonuslar";
    const detailEntry = mobileBonusDetail
      ? VOTEABLE_BONUS_POOL.find(e => e.type === mobileBonusDetail) ?? null
      : null;

    return (
      <div
        className={"cq-mbonus" + (isVoting ? "" : " cq-mbonus--readonly")}
        role="group"
        aria-label={isVoting ? "Bonus oylaması" : "Maçtaki bonuslar"}
      >
        <div className="cq-mbonus-head">
          <span className="cq-mbonus-title">{title}</span>
          {isVoting && (
            <span className="cq-mbonus-meta">
              Seç: <strong>{voteCap}</strong>
              <span className="cq-mbonus-sep">·</span>
              Kalan: <strong>{remainingVotes}</strong>
            </span>
          )}
        </div>

        <div className="cq-mbonus-chips">
          {VOTEABLE_BONUS_POOL.map(entry => {
            const count    = tally.get(entry.type) ?? 0;
            const selected = isVoting && myVoteSet.has(entry.type);
            const active   = mobileBonusDetail === entry.type;
            return (
              <button
                key={`m-${entry.type}`}
                type="button"
                className={
                  "cq-mbonus-chip"
                  + (selected ? " cq-mbonus-chip--selected" : "")
                  + (active   ? " cq-mbonus-chip--active"   : "")
                }
                data-category={entry.category}
                aria-pressed={selected}
                aria-expanded={active}
                onClick={() => {
                  playSound("click");
                  setMobileBonusDetail(prev => prev === entry.type ? null : entry.type);
                }}
              >
                <span className="cq-mbonus-icon" aria-hidden>{entry.icon}</span>
                <span className="cq-mbonus-label">{entry.label}</span>
                {isVoting && count > 0 && (
                  <span className="cq-mbonus-badge" aria-label={`${count} oy`}>{count}</span>
                )}
              </button>
            );
          })}
        </div>

        {isVoting && !myPlayerId && (
          <p className="cq-mbonus-hint" role="status">
            Oy vermek için odaya katılmalısın.
          </p>
        )}
        {!isVoting && (
          <p className="cq-mbonus-hint" role="status">
            Bonuslar maç başında rastgele dağıtılır. Detay için bonusa dokun.
          </p>
        )}

        {detailEntry && (() => {
          const selected   = isVoting && myVoteSet.has(detailEntry.type);
          const noQuota    = !selected && remainingVotes <= 0;
          const cannotVote = !myPlayerId || noQuota;
          const voteLabel  = selected
            ? "✓ Oyu Kaldır"
            : noQuota
              ? "Oy hakkın doldu"
              : "Oy Ver";
          return (
            <div
              className="cq-mbonus-card"
              role="dialog"
              aria-label={detailEntry.label}
              onClick={e => e.stopPropagation()}
            >
              <button
                type="button"
                className="cq-mbonus-card-close"
                aria-label="Kapat"
                onClick={() => setMobileBonusDetail(null)}
              >
                ✕
              </button>
              <div className="cq-mbonus-card-head" data-category={detailEntry.category}>
                <span className="cq-mbonus-card-icon" aria-hidden>{detailEntry.icon}</span>
                <span className="cq-mbonus-card-title">{detailEntry.label}</span>
              </div>
              <p className="cq-mbonus-card-desc">{detailEntry.description}</p>
              {isVoting ? (
                <div className="cq-mbonus-card-foot">
                  <span className="cq-mbonus-card-meta">
                    Kalan oy: <strong>{remainingVotes}</strong>
                  </span>
                  <button
                    type="button"
                    className={
                      "cq-mbonus-card-vote"
                      + (selected ? " cq-mbonus-card-vote--remove" : "")
                    }
                    disabled={cannotVote}
                    onClick={() => {
                      if (!myPlayerId) return;
                      if (!selected && remainingVotes <= 0) return;
                      playSound("click");
                      onToggleBonusVote(detailEntry.type);
                    }}
                  >
                    {voteLabel}
                  </button>
                </div>
              ) : (
                <p className="cq-mbonus-card-info">
                  Rastgele modda oy verilemez — bonuslar maç başında dağıtılır.
                </p>
              )}
            </div>
          );
        })()}
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
            <span className="cq-players-count">{countLabel}</span>
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
              return renderPlayerChip(p, { keyPrefix: "desktop" });
            })}
          </div>

          {renderBonusPanel("desktop")}

          {isRematch
            ? !canStart && (
                <div className="cq-wait-chip" role="status">
                  En az {CONQUEST_MIN_PLAYERS} aktif oyuncu gerekli — {CONQUEST_MIN_PLAYERS - activeCount} bekleniyor
                </div>
              )
            : players.length < CONQUEST_MIN_PLAYERS && (
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
                  onChange={e => {
                    const next = Number(e.target.value) as ConquestMaxPlayers;
                    if (next < players.length) {
                      setCapacityWarn(next);
                      return;
                    }
                    setCapacityWarn(null);
                    onUpdateSettings({ maxPlayers: next });
                  }}
                >
                  {CONQUEST_PLAYER_COUNTS.map(n => (
                    <option key={n} value={n}>
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

            <div className="duel-select-wrap">
              <label className="duel-select-label">🎁 Bonus Dağıtımı</label>
              <div className="duel-select-box">
                <select
                  className="duel-select"
                  value={bonusMode}
                  disabled={!isHost}
                  style={{ opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                  onChange={e => onChangeBonusDistribution(e.target.value as ConquestBonusDistribution)}
                >
                  <option value="random">🎲 Rastgele</option>
                  <option value="vote">🗳️ Oy ile Seç</option>
                </select>
                <span className="duel-select-caret">▾</span>
              </div>
            </div>
          </div>

          {isHost && capacityWarn !== null && (
            <p className="cq-player-count-warn" role="status">
              Oyuncu sayısı mevcut oyuncu sayısından ({players.length}) düşük olamaz.
            </p>
          )}

          <div className="cq-spacer" />

          <div className="cq-actions">
            {isHost && (
              <>
                <button
                  type="button"
                  className={canStart ? "btn btn-accent cq-start-btn" : "btn btn-ghost cq-start-btn"}
                  disabled={!canStart}
                  onClick={() => { playSound("click"); onStart(); }}
                  title={canStart
                    ? "Oyunu başlat"
                    : startBlockedHelper ?? `En az ${CONQUEST_MIN_PLAYERS} oyuncu gerekli`}
                >
                  🚀 Oyunu Başlat
                </button>
                {startBlockedHelper && (
                  <p className="cq-start-helper" role="status">{startBlockedHelper}</p>
                )}
              </>
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
              {waitingForHost
                ? "Yeni oyun için oda yöneticisi bekleniyor."
                : <>Sadece ev sahibi <strong>{hostName}</strong> başlatabilir.</>}
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
          <span className="wgg-players-fab-badge">{countLabel}</span>
        </button>
      )}

      {/* ════ MOBİL: Oyuncular bottom-sheet ════
       *
       * Conquest-scoped classes (.cq-ps-*) layer on top of the shared
       * .wgg-ps-* shell — wheel/duel group lobbies still get the original
       * behaviour.  The sheet itself is the scroll container (via .cq-ps-body)
       * so the bonus panel can never overlap the player list: list is natural
       * height, bonus panel sits below it, and the whole stack scrolls in
       * one direction with safe-area padding for iOS Safari.
       */}
      {playersOpen && (
        <div
          className="wgg-ps-backdrop cq-ps-backdrop"
          onClick={() => setPlayersOpen(false)}
        >
          <div
            className="wgg-ps-sheet cq-ps-sheet"
            onClick={e => e.stopPropagation()}
          >
            <div className="wgg-ps-handle" />
            <header className="wgg-ps-header">
              <span className="wgg-ps-title">
                <span>👥</span>
                <span>Oyuncular</span>
              </span>
              <span className="cq-players-count">{countLabel}</span>
              <button
                type="button"
                className="wgg-ps-close"
                aria-label="Kapat"
                onClick={() => setPlayersOpen(false)}
              >
                ✕
              </button>
            </header>
            <div className="cq-ps-body">
              <div className="wgg-ps-list cq-ps-list">
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
                  return renderPlayerChip(p, { keyPrefix: "mobile" });
                })}
              </div>
              {(isRematch ? !canStart : players.length < CONQUEST_MIN_PLAYERS) && (
                <div className="wgg-ps-warning cq-ps-warning">
                  {isRematch
                    ? `En az ${CONQUEST_MIN_PLAYERS} aktif oyuncu gerekli.`
                    : `En az ${CONQUEST_MIN_PLAYERS} oyuncu gerekli.`}
                </div>
              )}
              {renderMobileBonusPanel()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
