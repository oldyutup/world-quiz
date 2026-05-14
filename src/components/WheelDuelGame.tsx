/**
 * WheelDuelGame.tsx — Online Çark 1v1 (Lobby Supabase-bound)
 *
 * Bu component artık gerçek Supabase senkronu kullanır:
 *   • wheel_duel_rooms  — oda satırı (host_player_id, status, settings)
 *   • wheel_duel_players — oda oyuncuları (id, name, score)
 *   • duel_messages     — LobbyChat reuse (W-prefix sayesinde çakışmaz)
 *
 * Faz akışı:
 *   setup    → kullanıcı ad + ayar girer / odaya katılır
 *   creating → DB insert in-flight
 *   lobby    → realtime players + room.status izlenir, host start atabilir
 *   playing  → status='playing' olunca tetiklenir; gameplay placeholder
 *
 * isHost kararı: room.host_player_id === myId
 *   (players[0] gibi sıraya dayalı kararlardan kaçınılır)
 *
 * Sonraki iterasyon kapsamı (BU TURDA YOK):
 *   - gameplay senkronu (current_target_topoid, used_target_topoids, score)
 *   - winner/finish, finished_reason, finished_at
 *   - heartbeat (last_seen_at), disconnect grace
 *   - stale lobby cleanup, F5 resume
 *   - hızlı eşleş
 */

import { useEffect, useMemo, useRef, useState } from "react";
import LobbyChat from "./LobbyChat";
import type { Profile } from "../lib/auth";
import {
  supabase,
  type WheelDuelRoom,
  type WheelDuelPlayer,
} from "../lib/supabase";
import { playSound } from "../lib/sound";

/* ═══════════════════════════════════════════════════════════════
   TYPES & CONSTANTS
═══════════════════════════════════════════════════════════════ */

type Phase = "setup" | "creating" | "lobby" | "playing";
type Region =
  | "world"
  | "europe"
  | "asia"
  | "africa"
  | "north-america"
  | "south-america"
  | "oceania";

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

const PLAYER_ID_KEY = "geoquiz_wheel_duel_player_id";
const ROOM_KEY = "geoquiz_wheel_duel_room";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */

/** "W" + 5 random char → 6 toplam. W-prefix kuralı: country/flag duel
 *  kodları ile aynı duel_messages.room_code alanını paylaştığımız için
 *  chat geçmişlerinin karışmaması adına. */
function generateRoomCode(): string {
  let out = "W";
  for (let i = 0; i < 5; i++) {
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

function normalizeRegion(r: string): string {
  const map: Record<string, string> = {
    "north-america": "north_america",
    "south-america": "south_america",
  };
  return map[r] ?? r;
}

function denormalizeRegion(r: string): string {
  const map: Record<string, string> = {
    "north_america": "north-america",
    "south_america": "south-america",
  };
  return map[r] ?? r;
}

function regionLabel(value: string): string {
  const denorm = denormalizeRegion(value);
  return REGION_OPTIONS.find(r => r.value === denorm)?.label ?? value;
}

function durationLabel(value: number): string {
  return DURATION_OPTIONS.find(d => d.value === value)?.label ?? `${value}sn`;
}

function freshPlayerId(): string {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(PLAYER_ID_KEY, id);
  return id;
}

function clearWheelDuelSession() {
  localStorage.removeItem(PLAYER_ID_KEY);
  localStorage.removeItem(ROOM_KEY);
}

function saveRoomSession(roomId: string, roomCode: string, playerId: string) {
  localStorage.setItem(
    ROOM_KEY,
    JSON.stringify({ roomId, roomCode, playerId }),
  );
}

function validateName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return "Oyuncu adı en az 2 karakter olmalı.";
  if (trimmed.length > 16) return "Oyuncu adı en fazla 16 karakter olabilir.";
  return null;
}

function describeSupabaseError(code: string | undefined): string | null {
  if (!code) return null;
  if (code === "42P01")
    return "Veritabanı tabloları hazır değil. Yöneticiyle iletişime geç.";
  if (code === "42501") return "Veritabanı izin hatası. RLS politikalarını kontrol et.";
  return null;
}

/* ═══════════════════════════════════════════════════════════════
   COMPONENT
═══════════════════════════════════════════════════════════════ */

interface Props {
  onHome: () => void;
  profile: Profile | null;
}

export default function WheelDuelGame({ onHome, profile }: Props) {
  /* ── Phase ───────────────────────────────────────────────── */
  const [phase, setPhase] = useState<Phase>("setup");

  /* ── Setup form state ────────────────────────────────────── */
  const initialName = profile?.username ?? "";
  const [playerName, setPlayerName] = useState<string>(initialName);
  const [hostDuration, setHostDuration] = useState<number>(120);
  const [hostRegion, setHostRegion] = useState<Region>("world");
  const [joinCode, setJoinCode] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [hostClosedRoom, setHostClosedRoom] = useState(false);

  /* ── Lobby state (Supabase-bound) ─────────────────────────── */
  const [room, setRoom] = useState<WheelDuelRoom | null>(null);
  const [players, setPlayers] = useState<WheelDuelPlayer[]>([]);
  const [copied, setCopied] = useState(false);

  /* ── Identity (set fresh on create/join) ──────────────────── */
  const myIdRef = useRef<string>("");

  /* ── Derived ─────────────────────────────────────────────── */
  const isHost = !!room && room.host_player_id === myIdRef.current;
  const lobbyDuration = room?.duration_seconds ?? hostDuration;
  const lobbyRegionDb = room?.region ?? normalizeRegion(hostRegion);

  /* ── URL param: ?wheelDuel=KOD ───────────────────────────── */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wheelCode = params.get("wheelDuel");
    if (wheelCode) {
      setJoinCode(normalizeRoomCode(wheelCode));
    }
  }, []);

  /* ── Davet linki ─────────────────────────────────────────── */
  const shareLink = useMemo(() => {
    if (!room) return "";
    const url = new URL(window.location.href);
    url.searchParams.delete("duel");
    url.searchParams.delete("duelGroup");
    url.searchParams.delete("flagDuel");
    url.searchParams.set("wheelDuel", room.code);
    return url.toString();
  }, [room]);

  const inviteMessage = useMemo(() => {
    if (!room) return "";
    return (
      `Torble'da Online Çark 1v1 oynayalım! 🎯\n` +
      `Mod: ${regionLabel(room.region)} · Süre: ${durationLabel(room.duration_seconds)}\n` +
      `Çarkın seçtiği ülkeyi haritada en hızlı bulan kazanır.\n` +
      `Katılmak için tıkla:\n${shareLink}`
    );
  }, [room, shareLink]);

  /* ───────────────────────────────────────────────────────────
     REALTIME: oda + oyuncular
  ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!room) return;
    const roomId = room.id;
    const hostIdAtSubscribe = room.host_player_id;

    const chan = supabase
      .channel(`wheel-duel:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "wheel_duel_rooms",
          filter: `id=eq.${roomId}`,
        },
        payload => {
          const r = payload.new as WheelDuelRoom;
          setRoom(r);
          if (r.status === "playing") {
            setPhase(prev => (prev === "playing" ? prev : "playing"));
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "wheel_duel_rooms",
          filter: `id=eq.${roomId}`,
        },
        () => {
          // Misafir tarafında host odayı kapattıysa setup'a dön + uyarı
          if (myIdRef.current !== hostIdAtSubscribe) {
            setHostClosedRoom(true);
            setRoom(null);
            setPlayers([]);
            clearWheelDuelSession();
            setPhase("setup");
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "wheel_duel_players",
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          supabase
            .from("wheel_duel_players")
            .select("*")
            .eq("room_id", roomId)
            .order("joined_at", { ascending: true })
            .then(({ data }) => {
              if (data) setPlayers(data as WheelDuelPlayer[]);
            });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(chan);
    };
  }, [room?.id]);

  /* ───────────────────────────────────────────────────────────
     ACTIONS
  ─────────────────────────────────────────────────────────── */

  async function createRoom() {
    playSound("click");
    const nameErr = validateName(playerName);
    if (nameErr) {
      setErrorMsg(nameErr);
      return;
    }

    setErrorMsg(null);
    setHostClosedRoom(false);
    setStatusMsg("Oda kuruluyor…");
    setPhase("creating");

    clearWheelDuelSession();
    const freshId = freshPlayerId();
    myIdRef.current = freshId;

    const code = generateRoomCode();
    const trimmedName = playerName.trim();

    // 1) Oda insert
    const { data: roomData, error: roomErr } = await supabase
      .from("wheel_duel_rooms")
      .insert({
        code,
        status: "waiting",
        duration_seconds: hostDuration,
        region: normalizeRegion(hostRegion),
        host_player_id: freshId,
      })
      .select("*")
      .single();

    if (roomErr || !roomData?.id) {
      const friendly =
        describeSupabaseError(roomErr?.code) ??
        "Oda oluşturulamadı. Bağlantıyı kontrol et.";
      setErrorMsg(friendly);
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    const createdRoom = roomData as WheelDuelRoom;

    // 2) Host oyuncuyu ekle
    const { error: playerErr } = await supabase
      .from("wheel_duel_players")
      .insert({
        id: freshId,
        room_id: createdRoom.id,
        name: trimmedName,
        score: 0,
      });

    if (playerErr) {
      // Orphan oda temizliği (best-effort)
      supabase
        .from("wheel_duel_rooms")
        .delete()
        .eq("id", createdRoom.id)
        .then(() => {});
      const friendly =
        describeSupabaseError(playerErr.code) ??
        "Host eklenemedi. Tekrar dene.";
      setErrorMsg(friendly);
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    // 3) İlk player listesini çek (realtime + ilk render)
    const { data: ps } = await supabase
      .from("wheel_duel_players")
      .select("*")
      .eq("room_id", createdRoom.id)
      .order("joined_at", { ascending: true });

    setRoom(createdRoom);
    setPlayers((ps ?? []) as WheelDuelPlayer[]);
    saveRoomSession(createdRoom.id, createdRoom.code, freshId);
    setStatusMsg(null);
    setPhase("lobby");
  }

  async function joinRoomByCode() {
    playSound("click");
    const nameErr = validateName(playerName);
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
    setHostClosedRoom(false);
    setStatusMsg("Odaya bağlanılıyor…");
    setPhase("creating");

    clearWheelDuelSession();
    const freshId = freshPlayerId();
    myIdRef.current = freshId;

    // 1) Oda kodu lookup
    const { data: r, error: re } = await supabase
      .from("wheel_duel_rooms")
      .select("*")
      .eq("code", normalized)
      .maybeSingle();

    if (re || !r?.id) {
      const friendly =
        describeSupabaseError(re?.code) ?? "Oda bulunamadı. Kodu kontrol et.";
      setErrorMsg(friendly);
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    const targetRoom = r as WheelDuelRoom;

    if (targetRoom.status === "finished") {
      setErrorMsg("Bu oda kapanmış.");
      setStatusMsg(null);
      setPhase("setup");
      return;
    }
    if (targetRoom.status === "playing") {
      setErrorMsg("Maç zaten başlamış. Katılamazsın.");
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    // 2) Kapasite + isim çakışması
    const { data: existing } = await supabase
      .from("wheel_duel_players")
      .select("id, name")
      .eq("room_id", targetRoom.id);

    const trimmedName = playerName.trim();
    const sameName = (existing ?? []).some(
      p =>
        p.name?.trim().toLocaleLowerCase("tr-TR") ===
        trimmedName.toLocaleLowerCase("tr-TR"),
    );
    if (sameName) {
      setErrorMsg("Bu odada bu isim zaten kullanılıyor.");
      setStatusMsg(null);
      setPhase("setup");
      return;
    }
    if ((existing?.length ?? 0) >= 2) {
      setErrorMsg("Oda dolu (2 oyuncu mevcut).");
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    // 3) Player insert
    const { error: pe } = await supabase
      .from("wheel_duel_players")
      .insert({
        id: freshId,
        room_id: targetRoom.id,
        name: trimmedName,
        score: 0,
      });

    if (pe) {
      const friendly =
        describeSupabaseError(pe.code) ?? "Odaya katılınamadı.";
      setErrorMsg(friendly);
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    // 4) Player listesini çek
    const { data: ps } = await supabase
      .from("wheel_duel_players")
      .select("*")
      .eq("room_id", targetRoom.id)
      .order("joined_at", { ascending: true });

    setRoom(targetRoom);
    setPlayers((ps ?? []) as WheelDuelPlayer[]);
    saveRoomSession(targetRoom.id, targetRoom.code, freshId);
    setStatusMsg(null);
    setPhase("lobby");
  }

  async function leaveRoom() {
    playSound("click");
    const currentRoom = room;
    const currentMyId = myIdRef.current;
    const amHost = !!currentRoom && currentRoom.host_player_id === currentMyId;

    // UI önce sıfırlansın — DB silinmesini beklemeden setup'a dönelim
    setRoom(null);
    setPlayers([]);
    setCopied(false);
    setErrorMsg(null);
    setStatusMsg(null);
    setPhase("setup");
    clearWheelDuelSession();

    if (!currentRoom) return;

    if (amHost) {
      // Cascade delete sayesinde players da silinir
      await supabase
        .from("wheel_duel_rooms")
        .delete()
        .eq("id", currentRoom.id);
    } else {
      await supabase
        .from("wheel_duel_players")
        .delete()
        .eq("id", currentMyId)
        .eq("room_id", currentRoom.id);
    }
  }

  async function startGame() {
    playSound("click");
    if (!room || !isHost) return;
    if (players.length < 2) return;

    const startedAt = new Date().toISOString();
    // Optimistic — realtime UPDATE da aynı değeri getirecek
    setPhase("playing");

    const { error } = await supabase
      .from("wheel_duel_rooms")
      .update({ status: "playing", started_at: startedAt })
      .eq("id", room.id);

    if (error) {
      setErrorMsg("Oyun başlatılamadı. Tekrar dene.");
      setPhase("lobby");
    }
  }

  async function updateHostSetting(
    next: { duration_seconds?: number; region?: string },
  ) {
    if (!room || !isHost) return;

    // Optimistic
    setRoom(prev => (prev ? { ...prev, ...next } : prev));

    const { error } = await supabase
      .from("wheel_duel_rooms")
      .update(next)
      .eq("id", room.id);

    if (error) {
      // Rollback'i realtime echo'ya bırakıyoruz; en kötü ihtimal eski değer geri gelir
      console.error("[WheelDuel] updateHostSetting failed", error);
    }
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
            if (room) {
              leaveRoom();
            }
            onHome();
          }}
          title="Ana Menü"
        >
          <span>←</span>
          <span className="back-label">Menü</span>
        </button>

        <div className="duel-header-center">
          <span className="duel-mode-label">🎯 Çark · Online 1v1</span>
          {room && phase !== "setup" && (
            <>
              <span className="duel-code-badge">#{room.code}</span>
              <span className="duel-region-badge">{regionLabel(room.region)}</span>
            </>
          )}
        </div>

        <div style={{ width: 80 }} />
      </div>

      {/* ════════ SETUP ════════ */}
      {(phase === "setup" || phase === "creating") && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">🎯 Çark · Online 1v1</h2>
            <p className="duel-lobby-desc">
              Bir oda kur ya da arkadaşının kodunu gir. Lobby Supabase
              üzerinden senkronize — oyuncu listesi her iki tarayıcıda da
              anlık güncellenir. Çark gameplay sonraki aşamada.
            </p>

            {hostClosedRoom && (
              <p className="duel-error" style={{ marginTop: 4 }}>
                Ev sahibi odayı kapattı.
              </p>
            )}

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
                disabled={phase === "creating"}
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
                      disabled={phase === "creating"}
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
                      disabled={phase === "creating"}
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
                disabled={phase === "creating"}
              >
                {phase === "creating" && statusMsg?.includes("kuruluyor")
                  ? "Oda kuruluyor…"
                  : "🏠 Oda Kur"}
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
                  disabled={phase === "creating"}
                />
                <button
                  className="btn btn-danger"
                  onClick={joinRoomByCode}
                  disabled={phase === "creating"}
                >
                  {phase === "creating" && statusMsg?.includes("bağlan")
                    ? "Bağlanılıyor…"
                    : "Katıl"}
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
            {statusMsg && phase === "creating" && !errorMsg && (
              <p className="duel-status">{statusMsg}</p>
            )}
          </div>
        </div>
      )}

      {/* ════════ LOBBY ════════ */}
      {phase === "lobby" && room && (
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
                  {room.code}
                </span>
                <p
                  className="duel-room-code-hint"
                  style={{ fontSize: 12, marginTop: 4 }}
                >
                  6 haneli kod — arkadaşına ver
                </p>
              </div>

              {/* Invite */}
              <button
                className={"btn duel-invite-btn" + (copied ? " invited" : "")}
                onClick={copyInvite}
              >
                {copied
                  ? "✓ Davet mesajı kopyalandı!"
                  : "📋 Davet Mesajını Kopyala"}
              </button>

              <div
                className="duel-link-preview"
                style={{ marginBottom: 10 }}
                onClick={e => {
                  const el = e.currentTarget.querySelector(
                    "input",
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
                    {players.map(p => {
                      const isMe = p.id === myIdRef.current;
                      const isPlayerHost =
                        p.id === room.host_player_id;
                      return (
                        <div
                          key={p.id}
                          className={"duel-player-chip" + (isMe ? " mine" : "")}
                        >
                          <span className="duel-player-dot" />
                          <span className="duel-player-name">{p.name}</span>
                          <div className="duel-player-tags">
                            {isMe && <span className="duel-tag">Sen</span>}
                            {isPlayerHost && (
                              <span className="duel-tag host">👑</span>
                            )}
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
                          value={lobbyDuration}
                          disabled={!isHost}
                          onChange={e =>
                            updateHostSetting({
                              duration_seconds: Number(e.target.value),
                            })
                          }
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
                          value={denormalizeRegion(lobbyRegionDb)}
                          disabled={!isHost}
                          onChange={e =>
                            updateHostSetting({
                              region: normalizeRegion(e.target.value),
                            })
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

              {/* Actions */}
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
                    onClick={leaveRoom}
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
                    onClick={leaveRoom}
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

            {/* Right panel: LobbyChat */}
            <div className="duel-wait-chat-align">
              <LobbyChat
                roomCode={room.code}
                playerName={playerName.trim()}
              />
            </div>
          </div>
        </div>
      )}

      {/* ════════ PLAYING (placeholder) ════════ */}
      {phase === "playing" && room && (
        <div className="duel-lobby">
          <div className="duel-lobby-card" style={{ textAlign: "center" }}>
            <div style={{ fontSize: 56, marginBottom: 12 }}>🎯</div>
            <h2 className="duel-lobby-title">Online Çark — Yakında</h2>
            <p
              className="duel-lobby-desc"
              style={{ maxWidth: 460, margin: "0 auto 18px" }}
            >
              Online Çark gameplay bir sonraki aşamada eklenecek. Lobby
              senkronu, oda kodu ve chat hazır — gameplay senkronu eklendiğinde
              aynı odadan başlayacak.
            </p>

            <div
              className="duel-settings-summary"
              style={{ marginBottom: 18 }}
            >
              <span>#{room.code}</span>
              <span className="duel-sum-dot">·</span>
              <span>{regionLabel(room.region)}</span>
              <span className="duel-sum-dot">·</span>
              <span>⏱ {durationLabel(room.duration_seconds)}</span>
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
                onClick={leaveRoom}
              >
                ← Lobiden Çık
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  playSound("click");
                  if (room) leaveRoom();
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
