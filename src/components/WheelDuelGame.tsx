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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LobbyChat from "./LobbyChat";
import WorldMap from "./WorldMap";
import XpGainBar from "./XpGainBar";
import type { Profile } from "../lib/auth";
import { readStoredHomeTheme, getThemeBackgroundStyle, getThemeDataAttr } from "../lib/themeBackgrounds";
import {
  supabase,
  type WheelDuelRoom,
  type WheelDuelPlayer,
} from "../lib/supabase";
import {
  playSound,
  stopSound,
  getCountdownSoundMode,
  shouldPlayCountdownSound,
} from "../lib/sound";
import {
  awardXpEvent,
  calculateWheelDuelXp,
  resultFromScores,
  type XpBreakdown,
} from "../lib/progression";
import {
  getFlagPool,
  getContinentIds,
  TOPOID_TO_DISPLAY,
  type Continent,
} from "../data/countries";

/* ═══════════════════════════════════════════════════════════════
   TYPES & CONSTANTS
═══════════════════════════════════════════════════════════════ */

type Phase = "setup" | "creating" | "searching" | "lobby" | "playing" | "finished";

/** Heartbeat / arama tick aralığı. RPC tarafı 45 sn expires_at kullanıyor. */
const QUICK_MATCH_TICK_MS = 3000;

/** Bekleme süresine göre kabul edilen wheel_duel mode level farkı.
 *  RPC tarafı simetrik LEAST(caller, candidate) uygular; iki taraf da
 *  birbirinin level'ını kabul ediyor olmalı. */
function quickMatchBracket(searchSeconds: number): number {
  if (searchSeconds < 10) return 0;
  if (searchSeconds < 20) return 2;
  if (searchSeconds < 30) return 5;
  if (searchSeconds < 60) return 15;
  return 9999;
}

const FEEDBACK_MS = 1200;   // Doğru bilinince hedef bu kadar süre kapalı kalır (host pick gecikmesi)
const WRONG_FLASH_MS = 600; // Yanlış tıklama kırmızı flash süresi (lokal)

/** Online Çark 1v1 hedef havuzundan ÇIKARILAN ülkeler.
 *
 *  Mikro devletler ve haritada tıklanması zor ada ülkeleri online
 *  rekabette adil olmuyor — yalnız bu mod için dışarıda bırakılır.
 *  Offline WheelGame ve diğer modlar etkilenmez.
 *
 *  topoId üzerinden filtreliyoruz (display adı dilden dile değişebilir,
 *  ISO numerik kod kararlıdır). Listeyi düzenlemek için satır eklemek/
 *  silmek yeterli; her topoId'in yanına ülke adını yorum olarak yazdım.
 */
const WHEEL_DUEL_EXCLUDED_TOPOIDS = new Set<string>([
  // ── Avrupa mikro-devletleri ──
  "020",  // Andorra
  "438",  // Lihtenştayn / Liechtenstein
  "470",  // Malta
  "492",  // Monako / Monaco
  "674",  // San Marino
  "336",  // Vatikan / Vatican

  // ── Asya küçük/ada ülkeleri ──
  "048",  // Bahreyn / Bahrain
  "462",  // Maldivler / Maldives
  "702",  // Singapur / Singapore

  // ── Afrika ada ülkeleri ──
  "132",  // Cabo Verde / Cape Verde
  "174",  // Komorlar / Comoros
  "480",  // Mauritius
  "678",  // Sao Tome ve Principe / Sao Tome and Principe
  "690",  // Seyşeller / Seychelles

  // ── Karayipler / K.Amerika mikro adaları ──
  "028",  // Antigua ve Barbuda
  "052",  // Barbados
  "212",  // Dominika / Dominica
  "308",  // Grenada
  "659",  // Saint Kitts ve Nevis
  "662",  // Saint Lucia
  "670",  // Saint Vincent ve Grenadinler

  // ── Okyanusya mikro adaları ──
  "242",  // Fiji
  "296",  // Kiribati
  "520",  // Nauru
  "583",  // Mikronezya / Micronesia
  "584",  // Marshall Adaları / Marshall Islands
  "585",  // Palau
  "776",  // Tonga
  "798",  // Tuvalu
  "882",  // Samoa
]);
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
/** RLS hardening (M2 RPC switch): tüm yazma RPC'leri claim_token istiyor.
 *  Hem misafir hem logged-in oyuncuda aynı kanıt yolu; logged-in ek olarak
 *  auth.uid() ile de yetki kazanır ama claim_token tek-tip path olarak kalır. */
const CLAIM_TOKEN_KEY = "geoquiz_wheel_duel_claim_token";

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

/** RLS hardening: her oda kuruluşunda / katılımda taze claim_token üretip
 *  localStorage'a yaz. UUID; misafir oyuncu için yegane sahiplik kanıtı,
 *  logged-in için ek yetki kanıtı. Public tabloda saklanmaz (token-only
 *  realtime'dan dışlanmış wheel_duel_player_claims'a yazılır). */
function freshClaimToken(): string {
  const tok =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(CLAIM_TOKEN_KEY, tok);
  return tok;
}

function clearWheelDuelSession() {
  localStorage.removeItem(PLAYER_ID_KEY);
  localStorage.removeItem(ROOM_KEY);
  localStorage.removeItem(CLAIM_TOKEN_KEY);
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

/** M2 RPC'lerinden dönen hata mesajlarını kullanıcı dostu Türkçe karşılıklarına
 *  çevirir. RPC'ler `raise exception 'name_taken' using errcode='P0001'` gibi
 *  açık etiketler kullanıyor; error.message bu etiketi içerir. errcode da
 *  kontrol edilir, böylece beklenmeyen mesajda generic fallback'e düşeriz. */
function describeWheelDuelRpcError(
  error: { code?: string; message?: string } | null | undefined,
): string | null {
  if (!error) return null;
  const msg = (error.message ?? "").toLowerCase();
  if (msg.includes("code_taken"))         return "Bu oda kodu az önce kullanıldı. Tekrar dene.";
  if (msg.includes("name_taken"))         return "Bu odada bu isim zaten kullanılıyor.";
  if (msg.includes("name_invalid"))       return "Oyuncu adı en az 2 karakter olmalı.";
  if (msg.includes("room_full"))          return "Oda dolu (2 oyuncu mevcut).";
  if (msg.includes("room_finished"))      return "Bu oda kapanmış.";
  if (msg.includes("room_in_progress"))   return "Maç zaten başlamış. Katılamazsın.";
  if (msg.includes("room_unavailable"))   return "Oda şu an müsait değil.";
  if (msg.includes("room_not_found"))     return "Oda bulunamadı. Kodu kontrol et.";
  if (msg.includes("room_not_waiting"))   return "Oda artık lobby fazında değil.";
  if (msg.includes("room_not_playing"))   return "Oyun durumu değişti.";
  if (msg.includes("room_not_finished"))  return "Maç henüz bitmedi.";
  if (msg.includes("not_enough_players")) return "Başlamak için 2 oyuncu lazım.";
  if (msg.includes("not_enough_votes"))   return "Yeterli oy yok.";
  if (msg.includes("profile_mismatch"))   return "Kimlik uyuşmazlığı. Lütfen yeniden gir.";
  if (msg.includes("guest_id_required"))  return "Misafir kimliği eksik.";
  if (msg.includes("claim_token_required"))
    return "Oturum bilgin eksik. Sayfayı yenileyip tekrar dene.";
  if (msg.includes("player_room_mismatch"))
    return "Bu odanın oyuncusu değilsin.";
  if (msg.includes("unauthorized"))
    return "Bu işlem için yetkin yok. Oturumun bayatlamış olabilir.";
  if (msg.includes("first_target_required") || msg.includes("target_required"))
    return "Hedef bilgisi eksik.";
  if (msg.includes("duration_invalid"))   return "Geçersiz süre.";
  if (msg.includes("region_required") || msg.includes("region_invalid"))
    return "Geçersiz bölge.";
  if (msg.includes("code_required"))      return "Oda kodu gerekli.";
  if (msg.includes("player_id_required")) return "Oyuncu kimliği eksik.";
  // Generic fallback
  return describeSupabaseError(error.code);
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

  /* ── Gameplay state ───────────────────────────────────────── */
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [wrongId, setWrongId] = useState<string | null>(null);
  const [lastClaimedTopoId, setLastClaimedTopoId] = useState<string | null>(null);
  /** Lokal "pas oyumu gönderdim" bayrağı. UI optimistic state + lost-vote
   *  auto-retry sinyali. Hedef değişince otomatik sıfırlanır. */
  const [iPressedLocally, setIPressedLocally] = useState(false);
  /** Lokal "rövanş oyumu gönderdim" bayrağı. UI optimistic + lost-vote
   *  auto-retry sinyali. status finished'dan çıkınca sıfırlanır. */
  const [iRequestedRematchLocally, setIRequestedRematchLocally] = useState(false);

  /* ── XP (sadece giriş yapmış kullanıcı için, maç başına 1 kez) ── */
  const [xpResult, setXpResult] = useState<{
    awarded:     boolean;
    xpEarned:    number;
    prevTotalXp: number;
    totalXp:     number;
    prevModeXp:  number;
    modeXp:      number;
    breakdown:   XpBreakdown;
    /** Footer'ın React `key`'i — rematch sonrası temiz mount için
     *  current_match_id kullanıyoruz (her rövanşta DB tarafında değişir). */
    roomKey:     string;
    /** Kullanıcı X'e basınca true olur. */
    dismissed:   boolean;
  } | null>(null);
  const xpAwardedRef = useRef(false);

  /* ── Quick match state ─────────────────────────────────────
   *  searching → polling RPC ile rakip arar; bracket genişler.
   *  Eşleşince RPC 'matched_room_id' UPDATE yapar (bekleyen client realtime
   *  ile yakalar) veya RPC dönüşünden caller direkt joinQuickMatchRoom çağırır.
   *  Sonra phase 'playing' olur ve room.room_source==='quick_match' +
   *  started_at gelecekte iken countdown overlay gösterilir.
   */
  const [searchSeconds,    setSearchSeconds]    = useState(0);
  const [countdownSeconds, setCountdownSeconds] = useState(0);
  const quickMatchTickRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const quickMatchSecondsRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const quickMatchStartMsRef     = useRef<number>(0);
  const quickMatchAbortRef       = useRef(false);
  const quickMatchJoinedRef      = useRef(false);  // joinQuickMatchRoom tek seferlik guard
  const quickMatchCountdownRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Identity (set fresh on create/join) ──────────────────── */
  const myIdRef = useRef<string>("");
  /** RLS hardening: M2 RPC'lerine her yazma çağrısında geçirilen sahiplik
   *  kanıtı. createRoom / joinRoomByCode / joinQuickMatchRoom yollarında
   *  taze üretilir; render boyunca ref'te tutulur. */
  const myClaimTokenRef = useRef<string>("");

  /* ── Refs for transitions / guards ────────────────────────── */
  const prevTargetRef = useRef<string | null>(null);
  const endingRef = useRef<boolean>(false);
  const wrongFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClaimedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Refs that callbacks read (avoid stale closure on room/timeLeft) ── */
  const roomRef = useRef<WheelDuelRoom | null>(null);
  const timeLeftRef = useRef<number>(0);
  const finishGameRef = useRef<((reason: "timeout" | "pool") => Promise<void>) | null>(null);

  /* ── Sound guards (countdown + result tek sefer trigger) ── */
  const countdownPlayedRef = useRef(false);
  const resultSoundPlayedRef = useRef(false);

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
    url.searchParams.delete("wheelGroup");
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

          console.log("[WD/realtime] room UPDATE", {
            status: r.status,
            started_at: r.started_at,
            current_target_topoid: r.current_target_topoid,
            finished_reason: r.finished_reason,
            winner_player_id: r.winner_player_id,
          });

          // Target transitions → green flash for last claimed
          const prev = prevTargetRef.current;
          const curr = r.current_target_topoid ?? null;
          if (prev && !curr) {
            // Round ended — capture last target for ~FEEDBACK_MS green flash
            setLastClaimedTopoId(prev);
            if (lastClaimedTimerRef.current) clearTimeout(lastClaimedTimerRef.current);
            lastClaimedTimerRef.current = setTimeout(() => {
              setLastClaimedTopoId(null);
              lastClaimedTimerRef.current = null;
            }, FEEDBACK_MS);
          } else if (curr) {
            // New target appeared — clear any stale flash
            if (lastClaimedTimerRef.current) {
              clearTimeout(lastClaimedTimerRef.current);
              lastClaimedTimerRef.current = null;
            }
            setLastClaimedTopoId(null);
          }
          prevTargetRef.current = curr;

          setRoom(r);

          if (r.status === "playing") {
            setPhase(prev => (prev === "playing" ? prev : "playing"));
          }
          if (r.status === "finished") {
            setPhase("finished");
          }
          // Rövanş reset → her iki tarafta lobby'ye dön.
          // (waiting'e başka geçiş yolu şu an yok; ileride eklenirse de güvenli.)
          if (r.status === "waiting") {
            setPhase(prev => (prev === "lobby" ? prev : "lobby"));
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
     GAMEPLAY HELPERS
  ─────────────────────────────────────────────────────────── */

  const buildTargetPool = useCallback((regionDb: string): string[] => {
    const denorm = denormalizeRegion(regionDb);
    return getFlagPool(denorm as Continent | "world", "all")
      .map(c => c.topoId)
      .filter((id): id is string => !!id)
      .filter(id => !WHEEL_DUEL_EXCLUDED_TOPOIDS.has(id));
  }, []);

  const pickNextTarget = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    if (r.status !== "playing") return;
    if (r.host_player_id !== myIdRef.current) return;
    if (r.current_target_topoid) return;

    const pool = buildTargetPool(r.region);
    const used = new Set(r.used_target_topoids ?? []);
    const remaining = pool.filter(id => !used.has(id));

    if (remaining.length === 0) {
      // Havuz tükendi → erken bitir
      await finishGameRef.current?.("pool");
      return;
    }

    const next = remaining[Math.floor(Math.random() * remaining.length)];

    // RPC server tarafında aynı atomik guard'ı uygular (status=playing +
    // current_target IS NULL). pas alanları RPC tarafından temizlenir.
    const { error } = await supabase.rpc("wheel_duel_pick_target", {
      p_room_id:        r.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    myClaimTokenRef.current,
      p_target:         next,
    });
    if (error) {
      console.error("[WheelDuel] pick_target RPC failed", error);
    }
  }, [buildTargetPool]);

  const finishGame = useCallback(async (reason: "timeout" | "pool") => {
    const r = roomRef.current;
    if (!r) return;
    if (r.host_player_id !== myIdRef.current) return;
    if (endingRef.current) return;
    endingRef.current = true;

    // RPC winner_player_id'yi server-side hesaplar; client'tan winner
    // göndermiyoruz. finished_at server now() ile yazılır.
    const { error } = await supabase.rpc("wheel_duel_finish_game", {
      p_room_id:        r.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    myClaimTokenRef.current,
      p_reason:         reason,
    });

    if (error) {
      console.error("[WheelDuel] finish_game RPC failed", error);
      endingRef.current = false;
    }
  }, []);

  const handleMapClick = useCallback(
    async (topoId: string) => {
      const r = roomRef.current;
      if (!r || r.status !== "playing") return;
      if (!r.current_target_topoid) return;
      if (timeLeftRef.current <= 0) return;
      // Quick match countdown buffer'ı içinde tıklamayı engelle.
      if (r.started_at && Date.now() < new Date(r.started_at).getTime()) return;

      if (topoId !== r.current_target_topoid) {
        // Yanlış: lokal kırmızı flash, DB yok
        playSound("wrong");
        setWrongId(topoId);
        if (wrongFlashTimerRef.current) clearTimeout(wrongFlashTimerRef.current);
        wrongFlashTimerRef.current = setTimeout(() => {
          setWrongId(null);
          wrongFlashTimerRef.current = null;
        }, WRONG_FLASH_MS);
        return;
      }

      // Doğru: atomik claim + skor artışı SERVER tarafında tek transaction'da.
      // Client skor değeri GÖNDERMEZ; server score = score + 1 uygular.
      // Yarış kaybı (rakip önce kapmış) durumunda RPC {claimed:false} döner;
      // sessiz no-op (sound çalmaz). Skor güncellemesi realtime payload'ı
      // ile zaten taşınır, ekstra select gerekmez.
      const { data, error } = await supabase.rpc("wheel_duel_claim_target", {
        p_room_id:     r.id,
        p_player_id:   myIdRef.current,
        p_claim_token: myClaimTokenRef.current,
        p_target:      topoId,
      });

      if (error) {
        console.error("[WheelDuel] claim_target RPC failed", error);
        return;
      }

      const res = (data ?? {}) as { claimed?: boolean; new_score?: number | null };
      if (!res.claimed) {
        // Yarışı kaybettin (rakip kapmış) veya hedef bayatlamış — sessizce no-op
        return;
      }

      playSound("correct");
    },
    [],
  );

  /* ── Sync refs with state ── */
  useEffect(() => { roomRef.current = room; }, [room]);
  useEffect(() => {
    timeLeftRef.current = timeLeft;
    console.log("[WD/timeLeftRef] update", { timeLeft });
  }, [timeLeft]);
  useEffect(() => { finishGameRef.current = finishGame; }, [finishGame]);

  /* ───────────────────────────────────────────────────────────
     TIMER (clients independent, anchored to room.started_at)
  ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    console.log("[WD/timer] effect run", {
      phase,
      status: room?.status,
      started_at: room?.started_at,
      duration_seconds: room?.duration_seconds,
    });

    if (phase !== "playing") {
      console.log("[WD/timer] bail: phase !== playing");
      setTimeLeft(0);
      return;
    }
    if (!room?.started_at) {
      console.log("[WD/timer] bail: no started_at");
      return;
    }

    const startMs = new Date(room.started_at).getTime();
    const duration = Number(room.duration_seconds);
    if (!(duration > 0)) {
      console.log("[WD/timer] bail: duration invalid", { duration });
      return;
    }

    let firstTickLogged = false;
    const tick = () => {
      const elapsed = (Date.now() - startMs) / 1000;
      // Quick match'te started_at = now() + 3s (gelecekte) → elapsed negatif
      // olur, raw remaining > duration olur. Min(duration) ile cap'le ki
      // countdown sırasında timer "duration" değerinde sabit gözüksün.
      const raw = duration - elapsed;
      const remaining = Math.max(0, Math.min(duration, Math.ceil(raw)));
      if (!firstTickLogged) {
        console.log("[WD/timer] tick (first)", { elapsed, remaining });
        firstTickLogged = true;
      }
      setTimeLeft(remaining);
    };

    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [phase, room?.started_at, room?.duration_seconds]);

  /* ───────────────────────────────────────────────────────────
     HOST: pick next target after FEEDBACK_MS when target=null
  ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!isHost) return;
    if (phase !== "playing") return;
    if (!room) return;
    if (room.current_target_topoid) return;
    if (timeLeft <= 0) return;

    const t = setTimeout(() => {
      pickNextTarget();
    }, FEEDBACK_MS);

    return () => clearTimeout(t);
    // deps: timeLeft ve bare `room` KASTEN dışarıda. Timer her 200ms'de
    // timeLeft'i güncellediği için bunu deps'e koyarsak setTimeout sürekli
    // iptal olur ve 1200ms hiç tamamlanmaz. room?.id + room?.current_target_topoid
    // pick döngüsü için yeterli sinyal.
  }, [isHost, phase, room?.id, room?.current_target_topoid, pickNextTarget]);

  /* ───────────────────────────────────────────────────────────
     HOST: finish on timer expiry
     ────────────────────────────────────────────────────────────
     Otorite: room.started_at + duration_seconds (DB değerleri).
     timeLeft state'ine BAĞLI DEĞİL — closure-stale ve effect-order
     race'lerinin yarattığı "timeLeft=0 + phase=playing" anlık
     tuzağı bu sayede tamamen kapanır.

     Mekanizma: effect mount olunca prerequisites'leri doğrular ve
     250ms'lik bir interval kurar. Her tick'te Date.now() vs
     started_at karşılaştırması yapılır; elapsed >= duration olunca
     finish atılır.
  ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    console.log("[WD/finish] effect run", {
      phase,
      isHost,
      status: room?.status,
      started_at: room?.started_at,
      duration_seconds: room?.duration_seconds,
      ending: endingRef.current,
    });

    if (!isHost) {
      console.log("[WD/finish] bail: not host");
      return;
    }
    if (phase !== "playing") {
      console.log("[WD/finish] bail: phase !== playing");
      return;
    }
    if (!room) {
      console.log("[WD/finish] bail: no room");
      return;
    }
    if (room.status !== "playing") {
      console.log("[WD/finish] bail: room.status !== playing");
      return;
    }
    if (!room.started_at) {
      console.log("[WD/finish] bail: no started_at");
      return;
    }
    const duration = Number(room.duration_seconds);
    if (!(duration > 0)) {
      console.log("[WD/finish] bail: duration invalid", { duration });
      return;
    }
    if (endingRef.current) {
      console.log("[WD/finish] bail: endingRef already true");
      return;
    }

    const startMs = new Date(room.started_at).getTime();
    const durationMs = duration * 1000;

    const check = () => {
      if (endingRef.current) return;
      const elapsedMs = Date.now() - startMs;
      if (elapsedMs < durationMs) return;

      console.log("[WD/finish] FINISH_TRIGGERED_TIMEOUT", {
        elapsedMs,
        durationMs,
      });
      finishGame("timeout");
    };

    // İlk anlık check — yeni başlayan oyunda elapsed≈0 < duration, no-op.
    // Sayfa F5'le geri gelinmiş ve süre çoktan geçtiyse burada anında fire.
    check();
    const id = setInterval(check, 250);
    return () => clearInterval(id);
  }, [
    isHost,
    phase,
    room?.id,
    room?.status,
    room?.started_at,
    room?.duration_seconds,
    finishGame,
  ]);

  /* ───────────────────────────────────────────────────────────
     SES — geri sayım (last10 / last20 ayarına bağlı, diğer
     modlardaki guard mantığı). Genel Ses kapalıysa playSound
     zaten erkenden return ediyor.
  ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (phase !== "playing") {
      countdownPlayedRef.current = false;
      stopSound("countdown20");
      return;
    }

    const mode = getCountdownSoundMode();
    const limit = mode === "last20" ? 20 : mode === "last10" ? 10 : 0;
    const durationSeconds = Number(room?.duration_seconds ?? 0);

    if (limit === 0 || durationSeconds <= limit) {
      countdownPlayedRef.current = false;
      stopSound("countdown20");
      return;
    }

    if (!shouldPlayCountdownSound(timeLeft, mode)) {
      countdownPlayedRef.current = false;
      stopSound("countdown20");
      return;
    }

    if (timeLeft > 0 && !countdownPlayedRef.current) {
      countdownPlayedRef.current = true;
      playSound("countdown20");
    }

    if (timeLeft <= 0) {
      stopSound("countdown20");
    }
  }, [phase, timeLeft, room?.duration_seconds]);

  /* ── Unmount: countdown sesini garanti durdur ── */
  useEffect(() => {
    return () => {
      stopSound("countdown20");
    };
  }, []);

  /* ───────────────────────────────────────────────────────────
     SES — sonuç ekranı (win/lose tek sefer). Berabere'de hiç
     çalma (diğer modlarla aynı).
  ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (phase !== "finished" || !room) {
      resultSoundPlayedRef.current = false;
      return;
    }
    if (resultSoundPlayedRef.current) return;
    resultSoundPlayedRef.current = true;

    const winnerId = room.winner_player_id;
    const iWon = !!winnerId && winnerId === myIdRef.current;
    const isTie = !winnerId;

    if (iWon) {
      playSound("win", { restart: true });
    } else if (!isTie) {
      playSound("lose", { restart: true });
    }
  }, [phase, room?.winner_player_id, room]);

  /* ───────────────────────────────────────────────────────────
     XP — oyun bitince bir kez yaz (sadece giriş yapmış kullanıcı)
     Genel XP + mod XP ("wheel_duel") aynı RPC çağrısında işlenir.
     Idempotency anahtarı: room.current_match_id (rövanşta yenilenir).
  ─────────────────────────────────────────────────────────── */
  const isLoggedInPlayer = !!profile?.username;
  useEffect(() => {
    if (phase !== "finished" || !room) return;
    if (xpAwardedRef.current) return;
    if (!isLoggedInPlayer || !profile?.id) return;
    if (!room.current_match_id) return;

    const me  = players.find(p => p.id === myIdRef.current);
    const opp = players.find(p => p.id !== myIdRef.current);
    if (!me) return;

    const myScoreFinal  = me.score  ?? 0;
    const oppScoreFinal = opp?.score ?? 0;

    // winner_player_id finishGame içinde yazılıyor; daha güvenilir kaynak.
    // Yoksa skor karşılaştırmasına düşeriz (savunma).
    const winnerId = room.winner_player_id;
    const matchResult =
      winnerId === null || winnerId === undefined
        ? resultFromScores(myScoreFinal, oppScoreFinal)
        : winnerId === myIdRef.current
          ? "win"
          : "loss";

    xpAwardedRef.current = true;

    const breakdown = calculateWheelDuelXp({
      correctCount: myScoreFinal,
      result: matchResult,
    });

    const profileId = profile.id;
    const matchId   = room.current_match_id;
    const realRoomId = room.id;

    (async () => {
      const res = await awardXpEvent({
        profileId,
        modeKey:  "wheel_duel",
        roomId:   matchId,
        xpEarned: breakdown.total,
        result:   matchResult,
        details: {
          my_score:        myScoreFinal,
          opp_score:       oppScoreFinal,
          breakdown,
          real_room_id:    realRoomId,
          match_seq:       room.match_seq,
          finished_reason: room.finished_reason,
          region:          room.region,
          duration_seconds: room.duration_seconds,
        },
      });

      if (res.error) {
        xpAwardedRef.current = false;
        console.error("[WheelDuel] XP yazılamadı:", res.error);
        return;
      }

      // prev değerlerini RPC dönüşünden geriye türet (snapshot güvensiz).
      const prevModeXp  = res.awarded ? Math.max(0, res.modeXp  - res.xpEarned) : res.modeXp;
      const prevTotalXp = res.awarded ? Math.max(0, res.totalXp - res.xpEarned) : res.totalXp;

      setXpResult({
        awarded:     res.awarded,
        xpEarned:    res.xpEarned,
        prevTotalXp,
        totalXp:     res.totalXp,
        prevModeXp,
        modeXp:      res.modeXp,
        breakdown,
        roomKey:     matchId,
        dismissed:   false,
      });
    })();
  }, [
    phase,
    room,
    players,
    isLoggedInPlayer,
    profile?.id,
  ]);

  /* ── XP barı: kazandın/kaybettin sesi başladıktan sonra ekrana çıkar ── */
  const [xpFooterVisible, setXpFooterVisible] = useState(false);
  useEffect(() => {
    if (!xpResult) {
      setXpFooterVisible(false);
      return;
    }
    const t = setTimeout(() => setXpFooterVisible(true), 1200);
    return () => clearTimeout(t);
  }, [xpResult]);

  /* ── Status finished'dan çıkışta XP state'ini sıfırla (yeni maça hazırlık) ── */
  useEffect(() => {
    if (room?.status !== "finished") {
      setXpResult(null);
      xpAwardedRef.current = false;
    }
  }, [room?.status]);

  /* ───────────────────────────────────────────────────────────
     PAS GEÇ — request + host-side skip processor
  ─────────────────────────────────────────────────────────── */

  /** Mevcut hedef için pas oyumu DB'ye yaz. Idempotent (ben zaten oy
   *  verdiysem no-op). Hedef değişmediyse yazılır (atomic guard).
   *  iPressedLocally = lokal UI optimistic ve aynı zamanda
   *  "oyum DB'de yoksa tekrar gönder" auto-retry sinyali. */
  const requestPass = useCallback(async () => {
    const r = roomRef.current;
    if (!r || !r.current_target_topoid) return;
    if (r.status !== "playing") return;
    const myId = myIdRef.current;
    const target = r.current_target_topoid;

    const existing =
      r.pass_target_topoid === target ? r.pass_requested_by ?? [] : [];
    if (existing.includes(myId)) {
      // Zaten DB'de oyum var; lokal bayrağı da senkronla
      setIPressedLocally(true);
      return;
    }

    setIPressedLocally(true);

    // RPC idempotent: aynı oyuncudan ikinci çağrı no-op; bayat hedef için
    // sessiz no-op (WHERE current_target_topoid = p_target guard'ı tutmaz).
    const { error } = await supabase.rpc("wheel_duel_request_pass", {
      p_room_id:     r.id,
      p_player_id:   myId,
      p_claim_token: myClaimTokenRef.current,
      p_target:      target,
    });

    if (error) {
      console.error("[WheelDuel] request_pass RPC failed", error);
    }
  }, []);

  /** Sadece host. İki oy toplandığında atomik skip UPDATE'i atar:
   *   current_target_topoid = null (mevcut pick-next-target effect 1.2s
   *   sonra yeni hedefi seçer)
   *   used_target_topoids   += skipped target
   *   pass_*                = reset
   *  .eq("current_target_topoid", target) guard'ı double-fire'ı engeller. */
  const processSkip = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    if (r.host_player_id !== myIdRef.current) return;
    if (r.status !== "playing") return;
    if (!r.current_target_topoid) return;
    if (r.pass_target_topoid !== r.current_target_topoid) return;
    if ((r.pass_requested_by ?? []).length < 2) return;

    // RPC server tarafında ≥2 oy + target eşleşmesi guard'ını tekrar uygular;
    // çakışan ikinci tetiklemede sessiz no-op olur.
    const { error } = await supabase.rpc("wheel_duel_process_skip", {
      p_room_id:        r.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    myClaimTokenRef.current,
    });

    if (error) {
      console.error("[WheelDuel] process_skip RPC failed", error);
    }
  }, []);

  /* Hedef değişince lokal "ben bastım" sıfırla */
  useEffect(() => {
    setIPressedLocally(false);
  }, [room?.current_target_topoid]);

  /* Lost-vote auto-retry: lokal olarak bastığımı düşünüyorum ama DB'de
   * oyum yoksa (last-write-wins race), yeniden gönder. */
  useEffect(() => {
    if (!iPressedLocally) return;
    if (!room?.current_target_topoid) return;
    const myId = myIdRef.current;
    const matchesTarget =
      room.pass_target_topoid === room.current_target_topoid;
    const myVoteInDb =
      matchesTarget && (room.pass_requested_by ?? []).includes(myId);
    if (myVoteInDb) return;
    // Oy kayboldu → yeniden gönder. requestPass kendi idempotent guard'ına
    // sahip; sonsuz döngü riski yok.
    requestPass();
  }, [
    iPressedLocally,
    room?.pass_requested_by,
    room?.pass_target_topoid,
    room?.current_target_topoid,
    requestPass,
  ]);

  /* Host: iki oy toplandıysa skip'i tetikle */
  useEffect(() => {
    if (!isHost) return;
    if (phase !== "playing") return;
    if (!room?.current_target_topoid) return;
    if (room.pass_target_topoid !== room.current_target_topoid) return;
    if ((room.pass_requested_by ?? []).length < 2) return;
    processSkip();
  }, [
    isHost,
    phase,
    room?.current_target_topoid,
    room?.pass_target_topoid,
    room?.pass_requested_by?.length,
    processSkip,
    room?.pass_requested_by,
  ]);

  /* ───────────────────────────────────────────────────────────
     RÖVANŞ — request + host-side reset processor
  ─────────────────────────────────────────────────────────── */

  /** Sonuç ekranında "Rövanş İste" / "Kabul Et" tıklaması. Idempotent:
   *  Zaten oyum varsa no-op. Status 'finished' guard'ı stale-status
   *  korumasıdır (host arada reset atmışsa UPDATE silently no-op olur). */
  const requestRematch = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    if (r.status !== "finished") return;
    const myId = myIdRef.current;

    const existing = r.rematch_requested_by ?? [];
    if (existing.includes(myId)) {
      setIRequestedRematchLocally(true);
      return;
    }

    setIRequestedRematchLocally(true);

    // RPC idempotent + status='finished' guard içeride.
    const { error } = await supabase.rpc("wheel_duel_request_rematch", {
      p_room_id:     r.id,
      p_player_id:   myId,
      p_claim_token: myClaimTokenRef.current,
    });

    if (error) {
      console.error("[WheelDuel] request_rematch RPC failed", error);
    }
  }, []);

  /** Sadece host. İki rövanş oyu toplandığında atomik reset:
   *   1) wheel_duel_players.score = 0  (room_id eşleşen tüm satırlar)
   *   2) wheel_duel_rooms UPDATE: status='waiting' + tüm gameplay alanlarını
   *      sıfırla (started_at, finished_*, winner, target, used, pass_*,
   *      rematch_*). Guard: .eq("status","finished") → double-reset no-op. */
  const processRematch = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    if (r.host_player_id !== myIdRef.current) return;
    if (r.status !== "finished") return;
    if ((r.rematch_requested_by ?? []).length < 2) return;

    // RPC: skor reset + room reset tek transaction'da.
    // match_seq +1 ve current_match_id = gen_random_uuid() SERVER-SIDE
    // üretilir (XP idempotency anahtarı manipülasyona kapatılır).
    const { error } = await supabase.rpc("wheel_duel_process_rematch", {
      p_room_id:        r.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    myClaimTokenRef.current,
    });

    if (error) {
      console.error("[WheelDuel] process_rematch RPC failed", error);
    }
  }, []);

  /* Status finished'dan çıkışta lokal oy bayrağını sıfırla. Yeni maçta
   * eski rövanş niyetinin yanlışlıkla auto-retry'a yol açmasını önler. */
  useEffect(() => {
    if (room?.status !== "finished") {
      setIRequestedRematchLocally(false);
    }
  }, [room?.status]);

  /* Lost-vote auto-retry: lokal olarak oyladığımı düşünüyorum ama DB'de
   * oyum yoksa (last-write-wins race), yeniden gönder. requestRematch
   * idempotent — sonsuz döngü riski yok. */
  useEffect(() => {
    if (!iRequestedRematchLocally) return;
    if (room?.status !== "finished") return;
    const myId = myIdRef.current;
    if ((room.rematch_requested_by ?? []).includes(myId)) return;
    requestRematch();
  }, [
    iRequestedRematchLocally,
    room?.status,
    room?.rematch_requested_by,
    requestRematch,
  ]);

  /* Host: iki rövanş oyu toplandıysa atomik reset'i tetikle */
  useEffect(() => {
    if (!isHost) return;
    if (room?.status !== "finished") return;
    if ((room.rematch_requested_by ?? []).length < 2) return;
    processRematch();
  }, [
    isHost,
    room?.status,
    room?.rematch_requested_by?.length,
    room?.rematch_requested_by,
    processRematch,
  ]);

  /* ───────────────────────────────────────────────────────────
     QUICK MATCH — startQuickMatch / cancelQuickMatch / join
  ─────────────────────────────────────────────────────────── */

  /** RPC dönüşünden veya realtime UPDATE'inden sonra çağrılır.
   *  Odayı + iki player'ı yükler, lokal state'i set eder, phase 'playing'.
   *  Tek seferlik: quickMatchJoinedRef ile guard'lı (caller hem RPC dönüşünde
   *  hem realtime'da yarış halinde olabilir; ikincisi no-op olur). */
  const joinQuickMatchRoom = useCallback(
    async (roomId: string, playerId: string, opponentName?: string) => {
      if (quickMatchJoinedRef.current) return;
      quickMatchJoinedRef.current = true;

      // Polling/heartbeat'i durdur
      if (quickMatchTickRef.current) {
        clearInterval(quickMatchTickRef.current);
        quickMatchTickRef.current = null;
      }
      if (quickMatchSecondsRef.current) {
        clearInterval(quickMatchSecondsRef.current);
        quickMatchSecondsRef.current = null;
      }
      quickMatchAbortRef.current = true;  // dönmemiş RPC response'larını yut

      myIdRef.current = playerId;

      // ── RLS hardening: claim_token enjeksiyonu ──────────────────────────
      // wheel_duel_quick_match RPC'sine imza değişikliği yapmadık; player
      // satırını o RPC ekledi ama wheel_duel_player_claims'a token yazılmadı.
      // M2 RPC'leri (pass/claim/rematch/leave) claim_token istiyor, bu yüzden
      // burada taze bir token üretip claims tablosuna INSERT ediyoruz. Bu
      // INSERT anon/authenticated için açık (M1 policy). Best-effort: hata
      // verirse pas/claim akışları "unauthorized" yer; quick match yine
      // çalışır ama gameplay bozulur → log + UI mesajı.
      const quickMatchClaimToken = freshClaimToken();
      myClaimTokenRef.current = quickMatchClaimToken;
      const { error: claimErr } = await supabase
        .from("wheel_duel_player_claims")
        .insert({ player_id: playerId, claim_token: quickMatchClaimToken });
      if (claimErr) {
        console.error("[WheelDuel] quick-match claim insert failed", claimErr);
        setErrorMsg(
          "Oturum güvenlik kaydı yazılamadı. Maç devam etse de bazı işlemler hata verebilir.",
        );
      }

      const { data: roomData, error: roomErr } = await supabase
        .from("wheel_duel_rooms")
        .select("*")
        .eq("id", roomId)
        .maybeSingle();

      if (roomErr || !roomData) {
        console.error("[WheelDuel] joinQuickMatchRoom: room fetch failed", roomErr);
        // Soft fallback: searching ekranına dön
        quickMatchJoinedRef.current = false;
        setErrorMsg("Eşleşilen oda bulunamadı, tekrar dene.");
        setPhase("setup");
        return;
      }

      const { data: ps } = await supabase
        .from("wheel_duel_players")
        .select("*")
        .eq("room_id", roomId)
        .order("joined_at", { ascending: true });

      const room = roomData as WheelDuelRoom;
      setRoom(room);
      setPlayers((ps ?? []) as WheelDuelPlayer[]);
      saveRoomSession(room.id, room.code, playerId);

      // Quick match countdown başlat (started_at - now() fark)
      const startMs = room.started_at ? new Date(room.started_at).getTime() : 0;
      const now = Date.now();
      const remainMs = Math.max(0, startMs - now);
      setCountdownSeconds(Math.ceil(remainMs / 1000));

      if (quickMatchCountdownRef.current) {
        clearInterval(quickMatchCountdownRef.current);
        quickMatchCountdownRef.current = null;
      }
      if (remainMs > 0) {
        const tick = () => {
          const r = Math.max(0, startMs - Date.now());
          setCountdownSeconds(Math.ceil(r / 1000));
          if (r <= 0 && quickMatchCountdownRef.current) {
            clearInterval(quickMatchCountdownRef.current);
            quickMatchCountdownRef.current = null;
          }
        };
        quickMatchCountdownRef.current = setInterval(tick, 200);
      }

      // Opponent name UI'da küçük "Rakip bulundu: X" satırı için
      if (opponentName) {
        setStatusMsg(`Rakip bulundu: ${opponentName}`);
      } else {
        setStatusMsg(null);
      }
      setErrorMsg(null);
      setPhase("playing");
    },
    [],
  );

  /** Polling tick — RPC çağrısı, eşleşme bulunursa joinQuickMatchRoom. */
  const quickMatchTick = useCallback(async () => {
    if (quickMatchAbortRef.current) return;
    if (!profile?.id) return;

    const myProfileId = profile.id;

    // ── SELECT-first guard ──────────────────────────────────────
    // Realtime UPDATE event'i jitter/lag ile gecikebilir VE bu RPC
    // çağrısının UPSERT'ü matched_room_id'yi NULL'a çekiyor (caller
    // path için doğru, bekleyen path için yan etki). Bu yüzden RPC'den
    // önce kendi queue satırımı doğrudan SELECT edip matched_room_id
    // doluysa UPSERT'e hiç girmeden join'e geçiyoruz.
    const { data: selfRow } = await supabase
      .from("wheel_duel_queue")
      .select("matched_room_id, player_id")
      .eq("profile_id", myProfileId)
      .maybeSingle();

    if (quickMatchAbortRef.current) return;

    if (selfRow?.matched_room_id && selfRow.player_id) {
      console.log("[WD/quick-match] SELECT fallback matched", {
        room_id: selfRow.matched_room_id,
      });
      await joinQuickMatchRoom(selfRow.matched_room_id, selfRow.player_id);
      return;
    }
    // ────────────────────────────────────────────────────────────

    const elapsed = Math.floor((Date.now() - quickMatchStartMsRef.current) / 1000);
    const bracket = quickMatchBracket(elapsed);
    const myPlayerId  = myIdRef.current;
    const myName      = (profile.username ?? "").trim();
    const code        = generateRoomCode();
    const pool        = buildTargetPool(normalizeRegion(hostRegion));
    if (pool.length === 0) {
      setErrorMsg("Bu bölge için hedef havuzu boş.");
      cancelQuickMatchRef.current?.();
      return;
    }
    const firstTarget = pool[Math.floor(Math.random() * pool.length)];

    const { data, error } = await supabase.rpc("wheel_duel_quick_match", {
      p_profile_id:     myProfileId,
      p_player_id:      myPlayerId,
      p_player_name:    myName,
      p_duration:       hostDuration,
      p_region:         normalizeRegion(hostRegion),
      p_max_level_diff: bracket,
      p_room_code:      code,
      p_first_target:   firstTarget,
    });

    if (quickMatchAbortRef.current) return;

    if (error) {
      console.error("[WheelDuel] quick_match RPC error:", error);
      // Auth/validation hatası: aramayı durdur ve mesaj göster.
      setErrorMsg("Hızlı eşleş hatası: " + (error.message ?? "Bilinmeyen"));
      cancelQuickMatchRef.current?.();
      return;
    }

    const res = data as {
      matched:          boolean;
      room_id?:         string;
      my_player_id?:    string;
      opponent_name?:   string;
      search_age_seconds?: number;
    };

    if (res?.matched && res.room_id && res.my_player_id) {
      await joinQuickMatchRoom(res.room_id, res.my_player_id, res.opponent_name);
      return;
    }

    // Henüz eşleşme yok — searchSeconds zaten ayrı interval ile artıyor.
  }, [
    profile?.id,
    profile?.username,
    hostDuration,
    hostRegion,
    buildTargetPool,
    joinQuickMatchRoom,
  ]);

  // Forward ref pattern: quickMatchTick içinden cancel'a erişim için.
  const cancelQuickMatchRef = useRef<(() => void) | null>(null);

  const cancelQuickMatch = useCallback(async () => {
    quickMatchAbortRef.current = true;

    if (quickMatchTickRef.current) {
      clearInterval(quickMatchTickRef.current);
      quickMatchTickRef.current = null;
    }
    if (quickMatchSecondsRef.current) {
      clearInterval(quickMatchSecondsRef.current);
      quickMatchSecondsRef.current = null;
    }

    setSearchSeconds(0);
    setStatusMsg(null);
    setPhase("setup");

    if (profile?.id) {
      try {
        await supabase.rpc("wheel_duel_cancel_quick_match", {
          p_profile_id: profile.id,
        });
      } catch (e) {
        console.warn("[WheelDuel] cancel_quick_match RPC failed", e);
      }
    }
  }, [profile?.id]);

  useEffect(() => {
    cancelQuickMatchRef.current = cancelQuickMatch;
  }, [cancelQuickMatch]);

  const startQuickMatch = useCallback(async () => {
    playSound("click");
    setErrorMsg(null);
    setHostClosedRoom(false);

    if (!profile?.id || !profile.username) {
      setErrorMsg("Hızlı eşleş için giriş gerekli.");
      return;
    }

    // Quick match identity: her aramada fresh player UUID.
    clearWheelDuelSession();
    const freshId = freshPlayerId();
    myIdRef.current = freshId;

    // Reset guards & timers
    quickMatchAbortRef.current  = false;
    quickMatchJoinedRef.current = false;
    quickMatchStartMsRef.current = Date.now();
    setSearchSeconds(0);
    setCountdownSeconds(0);
    setPhase("searching");

    // Saniye sayacı (UI display + bracket)
    quickMatchSecondsRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - quickMatchStartMsRef.current) / 1000);
      setSearchSeconds(s);
    }, 1000);

    // İlk RPC çağrısı + 3sn'lik polling
    await quickMatchTick();
    quickMatchTickRef.current = setInterval(() => {
      quickMatchTick();
    }, QUICK_MATCH_TICK_MS);
  }, [profile?.id, profile?.username, quickMatchTick]);

  /* Realtime: bekleyen oyuncu kendi queue satırının matched_room_id
     UPDATE'ini dinler. Caller RPC dönüşünde direkt join eder, listener
     yine de güvenlik ağı olarak çalışır (no-op çünkü join guard'lı). */
  useEffect(() => {
    if (phase !== "searching") return;
    if (!profile?.id) return;

    const myProfileId = profile.id;
    const chan = supabase
      .channel(`wheel-duel-queue:${myProfileId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "wheel_duel_queue",
          filter: `profile_id=eq.${myProfileId}`,
        },
        payload => {
          const row = payload.new as {
            matched_room_id: string | null;
            player_id:       string;
          };
          console.log("[WD/queue-rt] UPDATE", {
            matched_room_id: row.matched_room_id,
          });
          if (!row.matched_room_id) return;
          if (quickMatchJoinedRef.current) return;
          // Bekleyen tarafıyız — opponent_name elimizde yok, join sonrası
          // players listesinden çıkarılır (statusMsg'a yazılmasa da olur).
          joinQuickMatchRoom(row.matched_room_id, row.player_id);
        },
      )
      .subscribe(status => {
        console.log("[WD/queue-rt] subscribe status:", status);
      });

    return () => {
      supabase.removeChannel(chan);
    };
  }, [phase, profile?.id, joinQuickMatchRoom]);

  /* Component unmount'ta searching state'inde isek queue satırını temizle. */
  useEffect(() => {
    return () => {
      if (quickMatchTickRef.current) clearInterval(quickMatchTickRef.current);
      if (quickMatchSecondsRef.current) clearInterval(quickMatchSecondsRef.current);
      if (quickMatchCountdownRef.current) clearInterval(quickMatchCountdownRef.current);
      // Best-effort cleanup; cancelQuickMatch async ama unmount'ta beklemeyiz.
      if (profile?.id && !quickMatchJoinedRef.current) {
        supabase.rpc("wheel_duel_cancel_quick_match", {
          p_profile_id: profile.id,
        }).then(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const claimToken = freshClaimToken();
    myIdRef.current = freshId;
    myClaimTokenRef.current = claimToken;

    const code = generateRoomCode();
    const trimmedName = playerName.trim();
    const profileId = profile?.id ?? null;
    // Misafir için guest_id = freshId (stable per-session anchor); logged-in
    // tarafta NULL bırakılır, server profile_id = auth.uid() kontrolü yapar.
    const guestId = profileId ? null : freshId;

    // Tek RPC: oda + host player + claim transaction'da.
    const { data: roomData, error: roomErr } = await supabase.rpc(
      "wheel_duel_create_room",
      {
        p_player_id:   freshId,
        p_profile_id:  profileId,
        p_guest_id:    guestId,
        p_name:        trimmedName,
        p_code:        code,
        p_duration:    hostDuration,
        p_region:      normalizeRegion(hostRegion),
        p_claim_token: claimToken,
      },
    );

    if (roomErr || !roomData?.id) {
      const friendly =
        describeWheelDuelRpcError(roomErr) ??
        "Oda oluşturulamadı. Bağlantıyı kontrol et.";
      setErrorMsg(friendly);
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    const createdRoom = roomData as WheelDuelRoom;

    // İlk player listesini çek (realtime devreye girene kadar UI hazır olsun)
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
    const claimToken = freshClaimToken();
    myIdRef.current = freshId;
    myClaimTokenRef.current = claimToken;

    const trimmedName = playerName.trim();
    const profileId = profile?.id ?? null;
    const guestId = profileId ? null : freshId;

    // RPC tek atışta: oda lookup + status/kapasite/isim çakışması check +
    // player insert + claim insert. for update ile race-safe kapasite.
    const { data: roomData, error: joinErr } = await supabase.rpc(
      "wheel_duel_join_room",
      {
        p_code:        normalized,
        p_player_id:   freshId,
        p_profile_id:  profileId,
        p_guest_id:    guestId,
        p_name:        trimmedName,
        p_claim_token: claimToken,
      },
    );

    if (joinErr || !roomData?.id) {
      const friendly =
        describeWheelDuelRpcError(joinErr) ?? "Odaya katılınamadı.";
      setErrorMsg(friendly);
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    const targetRoom = roomData as WheelDuelRoom;

    // Player listesini çek (realtime devreye girene kadar UI hazır olsun)
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
    const currentClaim = myClaimTokenRef.current;

    // UI önce sıfırlansın — DB silinmesini beklemeden setup'a dönelim
    setRoom(null);
    setPlayers([]);
    setCopied(false);
    setErrorMsg(null);
    setStatusMsg(null);
    setPhase("setup");
    setTimeLeft(0);
    setWrongId(null);
    setLastClaimedTopoId(null);
    setIPressedLocally(false);
    setXpResult(null);
    xpAwardedRef.current = false;
    endingRef.current = false;
    prevTargetRef.current = null;

    // Quick match guard ve countdown timer reset (tek shot olsa bile temiz çıkış)
    quickMatchJoinedRef.current = false;
    setCountdownSeconds(0);
    if (quickMatchCountdownRef.current) {
      clearInterval(quickMatchCountdownRef.current);
      quickMatchCountdownRef.current = null;
    }
    if (wrongFlashTimerRef.current) {
      clearTimeout(wrongFlashTimerRef.current);
      wrongFlashTimerRef.current = null;
    }
    if (lastClaimedTimerRef.current) {
      clearTimeout(lastClaimedTimerRef.current);
      lastClaimedTimerRef.current = null;
    }
    clearWheelDuelSession();

    if (!currentRoom) return;

    // RPC host/non-host ayrımını server'da yapar. Host ise oda DELETE
    // (cascade ile players + claims temizlenir); değilse kendi player satırı.
    // Idempotent: oda yoksa sessiz no-op.
    const { error } = await supabase.rpc("wheel_duel_leave_room", {
      p_room_id:     currentRoom.id,
      p_player_id:   currentMyId,
      p_claim_token: currentClaim,
    });
    if (error) {
      console.error("[WheelDuel] leave_room RPC failed", error);
    }
  }

  async function startGame() {
    playSound("click");
    if (!room || !isHost) return;
    if (players.length < 2) return;

    // İlk hedefi host burada seçer; gameplay UPDATE'i status + started_at + ilk
    // target'ı tek atışta yazar, böylece her iki client da aynı anda görür.
    const pool = buildTargetPool(room.region);
    if (pool.length === 0) {
      setErrorMsg("Bu bölge için hedef havuzu boş.");
      return;
    }
    const firstTarget = pool[Math.floor(Math.random() * pool.length)];
    const startedAt = new Date().toISOString();

    // Reset gameplay refs for a fresh round
    endingRef.current = false;
    prevTargetRef.current = firstTarget;  // realtime UPDATE'in lastClaimed
                                          // false-positive ihtimalini önler
    setLastClaimedTopoId(null);
    setWrongId(null);

    console.log("[WD/startGame] before update", {
      roomId: room.id,
      firstTarget,
      duration_seconds: hostDuration,
      hostId: myIdRef.current,
      isHost,
    });

    // setPhase("playing") burada ÇAĞIRMIYORUZ. RPC dönüp room.started_at
    // lokal state'e oturduktan sonra phase'i flip ediyoruz; aksi halde
    // "phase=playing + room.started_at=null" tek render bile finish effect'in
    // anında tetiklenmesine yol açıyor.
    // Not: started_at değeri RPC tarafında server now() ile yazılır;
    // client'ın gönderdiği startedAt artık kullanılmıyor (clock-skew kapanır).
    const { data: updated, error } = await supabase.rpc(
      "wheel_duel_start_game",
      {
        p_room_id:        room.id,
        p_host_player_id: myIdRef.current,
        p_claim_token:    myClaimTokenRef.current,
        p_first_target:   firstTarget,
      },
    );

    console.log("[WD/startGame] update result", { error, updated, startedAt });

    if (error || !updated) {
      setErrorMsg(
        describeWheelDuelRpcError(error) ?? "Oyun başlatılamadı. Tekrar dene.",
      );
      return;
    }

    const updatedRoom = updated as WheelDuelRoom;
    console.log("[WD/startGame] state set", {
      updatedStatus:    updatedRoom.status,
      updatedStartedAt: updatedRoom.started_at,
      updatedDuration:  updatedRoom.duration_seconds,
      updatedTarget:    updatedRoom.current_target_topoid,
    });

    setRoom(updatedRoom);  // started_at + status dolu satır
    setPhase("playing");   // güvenli: room artık tutarlı
  }

  async function updateHostSetting(
    next: { duration_seconds?: number; region?: string },
  ) {
    if (!room || !isHost) return;

    // Optimistic
    setRoom(prev => (prev ? { ...prev, ...next } : prev));

    // RPC partial update: dokunulmayan alana NULL geçilir → coalesce ile
    // mevcut değer korunur. RPC tarafında status='waiting' guard'ı uygulanır.
    const { error } = await supabase.rpc("wheel_duel_update_settings", {
      p_room_id:        room.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    myClaimTokenRef.current,
      p_duration:       next.duration_seconds ?? null,
      p_region:         next.region ?? null,
    });

    if (error) {
      // Rollback'i realtime echo'ya bırakıyoruz; en kötü ihtimal eski değer geri gelir
      console.error("[WheelDuel] update_settings RPC failed", error);
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

  const homeTheme = readStoredHomeTheme();
  const isPreGamePhase = phase !== "playing" && phase !== "finished";
  const themeBgStyle = isPreGamePhase ? getThemeBackgroundStyle(homeTheme) : undefined;
  const themeDataAttr = isPreGamePhase ? getThemeDataAttr(homeTheme) : undefined;

  return (
    <div className="app duel-screen" style={themeBgStyle} data-theme={themeDataAttr}>
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
              Odanı kur, kodu arkadaşına gönder. Çarkın seçtiği ülkeyi haritada ilk bulan puanı kapar.
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
            {!profile?.username ? (
              <button
                className="btn duel-quickmatch-btn"
                disabled
                title="Hızlı eşleş için giriş gerekli"
              >
                ⚡ Hızlı Eşleş{" "}
                <span style={{ opacity: 0.65 }}>(Giriş Gerekli)</span>
              </button>
            ) : (
              <button
                className="btn btn-accent duel-quickmatch-btn"
                onClick={startQuickMatch}
                disabled={phase === "creating"}
                title="Aynı süre + bölge seçen biriyle otomatik eşleş"
              >
                ⚡ Hızlı Eşleş
              </button>
            )}

            {errorMsg && <p className="duel-error">{errorMsg}</p>}
            {statusMsg && phase === "creating" && !errorMsg && (
              <p className="duel-status">{statusMsg}</p>
            )}
          </div>
        </div>
      )}

      {/* ════════ SEARCHING (Quick Match) ════════ */}
      {phase === "searching" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card" style={{ textAlign: "center" }}>
            <h2 className="duel-lobby-title">⚡ Hızlı Eşleş</h2>
            <p className="duel-lobby-desc">
              Aynı süre ve bölgeyi seçen, seviyene yakın bir rakip aranıyor…
            </p>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                margin: "16px 0",
                fontSize: 14,
              }}
            >
              <div>
                <strong>Süre:</strong> {durationLabel(hostDuration)}{" "}
                <span style={{ opacity: 0.5 }}>·</span>{" "}
                <strong>Bölge:</strong>{" "}
                {regionLabel(normalizeRegion(hostRegion))}
              </div>
              <div style={{ opacity: 0.85 }}>
                Bekleme: {Math.floor(searchSeconds / 60)}:
                {String(searchSeconds % 60).padStart(2, "0")}
                <span style={{ opacity: 0.5 }}> · </span>
                Aralık:{" "}
                {(() => {
                  const b = quickMatchBracket(searchSeconds);
                  return b >= 9999 ? "her seviye" : `±${b} lv`;
                })()}
              </div>
            </div>

            <div
              style={{
                fontSize: 36,
                margin: "8px 0 16px",
                animation: "wd-spin 1.4s linear infinite",
                display: "inline-block",
              }}
            >
              🎯
            </div>

            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                playSound("click");
                cancelQuickMatch();
              }}
            >
              ✕ Aramayı İptal Et
            </button>

            {errorMsg && (
              <p className="duel-error" style={{ marginTop: 12 }}>
                {errorMsg}
              </p>
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

      {/* ════════ PLAYING (finished'da da render — arka plan blur'lansın) ════════ */}
      {(phase === "playing" || phase === "finished") && room && (() => {
        const me = players.find(p => p.id === myIdRef.current);
        const opp = players.find(p => p.id !== myIdRef.current);
        const myScore = me?.score ?? 0;
        const oppScore = opp?.score ?? 0;
        const currentTarget = room.current_target_topoid;
        const targetDisplay = currentTarget
          ? TOPOID_TO_DISPLAY[currentTarget] ?? currentTarget
          : null;
        const lastClaimDisplay = lastClaimedTopoId
          ? TOPOID_TO_DISPLAY[lastClaimedTopoId] ?? lastClaimedTopoId
          : null;
        const regionDenorm = denormalizeRegion(room.region);
        const activeIds =
          regionDenorm === "world"
            ? new Set<string>()  // empty = no filter (WorldMap treats this as fit-all)
            : getContinentIds(regionDenorm as Continent);
        // For region=world we want all countries clickable. WorldMap uses
        // activeIds.has(...) for in-scope check, so build full set from pool.
        const clickableIds =
          regionDenorm === "world"
            ? new Set(buildTargetPool("world"))
            : activeIds;
        const usedSet = new Set(room.used_target_topoids ?? []);
        // Timer color (visual nudge near time-out)
        const timerColor =
          timeLeft <= 5 ? "var(--red, #e25555)"
          : timeLeft <= 15 ? "var(--amber, #d4a02c)"
          : "var(--accent, #4f8bff)";

        return (
          <div className="wd-screen">
            {/* HUD top bar */}
            <div className="wd-hud">
              <button
                className="back-btn wd-hud-back"
                onClick={() => {
                  playSound("click");
                  leaveRoom();
                }}
                title="Lobiden Çık"
              >
                <span>←</span>
                <span className="back-label">Çık</span>
              </button>

              <div className="wd-hud-center">
                {targetDisplay ? (
                  <>
                    <div className="wd-hud-label">🎯 Hedef</div>
                    <div className="wd-target">{targetDisplay}</div>
                  </>
                ) : lastClaimDisplay ? (
                  <>
                    <div className="wd-hud-label">✓ Doğru</div>
                    <div className="wd-target wd-target-claimed">
                      {lastClaimDisplay}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="wd-hud-label">…</div>
                    <div className="wd-target wd-target-muted">
                      Sıradaki hedef seçiliyor
                    </div>
                  </>
                )}
              </div>

              <div className="wd-hud-right">
                <div className="wd-hud-label">⏱ Süre</div>
                <div className="wd-timer" style={{ color: timerColor }}>
                  {timeLeft}
                </div>
              </div>
            </div>

            {/* Score row + Pas butonu */}
            <div className="wd-scores">
              <div className={"wd-score wd-score-me" + (myScore >= oppScore ? " lead" : "")}>
                <span className="wd-score-name">{me?.name ?? "Sen"}</span>
                <span className="wd-score-val">{myScore}</span>
              </div>
              <span className="wd-score-sep">vs</span>
              <div className={"wd-score wd-score-opp" + (oppScore > myScore ? " lead" : "")}>
                <span className="wd-score-name">{opp?.name ?? "Rakip"}</span>
                <span className="wd-score-val">{oppScore}</span>
              </div>

              {/* Pas Geç — sadece aktif hedef varken görünür */}
              {currentTarget && (() => {
                const myId = myIdRef.current;
                const passMatches =
                  room.pass_target_topoid === currentTarget;
                const passList = passMatches
                  ? (room.pass_requested_by ?? [])
                  : [];
                const iVotedDb = passList.includes(myId);
                const iVoted = iVotedDb || iPressedLocally;
                const oppVoted = passList.some(id => id !== myId);

                let label = "🟡 Pas Geç";
                let disabled = false;
                if (iVoted && oppVoted) {
                  label = "Geçiliyor…";
                  disabled = true;
                } else if (iVoted) {
                  label = "Pas Bekleniyor…";
                  disabled = true;
                } else if (oppVoted) {
                  label = "🟠 Rakip pas istedi · Sen de bas";
                }

                return (
                  <button
                    className="btn btn-ghost wd-pass-btn"
                    onClick={requestPass}
                    disabled={disabled}
                    title="Aktif hedefi her iki oyuncu da pas geçerse atlanır"
                  >
                    {label}
                  </button>
                );
              })()}
            </div>

            {/* Map */}
            <div className="wheel-map-area wd-map">
              <WorldMap
                guessedISOs={usedSet}
                lastGuessed={lastClaimedTopoId}
                showLabels={false}
                activeIds={clickableIds}
                resetKey={0}
                region={regionDenorm}
                onCountryClick={handleMapClick}
                wrongId={wrongId || undefined}
              />
            </div>
          </div>
        );
      })()}

      {/* ════════ QUICK MATCH COUNTDOWN — playing UI'ın üstüne overlay ════════ */}
      {phase === "playing"
        && room
        && room.room_source === "quick_match"
        && countdownSeconds > 0 && (() => {
          const opp = players.find(p => p.id !== myIdRef.current);
          return (
            <div className="wheel-result-backdrop">
              <div className="wheel-result-panel" style={{ textAlign: "center" }}>
                <div className="wheel-result-emoji">⚡</div>
                <h2 className="wheel-result-title">Rakip bulundu!</h2>
                {opp && (
                  <p
                    className="duel-lobby-desc"
                    style={{ margin: "0 0 4px", fontSize: "0.95rem" }}
                  >
                    {opp.name}
                  </p>
                )}
                <p
                  className="duel-lobby-desc"
                  style={{ margin: "8px 0 0", fontSize: "0.9rem" }}
                >
                  Oyun başlıyor…
                </p>
                <div
                  style={{
                    fontSize: 56,
                    fontWeight: 800,
                    margin: "10px 0 4px",
                    color: "var(--accent, #4f8bff)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {countdownSeconds}
                </div>
              </div>
            </div>
          );
        })()}

      {/* ════════ FINISHED — overlay (arka plan = blur'lu playing UI) ════════ */}
      {phase === "finished" && room && (() => {
        const me = players.find(p => p.id === myIdRef.current);
        const opp = players.find(p => p.id !== myIdRef.current);
        const myScore = me?.score ?? 0;
        const oppScore = opp?.score ?? 0;
        const winnerId = room.winner_player_id;
        const isTie = winnerId === null;
        const iWon = !!winnerId && winnerId === myIdRef.current;
        const reasonText =
          room.finished_reason === "pool"
            ? "Tüm ülkeler kullanıldı."
            : "Süre doldu.";
        const titleText = isTie ? "BERABERE" : iWon ? "KAZANDIN!" : "KAYBETTİN";
        const emoji = isTie ? "🤝" : iWon ? "🏆" : "💀";

        // Rövanş 4-state hesap
        const myId = myIdRef.current;
        const rematchVotes = room.rematch_requested_by ?? [];
        const iVotedRematch = rematchVotes.includes(myId);
        const oppVotedRematch = rematchVotes.some(v => v !== myId);
        let rematchLabel: string;
        let rematchDisabled: boolean;
        let rematchClassName = "wheel-ghost-btn";
        if (iVotedRematch && oppVotedRematch) {
          rematchLabel = "↺ Rövanş hazırlanıyor...";
          rematchDisabled = true;
        } else if (iVotedRematch) {
          rematchLabel = "✓ Rövanş istedin · Rakip bekleniyor (1/2)";
          rematchDisabled = true;
        } else if (oppVotedRematch) {
          rematchLabel = "↺ Rakip rövanş istiyor · Kabul Et";
          rematchDisabled = false;
          rematchClassName = "wheel-primary-btn";
        } else {
          rematchLabel = "↺ Rövanş İste";
          rematchDisabled = false;
        }

        return (
          <div className="wheel-result-backdrop">
            <div className="wheel-result-panel">
              <div className="wheel-result-emoji">{emoji}</div>
              <h2 className="wheel-result-title">{titleText}</h2>
              <p
                className="duel-lobby-desc"
                style={{ margin: "0 0 4px", fontSize: "0.95rem" }}
              >
                {reasonText}
              </p>

              <div className="wd-result-scores">
                <div className={"wd-score" + (iWon ? " lead" : "")}>
                  <span className="wd-score-name">{me?.name ?? "Sen"}</span>
                  <span className="wd-score-val">{myScore}</span>
                </div>
                <span className="wd-score-sep">·</span>
                <div className={"wd-score" + (!iWon && !isTie ? " lead" : "")}>
                  <span className="wd-score-name">{opp?.name ?? "Rakip"}</span>
                  <span className="wd-score-val">{oppScore}</span>
                </div>
              </div>

              <div className="wheel-result-rows">
                <div className="wheel-result-row">
                  <span>Süre</span>
                  <strong>{durationLabel(room.duration_seconds)}</strong>
                </div>
                <div className="wheel-result-row">
                  <span>Bölge</span>
                  <strong>{regionLabel(room.region)}</strong>
                </div>
              </div>

              <div className="wheel-result-actions">
                <button
                  type="button"
                  className="wheel-primary-btn"
                  onClick={() => {
                    playSound("click");
                    leaveRoom();
                    onHome();
                  }}
                >
                  ⌂ Ana Menü
                </button>
                <button
                  type="button"
                  className={rematchClassName}
                  disabled={rematchDisabled}
                  onClick={
                    rematchDisabled
                      ? undefined
                      : () => {
                          playSound("click");
                          requestRematch();
                        }
                  }
                >
                  {rematchLabel}
                </button>
                {profile?.username ? (
                  <button
                    type="button"
                    className="wheel-ghost-btn"
                    onClick={() => {
                      playSound("click");
                      leaveRoom();
                      // leaveRoom setPhase('setup') yapıyor; setState batch'inden
                      // sonra startQuickMatch tetiklensin diye microtask'a at.
                      Promise.resolve().then(() => startQuickMatch());
                    }}
                  >
                    ⚡ Hızlı Eşleş
                  </button>
                ) : (
                  <button
                    type="button"
                    className="wheel-ghost-btn"
                    disabled
                    title="Hızlı eşleş için giriş gerekli"
                  >
                    ⚡ Hızlı Eşleş · Giriş Gerekli
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ════════ ROOM CLOSED MODAL — host odayı kapattığında guest'e ════════ */}
      {hostClosedRoom && (
        <div
          className="fd-room-closed-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wd-room-closed-title"
        >
          <div className="fd-room-closed-modal">
            <div className="fd-room-closed-icon" aria-hidden="true">🚪</div>
            <h2 id="wd-room-closed-title" className="fd-room-closed-title">
              ODA KAPATILDI
            </h2>
            <p className="fd-room-closed-sub">
              Oda sahibi odadan ayrıldı ve oturumu sonlandırdı.
            </p>
            <button
              className="btn btn-accent fd-room-closed-action"
              autoFocus
              onClick={() => setHostClosedRoom(false)}
            >
              ← Lobiye Dön
            </button>
          </div>
        </div>
      )}

      {/* ════════ XP KAZANIMI — fixed footer ════════ */}
      {xpResult && xpFooterVisible && !xpResult.dismissed && (
        <XpGainBar
          key={xpResult.roomKey}
          modeLabel="Çark 1v1"
          prevTotalXp={xpResult.prevTotalXp}
          newTotalXp={xpResult.totalXp}
          prevModeXp={xpResult.prevModeXp}
          newModeXp={xpResult.modeXp}
          xpEarned={xpResult.xpEarned}
          awarded={xpResult.awarded}
          breakdown={xpResult.breakdown}
          onDismiss={() =>
            setXpResult(prev => (prev ? { ...prev, dismissed: true } : null))
          }
        />
      )}
    </div>
  );
}
