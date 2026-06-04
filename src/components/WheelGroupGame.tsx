/**
 * WheelGroupGame.tsx — Çark Çok Oyunculu (Group Wheel, 3–10 kişi)
 *
 * Mevcut tablolar/oyun modları DOKUNULMAZ:
 *   • Solo WheelGame   (offline)
 *   • WheelDuelGame    (online 1v1, wheel_duel_*)
 *   • DuelGame / FlagDuelGame / DuelGroupGame
 *
 * Yeni tablolar:
 *   • wheel_group_rooms
 *   • wheel_group_players
 *
 * Chat için mevcut duel_messages tablosu reuse edilir (LobbyChat),
 * room.code "M" ile başlar (Multi-Wheel prefix) → diğer modların kodlarıyla
 * aynı duel_messages.room_code alanında karışmaz.
 *
 * Atomic claim:
 *   Aynı hedefe birden çok client tıklayabilir; yalnız ilk doğru tıklayan
 *   .eq("current_target_topoid", target) guard'lı UPDATE'i kazanır. Diğer
 *   client'lar 0 row update alır ve sessizce no-op olur.
 *
 * Host yönetimi:
 *   - Host startGame atar.
 *   - Host ayarları değiştirir.
 *   - Host kick yapabilir.
 *   - Host odadan ayrılırsa: kendi UPDATE'inde host_player_id'yi en eski
 *     joined_at'e sahip BAŞKA aktif oyuncuya geçirir, sonra row'unu siler.
 *
 * XP:
 *   - Katılım +5, doğru başına +3, sıralama bonusu (1:+10, 2:+5, 3:+3)
 *   - awardXpEvent("wheel_group", current_match_id) ile idempotent yazılır.
 *   - RPC tarafı henüz "wheel_group" mode_key'i kabul etmiyorsa hata yutulur
 *     ve UI'da yine de breakdown gösterilir.
 *
 * Gold:
 *   - Bu modda gold verilmez. Hiçbir gold mutation çağrısı yapılmaz.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LobbyChat from "./LobbyChat";
import WorldMap from "./WorldMap";
import XpGainBar from "./XpGainBar";
import type { Profile } from "../lib/auth";
import { readStoredHomeTheme, getThemeBackgroundStyle, getThemeDataAttr } from "../lib/themeBackgrounds";
import { getSyncedNowMs, initServerClockSync } from "../lib/serverClock";
import {
  supabase,
  type WheelGroupRoom,
  type WheelGroupPlayer,
} from "../lib/supabase";
import {
  playSound,
  stopSound,
  getCountdownSoundMode,
  shouldPlayCountdownSound,
} from "../lib/sound";
import {
  awardXpEvent,
  calculateWheelGroupXp,
  type WheelGroupXpBreakdown,
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

type Phase = "setup" | "creating" | "lobby" | "playing" | "finished";

type Region =
  | "world"
  | "europe"
  | "asia"
  | "africa"
  | "north-america"
  | "south-america"
  | "oceania";

const MIN_PLAYERS = 3;
/** Lobide gosterilen toplam slot sayisi. max_players bunun altinda kalirsa
 *  fazlasi "Kapali slot" olarak render edilir. */
const TOTAL_SLOTS = 10;
/** Host max_players dropdown'inda gosterilen secenekler (3..10). */
const MAX_PLAYER_OPTIONS: number[] = [3, 4, 5, 6, 7, 8, 9, 10];

const FEEDBACK_MS    = 1000; // Doğru claim sonrası yeni hedef gelmeden bekleme
const WRONG_FLASH_MS = 600;  // Yanlış tıklama kırmızı flash süresi (lokal)
const PENALTY_MS     = 1000; // Cezalı modda yanlış tık tıklama kilidi süresi

const DURATION_OPTIONS: { label: string; value: number }[] = [
  { label: "30 sn", value: 30 },
  { label: "1 dk", value: 60 },
  { label: "2 dk", value: 120 },
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

/** Çark Çok Oyunculu hedef havuzundan ÇIKARILAN ülkeler.
 *  Wheel Duel ile aynı liste — mikro/ada ülkeleri online rekabette adil değil. */
const WHEEL_GROUP_EXCLUDED_TOPOIDS = new Set<string>([
  "020", "438", "470", "492", "674", "336",
  "048", "462", "702",
  "132", "174", "480", "678", "690",
  "028", "052", "212", "308", "659", "662", "670",
  "242", "296", "520", "583", "584", "585", "776", "798", "882",
]);

const PLAYER_ID_KEY = "geoquiz_wheel_group_player_id";
const ROOM_KEY      = "geoquiz_wheel_group_room";
/** RLS hardening (M2 RPC switch): tüm yazma RPC'leri claim_token istiyor.
 *  Hem misafir hem logged-in oyuncuda aynı kanıt yolu; logged-in ek olarak
 *  auth.uid() ile de yetki kazanır ama claim_token tek-tip path olarak kalır.
 *  Public tabloda saklanmaz (token-only realtime'dan dışlanmış
 *  wheel_group_player_claims tablosuna yazılır). */
const CLAIM_TOKEN_KEY = "geoquiz_wheel_group_claim_token";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */

/** "M" + 5 random char → 6 toplam. M = Multi (Group) Wheel. */
function generateRoomCode(): string {
  let out = "M";
  for (let i = 0; i < 5; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
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
 *  logged-in için ek yetki kanıtı. */
function freshClaimToken(): string {
  const tok =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(CLAIM_TOKEN_KEY, tok);
  return tok;
}

function clearWheelGroupSession() {
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
    return "Veritabanı tabloları hazır değil. Migration çalıştırılmamış olabilir.";
  if (code === "42501") return "Veritabanı izin hatası. RLS politikalarını kontrol et.";
  return null;
}

/** M2 RPC'lerinden dönen hata mesajlarını kullanıcı dostu Türkçe karşılıklarına
 *  çevirir. RPC'ler `raise exception 'name_taken' using errcode='P0001'` gibi
 *  açık etiketler kullanıyor; error.message bu etiketi içerir. errcode da
 *  kontrol edilir, böylece beklenmeyen mesajda generic fallback'e düşeriz. */
function describeWheelGroupRpcError(
  error: { code?: string; message?: string } | null | undefined,
): string | null {
  if (!error) return null;
  const msg = (error.message ?? "").toLowerCase();
  if (msg.includes("code_taken"))         return "Bu oda kodu az önce kullanıldı. Tekrar dene.";
  if (msg.includes("name_taken"))         return "Bu odada bu isim zaten kullanılıyor.";
  if (msg.includes("name_invalid"))       return "Oyuncu adı en az 2 karakter olmalı.";
  if (msg.includes("room_full"))          return "Oda dolu.";
  if (msg.includes("room_finished"))      return "Bu oda kapanmış.";
  if (msg.includes("room_in_progress"))   return "Maç başlamış. Katılamazsın.";
  if (msg.includes("room_unavailable"))   return "Oda şu an müsait değil.";
  if (msg.includes("room_not_found"))     return "Oda bulunamadı. Kodu kontrol et.";
  if (msg.includes("room_not_waiting"))   return "Oda artık lobby fazında değil.";
  if (msg.includes("room_not_playing"))   return "Oyun durumu değişti.";
  if (msg.includes("room_not_finished"))  return "Maç henüz bitmedi.";
  if (msg.includes("room_not_startable")) return "Oyun bu durumdan başlatılamaz.";
  if (msg.includes("not_enough_players")) return "Başlamak için en az 3 oyuncu lazım.";
  if (msg.includes("cannot_kick_self"))   return "Kendini kickleyemezsin.";
  if (msg.includes("max_players_invalid")) return "Oyuncu sayısı 3 ile 10 arasında olmalı.";
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
  if (msg.includes("target_player_required")) return "Hedef oyuncu kimliği eksik.";
  if (msg.includes("reason_required"))    return "Bitiş sebebi eksik.";
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

export default function WheelGroupGame({ onHome, profile }: Props) {
  /* ── Phase ───────────────────────────────────────────────── */
  const [phase, setPhase] = useState<Phase>("setup");

  /* ── Setup form state ────────────────────────────────────── */
  const initialName = profile?.username ?? "";
  const [playerName, setPlayerName] = useState<string>(initialName);

  /** Login durumu. Login olmus kullanici icin ad input'u readonly olur ve
   *  daima profile.username kullanilir; misafir icin manuel input acik kalir. */
  const isLoggedInPlayer = !!profile?.username;

  /** profile.username degisirse (login/logout/profile guncellemesi) lokal
   *  state'i senkronla. Login olmus kullanici icin createRoom/joinRoom anlik
   *  olarak profile.username'i gonderir, bu effect sadece UI gostergesini
   *  ve misafir → login gecisinde state'i tutarli tutar. */
  useEffect(() => {
    if (profile?.username) {
      setPlayerName(profile.username);
    }
  }, [profile?.username]);
  const [hostDuration, setHostDuration] = useState<number>(60);
  const [hostRegion, setHostRegion] = useState<Region>("world");
  const [hostPenalty, setHostPenalty] = useState<boolean>(false);
  const [joinCode, setJoinCode] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [hostClosedRoom, setHostClosedRoom] = useState(false);
  const [kickedNoticeOpen, setKickedNoticeOpen] = useState(false);
  const [newHostModalOpen, setNewHostModalOpen] = useState(false);

  /* ── Lobby state (Supabase-bound) ─────────────────────────── */
  const [room, setRoom] = useState<WheelGroupRoom | null>(null);
  const [players, setPlayers] = useState<WheelGroupPlayer[]>([]);
  const [kickTarget, setKickTarget] = useState<WheelGroupPlayer | null>(null);
  const [copied, setCopied] = useState(false);
  const [wggPlayersOpen, setWggPlayersOpen] = useState(false);
  const [wggChatOpen,    setWggChatOpen]    = useState(false);

  /** Max-players dropdown'in iki ayri ankrajdan acilabilmesi icin tek state.
   *  null = kapali, 'desktop' = sol kart sayacindan, 'mobile' = mobile sheet
   *  basligindan. Sadece host icin acilir; non-host icin badge non-interactive. */
  const [maxMenuAnchor, setMaxMenuAnchor] = useState<null | "desktop" | "mobile">(null);
  const maxMenuDesktopRef = useRef<HTMLDivElement | null>(null);
  const maxMenuMobileRef  = useRef<HTMLDivElement | null>(null);

  /* ── Gameplay state ───────────────────────────────────────── */
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [wrongId, setWrongId] = useState<string | null>(null);
  const [lastClaimedTopoId, setLastClaimedTopoId] = useState<string | null>(null);
  /** Cezalı modda yanlış tık sonrası tıklama kilidi. now() > penaltyUntilMs
   *  olmadan handleMapClick early return. Sadece bu oyuncu için lokal. */
  const [penaltyUntilMs, setPenaltyUntilMs] = useState<number>(0);

  /* ── Final leaderboard (sonuç ekranında dondurulur) ─── */
  const [finalLeaderboard, setFinalLeaderboard] = useState<
    Array<{ playerId: string; name: string; score: number }> | null
  >(null);

  /* ── XP state ──
   *  status: 'pending'     → RPC çağrısı in-flight
   *          'awarded'     → bu maç için XP başarıyla yazıldı
   *          'already'     → aynı maç_id için zaten yazılmıştı (rare)
   *          'error'       → RPC fail (errorMsg dolu)
   *          'not_logged'  → misafir oyuncu, XP yazılmıyor
   *
   *  XpGainBar prev/new snapshot'ları RPC dönüşünden türetilir:
   *    awarded=true  → prev = current - xpEarned (geriye türetme)
   *    awarded=false → prev = current (animasyon olmaz, "zaten verilmişti")
   *    error/not_logged → bar gösterilmez
   *
   *  roomKey = current_match_id (XpGainBar'a `key` olarak veriliyor;
   *  yeni maç başlayınca temiz mount). dismissed = X'e basıldı.
   */
  const [xpResult, setXpResult] = useState<{
    status: "pending" | "awarded" | "already" | "error" | "not_logged";
    xpEarned: number;
    breakdown: WheelGroupXpBreakdown;
    errorMsg?: string | null;
    prevTotalXp: number;
    totalXp: number;
    prevModeXp: number;
    modeXp: number;
    roomKey: string;
    dismissed: boolean;
  } | null>(null);
  const xpAwardedRef = useRef(false);

  /* XpGainBar'ı sonuç sesi/efekti bittikten sonra göster (WheelDuel pattern).
   *  ~1.2 sn bekle → kullanıcı önce sonuç modalına odaklansın, sonra XP barı belirsin. */
  const [xpFooterVisible, setXpFooterVisible] = useState(false);
  useEffect(() => {
    if (!xpResult) { setXpFooterVisible(false); return; }
    if (xpResult.status !== "awarded" && xpResult.status !== "already") {
      setXpFooterVisible(false);
      return;
    }
    const t = setTimeout(() => setXpFooterVisible(true), 1200);
    return () => clearTimeout(t);
  }, [xpResult]);

  /* ── Identity ── */
  const myIdRef = useRef<string>("");
  /** RLS hardening (M2 RPC switch): tüm yazma RPC'leri claim_token istiyor.
   *  Hem misafir hem logged-in oyuncuda aynı kanıt yolu; logged-in ek olarak
   *  auth.uid() ile de yetki kazanır ama claim_token tek-tip path olarak kalır. */
  const myClaimTokenRef = useRef<string>("");

  /* ── Refs for transitions / guards ────────────────────────── */
  const prevTargetRef = useRef<string | null>(null);
  const endingRef = useRef<boolean>(false);
  const wrongFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClaimedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Refs that callbacks read ── */
  const roomRef = useRef<WheelGroupRoom | null>(null);
  const playersRef = useRef<WheelGroupPlayer[]>([]);
  const finishGameRef = useRef<((reason: "timeout" | "pool") => Promise<void>) | null>(null);

  /* ── Sound guards ── */
  const countdownPlayedRef = useRef(false);
  const resultSoundPlayedRef = useRef(false);

  /* ── Derived ─────────────────────────────────────────────── */
  const isHost = !!room && room.host_player_id === myIdRef.current;
  const lobbyDuration = room?.duration_seconds ?? hostDuration;
  const lobbyRegionDb = room?.region ?? normalizeRegion(hostRegion);
  const lobbyPenalty = room?.penalty_enabled ?? hostPenalty;

  /* ── Sync refs ── */
  useEffect(() => { roomRef.current = room; }, [room]);
  useEffect(() => { playersRef.current = players; }, [players]);

  /* ── Live leaderboard ── */
  const leaderboard = useMemo(() => {
    return players
      .map(p => ({
        playerId: p.id,
        name: p.name,
        score: p.score ?? 0,
        isMe: p.id === myIdRef.current,
        isHost: room?.host_player_id === p.id,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }, [players, room?.host_player_id]);

  /* ── Viewport breakpoint (desktop ≥ 900px) ─────────────────
   *  Sonuç ekranındaki çift-kart layout için kullanılır.
   *  Mobilde tek kolon (orta kart üstte, scoreboard altta);
   *  desktop'ta yan yana (scoreboard solda).
   */
  const [isWideViewport, setIsWideViewport] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth >= 900 : true,
  );
  useEffect(() => {
    const onResize = () => setIsWideViewport(window.innerWidth >= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* ── URL param: ?wheelGroup=KOD ───────────────────────────── */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("wheelGroup");
    if (code) setJoinCode(normalizeRoomCode(code));
  }, []);

  /* ── Share/invite ──────────────────────────────────────────
   *  Davet linkini origin + pathname + tek query param ile uretiyoruz.
   *  window.location.href kullanirsak Supabase auth callback'lerinden
   *  donen `#error=access_denied&error_code=otp_expired` gibi hash
   *  parcalari linke bulasiyor. URL hash'i de string'e karistirma. */
  const shareLink = useMemo(() => {
    if (!room) return "";
    const origin = window.location.origin;
    const pathname = window.location.pathname;
    return `${origin}${pathname}?wheelGroup=${room.code}`;
  }, [room]);

  /* ── Max-players dropdown: click-outside + Esc kapanis ─────── */
  useEffect(() => {
    if (!maxMenuAnchor) return;
    function onDoc(ev: MouseEvent) {
      const t = ev.target as Node | null;
      if (!t) return;
      const inDesk = maxMenuDesktopRef.current?.contains(t) ?? false;
      const inMob  = maxMenuMobileRef.current?.contains(t) ?? false;
      if (!inDesk && !inMob) setMaxMenuAnchor(null);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMaxMenuAnchor(null);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [maxMenuAnchor]);

  const inviteMessage = useMemo(() => {
    if (!room) return "";
    return (
      `Torble'da Çark Çok Oyunculu oynayalım! 🏆\n` +
      `Mod: ${regionLabel(room.region)} · Süre: ${durationLabel(room.duration_seconds)} · ${room.penalty_enabled ? "Cezalı" : "Cezasız"}\n` +
      `Hedef ülkeyi haritada ilk bulan puan alır.\n` +
      `Katılmak için tıkla:\n${shareLink}`
    );
  }, [room, shareLink]);

  /* ═══════════════════════════════════════════════════════════
     REALTIME: oda + oyuncular
  ═══════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (!room) return;
    const roomId = room.id;

    const chan = supabase
      .channel(`wheel-group:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "wheel_group_rooms",
          filter: `id=eq.${roomId}`,
        },
        payload => {
          const r = payload.new as WheelGroupRoom;

          // Target transitions → green flash on the last claimed country
          const prev = prevTargetRef.current;
          const curr = r.current_target_topoid ?? null;
          if (prev && !curr) {
            setLastClaimedTopoId(prev);
            if (lastClaimedTimerRef.current) clearTimeout(lastClaimedTimerRef.current);
            lastClaimedTimerRef.current = setTimeout(() => {
              setLastClaimedTopoId(null);
              lastClaimedTimerRef.current = null;
            }, FEEDBACK_MS);
          } else if (curr) {
            if (lastClaimedTimerRef.current) {
              clearTimeout(lastClaimedTimerRef.current);
              lastClaimedTimerRef.current = null;
            }
            setLastClaimedTopoId(null);
          }
          prevTargetRef.current = curr;

          // Yeni host detection: önceki host ben değilken yeni host ben oldum
          if (
            r.host_player_id === myIdRef.current &&
            roomRef.current?.host_player_id !== myIdRef.current
          ) {
            setNewHostModalOpen(true);
          }

          setRoom(r);

          if (r.status === "playing") {
            setPhase(p => (p === "playing" ? p : "playing"));
          }
          if (r.status === "finished") {
            setPhase("finished");
          }
          if (r.status === "waiting") {
            setPhase(p => (p === "lobby" ? p : "lobby"));
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "wheel_group_rooms",
          filter: `id=eq.${roomId}`,
        },
        () => {
          // Tüm oda silindi (host last-resort kapatma). Kendi host değilsem
          // setup'a düş + uyarı.
          if (roomRef.current?.host_player_id !== myIdRef.current) {
            setHostClosedRoom(true);
            setRoom(null);
            setPlayers([]);
            clearWheelGroupSession();
            setPhase("setup");
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "wheel_group_players",
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          supabase
            .from("wheel_group_players")
            .select("*")
            .eq("room_id", roomId)
            .order("joined_at", { ascending: true })
            .then(({ data }) => {
              if (data) setPlayers(data as WheelGroupPlayer[]);
            });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(chan);
    };
  }, [room?.id]);

  /* ── Kick detection: lobby'de kendimi listede bulamıyorsam atıldım ── */
  useEffect(() => {
    if (phase !== "lobby") return;
    if (!room) return;
    if (!myIdRef.current) return;
    if (players.length === 0) return;
    const meInRoom = players.some(p => p.id === myIdRef.current);
    if (!meInRoom) {
      // Kicked
      clearWheelGroupSession();
      setRoom(null);
      setPlayers([]);
      setKickedNoticeOpen(true);
      setPhase("setup");
    }
  }, [phase, players, room]);

  /* ═══════════════════════════════════════════════════════════
     GAMEPLAY HELPERS
  ═══════════════════════════════════════════════════════════ */

  const buildTargetPool = useCallback((regionDb: string): string[] => {
    const denorm = denormalizeRegion(regionDb);
    return getFlagPool(denorm as Continent | "world", "all")
      .map(c => c.topoId)
      .filter((id): id is string => !!id)
      .filter(id => !WHEEL_GROUP_EXCLUDED_TOPOIDS.has(id));
  }, []);

  /** Host: yeni hedef seç. Atomic guard server-side
   *  (status='playing' + current_target_topoid IS NULL). */
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
      await finishGameRef.current?.("pool");
      return;
    }

    const next = remaining[Math.floor(Math.random() * remaining.length)];

    const { error } = await supabase.rpc("wheel_group_pick_target", {
      p_room_id:        r.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    myClaimTokenRef.current,
      p_target:         next,
    });
    if (error) {
      console.error("[WheelGroup] pick_target RPC failed", error);
    }
  }, [buildTargetPool]);

  const finishGame = useCallback(async (reason: "timeout" | "pool") => {
    const r = roomRef.current;
    if (!r) return;
    if (r.host_player_id !== myIdRef.current) return;
    if (endingRef.current) return;
    endingRef.current = true;

    // RPC: server-side now() ile finished_at yazılır + status='playing' guard.
    // Status guard fail olursa room_not_playing exception → endingRef rollback.
    const { error } = await supabase.rpc("wheel_group_finish_game", {
      p_room_id:        r.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    myClaimTokenRef.current,
      p_reason:         reason,
    });

    if (error) {
      console.error("[WheelGroup] finish_game RPC failed", error);
      endingRef.current = false;
    }
  }, []);

  useEffect(() => { finishGameRef.current = finishGame; }, [finishGame]);

  const handleMapClick = useCallback(
    async (topoId: string) => {
      const r = roomRef.current;
      if (!r || r.status !== "playing") return;
      if (!r.current_target_topoid) return;

      // Tıklama kilidi (cezalı modda)
      if (r.penalty_enabled && Date.now() < penaltyUntilMs) return;

      if (topoId !== r.current_target_topoid) {
        // Yanlış: lokal kırmızı flash; cezalı modda 1sn kilit
        playSound("wrong");
        setWrongId(topoId);
        if (wrongFlashTimerRef.current) clearTimeout(wrongFlashTimerRef.current);
        wrongFlashTimerRef.current = setTimeout(() => {
          setWrongId(null);
          wrongFlashTimerRef.current = null;
        }, WRONG_FLASH_MS);
        if (r.penalty_enabled) {
          setPenaltyUntilMs(Date.now() + PENALTY_MS);
        }
        return;
      }

      // Doğru: server-atomik claim + skor +1 tek RPC'de.
      // SKOR SERVER-SIDE artırılır; client değer GÖNDERMEZ. Yarışı kaybeden
      // client'lar claimed=false alır ve sessiz no-op olur.
      const { data: claimResult, error: claimErr } = await supabase.rpc(
        "wheel_group_claim_target",
        {
          p_room_id:     r.id,
          p_player_id:   myIdRef.current,
          p_claim_token: myClaimTokenRef.current,
          p_target:      topoId,
        },
      );

      if (claimErr) {
        console.error("[WheelGroup] claim_target RPC failed", claimErr);
        return;
      }

      const claimed =
        (claimResult as { claimed?: boolean } | null)?.claimed === true;
      if (!claimed) {
        // Yarışı başkası kazandı, hedef bayatladı veya status değişti → no-op.
        return;
      }

      playSound("correct");
      // Skor realtime UPDATE'iyle wheel_group_players abonesine yansır.
    },
    [penaltyUntilMs],
  );

  /* ── Server-clock sync ──
   *  room.started_at server `now()` ile yazılıyor; her client onu kendi
   *  Date.now()'una göre okuyunca PC saatleri arasındaki fark (5 sn'ye
   *  kadar) timer ve host-finish kontrolüne doğrudan kayma olarak yansıyor.
   *  initServerClockSync() bir RPC ile offset'i ölçüp getSyncedNowMs()
   *  üzerinden tüm hesapları aynı epoch referansına oturtuyor. Lobby/
   *  playing fazlarında aktif — setup ekranında gereksiz probe atmaz.
   */
  useEffect(() => {
    if (phase !== "lobby" && phase !== "playing") return;
    const handle = initServerClockSync();
    return () => handle.dispose();
  }, [phase]);

  /* ═══════════════════════════════════════════════════════════
     TIMER (clients independent, anchored to room.started_at)
  ═══════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (phase !== "playing") {
      setTimeLeft(0);
      return;
    }
    if (!room?.started_at) return;

    const startMs = new Date(room.started_at).getTime();
    const duration = Number(room.duration_seconds);
    if (!(duration > 0)) return;

    const tick = () => {
      const elapsed = (getSyncedNowMs() - startMs) / 1000;
      const remaining = Math.max(0, Math.min(duration, Math.ceil(duration - elapsed)));
      setTimeLeft(remaining);
    };

    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [phase, room?.started_at, room?.duration_seconds]);

  /* ═══════════════════════════════════════════════════════════
     HOST: pick next target after FEEDBACK_MS when target=null
  ═══════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (!isHost) return;
    if (phase !== "playing") return;
    if (!room) return;
    if (room.current_target_topoid) return;
    if (timeLeft <= 0) return;

    const t = setTimeout(() => { pickNextTarget(); }, FEEDBACK_MS);
    return () => clearTimeout(t);
    // timeLeft kasıtlı dışarıda — her tick'te effect yeniden çalışırsa setTimeout
    // sonsuza kadar reset olur.
  }, [isHost, phase, room?.id, room?.current_target_topoid, pickNextTarget]);

  /* ═══════════════════════════════════════════════════════════
     HOST: finish on timer expiry (server-authoritative)
  ═══════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (!isHost) return;
    if (phase !== "playing") return;
    if (!room) return;
    if (room.status !== "playing") return;
    if (!room.started_at) return;
    const duration = Number(room.duration_seconds);
    if (!(duration > 0)) return;
    if (endingRef.current) return;

    const startMs = new Date(room.started_at).getTime();
    const durationMs = duration * 1000;

    const check = () => {
      if (endingRef.current) return;
      const elapsedMs = getSyncedNowMs() - startMs;
      if (elapsedMs < durationMs) return;
      finishGame("timeout");
    };

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

  /* ═══════════════════════════════════════════════════════════
     COUNTDOWN SES
  ═══════════════════════════════════════════════════════════ */
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
    if (timeLeft <= 0) stopSound("countdown20");
  }, [phase, timeLeft, room?.duration_seconds]);

  useEffect(() => {
    return () => { stopSound("countdown20"); };
  }, []);

  /* ═══════════════════════════════════════════════════════════
     FINISHED — freeze leaderboard + result sound + XP
  ═══════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (phase !== "finished" || !room) {
      resultSoundPlayedRef.current = false;
      return;
    }

    // Final leaderboard'u dondur (henüz dondurulmadıysa)
    if (!finalLeaderboard) {
      (async () => {
        const { data } = await supabase
          .from("wheel_group_players")
          .select("id, name, score")
          .eq("room_id", room.id);
        const board = (data ?? [])
          .map(p => ({
            playerId: p.id as string,
            name: p.name as string,
            score: (p.score as number) ?? 0,
          }))
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        setFinalLeaderboard(board);
      })();
    }

    // Sonuç sesi (kazanan → win, diğerleri → lose; tie ilk sırada birden çoksa win)
    if (!resultSoundPlayedRef.current && finalLeaderboard) {
      resultSoundPlayedRef.current = true;
      const top = finalLeaderboard[0]?.score ?? 0;
      const me = finalLeaderboard.find(b => b.playerId === myIdRef.current);
      const myScore = me?.score ?? 0;
      if (myScore > 0 && myScore === top) playSound("win", { restart: true });
      else playSound("lose", { restart: true });
    }
  }, [phase, room, finalLeaderboard]);

  /* ── XP award (once per match_id, only logged-in users) ── */
  useEffect(() => {
    if (phase !== "finished" || !room) return;
    if (xpAwardedRef.current) return;
    if (!finalLeaderboard) return;

    const me = finalLeaderboard.find(b => b.playerId === myIdRef.current);
    if (!me) return;

    const myRank = finalLeaderboard.findIndex(b => b.playerId === myIdRef.current) + 1;

    const breakdown = calculateWheelGroupXp({
      correctCount: me.score,
      finalRank: Math.max(1, myRank),
      totalPlayers: finalLeaderboard.length,
    });

    const matchKey = room.current_match_id;

    // Misafir: XP yazılmaz, sadece breakdown gösterilir.
    if (!profile?.id || !profile.username) {
      xpAwardedRef.current = true;
      setXpResult({
        status: "not_logged",
        xpEarned: 0,
        breakdown,
        prevTotalXp: 0,
        totalXp: 0,
        prevModeXp: 0,
        modeXp: 0,
        roomKey: matchKey,
        dismissed: false,
      });
      return;
    }

    xpAwardedRef.current = true;
    setXpResult({
      status: "pending",
      xpEarned: 0,
      breakdown,
      prevTotalXp: 0,
      totalXp: 0,
      prevModeXp: 0,
      modeXp: 0,
      roomKey: matchKey,
      dismissed: false,
    });

    const profileId = profile.id;
    const matchId = matchKey;

    (async () => {
      const res = await awardXpEvent({
        profileId,
        modeKey: "wheel_group",
        roomId: matchId,
        xpEarned: breakdown.total,
        result: breakdown.finalRank === 1
          ? "win"
          : breakdown.finalRank <= 3
            ? "draw"
            : "loss",
        details: {
          my_score: me.score,
          final_rank: myRank,
          total_players: finalLeaderboard.length,
          breakdown,
          real_room_id: room.id,
          match_seq: room.match_seq,
          finished_reason: room.finished_reason,
          region: room.region,
          duration_seconds: room.duration_seconds,
          penalty_enabled: room.penalty_enabled,
        },
      });

      if (res.error) {
        // Hata mesajını gerçek hatayla console'a koy (kullanıcı F12'de görebilsin).
        // Sessiz fallback değil — `[WheelGroup XP]` prefix'i ile aranabilir.
        console.error("[WheelGroup XP] RPC failed:", res.error);
        setXpResult({
          status: "error",
          xpEarned: 0,
          breakdown,
          errorMsg: res.error,
          prevTotalXp: 0,
          totalXp: 0,
          prevModeXp: 0,
          modeXp: 0,
          roomKey: matchKey,
          dismissed: false,
        });
        return;
      }

      // prev = current - earned (awarded), aksi halde aynı snapshot →
      // XpGainBar count-up animasyonu doğru çalışsın diye.
      const prevTotalXp = res.awarded ? Math.max(0, res.totalXp - res.xpEarned) : res.totalXp;
      const prevModeXp  = res.awarded ? Math.max(0, res.modeXp  - res.xpEarned) : res.modeXp;

      setXpResult({
        status: res.awarded ? "awarded" : "already",
        xpEarned: res.awarded ? res.xpEarned : 0,
        breakdown,
        prevTotalXp,
        totalXp: res.totalXp,
        prevModeXp,
        modeXp: res.modeXp,
        roomKey: matchKey,
        dismissed: false,
      });
    })();
  }, [phase, room, finalLeaderboard, profile?.id, profile?.username]);

  /* ═══════════════════════════════════════════════════════════
     ACTIONS
  ═══════════════════════════════════════════════════════════ */

  async function createRoom() {
    playSound("click");
    // Loginli kullanici icin daima profile.username; misafir icin manuel input.
    const effectiveName = isLoggedInPlayer
      ? (profile?.username ?? "").trim()
      : playerName.trim();
    const nameErr = validateName(effectiveName);
    if (nameErr) { setErrorMsg(nameErr); return; }

    setErrorMsg(null);
    setHostClosedRoom(false);
    setKickedNoticeOpen(false);
    setStatusMsg("Oda kuruluyor…");
    setPhase("creating");

    clearWheelGroupSession();
    const freshId = freshPlayerId();
    const claimToken = freshClaimToken();
    myIdRef.current = freshId;
    myClaimTokenRef.current = claimToken;

    const code = generateRoomCode();
    const trimmedName = effectiveName;
    const profileId = profile?.id ?? null;
    // Misafir için guest_id = freshId (stable per-session anchor); logged-in
    // tarafta NULL bırakılır, server profile_id = auth.uid() kontrolü yapar.
    const guestId = profileId ? null : freshId;

    // Tek RPC: oda + host player + claim transaction'da. Orphan-room rollback
    // gerekmez (function rollback ile garantili). max_players init default'u
    // (10) ile başlatılır; host updateHostSetting ile sonradan değiştirir.
    const { data: roomData, error: roomErr } = await supabase.rpc(
      "wheel_group_create_room",
      {
        p_player_id:   freshId,
        p_profile_id:  profileId,
        p_guest_id:    guestId,
        p_name:        trimmedName,
        p_code:        code,
        p_duration:    hostDuration,
        p_region:      normalizeRegion(hostRegion),
        p_penalty:     hostPenalty,
        p_max_players: 10,
        p_claim_token: claimToken,
      },
    );

    if (roomErr || !roomData?.id) {
      const friendly =
        describeWheelGroupRpcError(roomErr) ??
        "Oda oluşturulamadı. Bağlantıyı kontrol et.";
      setErrorMsg(friendly);
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    const createdRoom = roomData as WheelGroupRoom;

    // İlk player listesini çek (realtime devreye girene kadar UI hazır olsun).
    const { data: ps } = await supabase
      .from("wheel_group_players")
      .select("*")
      .eq("room_id", createdRoom.id)
      .order("joined_at", { ascending: true });

    setRoom(createdRoom);
    setPlayers((ps ?? []) as WheelGroupPlayer[]);
    saveRoomSession(createdRoom.id, createdRoom.code, freshId);
    setStatusMsg(null);
    setPhase("lobby");
  }

  async function joinRoomByCode() {
    playSound("click");
    // Loginli kullanici icin daima profile.username; misafir icin manuel input.
    const effectiveName = isLoggedInPlayer
      ? (profile?.username ?? "").trim()
      : playerName.trim();
    const nameErr = validateName(effectiveName);
    if (nameErr) { setErrorMsg(nameErr); return; }
    const normalized = normalizeRoomCode(joinCode);
    if (normalized.length !== 6) {
      setErrorMsg("Oda kodu 6 karakter olmalı.");
      return;
    }

    setErrorMsg(null);
    setHostClosedRoom(false);
    setKickedNoticeOpen(false);
    setStatusMsg("Odaya bağlanılıyor…");
    setPhase("creating");

    clearWheelGroupSession();
    const freshId = freshPlayerId();
    const claimToken = freshClaimToken();
    myIdRef.current = freshId;
    myClaimTokenRef.current = claimToken;

    const trimmedName = effectiveName;
    const profileId = profile?.id ?? null;
    const guestId = profileId ? null : freshId;

    // RPC tek atışta: oda lookup (FOR UPDATE) + status/kapasite/isim çakışması
    // check + player insert + claim insert. Capacity trigger backup olarak
    // INSERT sırasında da çalışır; mesaj 'room_full' olarak yeniden raise edilir.
    const { data: roomData, error: joinErr } = await supabase.rpc(
      "wheel_group_join_room",
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
        describeWheelGroupRpcError(joinErr) ?? "Odaya katılınamadı.";
      setErrorMsg(friendly);
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    const targetRoom = roomData as WheelGroupRoom;

    // Player listesini çek (realtime devreye girene kadar UI hazır olsun).
    const { data: ps } = await supabase
      .from("wheel_group_players")
      .select("*")
      .eq("room_id", targetRoom.id)
      .order("joined_at", { ascending: true });

    setRoom(targetRoom);
    setPlayers((ps ?? []) as WheelGroupPlayer[]);
    saveRoomSession(targetRoom.id, targetRoom.code, freshId);
    setStatusMsg(null);
    setPhase("lobby");
  }

  /** Lobby/playing/finished'dan çıkış. Server RPC üç dalı tek transaction'da
   *  atomik yönetir:
   *   - Host & başkası varsa: host_player_id'yi en eski joined_at'e sahip BAŞKA
   *     oyuncuya devret, sonra kendi player row'unu sil.
   *   - Host & yalnız: odayı tamamen sil (cascade ile player + claim temizlenir).
   *   - Non-host: sadece kendi player row'unu sil.
   *  Idempotent: oda yoksa sessiz no-op. */
  async function leaveRoom() {
    playSound("click");
    const currentRoom = roomRef.current;
    const currentMyId = myIdRef.current;
    const currentClaim = myClaimTokenRef.current;

    // UI önce sıfırlansın
    setRoom(null);
    setPlayers([]);
    setCopied(false);
    setErrorMsg(null);
    setStatusMsg(null);
    setPhase("setup");
    setTimeLeft(0);
    setWrongId(null);
    setLastClaimedTopoId(null);
    setPenaltyUntilMs(0);
    setFinalLeaderboard(null);
    setXpResult(null);
    xpAwardedRef.current = false;
    endingRef.current = false;
    prevTargetRef.current = null;
    if (wrongFlashTimerRef.current) {
      clearTimeout(wrongFlashTimerRef.current);
      wrongFlashTimerRef.current = null;
    }
    if (lastClaimedTimerRef.current) {
      clearTimeout(lastClaimedTimerRef.current);
      lastClaimedTimerRef.current = null;
    }
    clearWheelGroupSession();

    if (!currentRoom) return;

    // RPC host/non-host ayrımını + host transfer + self DELETE'i tek transaction'da
    // yapar. Eski iki-step host transfer yarış penceresi (host UPDATE ile self
    // DELETE arasında concurrent leave) kapanır.
    const { error } = await supabase.rpc("wheel_group_leave_room", {
      p_room_id:     currentRoom.id,
      p_player_id:   currentMyId,
      p_claim_token: currentClaim,
    });
    if (error) {
      console.error("[WheelGroup] leave_room RPC failed", error);
    }
  }

  async function startGame() {
    playSound("click");
    if (!room || !isHost) return;
    if (players.length < MIN_PLAYERS) return;

    const pool = buildTargetPool(room.region);
    if (pool.length === 0) {
      setErrorMsg("Bu bölge için hedef havuzu boş.");
      return;
    }
    const firstTarget = pool[Math.floor(Math.random() * pool.length)];

    endingRef.current = false;
    prevTargetRef.current = firstTarget;
    setLastClaimedTopoId(null);
    setWrongId(null);
    setPenaltyUntilMs(0);
    setFinalLeaderboard(null);
    setXpResult(null);
    xpAwardedRef.current = false;

    // Tek RPC: tüm oyuncuların skorlarını 0'a çek + room satırını 'playing'
    // fazına geçir. started_at server-side now() ile yazılır (clock skew kapanır).
    // match_seq / current_match_id rotation server-side; mevcut semantik korunur
    // (yalnız status='finished' geçişinde bump, waiting → playing'de aynı kalır).
    const { data: updated, error } = await supabase.rpc(
      "wheel_group_start_game",
      {
        p_room_id:        room.id,
        p_host_player_id: myIdRef.current,
        p_claim_token:    myClaimTokenRef.current,
        p_first_target:   firstTarget,
      },
    );

    if (error || !updated) {
      setErrorMsg(
        describeWheelGroupRpcError(error) ?? "Oyun başlatılamadı. Tekrar dene.",
      );
      return;
    }

    setRoom(updated as WheelGroupRoom);
    setPhase("playing");
  }

  async function updateHostSetting(
    next: { duration_seconds?: number; region?: string; penalty_enabled?: boolean; max_players?: number },
  ) {
    if (!room || !isHost) return;
    // Optimistic
    setRoom(prev => (prev ? { ...prev, ...next } : prev));

    // RPC partial update: dokunulmayan alana NULL geçilir → coalesce ile
    // mevcut değer korunur. RPC tarafında status='waiting' guard'ı uygulanır.
    // max_players küçültme mevcut davranışı korur: var olan oyuncular
    // kicklenmez, yalnız yeni katılım limiti değişir.
    const { error } = await supabase.rpc("wheel_group_update_settings", {
      p_room_id:        room.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    myClaimTokenRef.current,
      p_duration:       next.duration_seconds ?? null,
      p_region:         next.region ?? null,
      p_penalty:        next.penalty_enabled ?? null,
      p_max_players:    next.max_players ?? null,
    });
    if (error) {
      // Rollback realtime echo'ya bırakılır; en kötü eski değer geri gelir.
      console.error("[WheelGroup] update_settings RPC failed", error);
    }
  }

  async function kickPlayer(targetId: string) {
    if (!room || !isHost) return;
    if (targetId === myIdRef.current) return;
    // RPC server-side validation: authorize_host + status='waiting' guard +
    // self-kick reject. Hedef yoksa idempotent no-op (zaten ayrılmış).
    const { error } = await supabase.rpc("wheel_group_kick_player", {
      p_room_id:          room.id,
      p_host_player_id:   myIdRef.current,
      p_host_claim_token: myClaimTokenRef.current,
      p_target_player_id: targetId,
    });
    if (error) {
      console.error("[WheelGroup] kick_player RPC failed", error);
      setErrorMsg(
        describeWheelGroupRpcError(error) ?? "Oyuncu odadan çıkarılamadı.",
      );
      return;
    }
    setPlayers(prev => prev.filter(p => p.id !== targetId));
    setKickTarget(null);
  }

  /** Sonuç ekranından lobiye geri dön. Host ise oda 'finished' → 'waiting'.
   *  Misafir ise sadece phase 'lobby'ye geçer; realtime row UPDATE'iyle
   *  zaten host'tan gelen reset herkese yayılır.
   *  RPC tarafında status='finished' guard uygulanır → mid-game lobiye dönüş
   *  reddedilir (UI zaten yalnız finished fazında bu butonu gösteriyor). */
  async function returnToLobby() {
    playSound("click");
    if (!room) return;
    if (isHost) {
      const { error } = await supabase.rpc("wheel_group_return_to_lobby", {
        p_room_id:        room.id,
        p_host_player_id: myIdRef.current,
        p_claim_token:    myClaimTokenRef.current,
      });
      if (error) {
        console.error("[WheelGroup] return_to_lobby RPC failed", error);
      }
    }
    setFinalLeaderboard(null);
    setXpResult(null);
    xpAwardedRef.current = false;
    setWrongId(null);
    setLastClaimedTopoId(null);
    setPenaltyUntilMs(0);
    endingRef.current = false;
    prevTargetRef.current = null;
    setPhase("lobby");
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
            if (room) leaveRoom();
            onHome();
          }}
          title="Ana Menü"
        >
          <span>←</span>
          <span className="back-label">Menü</span>
        </button>

        <div className="duel-header-center">
          <span className="duel-mode-label">🏆 Çark · Çok Oyunculu</span>
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
            <h2 className="duel-lobby-title">🏆 Çark · Çok Oyunculu</h2>
            <p className="duel-lobby-desc">
              3–10 oyuncu. Hedef ülkeyi haritada ilk bulan +1 alır. En çok puan toplayan kazanır.
            </p>

            {hostClosedRoom && (
              <p className="duel-error" style={{ marginTop: 4 }}>
                Ev sahibi odayı kapattı.
              </p>
            )}

            <div className="duel-field-row">
              <label className="duel-field-label">Oyuncu Adın</label>
              {isLoggedInPlayer ? (
                <div
                  className="duel-name-input"
                  aria-readonly="true"
                  title="Login olduğun için adın profil hesabından alınır"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "default",
                    opacity: 0.95,
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 10px",
                      borderRadius: 999,
                      background: "rgba(79,139,255,0.18)",
                      border: "1px solid rgba(79,139,255,0.55)",
                      fontWeight: 800,
                      fontSize: 14,
                      letterSpacing: "0.01em",
                    }}
                  >
                    <span aria-hidden>👤</span>
                    <span>@{profile?.username}</span>
                  </span>
                  <span style={{ fontSize: 12, opacity: 0.65 }}>
                    olarak oynuyorsun
                  </span>
                </div>
              ) : (
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
              )}
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
                        <option key={d.value} value={d.value}>{d.label}</option>
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
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>

                <div className="duel-select-wrap">
                  <label className="duel-select-label">Ceza</label>
                  <div className="duel-select-box">
                    <select
                      className="duel-select"
                      value={hostPenalty ? "on" : "off"}
                      onChange={e => setHostPenalty(e.target.value === "on")}
                      disabled={phase === "creating"}
                    >
                      <option value="off">Cezasız</option>
                      <option value="on">Cezalı (1sn kilit)</option>
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

            {errorMsg && <p className="duel-error">{errorMsg}</p>}
            {statusMsg && phase === "creating" && !errorMsg && (
              <p className="duel-status">{statusMsg}</p>
            )}
          </div>
        </div>
      )}

      {/* ════════ LOBBY — 3-card grid ════════ */}
      {phase === "lobby" && room && (
        <>
        <div className="duel-lobby">
          <div className="wgg-grid">

            {/* ══ SOL KART: Oyuncular ══ */}
            <div className="duel-lobby-card wgg-players-card">
              {/* Başlık */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexShrink: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.02em" }}>👥 Oyuncular</span>
                <div ref={maxMenuDesktopRef} style={{ position: "relative" }}>
                  <button
                    type="button"
                    className={"wgg-max-badge" + (isHost ? " wgg-max-badge--host" : "")}
                    aria-haspopup={isHost ? "listbox" : undefined}
                    aria-expanded={isHost ? maxMenuAnchor === "desktop" : undefined}
                    disabled={!isHost}
                    onClick={() => {
                      if (!isHost) return;
                      playSound("click");
                      setMaxMenuAnchor(prev => prev === "desktop" ? null : "desktop");
                    }}
                  >
                    {players.length}/{room.max_players}
                  </button>
                  {maxMenuAnchor === "desktop" && isHost && (
                    <ul className="wgg-max-menu" role="listbox" aria-label="Maksimum oyuncu sayısı">
                      {MAX_PLAYER_OPTIONS.map(n => {
                        const selected = n === room.max_players;
                        const tooLow   = n < players.length;
                        return (
                          <li key={n} role="presentation">
                            <button
                              type="button"
                              role="option"
                              aria-selected={selected}
                              disabled={tooLow}
                              className={
                                "wgg-max-opt"
                                + (selected ? " wgg-max-opt--sel" : "")
                                + (tooLow   ? " wgg-max-opt--lo"  : "")
                              }
                              onClick={() => {
                                if (tooLow) return;
                                playSound("click");
                                setMaxMenuAnchor(null);
                                if (n !== room.max_players) {
                                  updateHostSetting({ max_players: n });
                                }
                              }}
                              title={tooLow ? `Şu an ${players.length} oyuncu var` : undefined}
                            >
                              <span>{n} kişi</span>
                              {selected && <span aria-hidden="true">✓</span>}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>

              {/* Oyuncu listesi — kart içinde scroll */}
              <div className="wgg-player-list">
                {Array.from({ length: Math.max(TOTAL_SLOTS, players.length) }, (_, i) => {
                  const p = players[i] ?? null;
                  const isClosed = i >= room.max_players;
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
                      <div key={`empty-${i}`} style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "5px 8px", borderRadius: 8,
                        border: "1px dashed rgba(255,255,255,0.10)", opacity: 0.22,
                      }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "rgba(255,255,255,0.3)", flexShrink: 0 }} />
                        <span style={{ fontSize: 12, fontStyle: "italic" }}>Boş slot</span>
                      </div>
                    );
                  }
                  const isMe = p.id === myIdRef.current;
                  const isPlayerHost = p.id === room.host_player_id;
                  return (
                    <div
                      key={p.id}
                      className={"duel-player-chip" + (isMe ? " mine" : "")}
                      style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 5, paddingBottom: 5, minWidth: 0 }}
                    >
                      {/* Sol: dot + nick + rozetler — nick kısalır, rozetler nick'e yapışık */}
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
                        <span className="duel-player-dot" style={{ flexShrink: 0 }} />
                        <span style={{
                          fontSize: 13, fontWeight: 600, minWidth: 0,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {p.name}
                        </span>
                        {isMe && <span className="duel-tag" style={{ flexShrink: 0, marginLeft: 2 }}>Sen</span>}
                        {isPlayerHost && <span className="duel-tag host" style={{ flexShrink: 0, marginLeft: 2 }}>👑</span>}
                      </div>
                      {/* Sağ: kick */}
                      {isHost && !isPlayerHost && (
                        <button type="button" className="dgg-kick-btn" style={{ flexShrink: 0 }} onClick={() => setKickTarget(p)}>
                          At
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Uyarı chip */}
              {players.length < MIN_PLAYERS && (
                <div style={{ marginTop: 10, flexShrink: 0 }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    fontSize: 12, fontWeight: 700, padding: "4px 12px", borderRadius: 999,
                    background: "rgba(212,160,44,0.16)", border: "1px solid rgba(212,160,44,0.45)",
                    color: "var(--amber, #d4a02c)", letterSpacing: "0.02em",
                  }}>
                    En az {MIN_PLAYERS} oyuncu gerekli — {MIN_PLAYERS - players.length} bekleniyor
                  </span>
                </div>
              )}
            </div>

            {/* ══ ORTA KART: Oda bilgisi + Ayarlar + Aksiyon ══ */}
            <div className="duel-lobby-card wgg-middle-card">
              {/* Status chip + oda kodu */}
              <div style={{ textAlign: "center", flexShrink: 0 }}>
                <div style={{
                  display: "inline-block", fontSize: 10, fontWeight: 800,
                  letterSpacing: "0.14em", textTransform: "uppercase",
                  padding: "3px 12px", borderRadius: 999,
                  background: isHost ? "rgba(79,139,255,0.14)" : "rgba(58,165,93,0.14)",
                  border: isHost ? "1px solid rgba(79,139,255,0.35)" : "1px solid rgba(58,165,93,0.35)",
                  color: isHost ? "var(--accent, #4f8bff)" : "var(--green, #3aa55d)",
                  marginBottom: 8,
                }}>
                  {isHost ? "Oda Hazır" : "Odaya Katıldın"}
                </div>
                <div style={{ fontSize: 40, fontWeight: 900, letterSpacing: "0.18em", lineHeight: 1.1, fontFamily: "monospace" }}>
                  {room.code}
                </div>
                <div style={{ fontSize: 12, opacity: 0.5, marginTop: 5, letterSpacing: "0.02em" }}>
                  6 haneli kod — arkadaşlarına ver
                </div>
              </div>

              {/* Davet bölümü */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                <button
                  className={"btn duel-invite-btn" + (copied ? " invited" : "")}
                  onClick={copyInvite}
                  style={{ width: "100%" }}
                >
                  {copied ? "✓ Davet mesajı kopyalandı!" : "📋 Davet Mesajını Kopyala"}
                </button>
                <div onClick={e => {
                  const el = (e.currentTarget as HTMLElement).querySelector("input") as HTMLInputElement | null;
                  el?.select();
                }}>
                  <input
                    className="duel-link-input"
                    readOnly
                    value={shareLink}
                    onFocus={e => e.target.select()}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                </div>
              </div>

              {/* Ayarlar: 3 kompakt dark select */}
              <section aria-label="Oda Ayarları" style={{
                display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8, padding: "10px 12px",
                background: "rgba(10,18,32,0.55)", border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 12, boxSizing: "border-box", flexShrink: 0,
              }}>
                <div className="duel-select-wrap" style={{ minWidth: 0, gap: 3 }}>
                  <label className="duel-select-label" style={{ fontSize: "0.62rem" }}>⏱ Süre</label>
                  <div className="duel-select-box">
                    <select className="duel-select" value={lobbyDuration} disabled={!isHost}
                      onChange={e => updateHostSetting({ duration_seconds: Number(e.target.value) })}
                      style={{ height: 34, fontSize: 12.5, padding: "0 26px 0 10px", opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                    >
                      {DURATION_OPTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>
                <div className="duel-select-wrap" style={{ minWidth: 0, gap: 3 }}>
                  <label className="duel-select-label" style={{ fontSize: "0.62rem" }}>🌍 Bölge</label>
                  <div className="duel-select-box">
                    <select className="duel-select" value={denormalizeRegion(lobbyRegionDb)} disabled={!isHost}
                      onChange={e => updateHostSetting({ region: normalizeRegion(e.target.value) })}
                      style={{ height: 34, fontSize: 12.5, padding: "0 26px 0 10px", opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                    >
                      {REGION_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>
                <div className="duel-select-wrap" style={{ minWidth: 0, gap: 3 }}>
                  <label className="duel-select-label" style={{ fontSize: "0.62rem" }}>⚠️ Ceza</label>
                  <div className="duel-select-box">
                    <select className="duel-select" value={lobbyPenalty ? "on" : "off"} disabled={!isHost}
                      onChange={e => updateHostSetting({ penalty_enabled: e.target.value === "on" })}
                      style={{ height: 34, fontSize: 12.5, padding: "0 26px 0 10px", opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                    >
                      <option value="off">Cezasız</option>
                      <option value="on">Cezalı (1sn)</option>
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>
              </section>

              {/* Spacer: butonları alta iter */}
              <div style={{ flex: 1 }} />

              {/* Aksiyonlar */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
                {isHost && (() => {
                  const canStart = players.length >= MIN_PLAYERS;
                  return (
                    <button
                      className={canStart ? "btn btn-accent" : "btn btn-ghost"}
                      onClick={startGame}
                      disabled={!canStart}
                      title={canStart ? "Oyunu başlat" : `En az ${MIN_PLAYERS} oyuncu gerekli`}
                      style={{
                        width: "100%", minHeight: 44, fontSize: 15, fontWeight: 800,
                        borderRadius: 12, letterSpacing: "0.02em",
                        opacity: canStart ? 1 : 0.65, cursor: canStart ? "pointer" : "not-allowed",
                        boxSizing: "border-box",
                      }}
                    >
                      🚀 Oyunu Başlat ({players.length} kişi)
                    </button>
                  );
                })()}
                <button
                  className="btn btn-ghost"
                  onClick={leaveRoom}
                  style={{ width: "100%", minHeight: 44, fontSize: 14, fontWeight: 700, borderRadius: 12, opacity: 0.85, boxSizing: "border-box" }}
                >
                  ← Lobiden Çık
                </button>
              </div>

              {errorMsg && <p className="duel-error" style={{ flexShrink: 0 }}>{errorMsg}</p>}
            </div>

            {/* ══ SAĞ KART: Sohbet ══ */}
            <div className="wgg-chat-card">
              <LobbyChat
                roomCode={room.code}
                playerName={isLoggedInPlayer ? (profile?.username ?? "").trim() : playerName.trim()}
                mobileSheetOpen={wggChatOpen}
                onMobileSheetOpenChange={v => { setWggChatOpen(v); if (v) setWggPlayersOpen(false); }}
                hideMobileFab={wggChatOpen || wggPlayersOpen}
                sendMode="wheel_group"
                playerId={myIdRef.current}
                claimToken={myClaimTokenRef.current}
              />
            </div>
          </div>
        </div>

        {/* ════ MOBİL: Oyuncular FAB — herhangi bir sheet açıkken gizle ════ */}
        {!wggChatOpen && !wggPlayersOpen && (
          <button
            type="button"
            className="wgg-players-fab"
            aria-label="Oyuncuları aç"
            onClick={() => { setWggPlayersOpen(true); setWggChatOpen(false); }}
          >
            <span>👥</span>
            <span>Oyuncular</span>
            <span className="wgg-players-fab-badge">{players.length}/{room.max_players}</span>
          </button>
        )}

        {/* ════ MOBİL: Oyuncular bottom-sheet ════ */}
        {wggPlayersOpen && (
          <div className="wgg-ps-backdrop" onClick={() => setWggPlayersOpen(false)}>
            <div className="wgg-ps-sheet" onClick={e => e.stopPropagation()}>
              <div className="wgg-ps-handle" />
              <header className="wgg-ps-header">
                <span className="wgg-ps-title">
                  <span>👥</span>
                  <span>Oyuncular</span>
                </span>
                <div ref={maxMenuMobileRef} style={{ position: "relative" }}>
                  <button
                    type="button"
                    className={"wgg-max-badge wgg-max-badge--sheet" + (isHost ? " wgg-max-badge--host" : "")}
                    aria-haspopup={isHost ? "listbox" : undefined}
                    aria-expanded={isHost ? maxMenuAnchor === "mobile" : undefined}
                    disabled={!isHost}
                    onClick={() => {
                      if (!isHost) return;
                      playSound("click");
                      setMaxMenuAnchor(prev => prev === "mobile" ? null : "mobile");
                    }}
                  >
                    {players.length}/{room.max_players}
                  </button>
                  {maxMenuAnchor === "mobile" && isHost && (
                    <ul className="wgg-max-menu wgg-max-menu--sheet" role="listbox" aria-label="Maksimum oyuncu sayısı">
                      {MAX_PLAYER_OPTIONS.map(n => {
                        const selected = n === room.max_players;
                        const tooLow   = n < players.length;
                        return (
                          <li key={n} role="presentation">
                            <button
                              type="button"
                              role="option"
                              aria-selected={selected}
                              disabled={tooLow}
                              className={
                                "wgg-max-opt"
                                + (selected ? " wgg-max-opt--sel" : "")
                                + (tooLow   ? " wgg-max-opt--lo"  : "")
                              }
                              onClick={() => {
                                if (tooLow) return;
                                playSound("click");
                                setMaxMenuAnchor(null);
                                if (n !== room.max_players) {
                                  updateHostSetting({ max_players: n });
                                }
                              }}
                              title={tooLow ? `Şu an ${players.length} oyuncu var` : undefined}
                            >
                              <span>{n} kişi</span>
                              {selected && <span aria-hidden="true">✓</span>}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                <button
                  type="button"
                  className="wgg-ps-close"
                  onClick={() => setWggPlayersOpen(false)}
                  aria-label="Kapat"
                >
                  ✕
                </button>
              </header>
              <div className="wgg-ps-list">
                {Array.from({ length: Math.max(TOTAL_SLOTS, players.length) }, (_, i) => {
                  const p = players[i] ?? null;
                  const isClosed = i >= room.max_players;
                  if (!p) {
                    if (isClosed) {
                      return (
                        <div key={`closed-${i}`} className="wgg-slot-closed wgg-slot-closed--sheet" aria-disabled="true">
                          <span className="wgg-slot-closed-icon" aria-hidden="true">🔒</span>
                          <span className="wgg-slot-closed-label">Kapalı slot</span>
                        </div>
                      );
                    }
                    return (
                      <div key={`empty-${i}`} className="wgg-ps-empty-slot">
                        <span className="wgg-ps-dot-empty" />
                        <span>Boş slot</span>
                      </div>
                    );
                  }
                  const isMe = p.id === myIdRef.current;
                  const isPlayerHost = p.id === room.host_player_id;
                  return (
                    <div
                      key={p.id}
                      className={"duel-player-chip" + (isMe ? " mine" : "")}
                      style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 6, paddingBottom: 6, minWidth: 0 }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
                        <span className="duel-player-dot" style={{ flexShrink: 0 }} />
                        <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {p.name}
                        </span>
                        {isMe && <span className="duel-tag" style={{ flexShrink: 0, marginLeft: 2 }}>Sen</span>}
                        {isPlayerHost && <span className="duel-tag host" style={{ flexShrink: 0, marginLeft: 2 }}>👑</span>}
                      </div>
                      {isHost && !isPlayerHost && (
                        <button
                          type="button"
                          className="dgg-kick-btn"
                          style={{ flexShrink: 0 }}
                          onClick={() => { setKickTarget(p); setWggPlayersOpen(false); }}
                        >
                          At
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {players.length < MIN_PLAYERS && (
                <div className="wgg-ps-warning">
                  En az {MIN_PLAYERS} oyuncu gerekli — {MIN_PLAYERS - players.length} bekleniyor
                </div>
              )}
            </div>
          </div>
        )}
        </>
      )}

      {/* ════════ PLAYING (finished'da da arka plan render kalsın) ════════ */}
      {(phase === "playing" || phase === "finished") && room && (() => {
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
            ? new Set<string>()
            : getContinentIds(regionDenorm as Continent);
        const clickableIds =
          regionDenorm === "world"
            ? new Set(buildTargetPool("world"))
            : activeIds;
        const usedSet = new Set(room.used_target_topoids ?? []);
        const timerColor =
          timeLeft <= 5 ? "var(--red, #e25555)"
          : timeLeft <= 15 ? "var(--amber, #d4a02c)"
          : "var(--accent, #4f8bff)";

        const penaltyRemain = Math.max(0, penaltyUntilMs - Date.now());

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
                    <div className="wd-target wd-target-claimed">{lastClaimDisplay}</div>
                  </>
                ) : (
                  <>
                    <div className="wd-hud-label">…</div>
                    <div className="wd-target wd-target-muted">Sıradaki hedef seçiliyor</div>
                  </>
                )}
              </div>

              <div className="wd-hud-right">
                <div className="wd-hud-label">⏱ Süre</div>
                <div className="wd-timer" style={{ color: timerColor }}>{timeLeft}</div>
              </div>
            </div>

            {/* Compact live leaderboard */}
            <div
              className="dgg-leaderboard"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                justifyContent: "center",
                padding: "4px 8px 8px",
              }}
            >
              {leaderboard.slice(0, 10).map((entry, idx) => (
                <div
                  key={entry.playerId}
                  className={"dgg-lb-row" + (entry.isMe ? " mine" : "")}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    borderRadius: 999,
                    background: entry.isMe
                      ? "rgba(79,139,255,0.18)"
                      : "rgba(255,255,255,0.06)",
                    border: entry.isMe
                      ? "1px solid rgba(79,139,255,0.55)"
                      : "1px solid rgba(255,255,255,0.08)",
                    fontSize: 13,
                    lineHeight: 1.2,
                    whiteSpace: "nowrap",
                  }}
                >
                  <span style={{ opacity: 0.7, fontWeight: 700 }}>#{idx + 1}</span>
                  <span style={{ fontWeight: 600 }}>
                    {entry.name}
                    {entry.isHost && <span style={{ marginLeft: 4 }}>👑</span>}
                  </span>
                  <span style={{ fontWeight: 800, marginLeft: 4 }}>{entry.score}</span>
                </div>
              ))}
            </div>

            {room.penalty_enabled && penaltyRemain > 0 && (
              <div
                style={{
                  textAlign: "center",
                  fontSize: 12,
                  color: "var(--red, #e25555)",
                  margin: "0 0 4px",
                }}
              >
                ⛔ Tıklama kilidi: {Math.ceil(penaltyRemain / 100) / 10} sn
              </div>
            )}

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

      {/* ════════ FINISHED — overlay ════════ */}
      {phase === "finished" && room && (() => {
        const board = finalLeaderboard ?? leaderboard.map(b => ({
          playerId: b.playerId, name: b.name, score: b.score,
        }));
        const myRank = board.findIndex(b => b.playerId === myIdRef.current) + 1;
        const me = board.find(b => b.playerId === myIdRef.current);
        const myScore = me?.score ?? 0;
        const top = board[0]?.score ?? 0;
        const iWon = myScore > 0 && myScore === top;
        const reasonText = room.finished_reason === "pool"
          ? "Tüm ülkeler kullanıldı."
          : "Süre doldu.";
        const titleText = iWon ? "KAZANDIN!" : "OYUN BİTTİ";
        const emoji = iWon ? "🏆" : "🏁";

        // Top 3 podium + full table data
        const podium = board.slice(0, 3);

        // XP status badge content
        let xpStatusBadge: { label: string; color: string; title?: string } | null = null;
        if (xpResult?.status === "awarded") {
          xpStatusBadge = {
            label: `✓ +${xpResult.xpEarned} XP kaydedildi`,
            color: "var(--green, #3aa55d)",
          };
        } else if (xpResult?.status === "already") {
          xpStatusBadge = {
            label: "↺ Bu maç için XP zaten kaydedilmişti",
            color: "var(--muted, #9aa0a6)",
          };
        } else if (xpResult?.status === "pending") {
          xpStatusBadge = {
            label: "… XP kaydediliyor",
            color: "var(--muted, #9aa0a6)",
          };
        } else if (xpResult?.status === "error") {
          xpStatusBadge = {
            label: "⚠️ XP kaydedilemedi",
            color: "var(--red, #e25555)",
            title: xpResult.errorMsg ?? "RPC hatası",
          };
        } else if (xpResult?.status === "not_logged") {
          xpStatusBadge = {
            label: "ⓘ XP almak için giriş yap",
            color: "var(--muted, #9aa0a6)",
          };
        }

        // ── Iki ayrı kart layout için stiller ─────────────────────
        // Desktop (≥900px): row, scoreboard solda, sonuç kartı ortada
        // Mobil (<900px): column, sonuç kartı üstte, scoreboard altta
        // Backdrop'ta scroll alıyoruz; iki kart birlikte ekrana sığmazsa
        // tüm backdrop kaydırılır. Bu, mobilde "Lobiye Dön / Ana Menü"
        // butonlarına erişimi her zaman garantiler.
        const scoreboardCardStyle: React.CSSProperties = {
          width: isWideViewport ? 320 : "100%",
          maxWidth: "96vw",
          maxHeight: isWideViewport ? "min(640px, 88vh)" : 360,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "rgba(15, 18, 28, 0.86)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 16,
          padding: 14,
          boxSizing: "border-box",
          boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
          // Mobilde sonuç kartından sonra gelmeli; desktop'ta solda (önce).
          order: isWideViewport ? 0 : 1,
        };

        const resultCardOverrides: React.CSSProperties = {
          maxWidth: "min(560px, 96vw)",
          width: "100%",
          maxHeight: isWideViewport ? "min(720px, 92vh)" : "none",
          overflowY: isWideViewport ? "auto" : "visible",
          padding: "20px 22px",
          boxSizing: "border-box",
          order: isWideViewport ? 1 : 0,
        };

        return (
          <div
            className="wheel-result-backdrop"
            style={{
              // Backdrop kendisi tam ekran scroll alanı olsun (özellikle mobilde)
              overflowY: "auto",
              padding: isWideViewport ? "24px" : "16px 12px",
              boxSizing: "border-box",
              alignItems: isWideViewport ? "center" : "flex-start",
            }}
          >
            <div
              className="wgg-result-layout"
              style={{
                display: "flex",
                flexDirection: isWideViewport ? "row" : "column",
                alignItems: isWideViewport ? "flex-start" : "stretch",
                justifyContent: "center",
                gap: isWideViewport ? 22 : 14,
                width: "100%",
                maxWidth: isWideViewport ? 940 : 600,
                margin: "0 auto",
              }}
            >
              {/* ─── Kart 1: Tam Puan Tablosu (sol/desktop · alt/mobil) ─── */}
              <aside style={scoreboardCardStyle} aria-label="Tam Puan Tablosu">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 10,
                    paddingBottom: 8,
                    borderBottom: "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 14,
                      fontWeight: 800,
                      letterSpacing: "0.02em",
                    }}
                  >
                    📋 Tam Puan Tablosu
                  </h3>
                  <span style={{ fontSize: 11, opacity: 0.7, fontWeight: 600 }}>
                    {board.length} oyuncu
                  </span>
                </div>

                <div
                  style={{
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    paddingRight: 4,
                    flex: 1,
                    minHeight: 0,
                  }}
                >
                  {board.map((entry, idx) => {
                    const isMe = entry.playerId === myIdRef.current;
                    const medal =
                      idx === 0 ? "🥇"
                      : idx === 1 ? "🥈"
                      : idx === 2 ? "🥉"
                      : `#${idx + 1}`;
                    return (
                      <div
                        key={entry.playerId}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "36px 1fr auto",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 8px",
                          borderRadius: 8,
                          background: isMe
                            ? "rgba(79,139,255,0.18)"
                            : idx < 3
                              ? "rgba(255,255,255,0.04)"
                              : "transparent",
                          border: isMe
                            ? "1px solid rgba(79,139,255,0.55)"
                            : "1px solid transparent",
                          fontSize: 13,
                          lineHeight: 1.25,
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 800,
                            fontSize: idx < 3 ? 18 : 13,
                            textAlign: "center",
                            opacity: idx < 3 ? 1 : 0.7,
                          }}
                        >
                          {medal}
                        </span>
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            minWidth: 0,
                            fontWeight: isMe ? 800 : 600,
                          }}
                        >
                          <span
                            style={{
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              flex: 1,
                              minWidth: 0,
                            }}
                          >
                            {entry.name}
                          </span>
                          {isMe && (
                            <span
                              style={{
                                fontSize: 10,
                                padding: "1px 6px",
                                borderRadius: 999,
                                background: "rgba(79,139,255,0.55)",
                                color: "#fff",
                                fontWeight: 700,
                                letterSpacing: "0.03em",
                                flexShrink: 0,
                              }}
                            >
                              Sen
                            </span>
                          )}
                        </span>
                        <span
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 6,
                            justifyContent: "flex-end",
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 800,
                              fontVariantNumeric: "tabular-nums",
                              minWidth: 22,
                              textAlign: "right",
                            }}
                            title="Doğru sayısı"
                          >
                            {entry.score}
                          </span>
                          {isMe && xpResult && (
                            <span
                              style={{
                                fontSize: 10,
                                color: "var(--accent, #4f8bff)",
                                fontWeight: 700,
                                fontVariantNumeric: "tabular-nums",
                              }}
                              title="Bu maçta kazandığın XP"
                            >
                              +{xpResult.breakdown.total} XP
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: "1px solid rgba(255,255,255,0.08)",
                    fontSize: 11,
                    opacity: 0.6,
                    textAlign: "center",
                  }}
                >
                  Toplam {board.reduce((s, b) => s + b.score, 0)} doğru claim
                </div>
              </aside>

              {/* ─── Kart 2: Sonuç (orta/desktop · üst/mobil) ─── */}
              <div
                className="wheel-result-panel wgg-result-panel"
                style={resultCardOverrides}
              >
              <div className="wheel-result-emoji">{emoji}</div>
              <h2 className="wheel-result-title">{titleText}</h2>
              <p
                className="duel-lobby-desc"
                style={{ margin: "0 0 10px", fontSize: "0.95rem" }}
              >
                {reasonText}
              </p>

              {/* Top 3 podium */}
              {podium.length > 0 && (
                <div
                  className="dgg-final-board wgg-podium"
                  style={{
                    marginTop: 4,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {podium.map((entry, idx) => {
                    const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : "🥉";
                    const isMe = entry.playerId === myIdRef.current;
                    return (
                      <div
                        key={entry.playerId}
                        className={
                          "dgg-final-row" +
                          (isMe ? " mine" : "") +
                          (idx === 0 ? " winner" : "")
                        }
                      >
                        <span className="dgg-final-rank">{medal}</span>
                        <span className="dgg-final-name">
                          {entry.name}
                          {isMe && <span className="dgg-lb-you"> (Sen)</span>}
                        </span>
                        <span className="dgg-final-score">{entry.score}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* XP breakdown + status */}
              {xpResult && (
                <div style={{ marginTop: 10 }}>
                  <div
                    className="duel-result-meta"
                    style={{
                      fontSize: 13,
                      display: "flex",
                      gap: 10,
                      justifyContent: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <span>⭐ +{xpResult.breakdown.total} XP</span>
                    <span className="duel-sum-dot">·</span>
                    <span>Katılım +{xpResult.breakdown.participation}</span>
                    <span className="duel-sum-dot">·</span>
                    <span>
                      {xpResult.breakdown.correctCount}×+{xpResult.breakdown.perCorrect}
                      {" = +"}{xpResult.breakdown.correctTotal}
                    </span>
                    {xpResult.breakdown.rankBonus > 0 && (
                      <>
                        <span className="duel-sum-dot">·</span>
                        <span>Sıra bonusu +{xpResult.breakdown.rankBonus}</span>
                      </>
                    )}
                  </div>
                  {xpStatusBadge && (
                    <div
                      style={{
                        marginTop: 6,
                        textAlign: "center",
                        fontSize: 12,
                        color: xpStatusBadge.color,
                        fontWeight: 700,
                      }}
                      title={xpStatusBadge.title}
                    >
                      {xpStatusBadge.label}
                    </div>
                  )}
                </div>
              )}

              <div className="duel-result-meta" style={{ marginTop: 10 }}>
                <span>⏱ {durationLabel(room.duration_seconds)}</span>
                <span className="duel-sum-dot">·</span>
                <span>{regionLabel(room.region)}</span>
                <span className="duel-sum-dot">·</span>
                <span>{room.penalty_enabled ? "Cezalı" : "Cezasız"}</span>
                <span className="duel-sum-dot">·</span>
                <span>Sıra #{Math.max(1, myRank)}</span>
              </div>

              <div className="wheel-result-actions">
                <button
                  type="button"
                  className="wheel-primary-btn"
                  onClick={returnToLobby}
                >
                  ↩ Lobiye Dön
                </button>
                <button
                  type="button"
                  className="wheel-ghost-btn"
                  onClick={() => {
                    playSound("click");
                    leaveRoom();
                    onHome();
                  }}
                >
                  ⌂ Ana Menü
                </button>
              </div>
              </div>
              {/* /Kart 2 — sonuç */}
            </div>
            {/* /wgg-result-layout */}
          </div>
        );
      })()}

      {/* ════════ XP KAZANIMI — fixed footer (reusable XpGainBar) ════════ */}
      {phase === "finished"
        && xpResult
        && xpFooterVisible
        && !xpResult.dismissed
        && (xpResult.status === "awarded" || xpResult.status === "already") && (
        <XpGainBar
          key={xpResult.roomKey}
          modeLabel="Çark Grup"
          prevTotalXp={xpResult.prevTotalXp}
          newTotalXp={xpResult.totalXp}
          prevModeXp={xpResult.prevModeXp}
          newModeXp={xpResult.modeXp}
          xpEarned={xpResult.xpEarned}
          awarded={xpResult.status === "awarded"}
          breakdown={xpResult.breakdown}
          onDismiss={() =>
            setXpResult(prev => (prev ? { ...prev, dismissed: true } : null))
          }
        />
      )}

      {/* ════════ KICK CONFIRM MODAL ════════ */}
      {kickTarget && (
        <div className="dgg-confirm-backdrop" onClick={() => setKickTarget(null)}>
          <div className="dgg-confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="dgg-confirm-icon">⚠️</div>
            <h3>Oyuncuyu odadan çıkar</h3>
            <p>
              <strong>{kickTarget.name}</strong> adlı oyuncuyu odadan çıkarmak istediğine emin misin?
            </p>
            <div className="dgg-confirm-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setKickTarget(null)}
              >
                Vazgeç
              </button>
              <button
                type="button"
                className="dgg-confirm-danger"
                onClick={() => kickPlayer(kickTarget.id)}
              >
                Odadan At
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ NEW HOST NOTICE ════════ */}
      {newHostModalOpen && (
        <div
          className="dgg-confirm-backdrop"
          onClick={() => setNewHostModalOpen(false)}
        >
          <div
            className="dgg-confirm-modal"
            onClick={e => e.stopPropagation()}
          >
            <div className="dgg-confirm-icon">👑</div>
            <h3>YENİ ODA SAHİBİ SİZSİNİZ</h3>
            <p>Oda sahibi ayrıldı. Odayı artık siz yönetiyorsunuz.</p>
            <div className="dgg-confirm-actions single">
              <button
                type="button"
                className="btn btn-accent"
                onClick={() => setNewHostModalOpen(false)}
              >
                Tamam
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ KICKED NOTICE ════════ */}
      {kickedNoticeOpen && (
        <div
          className="dgg-confirm-backdrop"
          onClick={() => setKickedNoticeOpen(false)}
        >
          <div
            className="dgg-confirm-modal"
            onClick={e => e.stopPropagation()}
          >
            <div className="dgg-confirm-icon">🚪</div>
            <h3>Odadan Çıkarıldın</h3>
            <p>Oda sahibi seni odadan çıkardı.</p>
            <div className="dgg-confirm-actions single">
              <button
                type="button"
                className="btn btn-accent"
                onClick={() => setKickedNoticeOpen(false)}
              >
                Tamam
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
