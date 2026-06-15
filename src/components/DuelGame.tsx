/**
 * DuelGame.tsx — Online 1v1 Ülke Yaz (v3)
 *
 * ⚠️  Supabase setup (gerekli SQL):
 *
 *   ALTER TABLE duel_rooms
 *     ADD COLUMN IF NOT EXISTS duration_seconds int  NOT NULL DEFAULT 60,
 *     ADD COLUMN IF NOT EXISTS region          text NOT NULL DEFAULT 'world';
 *
 *   -- Heartbeat presence column (already applied):
 *   ALTER TABLE duel_players
 *     ADD COLUMN IF NOT EXISTS last_seen_at timestamptz DEFAULT now();
 *
 *   -- RLS: anon users must be able to INSERT into all 3 tables.
 *   -- If INSERT fails with "permission denied", run:
 *   ALTER TABLE duel_rooms   ENABLE ROW LEVEL SECURITY;
 *   ALTER TABLE duel_players ENABLE ROW LEVEL SECURITY;
 *   ALTER TABLE duel_claims  ENABLE ROW LEVEL SECURITY;
 *
 *   CREATE POLICY "anon_insert_rooms"   ON duel_rooms   FOR INSERT TO anon WITH CHECK (true);
 *   CREATE POLICY "anon_select_rooms"   ON duel_rooms   FOR SELECT TO anon USING (true);
 *   CREATE POLICY "anon_update_rooms"   ON duel_rooms   FOR UPDATE TO anon USING (true);
 *   CREATE POLICY "anon_insert_players" ON duel_players FOR INSERT TO anon WITH CHECK (true);
 *   CREATE POLICY "anon_select_players" ON duel_players FOR SELECT TO anon USING (true);
 *   CREATE POLICY "anon_update_players" ON duel_players FOR UPDATE TO anon USING (true);
 *   CREATE POLICY "anon_insert_claims"  ON duel_claims  FOR INSERT TO anon WITH CHECK (true);
 *   CREATE POLICY "anon_select_claims"  ON duel_claims  FOR SELECT TO anon USING (true);
 *
 *   -- Also enable Realtime on all three tables.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase, type DuelRoom, type DuelPlayer, type DuelClaim } from "../lib/supabase";
import {
  calculateCountryDuelXp,
  resultFromScores,
  awardXpEvent,
  type XpBreakdown,
} from "../lib/progression";
import {
  recordOnlineMatchResult,
  recordGameComplete,
  recordOnlineCorrectCountries,
} from "../lib/achievementStats";
import XpGainBar from "./XpGainBar";
import { DuelMapView } from "./WorldMap";
import LobbyChat from "./LobbyChat";
import {
  playSound,
  stopSound,
  shouldPlayCountdownSound,
  type CountdownSoundMode,
} from "../lib/sound";
import { NAME_TO_TOPOID, normalizeInput, getContinentIds, type Continent } from "../data/countries";
import { validateUsername, type Profile } from "../lib/auth";
import { useInviteJoin } from "../lib/useInviteJoin";
import { readStoredHomeTheme, getThemeBackgroundStyle, getThemeDataAttr } from "../lib/themeBackgrounds";
import { getSyncedNowMs, initServerClockSync } from "../lib/serverClock";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerProfileTrigger } from "./PlayerProfileTrigger";
import { LobbyInviteBar } from "./LobbyInviteBar";
import { useRosterProfiles } from "../lib/useRosterProfiles";
import { useSocialOptional } from "./SocialContext";

/* ─── options ─── */
const DURATION_OPTS = [
  { label: "30 sn", value: 30  },
  { label: "1 dk",  value: 60  },
  { label: "2 dk",  value: 120 },
  { label: "3 dk",  value: 180 },
  { label: "5 dk",  value: 300 },
];

const REGION_OPTS = [
  { label: "🌍 Dünya",          value: "world"         },
  { label: "🇪🇺 Avrupa",        value: "europe"        },
  { label: "🌏 Asya",           value: "asia"          },
  { label: "🌍 Afrika",         value: "africa"        },
  { label: "🌎 Kuzey Amerika",  value: "north-america" },
  { label: "🌎 Güney Amerika",  value: "south-america" },
  { label: "🌊 Okyanusya",      value: "oceania"       },
];

/**
 * Normalize region value for consistent DB storage and lookup.
 * Supabase LIKE queries are case-sensitive; we always write the same string.
 * UI labels can differ, but DB always stores exactly these values.
 */
const normalizeRegion = (r: string): string => {
  const map: Record<string, string> = {
    "north-america": "north_america",
    "south-america": "south_america",
    // already normalized or other regions pass through
  };
  return map[r] ?? r;
};

const denormalizeRegion = (r: string): string => {
  // Convert DB value back to getContinentIds key
  const map: Record<string, string> = {
    "north_america": "north-america",
    "south_america": "south-america",
  };
  return map[r] ?? r;
};

/* ─── localStorage helpers ─── */
const PLAYER_ID_KEY = "geoquiz_duel_player_id";   // persists across rooms (resume)
const ROOM_KEY      = "geoquiz_duel_room";         // current room session
const GUEST_ID_KEY  = "geoquiz_duel_guest_id";     // stabil guest_id (logged-out)

const DUEL_VERSION = "Online v3";

function makeCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

/* ─── debug logger ─── */
function dbg(label: string, obj?: unknown) {
  console.log(`[DuelGame ${DUEL_VERSION}] ${label}`, obj ?? "");
}
function dbgErr(label: string, err?: unknown, ctx?: unknown) {
  console.error(`[DuelGame ${DUEL_VERSION}] ❌ ${label}`, err, ctx ?? "");
}

/**
 * Generate a fresh player UUID for a new room.
 * We intentionally generate a new one each time "Oda Kur" is pressed
 * so old player rows in Supabase never collide.
 * The new ID is written to localStorage so "resume on reload" works
 * for the current room only.
 */
function freshPlayerId(): string {
  const id = crypto.randomUUID();
  localStorage.setItem(PLAYER_ID_KEY, id);
  dbg("freshPlayerId generated", id);
  return id;
}

/**
 * Fresh claim_token: M1'de eklenen duel_player_claims tablosuna her yeni
 * player satırı için bir tane yazılır. Mevcut session'la birlikte persist
 * edilir; reload sonrasında aynı player_id ile devam edebilmek için kritik.
 */
function freshClaimToken(): string {
  return crypto.randomUUID();
}

interface RoomSession {
  roomId:     string;
  roomCode:   string;
  playerId:   string;
  /** M1+M2 claim-token — RPC'ler authorize_player için bunu bekliyor */
  claimToken: string;
}

function saveRoomSession(
  roomId:     string,
  roomCode:   string,
  playerId:   string,
  claimToken: string,
) {
  localStorage.setItem(
    ROOM_KEY,
    JSON.stringify({ roomId, roomCode, playerId, claimToken }),
  );
}
function loadRoomSession(): RoomSession | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Required fields — claimToken eski sürümlerde olmayabilir; o satırları
    // null sayıp resume akışını fresh path'e düşürüyoruz.
    if (!parsed?.roomId || !parsed?.roomCode || !parsed?.playerId) return null;
    if (!parsed?.claimToken) return null;
    return parsed as RoomSession;
  } catch { return null; }
}

/**
 * Misafir kullanıcılar için stabil guest_id. Logged-in kullanıcılar için
 * profile.id kullanılır; bu fonksiyon yalnız profile yokken çağrılmalı.
 */
function ensureGuestId(): string {
  let g = localStorage.getItem(GUEST_ID_KEY);
  if (!g) {
    g = crypto.randomUUID();
    localStorage.setItem(GUEST_ID_KEY, g);
  }
  return g;
}

/**
 * Full duel session reset — clears ALL duel-related localStorage keys
 * EXCEPT guest_id (stabil kalmalı, aksi halde her oturumda yeni misafir
 * kimliği üretilirdi).
 * Call before creating a new room or on explicit logout/menu navigation.
 */
function clearDuelSession() {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("geoquiz_duel") && k !== GUEST_ID_KEY) {
      keysToRemove.push(k);
    }
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));
  dbg("clearDuelSession: removed", keysToRemove);
}

/* ─── Duel RPC error mapper ──────────────────────────────────────────
 *  M2 RPC'leri PG raise exception ile business hata mesajları döner
 *  (örn. 'room_full', 'name_taken'). Bunları kullanıcı dostu Türkçe
 *  metne çevirir. Mevcut UI metinleri ile birebir uyumlu kalır.
 */
interface DuelRpcError { code?: string; message?: string; details?: string }
function describeDuelRpcError(err: DuelRpcError | null | undefined): string {
  if (!err) return "İşlem başarısız.";
  const m = (err.message ?? "") + " " + (err.details ?? "");
  if (m.includes("code_taken"))               return "Bu kod kullanımda. Tekrar dene.";
  // display_name_forbidden ve registered_username_taken, name_taken/name_invalid'dan
  // ÖNCE kontrol edilmeli — helper bu hataları RPC body'sinin başında fırlatıyor.
  if (m.includes("display_name_forbidden"))   return "Bu nick kullanılamaz. Lütfen farklı bir nick dene.";
  if (m.includes("registered_username_taken"))return "Bu nick zaten kayıtlı. Giriş yap ya da farklı bir nick dene.";
  if (m.includes("name_taken"))               return "Bu odada bu isim zaten kullanılıyor.";
  if (m.includes("room_full"))                return "Oda dolu (2 oyuncu mevcut).";
  if (m.includes("room_not_found"))           return "Oda bulunamadı. Kodu kontrol et.";
  if (m.includes("old_room_not_found"))       return "Önceki oda bulunamadı.";
  if (m.includes("old_room_not_finished"))    return "Önceki maç henüz bitmedi.";
  if (m.includes("room_finished"))            return "Bu maç zaten bitti.";
  if (m.includes("room_in_progress"))         return "Maç zaten devam ediyor. Katılamazsın.";
  if (m.includes("room_not_waiting_rematch")) return "Rövanş odası hazır değil.";
  if (m.includes("room_not_waiting"))         return "Oda artık bekleme aşamasında değil.";
  if (m.includes("room_not_playing"))         return "Oda artık oyunda değil.";
  if (m.includes("not_enough_players"))       return "Yeterli oyuncu yok.";
  if (m.includes("name_invalid"))             return "Oyuncu adı 2–16 karakter olmalı.";
  if (m.includes("profile_mismatch"))         return "Oturum doğrulaması başarısız.";
  if (m.includes("player_room_mismatch"))     return "Bu odada oyuncun yok.";
  if (m.includes("room_code_mismatch"))       return "Oda doğrulaması başarısız.";
  if (m.includes("unauthorized"))             return "Bu işlem için yetkin yok.";
  if (m.includes("room_unavailable"))         return "Oda kullanılamıyor.";
  if (err.code === "42501")                   return "Veritabanı izin hatası.";
  return err.message || "İşlem başarısız.";
}


/* ─── region allow-list ─── */
function buildAllowedSet(region: string): Set<string> | null {
  if (region === "world") return null;
  // Denormalize DB value (e.g. "north_america" → "north-america") before getContinentIds
  const key = denormalizeRegion(region);
  return getContinentIds(key as Continent);
}

/* ─── phase ─── */
type DuelPhase = "lobby" | "creating" | "searching" | "waiting" | "playing" | "finished";

/* ─── HIZLI EŞLEŞ ───
 *  Bayrak/Çark deseni ile birebir simetrik:
 *  - 3 sn aralıkla country_duel_quick_match RPC çağrısı
 *  - Bekleme süresine göre bracket genişler
 *  - RPC tarafı LEAST(caller, candidate) uygular → simetrik kabul
 */
const QUICK_MATCH_TICK_MS = 3000;

function quickMatchBracket(searchSeconds: number): number {
  if (searchSeconds < 10) return 0;
  if (searchSeconds < 20) return 2;
  if (searchSeconds < 30) return 5;
  if (searchSeconds < 60) return 15;
  return 9999;
}

interface DuelGameProps {
  onHome: () => void;
  profile?: Profile | null;
  countdownSoundMode?: CountdownSoundMode;
}

export default function DuelGame({
  onHome,
  profile,
  countdownSoundMode = "last20",
}: DuelGameProps) {
  /* identity — set fresh for each new room, loaded from session on resume */
  const myIdRef = useRef<string>("");
  // Convenience getter so we don't change 30+ call sites
  const myId = myIdRef.current;

  /* claim-token ref — session restore'da yüklenir, fresh akışlarda set edilir */
  const claimTokenRef = useRef<string>("");

  /** RPC'lere profile_id / guest_id paramını üreten helper. M1'in identity
   *  XOR'unu (profile XOR guest) garanti altına alır:
   *   - Giriş yapmışsa profile.id; guest_id null
   *   - Misafirse profile null; stabil guest_id (localStorage) */
  const getIdentityArgs = useCallback((): { profileId: string | null; guestId: string | null } => {
    if (profile?.id) return { profileId: profile.id, guestId: null };
    return { profileId: null, guestId: ensureGuestId() };
  }, [profile?.id]);

  /* lobby form */
  const [playerName,   setPlayerName]   = useState("");
  const loggedInUsername = profile?.username ?? "";
  const effectivePlayerName = loggedInUsername || playerName;
  const isLoggedInPlayer = !!loggedInUsername;

  const [joinCode,     setJoinCode]     = useState("");
  /** Davet linkinden gelen oda kodu override. joinRoom çağrıldığında
   *  joinCode state'i henüz flush olmamış olabileceği için (useInviteJoin
   *  setJoinCode + triggerJoin'i aynı tick'te tetikler) ref üzerinden
   *  geçiyoruz. joinRoom okur okumaz tüketir ve null'a çeker. */
  const inviteOverrideCodeRef = useRef<string | null>(null);
  const [hostDuration, setHostDuration] = useState(60);
  const [hostRegion,   setHostRegion]   = useState("world");

  /* phase / messages */
  const [phase,     setPhase]     = useState<DuelPhase>("lobby");
  const [errorMsg,  setErrorMsg]  = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [hostClosedRoom, setHostClosedRoom] = useState(false);

  /* game state */
  const [room,        setRoom]        = useState<DuelRoom | null>(null);
  const [players,     setPlayers]     = useState<DuelPlayer[]>([]);
  const [claims,      setClaims]      = useState<DuelClaim[]>([]);
  // Sosyal: roster avatarları (tek batched RPC) + odadayken davet için room context.
  const rosterProfiles = useRosterProfiles(players.map((p) => p.profile_id ?? null));
  const social = useSocialOptional();
  useEffect(() => {
    if (!social) return;
    const code = room?.code;
    if (code) social.setRoomContext({ code, mode: "duel", roomUrl: `/?duel=${code}` });
    return () => social.setRoomContext(null);
  }, [social, room?.code]);
  const [timeLeft,    setTimeLeft]    = useState(60);
  const [isHost,      setIsHost]      = useState(false);
  const [input,       setInput]       = useState("");
  const [feedback,    setFeedback]    = useState<"ok" | "err" | "dup" | "region" | null>(null);
  const [isQuickMatch,  setIsQuickMatch]  = useState(false);
  const [showLabels,    setShowLabels]    = useState(true);
  const [quitModal,    setQuitModal]    = useState(false);
  // "idle" = main options, "forfeit" = confirm forfeit, "menu" = confirm menu exit
  type QuitStep = "idle" | "forfeit" | "menu";
  const [quitStep, setQuitStep] = useState<QuitStep>("idle");

  // Rematch state
  type RematchState = "idle" | "requested" | "received" | "declined";
  const [rematch, setRematch] = useState<RematchState>("idle");

  /* ── Hızlı Eşleş state + ref'ler (Bayrak/Çark deseni) ──
   *  searching → polling RPC ile rakip arar; bracket genişler.
   *  Eşleşince RPC matched_room_id UPDATE yapar (bekleyen client realtime
   *  ile yakalar) veya RPC dönüşünden caller direkt joinQuickMatchRoom çağırır.
   *  Sonra phase 'playing' olur; started_at gelecekte (now()+3s) iken
   *  countdown overlay 3sn boyunca gösterilir.
   */
  const [searchSeconds,    setSearchSeconds]    = useState(0);
  const [countdownSeconds, setCountdownSeconds] = useState(0);
  const quickMatchTickRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const quickMatchSecondsRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const quickMatchStartMsRef   = useRef<number>(0);
  const quickMatchAbortRef     = useRef(false);
  const quickMatchJoinedRef    = useRef(false);
  const quickMatchCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Frozen scores at game end — prevent late realtime claims from changing result display
  const [finalScores, setFinalScores] = useState<{ my: number; opp: number } | null>(null);
  // ── XP (sadece giriş yapmış kullanıcı için, maç başına 1 kez) ──
const [xpResult, setXpResult] = useState<{
  awarded:     boolean;
  xpEarned:    number;
  prevTotalXp: number;
  totalXp:     number;
  prevModeXp:  number;
  modeXp:      number;
  breakdown:   XpBreakdown;
  /** Footer'ın React `key`'i — rematch sonrası temiz mount için. */
  roomKey:     string;
  /** Kullanıcı X'e bastıysa veya auto-dismiss tetiklendiyse. */
  dismissed:   boolean;
} | null>(null);
const xpAwardedRef = useRef(false);

  // Disconnect grace period (manual room only)
  const [oppDisconnected,      setOppDisconnected]      = useState(false);
  const [disconnectCountdown,  setDisconnectCountdown]  = useState(0);
  const disconnectTimerRef    = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const disconnectIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Heartbeat: my own presence tick + opponent monitor (manual room only)
  const heartbeatRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const oppMonitorRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  /* refs */
  const inputRef        = useRef<HTMLInputElement>(null);
  const startTimeRef    = useRef<number | null>(null);
  const rafRef          = useRef<number | null>(null);
  const fbTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameEndedRef    = useRef(false);
  const lastWriteRef = useRef(0);
  const staleCountRef = useRef(0);
  const timeLeftRef     = useRef<number>(9999);   // mirrors timeLeft; readable in async handlers
  const pollTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownPlayedRef = useRef(false);
  const resultSoundPlayedRef = useRef(false);
  // Refs that keep realtime callbacks up-to-date (avoids stale closure bugs)
  const phaseRef        = useRef<DuelPhase>("lobby");
  const isHostRef       = useRef(false);
  const isQuickRef      = useRef(false);
  // Stable identity ref — set on joinRoom/createRoom success AND session restore
  const activePlayerIdRef = useRef<string | null>(null);

  /* derived */
  const gameDuration = room?.duration_seconds ?? hostDuration;
  const gameRegion   = room?.region ?? hostRegion;
  const allowedIds   = useMemo(() => buildAllowedSet(gameRegion), [gameRegion]);
  // gameRegion may be stored as "north_america" (normalized) or "north-america" (UI)
  // Denormalize before looking up label
  const regionLabel  = REGION_OPTS.find(r => r.value === denormalizeRegion(gameRegion))?.label
    ?? REGION_OPTS.find(r => r.value === gameRegion)?.label
    ?? "Dünya";
  const durationLabel = DURATION_OPTS.find(d => d.value === gameDuration)?.label ?? `${gameDuration}sn`;

  const me  = players.find(p => p.id === myId);
  const opp = players.find(p => p.id !== myId);

const durationSeconds = room?.duration_seconds ?? hostDuration;

useEffect(() => {
  if (phase !== "playing") {
    countdownPlayedRef.current = false;
    stopSound("countdown20");
    return;
  }

  const countdownLimit =
    countdownSoundMode === "last20"
      ? 20
      : countdownSoundMode === "last10"
        ? 10
        : 0;

  if (countdownLimit === 0 || durationSeconds <= countdownLimit) {
    countdownPlayedRef.current = false;
    stopSound("countdown20");
    return;
  }

  if (!shouldPlayCountdownSound(timeLeft, countdownSoundMode)) {
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
}, [phase, timeLeft, durationSeconds, countdownSoundMode]);

useEffect(() => {
  return () => {
    stopSound("countdown20");
  };
}, []);
useEffect(() => {
  if (phase !== "finished") {
    resultSoundPlayedRef.current = false;
    return;
  }
  if (resultSoundPlayedRef.current) return;

  const myId     = myIdRef.current;
  const forfeitId = room?.forfeited_player_id ?? null;
  const winnerId  = room?.winner_player_id  ?? null;

  // Forfeit: forfeited_player_id is the loser
  if (forfeitId !== null) {
    resultSoundPlayedRef.current = true;
    if (forfeitId !== myId) playSound("win",  { restart: true });
    else                    playSound("lose", { restart: true });
    return;
  }

  // Winner determined by DB (timeout or opponent-left forfeit)
  if (winnerId !== null) {
    resultSoundPlayedRef.current = true;
    if (winnerId === myId) playSound("win",  { restart: true });
    else                   playSound("lose", { restart: true });
    return;
  }

  // Neither determined yet (room state not arrived) — fall back to scores
  if (!finalScores) return;
  resultSoundPlayedRef.current = true;
  if (finalScores.my > finalScores.opp)      playSound("win",  { restart: true });
  else if (finalScores.my < finalScores.opp) playSound("lose", { restart: true });
  // Equal scores → draw, no sound (intentional)
}, [phase, finalScores, room?.winner_player_id, room?.forfeited_player_id]);
/* ── XP: oyun bitince bir kez yaz (sadece giriş yapmış kullanıcı) ── */
useEffect(() => {
  if (phase !== "finished" || !finalScores) return;
  if (xpAwardedRef.current) return;
  if (!isLoggedInPlayer || !profile?.id) return;
  if (!room?.id) return;

  const myScoreFinal  = finalScores.my;
  const oppScoreFinal = finalScores.opp;

  // RPC öncesi snapshot — animasyonun "neredeyim" değerleri.
  // profile.xp genel XP; mod XP'yi bilmediğimiz için 0'dan başlatıyoruz.
  // (İlk maçtan sonra DB'de gerçek değer olacak; sonraki maçta tekrar
  //  0'dan başlamayacak çünkü prevModeXp'yi RPC'nin döndürdüğü modeXp'den
  //  geriye doğru breakdown.total ile hesaplayacağız — aşağıda yapıyoruz.)
  const prevTotalXpSnapshot = profile.xp ?? 0;

  xpAwardedRef.current = true;

  const matchResult = resultFromScores(myScoreFinal, oppScoreFinal);
  const breakdown = calculateCountryDuelXp({
    correctCount: myScoreFinal,
    result: matchResult,
  });

  // Achievement stats: online win streak + daily streak/distinct-mode count.
  // Logged-in-only path, once-guarded (xpAwardedRef) → exactly once per match.
  recordOnlineMatchResult(matchResult, "country_duel");
  recordGameComplete({ modeFamily: "country" });
  // Dünya Gezgini: feed unique correct countries from THIS online match only
  // (myTopoIds = country codes this player claimed correctly). Offline play
  // never reaches here, so the achievement stays online-sourced.
  recordOnlineCorrectCountries(myTopoIds, "country_duel");

  const profileId = profile.id;
  const roomId    = room.id;

  (async () => {
    const res = await awardXpEvent({
      profileId,
      modeKey: "country_duel",
      roomId,
      xpEarned: breakdown.total,
      result: matchResult,
      details: {
        my_score:  myScoreFinal,
        opp_score: oppScoreFinal,
        breakdown,
      },
    });

    if (res.error) {
      xpAwardedRef.current = false;
      console.error("[DuelGame] XP yazılamadı:", res.error);
      return;
    }

    // prevModeXp'yi hesapla:
    //   - awarded=true  → DB'deki yeni modeXp'den bu maçın xpEarned'ini çıkar
    //   - awarded=false → DB'deki modeXp zaten "önceki" değer (RPC bu çağrıda
    //     yazma yapmadı, yani modeXp = prevModeXp). Animasyon "yerinde sayar".
    const prevModeXp = res.awarded
      ? Math.max(0, res.modeXp - res.xpEarned)
      : res.modeXp;

    // prevTotalXp için aynı mantık:
    //   - awarded=true  → totalXp - xpEarned
    //   - awarded=false → snapshot zaten doğru
    // NOT: snapshot kullanmıyoruz çünkü `profile.xp` güncel olmayabilir
    // (örn. başka bir tabda XP yazıldıysa). RPC dönüşü tek doğru kaynak.
    const prevTotalXp = res.awarded
      ? Math.max(0, res.totalXp - res.xpEarned)
      : res.totalXp;

    setXpResult({
      awarded:     res.awarded,
      xpEarned:    res.xpEarned,
      prevTotalXp,
      totalXp:     res.totalXp,
      prevModeXp,
      modeXp:      res.modeXp,
      breakdown,
      roomKey:     roomId,
      dismissed:   false,
    });

    // prevTotalXpSnapshot artık kullanılmıyor — yukarıdaki yorum açıklıyor.
    // İleride RPC'ye previous_total_xp eklersen burayı sadeleştiririz.
    void prevTotalXpSnapshot;
  })();
}, [phase, finalScores, isLoggedInPlayer, profile?.id, profile?.xp, room?.id]);
/* ── XP barı: kazandın/kaybettin sesi başladıktan sonra çık ── */
const [xpFooterVisible, setXpFooterVisible] = useState(false);
useEffect(() => {
  if (!xpResult) {
    setXpFooterVisible(false);
    return;
  }
  // 1.2 sn gecikme: win sesinin tepe noktasını geçince bar kayarak çıkar,
  // sonrasında kullanıcı X'e basana kadar ekranda kalır.
  const t = setTimeout(() => setXpFooterVisible(true), 1200);
  return () => clearTimeout(t);
}, [xpResult]);

  // Keep refs in sync so realtime handlers always read fresh values
  phaseRef.current   = phase;
  isHostRef.current  = isHost;
  isQuickRef.current = isQuickMatch;
  timeLeftRef.current = timeLeft;

  // Snapshot helpers used inside async handlers (avoids stale closure)
  const roomIdRef = useRef<string>("");
  if (room) roomIdRef.current = room.id;

  const myTopoIds  = useMemo(() => new Set(claims.filter(c => c.player_id === myId).map(c => c.country_code)), [claims, myId]);
  const oppTopoIds = useMemo(() => new Set(claims.filter(c => c.player_id !== myId).map(c => c.country_code)), [claims, myId]);
  const myScore    = myTopoIds.size;
  const oppScore   = oppTopoIds.size;

  const shareLink  = room ? `${location.origin}${location.pathname}?duel=${room.code}` : "";
  const timerPct   = (timeLeft / gameDuration) * 100;
  const timerColor = timeLeft > gameDuration * 0.33 ? "var(--accent)" : timeLeft > gameDuration * 0.13 ? "#f59e0b" : "#ef4444";
  const gameOver = gameEndedRef.current || timeLeft <= 0 || phase === "finished";
  // QM countdown buffer aktif mi? handleGuess'in client-side fairness guard'ı
  // ile birebir eşleşmeli (server-side started_at kontrolü yok).
  const qmCountdownActive =
    !!room
    && room.room_source === "quick_match"
    && countdownSeconds > 0;
  // Input/submit tarafı için kompozit: gameOver olmasa bile countdown'da kilit.
  const inputLocked = gameOver || qmCountdownActive;
  const inputCls = ["duel-input",
    feedback === "ok"  ? "ok"  : "",
    feedback === "err" || feedback === "dup" || feedback === "region" ? "err" : "",
    gameOver ? "disabled" : "",
  ].filter(Boolean).join(" ");

  /* ── feedback ── */
  const showFeedback = useCallback((type: "ok" | "err" | "dup" | "region") => {
    if (fbTimerRef.current) clearTimeout(fbTimerRef.current);
    setFeedback(type);
    if (type === "ok")  playSound("correct");
    else if (type === "err" || type === "region") playSound("wrong");
    fbTimerRef.current = setTimeout(() => setFeedback(null), 900);
  }, []);

  /* ── Restore session on mount ── */
  useEffect(() => {
    const saved = loadRoomSession();
    if (!saved) return;

    // Restore the stored playerId + claim-token into refs FIRST
    myIdRef.current = saved.playerId;
    claimTokenRef.current = saved.claimToken;
    activePlayerIdRef.current = saved.playerId;
    dbg("session restore: playerId loaded", saved.playerId);

    (async () => {
      const { data: r } = await supabase
        .from("duel_rooms").select("*").eq("id", saved.roomId).single();
      if (!r || r.status === "finished") {
        dbg("session restore: room finished or missing, clearing");
        clearDuelSession(); return;
      }
      const { data: ps } = await supabase
        .from("duel_players").select("*").eq("room_id", r.id);
      const isMe = (ps ?? []).some((p: DuelPlayer) => p.id === saved.playerId);
      if (!isMe) {
        dbg("session restore: playerId not in room, clearing");
        clearDuelSession(); return;
      }
      const room = r as DuelRoom;
      setRoom(room);
      setPlayers(ps ?? []);
      setIsHost((ps ?? [])[0]?.id === saved.playerId);
      setTimeLeft(room.duration_seconds);
      if (r.status === "playing") {
        const { data: cs } = await supabase
          .from("duel_claims").select("*").eq("room_id", r.id);
        setClaims(cs ?? []);
        setPhase("playing");
      } else {
        setPhase("waiting");
      }
      dbg("session restore: success", { roomId: r.id, status: r.status });
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Davet linki: ?duel=KOD prefill + giriş yapmışsa tek atış auto-join ── */
  useInviteJoin({
    paramKey: "duel",
    setJoinCode,
    canAutoJoin: !!profile?.username && phase === "lobby" && !room,
    triggerJoin: (code) => {
      inviteOverrideCodeRef.current = code;
      void joinRoom();
    },
  });

  /* ── Realtime subscriptions ── */

  /* ── handleOppDisconnect ──
   * Called by the opponent monitor when opponent last_seen_at is stale (> 6 s).
   * Starts a 15-second grace countdown. Idempotent: if already running, does nothing.
   * Cancelled by the opponent monitor when heartbeat resumes.
   * Only active in manual room mode (isQuickRef.current === false).
   */
  const handleOppDisconnect = useCallback((_lastSeenAt: string) => {
    if (gameEndedRef.current) return;
    if (disconnectTimerRef.current) return; // grace already in progress

    const GRACE =
  gameDuration <= 60 ? 20 :
  gameDuration <= 120 ? 30 :
  45;
    dbg("handleOppDisconnect: grace countdown start", { grace: GRACE });
    setOppDisconnected(true);
    setDisconnectCountdown(GRACE);

    disconnectIntervalRef.current = setInterval(() => {
      setDisconnectCountdown(prev => {
        if (prev <= 1) {
          if (disconnectIntervalRef.current) clearInterval(disconnectIntervalRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    disconnectTimerRef.current = setTimeout(async () => {
      if (gameEndedRef.current) return;
      const roomId = roomIdRef.current;
      const myId   = myIdRef.current;
      dbg("handleOppDisconnect: grace expired, declaring winner", myId);
      gameEndedRef.current = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
      if (oppMonitorRef.current) { clearInterval(oppMonitorRef.current); oppMonitorRef.current = null; }
      if (heartbeatRef.current)  { clearInterval(heartbeatRef.current);  heartbeatRef.current  = null; }

      try {
        const { data: cs } = await supabase
          .from("duel_claims").select("player_id").eq("room_id", roomId);
        const counts: Record<string, number> = {};
        (cs ?? []).forEach((c: { player_id: string }) => {
          counts[c.player_id] = (counts[c.player_id] ?? 0) + 1;
        });
        setFinalScores({ my: counts[myId] ?? 0, opp: 0 });
      } catch { /* ignore — UI falls back to live score state */ }

      // duel_handle_disconnect RPC: server (45 + GRACE) sn threshold doğrular.
      // Yanlış-pozitifi engeller (rakip yeniden bağlanmışsa no-op).
      const { error: dcErr } = await supabase.rpc("duel_handle_disconnect", {
        p_room_id:     roomId,
        p_player_id:   myId,
        p_claim_token: claimTokenRef.current,
      });
      if (dcErr) dbgErr("duel_handle_disconnect failed", dcErr);

      clearDuelSession();
      setOppDisconnected(false);
      setDisconnectCountdown(0);
      setPhase("finished");
    }, GRACE * 1000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!room) return;
    const chan = supabase.channel(`duel:${room.id}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "duel_rooms", filter: `id=eq.${room.id}` },
        async payload => {
          const r = payload.new as DuelRoom;
          setRoom(r);

          // Rematch pointer: opponent created new room and set rematch_room_id
          if (r.rematch_room_id && phaseRef.current === "finished") {
            dbg("RT: rematch_room_id detected, joining", r.rematch_room_id);
            await joinRematchRoom(r.rematch_room_id);
            return;
          }

          if (r.status === "playing" && phaseRef.current !== "playing") {
            dbg("RT: room → playing, started_at:", r.started_at);
            // r already has started_at from DB; setRoom(r) above already merged it
            setPhase("playing");
          }
          if (r.status === "finished" && !gameEndedRef.current) {
            gameEndedRef.current = true;
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
            // FIX: Non-triggerer client arrives here via Realtime UPDATE.
            // finalScores was never set on this client (finishGameByTimeout wasn't called here),
            // so we must fetch claims from DB and freeze scores now, before switching phase.
            // Without this, the non-triggerer falls back to possibly-stale claims state.
            const roomId = roomIdRef.current;
            const myId   = myIdRef.current;
            try {
              const { data: cs } = await supabase
                .from("duel_claims").select("player_id").eq("room_id", roomId);
              const counts: Record<string, number> = {};
              (cs ?? []).forEach((c: { player_id: string }) => {
                counts[c.player_id] = (counts[c.player_id] ?? 0) + 1;
              });
              const myFinal  = counts[myId] ?? 0;
              const oppEntry = Object.entries(counts).find(([id]) => id !== myId);
              const oppFinal = oppEntry ? oppEntry[1] : 0;
              setFinalScores({ my: myFinal, opp: oppFinal });
              dbg("RT finished: froze finalScores for non-triggerer", { myFinal, oppFinal });
            } catch (e) {
              dbgErr("RT finished: could not fetch claims for freeze", e);
              // Fall back to live score state — better than nothing
            }
            clearDuelSession();
            setPhase("finished");
          }
        })
      .on("postgres_changes",
        { event: "DELETE", schema: "public", table: "duel_rooms", filter: `id=eq.${room.id}` },
        () => {
          if (phaseRef.current === "waiting" && !isHostRef.current) {
            setHostClosedRoom(true);
          }
        })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "duel_players", filter: `room_id=eq.${room.id}` },
        () => {
          supabase.from("duel_players").select("*").eq("room_id", room.id)
            .then(({ data }) => {
              if (!data) return;

              // Misafir çıktı veya oda boşaldı — host tarafında güncelle
              if (phaseRef.current === "waiting" && data.length === 0) {
                backToLobby();
                return;
              }

              setPlayers(data);
              // Quick match auto-start:
              // Only trigger if we're the host, still waiting, and 2nd player just arrived
              if (
                isQuickRef.current &&
                isHostRef.current &&
                phaseRef.current === "waiting" &&
                data.length >= 2
              ) {
                dbg("quickMatch RT: 2nd player arrived, host auto-starting");
                supabase.rpc("duel_start_game", {
                  p_room_id:        room.id,
                  p_host_player_id: myIdRef.current,
                  p_claim_token:    claimTokenRef.current,
                }).then(({ error }) => {
                  if (error) dbgErr("quickMatch auto-start failed", error);
                  else dbg("quickMatch: room set to playing ✓");
                });
              }

              // NOT: "Opponent left → they forfeit" edge-case yolu (rakibin
              // duel_players satırının playing fazında silinmesi) kaldırıldı.
              // Ana akışta forfeit/disconnect RPC'leri rakibin SATIRINI silmez,
              // sadece duel_rooms.status='finished' olur. Rakip sekme kapatırsa
              // bizim handleOppDisconnect → duel_handle_disconnect RPC akışı
              // (45 + GRACE sn threshold) maçı bitirir. Bu sayede ek bir RPC
              // gerekmeden senaryo kapanır; eski direct UPDATE artık yok.
            });
        })
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "duel_claims", filter: `room_id=eq.${room.id}` },
        payload => {
          // Do NOT update claims after game has ended — final score must be frozen
          if (gameEndedRef.current || phaseRef.current === "finished") return;
          setClaims(prev => [...prev, payload.new as DuelClaim]);
        })
      // ── Rematch broadcasts ──
      .on("broadcast", { event: "rematch_request" }, () => {
        dbg("RT: rematch_request received");
        setRematch("received");
      })
      .on("broadcast", { event: "rematch_declined" }, () => {
        dbg("RT: rematch_declined received");
        setRematch("declined");
        // Auto-clear after a few seconds
        setTimeout(() => setRematch("idle"), 4000);
      })
      // (rematch_start broadcast replaced by rematch_room_id detection in UPDATE handler above)
      .subscribe();
    return () => { supabase.removeChannel(chan); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  /* ── finishGameByTimeout ──
   *  Any client can call this when remainingTime <= 0.
   *  Uses conditional update (.eq("status","playing")) so only ONE write wins
   *  even if both clients call simultaneously — Supabase atomic update.
   *  The "loser" write is a no-op (row already has status="finished").
   *
   *  FIX: After writing (or no-op), always freeze scores and set phase="finished"
   *  on THIS client. The non-triggerer client gets the same via Realtime UPDATE.
   *  Previously this function never called setPhase("finished"), causing the
   *  triggerer client to hang waiting for a Realtime event that might be delayed.
   */
  const finishGameByTimeout = useCallback(async () => {
    if (gameEndedRef.current || !room) return;
    gameEndedRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }

    // Fetch freshest claims from DB (not stale local state)
    const { data: cs } = await supabase
      .from("duel_claims").select("player_id").eq("room_id", room.id);
    const counts: Record<string, number> = {};
    (cs ?? []).forEach(c => { counts[c.player_id] = (counts[c.player_id] ?? 0) + 1; });

    // Freeze displayed scores before any more realtime INSERTs arrive
    const myId = myIdRef.current;
    const myFinal  = counts[myId]  ?? 0;
    const oppEntry = Object.entries(counts).find(([id]) => id !== myId);
    const oppFinal = oppEntry ? oppEntry[1] : 0;
    setFinalScores({ my: myFinal, opp: oppFinal });

    // Local winner hesabı sadece optimistic state için; server kendi yetkili
    // sayımını duel_finish_game RPC içinde duel_claims COUNT üzerinden yapıyor.
    const ids = Object.keys(counts);
    let winnerId: string | null = null;
    if (ids.length >= 2) {
      const sorted = ids.sort((a, b) => counts[b] - counts[a]);
      if (counts[sorted[0]] > counts[sorted[1]]) winnerId = sorted[0];
    } else if (ids.length === 1) {
      winnerId = ids[0];
    }

    // duel_finish_game RPC: player_in_room + status='playing' guard +
    // winner SERVER-SIDE hesaplanır. Double-call no-op (idempotent).
    const { data: finishedRoom, error } = await supabase.rpc("duel_finish_game", {
      p_room_id:     room.id,
      p_player_id:   myId,
      p_claim_token: claimTokenRef.current,
    });
    if (error) dbgErr("duel_finish_game failed", error);
    dbg("finishGameByTimeout: written or no-op", { winnerId, myFinal, oppFinal });

    // FIX: Always transition to finished on THIS client immediately after the DB
    // write (whether it won the race or not). The non-triggerer arrives via the
    // Realtime UPDATE handler below. Without this line the triggerer could hang
    // indefinitely if its own Realtime echo is delayed or dropped.
    const serverRoom = finishedRoom as DuelRoom | null;
    setRoom(prev => prev
      ? { ...prev, ...(serverRoom ?? {
          status: "finished" as const,
          finished_reason: "timeout" as const,
          winner_player_id: winnerId,
        }) }
      : prev
    );
    setPhase("finished");
    clearDuelSession();
  }, [room, myId]);

  /* ── Server-clock sync ──
   *  room.started_at server `now()` ile yazılıyor ama her client onu kendi
   *  Date.now()'una göre okuyor → iki PC arasındaki saat farkı (5 sn'ye
   *  kadar) timer'a doğrudan kayma olarak yansıyor. initServerClockSync()
   *  bir RPC ile offset'i ölçer ve getSyncedNowMs() üzerinden tüm timer
   *  hesapları aynı epoch referansına oturur. Sadece waiting/playing
   *  fazlarında aktif — lobby'de gereksiz probe atmaz.
   */
  useEffect(() => {
    if (phase !== "searching" && phase !== "waiting" && phase !== "playing") return;
    const handle = initServerClockSync();
    return () => handle.dispose();
  }, [phase]);

  /* ── SERVER-AUTHORITATIVE TIMER ──
   *  Source of truth: room.started_at (written by server on game start).
   *  Every client independently computes remainingTime.
   *  When time expires, ANY client calls finishGameByTimeout().
   *  The conditional DB update (.eq("status","playing")) ensures atomicity.
   */
  useEffect(() => {
    if (phase !== "playing") return;
    if (!room?.started_at) {
      dbg("timer: waiting for room.started_at");
      return;
    }
    
    const totalMs = gameDuration * 1000;
    let done = false;

    const tick = () => {
      if (done) return;
      const now = getSyncedNowMs();

// start güvenli
const safeStart = room.started_at
  ? new Date(room.started_at).getTime()
  : now;

const endMs = safeStart + totalMs;

// kalan süre (ms)
const remainingMs = Math.max(0, endMs - now);

// saniye
const rem = Math.floor(remainingMs / 1000);

// asla gameDuration'ı geçmesin
const safeRem = Math.min(gameDuration, rem);

setTimeLeft(safeRem);
      if (now >= endMs) {
        done = true;
        if (!gameEndedRef.current) {
          // ANY client triggers finish — conditional update prevents double-write
          finishGameByTimeout();
        }
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible" && !done) {
        // Re-check if game already finished while tab was hidden
        if (phaseRef.current !== "playing") { done = true; return; }
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      done = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gameDuration, room?.started_at]);

  /* auto-focus */
  useEffect(() => {
    if (phase === "playing") setTimeout(() => inputRef.current?.focus(), 100);
  }, [phase]);

  /* ── Realtime fallback: poll room every 1 s while playing ──
   *  If realtime event was missed (network hiccup, tab sleep), polling
   *  catches the status change and triggers the result screen.
   */
  /* ── Waiting fazında player listesini polla (Realtime yedek) ── */
  useEffect(() => {
    if (phase !== "waiting" || !room?.id) return;
    const roomId = room.id;
    const timer = setInterval(async () => {
      const { data } = await supabase
        .from("duel_players")
        .select("*")
        .eq("room_id", roomId);
      if (!data) return;
      setPlayers(data);
    }, 2000);
    return () => clearInterval(timer);
  }, [phase, room?.id]);
  useEffect(() => {
    if (phase !== "playing" || !room?.id) return;
    const roomId = room.id;
    pollTimerRef.current = setInterval(async () => {
      if (phaseRef.current !== "playing") {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        return;
      }
      try {
        const { data } = await supabase
          .from("duel_rooms")
          .select("status, finished_reason, winner_player_id, forfeited_player_id, started_at")
          .eq("id", roomId)
          .single();
        if (!data) return;
        if (data.status === "finished" && !gameEndedRef.current) {
          dbg("poll: detected finished room — applying result");
          gameEndedRef.current = true;
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          // FIX: Freeze finalScores from DB so this fallback path also shows
          // correct scores (same as RT handler fix above).
          const myId = myIdRef.current;
          try {
            const { data: cs } = await supabase
              .from("duel_claims").select("player_id").eq("room_id", roomId);
            const counts: Record<string, number> = {};
            (cs ?? []).forEach((c: { player_id: string }) => {
              counts[c.player_id] = (counts[c.player_id] ?? 0) + 1;
            });
            const myFinal  = counts[myId] ?? 0;
            const oppEntry = Object.entries(counts).find(([id]) => id !== myId);
            const oppFinal = oppEntry ? oppEntry[1] : 0;
            setFinalScores({ my: myFinal, opp: oppFinal });
            dbg("poll finished: froze finalScores", { myFinal, oppFinal });
          } catch { /* ignore — UI falls back to live score state */ }
          // Merge polled data into room state
          setRoom(prev => prev ? { ...prev, ...data } : prev);
          clearDuelSession();
          setPhase("finished");
        }
      } catch { /* network error — ignore, next poll will retry */ }
    }, 1000);
    return () => {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, room?.id]);

  /* ── ESC → toggle quit modal while playing ── */
  useEffect(() => {
    if (phase !== "playing") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setQuitModal(prev => {
        if (prev) setQuitStep("idle"); // reset to main options when closing
        return !prev;
      });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [phase]);

  /* ── Heartbeat: update my own last_seen_at every 3 s while playing ── */
  useEffect(() => {
    if (phase !== "playing") return;

    const myId   = myIdRef.current;
    const roomId = roomIdRef.current;
    if (!myId || !roomId) return;

    const tick = () => {
      const token = claimTokenRef.current;
      if (!token) return;
      supabase.rpc("duel_heartbeat", {
        p_player_id:   myId,
        p_claim_token: token,
      }).then(({ error }) => {
        if (error) dbgErr("heartbeat rpc failed", error);
      });
    };

    tick(); // immediate first tick
    heartbeatRef.current = setInterval(tick, 3000);

    return () => {
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /* ── Opponent monitor: poll opponent last_seen_at every 3 s ──
   *
   * Works for both manual room and Quick Match.
   * If opponent last_seen_at is > 6 s old → start 15-s disconnect grace.
   * If opponent heartbeat resumes            → cancel grace.
   * Opponent is always players.find(p => p.id !== myId) — never self.
   */
  useEffect(() => {
    if (phase !== "playing" || !room) return;

    const roomId = room.id;

    const check = async () => {
      if (phaseRef.current !== "playing" || gameEndedRef.current) return;

      const myId = myIdRef.current;
      const { data: ps } = await supabase
        .from("duel_players")
        .select("id, last_seen_at")
        .eq("room_id", roomId);

      if (!ps || ps.length < 2) return; // opponent not yet present

      const opp = ps.find((p: { id: string }) => p.id !== myId);
      if (!opp) return;

      const lastSeen = opp.last_seen_at
  ? new Date(opp.last_seen_at).getTime()
  : 0;

const nowSynced = getSyncedNowMs();

const started = room.started_at
  ? new Date(room.started_at).getTime()
  : nowSynced;

const justStarted = nowSynced - started < 10000;

const stale =
  !justStarted &&
  lastSeen > 0 &&
  (nowSynced - lastSeen) > 45000;

      dbg("opp monitor", { oppId: opp.id, lastSeen: opp.last_seen_at, stale });

      if (stale) {
  staleCountRef.current += 1;

  if (staleCountRef.current >= 4) {
    handleOppDisconnect(opp.last_seen_at);
  }
} else {
  staleCountRef.current = 0;
        if (disconnectTimerRef.current || disconnectIntervalRef.current) {
          if (disconnectTimerRef.current)   { clearTimeout(disconnectTimerRef.current);   disconnectTimerRef.current   = null; }
          if (disconnectIntervalRef.current){ clearInterval(disconnectIntervalRef.current); disconnectIntervalRef.current = null; }
          setOppDisconnected(false);
          setDisconnectCountdown(0);
          dbg("opp monitor: opp alive, grace cancelled");
        }
      }
    };

    check(); // immediate first check
    oppMonitorRef.current = setInterval(check, 3000);

    return () => {
      if (oppMonitorRef.current) { clearInterval(oppMonitorRef.current); oppMonitorRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, room?.id]);

  /* ── CREATE ROOM ── */
  const createRoom = async () => {
    const name = effectivePlayerName.trim();
const usernameError = validateUsername(name);

if (usernameError) {
  setErrorMsg(usernameError);
  setStatusMsg(null);
  setPhase("lobby");
  return;
}

    setErrorMsg(null);
    setStatusMsg("Oda kuruluyor…");
    setPhase("creating");

    // ── Clear old session and generate FRESH identity (player_id + claim_token) ──
    clearDuelSession();
    const freshId    = freshPlayerId();
    const freshToken = freshClaimToken();
    myIdRef.current        = freshId;
    claimTokenRef.current  = freshToken;

    const code = makeCode();
    const { profileId, guestId } = getIdentityArgs();
    dbg("createRoom start (RPC)", { code, playerId: freshId, hostDuration, hostRegion });

    // ── duel_create_room RPC: oda + player + claim tek transaction ──
    const { data: roomData, error: roomErr } = await supabase.rpc("duel_create_room", {
      p_player_id:   freshId,
      p_profile_id:  profileId,
      p_guest_id:    guestId,
      p_name:        name,
      p_code:        code,
      p_duration:    hostDuration,
      p_region:      normalizeRegion(hostRegion),
      p_claim_token: freshToken,
    });

    dbg("duel_create_room result", { roomData, roomErr });

    if (roomErr || !roomData) {
      dbgErr("duel_create_room failed", roomErr, { code });
      setErrorMsg(describeDuelRpcError(roomErr));
      setStatusMsg(null); setPhase("lobby"); return;
    }

    const room = roomData as DuelRoom;
    dbg("room confirmed", { id: room.id, code: room.code });

    // ── Fetch player list (state için; RPC sadece room satırı döndürüyor) ──
    const { data: players, error: psErr } = await supabase
      .from("duel_players").select("*").eq("room_id", room.id);
    dbg("duel_players fetch", { players, psErr });

    setRoom(room);
    setPlayers(players ?? []);
    setClaims([]);
    setIsHost(true);
    saveRoomSession(room.id, room.code, freshId, freshToken);
    activePlayerIdRef.current = freshId;
    setTimeLeft(hostDuration);
    setStatusMsg(null);
    setPhase("waiting");
    dbg("createRoom success ✓", { roomId: room.id, code: room.code, playerId: freshId });
  };

  /* ── JOIN ROOM ── */
  const joinRoom = async () => {
   const name = effectivePlayerName.trim();
const overrideCode = inviteOverrideCodeRef.current;
inviteOverrideCodeRef.current = null;
const code = (overrideCode ?? joinCode).trim().toUpperCase();

const usernameError = validateUsername(name);

if (usernameError) {
  setErrorMsg(usernameError);
  setStatusMsg(null);
  setPhase("lobby");
  return;
}

if (!code) {
  setErrorMsg("Oda kodu yazmalısın.");
  return;
}

    setErrorMsg(null); setStatusMsg("Odaya bağlanılıyor…");

    // Determine player ID + token: reuse stored ones ONLY if this room session matches.
    const savedSession = loadRoomSession();
    const isResume = !!(savedSession?.roomCode === code && savedSession?.playerId && savedSession?.claimToken);
    const joinId: string = isResume
      ? savedSession!.playerId
      : freshPlayerId();
    const joinToken: string = isResume
      ? savedSession!.claimToken
      : freshClaimToken();
    if (!isResume) clearDuelSession();
    myIdRef.current       = joinId;
    claimTokenRef.current = joinToken;

    dbg("joinRoom start", { code, joinId, isResume });

    if (isResume) {
      // ── Resume akışı: RPC ÇAĞIRMAYIZ (oda zaten kayıtlı, claim_token var) ──
      const { data: r } = await supabase
        .from("duel_rooms")
        .select("*")
        .eq("code", code)
        .single();
      if (!r?.id) {
        setErrorMsg("Oda bulunamadı. Kodu kontrol et.");
        setStatusMsg(null); return;
      }
      const room = r as DuelRoom;
      const { data: ps } = await supabase
        .from("duel_players").select("*").eq("room_id", room.id);
      setRoom(room); setPlayers(ps ?? []); setClaims([]); setIsHost(false);
      saveRoomSession(room.id, room.code, joinId, joinToken);
      activePlayerIdRef.current = joinId;
      setTimeLeft(room.duration_seconds ?? 60);
      setStatusMsg(null); setPhase("waiting");
      dbg("joinRoom resume ✓", { roomId: room.id, joinId });
      return;
    }

    // ── Fresh join: duel_join_room RPC (kapasite + isim + insert tek transaction) ──
    const { profileId, guestId } = getIdentityArgs();
    const { data: roomData, error: joinErr } = await supabase.rpc("duel_join_room", {
      p_code:         code,
      p_player_id:    joinId,
      p_profile_id:   profileId,
      p_guest_id:     guestId,
      p_name:         name,
      p_claim_token:  joinToken,
    });

    dbg("duel_join_room result", { roomData, joinErr });

    if (joinErr || !roomData) {
      dbgErr("duel_join_room failed", joinErr, { joinId, code });
      setErrorMsg(describeDuelRpcError(joinErr));
      setStatusMsg(null); return;
    }

    const room = roomData as DuelRoom;

    // Fetch full player list for state
    const { data: ps } = await supabase
      .from("duel_players").select("*").eq("room_id", room.id);
    dbg("player list after join", ps);

    setRoom(room); setPlayers(ps ?? []); setClaims([]); setIsHost(false);
    saveRoomSession(room.id, room.code, joinId, joinToken);
    activePlayerIdRef.current = joinId;
    setTimeLeft(room.duration_seconds ?? 60);
    setStatusMsg(null); setPhase("waiting");
    dbg("joinRoom success ✓", { roomId: room.id, joinId });
  };

  /* ── START GAME (host only) — sets server-authoritative started_at ── */
  const startGame = async () => {
    if (!room || !isHost) return;
    const { error } = await supabase.rpc("duel_start_game", {
      p_room_id:        room.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    claimTokenRef.current,
    });
    if (error) {
      dbgErr("duel_start_game failed", error);
      setErrorMsg(describeDuelRpcError(error));
      return;
    }

    const { data: cs } = await supabase
      .from("duel_claims").select("*").eq("room_id", room.id);
    setClaims(cs ?? []);
    setPhase("playing");
  };

  /* ── GUESS ── */
  const handleGuess = async () => {
    // ── GUARD: must be playing, have a room, and have time left ──
    if (phaseRef.current !== "playing") return;
    if (gameEndedRef.current) return;

    // ── QM COUNTDOWN GUARD (fairness) ──
    // Quick match odası RPC tarafından started_at = now() + 3s ile kuruluyor;
    // bu sırada phase 'playing' ama saat henüz başlamadı. Server-side claim
    // RPC'si started_at kontrolü yapmadığından, client guard koymazsak iki
    // oyuncudan biri buffer'da yazıp Enter'a basıp puan kayıt edebilir.
    // serverClock üzerinden okuyoruz; lokal saat kayması yansımasın.
    if (
      room?.room_source === "quick_match" &&
      room.started_at &&
      getSyncedNowMs() < new Date(room.started_at).getTime()
    ) {
      return;
    }
    if (activePlayerIdRef.current && claimTokenRef.current) {
  const now = Date.now();

  if (now - lastWriteRef.current > 2000) {
    lastWriteRef.current = now;

    // Heartbeat RPC — kendi last_seen_at'imi güncellerken claim_token authz
    await supabase.rpc("duel_heartbeat", {
      p_player_id:   activePlayerIdRef.current,
      p_claim_token: claimTokenRef.current,
    });
  }
}
    if (timeLeftRef.current <= 0) return;
    if (!room || room.status !== "playing") return;

    const norm = normalizeInput(input);
    if (!norm) return;
    const topoId = NAME_TO_TOPOID[norm];
    if (!topoId) {
  showFeedback("err");
  setInput("");
  return;
}

if (allowedIds && !allowedIds.has(topoId)) {
  showFeedback("region");
  setInput("");
  return;
}

if (claims.some(c => c.country_code === topoId)) {
  showFeedback("dup");
  setInput("");
  return;
}

    // Final time check right before the DB insert
    if (timeLeftRef.current <= 0 || gameEndedRef.current) return;

    setInput("");
    // duel_submit_claim RPC: server-side player_room_mismatch + status guard
    // + atomic claim insert. Dup'ta {claimed:false, reason:'dup'} döner.
    const { data: claimRes, error } = await supabase.rpc("duel_submit_claim", {
      p_room_id:      room.id,
      p_player_id:    myId,
      p_claim_token:  claimTokenRef.current,
      p_country_code: topoId,
    });

    if (error) {
      dbgErr("duel_submit_claim failed", error);
      showFeedback("err");
      return;
    }

    const res = claimRes as { claimed: boolean; reason?: string } | null;
    if (res?.claimed) {
      showFeedback("ok");
      return;
    }
    if (res?.reason === "dup") {
      showFeedback("dup");
      return;
    }
    showFeedback("err");
    return;
}
  /* ── COPY INVITE MESSAGE ── */
  const inviteMessage = room
    ? `Torble'da Online 1v1 ülke kapmaca oynayalım! ⚔️
Mod: ${regionLabel} · Süre: ${durationLabel}
En çok ülke yazan kazanır.
Katılmak için tıkla:
${shareLink}`
    : "";


  /* ════════════════════════════════════════════════════════════════
     HIZLI EŞLEŞ — startQuickMatch / cancelQuickMatch / join
     ────────────────────────────────────────────────────────────────
     Backend: country_duel_quick_match / cancel / reset RPC'leri
     (supabase/migrations/20260701120000_country_duel_quick_match.sql).
     Akış Bayrak/Çark ile birebir simetrik. Giriş zorunlu — misafir
     kullanılamaz; lobby butonu auth check'i UI tarafında yapıyor.
  ════════════════════════════════════════════════════════════════ */

  /** RPC dönüşünden veya realtime UPDATE'inden sonra çağrılır.
   *  Odayı + iki player'ı yükler, lokal state'i set eder, phase 'playing'.
   *  Tek seferlik: quickMatchJoinedRef ile guard'lı. */
  const joinQuickMatchRoom = useCallback(
    async (roomId: string, playerId: string, opponentName?: string) => {
      if (quickMatchJoinedRef.current) return;
      if (quickMatchAbortRef.current) return;

      // VALIDATE BEFORE COMMITTING. Önce odanın taze QM oda olduğunu doğrula
      // ki stale matched_room_id (cancel RPC matched satırları silmiyor)
      // search state'i bozmasın. Bayrak'taki self-heal yaklaşımıyla aynı.
      const { data: roomData, error: roomErr } = await supabase
        .from("duel_rooms")
        .select("*")
        .eq("id", roomId)
        .maybeSingle();

      if (roomErr || !roomData) {
        dbgErr("joinQuickMatchRoom: room fetch failed, will retry on next tick", roomErr);
        return;
      }

      const r = roomData as DuelRoom;

      // Stale-room guard: QM odası RPC tarafından status='playing' + started_at
      // = now()+3s ile kurulur. 30sn'den taze değilse veya status != playing
      // ise önceki bir maçtan kalmış → sessizce atla ki polling devam etsin.
      const startedAtMs = r.started_at ? new Date(r.started_at).getTime() : 0;
      const isStaleRoom =
        r.status !== "playing" ||
        !startedAtMs ||
        getSyncedNowMs() - startedAtMs > 30_000;
      if (isStaleRoom) {
        dbgErr("joinQuickMatchRoom: stale matched_room_id, skipping silently", {
          status: r.status,
          started_at: r.started_at,
        });
        return;
      }

      // OK, fresh match — commit to join.
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
      quickMatchAbortRef.current = true;

      myIdRef.current = playerId;
      activePlayerIdRef.current = playerId;
      // QM-country: country_duel_quick_match RPC duel_player_claims kaydı atmaz;
      // auth duel_authorize_player'ın profile_id branch'inden geçiyor (PR-1
      // migration duel_players.profile_id'yi caller/waiter için doldurur).
      // claim_token yine de fresh üretelim — DuelGame'in submit/heartbeat RPC
      // parametreleri uuid bekliyor (boş string PostgREST'te uuid_in('') hatası
      // verir); değer authorize'a girmiyor ama parametre formatı için gerekli.
      claimTokenRef.current = freshClaimToken();

      const { data: ps } = await supabase
        .from("duel_players")
        .select("*")
        .eq("room_id", roomId)
        .order("joined_at", { ascending: true });

      const playerList = (ps ?? []) as DuelPlayer[];
      // Host kararı DB'deki host_player_id üzerinden (QM RPC waiter'ı host
      // olarak set ediyor — deterministic). NULL ise fallback player_id sort.
      const hostId =
        (r.host_player_id ?? "") ||
        [...playerList].sort((a, b) => a.id.localeCompare(b.id))[0]?.id ||
        "";
      const isMeHost = hostId === playerId;

      saveRoomSession(r.id, r.code, playerId, claimTokenRef.current);

      // XP idempotency için fresh state
      setXpResult(null);
      xpAwardedRef.current = false;
      gameEndedRef.current = false;
      setFinalScores(null);

      setRoom(r);
      setPlayers(playerList);
      setClaims([]);
      setIsHost(isMeHost);
      setIsQuickMatch(true);
      setTimeLeft(r.duration_seconds);

      // Quick match countdown başlat (started_at - now() farkı). started_at
      // server tarafında now()+3s; client clock drift olunca buffer negatif
      // veya büyük görünebilir → synced clock kullanıyoruz.
      const startMs = r.started_at ? new Date(r.started_at).getTime() : 0;
      const now = getSyncedNowMs();
      const remainMs = Math.max(0, startMs - now);
      setCountdownSeconds(Math.ceil(remainMs / 1000));

      if (quickMatchCountdownRef.current) {
        clearInterval(quickMatchCountdownRef.current);
        quickMatchCountdownRef.current = null;
      }
      if (remainMs > 0) {
        const tick = () => {
          const remaining = Math.max(0, startMs - getSyncedNowMs());
          setCountdownSeconds(Math.ceil(remaining / 1000));
          if (remaining <= 0 && quickMatchCountdownRef.current) {
            clearInterval(quickMatchCountdownRef.current);
            quickMatchCountdownRef.current = null;
          }
        };
        quickMatchCountdownRef.current = setInterval(tick, 200);
      }

      if (opponentName) setStatusMsg(`Rakip bulundu: ${opponentName}`);
      else              setStatusMsg(null);
      setErrorMsg(null);
      setPhase("playing");
      dbg("joinQuickMatchRoom: switched to playing ✓", { roomId, isMeHost });
    },
    [],
  );

  // Forward ref pattern — quickMatchTick içinden cancel'a erişim için
  const cancelQuickMatchRef = useRef<(() => void) | null>(null);

  /** Polling tick — SELECT-first guard sonra RPC. */
  const quickMatchTick = useCallback(async () => {
    if (quickMatchAbortRef.current) return;
    if (!profile?.id) return;

    const myProfileId = profile.id;

    // SELECT-first guard: realtime UPDATE jitter olabilir VE RPC UPSERT'ü
    // matched_room_id'yi NULL'a çekiyor (caller path için doğru, bekleyen
    // için yan etki). Önce kendi queue satırımı oku, matched_room_id doluysa
    // join'e geç.
    const { data: selfRow } = await supabase
      .from("country_duel_queue")
      .select("matched_room_id, player_id")
      .eq("profile_id", myProfileId)
      .maybeSingle();

    if (quickMatchAbortRef.current) return;

    if (selfRow?.matched_room_id && selfRow.player_id) {
      await joinQuickMatchRoom(selfRow.matched_room_id, selfRow.player_id);
      // joinQuickMatchRoom stale guard ile no-op'a düşmüş olabilir → o zaman
      // RPC'ye düşmeye devam etmeliyiz (stale row self-heal RPC içinde).
      if (quickMatchJoinedRef.current) return;
    }

    const elapsed = Math.floor((Date.now() - quickMatchStartMsRef.current) / 1000);
    const bracket = quickMatchBracket(elapsed);
    const myPlayerId = myIdRef.current;
    const myName     = (profile.username ?? "").trim();
    const code       = makeCode();

    const { data, error } = await supabase.rpc("country_duel_quick_match", {
      p_profile_id:     myProfileId,
      p_player_id:      myPlayerId,
      p_player_name:    myName,
      p_duration:       hostDuration,
      p_region:         normalizeRegion(hostRegion),
      p_max_level_diff: bracket,
      p_room_code:      code,
    });

    if (quickMatchAbortRef.current) return;

    if (error) {
      dbgErr("country_duel_quick_match RPC error", error);
      setErrorMsg("Hızlı eşleş hatası: " + (error.message ?? "Bilinmeyen"));
      cancelQuickMatchRef.current?.();
      return;
    }

    const res = data as {
      matched:             boolean;
      room_id?:            string;
      my_player_id?:       string;
      opponent_name?:      string | null;
      search_age_seconds?: number;
    };

    if (res?.matched && res.room_id && res.my_player_id) {
      await joinQuickMatchRoom(res.room_id, res.my_player_id, res.opponent_name ?? undefined);
      return;
    }
    // Henüz eşleşme yok — searchSeconds zaten ayrı interval ile artıyor.
  }, [profile?.id, profile?.username, hostDuration, hostRegion, joinQuickMatchRoom]);

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
    if (quickMatchCountdownRef.current) {
      clearInterval(quickMatchCountdownRef.current);
      quickMatchCountdownRef.current = null;
    }

    setSearchSeconds(0);
    setStatusMsg(null);
    setPhase("lobby");

    if (profile?.id) {
      try {
        await supabase.rpc("country_duel_cancel_quick_match", {
          p_profile_id: profile.id,
        });
      } catch (e) {
        console.warn("[DuelGame] cancel_quick_match RPC failed", e);
      }
    }
  }, [profile?.id]);

  useEffect(() => {
    cancelQuickMatchRef.current = cancelQuickMatch;
  }, [cancelQuickMatch]);

  const startQuickMatch = useCallback(async () => {
    playSound("click");
    setErrorMsg(null);

    if (!profile?.id || !profile.username) {
      setErrorMsg("Hızlı eşleş için giriş gerekli.");
      return;
    }

    // Quick match identity: her aramada fresh player UUID
    clearDuelSession();
    const freshId = freshPlayerId();
    myIdRef.current = freshId;
    claimTokenRef.current = "";

    // Önceki maç state'ini temizle (sonuç ekranından gelinmiş olabilir)
    setRoom(null);
    setPlayers([]);
    setClaims([]);
    setIsHost(false);
    setIsQuickMatch(false);
    setRematch("idle");
    setXpResult(null);
    xpAwardedRef.current = false;
    gameEndedRef.current = false;
    setFinalScores(null);

    // Reset guards & timers
    quickMatchAbortRef.current  = false;
    quickMatchJoinedRef.current = false;
    quickMatchStartMsRef.current = Date.now();
    setSearchSeconds(0);
    setCountdownSeconds(0);
    setPhase("searching");

    // Önceki maçtan kalan country_duel_queue satırını sil. Cancel RPC yalnız
    // matched_room_id=NULL siliyor; reset koşulsuz siler → SELECT-first guard
    // önceki tamamlanmış maça yapışmasın.
    try {
      const { error: resetErr } = await supabase.rpc(
        "country_duel_reset_quick_match",
        { p_profile_id: profile.id },
      );
      if (resetErr) console.warn("[DuelGame] reset_quick_match RPC error:", resetErr);
    } catch (e) {
      console.warn("[DuelGame] reset_quick_match RPC threw:", e);
    }

    // Saniye sayacı (UI display + bracket)
    quickMatchSecondsRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - quickMatchStartMsRef.current) / 1000);
      setSearchSeconds(s);
    }, 1000);

    // İlk RPC çağrısı + polling.
    // İlk tick eşleşmeyle dönerse joinQuickMatchRoom abort+joined flag'lerini
    // true yapmış olur; bu durumda interval'i HİÇ kurmuyoruz (aksi halde
    // no-op tick'ler component lifetime boyunca leak'ler).
    await quickMatchTick();
    if (!quickMatchAbortRef.current && !quickMatchJoinedRef.current) {
      quickMatchTickRef.current = setInterval(() => {
        quickMatchTick();
      }, QUICK_MATCH_TICK_MS);
    }
  }, [profile?.id, profile?.username, quickMatchTick]);

  /* Realtime: bekleyen oyuncu kendi queue satırının matched_room_id UPDATE'ini
     dinler. Caller RPC dönüşünde direkt join eder; listener güvenlik ağı. */
  useEffect(() => {
    if (phase !== "searching") return;
    if (!profile?.id) return;

    const myProfileId = profile.id;
    const chan = supabase
      .channel(`country-duel-queue:${myProfileId}`)
      .on(
        "postgres_changes",
        {
          event:  "UPDATE",
          schema: "public",
          table:  "country_duel_queue",
          filter: `profile_id=eq.${myProfileId}`,
        },
        (payload) => {
          const row = payload.new as {
            matched_room_id: string | null;
            player_id:       string;
          };
          if (!row.matched_room_id) return;
          if (quickMatchJoinedRef.current) return;
          joinQuickMatchRoom(row.matched_room_id, row.player_id);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(chan);
    };
  }, [phase, profile?.id, joinQuickMatchRoom]);

  /* Component unmount'ta searching ise queue satırını temizle. */
  useEffect(() => {
    return () => {
      if (quickMatchTickRef.current)      clearInterval(quickMatchTickRef.current);
      if (quickMatchSecondsRef.current)   clearInterval(quickMatchSecondsRef.current);
      if (quickMatchCountdownRef.current) clearInterval(quickMatchCountdownRef.current);
      if (profile?.id && !quickMatchJoinedRef.current) {
        supabase.rpc("country_duel_cancel_quick_match", {
          p_profile_id: profile.id,
        }).then(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

    /* ── FORFEIT ──
   *  The forfeiting player ALWAYS loses, regardless of score.
   *  Strategy:
   *   1. Snapshot room/players refs (closures)
   *   2. Stop timer immediately
   *   3. Write authoritative finish to DB — rakip realtime alır, "Kazandın" görür
   *   4. THEN navigate — so we don't lose room ref before the DB write
   */
  const forfeit = useCallback(async (thenNavigate: "lobby" | "home") => {
    // Snapshot before any state mutations
    const snapshotRoom    = room;
    const snapshotPlayers = players;
    const myId = myIdRef.current;

    gameEndedRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    if (snapshotRoom) {
      const winnerId = snapshotPlayers.find(p => p.id !== myId)?.id ?? null;
      // Optimistic local update — result screen shows correct result immediately
      setRoom({
        ...snapshotRoom,
        status:              "finished",
        finished_reason:     "forfeit",
        forfeited_player_id: myId,
        winner_player_id:    winnerId,
      });
      // duel_forfeit_game RPC: server-side forfeit eden = loser, rakip = winner.
      // Conditional update (status='playing') → double-call no-op (idempotent).
      const { error } = await supabase.rpc("duel_forfeit_game", {
        p_room_id:     snapshotRoom.id,
        p_player_id:   myId,
        p_claim_token: claimTokenRef.current,
      });
      if (error) dbgErr("duel_forfeit_game failed", error);
      else dbg("forfeit: written", { forfeitedBy: myId, winnerId, room: snapshotRoom.id });
    }

    clearDuelSession();
    setQuitModal(false);
    setQuitStep("idle");

    if (thenNavigate === "home") {
      setRoom(null); setPlayers([]); setClaims([]);
      setIsQuickMatch(false); setShowLabels(false); setRematch("idle");
      setPhase("lobby"); setErrorMsg(null); setStatusMsg(null);
      myIdRef.current = "";
      onHome();
    } else {
      // Stay on result screen — room state already has updated forfeit fields
      setPhase("finished");
    }
  }, [room, players, onHome]);

  /* ── BACK TO LOBBY ── */
  const backToLobby = async () => {
    if (disconnectTimerRef.current)   { clearTimeout(disconnectTimerRef.current);   disconnectTimerRef.current   = null; }
    if (disconnectIntervalRef.current){ clearInterval(disconnectIntervalRef.current); disconnectIntervalRef.current = null; }
    if (heartbeatRef.current)         { clearInterval(heartbeatRef.current);         heartbeatRef.current         = null; }
    if (oppMonitorRef.current)        { clearInterval(oppMonitorRef.current);         oppMonitorRef.current        = null; }
    setOppDisconnected(false);
    setDisconnectCountdown(0);
    if (room && phase === "waiting" && claimTokenRef.current) {
      // duel_leave_room RPC: host ise oda+player'lar cascade delete; misafir
      // ise kendi satırı (+ oda boşaldıysa oda).
      const { error } = await supabase.rpc("duel_leave_room", {
        p_room_id:     room.id,
        p_player_id:   myIdRef.current,
        p_claim_token: claimTokenRef.current,
      });
      console.log("[backToLobby] duel_leave_room result:", error?.message ?? "ok");
    }
    clearDuelSession();
    myIdRef.current = "";
    claimTokenRef.current = "";
    setRoom(null); setPlayers([]); setClaims([]);
    setIsQuickMatch(false); setRematch("idle"); setFinalScores(null);
setXpResult(null); xpAwardedRef.current = false;
gameEndedRef.current = false; startTimeRef.current = null;
    setQuitModal(false); setQuitStep("idle");
    setPhase("lobby"); setErrorMsg(null); setStatusMsg(null);
  };

  /* ── joinRematchRoom — requester follows rematch_room_id pointer ── */
  const joinRematchRoom = useCallback(async (newRoomId: string) => {
    const oldName = me?.name ?? playerName;
    clearDuelSession();
    const freshId    = freshPlayerId();
    const freshToken = freshClaimToken();
    myIdRef.current        = freshId;
    claimTokenRef.current  = freshToken;

    // duel_join_rematch_room RPC: status='waiting_rematch' kabul eder, player
    // insert + claim + atomik status='playing' transition.
    const { profileId, guestId } = getIdentityArgs();
    const { data: roomData, error: joinErr } = await supabase.rpc("duel_join_rematch_room", {
      p_new_room_id: newRoomId,
      p_player_id:   freshId,
      p_profile_id:  profileId,
      p_guest_id:    guestId,
      p_name:        oldName,
      p_claim_token: freshToken,
    });
    if (joinErr || !roomData) {
      dbgErr("duel_join_rematch_room failed", joinErr);
      setErrorMsg(describeDuelRpcError(joinErr));
      return;
    }
    const updatedRoom = roomData as DuelRoom;

    const { data: ps } = await supabase
      .from("duel_players").select("*").eq("room_id", updatedRoom.id);

    saveRoomSession(updatedRoom.id, updatedRoom.code, freshId, freshToken);
    setRoom(updatedRoom);
    setPlayers(ps ?? []);
    setClaims([]);
    setIsHost(false);
    setRematch("idle");
    gameEndedRef.current = false;
setXpResult(null); xpAwardedRef.current = false;
    setTimeLeft(updatedRoom.duration_seconds);
    setPhase("playing");
    dbg("joinRematchRoom: switched + started ✓", updatedRoom.code);
  }, [me, playerName, getIdentityArgs]);

  /* ── REMATCH (via Realtime broadcast on the finished room's channel) ── */
  const requestRematch = useCallback(() => {
    if (!room) return;
    setRematch("requested");
    // Reuse the existing realtime channel — broadcast a lightweight signal
    const chan = supabase.channel(`duel:${room.id}`);
    chan.send({ type: "broadcast", event: "rematch_request", payload: { from: myIdRef.current } });
    dbg("rematch: request sent", room.id);
  }, [room]);

  const acceptRematch = useCallback(async () => {
    if (!room) return;
    const oldRoomId      = room.id;
    const oldPlayerId    = myIdRef.current;
    const oldClaimToken  = claimTokenRef.current;
    const dbDuration     = room.duration_seconds;
    setRematch("idle");

    // ÖNEMLİ: Fresh kimliği session'a HENÜZ yazmıyoruz — duel_accept_rematch
    // RPC eski player'ı (oldPlayerId + oldClaimToken) authorize edecek.
    // RPC dönüşünde state'i yeni odaya çevirip session'ı güncelliyoruz.
    const newPlayerId = crypto.randomUUID();
    const newToken    = freshClaimToken();
    const code        = makeCode();

    const { data: newRoomData, error: rpcErr } = await supabase.rpc("duel_accept_rematch", {
      p_old_room_id:     oldRoomId,
      p_old_player_id:   oldPlayerId,
      p_old_claim_token: oldClaimToken,
      p_new_room_code:   code,
      p_new_player_id:   newPlayerId,
      p_new_claim_token: newToken,
    });

    if (rpcErr || !newRoomData) {
      dbgErr("duel_accept_rematch failed", rpcErr);
      setErrorMsg(describeDuelRpcError(rpcErr) || "Rövanş odası açılamadı.");
      return;
    }
    const newRoom = newRoomData as DuelRoom;
    dbg("acceptRematch: new room + pointer written", { oldRoomId, newRoomId: newRoom.id });

    // Yeni odaya geçiş — şimdi yeni kimliği session'a yaz
    clearDuelSession();
    localStorage.setItem(PLAYER_ID_KEY, newPlayerId);
    myIdRef.current       = newPlayerId;
    claimTokenRef.current = newToken;

    const { data: ps } = await supabase
      .from("duel_players").select("*").eq("room_id", newRoom.id);
    saveRoomSession(newRoom.id, newRoom.code, newPlayerId, newToken);
    setRoom(newRoom);
    setPlayers(ps ?? []);
    setClaims([]);
    setIsHost(true);  // Accepter = host of new room
    gameEndedRef.current = false;
setXpResult(null); xpAwardedRef.current = false;
    setTimeLeft(dbDuration);
    setPhase("waiting");
    dbg("acceptRematch: switched to new room", newRoom.code);
  }, [room]);

  const declineRematch = useCallback(() => {
    if (!room) return;
    const chan = supabase.channel(`duel:${room.id}`);
    chan.send({ type: "broadcast", event: "rematch_declined", payload: {} });
    setRematch("idle");
    dbg("rematch: declined");
  }, [room]);

  /* ─────────────────────────────────────────
     RENDER
  ───────────────────────────────────────── */
  /**
   * Result resolution priority (server-authoritative):
   *   1. finished_reason === "forfeit"  → forfeitedBy = loser, winner_player_id = winner
   *   2. winner_player_id present       → that player wins (timeout)
   *   3. winner_player_id null + timeout → draw
   *   4. Legacy fallback                 → score-based
   */
  const resolveResult = (): { emoji: string; title: string; subtitle: string | null } => {
    if (phase !== "finished" || !room) return { emoji: "", title: "", subtitle: null };
    const myId = myIdRef.current;
    const winnerId  = room.winner_player_id;
    const reason    = room.finished_reason;
    const forfeitId = room.forfeited_player_id;

    if (reason === "forfeit") {
      if (forfeitId === myId) return {
        emoji: "🏳️",
        title: "Kaybettin",
        subtitle: "Pes ettin — rakip kazandı.",
      };
      if (winnerId === myId) return {
        emoji: "🏆",
        title: "Kazandın!",
        subtitle: "Rakip pes etti.",
      };
      return { emoji: "🏳️", title: "Maç Bitti", subtitle: "Pes edildi." };
    }

    if (reason === "disconnect") {
      if (winnerId === myId) return {
        emoji: "🏆",
        title: "Kazandın!",
        subtitle: "Rakip bağlantısını kaybetti ve geri dönmedi.",
      };
      return {
        emoji: "📡",
        title: "Bağlantı Kesildi",
        subtitle: "Bağlantın kesildi ve süre doldu.",
      };
    }

    if (winnerId) {
      return winnerId === myId
        ? { emoji: "🏆", title: "Kazandın!", subtitle: null }
        : { emoji: "😔", title: "Kaybettin", subtitle: null };
    }

    if (reason === "timeout") {
      return { emoji: "🤝", title: "Berabere", subtitle: "Eşit skor." };
    }

    // Legacy fallback for old rows without DB fields
    if (myScore > oppScore) return { emoji: "🏆", title: "Kazandın!", subtitle: null };
    if (myScore < oppScore) return { emoji: "😔", title: "Kaybettin", subtitle: null };
    return { emoji: "🤝", title: "Berabere", subtitle: null };
  };
  const result = resolveResult();

  const homeTheme = readStoredHomeTheme();
  const isPreGamePhase = phase === "lobby" || phase === "creating" || phase === "waiting";
  const themeBgStyle = isPreGamePhase ? getThemeBackgroundStyle(homeTheme) : undefined;
  const themeDataAttr = isPreGamePhase ? getThemeDataAttr(homeTheme) : undefined;

  return (
    <div
      className={"app duel-screen" + (phase === "playing" ? " duel-game-active" : "")}
      style={themeBgStyle}
      data-theme={themeDataAttr}
    >

      {/* ── HEADER ── */}
      <div className="duel-header">
        <button
  className="back-btn"
  onClick={() => {
    playSound("click");
    if (phase === "playing") {
      setQuitModal(true);
      setQuitStep("idle");
      return;
    }
    onHome();
  }}
>
          <span>←</span><span className="back-label">Menü</span>
        </button>
        <div className="duel-header-center">
          <span className="duel-mode-label">⚔️ Online 1v1</span>
          {room && phase !== "lobby" && (
            <>
              <span className="duel-code-badge">#{room.code}</span>
              {phase !== "finished" && (
                <span className="duel-region-badge">{regionLabel}</span>
              )}
            </>
          )}
        </div>
        {/* Version badge — helps identify which deploy is running */}
        <span className="duel-version-badge">{DUEL_VERSION}</span>
        {phase === "playing" ? (
          <div className="timer-ring-wrap" style={{ width: 44, height: 44 }}>
            <svg viewBox="0 0 42 42" className="timer-svg">
              <circle cx="21" cy="21" r="17" fill="none" stroke="var(--border)" strokeWidth="3"/>
              <circle cx="21" cy="21" r="17" fill="none"
                stroke={timerColor} strokeWidth="3" strokeDasharray="106.8"
                strokeDashoffset={106.8 - (timerPct / 100) * 106.8}
                strokeLinecap="round"
                style={{ transform:"rotate(-90deg)", transformOrigin:"50% 50%", transition:"stroke-dashoffset 0.9s linear" }}/>
            </svg>
            <span className="timer-num" style={{ color: timerColor }}>{timeLeft}</span>
          </div>
        ) : (
          <div style={{ width: 44 }}/>
        )}
      </div>

      {/* ════════ LOBBY ════════ */}
      {(phase === "lobby" || phase === "creating") && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">⚔️ Online 1v1</h2>
            <p className="duel-lobby-desc">
              Arkadaşınla gerçek zamanlı ülke kapmaca oyna.<br/>
              Daha çok ülke yazan kazanır!
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

            {/* HOST settings block — dropdown version */}
            <div className="duel-settings-block">
              <p className="duel-settings-title">🏠 Oda Kur</p>

              <div className="duel-selects-row">
                {/* Duration select */}
                <div className="duel-select-wrap">
                  <label className="duel-select-label">Süre</label>
                  <div className="duel-select-box">
                    <select
                      className="duel-select"
                      value={hostDuration}
                      onChange={e => setHostDuration(Number(e.target.value))}
                    >
                      {DURATION_OPTS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>

                {/* Region select */}
                <div className="duel-select-wrap">
                  <label className="duel-select-label">Bölge</label>
                  <div className="duel-select-box">
                    <select
                      className="duel-select"
                      value={hostRegion}
                      onChange={e => setHostRegion(e.target.value)}
                    >
                      {REGION_OPTS.map(o => (
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
                disabled={phase === "creating"}
              >
                {phase === "creating" ? "Kuruluyor…" : "🏠 Oda Kur"}
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
                  onChange={e => setJoinCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  autoComplete="off"
                />
                <button className="btn btn-danger" onClick={joinRoom}>Katıl</button>
              </div>
            </div>

            {/* Quick Match — Bayrak/Çark deseni: auth zorunlu */}
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

            {errorMsg  && <p className="duel-error">{errorMsg}</p>}
            {statusMsg && !statusMsg.includes("Rakip") && <p className="duel-status">{statusMsg}</p>}
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

            <div style={{
              display: "flex", flexDirection: "column",
              gap: 6, margin: "16px 0", fontSize: 14,
            }}>
              <div>
                <strong>Süre:</strong> {DURATION_OPTS.find(d => d.value === hostDuration)?.label ?? `${hostDuration}sn`}{" "}
                <span style={{ opacity: 0.5 }}>·</span>{" "}
                <strong>Bölge:</strong>{" "}
                {REGION_OPTS.find(r => r.value === hostRegion)?.label ?? "🌍 Dünya"}
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

            <div style={{
              fontSize: 36, margin: "8px 0 16px",
              animation: "wd-spin 1.4s linear infinite",
              display: "inline-block",
            }}>
              ⌨️
            </div>

            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => { playSound("click"); cancelQuickMatch(); }}
            >
              ✕ Aramayı İptal Et
            </button>

            {errorMsg && (
              <p className="duel-error" style={{ marginTop: 12 }}>{errorMsg}</p>
            )}
          </div>
        </div>
      )}

      {/* ════════ WAITING ════════ */}
      {phase === "waiting" && room && (
        <div className="duel-lobby">
            <div className="duel-lobby-with-chat duel-1v1-room-layout">
            <div className="duel-lobby-card duel-1v1-room-card">
              {/* QM akışı artık `phase === "searching"` üzerinden işliyor;
                  waiting fazına yalnız manuel oda akışı düşüyor. */}
              <>
                <h2 className="duel-lobby-title" style={{ fontSize: 22, margin: "0 0 14px" }}>
  Rakip Bekleniyor…
</h2>

                {/* Big room code */}
                <div className="duel-room-code-block" style={{ margin: "0 0 12px" }}>
  <span className="duel-room-code" style={{ fontSize: 36, letterSpacing: "0.15em" }}>
    {room.code}
  </span>
  <p className="duel-room-code-hint" style={{ fontSize: 12, marginTop: 4 }}>
    6 haneli kod — arkadaşına ver
  </p>
</div>

                {/* Invite — kopyala + arkadaş davet et */}
                <LobbyInviteBar
                  inviteMessage={inviteMessage}
                  shareLink={shareLink}
                  roomCode={room.code}
                  mode="duel"
                  roomUrl={`/?duel=${room.code}`}
                />
                {/* Link preview (read-only, tap to select) */}
                <div className="duel-link-preview" style={{ marginBottom: 10 }} onClick={e => {
                  const el = e.currentTarget.querySelector("input") as HTMLInputElement | null;
                  el?.select();
                }}>
                  <input
                    className="duel-link-input"
                    readOnly
                    value={shareLink}
                    onFocus={e => e.target.select()}
                  />
                </div>

                
                {/* Room settings - host only */}
{/* Middle: players + settings */}
<div className="duel-wait-middle" style={{ marginTop: 8 }}>
  {/* Players */} 
  <div className="duel-wait-players-box">
    <div className="duel-wait-section-title">Oyuncular</div>

    <div className="duel-players-list duel-wait-players">
      {players.map((p) => (
        <div
          key={p.id}
          className={"duel-player-chip has-avatar" + (p.id === myId ? " mine" : "")}
        >
          <PlayerProfileTrigger profileId={p.profile_id} as="span" className="duel-player-id">
            <PlayerAvatar
              avatarId={rosterProfiles.get(p.profile_id ?? "")?.avatarId}
              username={p.name}
              size="sm"
              highlight={players[0]?.id === p.id}
              className="duel-player-avatar"
            />
            <span className="duel-player-name">{p.name}</span>
          </PlayerProfileTrigger>

          <div className="duel-player-tags">
            {p.id === myId && <span className="duel-tag">Sen</span>}
            {players[0]?.id === p.id && <span className="duel-tag host">👑</span>}
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

   

    {/* Host/guest bilgi mesajı oyuncular kutusunun altında */}
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
        <span>Süre</span>
        <select
          value={hostDuration}
          disabled={!isHost}
          onChange={(e) => setHostDuration(Number(e.target.value))}
        >
          <option value={60}>1 dk</option>
          <option value={120}>2 dk</option>
          <option value={180}>3 dk</option>
          <option value={300}>5 dk</option>
        </select>
      </label>

      <label className="duel-room-setting-field">
        <span>Bölge</span>
        <select
          value={hostRegion}
          disabled={!isHost}
          onChange={(e) => setHostRegion(e.target.value)}
        >
          <option value="world">🌍 Dünya</option>
          <option value="europe">Avrupa</option>
          <option value="asia">Asya</option>
          <option value="africa">Afrika</option>
          <option value="north-america">Kuzey Amerika</option>
          <option value="south-america">Güney Amerika</option>
          <option value="oceania">Okyanusya</option>
        </select>
      </label>
    </div>

    {isHost && (
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
        Ayarları buradan değiştirebilirsiniz
      </p>
    )}
    {!isHost && (
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
        Yalnızca oda sahibi değiştirebilir
      </p>
    )}
  </div>
</div>
  </div>


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
      boxSizing: "border-box",
    }}
  >
    <button
      className="btn btn-accent duel-start-btn"
      onClick={startGame}
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
      }}
    >
      🚀 Oyunu Başlat
    </button>
    <button
      className="btn btn-ghost"
      onClick={backToLobby}
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
    marginTop: 0,
    width: "100%",
    maxWidth: 610,
    marginLeft: "auto",
    marginRight: "auto",
    boxSizing: "border-box",
  }}
>
  <button
    className="btn btn-ghost btn-sm"
    onClick={backToLobby}
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
              </>
          </div>
          <div className="duel-wait-chat-align">
            <LobbyChat
              roomCode={room.code}
              playerName={effectivePlayerName}
              sendMode="duel"
              playerId={myIdRef.current}
              claimToken={claimTokenRef.current}
            />
          </div>
          </div>
        </div>
      )}
{hostClosedRoom && (
        <div className="duel-quit-backdrop" onClick={() => { setHostClosedRoom(false); backToLobby(); }}>
          <div className="duel-quit-modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: "2.5rem", marginBottom: 8 }}>🚪</div>
            <h3 className="duel-quit-title">Oda Kapatıldı</h3>
            <p className="duel-quit-sub">Oda sahibi odadan ayrıldı ve oturumu sonlandırdı.</p>
            <div className="duel-quit-actions">
              <button
                className="btn btn-accent"
                onClick={() => { setHostClosedRoom(false); backToLobby(); }}
              >
                ← Lobiye Dön
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* ════════ QUICK MATCH COUNTDOWN — playing UI'ın üstüne overlay ════════ */}
      {phase === "playing"
        && room
        && room.room_source === "quick_match"
        && countdownSeconds > 0 && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 1500,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(6px)",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                textAlign: "center",
                color: "var(--accent, #facc15)",
                fontWeight: 800,
                lineHeight: 1.1,
                userSelect: "none",
              }}
            >
              <div style={{ fontSize: 18, opacity: 0.85, marginBottom: 6 }}>
                Hazırlan…
              </div>
              <div
                style={{
                  fontSize: 96,
                  textShadow: "0 4px 24px rgba(0,0,0,0.6)",
                }}
              >
                {countdownSeconds}
              </div>
            </div>
          </div>
      )}

      {/* ════════ PLAYING (finished'da da render — arka plan blur'lansın) ════════ */}
      {(phase === "playing" || phase === "finished") && (
        <>
          {/* Score bar — with quit button and label toggle */}
          <div className="duel-score-bar">
            <div className="duel-score-mine">
              <span className="duel-score-name">{me?.name ?? "Ben"}</span>
              <span className="duel-score-num mine">{myScore}</span>
            </div>
            <span className="duel-score-vs">vs</span>
            <div className="duel-score-opp">
              <span className="duel-score-num opp">{oppScore}</span>
              <span className="duel-score-name">{opp?.name ?? "Rakip"}</span>
            </div>
            {/* Label toggle */}
            <label className="duel-label-toggle" title="Ülke isimlerini göster">
              <input
                type="checkbox"
                checked={showLabels}
                onChange={e => setShowLabels(e.target.checked)}
                className="toggle-cb"
              />
              <span className="toggle-track"><span className="toggle-thumb"/></span>
              <span className="duel-toggle-text">İsimler</span>
            </label>
            {/* Quit button */}
            <button
              className="duel-quit-btn"
              onClick={() => { setQuitModal(true); setQuitStep("idle"); }}
              title="Oyundan Çık (ESC)"
            >
              ✕ Çık
            </button>
          </div>

          {/* Opponent disconnect grace banner */}
          {oppDisconnected && (
            <div className="duel-disconnect-banner">
              📡 Rakibiniz bağlantısını kaybetti.{" "}
              {disconnectCountdown > 0
                ? <><strong>{disconnectCountdown} saniye</strong> içinde dönmezse kazanacaksınız.</>
                : "Kazandınız!"}
            </div>
          )}

          {/* Map */}
          <div className="map-area">
            <DuelMapView
              myTopoIds={myTopoIds}
              oppTopoIds={oppTopoIds}
              showLabels={showLabels}
              region={denormalizeRegion(gameRegion)}
              activeIds={allowedIds ?? undefined}
            />
          </div>

          {/* Input */}
          <div className="duel-input-bar">
            <input
              ref={inputRef}
              type="text"
              className={inputCls}
              disabled={inputLocked}
              placeholder={
                gameOver
                  ? "Süre bitti"
                  : qmCountdownActive
                    ? "Hazırlan…"
                    : allowedIds
                      ? `${regionLabel} ülkesi yaz… (Enter)`
                      : "Ülke adı yaz… (Enter)"
              }
              value={inputLocked ? "" : input}
              onChange={e => { if (!inputLocked) setInput(e.target.value); }}
              onKeyDown={e => { if (e.key === "Enter" && !inputLocked) handleGuess(); }}
              autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
            />
            <button className="btn btn-accent" onClick={handleGuess} disabled={inputLocked}>Gir</button>
            <div className="duel-fb-slot">
              {feedback === "ok"     && <span className="fb fb-ok">✓ Alındı!</span>}
              {feedback === "err"    && <span className="fb fb-no">✗ Bulunamadı</span>}
              {feedback === "dup"    && <span className="fb fb-dup">Zaten alındı</span>}
              {feedback === "region" && <span className="fb fb-no">⚠ Bu bölge dışı</span>}
            </div>
          </div>

          {/* ── Quit modal ── */}
          {quitModal && (
            <div className="duel-quit-backdrop"
              onClick={() => { setQuitModal(false); setQuitStep("idle"); }}>
              <div className="duel-quit-modal" onClick={e => e.stopPropagation()}>

                {quitStep === "idle" && (
                  <>
                    <h3 className="duel-quit-title">Maçtan çıkmak istiyor musun?</h3>
                    <p className="duel-quit-sub">Çıkış yapan oyuncu kaybetmiş sayılır.</p>
                    <div className="duel-quit-actions">
                      <button className="btn duel-quit-action forfeit"
                        onClick={() => setQuitStep("forfeit")}>
                        🏳️ Pes Et
                      </button>
                      <button className="btn duel-quit-action menu"
                        onClick={() => setQuitStep("menu")}>
                        🏠 Ana Menüye Dön
                      </button>
                      <button className="btn duel-quit-action cancel"
                        onClick={() => { setQuitModal(false); setQuitStep("idle"); }}>
                        ↩ İptal
                      </button>
                    </div>
                  </>
                )}

                {quitStep === "forfeit" && (
                  <>
                    <h3 className="duel-quit-title">Pes etmek istediğine emin misin?</h3>
                    <p className="duel-quit-sub">Bu maçı kaybetmiş sayılacaksın.</p>
                    <div className="duel-quit-actions">
                      <button className="btn duel-quit-action forfeit"
                        onClick={() => forfeit("lobby")}>
                        🏳️ Evet, Pes Et
                      </button>
                      <button className="btn duel-quit-action cancel"
                        onClick={() => setQuitStep("idle")}>
                        ↩ Vazgeç
                      </button>
                    </div>
                  </>
                )}

                {quitStep === "menu" && (
                  <>
                    <h3 className="duel-quit-title">Ana Menüye Dön?</h3>
                    <p className="duel-quit-sub">
                      Maç devam ediyor. Ana menüye dönersen kaybetmiş sayılacaksın.
                    </p>
                    <div className="duel-quit-actions">
                      <button className="btn duel-quit-action forfeit"
                        onClick={() => forfeit("home")}>
                        ✓ Evet, çık
                      </button>
                      <button className="btn duel-quit-action cancel"
                        onClick={() => setQuitStep("idle")}>
                        ↩ Geri
                      </button>
                    </div>
                  </>
                )}

              </div>
            </div>
          )}
        </>
      )}

      {/* ════════ FINISHED — overlay (arka plan = blur'lu playing UI) ════════ */}
      {phase === "finished" && (
        <div className="wheel-result-backdrop">
          <div className="duel-result-card">
            <div className="duel-result-emoji">{result.emoji}</div>
            <h2 className="duel-result-title">{result.title}</h2>
            {result.subtitle && (
              <p className="duel-result-subtitle">{result.subtitle}</p>
            )}

            {/* Scores */}
            <div className="duel-result-scores">
              <div className="duel-result-col mine">
                <span className="duel-result-name">{me?.name ?? "Ben"}</span>
                <span className="duel-result-num">
                  {finalScores?.my ?? myScore}
                </span>
                <span className="duel-result-sub">ülke</span>
              </div>
              <span className="duel-result-vs">—</span>
              <div className="duel-result-col opp">
                <span className="duel-result-num">
                  {finalScores?.opp ?? oppScore}
                </span>
                <span className="duel-result-name">{opp?.name ?? "Rakip"}</span>
                <span className="duel-result-sub">ülke</span>
              </div>
            </div>

            {/* Meta */}
            <div className="wheel-result-rows">
              <div className="wheel-result-row">
                <span>Süre</span>
                <strong>{durationLabel}</strong>
              </div>
              <div className="wheel-result-row">
                <span>Bölge</span>
                <strong>{regionLabel}</strong>
              </div>
              <div className="wheel-result-row">
                <span>Yazılan ülke</span>
                <strong>{claims.length}</strong>
              </div>
            </div>

            {errorMsg && <p className="duel-error">{errorMsg}</p>}

            {/* ── Rematch section ── */}
            <div className="duel-rematch-area">
              {rematch === "idle" && opp && (
                <button className="btn duel-rematch-btn" onClick={requestRematch}>
                  ⚔️ Rövanş İste
                </button>
              )}
              {rematch === "requested" && (
                <p className="duel-rematch-status waiting">
                  ⏳ Rövanş isteği gönderildi, rakip bekleniyor…
                </p>
              )}
              {rematch === "received" && (
                <div className="duel-rematch-incoming">
                  <p className="duel-rematch-status">⚔️ Rakibin rövanş istiyor!</p>
                  <div className="duel-rematch-btns">
                    <button className="btn btn-accent btn-sm" onClick={acceptRematch}>Kabul Et</button>
                    <button className="btn btn-ghost  btn-sm" onClick={declineRematch}>Reddet</button>
                  </div>
                </div>
              )}
              {rematch === "declined" && (
                <p className="duel-rematch-status declined">😞 Rakip rövanşı reddetti.</p>
              )}
            </div>

            {/* ── Actions ── */}
            <div className="duel-result-actions">
              {!profile?.username ? (
                <button
                  className="btn btn-accent"
                  disabled
                  title="Hızlı eşleş için giriş gerekli"
                >
                  ⚡ Hızlı Eşleş <span style={{ opacity: 0.65 }}>(Giriş Gerekli)</span>
                </button>
              ) : (
                <button
                  className="btn btn-accent"
                  onClick={() => {
                    // Sonuç ekranından doğrudan yeni aramaya geç.
                    // setState batch'inden sonra startQuickMatch tetiklensin.
                    Promise.resolve().then(() => startQuickMatch());
                  }}
                >
                  ⚡ Hızlı Eşleş
                </button>
              )}
              <button className="btn btn-ghost" onClick={onHome}>
                ⌂ Ana Menü
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ XP KAZANIMI — fixed footer ════════ */}
      {xpResult && xpFooterVisible && !xpResult.dismissed && (
        <XpGainBar
          key={xpResult.roomKey}
          modeLabel="Kapmaca"
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