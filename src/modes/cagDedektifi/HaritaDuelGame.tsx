/**
 * HaritaDuelGame — Harita Dedektifi Online 1v1 lobby (MVP)
 *
 * Bu PR sadece lobby altyapısını ve UI temelini kuruyor. Round/oyun ekranı
 * henüz bağlı değil — host "Oyunu Başlat" dediğinde placeholder ekran açılır.
 *
 * Mimari (mevcut Ülke Yaz / Bayrak / Çark online lobby desenleriyle uyumlu):
 *   - Lobby state Supabase Realtime channel üzerinden yürür:
 *       channel: `harita-duel-<CODE>`
 *       presence: oyuncu listesi (playerId, name, isHost)
 *       broadcast 'settings': host mod/tur ayarını yayar
 *       broadcast 'request_settings': joiner host'tan snapshot ister
 *       broadcast 'start': host placeholder round ekranına geçişi tetikler
 *   - Chat: mevcut LobbyChat (sendMode="direct" → duel_messages tablosu)
 *   - DB tabloları: bu PR'da hiçbir migration yapılmaz. Round ekranı
 *     bağlandığında ayrı bir tablo seti (harita_duel_rooms / _players) ya da
 *     duel_rooms üzerinde bir 'mode' kolonu önerilecek.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import LobbyChat from "../../components/LobbyChat";
import {
  readStoredHomeTheme,
  getThemeBackgroundStyle,
  getThemeDataAttr,
} from "../../lib/themeBackgrounds";
import { playSound } from "../../lib/sound";
import { validateUsername, type Profile } from "../../lib/auth";

type Phase = "lobby" | "waiting" | "placeholder";
type DuelMode = "harita_dedektifi" | "anakronizmi_bul";

interface RoundOption {
  label: string;
  value: number;
}
const ROUND_OPTIONS: RoundOption[] = [
  { label: "5 Tur",  value: 5  },
  { label: "10 Tur", value: 10 },
  { label: "15 Tur", value: 15 },
  { label: "20 Tur", value: 20 },
];

interface ModeOption {
  label: string;
  value: DuelMode;
  disabled: boolean;
}
const MODE_OPTIONS: ModeOption[] = [
  { label: "📍 Harita Dedektifi",  value: "harita_dedektifi", disabled: false },
  { label: "🕵️ Anakronizmi Bul",   value: "anakronizmi_bul",  disabled: true  },
];

interface RoomSettings {
  mode:   DuelMode;
  rounds: number;
}

interface PresencePlayer {
  playerId: string;
  name:     string;
  isHost:   boolean;
}

function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function makePlayerId() {
  return (
    "hd-" +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}

interface HaritaDuelGameProps {
  onHome:   () => void;
  profile?: Profile | null;
}

export default function HaritaDuelGame({ onHome, profile }: HaritaDuelGameProps) {
  const loggedInUsername = profile?.username ?? "";
  const isLoggedInPlayer = !!loggedInUsername;

  const [playerName, setPlayerName] = useState("");
  const effectivePlayerName = loggedInUsername || playerName;

  const [joinCode,   setJoinCode]   = useState("");
  const [phase,      setPhase]      = useState<Phase>("lobby");
  const [errorMsg,   setErrorMsg]   = useState<string | null>(null);
  const [statusMsg,  setStatusMsg]  = useState<string | null>(null);
  const [copied,     setCopied]     = useState(false);

  const [roomCode,   setRoomCode]   = useState<string | null>(null);
  const [isHost,     setIsHost]     = useState(false);
  const [players,    setPlayers]    = useState<PresencePlayer[]>([]);
  const [settings,   setSettings]   = useState<RoomSettings>({
    mode:   "harita_dedektifi",
    rounds: 10,
  });

  const playerIdRef = useRef<string>("");
  const channelRef  = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // Reflect latest "isHost" inside async channel callbacks without re-subscribing.
  const isHostRef   = useRef(false);
  isHostRef.current = isHost;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /* ── Realtime channel teardown ── */
  const teardownChannel = useCallback(() => {
    const ch = channelRef.current;
    if (!ch) return;
    void supabase.removeChannel(ch);
    channelRef.current = null;
  }, []);

  useEffect(() => () => teardownChannel(), [teardownChannel]);

  /* ── Subscribe to a channel + presence ── */
  const subscribeToRoom = useCallback(
    async (code: string, asHost: boolean): Promise<boolean> => {
      teardownChannel();
      const myId = playerIdRef.current || makePlayerId();
      playerIdRef.current = myId;

      const myName = effectivePlayerName.trim();
      const channel = supabase.channel(`harita-duel-${code}`, {
        config: { presence: { key: myId } },
      });
      channelRef.current = channel;

      channel.on("presence", { event: "sync" }, () => {
        const state = channel.presenceState() as Record<
          string,
          Array<{ playerId: string; name: string; isHost: boolean }>
        >;
        const list: PresencePlayer[] = [];
        Object.values(state).forEach((entries) => {
          entries.forEach((e) =>
            list.push({
              playerId: e.playerId,
              name:     e.name,
              isHost:   !!e.isHost,
            }),
          );
        });
        list.sort((a, b) =>
          a.isHost === b.isHost ? a.name.localeCompare(b.name) : a.isHost ? -1 : 1,
        );
        setPlayers(list);
      });

      channel.on("broadcast", { event: "settings" }, (payload) => {
        const next = payload.payload as RoomSettings | undefined;
        if (!next) return;
        if (!isHostRef.current) setSettings(next);
      });

      channel.on("broadcast", { event: "request_settings" }, () => {
        if (isHostRef.current) {
          channel.send({
            type:    "broadcast",
            event:   "settings",
            payload: settingsRef.current,
          });
        }
      });

      channel.on("broadcast", { event: "start" }, () => {
        setPhase("placeholder");
      });

      return new Promise<boolean>((resolve) => {
        channel.subscribe(async (status) => {
          if (status !== "SUBSCRIBED") return;
          await channel.track({
            playerId: myId,
            name:     myName || "Misafir",
            isHost:   asHost,
          });
          if (!asHost) {
            // Ask the host for the current settings snapshot.
            await channel.send({
              type:    "broadcast",
              event:   "request_settings",
              payload: { from: myId },
            });
          }
          resolve(true);
        });
      });
    },
    [effectivePlayerName, teardownChannel],
  );

  /* ── Push settings on host change ── */
  useEffect(() => {
    if (!isHost) return;
    const ch = channelRef.current;
    if (!ch) return;
    void ch.send({
      type:    "broadcast",
      event:   "settings",
      payload: settings,
    });
  }, [isHost, settings]);

  /* ── Actions ── */
  const createRoom = async () => {
    const name = effectivePlayerName.trim();
    const usernameError = validateUsername(name);
    if (usernameError) {
      setErrorMsg(usernameError);
      return;
    }
    setErrorMsg(null);
    setStatusMsg("Oda kuruluyor…");
    const code = makeCode();
    playerIdRef.current = makePlayerId();
    setIsHost(true);
    setRoomCode(code);
    setPlayers([]);
    const ok = await subscribeToRoom(code, true);
    if (!ok) {
      setErrorMsg("Realtime bağlantı kurulamadı.");
      setStatusMsg(null);
      setIsHost(false);
      setRoomCode(null);
      return;
    }
    setStatusMsg(null);
    setPhase("waiting");
  };

  const joinRoom = async () => {
    const name = effectivePlayerName.trim();
    const usernameError = validateUsername(name);
    if (usernameError) {
      setErrorMsg(usernameError);
      return;
    }
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setErrorMsg("Oda kodu yazmalısın.");
      return;
    }
    setErrorMsg(null);
    setStatusMsg("Odaya bağlanılıyor…");
    playerIdRef.current = makePlayerId();
    setIsHost(false);
    setRoomCode(code);
    setPlayers([]);
    const ok = await subscribeToRoom(code, false);
    if (!ok) {
      setErrorMsg("Realtime bağlantı kurulamadı.");
      setStatusMsg(null);
      setRoomCode(null);
      return;
    }
    setStatusMsg(null);
    setPhase("waiting");
  };

  const quickMatch = () => {
    // Hızlı eşleş henüz bağlı değil — kullanıcıya kısa bilgi göster.
    setStatusMsg("Hızlı eşleş yakında — şimdilik oda kurabilir veya kodla katılabilirsin.");
    window.setTimeout(() => setStatusMsg(null), 2500);
  };

  const backToLobby = () => {
    teardownChannel();
    setPhase("lobby");
    setRoomCode(null);
    setIsHost(false);
    setPlayers([]);
    setErrorMsg(null);
    setStatusMsg(null);
  };

  const startGame = async () => {
    if (!isHost || !channelRef.current) return;
    await channelRef.current.send({
      type:    "broadcast",
      event:   "start",
      payload: { settings: settingsRef.current },
    });
    setPhase("placeholder");
  };

  const copyCode = async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  /* ── Theme background (matches other 1v1 lobbies) ── */
  const homeTheme = useMemo(() => readStoredHomeTheme(), []);
  const themeBg   = phase !== "placeholder" ? getThemeBackgroundStyle(homeTheme) : undefined;
  const themeAttr = phase !== "placeholder" ? getThemeDataAttr(homeTheme) : undefined;

  const modeLabel  = MODE_OPTIONS.find(m => m.value === settings.mode)?.label ?? "Harita Dedektifi";
  const roundLabel = ROUND_OPTIONS.find(r => r.value === settings.rounds)?.label ?? `${settings.rounds} Tur`;

  return (
    <div
      className="app duel-screen"
      style={themeBg}
      data-theme={themeAttr}
    >
      {/* ── HEADER ── */}
      <div className="duel-header">
        <button
          className="back-btn"
          onClick={() => {
            playSound("click");
            teardownChannel();
            onHome();
          }}
        >
          <span>←</span>
          <span className="back-label">Menü</span>
        </button>
        <div className="duel-header-center">
          <span className="duel-mode-label">⚔️ Harita Dedektifi 1v1</span>
          {roomCode && phase !== "lobby" && (
            <span className="duel-code-badge">#{roomCode}</span>
          )}
        </div>
        <div style={{ width: 44 }} />
      </div>

      {/* ════════ LOBBY ════════ */}
      {phase === "lobby" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">⚔️ Harita Dedektifi 1v1</h2>
            <p className="duel-lobby-desc">
              Arkadaşınla gerçek zamanlı Harita Dedektifi düellosu.<br />
              Doğru noktayı önce ve daha yakın tahmin eden kazanır!
            </p>

            {/* Player name */}
            <div className="duel-field-row">
              <label className="duel-field-label">Oyuncu Adın</label>
              <input
                className="duel-name-input"
                type="text"
                placeholder="Adını gir..."
                value={isLoggedInPlayer ? loggedInUsername : playerName}
                onChange={(e) => {
                  if (isLoggedInPlayer) return;
                  setPlayerName(e.target.value);
                }}
                disabled={isLoggedInPlayer}
                maxLength={20}
                autoComplete="off"
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              />
            </div>

            {/* HOST settings block */}
            <div className="duel-settings-block">
              <p className="duel-settings-title">🏠 Oda Kur</p>

              <div className="duel-selects-row">
                {/* Mode select */}
                <div className="duel-select-wrap">
                  <label className="duel-select-label">Mod</label>
                  <div className="duel-select-box">
                    <select
                      className="duel-select"
                      value={settings.mode}
                      onChange={(e) =>
                        setSettings(s => ({ ...s, mode: e.target.value as DuelMode }))
                      }
                    >
                      {MODE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value} disabled={o.disabled}>
                          {o.label}{o.disabled ? " (Yakında)" : ""}
                        </option>
                      ))}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>

                {/* Rounds select */}
                <div className="duel-select-wrap">
                  <label className="duel-select-label">Tur</label>
                  <div className="duel-select-box">
                    <select
                      className="duel-select"
                      value={settings.rounds}
                      onChange={(e) =>
                        setSettings(s => ({ ...s, rounds: Number(e.target.value) }))
                      }
                    >
                      {ROUND_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>
              </div>

              <button
                className="btn btn-accent duel-create-btn"
                onClick={createRoom}
              >
                🏠 Oda Kur
              </button>
            </div>

            {/* Divider */}
            <div className="duel-section-divider">veya mevcut bir odaya katıl</div>

            {/* JOIN block */}
            <div className="duel-join-block">
              <div className="duel-join-row">
                <input
                  className="duel-code-input"
                  type="text"
                  placeholder="ODA KODU"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  autoComplete="off"
                />
                <button className="btn btn-danger" onClick={joinRoom}>Katıl</button>
              </div>
            </div>

            {/* Quick Match */}
            <div className="duel-section-divider">veya hızlı eşleş</div>
            <button
              className="btn btn-accent duel-quickmatch-btn"
              onClick={quickMatch}
              title="Hızlı eşleş yakında"
            >
              ⚡ Hızlı Eşleş <span style={{ opacity: 0.65 }}>(Yakında)</span>
            </button>

            {errorMsg  && <p className="duel-error">{errorMsg}</p>}
            {statusMsg && <p className="duel-status">{statusMsg}</p>}
          </div>
        </div>
      )}

      {/* ════════ WAITING (Lobby with players + chat) ════════ */}
      {phase === "waiting" && roomCode && (
        <div className="duel-lobby">
          <div className="duel-lobby-with-chat duel-1v1-room-layout">
            <div className="duel-lobby-card duel-1v1-room-card">
              <h2 className="duel-lobby-title" style={{ fontSize: 22, margin: "0 0 14px" }}>
                Harita Dedektifi 1v1
              </h2>

              {/* Big room code */}
              <div className="duel-room-code-block" style={{ margin: "0 0 12px" }}>
                <span
                  className="duel-room-code"
                  style={{ fontSize: 36, letterSpacing: "0.15em" }}
                >
                  {roomCode}
                </span>
                <p className="duel-room-code-hint" style={{ fontSize: 12, marginTop: 4 }}>
                  6 haneli kod — arkadaşına ver
                </p>
              </div>

              <button
                className={"btn duel-invite-btn" + (copied ? " invited" : "")}
                onClick={copyCode}
              >
                {copied ? "✓ Kod kopyalandı!" : "📋 Oda Kodunu Kopyala"}
              </button>

              {/* Middle: players + settings */}
              <div className="duel-wait-middle" style={{ marginTop: 8 }}>
                <div className="duel-wait-players-box">
                  <div className="duel-wait-section-title">Oyuncular</div>
                  <div className="duel-players-list duel-wait-players">
                    {players.map((p) => (
                      <div
                        key={p.playerId}
                        className={
                          "duel-player-chip" +
                          (p.playerId === playerIdRef.current ? " mine" : "")
                        }
                      >
                        <span className="duel-player-dot" />
                        <span className="duel-player-name">{p.name}</span>
                        <div className="duel-player-tags">
                          {p.playerId === playerIdRef.current && (
                            <span className="duel-tag">Sen</span>
                          )}
                          {p.isHost && <span className="duel-tag host">👑</span>}
                        </div>
                      </div>
                    ))}

                    {players.length < 2 && (
                      <div className="duel-player-chip waiting">
                        <span className="duel-player-dot waiting" />
                        <span>Rakip bekleniyor...</span>
                      </div>
                    )}
                  </div>

                  {isHost && players.length < 2 && (
                    <p style={{ margin: "10px 0 0", fontSize: 12, opacity: 0.65, textAlign: "center" }}>
                      Rakibin katılması bekleniyor...
                    </p>
                  )}
                  {isHost && players.length >= 2 && (
                    <p style={{ margin: "10px 0 0", fontSize: 12, opacity: 0.65, textAlign: "center" }}>
                      Oyunu başlatmanız bekleniyor
                    </p>
                  )}
                  {!isHost && (
                    <p style={{ margin: "10px 0 0", fontSize: 12, opacity: 0.65, textAlign: "center" }}>
                      Ev sahibi oyunu başlatacak...
                    </p>
                  )}
                </div>

                {/* Room settings */}
                <div className="duel-wait-settings-lift">
                  <div className="duel-room-settings-box duel-wait-settings-compact">
                    <div className="duel-room-settings-title">⚙️ Oda Ayarları</div>
                    <div className="duel-room-settings-grid">
                      <label className="duel-room-setting-field">
                        <span>Mod</span>
                        <select
                          value={settings.mode}
                          disabled={!isHost}
                          onChange={(e) =>
                            setSettings(s => ({ ...s, mode: e.target.value as DuelMode }))
                          }
                        >
                          {MODE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value} disabled={o.disabled}>
                              {o.label}{o.disabled ? " (Yakında)" : ""}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="duel-room-setting-field">
                        <span>Tur</span>
                        <select
                          value={settings.rounds}
                          disabled={!isHost}
                          onChange={(e) =>
                            setSettings(s => ({ ...s, rounds: Number(e.target.value) }))
                          }
                        >
                          {ROUND_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <p
                      className="duel-room-settings-note"
                      style={{
                        margin: "10px 0 0",
                        fontSize: 11,
                        opacity: 0.6,
                        textAlign: "center",
                        lineHeight: 1.3,
                      }}
                    >
                      {isHost
                        ? "Ayarları buradan değiştirebilirsiniz"
                        : "Yalnızca oda sahibi değiştirebilir"}
                    </p>
                  </div>
                </div>
              </div>

              {/* Start / Back */}
              {isHost && players.length >= 2 ? (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 18,
                    marginTop: 2,
                    width: "100%",
                    maxWidth: 610,
                    marginLeft: "auto",
                    marginRight: "auto",
                  }}
                >
                  <button
                    className="btn btn-accent duel-start-btn"
                    onClick={startGame}
                    style={{ minHeight: 46, fontSize: 15, borderRadius: 14, fontWeight: 800 }}
                  >
                    🚀 Oyunu Başlat
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={backToLobby}
                    style={{ minHeight: 46, fontSize: 14, borderRadius: 14, fontWeight: 700, opacity: 0.85 }}
                  >
                    ← Lobiye Dön
                  </button>
                </div>
              ) : (
                <div style={{ marginTop: 0, width: "100%", maxWidth: 610, marginLeft: "auto", marginRight: "auto" }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={backToLobby}
                    style={{ width: "100%", minHeight: 46, fontSize: 14, borderRadius: 14, fontWeight: 700, opacity: 0.85 }}
                  >
                    ← Lobiye Dön
                  </button>
                </div>
              )}

              {errorMsg && <p className="duel-error">{errorMsg}</p>}
            </div>

            {/* Chat panel — mevcut LobbyChat reuse (direct mode) */}
            <div className="duel-wait-chat-align">
              <LobbyChat
                roomCode={roomCode}
                playerName={effectivePlayerName}
                sendMode="direct"
              />
            </div>
          </div>
        </div>
      )}

      {/* ════════ PLACEHOLDER (start sonrası) ════════ */}
      {phase === "placeholder" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card" style={{ textAlign: "center" }}>
            <h2 className="duel-lobby-title">🚧 Harita Dedektifi 1v1</h2>
            <p className="duel-lobby-desc" style={{ marginTop: 8 }}>
              Round ekranı hazırlanıyor — yakında!<br />
              <span style={{ opacity: 0.75 }}>
                Mod: <strong>{modeLabel}</strong> · {roundLabel}
              </span>
            </p>
            <div style={{ fontSize: 64, margin: "16px 0" }}>🗺️ ⚔️</div>
            <button
              className="btn btn-accent"
              onClick={backToLobby}
              style={{ minWidth: 180 }}
            >
              ← Lobiye Dön
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
