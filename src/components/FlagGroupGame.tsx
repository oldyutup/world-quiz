/**
 * FlagGroupGame.tsx — Bayrak Bilmece Çok Oyunculu (oda koduyla, 2–10 kişi)
 *
 * Mevcut Bayrak Bilmece 1v1 (FlagDuelGame.tsx) motoruna DOKUNULMAZ. Bu bileşen:
 *   • Oda yaşam döngüsü (create/join/kick/leave/return/kapasite) → duel_group_*
 *     pattern'inin flag_group_* karşılığı (DuelGroupGame.tsx shell'i model alındı).
 *   • Tur bazlı bayrak yarışı → FlagDuelGame ile AYNI cevap doğrulama
 *     (normalizeInput + NAME_TO_ENTRY), aynı flag SVG yolu, aynı per-flag timer.
 *   • İlk-doğru KAZANAN: server-otoriter (flag_group_submit_claim +
 *     UNIQUE(room_id, country_code)). İki oyuncu aynı anda doğru yazsa yalnız
 *     BİRİ puan alır; N oyuncuya ölçeklenir.
 *   • "Lobiye Dön": per-player (Kuşatma modeli). Dönmeyen oyuncu "Sonuç
 *     ekranında" olarak dimmed görünür; host herkes dönmeden başlatamaz.
 *
 * Bayrağı her client BAĞIMSIZ seçmez: host tek otoriter sıra sağlayıcıdır
 * (flag_group_advance_flag → room.current_flag). Tüm client'lar current_flag'i
 * global CODE_TO_ENTRY ile render eder (kendi rastgele havuzuna bağlı değil).
 *
 * PAS TUR TÜKETMEZ (1v1 paritesi): her gösterilen bayrak monoton `flag_seq`
 * kimliği taşır; atomik çözüm anahtarı (room, game_seq, flag_seq). Çoğunluk pas
 * derse mevcut bayrak `pass:<flag>` sentinel'iyle çözülür ama SERVER
 * (flag_group_advance_flag) current_round'u DEĞİŞTİRMEDEN yeni bir bayrak (yeni
 * flag_seq) getirir — final turda bile oyun bitmez. Round yalnız gerçek claim
 * veya timeout ile ilerler. Round vs finalize kararı client'a değil server'a
 * aittir (mevcut çözüm satırı kilit altında okunur).
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase } from "../lib/supabase";
import { LobbyInviteBar } from "./LobbyInviteBar";
import LobbyChat from "./LobbyChat";
import { PlayerAvatar } from "./PlayerAvatar";
import { playSound, stopSound, getCountdownSoundMode } from "../lib/sound";
import {
  NAME_TO_ENTRY,
  CODE_TO_ENTRY,
  normalizeInput,
  getFlagPool,
  buildProgressionQueue,
  type Continent,
  type CountryEntry,
} from "../data/countries";
import { validateUsername, type Profile } from "../lib/auth";
import { useInviteJoin } from "../lib/useInviteJoin";
import { readStoredHomeTheme, getThemeBackgroundStyle, getThemeDataAttr } from "../lib/themeBackgrounds";
import { getSyncedNowMs, initServerClockSync } from "../lib/serverClock";
import {
  buildLeaderboard,
  resolveWinners,
  allPlayersReady,
  pickNextFlagCode,
  isPassClaim,
  isScoringClaim,
  requiredPassVotes,
  shownFlagCodes,
  type LeaderRow,
} from "./flagGroupLogic";

/* ─── Local types (lib/supabase.ts kirletmemek için) ─── */
interface FGRoom {
  id:              string;
  code:            string;
  status:          "waiting" | "playing" | "finished";
  region:          string;
  total_rounds:    number;
  max_players:     number;
  current_round:   number;
  current_flag:    string | null;
  current_flag_at: string | null;
  game_seq:        number;   // oyun oturumu kimliği (pas oyu tur-anahtarı)
  flag_seq:        number;   // o oyunda gösterilen HER yeni bayrağın monoton kimliği (atomik çözüm anahtarı)
  started_at:      string | null;
  finished_at:     string | null;
  created_at:      string;
  updated_at:      string;
}
interface FGPlayer {
  id:           string;
  room_id:      string;
  name:         string;
  is_host:      boolean;
  status:       "waiting" | "playing" | "finished";
  joined_at:    string;
  last_seen_at: string;
}
interface FGClaim {
  id:           number;
  room_id:      string;
  player_id:    string;
  game_seq:     number;
  round:        number;
  flag_seq:     number;   // çözümün bağlandığı gösterilen-bayrak kimliği (atomik anahtar)
  country_code: string;
  created_at:   string;
}
/** Bir gösterilen bayrağın (game_seq, flag_seq) Pas Geç oyu — flag_group_pass_votes satırı. */
interface FGPassVote {
  id:        string;
  room_id:   string;
  game_seq:  number;
  round:     number;
  flag_seq:  number;   // oy bu gösterilen bayrağa bağlı → yeni bayrakta 0/N'den başlar
  player_id: string;
  created_at: string;
}

/* ─── Sabitler ─── */
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;
const FLAG_TIMEOUT_SEC = 10;   // her bayrak için süre (1v1 ile aynı)
const REVEAL_DELAY_MS  = 2000; // cevap/timeout sonrası cevap gösterim süresi
/* Geri sayım sesi: countdown20.mp3 ~19.5 sn; tur 10 sn olduğundan son 5 sn'lik
   bölümü sondan hizalayarak çalarız (bkz. sound.ts + Çizim Test paritesi). */
const COUNTDOWN_AUDIO_SECONDS = 19.5;
const COUNTDOWN_TAIL_SEC = 5;
const COUNTDOWN_SEEK_S = Math.max(0, COUNTDOWN_AUDIO_SECONDS - COUNTDOWN_TAIL_SEC);

const ROUND_OPTS = [
  { label: "5 Tur",  value: 5  },
  { label: "10 Tur", value: 10 },
  { label: "15 Tur", value: 15 },
  { label: "20 Tur", value: 20 },
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
const CONTINENT_LABEL: Record<string, string> = {
  "world": "🌍 Dünya", "europe": "🇪🇺 Avrupa", "asia": "🌏 Asya", "africa": "🌍 Afrika",
  "north-america": "🌎 K.Amerika", "south-america": "🌎 G.Amerika", "oceania": "🌊 Okyanusya",
};

/** DB region değeri (1v1 ile aynı normalize kuralı) */
const normalizeRegion = (r: string): string => ({
  "north-america": "north_america", "south-america": "south_america",
}[r] ?? r);
const denormalizeRegion = (r: string): string => ({
  "north_america": "north-america", "south_america": "south-america",
}[r] ?? r);

/* ─── Sohbet oda-anahtarı namespace'i ───
   Sohbet paylaşımlı `duel_messages` tablosunu kullanır (room_code ile ayrılır).
   ANCAK oda kodları modlar arası GLOBAL UNIQUE DEĞİL: her `<mode>_rooms.code`
   yalnız KENDİ tablosunda unique (flag_group / wheel_group / duel_group /
   conquest ayrı tablolar). Dolayısıyla iki farklı mod aynı 6 haneli kodu aynı
   anda üretebilir → yalnız plain `code` ile anahtarlanan mesaj sorgusu +
   `chat-<code>` kanalı modlar arası mesaj SIZINTISINA yol açabilir.
   Çözüm: Bayrak Grup mesajları "flag_group:<code>" mantıksal anahtarıyla izole
   edilir (LobbyChat geçmiş sorgusu + Realtime kanalı + send RPC hepsi bu
   anahtarı kullanır). Server (flag_group_send_message) anahtarı YENİDEN kurup
   doğrular; üyelik hâlâ GERÇEK oda kaydından (player→room) gelir. Hiçbir başka
   mod `:`-önekli anahtar yazmadığından çakışma yapısal olarak imkânsızdır. */
const CHAT_ROOM_NS = "flag_group";
const chatRoomKey = (code: string) => `${CHAT_ROOM_NS}:${code}`;

/* ─── localStorage (1v1 / duel-group'tan ayrı namespace) ─── */
const PLAYER_ID_KEY = "geoquiz_flaggroup_player_id";
const ROOM_KEY      = "geoquiz_flaggroup_room";
const GUEST_ID_KEY  = "geoquiz_flaggroup_guest_id";

function makeCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function dbgErr(label: string, err?: unknown) { console.error(`[FlagGroupGame] ❌ ${label}`, err ?? ""); }

interface RoomSession { roomId: string; roomCode: string; playerId: string; claimToken: string; }
function saveRoomSession(roomId: string, roomCode: string, playerId: string, claimToken: string) {
  localStorage.setItem(ROOM_KEY, JSON.stringify({ roomId, roomCode, playerId, claimToken }));
}
function loadRoomSession(): RoomSession | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.roomId || !p?.roomCode || !p?.playerId || !p?.claimToken) return null;
    return p as RoomSession;
  } catch { return null; }
}
function ensureGuestId(): string {
  let g = localStorage.getItem(GUEST_ID_KEY);
  if (!g) { g = crypto.randomUUID(); localStorage.setItem(GUEST_ID_KEY, g); }
  return g;
}
function clearFlagGroupSession() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("geoquiz_flaggroup") && k !== GUEST_ID_KEY) keys.push(k);
  }
  keys.forEach(k => localStorage.removeItem(k));
}

/* ─── RPC hata mapper (server raise → Türkçe) ─── */
interface FGRpcError { code?: string; message?: string; details?: string }
function describeFlagGroupRpcError(err: FGRpcError | null | undefined): string {
  if (!err) return "İşlem başarısız.";
  const m = (err.message ?? "") + " " + (err.details ?? "");
  if (m.includes("code_taken"))                return "Bu kod kullanımda. Tekrar dene.";
  if (m.includes("display_name_forbidden"))    return "Bu nick kullanılamaz. Lütfen farklı bir nick dene.";
  if (m.includes("registered_username_taken")) return "Bu nick zaten kayıtlı. Giriş yap ya da farklı bir nick dene.";
  if (m.includes("name_taken"))                return "Bu isim bu odada kullanılıyor. Farklı bir isim seç.";
  if (m.includes("room_full"))                 return "Oda dolu.";
  if (m.includes("room_not_found"))            return "Oda bulunamadı. Kodu kontrol et.";
  if (m.includes("room_finished"))             return "Bu oyun zaten bitti.";
  if (m.includes("room_in_progress"))          return "Oyun başladı, katılamazsın.";
  if (m.includes("room_not_waiting"))          return "Oda artık bekleme aşamasında değil.";
  if (m.includes("room_not_playing"))          return "Oda artık oyunda değil.";
  if (m.includes("players_not_ready"))         return "Tüm oyuncuların lobiye dönmesi bekleniyor.";
  if (m.includes("not_enough_players"))        return `En az ${MIN_PLAYERS} oyuncu gerekli.`;
  if (m.includes("max_players_too_low"))       return "Maksimum oyuncu sayısı şu an odada olan kişi sayısından düşük olamaz.";
  if (m.includes("max_players_invalid"))       return "Geçersiz oyuncu sayısı (2–10).";
  if (m.includes("total_rounds_invalid"))      return "Geçersiz tur sayısı.";
  if (m.includes("name_invalid"))              return "Oyuncu adı 2–16 karakter olmalı.";
  if (m.includes("profile_mismatch"))          return "Oturum doğrulaması başarısız.";
  if (m.includes("player_room_mismatch"))      return "Bu odada aktif oyuncun yok.";
  if (m.includes("cannot_kick_self"))          return "Kendini odadan çıkaramazsın.";
  if (m.includes("unauthorized"))              return "Bu işlem için yetkin yok.";
  if (m.includes("room_unavailable"))          return "Oda kullanılamıyor.";
  if (err.code === "42501")                    return "Veritabanı izin hatası.";
  return err.message || "İşlem başarısız.";
}

type Phase = "lobby" | "creating" | "waiting" | "playing" | "finished";

interface Props {
  onHome: () => void;
  profile?: Profile | null;
}

export default function FlagGroupGame({ onHome, profile }: Props) {
  /* identity */
  const myIdRef = useRef<string>("");
  const claimTokenRef = useRef<string>("");
  const getIdentityArgs = useCallback((): { profileId: string | null; guestId: string | null } => {
    if (profile?.id) return { profileId: profile.id, guestId: null };
    return { profileId: null, guestId: ensureGuestId() };
  }, [profile?.id]);

  /* lobby form */
  const loggedInUsername = profile?.username ?? "";
  const isLoggedInPlayer = !!loggedInUsername;
  const [playerName, setPlayerName] = useState("");
  const effectivePlayerName = loggedInUsername || playerName;
  const [joinCode, setJoinCode] = useState("");
  const inviteOverrideCodeRef = useRef<string | null>(null);
  const [hostRounds, setHostRounds] = useState(10);
  const [hostRegion, setHostRegion] = useState("world");
  const [hostMaxPlayers, setHostMaxPlayers] = useState(10);

  /* phase / messages */
  const [phase, setPhase] = useState<Phase>("lobby");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [kickedNoticeOpen, setKickedNoticeOpen] = useState(false);
  const [roomClosedNoticeOpen, setRoomClosedNoticeOpen] = useState(false);
  const [quitModal, setQuitModal] = useState(false);
  const [kickTarget, setKickTarget] = useState<FGPlayer | null>(null);
  /* Mobil lobi sheet'leri (Çark/Ülke Yaz grup lobisiyle aynı desen) */
  const [chatSheetOpen, setChatSheetOpen] = useState(false);
  const [playersSheetOpen, setPlayersSheetOpen] = useState(false);

  /* game state */
  const [room, setRoom] = useState<FGRoom | null>(null);
  const [players, setPlayers] = useState<FGPlayer[]>([]);
  const [claims, setClaims] = useState<FGClaim[]>([]);
  const [passVotes, setPassVotes] = useState<FGPassVote[]>([]);  // oda için tüm pas oyları (tur-filtreli türetilir)
  const [passPending, setPassPending] = useState(false);         // in-flight toggle → çift-tık guard
  const [isHost, setIsHost] = useState(false);
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<"correct" | "wrong" | "dup" | null>(null);
  const [timeLeft, setTimeLeft] = useState(FLAG_TIMEOUT_SEC);
  const [imgError, setImgError] = useState(false);
  const [finalLeaderboard, setFinalLeaderboard] = useState<LeaderRow[] | null>(null);
  const [returned, setReturned] = useState(false); // bu client "Lobiye Dön" dedi mi (finished→waiting geçişi)

  /* refs (stale closure guard) */
  const roomRef = useRef<FGRoom | null>(null);
  const phaseRef = useRef<Phase>("lobby");
  const isHostRef = useRef(false);
  const claimsRef = useRef<FGClaim[]>([]);
  const timeLeftRef = useRef(FLAG_TIMEOUT_SEC);
  const gameEndedRef = useRef(false);
  const leavingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  /* host bayrak-sırası + gösterilen bayraklar */
  const flagSeqCodesRef = useRef<string[]>([]);
  const usedFlagsRef = useRef<Set<string>>(new Set());
  const advanceHandledRef = useRef<string>("");   // roundKey (bir kez ilerlet)
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Geri sayım sesi guard'ı: gösterilen bayrak kimliği (game_seq+flag_seq).
  // "G:F" = silahlı (henüz çalmadı), "G:F:played" = bu bayrakta bir kez çalındı,
  // "" = ses durdurulmuş. Pas AYNI turda flag_seq'i artırdığı için bu anahtar
  // her yeni bayrakta değişir ve ses sıfırdan silahlanır.
  const countdownFlagRef = useRef<string>("");

  useEffect(() => { roomRef.current = room; }, [room]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { claimsRef.current = claims; }, [claims]);
  useEffect(() => { timeLeftRef.current = timeLeft; }, [timeLeft]);

  const myId = myIdRef.current;
  const myPlayer = players.find(p => p.id === myId) ?? null;

  /* ─── host sequence builder ─── */
  const buildHostSequence = useCallback((region: string, totalRounds: number, exclude: Set<string>) => {
    const cont = denormalizeRegion(region) as Continent | "world";
    const pool = getFlagPool(cont, "all");
    const curve = buildProgressionQueue(pool, totalRounds).map(e => e.code);
    // İlk `totalRounds` bayrak zorluk eğrisini takip eder; kuyruk (tüm havuz)
    // reconnect/timeout güvenlik ağıdır (asla tekrar göstermeyiz → used set).
    const seq = [...curve, ...pool.map(e => e.code)];
    flagSeqCodesRef.current = seq;
    usedFlagsRef.current = new Set(exclude);
  }, []);

  /* ─── türetilmiş tur durumu ─── */
  const currentFlag: CountryEntry | null = useMemo(() => {
    if (!room?.current_flag) return null;
    return CODE_TO_ENTRY[room.current_flag] ?? null;
  }, [room?.current_flag]);

  // Tur kimliği artık gösterilen-bayrak kimliğini (flag_seq) içerir: pas AYNI
  // tur altında yeni bayrak (yeni flag_seq) getirdiği için, roundKey'in flag_seq
  // ile değişmesi per-flag reset/timer/advance akışlarını doğru tetikler.
  const roundKey = room ? `G${room.game_seq}:R${room.current_round}:F${room.flag_seq}:${room.current_flag ?? ""}` : "";
  // MEVCUT gösterilen bayrağın (game_seq, flag_seq) çözüm satırı — gerçek claim
  // VEYA pas sentinel. flag_seq'e bağlandığı için AYNI round'daki ESKİ bayrağın
  // (paslanmış) sentinel'i yeni bayrağı "çözülmüş" göstermez (stale sızıntı yok).
  const currentResolution = useMemo(
    () => (room ? claims.find(c => c.game_seq === room.game_seq && c.flag_seq === room.flag_seq) ?? null : null),
    [claims, room?.game_seq, room?.flag_seq],
  );
  const winnerId = currentResolution && isScoringClaim(currentResolution.country_code)
    ? currentResolution.player_id : null;
  const roundAnswered = winnerId !== null;
  // Bu gösterilen bayrak PAS ile mi kapandı? (çözüm satırı `pass:<flag>` sentinel'i)
  const roundPassed = !!currentResolution && isPassClaim(currentResolution.country_code);
  const roundTimedOut = phase === "playing" && !roundAnswered && !roundPassed && timeLeft <= 0;
  const roundResolved = roundAnswered || roundPassed || roundTimedOut;
  const iAnswered = roundAnswered && winnerId === myId;
  const myPlaying = myPlayer?.status === "playing";
  const isPlaying = phase === "playing" && !roundResolved && myPlaying && timeLeft > 0;

  /* ─── Pas Geç oylaması (mevcut tur) ─── */
  // Aktif ('playing') oyuncu sayısı = quorum tabanı. Server otoriter hesaplar;
  // bu yalnız GÖSTERİM (X/N) içindir ve oyuncu ayrıl/atıl'da canlı güncellenir.
  const activePlayingCount = useMemo(
    () => players.filter(p => p.status === "playing").length,
    [players],
  );
  const passRequired = requiredPassVotes(activePlayingCount);
  // Oylar GÖSTERİLEN BAYRAĞA (game_seq, flag_seq) bağlı → pas sonrası yeni bayrak
  // (flag_seq++) oy sayacını 0/N'e sıfırlar; eski bayrağın oyları sızmaz.
  const currentFlagPassVotes = useMemo(
    () => (room ? passVotes.filter(v => v.game_seq === room.game_seq && v.flag_seq === room.flag_seq) : []),
    [passVotes, room?.game_seq, room?.flag_seq],
  );
  const passVoteCount = currentFlagPassVotes.length;
  const iVotedPass = currentFlagPassVotes.some(v => v.player_id === myId);

  const leaderboard = useMemo(() => buildLeaderboard(players, claims), [players, claims]);
  const myScore = useMemo(() => leaderboard.find(r => r.playerId === myId)?.score ?? 0, [leaderboard, myId]);

  const regionLabel = CONTINENT_LABEL[denormalizeRegion(room?.region ?? hostRegion)] ?? "🌍 Dünya";
  const shareLink = room ? `${location.origin}${location.pathname}?flagGroup=${room.code}` : "";

  /* per-round reset (input/feedback/img/timer) */
  useEffect(() => {
    setInput("");
    setFeedback(null);
    setImgError(false);
    setTimeLeft(FLAG_TIMEOUT_SEC); // stale-0 flicker (önceki turdan) engelle
  }, [roundKey]);

  const showFeedback = useCallback((type: "correct" | "wrong" | "dup") => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback(type);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), 900);
  }, []);

  /* ═══════════ INVITE JOIN (?flagGroup=KOD) ═══════════ */
  const hasSavedSessionAtMount = useMemo(() => loadRoomSession() !== null, []);
  useInviteJoin({
    paramKey: "flagGroup",
    setJoinCode,
    canAutoJoin: !!profile?.username && phase === "lobby" && !room && !hasSavedSessionAtMount,
    triggerJoin: (code) => { inviteOverrideCodeRef.current = code; void joinRoom(); },
  });

  /* ═══════════ SESSION RESTORE (reload/reconnect) ═══════════ */
  useEffect(() => {
    const saved = loadRoomSession();
    if (!saved) return;
    myIdRef.current = saved.playerId;
    claimTokenRef.current = saved.claimToken;
    (async () => {
      const { data: r } = await supabase.from("flag_group_rooms").select("*").eq("id", saved.roomId).single();
      if (!r?.id) { clearFlagGroupSession(); return; }
      const room0 = r as FGRoom;
      const { data: ps } = await supabase.from("flag_group_players").select("*").eq("room_id", room0.id);
      const myRow = (ps ?? []).find((p: FGPlayer) => p.id === saved.playerId);
      if (!myRow) { clearFlagGroupSession(); return; }   // atılmış/oda gitmiş → temiz başla
      const { data: cs } = await supabase.from("flag_group_claims").select("*").eq("room_id", room0.id);
      const claims0 = (cs as FGClaim[] | null) ?? [];
      setRoom(room0); setPlayers((ps as FGPlayer[]) ?? []); setIsHost(!!myRow.is_host); setClaims(claims0);
      if (room0.status === "playing") {
        gameEndedRef.current = false; advanceHandledRef.current = "";
        if (myRow.is_host) buildHostSequence(room0.region, room0.total_rounds,
          new Set([...(room0.current_flag ? [room0.current_flag] : []), ...shownFlagCodes(claims0)]));
        setPhase("playing");
      } else if (room0.status === "finished") {
        gameEndedRef.current = true; setFinalLeaderboard(buildLeaderboard((ps as FGPlayer[]) ?? [], claims0));
        setReturned(myRow.status === "waiting"); setPhase("finished");
      } else {
        setPhase("waiting");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ═══════════ REALTIME ═══════════ */
  useEffect(() => {
    if (!room) return;
    const roomId = room.id;
    const chan = supabase.channel(`flag-group:${roomId}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "flag_group_rooms", filter: `id=eq.${roomId}` },
        (payload: { new: FGRoom }) => {
          const r = payload.new as FGRoom;
          setRoom(r);
          if (r.status === "playing" && phaseRef.current !== "playing") {
            // Yeni maç başladı — eski state temizliği + (host) sıra kurulumu.
            setClaims([]);
            setPassVotes([]);
            setFinalLeaderboard(null);
            setReturned(false);
            gameEndedRef.current = false;
            advanceHandledRef.current = "";
            // Sıra host'un startGame'inde kurulur; realtime clobber ETMESİN.
            if (isHostRef.current && flagSeqCodesRef.current.length === 0)
              buildHostSequence(r.region, r.total_rounds, new Set(r.current_flag ? [r.current_flag] : []));
            setPhase("playing");
          }
          if (r.status === "finished" && !gameEndedRef.current) {
            gameEndedRef.current = true;
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            void freezeLeaderboard(r.id);
            setReturned(false);
            setPhase("finished");
          }
        })
      .on("postgres_changes",
        { event: "DELETE", schema: "public", table: "flag_group_rooms", filter: `id=eq.${roomId}` },
        () => {
          if (leavingRef.current) return;
          // Kendi rızamızla ayrılmıyorsak ve oyun normal bitmediyse → host kapattı.
          leavingRef.current = true;
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          clearFlagGroupSession();
          resetToLobby();
          setRoomClosedNoticeOpen(true);
          leavingRef.current = false;
        })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "flag_group_players", filter: `room_id=eq.${roomId}` },
        () => {
          supabase.from("flag_group_players").select("*").eq("room_id", roomId)
            .then(({ data }: { data: FGPlayer[] | null }) => { if (data) setPlayers(data as FGPlayer[]); });
        })
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "flag_group_claims", filter: `room_id=eq.${roomId}` },
        (payload: { new: FGClaim }) => {
          setClaims(prev => {
            const c = payload.new as FGClaim;
            if (prev.some(x => x.id === c.id)) return prev;
            return [...prev, c];
          });
        })
      .on("postgres_changes",
        // Pas oyları — her değişimde (INSERT/DELETE) oda için listeyi yenile.
        // Tek satır olduğu için tam fetch maliyeti ihmal edilebilir; DELETE
        // (unvote / FK-cascade) tutarlılığı için en sağlam yol.
        { event: "*", schema: "public", table: "flag_group_pass_votes", filter: `room_id=eq.${roomId}` },
        () => {
          supabase.from("flag_group_pass_votes").select("*").eq("room_id", roomId)
            .then(({ data }: { data: FGPassVote[] | null }) => { if (data) setPassVotes(data as FGPassVote[]); });
        })
      .subscribe();

    // İlk yükleme — abone olunca mevcut pas oylarını çek (reload/reconnect'te
    // kendi oyum doğru görünsün).
    supabase.from("flag_group_pass_votes").select("*").eq("room_id", roomId)
      .then(({ data }: { data: FGPassVote[] | null }) => { if (data) setPassVotes(data as FGPassVote[]); });

    return () => { supabase.removeChannel(chan); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  /* Fallback poll: waiting fazında player listesi + start tespiti */
  useEffect(() => {
    if (phase !== "waiting" || !room?.id) return;
    const roomId = room.id;
    const t = setInterval(async () => {
      const { data: ps } = await supabase.from("flag_group_players").select("*").eq("room_id", roomId);
      if (ps) setPlayers(ps as FGPlayer[]);
      const { data: r } = await supabase.from("flag_group_rooms").select("*").eq("id", roomId).single();
      if (r && r.status === "playing" && phaseRef.current === "waiting") {
        setClaims([]); setPassVotes([]); setFinalLeaderboard(null); setReturned(false);
        gameEndedRef.current = false; advanceHandledRef.current = "";
        if (isHostRef.current && flagSeqCodesRef.current.length === 0)
          buildHostSequence((r as FGRoom).region, (r as FGRoom).total_rounds, new Set((r as FGRoom).current_flag ? [(r as FGRoom).current_flag!] : []));
        setRoom(r as FGRoom);
        setPhase("playing");
      }
    }, 2000);
    return () => clearInterval(t);
  }, [phase, room?.id, buildHostSequence]);

  /* Server-clock sync (playing) */
  useEffect(() => {
    if (phase !== "playing") return;
    const h = initServerClockSync();
    return () => h.dispose();
  }, [phase]);

  /* Per-flag timer (server-otoriter, tüm client'lar current_flag_at'e bakar) */
  useEffect(() => {
    if (phase !== "playing" || !room?.current_flag_at) { setTimeLeft(FLAG_TIMEOUT_SEC); return; }
    const startMs = new Date(room.current_flag_at).getTime();
    const totalMs = FLAG_TIMEOUT_SEC * 1000;
    let done = false;
    const tick = () => {
      if (done) return;
      const remMs = Math.max(0, startMs + totalMs - getSyncedNowMs());
      setTimeLeft(Math.min(FLAG_TIMEOUT_SEC, Math.ceil(remMs / 1000)));
      if (remMs <= 0) { done = true; return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { done = true; if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, roundKey, room?.current_flag_at]);

  /* Geri sayım sesi (yalnız yerel UI efekti — Realtime'a yayılmaz).
     Son COUNTDOWN_TAIL_SEC (5) sn'de gösterilen bayrak başına BİR kez çalar;
     tek cache instance (countdown20) kullandığından iki ses üst üste binmez.
     Pas AYNI turda flag_seq'i artırır → countdownFlagRef anahtarı değişir →
     yeni bayrakta ses sıfırlanır ve yeniden silahlanır. */
  useEffect(() => {
    const flagKey = room ? `G${room.game_seq}:F${room.flag_seq}` : "";

    // Aktif oynanış dışı / bayrak çözüldü / kullanıcı geri sayımı kapattı /
    // oda yok → sesi kes ve guard'ı temizle.
    if (phase !== "playing" || roundResolved || !room || getCountdownSoundMode() === "off") {
      if (countdownFlagRef.current) {
        stopSound("countdown20");
        countdownFlagRef.current = "";
      }
      return;
    }

    // Yeni bayrak (flag_seq/game_seq değişti): önceki sesi durdur+başa sar,
    // bu bayrak için guard'ı "silahlı" duruma getir ve HEMEN return et.
    // KRİTİK (pas fix): bu effect çalışmasında `timeLeft` hâlâ ESKİ bayraktan
    // kalma olabilir (pas sonrası ilk render'da ≤5) — timer efekti yeni
    // current_flag_at'e göre rAF içinde asenkron resetliyor, bu render'da
    // henüz 10'a dönmedi. Aynı run'da aşağıdaki oynatma branch'ine düşersek
    // ses yanlışlıkla 10. sn'de tetiklenip guard'ı `:played` yapar; gerçek
    // 5→0 penceresinde artık çalmaz. Silahlayıp return ederek oynatmayı yalnız
    // `timeLeft` yeni bayrağa göre güncellendikten sonraki re-run'a bırakırız.
    if (countdownFlagRef.current !== flagKey && countdownFlagRef.current !== `${flagKey}:played`) {
      stopSound("countdown20");
      countdownFlagRef.current = flagKey;
      return;
    }

    // Kalan süre ilk kez son 5 sn'ye inince (gecikip 6→4'e düşse de) tek sefer çal.
    if (countdownFlagRef.current === flagKey && timeLeft > 0 && timeLeft <= COUNTDOWN_TAIL_SEC) {
      countdownFlagRef.current = `${flagKey}:played`;
      playSound("countdown20", { seekSeconds: COUNTDOWN_SEEK_S });
    }

    // Süre bittiyse (henüz resolve UPDATE'i gelmeden) sarkmayı önle.
    if (timeLeft <= 0) {
      stopSound("countdown20");
    }
  }, [phase, roundResolved, timeLeft, room?.game_seq, room?.flag_seq, room]);

  /* Unmount: geri sayım sesi hiçbir koşulda sarkmasın. */
  useEffect(() => () => stopSound("countdown20"), []);

  /* auto-focus */
  useEffect(() => {
    if (isPlaying) setTimeout(() => inputRef.current?.focus(), 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundKey, isPlaying]);

  /* ═══════════ BAYRAK İLERLETME (host otoriter, SERVER karar verir) ═══════════
     Host, mevcut bayrak çözüldükten sonra flag_group_advance_flag'i çağırır ve
     YALNIZ bir aday sonraki bayrak verir. Round'un ilerleyip ilerlemeyeceğine
     (pas → aynı tur, claim/timeout → +1, son tur → finalize) SERVER karar verir;
     client "shouldAdvanceRound" göndermez. Non-host YALNIZ son-tur host-kaybı
     güvenlik ağı olarak finalize eder — ve YALNIZ tur claim/timeout ile bittiyse
     (PAS ise host aynı tur altında yeni bayrak getireceği için finalize ETMEZ). */
  useEffect(() => {
    if (phase !== "playing" || !room) return;
    if (!roundResolved) return;
    const rk = roundKey;
    if (advanceHandledRef.current === rk) return;

    const isHostNow = isHostRef.current;
    if (isHostNow) {
      advanceTimerRef.current = setTimeout(() => { void runAdvance(rk, true); }, REVEAL_DELAY_MS);
    } else {
      // Non-host güvenlik ağı: yalnız SON tur + PAS DEĞİL (claim/timeout) → finalize.
      // Paslanan son tur host tarafından yeni bayrağa taşınır; non-host bitirmemeli.
      const isLastRound = room.current_round >= room.total_rounds;
      if (!isLastRound || roundPassed) return;
      advanceTimerRef.current = setTimeout(() => { void runAdvance(rk, false); }, REVEAL_DELAY_MS + 4000);
    }
    return () => { if (advanceTimerRef.current) { clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, roundResolved, roundKey, room?.current_round]);

  const runAdvance = useCallback(async (rk: string, isHostNow: boolean) => {
    if (phaseRef.current !== "playing") return;
    const r = roomRef.current;
    if (!r || r.status !== "playing") return;
    advanceHandledRef.current = rk;

    if (!isHostNow) {
      // Son-tur host-kaybı güvenlik ağı (idempotent; host zaten bitirdiyse no-op).
      const { error } = await supabase.rpc("flag_group_finalize_game", {
        p_room_id: r.id, p_player_id: myIdRef.current, p_claim_token: claimTokenRef.current,
      });
      if (error) dbgErr("flag_group_finalize_game (safety net) failed", error);
      return;
    }

    // Host: aday sonraki bayrağı seç (havuzdan, tekrar yok). null → havuz tükendi;
    // server bunu finalize sinyali olarak yorumlar. Round vs finalize kararı
    // SERVER'da (advance_flag) mevcut çözüm satırı kilit altında okunarak verilir.
    usedFlagsRef.current.add(r.current_flag ?? "");
    const next = pickNextFlagCode(flagSeqCodesRef.current, usedFlagsRef.current);
    if (next) usedFlagsRef.current.add(next);
    const { data, error } = await supabase.rpc("flag_group_advance_flag", {
      p_room_id: r.id, p_host_player_id: myIdRef.current, p_claim_token: claimTokenRef.current,
      p_flag_seq: r.flag_seq, p_next_flag: next,
    });
    if (error) { dbgErr("flag_group_advance_flag failed", error); advanceHandledRef.current = ""; return; }
    if (data) setRoom(data as FGRoom);
  }, []);

  /* ═══════════ KICKED detection (waiting/finished) ═══════════ */
  useEffect(() => {
    if (!room || !myIdRef.current || !players.length) return;
    if (phase !== "waiting" && phase !== "finished") return;
    if (leavingRef.current) return;
    if (players.some(p => p.id === myIdRef.current)) return;
    clearFlagGroupSession();
    resetToLobby();
    setKickedNoticeOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, phase, players]);

  /* heartbeat (waiting + playing) */
  useEffect(() => {
    if (phase !== "waiting" && phase !== "playing") return;
    if (!myIdRef.current || !claimTokenRef.current) return;
    const beat = () => {
      supabase.rpc("flag_group_heartbeat", { p_player_id: myIdRef.current, p_claim_token: claimTokenRef.current })
        .then(({ error }: { error: unknown }) => { if (error) dbgErr("heartbeat failed", error); });
    };
    beat();
    const t = setInterval(beat, 5000);
    return () => clearInterval(t);
  }, [phase]);

  /* ─── helpers ─── */
  const freezeLeaderboard = useCallback(async (roomId: string) => {
    const [{ data: cs }, { data: ps }] = await Promise.all([
      supabase.from("flag_group_claims").select("*").eq("room_id", roomId),
      supabase.from("flag_group_players").select("*").eq("room_id", roomId),
    ]);
    const pl = (ps as FGPlayer[] | null) ?? players;
    const cl = (cs as FGClaim[] | null) ?? claims;
    if (cs) setClaims(cl);
    setFinalLeaderboard(buildLeaderboard(pl, cl));
  }, [players, claims]);

  function resetToLobby() {
    setRoom(null); setPlayers([]); setClaims([]); setPassVotes([]); setIsHost(false);
    setFinalLeaderboard(null); setReturned(false); setErrorMsg(null); setStatusMsg(null);
    setQuitModal(false); gameEndedRef.current = false; advanceHandledRef.current = "";
    setPhase("lobby");
  }

  /* ═══════════ CREATE / JOIN ═══════════ */
  const createRoom = async () => {
    const name = effectivePlayerName.trim();
    const err = validateUsername(name);
    if (err) { setErrorMsg(err); setPhase("lobby"); return; }
    const safeMax = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, hostMaxPlayers));

    setErrorMsg(null); setStatusMsg("Oda kuruluyor…"); setPhase("creating");
    clearFlagGroupSession();
    const freshId = crypto.randomUUID();
    const freshToken = crypto.randomUUID();
    myIdRef.current = freshId; claimTokenRef.current = freshToken;
    localStorage.setItem(PLAYER_ID_KEY, freshId);
    const code = makeCode();
    const { profileId, guestId } = getIdentityArgs();

    const { data, error } = await supabase.rpc("flag_group_create_room", {
      p_player_id: freshId, p_profile_id: profileId, p_guest_id: guestId, p_name: name,
      p_code: code, p_region: normalizeRegion(hostRegion), p_total_rounds: hostRounds,
      p_max_players: safeMax, p_claim_token: freshToken,
    });
    if (error || !data) {
      dbgErr("flag_group_create_room failed", error);
      setErrorMsg(describeFlagGroupRpcError(error)); setStatusMsg(null); setPhase("lobby"); return;
    }
    const newRoom = data as FGRoom;
    const { data: ps } = await supabase.from("flag_group_players").select("*").eq("room_id", newRoom.id);
    setRoom(newRoom); setPlayers((ps as FGPlayer[]) ?? []); setClaims([]); setIsHost(true);
    saveRoomSession(newRoom.id, newRoom.code, freshId, freshToken);
    setStatusMsg(null); setPhase("waiting");
  };

  const joinRoom = async () => {
    const name = effectivePlayerName.trim();
    const overrideCode = inviteOverrideCodeRef.current; inviteOverrideCodeRef.current = null;
    const code = (overrideCode ?? joinCode).trim().toUpperCase();
    const err = validateUsername(name);
    if (err) { setErrorMsg(err); setPhase("lobby"); return; }
    if (!code) { setErrorMsg("Oda kodu yazmalısın."); return; }

    setErrorMsg(null); setStatusMsg("Odaya bağlanılıyor…");

    // Resume: aynı odada kayıtlı session varsa RPC çağırmadan restore.
    const saved = loadRoomSession();
    if (saved?.roomCode === code && saved.playerId && saved.claimToken) {
      myIdRef.current = saved.playerId; claimTokenRef.current = saved.claimToken;
      const { data: r } = await supabase.from("flag_group_rooms").select("*").eq("code", code).single();
      if (!r?.id) { setErrorMsg("Oda bulunamadı. Kodu kontrol et."); setStatusMsg(null); return; }
      const targetRoom = r as FGRoom;
      const { data: ps } = await supabase.from("flag_group_players").select("*").eq("room_id", targetRoom.id);
      const myRow = (ps ?? []).find((p: FGPlayer) => p.id === saved.playerId);
      if (myRow) {
        setRoom(targetRoom); setPlayers((ps as FGPlayer[]) ?? []); setIsHost(!!myRow.is_host);
        const { data: cs } = await supabase.from("flag_group_claims").select("*").eq("room_id", targetRoom.id);
        setClaims((cs as FGClaim[]) ?? []);
        saveRoomSession(targetRoom.id, targetRoom.code, saved.playerId, saved.claimToken);
        if (targetRoom.status === "playing") {
          gameEndedRef.current = false; advanceHandledRef.current = "";
          if (myRow.is_host) buildHostSequence(
            targetRoom.region, targetRoom.total_rounds,
            new Set([...(targetRoom.current_flag ? [targetRoom.current_flag] : []),
                     ...shownFlagCodes((cs as FGClaim[] | null) ?? [])]),
          );
          setPhase("playing");
        } else if (targetRoom.status === "finished") {
          gameEndedRef.current = true; void freezeLeaderboard(targetRoom.id); setPhase("finished");
        } else {
          setPhase("waiting");
        }
        setStatusMsg(null);
        return;
      }
      clearFlagGroupSession();
    }

    const joinId = crypto.randomUUID();
    const joinToken = crypto.randomUUID();
    myIdRef.current = joinId; claimTokenRef.current = joinToken;
    localStorage.setItem(PLAYER_ID_KEY, joinId);
    const { profileId, guestId } = getIdentityArgs();
    const { data, error } = await supabase.rpc("flag_group_join_room", {
      p_code: code, p_player_id: joinId, p_profile_id: profileId, p_guest_id: guestId,
      p_name: name, p_claim_token: joinToken,
    });
    if (error || !data) {
      dbgErr("flag_group_join_room failed", error);
      setErrorMsg(describeFlagGroupRpcError(error)); setStatusMsg(null); return;
    }
    const targetRoom = data as FGRoom;
    const { data: ps } = await supabase.from("flag_group_players").select("*").eq("room_id", targetRoom.id);
    setRoom(targetRoom); setPlayers((ps as FGPlayer[]) ?? []); setClaims([]); setIsHost(false);
    saveRoomSession(targetRoom.id, targetRoom.code, joinId, joinToken);
    setStatusMsg(null); setPhase("waiting");
  };

  /* ═══════════ HOST SETTINGS ═══════════ */
  const updateRoomSettings = useCallback(async (patch: Partial<Pick<FGRoom, "total_rounds" | "region" | "max_players">>) => {
    const r = roomRef.current;
    if (!r || !isHostRef.current || phaseRef.current !== "waiting") return;
    if (patch.max_players != null && patch.max_players < players.length) {
      setErrorMsg(`Maksimum oyuncu sayısı şu an odada olan kişi sayısından düşük olamaz. Şu an ${players.length} kişi var.`);
      return;
    }
    const { data, error } = await supabase.rpc("flag_group_update_settings", {
      p_room_id: r.id, p_host_player_id: myIdRef.current, p_claim_token: claimTokenRef.current,
      p_total_rounds: patch.total_rounds ?? null, p_region: patch.region ?? null, p_max_players: patch.max_players ?? null,
    });
    if (error) { dbgErr("flag_group_update_settings failed", error); setErrorMsg(describeFlagGroupRpcError(error)); return; }
    if (data) setRoom(data as FGRoom);
    setErrorMsg(null);
  }, [players.length]);

  /* ═══════════ START ═══════════ */
  const startGame = async () => {
    const r = roomRef.current;
    if (!r || !isHostRef.current) return;
    if (players.length < MIN_PLAYERS) { setErrorMsg(`En az ${MIN_PLAYERS} oyuncu gerekli.`); return; }
    if (!allPlayersReady(players)) { setErrorMsg("Tüm oyuncuların lobiye dönmesi bekleniyor."); return; }

    buildHostSequence(r.region, r.total_rounds, new Set());
    const first = pickNextFlagCode(flagSeqCodesRef.current, usedFlagsRef.current);
    if (!first) { setErrorMsg("Bu bölgede yeterli bayrak yok."); return; }
    usedFlagsRef.current.add(first);

    const { data, error } = await supabase.rpc("flag_group_start_game", {
      p_room_id: r.id, p_host_player_id: myIdRef.current, p_claim_token: claimTokenRef.current, p_first_flag: first,
    });
    if (error) { dbgErr("flag_group_start_game failed", error); setErrorMsg(describeFlagGroupRpcError(error)); return; }
    setClaims([]); setPassVotes([]); gameEndedRef.current = false; advanceHandledRef.current = "";
    if (data) setRoom(data as FGRoom);
    setPhase("playing");
  };

  /* ═══════════ GUESS ═══════════ */
  const handleGuess = async () => {
    if (phaseRef.current !== "playing") return;
    const r = roomRef.current;
    if (!r || !currentFlag || roundResolved || !myPlaying || timeLeftRef.current <= 0) return;
    const norm = normalizeInput(input);
    if (!norm) return;
    const entry = NAME_TO_ENTRY[norm];
    // 1v1 ile AYNI doğrulama: girilen ad mevcut bayrağın ülkesi mi?
    if (!entry || entry.code !== currentFlag.code) { playSound("wrong"); showFeedback("wrong"); setInput(""); return; }
    setInput("");
    if (claimsRef.current.some(c => c.country_code === currentFlag.code)) { showFeedback("dup"); return; }

    const { data, error } = await supabase.rpc("flag_group_submit_claim", {
      p_room_id: r.id, p_player_id: myIdRef.current, p_claim_token: claimTokenRef.current, p_country_code: currentFlag.code,
    });
    if (error) { dbgErr("flag_group_submit_claim failed", error); playSound("wrong"); showFeedback("wrong"); return; }
    const res = data as { claimed: boolean; reason?: string } | null;
    if (res?.claimed) { playSound("correct"); showFeedback("correct"); }
    else if (res?.reason === "dup") { showFeedback("dup"); }        // başkası önce bildi
    else { showFeedback("wrong"); }                                  // stale (tur kapanmış)
  };

  /* ═══════════ PAS GEÇ (toggle oy) ═══════════
     Server-otoriter: RPC quorum'u KİLİT altında kendi hesaplar; çoğunluk
     oluşunca flag_group_claims'e `pass:<flag>` sentinel yazar → tüm client'lar
     claims realtime'ıyla roundPassed=true görür (bu turu ÇÖZER). Client burada
     yalnız oyu toggle eder; kararı vermez. Oy/geri-çek state'i pas oyları
     realtime'ından (passVotes) yansır. */
  const togglePass = useCallback(async () => {
    const r = roomRef.current;
    if (!r || r.status !== "playing" || !claimTokenRef.current) return;
    if (passPending) return;
    setPassPending(true);
    try {
      const { error } = await supabase.rpc("flag_group_toggle_pass_vote", {
        p_room_id: r.id, p_player_id: myIdRef.current, p_claim_token: claimTokenRef.current,
        p_game_seq: r.game_seq, p_round: r.current_round, p_flag_seq: r.flag_seq,
      });
      if (error) dbgErr("flag_group_toggle_pass_vote failed", error);
    } finally {
      setPassPending(false);
    }
  }, [passPending]);

  /* ═══════════ ESC = Pas Geç oyu (1v1 klavye paritesi) ═══════════
     Bayrak 1v1'de ESC pas verir; çok oyunculuda ESC turu DOĞRUDAN geçirmez,
     yalnız kullanıcının pas OYUNU verir/geri çeker (togglePass — server quorum'u
     hesaplar). Listener yalnız 'playing' fazında ve oyuncu oy verebilecek
     durumdayken (Pas Geç butonu görünürken = isPlaying) aktiftir; faz/round
     değişince temizlenir. Guard'lar: e.repeat (uzun basış tek işlem), IME
     composition, açık modal/overlay (quit/kick/uyarı/mobil sheet). Document
     seviyesinde dinlenir → input odakta olsa bile çalışır (input onKeyDown yalnız
     Enter'ı işler, ESC buraya köpürür). */
  useEffect(() => {
    if (phase !== "playing") return;
    const overlayOpen = quitModal || !!kickTarget || kickedNoticeOpen
      || roomClosedNoticeOpen || chatSheetOpen || playersSheetOpen;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.repeat) return;                          // uzun basış → tek işlem
      if (e.isComposing || e.keyCode === 229) return; // IME composition sırasında yok say
      if (overlayOpen) return;                        // modal/overlay açıkken pas verme
      if (!isPlaying) return;                         // round resolve / yetkisiz / süre bitti → yok say
      e.preventDefault();
      void togglePass();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, isPlaying, quitModal, kickTarget, kickedNoticeOpen, roomClosedNoticeOpen, chatSheetOpen, playersSheetOpen, togglePass]);

  /* ═══════════ KICK ═══════════ */
  const kickPlayer = useCallback(async (playerId: string) => {
    const r = roomRef.current;
    if (!r || !isHostRef.current) return;
    if (phaseRef.current !== "waiting" && phaseRef.current !== "finished") return;
    if (playerId === myIdRef.current) return;
    const { error } = await supabase.rpc("flag_group_kick_player", {
      p_room_id: r.id, p_host_player_id: myIdRef.current, p_host_claim_token: claimTokenRef.current, p_target_player_id: playerId,
    });
    if (error) { dbgErr("flag_group_kick_player failed", error); setErrorMsg(describeFlagGroupRpcError(error)); return; }
    setPlayers(prev => prev.filter(p => p.id !== playerId));
    setKickTarget(null);
  }, []);

  /* ═══════════ LEAVE ═══════════ */
  const leaveRoom = useCallback(async (target: "lobby" | "home") => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    try {
      const r = roomRef.current;
      if (r && claimTokenRef.current) {
        const { error } = await supabase.rpc("flag_group_leave_room", {
          p_room_id: r.id, p_player_id: myIdRef.current, p_claim_token: claimTokenRef.current,
        });
        if (error) dbgErr("flag_group_leave_room failed", error);
      }
      clearFlagGroupSession(); claimTokenRef.current = "";
      if (target === "home") { onHome(); }
      else { resetToLobby(); }
    } finally { leavingRef.current = false; }
  }, [onHome]);

  /* ═══════════ RETURN TO LOBBY (per-player) ═══════════ */
  const returnToLobby = useCallback(async () => {
    const r = roomRef.current;
    if (!r || !claimTokenRef.current) return;
    setReturned(true);
    const { error } = await supabase.rpc("flag_group_return_to_lobby", {
      p_room_id: r.id, p_player_id: myIdRef.current, p_claim_token: claimTokenRef.current,
    });
    if (error) { dbgErr("flag_group_return_to_lobby failed", error); setReturned(false); return; }
    setClaims([]); setPassVotes([]); setFinalLeaderboard(null); gameEndedRef.current = false; advanceHandledRef.current = "";
    setErrorMsg(null); setPhase("waiting");
  }, []);

  /* ─── invite message ─── */
  const inviteMessage = room ? `🚩 Bayrak Bilmece – Çok Oyunculu

Oda Kodu: ${room.code}
Bölge: ${regionLabel}
Tur: ${room.total_rounds}

Aynı bayrağı görürsünüz — ilk doğru yazan turu alır!

Oyuna katıl:
${shareLink}` : "";

  /* derived: start gate + reasons */
  const everyoneReady = allPlayersReady(players);
  const canStart = isHost && phase === "waiting" && players.length >= MIN_PLAYERS && everyoneReady;
  const startBlockReason = players.length < MIN_PLAYERS
    ? `En az ${MIN_PLAYERS} oyuncu gerekli`
    : !everyoneReady ? "Tüm oyuncuların lobiye dönmesi bekleniyor." : "";

  /* ─────────── RENDER ─────────── */
  const homeTheme = readStoredHomeTheme();
  const isPreGame = phase !== "playing" && phase !== "finished";
  const themeBgStyle = isPreGame ? getThemeBackgroundStyle(homeTheme) : undefined;
  const themeDataAttr = isPreGame ? getThemeDataAttr(homeTheme) : undefined;

  const flagSrc = currentFlag ? `/assets/flags/${currentFlag.code}.svg` : "";
  const winnerName = winnerId ? (players.find(p => p.id === winnerId)?.name ?? "Bir oyuncu") : "";
  const timerColor = roundTimedOut ? "#ef4444"
    : timeLeft > FLAG_TIMEOUT_SEC * 0.5 ? "var(--accent)"
    : timeLeft > FLAG_TIMEOUT_SEC * 0.3 ? "#f59e0b" : "#ef4444";
  const timerPct = (timeLeft / FLAG_TIMEOUT_SEC) * 100;

  /* ─── Üst oyun barı (Çark Çok Oyunculu ile aynı .duel-header yapısı) ───
     Sol: ← Menü (güvenli ayrılma akışı) · Orta: mod adı + gerçek oda kodu +
     gerçek bölge. Oyun sırasında ← Menü quit modalını açar (mevcut davranış);
     lobide/sonuçta güvenli leaveRoom → host çıkarsa oda kapanır. */
  const flagTopBar = (
    <div className="duel-header">
      <button
        className="back-btn"
        title="Ana Menü"
        onClick={() => {
          playSound("click");
          if (phaseRef.current === "playing") { setQuitModal(true); return; }
          leaveRoom("home");
        }}
      >
        <span>←</span>
        <span className="back-label">Menü</span>
      </button>
      <div className="duel-header-center">
        <span className="duel-mode-label">🚩 Bayrak Bilmece · Çok Oyunculu</span>
        {room && (
          <>
            <span className="duel-code-badge">#{room.code}</span>
            <span className="duel-region-badge">{regionLabel}</span>
          </>
        )}
      </div>
      <div style={{ width: 80 }} />
    </div>
  );

  /* ─── Ortak oyuncu satırı (desktop sol kart + mobil sheet) ───
     "Sonuç ekranında" (status !== waiting) satırları dimmed + etiketli kalır. */
  const renderFlagPlayerRow = (p: FGPlayer) => {
    const isMe = p.id === myId;
    const onResults = p.status !== "waiting";
    return (
      <div
        key={p.id}
        className={"duel-player-chip" + (isMe ? " mine" : "")}
        style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 5, paddingBottom: 5, minWidth: 0, opacity: onResults ? 0.5 : 1 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
          <PlayerAvatar username={p.name} size="sm" highlight={p.is_host} className="duel-player-avatar" />
          <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {p.name}
          </span>
          {isMe && <span className="duel-tag" style={{ flexShrink: 0, marginLeft: 2 }}>Sen</span>}
          {p.is_host && <span className="duel-tag host" style={{ flexShrink: 0, marginLeft: 2 }}>👑</span>}
        </div>
        {onResults && (
          <span style={{ fontSize: 10.5, color: "var(--amber, #d4a02c)", whiteSpace: "nowrap", flexShrink: 0 }}>
            Sonuç ekranında
          </span>
        )}
        {isHost && !p.is_host && (
          <button
            type="button"
            className="dgg-kick-btn"
            style={{ flexShrink: 0 }}
            onClick={() => { setKickTarget(p); setPlayersSheetOpen(false); }}
          >
            At
          </button>
        )}
      </div>
    );
  };

  /* ─── Oyuncu yuvaları (dolu + boş + kapalı) — Çark/Ülke Yaz ile aynı ─── */
  const renderFlagSlots = (sheet: boolean) => {
    if (!room) return null;
    const sorted = players.slice().sort((a, b) => a.joined_at.localeCompare(b.joined_at));
    return Array.from({ length: Math.max(MAX_PLAYERS, sorted.length) }, (_, i) => {
      const p = sorted[i] ?? null;
      const isClosed = i >= room.max_players;
      if (!p) {
        if (isClosed) {
          return (
            <div key={`closed-${i}`} className={"wgg-slot-closed" + (sheet ? " wgg-slot-closed--sheet" : "")} aria-disabled="true">
              <span className="wgg-slot-closed-icon" aria-hidden="true">🔒</span>
              <span className="wgg-slot-closed-label">Kapalı slot</span>
            </div>
          );
        }
        if (sheet) {
          return (
            <div key={`empty-${i}`} className="wgg-ps-empty-slot">
              <span className="wgg-ps-dot-empty" />
              <span>Boş slot</span>
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
      return renderFlagPlayerRow(p);
    });
  };

  return (
    <div className="duel-app" style={themeBgStyle} data-theme={themeDataAttr}>
      {/* ════════ LOBBY ════════ */}
      {(phase === "lobby" || phase === "creating") && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}
              onClick={() => { playSound("click"); onHome(); }}>← Ana Menü</button>
            <h2 className="duel-lobby-title">🚩 Bayrak — Çok Oyunculu</h2>
            <p className="duel-lobby-desc">
              2–10 kişilik arkadaş grubunla oyna • Aynı bayrağı görürsünüz —
              ilk doğru yazan turu alır, en çok tur alan kazanır!
            </p>

            <input className="duel-name-input" type="text" placeholder="İsmin"
              value={isLoggedInPlayer ? loggedInUsername : playerName}
              onChange={e => { if (!isLoggedInPlayer) setPlayerName(e.target.value.slice(0, 20)); }}
              disabled={isLoggedInPlayer} maxLength={20} autoComplete="off" />

            {/* CREATE */}
            <div className="duel-create-block duel-create-polished">
              <div className="duel-create-fields">
                <div className="duel-host-settings">
                  <div className="duel-select-wrap">
                    <label className="duel-select-label">Tur</label>
                    <div className="duel-select-box">
                      <select className="duel-select" value={hostRounds} onChange={e => setHostRounds(Number(e.target.value))}>
                        {ROUND_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <span className="duel-select-caret">⌄</span>
                    </div>
                  </div>
                  <div className="duel-select-wrap">
                    <label className="duel-select-label">Bölge</label>
                    <div className="duel-select-box">
                      <select className="duel-select" value={hostRegion} onChange={e => setHostRegion(e.target.value)}>
                        {REGION_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <span className="duel-select-caret">⌄</span>
                    </div>
                  </div>
                  <div className="duel-select-wrap">
                    <label className="duel-select-label">Maks Oyuncu</label>
                    <div className="duel-select-box">
                      <select className="duel-select" value={hostMaxPlayers} onChange={e => setHostMaxPlayers(Number(e.target.value))}>
                        {[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>{n} kişi</option>)}
                      </select>
                      <span className="duel-select-caret">⌄</span>
                    </div>
                  </div>
                </div>
                <button className="btn btn-accent duel-create-btn" onClick={createRoom} disabled={phase !== "lobby"}>
                  {phase === "creating" ? "Kuruluyor..." : "🏠 Grup Odası Kur"}
                </button>
              </div>

              <div className="dgg-join-divider"><span>veya mevcut bir odaya katıl</span></div>

              <div className="duel-join-block">
                <div className="duel-join-row">
                  <input className="duel-code-input" type="text" placeholder="ODA KODU"
                    value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase().slice(0, 8))}
                    onKeyDown={e => { if (e.key === "Enter") joinRoom(); }} maxLength={8} autoComplete="off" />
                  <button className="btn btn-accent" onClick={joinRoom}>Katıl</button>
                </div>
              </div>
            </div>

            {statusMsg && <p className="duel-waiting-msg">{statusMsg}</p>}
            {errorMsg && <p className="duel-error">{errorMsg}</p>}
          </div>
        </div>
      )}

      {/* ════════ WAITING (LOBİ) — 3 kolon: Oyuncular · Oda/Ayarlar · Sohbet ════════ */}
      {phase === "waiting" && room && (
        <div className="dgg-lobby-shell">
          {flagTopBar}
          <div className="duel-lobby">
            <div className="wgg-grid">
              {/* ══ SOL KART: Oyuncular ══ */}
              <div className="duel-lobby-card wgg-players-card">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexShrink: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.02em" }}>👥 Oyuncular</span>
                  <span className="wgg-max-badge" aria-label="Oyuncu sayısı">{players.length}/{room.max_players}</span>
                </div>
                <div className="wgg-player-list">
                  {renderFlagSlots(false)}
                </div>
                {players.length < MIN_PLAYERS && (
                  <div style={{ marginTop: 10, flexShrink: 0 }}>
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700,
                      padding: "4px 12px", borderRadius: 999, background: "rgba(212,160,44,0.16)",
                      border: "1px solid rgba(212,160,44,0.45)", color: "var(--amber, #d4a02c)", letterSpacing: "0.02em",
                    }}>En az {MIN_PLAYERS} oyuncu gerekli — {MIN_PLAYERS - players.length} bekleniyor</span>
                  </div>
                )}
              </div>

              {/* ══ ORTA KART: kod + davet + ayarlar + start ══ */}
              <div className="duel-lobby-card wgg-middle-card">
                <div style={{ textAlign: "center", flexShrink: 0 }}>
                  <div style={{
                    display: "inline-block", fontSize: 10, fontWeight: 800, letterSpacing: "0.14em",
                    textTransform: "uppercase", padding: "3px 12px", borderRadius: 999, marginBottom: 8,
                    background: isHost ? "rgba(79,139,255,0.14)" : "rgba(58,165,93,0.14)",
                    border: isHost ? "1px solid rgba(79,139,255,0.35)" : "1px solid rgba(58,165,93,0.35)",
                    color: isHost ? "var(--accent, #4f8bff)" : "var(--green, #3aa55d)",
                  }}>{isHost ? "Oda Hazır" : "Odaya Katıldın"}</div>
                  <div style={{ fontSize: 40, fontWeight: 900, letterSpacing: "0.18em", fontFamily: "monospace" }}>{room.code}</div>
                  <div style={{ fontSize: 12, opacity: 0.5, marginTop: 5 }}>Kodu arkadaşlarına ver</div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                  <LobbyInviteBar inviteMessage={inviteMessage} shareLink={shareLink} roomCode={room.code}
                    mode="flagGroup" roomUrl={`/?flagGroup=${room.code}`} />
                  <div onClick={e => { const el = (e.currentTarget as HTMLElement).querySelector("input"); el?.select(); }}>
                    <input className="duel-link-input" readOnly value={shareLink} onFocus={e => e.target.select()}
                      style={{ width: "100%", boxSizing: "border-box" }} />
                  </div>
                </div>

                <section aria-label="Oda Ayarları" style={{
                  display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, padding: "10px 12px",
                  background: "rgba(10,18,32,0.55)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, boxSizing: "border-box", flexShrink: 0,
                }}>
                  <div className="duel-select-wrap" style={{ minWidth: 0, gap: 3 }}>
                    <label className="duel-select-label" style={{ fontSize: "0.62rem" }}>🎯 Tur</label>
                    <div className="duel-select-box">
                      <select className="duel-select" value={room.total_rounds} disabled={!isHost}
                        onChange={e => updateRoomSettings({ total_rounds: Number(e.target.value) })}
                        style={{ height: 34, fontSize: 12.5, padding: "0 26px 0 10px", opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}>
                        {ROUND_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <span className="duel-select-caret">▾</span>
                    </div>
                  </div>
                  <div className="duel-select-wrap" style={{ minWidth: 0, gap: 3 }}>
                    <label className="duel-select-label" style={{ fontSize: "0.62rem" }}>🌍 Bölge</label>
                    <div className="duel-select-box">
                      <select className="duel-select" value={denormalizeRegion(room.region)} disabled={!isHost}
                        onChange={e => updateRoomSettings({ region: normalizeRegion(e.target.value) })}
                        style={{ height: 34, fontSize: 12.5, padding: "0 26px 0 10px", opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}>
                        {REGION_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <span className="duel-select-caret">▾</span>
                    </div>
                  </div>
                  <div className="duel-select-wrap" style={{ minWidth: 0, gap: 3 }}>
                    <label className="duel-select-label" style={{ fontSize: "0.62rem" }}>👥 Maks</label>
                    <div className="duel-select-box">
                      <select className="duel-select" value={room.max_players} disabled={!isHost}
                        onChange={e => updateRoomSettings({ max_players: Number(e.target.value) })}
                        style={{ height: 34, fontSize: 12.5, padding: "0 26px 0 10px", opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}>
                        {[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>{n} kişi</option>)}
                      </select>
                      <span className="duel-select-caret">▾</span>
                    </div>
                  </div>
                </section>

                <div style={{ flex: 1 }} />

                <div style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
                  {isHost ? (
                    <button className={canStart ? "btn btn-accent" : "btn btn-ghost"} onClick={startGame} disabled={!canStart}
                      title={canStart ? "Oyunu başlat" : startBlockReason}
                      style={{ width: "100%", minHeight: 44, fontSize: 15, fontWeight: 800, borderRadius: 12, opacity: canStart ? 1 : 0.65, cursor: canStart ? "pointer" : "not-allowed", boxSizing: "border-box" }}>
                      🚀 Oyunu Başlat ({players.length} kişi)
                    </button>
                  ) : (
                    <p className="duel-waiting-msg" style={{ margin: 0, textAlign: "center" }}>Ev sahibi oyunu başlatacak...</p>
                  )}
                  {isHost && !canStart && startBlockReason && (
                    <p className="duel-waiting-msg" style={{ margin: 0, textAlign: "center", fontSize: 12 }}>{startBlockReason}</p>
                  )}
                  <button className="btn btn-ghost" onClick={() => leaveRoom("lobby")}
                    style={{ width: "100%", minHeight: 44, fontSize: 14, fontWeight: 700, borderRadius: 12, opacity: 0.85, boxSizing: "border-box" }}>
                    ← Lobiden Çık
                  </button>
                </div>
                {errorMsg && <p className="duel-error" style={{ flexShrink: 0 }}>{errorMsg}</p>}
              </div>

              {/* ══ SAĞ KART: Sohbet (oda-izole, gerçek zamanlı) ══ */}
              <div className="wgg-chat-card">
                <LobbyChat
                  /* Namespaced anahtar: modlar arası room_code çakışmasına karşı
                     izolasyon. Geçmiş sorgusu + Realtime kanalı + send RPC hepsi
                     "flag_group:<code>" kullanır; server bu anahtarı doğrular. */
                  roomCode={chatRoomKey(room.code)}
                  playerName={(myPlayer?.name ?? effectivePlayerName).trim()}
                  mobileSheetOpen={chatSheetOpen}
                  onMobileSheetOpenChange={v => { setChatSheetOpen(v); if (v) setPlayersSheetOpen(false); }}
                  hideMobileFab={chatSheetOpen || playersSheetOpen}
                  sendMode="flag_group"
                  playerId={myIdRef.current}
                  claimToken={claimTokenRef.current}
                />
              </div>
            </div>
          </div>

          {/* ════ MOBİL: Oyuncular FAB — herhangi bir sheet açıkken gizle ════ */}
          {!chatSheetOpen && !playersSheetOpen && (
            <button
              type="button"
              className="wgg-players-fab"
              aria-label="Oyuncuları aç"
              onClick={() => { setPlayersSheetOpen(true); setChatSheetOpen(false); }}
            >
              <span>👥</span>
              <span>Oyuncular</span>
              <span className="wgg-players-fab-badge">{players.length}/{room.max_players}</span>
            </button>
          )}

          {/* ════ MOBİL: Oyuncular bottom-sheet ════ */}
          {playersSheetOpen && (
            <div className="wgg-ps-backdrop" onClick={() => setPlayersSheetOpen(false)}>
              <div className="wgg-ps-sheet" onClick={e => e.stopPropagation()}>
                <div className="wgg-ps-handle" />
                <header className="wgg-ps-header">
                  <span className="wgg-ps-title">
                    <span>👥</span>
                    <span>Oyuncular</span>
                  </span>
                  <span className="wgg-max-badge wgg-max-badge--sheet" aria-label="Oyuncu sayısı">
                    {players.length}/{room.max_players}
                  </span>
                  <button type="button" className="wgg-ps-close" onClick={() => setPlayersSheetOpen(false)} aria-label="Kapat">✕</button>
                </header>
                <div className="wgg-ps-list">
                  {renderFlagSlots(true)}
                </div>
                {players.length < MIN_PLAYERS && (
                  <div className="wgg-ps-warning">
                    En az {MIN_PLAYERS} oyuncu gerekli — {MIN_PLAYERS - players.length} bekleniyor
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════ PLAYING ════════ */}
      {phase === "playing" && room && (
        <div className="fgg-play-shell">
          {flagTopBar}
          <div className="control-bar">
            <div className="bar-row bar-top">
              {/* ← Menü üst bara taşındı (flagTopBar); çift buton olmasın. */}
              <div className="bar-dropdowns" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="duel-region-badge">{regionLabel}</span>
                <span className="duel-code-badge">Tur {room.current_round}/{room.total_rounds}</span>
              </div>
              <div className="bar-right" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="score-pill" title="Skorun">
                  <span className="score-n">{myScore}</span>
                  <span className="score-lbl">tur</span>
                </div>
                <div className="timer-ring-wrap">
                  <svg viewBox="0 0 42 42" className="timer-svg">
                    <circle cx="21" cy="21" r="17" fill="none" stroke="var(--border)" strokeWidth="3" />
                    <circle cx="21" cy="21" r="17" fill="none" stroke={timerColor} strokeWidth="3"
                      strokeDasharray="106.8" strokeDashoffset={106.8 - (timerPct / 100) * 106.8} strokeLinecap="round"
                      style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%", transition: "stroke-dashoffset 0.9s linear, stroke 0.4s" }} />
                  </svg>
                  <span className="timer-num" style={{ color: timerColor }}>{timeLeft}</span>
                </div>
              </div>
            </div>

            <div className={["bar-row bar-input", feedback ?? ""].filter(Boolean).join(" ")}>
              <input ref={inputRef} type="text" className="guess-input"
                placeholder={roundResolved ? "Sıradaki tur…" : "Bu bayrağın ülkesi? (Enter)"}
                value={input} disabled={!isPlaying} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleGuess(); }}
                autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
              {isPlaying && <button className="btn btn-accent" onClick={handleGuess}>Gir</button>}
            </div>

            <div className="bar-row bar-bottom">
              <div className="feedback-slot">
                {feedback === "correct" && <span className="fb fb-ok">✓ Doğru! Turu aldın.</span>}
                {feedback === "wrong" && <span className="fb fb-no">✗ Yanlış cevap</span>}
                {feedback === "dup" && <span className="fb fb-dup">Başka oyuncu önce bildi</span>}
              </div>
            </div>
          </div>

          {/* ── Pas Geç aksiyon şeridi ──
              Konum (Bayrak 1v1 .pas-gec-bar referansı): ipucu/durum satırının
              (control-bar) HEMEN ALTINDA, bayrak sahnesinin ÜSTÜNDE ayrı tam-
              genişlik şerit. Buton solda; sağ taraf zorunlu kontrol olmadığı
              için sade. Scoped .fgg-pass-* class'ları (1v1 görünümünü taklit
              eder). Çoğunluk (floor(N/2)+1) oluşunca server turu paslar —
              client yalnız oyu toggle eder. */}
          {isPlaying && (
            <div className="fgg-pass-bar">
              <button
                type="button"
                className={"fgg-pass-btn" + (iVotedPass ? " fgg-pass-btn--voted" : "")}
                onClick={togglePass}
                disabled={passPending}
                aria-pressed={iVotedPass}
                title={iVotedPass ? "Pas oyunu geri çek" : "Yeterli oyuncu pas derse tur atlanır"}
              >
                <span aria-hidden="true">⏭️</span>
                Pas Geç {passVoteCount}/{passRequired}
              </button>
              {/* ESC klavye ipucu (Bayrak 1v1 .pas-gec-hint paritesi) */}
              <span className="fgg-pass-hint" aria-hidden="true">ESC</span>
              {passVoteCount > 0 && !iVotedPass && (
                <span className="fgg-pass-note">Oylama sürüyor…</span>
              )}
            </div>
          )}

          {/* ── Ana oyun sahnesi ──
              Simetrik 3-kolon grid ([boş denge] · [bayrak] · [skor paneli]):
              bayrak GERÇEK viewport merkezinde durur; skor paneli sağ kolonda
              olduğu için merkezi sola İTEMEZ. Layout .fgg-play-area'ya scope'lu
              (1v1/solo `.flag-area`'yı paylaşır ama etkilemez). */}
          <div className="flag-area fgg-play-area">
            {currentFlag && (
              <div className="flag-stage">
                <div className="flag-meta-row">
                  <span className="flag-progress">{room.current_round} / {room.total_rounds}</span>
                  <span className="flag-diff-pill" style={{ background: "rgba(99,102,241,.13)", borderColor: "var(--accent)", color: "var(--accent)" }}>{regionLabel}</span>
                </div>
                <div className="flag-img-wrap">
                  {imgError ? (
                    <div className="flag-fallback">
                      <span className="flag-fallback-code">{currentFlag.code.toUpperCase()}</span>
                      <span className="flag-fallback-hint">Bayrak yüklenemedi</span>
                    </div>
                  ) : (
                    <img key={currentFlag.code + ":" + room.current_round} src={flagSrc} alt="Bayrak" className="flag-img" onError={() => setImgError(true)} />
                  )}
                </div>
                {roundResolved ? (
                  roundAnswered ? (
                    <div className={`skip-answer-reveal ${iAnswered ? "skip-answer-reveal--ok" : "skip-answer-reveal--no"}`}>
                      <span className="skip-label">{iAnswered ? "✓ Sen bildin:" : `✓ ${winnerName} bildi:`}</span>
                      <span className="skip-country">{currentFlag.display}</span>
                    </div>
                  ) : roundPassed ? (
                    <div className="skip-answer-reveal skip-answer-reveal--timeout">
                      <span className="skip-label">⏭️ Tur paslandı! Cevap:</span>
                      <span className="skip-country">{currentFlag.display}</span>
                    </div>
                  ) : (
                    <div className="skip-answer-reveal skip-answer-reveal--timeout">
                      <span className="skip-label">⏰ Süre doldu! Cevap:</span>
                      <span className="skip-country">{currentFlag.display}</span>
                    </div>
                  )
                ) : (
                  <p className="flag-prompt">Bu bayrağın ülkesi nedir?</p>
                )}
              </div>
            )}

            {/* Canlı skor tablosu (içerik/sıralama mantığı aynı; yalnız görsel
                kabuk .fgg-score-* sınıflarına taşındı). */}
            <aside className="fgg-score-panel" aria-label="Canlı skor tablosu">
              <div className="fgg-score-head">🏆 Skor</div>
              <div className="fgg-score-list">
                {leaderboard.map(row => (
                  <div
                    key={row.playerId}
                    className={"fgg-score-row" + (row.playerId === myId ? " fgg-score-row--me" : "")}
                  >
                    <span className="fgg-score-rank">{row.rank}.</span>
                    <span className="fgg-score-name">{row.name}</span>
                    <span className="fgg-score-val">{row.score}</span>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </div>
      )}

      {/* ════════ FINISHED (SONUÇ) ════════ */}
      {phase === "finished" && room && (() => {
        const board = finalLeaderboard ?? leaderboard;
        const { winnerIds, isTie } = resolveWinners(board);
        const iWon = winnerIds.includes(myId);
        const title = winnerIds.length === 0 ? "Berabere!"
          : isTie ? "Berabere!"
          : iWon ? "Kazandın! 🏆"
          : `${board.find(r => winnerIds.includes(r.playerId))?.name ?? "Bir oyuncu"} kazandı`;
        const emoji = winnerIds.length === 0 || isTie ? "🤝" : iWon ? "🏆" : "🎯";
        return (
          <div className="wheel-result-backdrop">
            <div className="duel-result-card" style={{ maxWidth: 460, width: "100%" }}>
              <div className="duel-result-emoji" style={{ textAlign: "center" }}>{emoji}</div>
              <h2 className="duel-result-title" style={{ textAlign: "center" }}>{title}</h2>

              <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "14px 0", maxHeight: 300, overflowY: "auto" }}>
                {board.map(row => {
                  const p = players.find(pl => pl.id === row.playerId);
                  const isMe = row.playerId === myId;
                  return (
                    <div key={row.playerId} style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 10,
                      background: isMe ? "rgba(79,139,255,0.12)" : "rgba(255,255,255,0.03)",
                      border: winnerIds.includes(row.playerId) ? "1px solid rgba(212,160,44,0.5)" : "1px solid rgba(255,255,255,0.06)",
                    }}>
                      <span style={{ width: 22, fontSize: 15, fontWeight: 800, opacity: 0.7 }}>{row.rank}.</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: isMe ? 800 : 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.name}{isMe ? " (sen)" : ""}
                        {winnerIds.includes(row.playerId) && " 👑"}
                      </span>
                      {p && p.status !== "waiting"
                        ? <span style={{ fontSize: 10.5, color: "var(--amber, #d4a02c)" }}>Sonuç ekranında</span>
                        : <span style={{ fontSize: 10.5, color: "var(--green, #3aa55d)" }}>Lobide</span>}
                      <span style={{ fontSize: 16, fontWeight: 800, color: "var(--accent)" }}>{row.score}</span>
                    </div>
                  );
                })}
              </div>

              <div className="fgg-result-actions">
                {returned ? (
                  <p className="duel-waiting-msg fgg-result-note">Lobiye dönüldü — diğer oyuncular bekleniyor…</p>
                ) : (
                  <button className="btn btn-accent fgg-result-btn" onClick={returnToLobby}>
                    ↩️ Lobiye Dön
                  </button>
                )}
                <button className="btn btn-ghost fgg-result-btn" onClick={() => leaveRoom("home")} style={{ opacity: 0.85 }}>
                  🏠 Ana Menü
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ════════ QUIT MODAL (playing) ════════ */}
      {quitModal && (
        <div className="wheel-result-backdrop" onClick={() => setQuitModal(false)}>
          <div className="duel-result-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 380, textAlign: "center" }}>
            <div className="duel-result-emoji">🚪</div>
            <h2 className="duel-result-title">Oyundan çık?</h2>
            <p className="duel-lobby-desc">Oyundan ayrılırsan diğer oyuncular devam eder.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
              <button className="btn btn-ghost" onClick={() => { setQuitModal(false); leaveRoom("lobby"); }}>Lobiye Dön</button>
              <button className="btn btn-ghost" onClick={() => { setQuitModal(false); leaveRoom("home"); }}>Ana Menü</button>
              <button className="btn btn-accent" onClick={() => setQuitModal(false)}>Devam Et</button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ KICK CONFIRM ════════ */}
      {kickTarget && (
        <div className="wheel-result-backdrop" onClick={() => setKickTarget(null)}>
          <div className="duel-result-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 380, textAlign: "center" }}>
            <div className="duel-result-emoji">👋</div>
            <h2 className="duel-result-title">Oyuncuyu çıkar?</h2>
            <p className="duel-lobby-desc"><strong>{kickTarget.name}</strong> odadan çıkarılacak.</p>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setKickTarget(null)}>Vazgeç</button>
              <button className="btn btn-accent" style={{ flex: 1 }} onClick={() => kickPlayer(kickTarget.id)}>Çıkar</button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ KICKED NOTICE ════════ */}
      {kickedNoticeOpen && (
        <div className="wheel-result-backdrop" onClick={() => setKickedNoticeOpen(false)}>
          <div className="duel-result-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 380, textAlign: "center" }}>
            <div className="duel-result-emoji">🚫</div>
            <h2 className="duel-result-title">Odadan çıkarıldın</h2>
            <p className="duel-lobby-desc">Oda sahibi tarafından odadan çıkarıldın.</p>
            <button className="btn btn-accent" style={{ marginTop: 12 }} onClick={() => setKickedNoticeOpen(false)}>Tamam</button>
          </div>
        </div>
      )}

      {/* ════════ ROOM CLOSED NOTICE ════════ */}
      {roomClosedNoticeOpen && (
        <div className="wheel-result-backdrop" onClick={() => setRoomClosedNoticeOpen(false)}>
          <div className="duel-result-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 380, textAlign: "center" }}>
            <div className="duel-result-emoji">🔒</div>
            <h2 className="duel-result-title">Oda kapatıldı</h2>
            <p className="duel-lobby-desc">Oda sahibi ayrıldığı için oda kapatıldı.</p>
            <button className="btn btn-accent" style={{ marginTop: 12 }} onClick={() => setRoomClosedNoticeOpen(false)}>Tamam</button>
          </div>
        </div>
      )}
    </div>
  );
}
