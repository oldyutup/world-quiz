/**
 * WheelDuelGame.tsx — Online Çark 1v1 (UI/Lobby İskeleti)
 *
 * Bu component henüz gameplay içermez. Yalnız UI/lobby iskeleti olarak çalışır.
 * State tamamen local/mock — Supabase'e wheel_duel_rooms / wheel_duel_players
 * tabloları henüz bağlı değil. LobbyChat reuse edildiği için chat mesajları
 * mevcut `duel_messages` tablosuna oda kodu üzerinden yazılır (chat tablosu
 * herhangi bir room_id FK kullanmadığından bu güvenli).
 *
 * Üç faz:
 *   - setup   : oyuncu adı + bölge + süre + Oda Kur / Koda Katıl
 *   - lobby   : oda kodu, davet linki, oyuncular, ayarlar, başlat
 *   - playing : "Gameplay sonraki aşamada eklenecek." placeholder
 *
 * Sonraki aşamada Supabase wheel_duel_* tablolarına bağlanacak yerler:
 *   - createRoom()        → wheel_duel_rooms insert + wheel_duel_players insert
 *   - joinRoom()          → wheel_duel_rooms select + wheel_duel_players insert
 *   - updateSettings()    → wheel_duel_rooms update (host only)
 *   - startGame()         → wheel_duel_rooms update status=playing
 *   - realtime subscribe  → players + room status
 */

import { useEffect, useMemo, useState } from "react";
import LobbyChat from "./LobbyChat";
import type { Profile } from "../lib/auth";
import { playSound } from "../lib/sound";

/* ═══════════════════════════════════════════════════════════════
   TYPES & CONSTANTS
═══════════════════════════════════════════════════════════════ */

type Phase = "setup" | "lobby" | "playing";
type Region =
  | "world"
  | "europe"
  | "asia"
  | "africa"
  | "north-america"
  | "south-america"
  | "oceania";

interface MockPlayer {
  id: string;
  name: string;
  isHost: boolean;
}

const DURATION_OPTIONS: { label: string; value: number }[] = [
  { label: "1 dk", value: 60 },
  { label: "2 dk", value: 120 },
  { label: "3 dk", value: 180 },
  { label: "5 dk", value: 300 },
];

const REGION_OPTIONS: { label: string; value: Region }[] = [
  { label: "🌍 Dünya", value: "world" },
  { label: "🇪🇺 Avrupa", value: "europe" },
  { label: "🌏 Asya", value: "asia" },
  { label: "🌍 Afrika", value: "africa" },
  { label: "🌎 K.Amerika", value: "north-america" },
  { label: "🌎 G.Amerika", value: "south-america" },
  { label: "🌊 Okyanusya", value: "oceania" },
];

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateRoomCode(len = 6): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

function normalizeRoomCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function regionLabel(value: Region): string {
  return REGION_OPTIONS.find(r => r.value === value)?.label ?? value;
}

function durationLabel(value: number): string {
  return DURATION_OPTIONS.find(d => d.value === value)?.label ?? `${value}sn`;
}

/* ═══════════════════════════════════════════════════════════════
   COMPONENT
═══════════════════════════════════════════════════════════════ */

interface Props {
  onHome: () => void;
  profile: Profile | null;
}

export default function WheelDuelGame({ onHome, profile }: Props) {
  const [phase, setPhase] = useState<Phase>("setup");

  // Setup form state
  const initialName = profile?.username ?? "";
  const [playerName, setPlayerName] = useState<string>(initialName);
  const [hostDuration, setHostDuration] = useState<number>(120);
  const [hostRegion, setHostRegion] = useState<Region>("world");
  const [joinCode, setJoinCode] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Lobby state (local/mock)
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [isHost, setIsHost] = useState<boolean>(false);
  const [players, setPlayers] = useState<MockPlayer[]>([]);
  const [copied, setCopied] = useState(false);

  /* ── URL paramı: ?wheelDuel=KOD ile gelinmişse join kodunu doldur ── */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wheelCode = params.get("wheelDuel");
    if (wheelCode) {
      setJoinCode(normalizeRoomCode(wheelCode));
    }
  }, []);

  /* ── Davet linki (URL paramı: wheelDuel=KOD) ── */
  const shareLink = useMemo(() => {
    if (!roomCode) return "";
    const url = new URL(window.location.href);
    url.searchParams.delete("duel");
    url.searchParams.delete("duelGroup");
    url.searchParams.delete("flagDuel");
    url.searchParams.set("wheelDuel", roomCode);
    return url.toString();
  }, [roomCode]);

  const inviteMessage = useMemo(() => {
    if (!roomCode) return "";
    return (
      `Torble'da Online Çark 1v1 oynayalım! 🎯\n` +
      `Mod: ${regionLabel(hostRegion)} · Süre: ${durationLabel(hostDuration)}\n` +
      `Çarkın seçtiği ülkeyi haritada en hızlı bulan kazanır.\n` +
      `Katılmak için tıkla:\n${shareLink}`
    );
  }, [roomCode, hostRegion, hostDuration, shareLink]);

  /* ── Eylemler ── */
  function validateName(): string | null {
    const trimmed = playerName.trim();
    if (trimmed.length < 2) return "Oyuncu adı en az 2 karakter olmalı.";
    if (trimmed.length > 16) return "Oyuncu adı en fazla 16 karakter olabilir.";
    return null;
  }

  function createRoom() {
    playSound("click");
    const nameErr = validateName();
    if (nameErr) {
      setErrorMsg(nameErr);
      return;
    }
    setErrorMsg(null);

    const code = generateRoomCode(6);
    const me: MockPlayer = {
      id: `local-${Date.now()}`,
      name: playerName.trim(),
      isHost: true,
    };

    setRoomCode(code);
    setIsHost(true);
    setPlayers([me]);
    setPhase("lobby");
  }

  function joinRoomByCode() {
    playSound("click");
    const nameErr = validateName();
    if (nameErr) {
      setErrorMsg(nameErr);
      return;
    }
    const normalized = normalizeRoomCode(joinCode);
    if (normalized.length !== 6) {
      setErrorMsg("Oda kodu 6 karakter olmalı.");
      return;
    }
    setErrorMsg(null);

    // Mock: ev sahibi rakip + ben
    const mockHost: MockPlayer = {
      id: `mock-host-${normalized}`,
      name: "Rakip",
      isHost: true,
    };
    const me: MockPlayer = {
      id: `local-${Date.now()}`,
      name: playerName.trim(),
      isHost: false,
    };

    setRoomCode(normalized);
    setIsHost(false);
    setPlayers([mockHost, me]);
    setPhase("lobby");
  }

  function backToSetup() {
    playSound("click");
    setPhase("setup");
    setRoomCode(null);
    setIsHost(false);
    setPlayers([]);
    setCopied(false);
    setErrorMsg(null);
  }

  function startGame() {
    playSound("click");
    setPhase("playing");
  }

  function copyInvite() {
    const text = inviteMessage || shareLink;
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

  /* ═══════════════════════════════════════════════════════════════
     RENDER
  ═══════════════════════════════════════════════════════════════ */

  return (
    <div className="app duel-screen">
      {/* ════════ HEADER ════════ */}
      <div className="duel-header">
        <button
          className="back-btn"
          onClick={() => {
            playSound("click");
            onHome();
          }}
          title="Ana Menü"
        >
          <span>←</span>
          <span className="back-label">Menü</span>
        </button>

        <div className="duel-header-center">
          <span className="duel-mode-label">🎯 Çark · Online 1v1</span>
          {roomCode && phase !== "setup" && (
            <>
              <span className="duel-code-badge">#{roomCode}</span>
              <span className="duel-region-badge">{regionLabel(hostRegion)}</span>
            </>
          )}
        </div>

        <div style={{ width: 80 }} />
      </div>

      {/* ════════ SETUP ════════ */}
      {phase === "setup" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">🎯 Çark · Online 1v1</h2>
            <p className="duel-lobby-desc">
              Bir oda kur ya da arkadaşının kodunu gir. Online çark gameplay
              sonraki aşamada eklenecek — şimdilik lobby iskeleti aktif.
            </p>

            <div className="duel-field-row">
              <label className="duel-field-label">Oyuncu Adın</label>
              <input
                className="duel-name-input"
                type="text"
                value={playerName}
                onChange={e => setPlayerName(e.target.value.slice(0, 16))}
                placeholder="Adın..."
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="duel-settings-block">
              <p className="duel-settings-title">🏠 Oda Kur</p>

              <div className="duel-selects-row">
                <div className="duel-select-wrap">
                  <label className="duel-select-label">Süre</label>
                  <div className="duel-select-box">
                    <select
                      className="duel-select"
                      value={hostDuration}
                      onChange={e => setHostDuration(Number(e.target.value))}
                    >
                      {DURATION_OPTIONS.map(d => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>

                <div className="duel-select-wrap">
                  <label className="duel-select-label">Bölge</label>
                  <div className="duel-select-box">
                    <select
                      className="duel-select"
                      value={hostRegion}
                      onChange={e => setHostRegion(e.target.value as Region)}
                    >
                      {REGION_OPTIONS.map(r => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
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

            <div className="duel-section-divider">veya mevcut bir odaya katıl</div>

            <div className="duel-join-block">
              <div className="duel-join-row">
                <input
                  className="duel-code-input"
                  type="text"
                  value={joinCode}
                  onChange={e => setJoinCode(normalizeRoomCode(e.target.value))}
                  placeholder="ODA KODU"
                  maxLength={6}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="btn btn-danger" onClick={joinRoomByCode}>
                  Katıl
                </button>
              </div>
            </div>

            <div className="duel-section-divider">veya hızlı eşleş</div>
            <button
              className="btn duel-quickmatch-btn"
              disabled
              title="Yakında"
            >
              ⚡ Hızlı Eşleş <span style={{ opacity: 0.65 }}>(Yakında)</span>
            </button>

            {errorMsg && <p className="duel-error">{errorMsg}</p>}
          </div>
        </div>
      )}

      {/* ════════ LOBBY ════════ */}
      {phase === "lobby" && roomCode && (
        <div className="duel-lobby">
          <div className="duel-lobby-with-chat duel-1v1-room-layout">
            <div className="duel-lobby-card duel-1v1-room-card">
              <h2
                className="duel-lobby-title"
                style={{ fontSize: 22, margin: "0 0 14px" }}
              >
                {isHost ? "Oda Hazır" : "Odaya Katıldın"}
              </h2>

              {/* Room code */}
              <div
                className="duel-room-code-block"
                style={{ margin: "0 0 12px" }}
              >
                <span
                  className="duel-room-code"
                  style={{ fontSize: 36, letterSpacing: "0.15em" }}
                >
                  {roomCode}
                </span>
                <p
                  className="duel-room-code-hint"
                  style={{ fontSize: 12, marginTop: 4 }}
                >
                  6 haneli kod — arkadaşına ver
                </p>
              </div>

              {/* Invite button */}
              <button
                className={"btn duel-invite-btn" + (copied ? " invited" : "")}
                onClick={copyInvite}
              >
                {copied
                  ? "✓ Davet mesajı kopyalandı!"
                  : "📋 Davet Mesajını Kopyala"}
              </button>

              {/* Link preview */}
              <div
                className="duel-link-preview"
                style={{ marginBottom: 10 }}
                onClick={e => {
                  const el = e.currentTarget.querySelector(
                    "input"
                  ) as HTMLInputElement | null;
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

              {/* Players + Settings */}
              <div className="duel-wait-middle" style={{ marginTop: 8 }}>
                <div className="duel-wait-players-box">
                  <div className="duel-wait-section-title">Oyuncular</div>

                  <div className="duel-players-list duel-wait-players">
                    {players.map(p => (
                      <div
                        key={p.id}
                        className={
                          "duel-player-chip" +
                          (p.name === playerName.trim() ? " mine" : "")
                        }
                      >
                        <span className="duel-player-dot" />
                        <span className="duel-player-name">{p.name}</span>
                        <div className="duel-player-tags">
                          {p.name === playerName.trim() && (
                            <span className="duel-tag">Sen</span>
                          )}
                          {p.isHost && (
                            <span className="duel-tag host">👑</span>
                          )}
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
                    <p
                      style={{
                        margin: "10px 0 0",
                        fontSize: 12,
                        opacity: 0.65,
                        textAlign: "center",
                      }}
                    >
                      Rakibin katılması bekleniyor...
                    </p>
                  )}
                  {isHost && players.length >= 2 && (
                    <p
                      style={{
                        margin: "10px 0 0",
                        fontSize: 12,
                        opacity: 0.65,
                        textAlign: "center",
                      }}
                    >
                      Oyunu başlatmanız bekleniyor
                    </p>
                  )}
                  {!isHost && (
                    <p
                      style={{
                        margin: "10px 0 0",
                        fontSize: 12,
                        opacity: 0.65,
                        textAlign: "center",
                      }}
                    >
                      Ev sahibi oyunu başlatacak...
                    </p>
                  )}
                </div>

                <div className="duel-wait-settings-lift">
                  <div className="duel-room-settings-box duel-wait-settings-compact">
                    <div className="duel-room-settings-title">
                      ⚙️ Oda Ayarları
                    </div>

                    <div className="duel-room-settings-grid">
                      <label className="duel-room-setting-field">
                        <span>Süre</span>
                        <select
                          value={hostDuration}
                          disabled={!isHost}
                          onChange={e => setHostDuration(Number(e.target.value))}
                        >
                          {DURATION_OPTIONS.map(d => (
                            <option key={d.value} value={d.value}>
                              {d.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="duel-room-setting-field">
                        <span>Bölge</span>
                        <select
                          value={hostRegion}
                          disabled={!isHost}
                          onChange={e =>
                            setHostRegion(e.target.value as Region)
                          }
                        >
                          {REGION_OPTIONS.map(r => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
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

              {/* Action buttons */}
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
                    onClick={startGame}
                    disabled={players.length < 2}
                    title={
                      players.length < 2
                        ? "Rakip bekleniyor"
                        : "Oyunu başlat"
                    }
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
                    onClick={backToSetup}
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
                    onClick={backToSetup}
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
            </div>

            {/* Right panel: LobbyChat reuse */}
            <div className="duel-wait-chat-align">
              <LobbyChat roomCode={roomCode} playerName={playerName.trim()} />
            </div>
          </div>
        </div>
      )}

      {/* ════════ PLAYING (placeholder) ════════ */}
      {phase === "playing" && roomCode && (
        <div className="duel-lobby">
          <div className="duel-lobby-card" style={{ textAlign: "center" }}>
            <div style={{ fontSize: 56, marginBottom: 12 }}>🎯</div>
            <h2 className="duel-lobby-title">Online Çark — Yakında</h2>
            <p
              className="duel-lobby-desc"
              style={{ maxWidth: 460, margin: "0 auto 18px" }}
            >
              Online Çark gameplay bir sonraki aşamada eklenecek. Oda kodu,
              davet linki, lobi ve chat iskeleti hazır — gameplay senkronu
              eklendiğinde aynı odadan başlayacak.
            </p>

            <div
              className="duel-settings-summary"
              style={{ marginBottom: 18 }}
            >
              <span>#{roomCode}</span>
              <span className="duel-sum-dot">·</span>
              <span>{regionLabel(hostRegion)}</span>
              <span className="duel-sum-dot">·</span>
              <span>⏱ {durationLabel(hostDuration)}</span>
            </div>

            <div
              style={{
                display: "flex",
                gap: 12,
                justifyContent: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                className="btn btn-ghost"
                onClick={() => {
                  playSound("click");
                  setPhase("lobby");
                }}
              >
                ← Lobiye Dön
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  playSound("click");
                  onHome();
                }}
              >
                ⌂ Ana Menü
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
