/**
 * DuelGroupGame.tsx — Online Çok Oyunculu Mod (Ülke Yaz, 3–10 kişi)
 *
 * Bu dosya mevcut 1v1 DuelGame.tsx'e DOKUNMAZ. Tamamen ayrı bir component
 * ve ayrı Supabase tabloları (duel_group_rooms / duel_group_players /
 * duel_group_claims) kullanır.
 *
 * ─────────────────────────────────────────────────────────────────
 * ⚠️  Supabase setup (gerekli SQL — bir defa çalıştır):
 *
 *   CREATE TABLE IF NOT EXISTS duel_group_rooms (
 *     id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     code              text UNIQUE NOT NULL,
 *     status            text NOT NULL DEFAULT 'waiting',
 *                       -- 'waiting' | 'playing' | 'finished'
 *     duration_seconds  int  NOT NULL DEFAULT 60,
 *     region            text NOT NULL DEFAULT 'world',
 *     max_players       int  NOT NULL DEFAULT 10,
 *     started_at        timestamptz,
 *     created_at        timestamptz NOT NULL DEFAULT now(),
 *     updated_at        timestamptz NOT NULL DEFAULT now()
 *   );
 *
 *   CREATE TABLE IF NOT EXISTS duel_group_players (
 *     id            uuid PRIMARY KEY,
 *     room_id       uuid NOT NULL REFERENCES duel_group_rooms(id) ON DELETE CASCADE,
 *     name          text NOT NULL,
 *     is_host       boolean NOT NULL DEFAULT false,
 *     joined_at     timestamptz NOT NULL DEFAULT now(),
 *     last_seen_at  timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX IF NOT EXISTS duel_group_players_room_idx ON duel_group_players(room_id);
 *
 *   CREATE TABLE IF NOT EXISTS duel_group_claims (
 *     id            bigserial PRIMARY KEY,
 *     room_id       uuid NOT NULL REFERENCES duel_group_rooms(id) ON DELETE CASCADE,
 *     player_id     uuid NOT NULL,
 *     country_code  text NOT NULL,
 *     created_at    timestamptz NOT NULL DEFAULT now(),
 *     UNIQUE (room_id, country_code)   -- aynı ülkeyi sadece ilk yazan alır
 *   );
 *   CREATE INDEX IF NOT EXISTS duel_group_claims_room_idx ON duel_group_claims(room_id);
 *
 *   ALTER TABLE duel_group_rooms   ENABLE ROW LEVEL SECURITY;
 *   ALTER TABLE duel_group_players ENABLE ROW LEVEL SECURITY;
 *   ALTER TABLE duel_group_claims  ENABLE ROW LEVEL SECURITY;
 *
 *   CREATE POLICY "anon_all_group_rooms"   ON duel_group_rooms   FOR ALL TO anon USING (true) WITH CHECK (true);
 *   CREATE POLICY "anon_all_group_players" ON duel_group_players FOR ALL TO anon USING (true) WITH CHECK (true);
 *   CREATE POLICY "anon_all_group_claims"  ON duel_group_claims  FOR ALL TO anon USING (true) WITH CHECK (true);
 *
 *   -- Auth oturumu olan kullanıcılar (Supabase Auth) authenticated rolüyle
 *   -- istek gönderir. Yukarıdaki politikalar sadece anon'a izin verdiği için
 *   -- logged-in host'un startGame DELETE'i sessizce 0 satır siliyor ve eski
 *   -- maç claim'leri rövanşta UNIQUE(room_id, country_code)'i tetikliyor.
 *   -- Aşağıdaki ek politika 20260522120000_duel_group_claims_auth_policy.sql
 *   -- migration'ı ile uygulanır:
 *   CREATE POLICY "duel_group_claims_all_authenticated"
 *     ON duel_group_claims FOR ALL TO authenticated
 *     USING (true) WITH CHECK (true);
 *
 *   -- Realtime'ı her üç tabloda etkinleştir.
 *   ALTER PUBLICATION supabase_realtime ADD TABLE duel_group_rooms;
 *   ALTER PUBLICATION supabase_realtime ADD TABLE duel_group_players;
 *   ALTER PUBLICATION supabase_realtime ADD TABLE duel_group_claims;
 * ─────────────────────────────────────────────────────────────────
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase } from "../lib/supabase";
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
import { readStoredHomeTheme, getThemeBackgroundStyle, getThemeDataAttr } from "../lib/themeBackgrounds";
import { getSyncedNowMs, initServerClockSync } from "../lib/serverClock";
import {
  DUEL_GROUP_COLORS,
  DUEL_GROUP_COLOR_LABEL,
  DUEL_GROUP_COLOR_HEX,
  DUEL_GROUP_FALLBACK_HEX,
  hexForDuelGroupColor,
  resolveDuelGroupColors,
  type DuelGroupColor,
} from "../lib/duelGroupColors";

/* ─── Lokal type'lar (lib/supabase.ts'i kirletmemek için) ─── */
interface GroupRoom {
  id:               string;
  code:             string;
  status:           "waiting" | "playing" | "finished";
  duration_seconds: number;
  region:           string;
  max_players:      number;
  started_at:       string | null;
  created_at:       string;
  updated_at:       string;
}
interface GroupPlayer {
  id:           string;
  room_id:      string;
  name:         string;
  is_host:      boolean;
  joined_at:    string;
  last_seen_at: string;
  status: "waiting" | "playing" | "finished";
  color_key:    string | null;
}
interface GroupClaim {
  id:           number;
  room_id:      string;
  player_id:    string;
  country_code: string;
  created_at:   string;
}

/* ─── Sabitler ─── */
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;

const DURATION_OPTS = [
  { label: "1 dk",  value: 60  },
  { label: "2 dk",  value: 120 },
  { label: "3 dk",  value: 180 },
  { label: "5 dk",  value: 300 },
  { label: "10 dk", value: 600 },
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

/** DB'de kullanılacak normalize edilmiş region değeri (1v1 ile aynı kuralla) */
const normalizeRegion = (r: string): string => {
  const map: Record<string, string> = {
    "north-america": "north_america",
    "south-america": "south_america",
  };
  return map[r] ?? r;
};
const denormalizeRegion = (r: string): string => {
  const map: Record<string, string> = {
    "north_america": "north-america",
    "south_america": "south-america",
  };
  return map[r] ?? r;
};

/* ─── localStorage helpers (1v1'inkinden ayrı namespace) ─── */
const PLAYER_ID_KEY = "geoquiz_group_player_id";
const ROOM_KEY      = "geoquiz_group_room";
const GUEST_ID_KEY  = "geoquiz_group_guest_id";   // stabil guest_id (logged-out)

function makeCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

function dbg(label: string, obj?: unknown) {
  console.log(`[DuelGroupGame] ${label}`, obj ?? "");
}
function dbgErr(label: string, err?: unknown, ctx?: unknown) {
  console.error(`[DuelGroupGame] ❌ ${label}`, err, ctx ?? "");
}

function freshPlayerId(): string {
  const id = crypto.randomUUID();
  localStorage.setItem(PLAYER_ID_KEY, id);
  return id;
}

/**
 * Fresh claim_token: M1'de eklenen duel_group_player_claims tablosuna her
 * yeni player satırı için bir tane yazılır. Session ile persist edilir;
 * reload sonrasında aynı player_id ile devam edebilmek için kritik.
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
    if (!parsed?.roomId || !parsed?.roomCode || !parsed?.playerId) return null;
    // claimToken eski (M1 öncesi) session'larda olmayabilir — fresh akışa düş
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

function clearGroupSession() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    // GUEST_ID_KEY'i koru — her oturumda yeni misafir kimliği üretmek istemiyoruz
    if (k && k.startsWith("geoquiz_group") && k !== GUEST_ID_KEY) {
      keys.push(k);
    }
  }
  keys.forEach(k => localStorage.removeItem(k));
}

/* ─── Duel Group RPC error mapper ────────────────────────────────────
 *  M2 RPC'leri PG raise exception ile business hata mesajları döner
 *  (örn. 'room_full', 'name_taken'). Bunları kullanıcı dostu Türkçe
 *  metne çevirir. Mevcut UI metinleri ile birebir uyumlu kalır.
 */
interface DuelGroupRpcError { code?: string; message?: string; details?: string }
function describeDuelGroupRpcError(err: DuelGroupRpcError | null | undefined): string {
  if (!err) return "İşlem başarısız.";
  const m = (err.message ?? "") + " " + (err.details ?? "");
  if (m.includes("code_taken"))               return "Bu kod kullanımda. Tekrar dene.";
  if (m.includes("name_taken"))               return "Bu isim bu odada kullanılıyor. Farklı bir isim seç.";
  if (m.includes("room_full"))                return "Oda dolu.";
  if (m.includes("room_not_found"))           return "Oda bulunamadı. Kodu kontrol et.";
  if (m.includes("room_finished"))            return "Bu oyun zaten bitti.";
  if (m.includes("room_in_progress"))         return "Oyun başladı, katılamazsın.";
  if (m.includes("room_not_waiting"))         return "Oda artık bekleme aşamasında değil.";
  if (m.includes("room_not_playing"))         return "Oda artık oyunda değil.";
  if (m.includes("room_not_finished"))        return "Oda henüz bitmedi.";
  if (m.includes("not_enough_players"))       return "En az 3 oyuncu gerekli.";
  if (m.includes("max_players_invalid"))      return "Geçersiz oyuncu sayısı (3–10).";
  if (m.includes("max_players_too_low"))      return "Maksimum oyuncu sayısı şu an odada olan kişi sayısından düşük olamaz.";
  if (m.includes("name_invalid"))             return "Geçersiz isim.";
  if (m.includes("profile_mismatch"))         return "Oturum doğrulaması başarısız.";
  if (m.includes("player_room_mismatch"))     return "Bu odada oyuncun yok.";
  if (m.includes("cannot_kick_self"))         return "Kendini odadan çıkaramazsın.";
  if (m.includes("unauthorized"))             return "Bu işlem için yetkin yok.";
  if (m.includes("room_unavailable"))         return "Oda kullanılamıyor.";
  if (m.includes("color_taken"))              return "Bu renk başkası tarafından seçilmiş.";
  if (m.includes("color_invalid"))            return "Geçersiz renk.";
  if (err.code === "42501")                   return "Veritabanı izin hatası.";
  return err.message || "İşlem başarısız.";
}

function buildAllowedSet(region: string): Set<string> | null {
  if (region === "world") return null;
  const key = denormalizeRegion(region);
  return getContinentIds(key as Continent);
}

type Phase = "lobby" | "creating" | "waiting" | "playing" | "finished";

interface Props {
  onHome: () => void;
  profile?: Profile | null;
  countdownSoundMode?: CountdownSoundMode;
}

export default function DuelGroupGame({
  onHome,
  profile,
  countdownSoundMode = "last20",
}: Props) {
  /* identity */
  const myIdRef = useRef<string>("");
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
  const [hostDuration, setHostDuration] = useState(120);
  const [hostRegion,   setHostRegion]   = useState("world");
  const [hostMaxPlayers, setHostMaxPlayers] = useState(10);

  /* phase / messages */
  const [phase,     setPhase]     = useState<Phase>("lobby");
  const [errorMsg,  setErrorMsg]  = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [kickedNoticeOpen, setKickedNoticeOpen] = useState(false);
  const [roomClosedNoticeOpen, setRoomClosedNoticeOpen] = useState(false);
  const [dggChatOpen, setDggChatOpen] = useState(false);
  const [dggPlayersOpen, setDggPlayersOpen] = useState(false);
  const [newHostNoticeOpen, setNewHostNoticeOpen] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);

  /* viewport breakpoint (desktop ≥ 900px) — for end-screen 2-card layout */
  const [isWideViewport, setIsWideViewport] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth >= 900 : true,
  );
  useEffect(() => {
    const onResize = () => setIsWideViewport(window.innerWidth >= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* game state */
  const [room,     setRoom]     = useState<GroupRoom | null>(null);
  const [players,  setPlayers]  = useState<GroupPlayer[]>([]);
  const [kickTarget, setKickTarget] = useState<GroupPlayer | null>(null);
  const [claims,   setClaims]   = useState<GroupClaim[]>([]);
  const [timeLeft, setTimeLeft] = useState(60);
  const [isHost,   setIsHost]   = useState(false);
  const [input,    setInput]    = useState("");
  const [feedback, setFeedback] = useState<"ok" | "err" | "dup" | "region" | null>(null);
  const [copied,   setCopied]   = useState(false);
  const [showLabels] = useState(true);
  const [quitModal, setQuitModal] = useState(false);

  // Frozen leaderboard at game end
  const [finalLeaderboard, setFinalLeaderboard] =
    useState<Array<{ playerId: string; name: string; score: number }> | null>(null);

  /* refs */
  const inputRef     = useRef<HTMLInputElement>(null);
  const rafRef       = useRef<number | null>(null);
  const fbTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameEndedRef = useRef(false);
  const phaseRef     = useRef<Phase>("lobby");
  const isHostRef    = useRef(false);
  const roomIdRef    = useRef<string>("");
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeLeftRef  = useRef<number>(9999);
  const countdownPlayedRef = useRef(false);
  const leavingRef   = useRef(false);
  const lastSeenIsHostRef = useRef<boolean | null>(null);

  /* derived */
  const gameDuration = room?.duration_seconds ?? hostDuration;
  const gameRegion   = room?.region ?? hostRegion;
  const allowedIds   = useMemo(() => buildAllowedSet(gameRegion), [gameRegion]);
  const regionLabel  = REGION_OPTS.find(r => r.value === denormalizeRegion(gameRegion))?.label
    ?? REGION_OPTS.find(r => r.value === gameRegion)?.label
    ?? "Dünya";
  const durationLabel = DURATION_OPTS.find(d => d.value === gameDuration)?.label ?? `${gameDuration}sn`;
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

  if (countdownLimit === 0 || gameDuration <= countdownLimit) {
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
}, [phase, timeLeft, gameDuration, countdownSoundMode]);

useEffect(() => {
  return () => {
    stopSound("countdown20");
  };
}, []);

  /* mobile sheet'ler waiting fazından çıkınca otomatik kapansın */
  useEffect(() => {
    if (phase !== "waiting") {
      setDggChatOpen(false);
      setDggPlayersOpen(false);
      setColorPickerOpen(false);
    }
  }, [phase]);

  /* renk seçici dışında bir yere tıklanırsa kapansın */
  useEffect(() => {
    if (!colorPickerOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-dgg-color-picker]")) return;
      setColorPickerOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [colorPickerOpen]);

  /* sync refs */
  phaseRef.current  = phase;
  isHostRef.current = isHost;
  timeLeftRef.current = timeLeft;
  if (room) roomIdRef.current = room.id;

  /* skor hesabı: claims tablosundan canlı */
  const scoreMap = useMemo(() => {
    const m: Record<string, number> = {};
    claims.forEach(c => { m[c.player_id] = (m[c.player_id] ?? 0) + 1; });
    return m;
  }, [claims]);

  const myScore = scoreMap[myId] ?? 0;
  
  // Lobi listesi odadaki TÜM oyuncuları gösterir. status filtresi YOK:
  // oyun bittikten sonra her client kendi satırını 'finished' yapar; host
  // "Lobiye dön" RPC'siyle hepsini 'waiting'e resetleyene kadar status
  // 'finished' kalabilir. Status'a göre filtrelersek host'tan önce lobiye
  // dönen misafir kendi satırını dahi göremez. Üyelik = duel_group_players
  // tablosunda satır olması; realtime DELETE/leave/kick listeyi temizliyor.
  const waitingPlayers = players;
 
/* leaderboard: tüm oyuncular skora göre sıralı */
  const leaderboard = useMemo(() => {
    return players
      .map(p => ({
        playerId: p.id,
        name:     p.name,
        score:    scoreMap[p.id] ?? 0,
        isMe:     p.id === myId,
        isHost:   p.is_host,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }, [players, scoreMap, myId]);

  /* harita için: benim claim'lerim ve diğerlerinin */
  const myTopoIds  = useMemo(
    () => new Set(claims.filter(c => c.player_id === myId).map(c => c.country_code)),
    [claims, myId],
  );
  const otherTopoIds = useMemo(
    () => new Set(claims.filter(c => c.player_id !== myId).map(c => c.country_code)),
    [claims, myId],
  );

  /* renk haritası: her oyuncu → renk anahtarı (resolved + fallback) */
  const colorByPlayerId = useMemo(
    () => resolveDuelGroupColors(
      [...players].sort((a, b) => (a.joined_at ?? "").localeCompare(b.joined_at ?? "")),
    ),
    [players],
  );

  /* harita: ülke kodu → hex renk (claim sahibinin rengi) */
  const claimColorMap = useMemo(() => {
    const m: Record<string, string> = {};
    claims.forEach(c => {
      const color = colorByPlayerId[c.player_id];
      m[c.country_code] = color ? DUEL_GROUP_COLOR_HEX[color] : DUEL_GROUP_FALLBACK_HEX;
    });
    return m;
  }, [claims, colorByPlayerId]);


  const shareLink = room ? `${location.origin}${location.pathname}?duelGroup=${room.code}` : "";
  const timerPct  = gameDuration > 0 ? (timeLeft / gameDuration) * 100 : 0;
  const timerColor =
    timeLeft > gameDuration * 0.33 ? "var(--accent)" :
    timeLeft > gameDuration * 0.13 ? "#f59e0b" : "#ef4444";
  const gameOver = gameEndedRef.current || timeLeft <= 0 || phase === "finished";
  const inputCls = ["duel-input",
    feedback === "ok"  ? "ok"  : "",
    feedback === "err" || feedback === "dup" || feedback === "region" ? "err" : "",
    gameOver ? "disabled" : "",
  ].filter(Boolean).join(" ");

  /* ── feedback helper ── */
  const showFeedback = useCallback((type: "ok" | "err" | "dup" | "region") => {
    if (fbTimerRef.current) clearTimeout(fbTimerRef.current);
    setFeedback(type);
    if (type === "ok")  playSound("correct");
    else if (type === "err" || type === "region") playSound("wrong");
    fbTimerRef.current = setTimeout(() => setFeedback(null), 900);
  }, []);

  /* ── ?duelGroup=CODE URL paramı ── */
  useEffect(() => {
    const code = new URLSearchParams(location.search).get("duelGroup");
    if (code) setJoinCode(code.toUpperCase());
  }, []);

  /* ── Session restore ── */
  useEffect(() => {
    const saved = loadRoomSession();
    if (!saved) return;

    myIdRef.current       = saved.playerId;
    claimTokenRef.current = saved.claimToken;

    (async () => {
      const { data: r } = await supabase
        .from("duel_group_rooms").select("*").eq("id", saved.roomId).single();
      if (!r || r.status === "finished") {
        clearGroupSession();
        return;
      }
      const { data: ps } = await supabase
        .from("duel_group_players").select("*").eq("room_id", r.id);
      const isMe = (ps ?? []).some((p: GroupPlayer) => p.id === saved.playerId);
      if (!isMe) {
        clearGroupSession();
        return;
      }
      const room = r as GroupRoom;
      const myRow = (ps ?? []).find((p: GroupPlayer) => p.id === saved.playerId);
      setRoom(room);
      setPlayers(ps ?? []);
      setIsHost(!!myRow?.is_host);
      setTimeLeft(room.duration_seconds);
      if (r.status === "playing") {
        const { data: cs } = await supabase
          .from("duel_group_claims").select("*").eq("room_id", r.id);
        setClaims(cs ?? []);
        setPhase("playing");
      } else {
        setPhase("waiting");
      }
      dbg("session restore ✓", { roomId: r.id, status: r.status });
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Realtime ── */
  useEffect(() => {
    if (!room) return;

    const chan = supabase.channel(`duel-group:${room.id}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "duel_group_rooms", filter: `id=eq.${room.id}` },
        async (payload: { new: GroupRoom }) => {
          const r = payload.new as GroupRoom;
          setRoom(r);

          if (r.status === "playing" && phaseRef.current !== "playing") {
            dbg("RT room → playing", r.started_at);
            // Yeni maç başladı — önceki maçtan kalan yerel state'i temizle.
            // Host duel_group_claims tablosunu siliyor ama realtime sadece INSERT
            // dinlediği için diğer client'lar stale claims taşıyor; burada düşürüyoruz.
            setClaims([]);
            setFinalLeaderboard(null);
            gameEndedRef.current = false;
            setPhase("playing");
          }
          if (r.status === "finished" && !gameEndedRef.current) {
            gameEndedRef.current = true;
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
            await freezeLeaderboard(r.id, r.started_at);
            clearGroupSession();
            setPhase("finished");
          }
        })
      .on("postgres_changes",
        { event: "DELETE", schema: "public", table: "duel_group_rooms", filter: `id=eq.${room.id}` },
        () => {
          if (leavingRef.current) return;
          if (phaseRef.current !== "waiting" && phaseRef.current !== "playing") return;
          if (gameEndedRef.current) return;
          leavingRef.current = true;
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
          clearGroupSession();
          setRoom(null);
          setPlayers([]);
          setClaims([]);
          setIsHost(false);
          setFinalLeaderboard(null);
          setErrorMsg(null);
          setStatusMsg(null);
          setQuitModal(false);
          setNewHostNoticeOpen(false);
          gameEndedRef.current = false;
          lastSeenIsHostRef.current = null;
          setRoomClosedNoticeOpen(true);
          setPhase("lobby");
          leavingRef.current = false;
        })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "duel_group_players", filter: `room_id=eq.${room.id}` },
        () => {
          // Tüm değişikliklerde listeyi yeniden çek (basit, doğru)
          supabase.from("duel_group_players")
            .select("*").eq("room_id", room.id)
            .then(({ data }: { data: GroupPlayer[] | null }) => {
              if (!data) return;
              setPlayers(data as GroupPlayer[]);
            });
        })
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "duel_group_claims", filter: `room_id=eq.${room.id}` },
        (payload: { new: GroupClaim }) => {
          if (gameEndedRef.current || phaseRef.current === "finished") return;
          setClaims(prev => {
            const c = payload.new as GroupClaim;
            if (prev.some(x => x.id === c.id)) return prev;
            return [...prev, c];
          });
        })
      .subscribe();

    return () => { supabase.removeChannel(chan); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  /* ── Realtime fallback poll (waiting fazı için player listesi) ── */
  useEffect(() => {
    if (phase !== "waiting" || !room?.id) return;
    const roomId = room.id;
    const t = setInterval(async () => {
      const { data } = await supabase
        .from("duel_group_players").select("*").eq("room_id", roomId);
      if (data) setPlayers(data as GroupPlayer[]);
      // status değişti mi kontrol et (host başlattı vs.)
      const { data: r } = await supabase
        .from("duel_group_rooms").select("*").eq("id", roomId).single();
      if (r && r.status === "playing" && phaseRef.current === "waiting") {
        setRoom(r as GroupRoom);
        // Realtime kaçırılmış olabilir; yeni maçta önceki claim state'i hayatta kalmasın.
        setClaims([]);
        setFinalLeaderboard(null);
        gameEndedRef.current = false;
        setPhase("playing");
      }
    }, 2000);
    return () => clearInterval(t);
  }, [phase, room?.id]);

  /* ── Realtime fallback poll (playing fazı için bitiş tespiti) ── */
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
          .from("duel_group_rooms")
          .select("status, started_at")
          .eq("id", roomId).single();
        if (!data) return;
        if (data.status === "finished" && !gameEndedRef.current) {
          gameEndedRef.current = true;
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          await freezeLeaderboard(roomId, data.started_at);
          setRoom(prev => prev ? { ...prev, status: "finished" } : prev);
          clearGroupSession();
          setPhase("finished");
        }
      } catch { /* ignore */ }
    }, 1500);
    return () => {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, room?.id]);

  /* ── Server-clock sync ──
   *  room.started_at server `now()` ile yazılıyor; her client onu kendi
   *  Date.now()'una göre okuyunca PC saatleri arasındaki fark (5 sn'ye
   *  kadar) timer'a doğrudan kayma olarak yansıyor. initServerClockSync()
   *  bir RPC ile offset'i ölçüp getSyncedNowMs() üzerinden tüm hesapları
   *  aynı epoch referansına oturtuyor. Waiting/playing fazlarında aktif —
   *  lobby'de gereksiz probe atmaz.
   */
  useEffect(() => {
    if (phase !== "waiting" && phase !== "playing") return;
    const handle = initServerClockSync();
    return () => handle.dispose();
  }, [phase]);

  /* ── Server-authoritative timer (1v1 ile aynı mantık) ── */
  useEffect(() => {
    if (phase !== "playing") return;
    if (!room?.started_at) return;

    const totalMs = gameDuration * 1000;
    let done = false;

    const tick = () => {
      if (done) return;
      const now      = getSyncedNowMs();
      const startMs  = room.started_at ? new Date(room.started_at).getTime() : now;
      const endMs    = startMs + totalMs;
      const remMs    = Math.max(0, endMs - now);
      const remSec   = Math.floor(remMs / 1000);
      const safeRem  = Math.min(gameDuration, remSec);
      setTimeLeft(safeRem);

      if (now >= endMs) {
        done = true;
        if (!gameEndedRef.current) finishGameByTimeout();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const onVis = () => {
      if (document.visibilityState === "visible" && !done) {
        if (phaseRef.current !== "playing") { done = true; return; }
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      done = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gameDuration, room?.started_at]);

  /* ── auto-focus oyun başlayınca ── */
  useEffect(() => {
    if (phase === "playing") setTimeout(() => inputRef.current?.focus(), 100);
  }, [phase]);

  /* — oyun bitince bu oyuncuyu finished işaretle — */
useEffect(() => {
  if (phase !== "finished" || !room || !myIdRef.current) return;
  if (!claimTokenRef.current) return;

  supabase.rpc("duel_group_mark_finished", {
    p_room_id:     room.id,
    p_player_id:   myIdRef.current,
    p_claim_token: claimTokenRef.current,
  }).then(({ error }: { error: unknown }) => {
    if (error) dbgErr("duel_group_mark_finished failed", error);
  });
}, [phase, room]);

  /* ── ESC → quit modal ── */
  useEffect(() => {
    if (phase !== "playing") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setQuitModal(prev => !prev);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [phase]);

  /* ── Lightweight heartbeat: sadece guess ya da focus event'inde last_seen güncelle ──
   *    (saniyelik DB write yok; ölçeklenebilirlik kuralı)
   */
  const heartbeatThrottleRef = useRef(0);
  const touchHeartbeat = useCallback(() => {
    if (!myIdRef.current || !claimTokenRef.current) return;
    const now = Date.now();
    if (now - heartbeatThrottleRef.current < 5000) return;
    heartbeatThrottleRef.current = now;
    supabase.rpc("duel_group_heartbeat", {
      p_player_id:   myIdRef.current,
      p_claim_token: claimTokenRef.current,
    }).then(({ error }: { error: unknown }) => {
      if (error) dbgErr("heartbeat rpc failed", error);
    });
  }, []);

  /* ── Final leaderboard'u dondur ── */
  const freezeLeaderboard = useCallback(async (roomId: string, matchStartedAt: string | null | undefined) => {
    // Önceki maçtan kalmış olabilecek claim satırlarını saymamak için yalnızca
    // mevcut maçın started_at değerinden sonra oluşturulan claim'leri sayıyoruz.
    // Live scoreboard zaten yalnızca bu maçta gelen realtime INSERT'leri tutuyor;
    // burada DB sorgusunu da aynı pencereye sıkıştırıyoruz ki iki kaynak tutarlı olsun.
    const sinceTs = matchStartedAt ?? "1970-01-01T00:00:00Z";
    const [csRes, psRes] = await Promise.all([
      supabase.from("duel_group_claims")
        .select("player_id")
        .eq("room_id", roomId)
        .gte("created_at", sinceTs),
      supabase.from("duel_group_players").select("id, name").eq("room_id", roomId),
    ]);
    const cs: Array<{ player_id: string }> = csRes?.data ?? [];
    const ps: Array<{ id: string; name: string }> = psRes?.data ?? [];

    const counts: Record<string, number> = {};
    cs.forEach(c => { counts[c.player_id] = (counts[c.player_id] ?? 0) + 1; });

    const board: Array<{ playerId: string; name: string; score: number }> =
      ps.map(p => ({
        playerId: p.id,
        name:     p.name,
        score:    counts[p.id] ?? 0,
      }));

    board.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    setFinalLeaderboard(board);
    dbg("final leaderboard frozen", board);
  }, []);

  /* ── Süre dolunca finish (her client çağırabilir, atomic update kazanır) ── */
  const finishGameByTimeout = useCallback(async () => {
    if (gameEndedRef.current || !room) return;
    gameEndedRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }

    await freezeLeaderboard(room.id, room.started_at);

    // duel_group_finish_game RPC: conditional update (status='playing' guard)
    // → double-call no-op (idempotent). Herhangi bir oyuncu tetikleyebilir.
    const { error } = await supabase.rpc("duel_group_finish_game", {
      p_room_id:     room.id,
      p_player_id:   myIdRef.current,
      p_claim_token: claimTokenRef.current,
    });
    if (error) dbgErr("duel_group_finish_game failed", error);

    setRoom(prev => prev ? { ...prev, status: "finished" } : prev);
    setPhase("finished");
    clearGroupSession();
  }, [room, freezeLeaderboard]);

  /* — KICKED CHECK: odadan silinen oyuncuyu lobby ekranına düşür — */
useEffect(() => {
  if (!room) return;
  if (phase !== "waiting") return;
  if (!myIdRef.current) return;
  if (!players.length) return;
  if (leavingRef.current) return; // kendi rızasıyla ayrılıyorsak kick modal'ı tetikleme

  const stillInRoom = players.some((p) => p.id === myIdRef.current);

  if (!stillInRoom) {
    clearGroupSession();
    setRoom(null);
    setPlayers([]);
    setClaims([]);
    setIsHost(false);
    setFinalLeaderboard(null);
    setErrorMsg(null);
    setStatusMsg(null);
    setKickedNoticeOpen(true);
    setPhase("lobby");
  }
}, [room, phase, players]);

  /* — HOST TRANSFER DETECTION: yerel is_host değişimini izle, yeni hosta modal göster — */
  useEffect(() => {
    if (!room) {
      lastSeenIsHostRef.current = null;
      return;
    }
    if (!myIdRef.current || !players.length) return;

    const me = players.find((p) => p.id === myIdRef.current);
    if (!me) return;

    const nowHost = !!me.is_host;
    const prev = lastSeenIsHostRef.current;

    if (prev === null) {
      // İlk gözlem: sadece seed et, modal tetikleme
      lastSeenIsHostRef.current = nowHost;
      if (nowHost !== isHostRef.current) setIsHost(nowHost);
      return;
    }

    if (nowHost !== prev) {
      lastSeenIsHostRef.current = nowHost;
      setIsHost(nowHost);
      if (nowHost && !prev && phaseRef.current === "waiting") {
        setNewHostNoticeOpen(true);
      }
    }
  }, [room, players]);

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

    const safeMax = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, hostMaxPlayers));

    setErrorMsg(null);
    setStatusMsg("Oda kuruluyor…");
    setPhase("creating");

    clearGroupSession();
    const freshId    = freshPlayerId();
    const freshToken = freshClaimToken();
    myIdRef.current        = freshId;
    claimTokenRef.current  = freshToken;

    const code = makeCode();
    const { profileId, guestId } = getIdentityArgs();

    // duel_group_create_room RPC: room + host player + claim tek transaction
    const { data: roomData, error: roomErr } = await supabase.rpc("duel_group_create_room", {
      p_player_id:   freshId,
      p_profile_id:  profileId,
      p_guest_id:    guestId,
      p_name:        name,
      p_code:        code,
      p_duration:    hostDuration,
      p_region:      normalizeRegion(hostRegion),
      p_max_players: safeMax,
      p_claim_token: freshToken,
    });

    if (roomErr || !roomData) {
      dbgErr("duel_group_create_room failed", roomErr);
      setErrorMsg(describeDuelGroupRpcError(roomErr));
      setStatusMsg(null); setPhase("lobby"); return;
    }

    const newRoom = roomData as GroupRoom;

    const { data: ps } = await supabase
      .from("duel_group_players").select("*").eq("room_id", newRoom.id);

    setRoom(newRoom);
    setPlayers((ps as GroupPlayer[]) ?? []);
    setClaims([]);
    setIsHost(true);
    saveRoomSession(newRoom.id, newRoom.code, freshId, freshToken);
    setTimeLeft(hostDuration);
    setStatusMsg(null);
    setPhase("waiting");
    dbg("createRoom ✓", { roomId: newRoom.id, code: newRoom.code });
  };

  /* ── JOIN ROOM ── */
  const joinRoom = async () => {
    const name = effectivePlayerName.trim();
const code = joinCode.trim().toUpperCase();

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

    // Resume akışı: aynı odada kayıtlı session varsa direkt restore et,
    // RPC çağırma (server zaten o player'ı tanıyor).
    const saved = loadRoomSession();
    const isResume = !!(saved?.roomCode === code && saved?.playerId && saved?.claimToken);

    if (isResume) {
      const joinId = saved!.playerId;
      const joinToken = saved!.claimToken;
      myIdRef.current       = joinId;
      claimTokenRef.current = joinToken;

      const { data: r } = await supabase
        .from("duel_group_rooms").select("*").eq("code", code).single();
      if (!r?.id) {
        setErrorMsg("Oda bulunamadı. Kodu kontrol et."); setStatusMsg(null); return;
      }
      if (r.status === "finished") {
        setErrorMsg("Bu oyun zaten bitti."); setStatusMsg(null); return;
      }
      const targetRoom = r as GroupRoom;
      const { data: ps } = await supabase
        .from("duel_group_players").select("*").eq("room_id", targetRoom.id);
      const myRow = (ps ?? []).find((p: GroupPlayer) => p.id === joinId);
      if (!myRow) {
        // Session geçersiz: oda mevcut ama satırımız silinmiş → fresh path'e düş
        clearGroupSession();
      } else {
        setRoom(targetRoom);
        setPlayers((ps as GroupPlayer[]) ?? []);
        setClaims([]);
        setIsHost(!!myRow.is_host);
        saveRoomSession(targetRoom.id, targetRoom.code, joinId, joinToken);
        setTimeLeft(targetRoom.duration_seconds);
        setStatusMsg(null); setPhase("waiting");
        dbg("joinRoom resume ✓", { roomId: targetRoom.id });
        return;
      }
    }

    // Fresh join: yeni player_id + claim_token; duel_group_join_room RPC
    // server-side kapasite + isim çakışması + room status guard yapar.
    const joinId    = freshPlayerId();
    const joinToken = freshClaimToken();
    myIdRef.current       = joinId;
    claimTokenRef.current = joinToken;

    const { profileId, guestId } = getIdentityArgs();
    const { data: roomData, error: joinErr } = await supabase.rpc("duel_group_join_room", {
      p_code:        code,
      p_player_id:   joinId,
      p_profile_id:  profileId,
      p_guest_id:    guestId,
      p_name:        name,
      p_claim_token: joinToken,
    });

    if (joinErr || !roomData) {
      dbgErr("duel_group_join_room failed", joinErr);
      setErrorMsg(describeDuelGroupRpcError(joinErr));
      setStatusMsg(null); return;
    }

    const targetRoom = roomData as GroupRoom;

    const { data: ps } = await supabase
      .from("duel_group_players").select("*").eq("room_id", targetRoom.id);

    setRoom(targetRoom);
    setPlayers((ps as GroupPlayer[]) ?? []);
    setClaims([]);
    setIsHost(false);
    saveRoomSession(targetRoom.id, targetRoom.code, joinId, joinToken);
    setTimeLeft(targetRoom.duration_seconds);
    setStatusMsg(null); setPhase("waiting");
    dbg("joinRoom ✓", { roomId: targetRoom.id });
  };


  const updateRoomSettings = useCallback(
  async (patch: Partial<Pick<GroupRoom, "duration_seconds" | "region" | "max_players">>) => {
    if (!room || !isHostRef.current || phase !== "waiting") return;

    const nextMaxPlayers = patch.max_players ?? room.max_players;

    if (nextMaxPlayers < waitingPlayers.length) {
      setErrorMsg(`Maksimum oyuncu sayısı şu an odada olan kişi sayısından düşük olamaz. Şu an ${waitingPlayers.length} kişi var.`);
      return;
    }

    // duel_group_update_settings RPC: host-only, status='waiting' guard,
    // server-side max_players_too_low kontrolü.
    const { error } = await supabase.rpc("duel_group_update_settings", {
      p_room_id:        room.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    claimTokenRef.current,
      p_duration:       patch.duration_seconds ?? null,
      p_region:         patch.region           ?? null,
      p_max_players:    patch.max_players      ?? null,
    });

    if (error) {
      dbgErr("duel_group_update_settings failed", error);
      setErrorMsg(describeDuelGroupRpcError(error));
      return;
    }

    setErrorMsg(null);
  },
  [room, phase, waitingPlayers.length]
);
  /* ── SET PLAYER COLOR (her oyuncu kendi rengini değiştirebilir) ── */
  const setPlayerColor = useCallback(
    async (color: DuelGroupColor) => {
      if (!room || phase !== "waiting") return;
      if (!myIdRef.current || !claimTokenRef.current) return;

      // Optimistic update — realtime echo kalıcılaştıracak
      const prevColor = (players.find(p => p.id === myIdRef.current)?.color_key ?? null);
      setPlayers(prev => prev.map(p =>
        p.id === myIdRef.current ? { ...p, color_key: color } : p,
      ));

      const { error } = await supabase.rpc("duel_group_set_player_color", {
        p_player_id:   myIdRef.current,
        p_claim_token: claimTokenRef.current,
        p_color:       color,
      });

      if (error) {
        dbgErr("duel_group_set_player_color failed", error);
        // Rollback optimistic update
        setPlayers(prev => prev.map(p =>
          p.id === myIdRef.current ? { ...p, color_key: prevColor } : p,
        ));
        setErrorMsg(describeDuelGroupRpcError(error));
        setTimeout(() => setErrorMsg(null), 2400);
      }
    },
    [room, phase, players],
  );

  /* ── START GAME (sadece host) ── */
  const startGame = async () => {
    if (!room || !isHost) return;
    if (players.length < MIN_PLAYERS) {
      setErrorMsg(`En az ${MIN_PLAYERS} oyuncu gerekli.`); return;
    }

    // duel_group_start_game RPC: claims DELETE + players UPDATE + room UPDATE
    // tek transaction. Server-side host + status='waiting' + count>=3 guard'ı.
    const { data: startedRoom, error } = await supabase.rpc("duel_group_start_game", {
      p_room_id:        room.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    claimTokenRef.current,
    });
    if (error) {
      dbgErr("duel_group_start_game failed", error);
      setErrorMsg(describeDuelGroupRpcError(error));
      return;
    }

    setClaims([]);
    // Realtime ile zaten gelecek; ama yine de hızlı geçiş için yerel set.
    // started_at fallback'i synced clock ile yazılır → host local clock'u
    // drift olsa bile timer ilk frame'de yanlış başlamaz.
    const r = startedRoom as GroupRoom | null;
    setRoom(prev => prev ? { ...prev, ...(r ?? { status: "playing" as const, started_at: new Date(getSyncedNowMs()).toISOString() }) } : prev);
    setPhase("playing");
  };

  /* ── GUESS ── */
  const handleGuess = async () => {
    if (phaseRef.current !== "playing") return;
    if (gameEndedRef.current) return;
    if (timeLeftRef.current <= 0) return;
    if (!room || room.status !== "playing") return;

    touchHeartbeat();

    const norm = normalizeInput(input);
    if (!norm) return;
    const topoId = NAME_TO_TOPOID[norm];
    if (!topoId) { showFeedback("err"); setInput(""); return; }
    if (allowedIds && !allowedIds.has(topoId)) { showFeedback("region"); setInput(""); return; }
    if (claims.some(c => c.country_code === topoId)) { showFeedback("dup"); setInput(""); return; }

    if (timeLeftRef.current <= 0 || gameEndedRef.current) return;

    setInput("");

    // duel_group_submit_claim RPC: server-side player_room_mismatch +
    // status='playing' + atomic insert + stale-claim retry (önceki maçtan
    // kalmış satır varsa sil + retry). Frontend client-side retry mantığı
    // artık gereksiz; server tek shot'ta çözüyor.
    const { data: claimRes, error } = await supabase.rpc("duel_group_submit_claim", {
      p_room_id:      room.id,
      p_player_id:    myIdRef.current,
      p_claim_token:  claimTokenRef.current,
      p_country_code: topoId,
    });

    if (error) {
      dbgErr("duel_group_submit_claim failed", error);
      showFeedback("err");
      return;
    }

    const res = claimRes as { claimed: boolean; reason?: string } | null;
    if (res?.claimed) { showFeedback("ok"); return; }
    if (res?.reason === "dup") { showFeedback("dup"); return; }
    showFeedback("err");
  };

  /* ── COPY INVITE ── */
  const inviteMessage = room
    ? `🏆 Çok Oyunculu – Ülke Yaz

Oda Kodu: ${room.code}
Bölge: ${regionLabel}
Süre: ${durationLabel}

Arkadaşlarınla aynı odada yarış:
Süre bitmeden en çok ülkeyi yazan kazanır.

Oyuna katıl:
${shareLink}`
    : "";
  const copyInvite = () => {
    const text = inviteMessage || shareLink;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {
      window.prompt("Linki kopyala:", shareLink);
    });
  };

  /* ── NOT: reconcileRoomAfterLeave helper'ı RPC switch'ten önce host transfer
   *  ve boş-oda cleanup'ını client-side yapıyordu. Bu mantık artık
   *  duel_group_leave_room RPC içinde server-side (FOR UPDATE lock'lu, atomik).
   *  kickPlayer için ek reconcile gerekmiyor — caller zaten host kalır.
   */

  /* — KICK PLAYER (sadece host, sadece bekleme odası) — */
const kickPlayer = useCallback(
  async (playerId: string) => {
    if (!room || !isHostRef.current) return;
    if (phaseRef.current !== "waiting") return;
    if (playerId === myIdRef.current) return;

    // duel_group_kick_player RPC: host-only + self-kick blocked + lobby-only
    // + target player delete (cascade ile target'ın claim_token'ı temizlenir).
    const { error } = await supabase.rpc("duel_group_kick_player", {
      p_room_id:          room.id,
      p_host_player_id:   myIdRef.current,
      p_host_claim_token: claimTokenRef.current,
      p_target_player_id: playerId,
    });

    if (error) {
      dbgErr("duel_group_kick_player failed", error);
      setErrorMsg(describeDuelGroupRpcError(error));
      return;
    }

    setPlayers((prev) => prev.filter((p) => p.id !== playerId));
    setKickTarget(null);
  },
  [room]
);

  /* ── BACK TO LOBBY ── */
  const backToLobby = useCallback(async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    try {
      // Odadaki player satırını her durumda sil. Eskiden burada
      // `phaseRef.current === "waiting"` guard'ı vardı; oyun bittikten sonra
      // "Yeni Oyun" akışı (phase==='finished') leave_room'u atlıyordu,
      // ayrılan oyuncu diğerlerinin listesinde "hayalet" olarak kalıyordu.
      // RPC faz-bağımsız: host transfer / boş oda silme / non-host self-delete
      // mantığını kendi içinde atomik handle eder.
      if (room && claimTokenRef.current) {
        try {
          const { error: leaveErr } = await supabase.rpc("duel_group_leave_room", {
            p_room_id:     room.id,
            p_player_id:   myIdRef.current,
            p_claim_token: claimTokenRef.current,
          });
          if (leaveErr) dbgErr("duel_group_leave_room failed", leaveErr);
        } catch (e) { dbgErr("backToLobby cleanup failed", e); }
      }
      clearGroupSession();
      claimTokenRef.current = "";
      setRoom(null);
      setPlayers([]);
      setClaims([]);
      setIsHost(false);
      setFinalLeaderboard(null);
      setErrorMsg(null);
      setStatusMsg(null);
      setQuitModal(false);
      setNewHostNoticeOpen(false);
      gameEndedRef.current = false;
      lastSeenIsHostRef.current = null;
      setPhase("lobby");
    } finally {
      leavingRef.current = false;
    }
  }, [room]);

/* — RETURN TO SAME ROOM (oyun sonu -> aynı odaya dön) —
 *  duel_group_return_to_lobby RPC: HOST-ONLY. Server tarafında hem rooms.status
 *  'waiting'e çekilir hem host'un kendi player satırı 'waiting'e çekilir
 *  (atomik). Non-host caller'lar RPC'yi çağırmaz; realtime room UPDATE'i
 *  ile waiting phase'e geçerler.
 */
const returnToRoom = useCallback(async () => {
  if (!room) return;

  if (isHostRef.current && claimTokenRef.current) {
    try {
      const { error } = await supabase.rpc("duel_group_return_to_lobby", {
        p_room_id:        room.id,
        p_host_player_id: myIdRef.current,
        p_claim_token:    claimTokenRef.current,
      });
      if (error) dbgErr("duel_group_return_to_lobby failed", error);
    } catch (e) {
      dbgErr("returnToRoom failed", e);
    }
  }

  // Oyunun geçici state'lerini temizle ama ODAYI ve OYUNCULARI KORU
  setClaims([]);
  setFinalLeaderboard(null);
  setErrorMsg(null);
  setStatusMsg(null);
  setQuitModal(false);
  gameEndedRef.current = false;

  // Aynı odanın bekleme ekranına dön
  setPhase("waiting");
}, [room]);

  /* — GO HOME (oyun sonu ekranından "Ana Menü") —
   *  Eskiden buton doğrudan onHome() çağırıyordu; player satırı odada
   *  kalıyor, diğer oyuncuların listesinde hayalet olarak görünüyordu.
   *  leave_room RPC önce çağrılır (host transfer / oda silme / non-host
   *  self-delete semantiği server tarafında atomik), sonra navigate.
   */
  const leaveAndGoHome = useCallback(async () => {
    if (room && claimTokenRef.current) {
      try {
        const { error } = await supabase.rpc("duel_group_leave_room", {
          p_room_id:     room.id,
          p_player_id:   myIdRef.current,
          p_claim_token: claimTokenRef.current,
        });
        if (error) dbgErr("leaveAndGoHome leave_room failed", error);
      } catch (e) { dbgErr("leaveAndGoHome cleanup failed", e); }
    }
    clearGroupSession();
    claimTokenRef.current = "";
    onHome();
  }, [room, onHome]);

  /* ── FORFEIT (oyun sırasında çık) ── */
  const forfeit = useCallback(async (target: "lobby" | "home") => {
    // Skor zaten claim sayısına göre olduğu için "kaybetmek" davranışı:
    // sadece odadan ayrıl. Geri kalanlar kendi aralarında yarışmaya devam eder.
    if (room && claimTokenRef.current) {
      try {
        const { error } = await supabase.rpc("duel_group_leave_room", {
          p_room_id:     room.id,
          p_player_id:   myIdRef.current,
          p_claim_token: claimTokenRef.current,
        });
        if (error) dbgErr("forfeit leave_room failed", error);
      } catch (e) { dbgErr("forfeit cleanup failed", e); }
    }
    clearGroupSession();
    claimTokenRef.current = "";
    setQuitModal(false);
    if (target === "home") onHome();
    else backToLobby();
  }, [room, backToLobby, onHome]);

  /* ─────────── RENDER ─────────── */

  const homeTheme = readStoredHomeTheme();
  const isPreGamePhase = phase !== "playing" && phase !== "finished";
  const themeBgStyle = isPreGamePhase ? getThemeBackgroundStyle(homeTheme) : undefined;
  const themeDataAttr = isPreGamePhase ? getThemeDataAttr(homeTheme) : undefined;

  return (
    <div className="duel-app" style={themeBgStyle} data-theme={themeDataAttr}>
      {/* ════════ LOBBY ════════ */}
      {phase === "lobby" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <button
  className="btn btn-ghost btn-sm"
  onClick={() => {
    playSound("click");
    onHome();
  }}
  style={{ alignSelf: "flex-start" }}
>
              ← Ana Menü
            </button>

            <h2 className="duel-lobby-title">🏆 Çok Oyunculu</h2>
            <p className="duel-lobby-desc">3–10 kişilik arkadaş grubunla oyna • En çok ülke yazan kazanır.</p>

            <input
  className="duel-name-input"
  type="text"
  placeholder="İsmin"
  value={isLoggedInPlayer ? loggedInUsername : playerName}
  onChange={(e) => {
    if (isLoggedInPlayer) return;
    setPlayerName(e.target.value.slice(0, 20));
  }}
  disabled={isLoggedInPlayer}
  maxLength={20}
  autoComplete="off"
/>

            {/* CREATE block */}
<div className="duel-create-block duel-create-polished">
  <div className="duel-create-fields">
    <div className="duel-host-settings">
      <div className="duel-select-wrap">
        <label className="duel-select-label">Süre</label>
        <div className="duel-select-box">
          <select
            className="duel-select"
            value={hostDuration}
            onChange={(e) => setHostDuration(Number(e.target.value))}
          >
            {DURATION_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="duel-select-caret">⌄</span>
        </div>
      </div>

      <div className="duel-select-wrap">
        <label className="duel-select-label">Bölge</label>
        <div className="duel-select-box">
          <select
            className="duel-select"
            value={hostRegion}
            onChange={(e) => setHostRegion(e.target.value)}
          >
            {REGION_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="duel-select-caret">⌄</span>
        </div>
      </div>

      <div className="duel-select-wrap">
        <label className="duel-select-label">Maks Oyuncu</label>
        <div className="duel-select-box">
          <select
            className="duel-select"
            value={hostMaxPlayers}
            onChange={(e) => setHostMaxPlayers(Number(e.target.value))}
          >
            {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>
                {n} kişi
              </option>
            ))}
          </select>
          <span className="duel-select-caret">⌄</span>
        </div>
      </div>
    </div>

    <button
      className="btn btn-accent duel-create-btn"
      onClick={createRoom}
      disabled={phase !== "lobby"}
    >
      {(phase as Phase) === "creating" ? "Kuruluyor..." : "🏠 Grup Odası Kur"}
    </button>
  </div>

  <div className="dgg-join-divider">
  <span>veya mevcut bir odaya katıl</span>
</div>

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
      <button className="btn btn-danger duel-join-btn" onClick={joinRoom}>
        Katıl
      </button>
    </div>
  </div>

    {errorMsg && <p className="duel-error">{errorMsg}</p>}
  {statusMsg && <p className="duel-status">{statusMsg}</p>}
</div>
</div>
</div>
)}

      {/* ════════ WAITING — 3-card grid (Çark lobby ile aynı yapı) ════════ */}
      {phase === "waiting" && room && (() => {
        const canStart = waitingPlayers.length >= MIN_PLAYERS;
        const totalSlots = Math.max(MAX_PLAYERS, waitingPlayers.length);
        const colorsTakenByOthers = new Set<string>(
          players
            .filter(p => p.id !== myId && p.color_key)
            .map(p => p.color_key as string),
        );
        const renderPlayerRow = (p: GroupPlayer) => {
          const isMe = p.id === myId;
          const pColorKey = colorByPlayerId[p.id];
          const pColorHex = hexForDuelGroupColor(pColorKey);
          return (
            <div
              key={p.id}
              className={"duel-player-chip" + (isMe ? " mine" : "")}
              style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 5, paddingBottom: 5, minWidth: 0, position: "relative" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
                <span
                  className="duel-player-dot"
                  style={{
                    flexShrink: 0,
                    background: pColorHex,
                    boxShadow: `0 0 0 2px ${pColorHex}33`,
                  }}
                />
                <span style={{
                  fontSize: 13, fontWeight: 600, minWidth: 0,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {p.name}
                </span>
                {isMe     && <span className="duel-tag"      style={{ flexShrink: 0, marginLeft: 2 }}>Sen</span>}
                {p.is_host && <span className="duel-tag host" style={{ flexShrink: 0, marginLeft: 2 }}>👑</span>}
              </div>
              {isMe && (
                <div data-dgg-color-picker style={{ position: "relative", flexShrink: 0 }}>
                  <button
                    type="button"
                    aria-label="Rengini seç"
                    title={pColorKey ? `Rengin: ${DUEL_GROUP_COLOR_LABEL[pColorKey]}` : "Rengini seç"}
                    onClick={(e) => {
                      e.stopPropagation();
                      playSound("click");
                      setColorPickerOpen(v => !v);
                    }}
                    style={{
                      width: 22, height: 22, borderRadius: "50%",
                      background: pColorHex,
                      border: "2px solid rgba(255,255,255,0.85)",
                      boxShadow: "0 0 0 1px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.35)",
                      cursor: "pointer", padding: 0,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      transition: "transform 120ms ease",
                    }}
                  />
                  {colorPickerOpen && (
                    <div
                      role="dialog"
                      aria-label="Renk paleti"
                      style={{
                        position: "absolute", top: "calc(100% + 6px)", right: 0,
                        zIndex: 30, padding: 10, borderRadius: 12,
                        background: "rgba(15,18,28,0.96)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        boxShadow: "0 12px 30px rgba(0,0,0,0.55)",
                        backdropFilter: "blur(10px)",
                        WebkitBackdropFilter: "blur(10px)",
                        display: "grid",
                        gridTemplateColumns: "repeat(5, 22px)",
                        gap: 8,
                        minWidth: 158,
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {DUEL_GROUP_COLORS.map(c => {
                        const hex = DUEL_GROUP_COLOR_HEX[c];
                        const taken = c !== pColorKey && colorsTakenByOthers.has(c);
                        const selected = c === pColorKey;
                        return (
                          <button
                            key={c}
                            type="button"
                            disabled={taken}
                            aria-label={DUEL_GROUP_COLOR_LABEL[c]}
                            title={taken
                              ? `${DUEL_GROUP_COLOR_LABEL[c]} (alındı)`
                              : DUEL_GROUP_COLOR_LABEL[c]}
                            onClick={() => {
                              if (taken || selected) {
                                if (selected) setColorPickerOpen(false);
                                return;
                              }
                              setPlayerColor(c);
                              setColorPickerOpen(false);
                            }}
                            style={{
                              width: 22, height: 22, borderRadius: "50%",
                              background: hex,
                              border: selected
                                ? "2px solid #fff"
                                : "2px solid rgba(255,255,255,0.25)",
                              boxShadow: selected
                                ? `0 0 0 2px ${hex}, 0 0 0 3px rgba(255,255,255,0.6)`
                                : "0 1px 2px rgba(0,0,0,0.4)",
                              cursor: taken ? "not-allowed" : "pointer",
                              opacity: taken ? 0.28 : 1,
                              padding: 0,
                              position: "relative",
                              transition: "transform 120ms ease",
                            }}
                          >
                            {selected && (
                              <span style={{
                                position: "absolute", inset: 0,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                color: "#fff", fontSize: 11, fontWeight: 900,
                                textShadow: "0 1px 2px rgba(0,0,0,0.7)",
                              }}>✓</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {isHost && !p.is_host && p.id !== myId && (
                <button
                  type="button"
                  className="dgg-kick-btn"
                  style={{ flexShrink: 0 }}
                  onClick={() => { setKickTarget(p); setDggPlayersOpen(false); }}
                >
                  At
                </button>
              )}
            </div>
          );
        };

        return (
          <>
            <div className="dgg-lobby-shell">
              <div className="duel-lobby">
                <div className="wgg-grid">

                {/* ══ SOL KART: Oyuncular ══ */}
                <div className="duel-lobby-card wgg-players-card">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexShrink: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.02em" }}>👥 Oyuncular</span>
                    <span className="wgg-max-badge" aria-label="Oyuncu sayısı">
                      {waitingPlayers.length}/{room.max_players}
                    </span>
                  </div>

                  <div className="wgg-player-list">
                    {Array.from({ length: totalSlots }, (_, i) => {
                      const p = waitingPlayers[i] ?? null;
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
                      return renderPlayerRow(p);
                    })}
                  </div>

                  {waitingPlayers.length < MIN_PLAYERS && (
                    <div style={{ marginTop: 10, flexShrink: 0 }}>
                      <span style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        fontSize: 12, fontWeight: 700, padding: "4px 12px", borderRadius: 999,
                        background: "rgba(212,160,44,0.16)", border: "1px solid rgba(212,160,44,0.45)",
                        color: "var(--amber, #d4a02c)", letterSpacing: "0.02em",
                      }}>
                        En az {MIN_PLAYERS} oyuncu gerekli — {MIN_PLAYERS - waitingPlayers.length} bekleniyor
                      </span>
                    </div>
                  )}
                </div>

                {/* ══ ORTA KART: Oda kodu + davet + ayarlar + aksiyon ══ */}
                <div className="duel-lobby-card wgg-middle-card">
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

                  <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                    <button
                      className={"btn duel-invite-btn" + (copied ? " invited" : "")}
                      onClick={copyInvite}
                      style={{ width: "100%" }}
                    >
                      {copied ? "✓ Davet mesajı kopyalandı!" : "📋 Davet Mesajını Kopyala"}
                    </button>
                    <div onClick={(e) => {
                      const el = (e.currentTarget as HTMLElement).querySelector("input") as HTMLInputElement | null;
                      el?.select();
                    }}>
                      <input
                        className="duel-link-input"
                        readOnly
                        value={shareLink}
                        onFocus={(e) => e.target.select()}
                        style={{ width: "100%", boxSizing: "border-box" }}
                      />
                    </div>
                  </div>

                  <section aria-label="Oda Ayarları" style={{
                    display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 8, padding: "10px 12px",
                    background: "rgba(10,18,32,0.55)", border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 12, boxSizing: "border-box", flexShrink: 0,
                  }}>
                    <div className="duel-select-wrap" style={{ minWidth: 0, gap: 3 }}>
                      <label className="duel-select-label" style={{ fontSize: "0.62rem" }}>⏱ Süre</label>
                      <div className="duel-select-box">
                        <select className="duel-select" value={room.duration_seconds} disabled={!isHost}
                          onChange={(e) => updateRoomSettings({ duration_seconds: Number(e.target.value) })}
                          style={{ height: 34, fontSize: 12.5, padding: "0 26px 0 10px", opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                        >
                          {DURATION_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        <span className="duel-select-caret">▾</span>
                      </div>
                    </div>
                    <div className="duel-select-wrap" style={{ minWidth: 0, gap: 3 }}>
                      <label className="duel-select-label" style={{ fontSize: "0.62rem" }}>🌍 Bölge</label>
                      <div className="duel-select-box">
                        <select className="duel-select" value={denormalizeRegion(room.region)} disabled={!isHost}
                          onChange={(e) => updateRoomSettings({ region: normalizeRegion(e.target.value) })}
                          style={{ height: 34, fontSize: 12.5, padding: "0 26px 0 10px", opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                        >
                          {REGION_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        <span className="duel-select-caret">▾</span>
                      </div>
                    </div>
                    <div className="duel-select-wrap" style={{ minWidth: 0, gap: 3 }}>
                      <label className="duel-select-label" style={{ fontSize: "0.62rem" }}>👥 Maks</label>
                      <div className="duel-select-box">
                        <select className="duel-select" value={room.max_players} disabled={!isHost}
                          onChange={(e) => updateRoomSettings({ max_players: Number(e.target.value) })}
                          style={{ height: 34, fontSize: 12.5, padding: "0 26px 0 10px", opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                        >
                          {[3, 4, 5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>{n} kişi</option>)}
                        </select>
                        <span className="duel-select-caret">▾</span>
                      </div>
                    </div>
                  </section>

                  <div style={{ flex: 1 }} />

                  <div style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
                    {isHost && (
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
                        🚀 Oyunu Başlat ({waitingPlayers.length} kişi)
                      </button>
                    )}
                    {!isHost && (
                      <p className="duel-waiting-msg" style={{ margin: 0, textAlign: "center" }}>
                        Ev sahibi oyunu başlatacak...
                      </p>
                    )}
                    <button
                      className="btn btn-ghost"
                      onClick={backToLobby}
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
                    playerName={effectivePlayerName}
                    mobileSheetOpen={dggChatOpen}
                    onMobileSheetOpenChange={(v) => { setDggChatOpen(v); if (v) setDggPlayersOpen(false); }}
                    hideMobileFab={dggChatOpen || dggPlayersOpen}
                    sendMode="duel_group"
                    playerId={myIdRef.current}
                    claimToken={claimTokenRef.current}
                  />
                </div>
                </div>
              </div>
            </div>

            {/* ════ MOBİL: Oyuncular FAB ════ */}
            {!dggChatOpen && !dggPlayersOpen && (
              <button
                type="button"
                className="wgg-players-fab"
                aria-label="Oyuncuları aç"
                onClick={() => { setDggPlayersOpen(true); setDggChatOpen(false); }}
              >
                <span>👥</span>
                <span>Oyuncular</span>
                <span className="wgg-players-fab-badge">{waitingPlayers.length}/{room.max_players}</span>
              </button>
            )}

            {/* ════ MOBİL: Oyuncular bottom-sheet ════ */}
            {dggPlayersOpen && (
              <div className="wgg-ps-backdrop" onClick={() => setDggPlayersOpen(false)}>
                <div className="wgg-ps-sheet" onClick={(e) => e.stopPropagation()}>
                  <div className="wgg-ps-handle" />
                  <header className="wgg-ps-header">
                    <span className="wgg-ps-title">
                      <span>👥</span>
                      <span>Oyuncular</span>
                    </span>
                    <span className="wgg-max-badge wgg-max-badge--sheet" aria-label="Oyuncu sayısı">
                      {waitingPlayers.length}/{room.max_players}
                    </span>
                    <button
                      type="button"
                      className="wgg-ps-close"
                      onClick={() => setDggPlayersOpen(false)}
                      aria-label="Kapat"
                    >
                      ✕
                    </button>
                  </header>
                  <div className="wgg-ps-list">
                    {Array.from({ length: totalSlots }, (_, i) => {
                      const p = waitingPlayers[i] ?? null;
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
                      return renderPlayerRow(p);
                    })}
                  </div>
                  {waitingPlayers.length < MIN_PLAYERS && (
                    <div className="wgg-ps-warning">
                      En az {MIN_PLAYERS} oyuncu gerekli — {MIN_PLAYERS - waitingPlayers.length} bekleniyor
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* ════════ PLAYING (finished'da da arka plan render kalsın) ════════ */}
      {(phase === "playing" || phase === "finished") && room && (
  <div className="dgg-game">
        <>
          {/* Üst bar: skor + timer + leaderboard pill */}
          <div className="duel-score-bar">
            <div className="duel-score-mine">
              <span className="duel-score-label">Senin Skorun</span>
              <span className="duel-score-value">{myScore}</span>
            </div>

            <div className="dgg-timer-wrap">
              <div className="dgg-timer-bar">
                <div className="dgg-timer-fill" style={{
                  width: `${timerPct}%`,
                  background: timerColor,
                }}/>
              </div>
              <span className="dgg-timer-text" style={{ color: timerColor }}>
                {Math.floor(timeLeft / 60)}:{String(timeLeft % 60).padStart(2, "0")}
              </span>
            </div>

            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setQuitModal(true)}
              aria-label="Çıkış"
            >
              ✕ Çık
            </button>
          </div>

          {/* Live leaderboard */}
          <div className="dgg-leaderboard">
            {leaderboard.map((entry, idx) => {
              const colorHex = hexForDuelGroupColor(colorByPlayerId[entry.playerId]);
              return (
                <div
                  key={entry.playerId}
                  className={"dgg-lb-row" + (entry.isMe ? " mine" : "")}
                >
                  <span className="dgg-lb-rank">#{idx + 1}</span>
                  <span style={{
                    width: 8, height: 8, borderRadius: "50%", background: colorHex,
                    flexShrink: 0, boxShadow: `0 0 0 1px ${colorHex}55`,
                  }} />
                  <span className="dgg-lb-name">
                    {entry.name}
                    {entry.isHost && <span className="dgg-lb-host"> 👑</span>}
                    {entry.isMe   && <span className="dgg-lb-you"> (Sen)</span>}
                  </span>
                  <span className="dgg-lb-score">{entry.score}</span>
                </div>
              );
            })}
          </div>

          {/* Map */}
          <div className="dgg-map-wrap map-area">
            <DuelMapView
              myTopoIds={myTopoIds}
              oppTopoIds={otherTopoIds}
              showLabels={showLabels}
              region={denormalizeRegion(gameRegion)}
              activeIds={allowedIds ?? undefined}
              claimColors={claimColorMap}
            />
          </div>

          {/* Input */}
          <div className="duel-input-bar">
            <input
              ref={inputRef}
              type="text"
              className={inputCls}
              disabled={gameOver}
              placeholder={gameOver
                ? "Süre bitti"
                : allowedIds
                  ? `${regionLabel} ülkesi yaz… (Enter)`
                  : "Ülke adı yaz… (Enter)"}
              value={gameOver ? "" : input}
              onChange={e => { if (!gameOver) setInput(e.target.value); }}
              onKeyDown={e => { if (e.key === "Enter" && !gameOver) handleGuess(); }}
              autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
            />
            <button className="btn btn-accent" onClick={handleGuess} disabled={gameOver}>Gir</button>
            <div className="duel-fb-slot">
              {feedback === "ok"     && <span className="fb fb-ok">✓ +1!</span>}
              {feedback === "err"    && <span className="fb fb-no">✗ Bulunamadı</span>}
              {feedback === "dup"    && <span className="fb fb-dup">Zaten alındı</span>}
              {feedback === "region" && <span className="fb fb-no">⚠ Bölge dışı</span>}
            </div>
          </div>

          {/* Quit modal */}
          {quitModal && (
            <div className="duel-quit-backdrop" onClick={() => setQuitModal(false)}>
              <div className="duel-quit-modal" onClick={e => e.stopPropagation()}>
                <h3 className="duel-quit-title">Oyundan çıkmak istiyor musun?</h3>
                <p className="duel-quit-sub">Çıkarsan diğerleri yarışmaya devam eder; senin skorun donar.</p>
                <div className="duel-quit-actions">
                  <button className="btn duel-quit-action forfeit" onClick={() => forfeit("lobby")}>
                    🚪 Lobiye Dön
                  </button>
                  <button className="btn duel-quit-action menu" onClick={() => forfeit("home")}>
                    🏠 Ana Menü
                  </button>
                  <button className="btn duel-quit-action cancel" onClick={() => setQuitModal(false)}>
                    ↩ Vazgeç
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
        </div>
)}

      {/* ════════ FINISHED — overlay (Çark Grup ile aynı görsel düzen) ════════ */}
      {phase === "finished" && room && (() => {
        const board = finalLeaderboard ?? leaderboard.map(b => ({
          playerId: b.playerId, name: b.name, score: b.score,
        }));
        const myRank = board.findIndex(b => b.playerId === myIdRef.current) + 1;
        const me = board.find(b => b.playerId === myIdRef.current);
        const myFinalScore = me?.score ?? 0;
        const top = board[0]?.score ?? 0;
        const iWon = myFinalScore > 0 && myFinalScore === top;
        const titleText = iWon ? "KAZANDIN!" : "OYUN BİTTİ";
        const emoji = iWon ? "🏆" : "🏁";
        const reasonText = "Süre doldu.";
        const podium = board.slice(0, 3);
        const totalClaims = board.reduce((s, b) => s + b.score, 0);

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
              overflowY: "auto",
              padding: isWideViewport ? "24px" : "16px 12px",
              boxSizing: "border-box",
              alignItems: isWideViewport ? "center" : "flex-start",
            }}
          >
            <div
              className="dgg-result-layout"
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
                            fontWeight: 800,
                            fontVariantNumeric: "tabular-nums",
                            minWidth: 22,
                            textAlign: "right",
                          }}
                          title="Doğru sayısı"
                        >
                          {entry.score}
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
                  Toplam {totalClaims} doğru claim
                </div>
              </aside>

              {/* ─── Kart 2: Sonuç (orta/desktop · üst/mobil) ─── */}
              <div
                className="wheel-result-panel dgg-result-panel"
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
                    className="dgg-final-board"
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
                      const colorHex = hexForDuelGroupColor(colorByPlayerId[entry.playerId]);
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
                          <span style={{
                            width: 9, height: 9, borderRadius: "50%", background: colorHex,
                            flexShrink: 0, boxShadow: `0 0 0 1px ${colorHex}55`,
                            display: "inline-block",
                          }} />
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

                <div className="duel-result-meta" style={{ marginTop: 10 }}>
                  <span>⏱ {durationLabel}</span>
                  <span className="duel-sum-dot">·</span>
                  <span>{regionLabel}</span>
                  <span className="duel-sum-dot">·</span>
                  <span>Toplam {totalClaims} ülke</span>
                  <span className="duel-sum-dot">·</span>
                  <span>Sıra #{Math.max(1, myRank)}</span>
                </div>

                {errorMsg && <p className="duel-error" style={{ marginTop: 8 }}>{errorMsg}</p>}

                <div className="wheel-result-actions">
                  <button
                    type="button"
                    className="wheel-primary-btn"
                    onClick={returnToRoom}
                  >
                    ↩ Lobiye Dön
                  </button>
                  <button
                    type="button"
                    className="wheel-ghost-btn"
                    onClick={backToLobby}
                  >
                    ↻ Yeni Oyun
                  </button>
                  <button
                    type="button"
                    className="wheel-ghost-btn"
                    onClick={leaveAndGoHome}
                  >
                    ⌂ Ana Menü
                  </button>
                </div>
              </div>
              {/* /Kart 2 — sonuç */}
            </div>
          </div>
        );
      })()}

          {kickTarget && (
  <div className="dgg-confirm-backdrop" onClick={() => setKickTarget(null)}>
    <div className="dgg-confirm-modal" onClick={(e) => e.stopPropagation()}>
      <div className="dgg-confirm-icon">⚠️</div>

      <h3>Oyuncuyu odadan çıkar</h3>

      <p>
        <strong>{kickTarget.name}</strong> adlı oyuncuyu odadan çıkarmak
        istediğine emin misin?
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

{kickedNoticeOpen && (
  <div
    className="dgg-confirm-backdrop"
    onClick={() => setKickedNoticeOpen(false)}
  >
    <div
      className="dgg-confirm-modal"
      onClick={(e) => e.stopPropagation()}
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

{roomClosedNoticeOpen && (
  <div
    className="dgg-confirm-backdrop"
    onClick={() => setRoomClosedNoticeOpen(false)}
  >
    <div
      className="dgg-confirm-modal"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="dgg-confirm-icon">🚪</div>

      <h3>Oda Kapatıldı</h3>

      <p>Oda artık aktif değil. Yeni bir oda kurabilir veya başka bir odaya katılabilirsin.</p>

      <div className="dgg-confirm-actions single">
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => setRoomClosedNoticeOpen(false)}
        >
          Tamam
        </button>
      </div>
    </div>
  </div>
)}

{newHostNoticeOpen && (
  <div
    className="dgg-confirm-backdrop"
    onClick={() => setNewHostNoticeOpen(false)}
  >
    <div
      className="dgg-confirm-modal"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="dgg-confirm-icon">👑</div>

      <h3>YENİ ODA SAHİBİ SİZSİNİZ</h3>

      <p>Oda sahibi ayrıldı. Odayı artık siz yönetiyorsunuz.</p>

      <div className="dgg-confirm-actions single">
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => setNewHostNoticeOpen(false)}
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
