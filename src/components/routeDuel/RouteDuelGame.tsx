/**
 * RouteDuelGame.tsx — Rota Modu · Online 1v1 orkestratörü.
 *
 * Sunucu-otoriter multiplayer (migration: 20260802120000_route_duel_init.sql):
 *   • Rota üretimi, komşuluk doğrulaması, tur süresi, ilk-bitiren claim'i,
 *     skor, tur ilerletme, kazanan, rövanş reset — HEPSİ RPC'lerde.
 *   • Client yalnız: durum yansıtma (realtime), optimistic hamle + geri sarma,
 *     zamanlayıcı GÖSTERİMİ (getSyncedNowMs) ve tetikleyiciler (advance /
 *     request_rematch / handle_disconnect — hepsi sunucuda yeniden doğrulanır).
 *   • Rövanş TEK RPC: route_duel_request_rematch oy kaydeder ve İKİNCİ ONAYDA
 *     yeni maçı sunucuda atomik başlatır — host client'ında ayrıca bir
 *     "process" adımı YOK (host arka planda/kopuk olsa bile rövanş başlar).
 *
 * Faz akışı (WheelDuelGame modeli):
 *   setup → creating → lobby → playing → finished  (+ searching: Hızlı Eşleş)
 *
 * Realtime: oda-özel tek kanal (route-duel:<roomId>); room UPDATE/DELETE +
 * players '*' → refetch. Unmount/oda değişiminde kanal kaldırılır; StrictMode
 * remount'unda effect cleanup'ı duplicate aboneliği engeller.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Profile } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { playSound } from "../../lib/sound";
import { useInviteJoin } from "../../lib/useInviteJoin";
import { getSyncedNowMs, initServerClockSync } from "../../lib/serverClock";
import { readStoredHomeTheme, getThemeBackgroundStyle } from "../../lib/themeBackgrounds";
import { useRosterProfiles } from "../../lib/useRosterProfiles";
import { useSocialOptional } from "../SocialContext";
import { buildKeyToTopoId } from "../RouteGame";
import RouteDuelLobby from "./RouteDuelLobby";
import RouteDuelPlay, { type RouteDuelMoveResult } from "./RouteDuelPlay";
import RouteDuelResult from "./RouteDuelResult";
import {
  ROUTE_DUEL_ROUND_OPTIONS,
  ROUTE_DUEL_LENGTH_OPTIONS,
  describeRouteDuelRpcError,
  generateRouteDuelRoomCode,
  roundsLabel,
  routeLengthLabel,
  type RouteDuelLength,
  type RouteDuelRoom,
  type RouteDuelPlayer,
} from "../../lib/routeDuelShared";
import {
  ROUTE_DUEL_HEARTBEAT_MS,
  ROUTE_DUEL_OPP_POLL_MS,
  attachHeartbeatWakeups,
  computeOppStaleSeconds,
  isRouteDuelPresencePhase,
  parseServerTimestampMs,
  shouldRequestDisconnect,
} from "../../lib/routeDuelConnection";

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS & HELPERS
═══════════════════════════════════════════════════════════════ */

type Phase = "setup" | "creating" | "searching" | "lobby" | "playing" | "finished";

const PLAYER_ID_KEY = "torble_route_duel_player_id";
const ROOM_KEY = "torble_route_duel_room";
const CLAIM_TOKEN_KEY = "torble_route_duel_claim_token";

/** Tur sonucu banner'ının ekranda kalma süresi; sonrasında host advance eder. */
const ROUND_RESULT_MS = 3200;
/** Host advance edemezse (takıldı/koptu) diğer oyuncunun güvenlik-ağı gecikmesi. */
const ADVANCE_FALLBACK_MS = 8000;
/** Timeout turunda deadline sonrası advance gecikmesi (banner kısa görünür). */
const TIMEOUT_ADVANCE_MS = 1600;
/* Bağlantı göstergesi + kopuş-isteği eşikleri routeDuelConnection.ts'te
 * (saf/testli): amber "Bağlantı zayıf…" 12 sn (4 kaçırılmış beat), sunucu
 * kontrolü isteği 20 sn. KIRMIZI "Bağlantı koptu" yalnız sunucu onayıyla
 * (finished_reason='disconnect') — yaş tek başına asla kırmızı üretmez. */

const QUICK_MATCH_TICK_MS = 3000;

function quickMatchBracket(searchSeconds: number): number {
  if (searchSeconds < 10) return 0;
  if (searchSeconds < 20) return 2;
  if (searchSeconds < 30) return 5;
  if (searchSeconds < 60) return 15;
  return 9999;
}

function freshUuid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function freshPlayerId(): string {
  const id = freshUuid();
  try { localStorage.setItem(PLAYER_ID_KEY, id); } catch { /* best effort */ }
  return id;
}

function freshClaimToken(): string {
  const tok = freshUuid();
  try { localStorage.setItem(CLAIM_TOKEN_KEY, tok); } catch { /* best effort */ }
  return tok;
}

function clearRouteDuelSession() {
  try {
    localStorage.removeItem(PLAYER_ID_KEY);
    localStorage.removeItem(ROOM_KEY);
    localStorage.removeItem(CLAIM_TOKEN_KEY);
  } catch { /* best effort */ }
}

function saveRoomSession(roomId: string, roomCode: string, playerId: string) {
  try {
    localStorage.setItem(ROOM_KEY, JSON.stringify({ roomId, roomCode, playerId }));
  } catch { /* best effort */ }
}

function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function validateName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return "Oyuncu adı en az 2 karakter olmalı.";
  if (trimmed.length > 16) return "Oyuncu adı en fazla 16 karakter olabilir.";
  return null;
}

/* ═══════════════════════════════════════════════════════════════
   COMPONENT
═══════════════════════════════════════════════════════════════ */

interface Props {
  onHome: () => void;
  profile: Profile | null;
  /** Hızlı Eşleş auto-start: App intent'i taşır (Tur + Rota Uzunluğu). */
  autoQuickMatch?: { rounds?: number; routeLength?: string } | null;
  onQuickMatchConsumed?: () => void;
}

export default function RouteDuelGame({
  onHome,
  profile,
  autoQuickMatch = null,
  onQuickMatchConsumed,
}: Props) {
  const keyToTopoId = useMemo(buildKeyToTopoId, []);

  const [phase, setPhase] = useState<Phase>("setup");

  /* ── Setup form ── */
  const [playerName, setPlayerName] = useState<string>(profile?.username ?? "");
  const [hostRounds, setHostRounds] = useState<number>(() => {
    const r = autoQuickMatch?.rounds;
    return ROUTE_DUEL_ROUND_OPTIONS.some(o => o.value === r) ? (r as number) : 5;
  });
  const [hostLength, setHostLength] = useState<RouteDuelLength>(() => {
    const l = autoQuickMatch?.routeLength;
    return ROUTE_DUEL_LENGTH_OPTIONS.some(o => o.value === l) ? (l as RouteDuelLength) : "7";
  });
  /* Ayarların ref aynası: quickMatchTick interval closure'ı state'i DEĞİL bunu
   * okur — sonuç ekranından "Hızlı Eşleş" (oda ayarlarıyla yeniden kuyruk)
   * setState flush'unu beklemeden doğru değerlerle arar. State yalnız UI için. */
  const hostRoundsRef = useRef(hostRounds);
  const hostLengthRef = useRef(hostLength);
  const applyHostRounds = (v: number) => { hostRoundsRef.current = v; setHostRounds(v); };
  const applyHostLength = (v: RouteDuelLength) => { hostLengthRef.current = v; setHostLength(v); };

  const [joinCode, setJoinCode] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [hostClosedRoom, setHostClosedRoom] = useState(false);

  const inviteOverrideCodeRef = useRef<string | null>(null);
  const inviteOverrideNameRef = useRef<string | null>(null);

  /* ── Oda state ── */
  const [room, setRoom] = useState<RouteDuelRoom | null>(null);
  const [players, setPlayers] = useState<RouteDuelPlayer[]>([]);
  const roomRef = useRef<RouteDuelRoom | null>(null);
  useEffect(() => { roomRef.current = room; }, [room]);

  const myIdRef = useRef<string>("");
  const myClaimTokenRef = useRef<string>("");

  const isHost = !!room && room.host_player_id === myIdRef.current;
  const me = players.find(p => p.id === myIdRef.current);
  const opp = players.find(p => p.id !== myIdRef.current);

  const rosterProfiles = useRosterProfiles(players.map(p => p.profile_id ?? null));
  const social = useSocialOptional();
  useEffect(() => {
    if (!social) return;
    const code = room?.code;
    if (code) social.setRoomContext({ code, mode: "routeDuel", roomUrl: `/?routeDuel=${code}` });
    return () => social.setRoomContext(null);
  }, [social, room?.code]);

  /* ── Quit modal (yalnız aktif maçta) ── */
  const [quitModal, setQuitModal] = useState(false);
  useEffect(() => {
    if (phase !== "playing") setQuitModal(false);
  }, [phase]);

  /* ── Rakip presence (sunucu satırından; karar sunucuda) ── */
  const [oppStaleSeconds, setOppStaleSeconds] = useState<number | null>(null);

  /* ── Rövanş lokal bayrağı (lost-vote retry) ── */
  const [iRequestedRematchLocally, setIRequestedRematchLocally] = useState(false);

  /* ── Quick match ── */
  const [searchSeconds, setSearchSeconds] = useState(0);
  const quickMatchTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const quickMatchSecondsRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const quickMatchStartMsRef = useRef(0);
  const quickMatchAbortRef = useRef(false);
  const quickMatchJoinedRef = useRef(false);

  /* ── Sonuç sesi (maç başına bir kez) ── */
  const resultSoundPlayedRef = useRef(false);

  /* ═══════════════ DAVET LİNKİ ═══════════════ */
  useInviteJoin({
    paramKey: "routeDuel",
    setJoinCode,
    canAutoJoin: !!profile?.username && phase === "setup" && !room,
    triggerJoin: code => {
      inviteOverrideCodeRef.current = code;
      inviteOverrideNameRef.current = profile?.username ?? null;
      void joinRoomByCode();
    },
  });

  const shareLink = useMemo(() => {
    if (!room) return "";
    const url = new URL(window.location.href);
    for (const p of ["duel", "duelGroup", "flagDuel", "flagGroup", "wheelDuel", "wheelGroup"]) {
      url.searchParams.delete(p);
    }
    url.searchParams.set("routeDuel", room.code);
    return url.toString();
  }, [room]);

  const inviteMessage = useMemo(() => {
    if (!room) return "";
    return (
      `Torble'da Rota Modu Online 1v1 oynayalım! 🧭\n` +
      `${roundsLabel(room.total_rounds)} · ${routeLengthLabel(room.route_length)}\n` +
      `Aynı rotada yarışıyoruz: hedef ülkeye komşu ülkelerden ilerleyerek İLK ulaşan turu kazanır.\n` +
      `Katılmak için tıkla:\n${shareLink}`
    );
  }, [room, shareLink]);

  /* ═══════════════ REALTIME: oda + oyuncular ═══════════════ */
  useEffect(() => {
    if (!room) return;
    const roomId = room.id;
    const hostIdAtSubscribe = room.host_player_id;

    const chan = supabase
      .channel(`route-duel:${roomId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "route_duel_rooms", filter: `id=eq.${roomId}` },
        payload => {
          const r = payload.new as RouteDuelRoom;
          setRoom(r);
          if (r.status === "playing") {
            setPhase(prev => (prev === "playing" ? prev : "playing"));
          }
          if (r.status === "finished") {
            setPhase("finished");
          }
          if (r.status === "waiting") {
            setPhase(prev => (prev === "lobby" ? prev : "lobby"));
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "route_duel_rooms", filter: `id=eq.${roomId}` },
        () => {
          // Host odayı kapattı → misafir setup'a döner + bilgi modalı.
          if (myIdRef.current !== hostIdAtSubscribe) {
            setHostClosedRoom(true);
            setRoom(null);
            setPlayers([]);
            clearRouteDuelSession();
            setPhase("setup");
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "route_duel_players", filter: `room_id=eq.${roomId}` },
        () => {
          void supabase
            .from("route_duel_players")
            .select("*")
            .eq("room_id", roomId)
            .order("joined_at", { ascending: true })
            .then(({ data }) => {
              if (data) setPlayers(data as RouteDuelPlayer[]);
            });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(chan);
    };
  }, [room?.id]);

  /* ═══════════════ SERVER-CLOCK SYNC ═══════════════ */
  useEffect(() => {
    if (phase !== "searching" && phase !== "lobby" && phase !== "playing" && phase !== "finished") return;
    const handle = initServerClockSync();
    return () => handle.dispose();
  }, [phase]);

  /* ═══════════════ HEARTBEAT (oda üyeliği boyunca; 3 sn) ═══════════════
     Faz DEĞİL üyelik bazlı: lobby → playing → finished boyunca KESİNTİSİZ
     (presenceActive boolean'ı fazlar arasında true kaldığı için effect
     yeniden kurulmaz → interval kopmaz, duplicate de oluşmaz). Tur-sonu
     banner'ı/faz overlay'leri fazı değiştirmez; beat zaten sürer.
     visibilitychange/focus/online dönüşünde interval beklenmeden ANINDA
     beat atılır (arka plandan dönen sekme rakibe stale görünmesin). */
  const presenceActive = isRouteDuelPresencePhase(phase) && !!room;
  useEffect(() => {
    if (!presenceActive) return;
    const beat = () => {
      void supabase.rpc("route_duel_heartbeat", {
        p_player_id: myIdRef.current,
        p_claim_token: myClaimTokenRef.current,
      });
    };
    beat();
    const id = setInterval(beat, ROUTE_DUEL_HEARTBEAT_MS);
    const detachWakeups = attachHeartbeatWakeups(beat, document, window);
    return () => {
      clearInterval(id);
      detachWakeups();
    };
  }, [presenceActive, room?.id]);

  /* ═══════════════ RAKİP MONİTÖRÜ (playing; 3 sn poll) ═══════════════
     DuelGame deseni: realtime'a ek olarak rakip last_seen_at'i doğrudan
     SELECT'le okunur (realtime kanalı düşse bile presence akar) — lokal
     Realtime channel status'u ASLA rakip bağlantısı sayılmaz. İKİ satır
     birden okunur: kendi last_seen_at'im sunucu-saat çıpasıdır (lokal saat
     kayması sahte "koptu" üretemez; hesap routeDuelConnection.ts'te, testli).
     SELECT hatasında önceki değer korunur (kendi ağ hıçkırığım rakibi
     "koptu"ya düşürmez). Eşik aşılırsa handle_disconnect İSTENİR; kararı
     sunucu verir (RPC içindeki 20 sn guard). */
  useEffect(() => {
    if (phase !== "playing" || !room) return;
    const roomId = room.id;
    let cancelled = false;

    const tick = async () => {
      const { data } = await supabase
        .from("route_duel_players")
        .select("id, last_seen_at")
        .eq("room_id", roomId);
      if (cancelled || !data) return;

      const rows = data as Pick<RouteDuelPlayer, "id" | "last_seen_at">[];
      const oppRow = rows.find(r => r.id !== myIdRef.current);
      if (!oppRow) return;
      const myRow = rows.find(r => r.id === myIdRef.current);

      const stale = computeOppStaleSeconds({
        oppLastSeenMs: parseServerTimestampMs(oppRow.last_seen_at),
        myLastSeenMs:  myRow ? parseServerTimestampMs(myRow.last_seen_at) : null,
        syncedNowMs:   getSyncedNowMs(),
      });
      setOppStaleSeconds(stale);

      if (shouldRequestDisconnect(stale)) {
        // Sunucu doğrular: eşik dolmadıysa no-op olarak playing oda döner ve
        // gösterge amber'da kalır; dolduysa maçı kalan oyuncu lehine bitirir.
        // Onaylı oda satırı (finished_reason='disconnect') RPC dönüşünden de
        // yakalanır — realtime UPDATE gecikse/düşse bile kırmızı+sonuç ekranı
        // sunucu kararıyla birlikte gelir, asla ondan önce değil.
        void supabase
          .rpc("route_duel_handle_disconnect", {
            p_room_id: roomId,
            p_player_id: myIdRef.current,
            p_claim_token: myClaimTokenRef.current,
          })
          .then(({ data }) => {
            if (cancelled) return;
            const r = data as RouteDuelRoom | null;
            if (r?.id && r.status === "finished") {
              setRoom(r);
              setPhase("finished");
            }
          });
      }
    };

    void tick();
    const id = setInterval(() => void tick(), ROUTE_DUEL_OPP_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      setOppStaleSeconds(null);
    };
  }, [phase, room?.id]);

  /* ═══════════════ TUR İLERLETME TETİKLEYİCİSİ ═══════════════
     Sunucu kuralı: advance yalnız tur bittiyse çalışır (kazanan VAR ya da
     deadline geçti) — erken atlama sunucuda imkânsız. Host birincil
     tetikleyici; host takılırsa diğer oyuncu gecikmeli güvenlik ağı.
     Çift çağrı zararsız (ikincisi 'round_not_over' alır). */
  const advanceInFlightRef = useRef(false);
  useEffect(() => {
    if (phase !== "playing" || !room) return;
    advanceInFlightRef.current = false;

    const check = () => {
      const r = roomRef.current;
      if (!r || r.status !== "playing") return;
      if (advanceInFlightRef.current) return;

      const now = getSyncedNowMs();
      const deadlineMs = r.round_deadline ? new Date(r.round_deadline).getTime() : 0;
      const decidedMs = r.round_decided_at ? new Date(r.round_decided_at).getTime() : 0;
      const amHost = r.host_player_id === myIdRef.current;

      let due = false;
      if (r.round_winner_player_id && decidedMs > 0) {
        const wait = amHost ? ROUND_RESULT_MS : ROUND_RESULT_MS + ADVANCE_FALLBACK_MS;
        due = now >= decidedMs + wait;
      } else if (deadlineMs > 0 && now >= deadlineMs) {
        const wait = amHost ? TIMEOUT_ADVANCE_MS : TIMEOUT_ADVANCE_MS + ADVANCE_FALLBACK_MS;
        due = now >= deadlineMs + wait;
      }
      if (!due) return;

      advanceInFlightRef.current = true;
      void supabase
        .rpc("route_duel_advance_round", {
          p_room_id: r.id,
          p_player_id: myIdRef.current,
          p_claim_token: myClaimTokenRef.current,
        })
        .then(({ error }) => {
          // 'round_not_over' / yarış kaybı sessiz geçilir; yeni tur realtime
          // room UPDATE ile gelir ve effect (deps) yeniden kurulur.
          if (error && !(error.message ?? "").includes("round_not_over")) {
            console.error("[RouteDuel] advance_round failed", error);
          }
          advanceInFlightRef.current = false;
        });
    };

    const id = setInterval(check, 400);
    return () => clearInterval(id);
  }, [phase, room?.id, room?.game_seq, room?.current_round]);

  /* ═══════════════ RÖVANŞ ═══════════════
     TEK RPC: oy + (ikinci onayda) sunucuda ATOMİK yeni maç. Host client'ının
     ayrıca process etmesi GEREKMEZ — host sekmesi arka planda ya da kopuk
     olsa bile guest'in ikinci onayı rövanşı sunucuda başlatır. RPC güncel oda
     satırını döndürür (anında geçiş); diğer oyuncu aynı sunucu state'ini
     realtime room UPDATE ile görür. */
  const requestRematch = useCallback(async () => {
    const r = roomRef.current;
    if (!r || r.status !== "finished") return;
    if ((r.rematch_requested_by ?? []).includes(myIdRef.current)) {
      setIRequestedRematchLocally(true);
      return;
    }
    setIRequestedRematchLocally(true);
    const { data, error } = await supabase.rpc("route_duel_request_rematch", {
      p_room_id: r.id,
      p_player_id: myIdRef.current,
      p_claim_token: myClaimTokenRef.current,
    });
    if (error) {
      console.error("[RouteDuel] request_rematch failed", error);
      return;
    }
    const next = data as RouteDuelRoom | null;
    if (next?.id) {
      setRoom(next);
      if (next.status === "playing") setPhase("playing");
    }
  }, []);

  /* Lost-vote retry (wheel modeli): lokalde oyladım ama DB'de yoksa yeniden. */
  useEffect(() => {
    if (!iRequestedRematchLocally) return;
    if (room?.status !== "finished") return;
    if ((room.rematch_requested_by ?? []).includes(myIdRef.current)) return;
    void requestRematch();
  }, [iRequestedRematchLocally, room?.status, room?.rematch_requested_by, requestRematch]);

  useEffect(() => {
    if (room?.status !== "finished") setIRequestedRematchLocally(false);
  }, [room?.status]);

  /* ═══════════════ SONUÇ SESİ ═══════════════ */
  useEffect(() => {
    if (phase !== "finished" || !room) {
      resultSoundPlayedRef.current = false;
      return;
    }
    if (resultSoundPlayedRef.current) return;
    resultSoundPlayedRef.current = true;
    const iWon = !!room.winner_player_id && room.winner_player_id === myIdRef.current;
    playSound(iWon ? "win" : "lose", { restart: true });
  }, [phase, room?.winner_player_id, room]);

  /* ═══════════════ AKSİYONLAR ═══════════════ */

  async function createRoom() {
    playSound("click");
    const nameErr = validateName(playerName);
    if (nameErr) { setErrorMsg(nameErr); return; }

    setErrorMsg(null);
    setHostClosedRoom(false);
    setStatusMsg("Oda kuruluyor…");
    setPhase("creating");

    clearRouteDuelSession();
    const freshId = freshPlayerId();
    const claimToken = freshClaimToken();
    myIdRef.current = freshId;
    myClaimTokenRef.current = claimToken;

    const profileId = profile?.id ?? null;
    const guestId = profileId ? null : freshId;

    const { data, error } = await supabase.rpc("route_duel_create_room", {
      p_player_id: freshId,
      p_profile_id: profileId,
      p_guest_id: guestId,
      p_name: playerName.trim(),
      p_code: generateRouteDuelRoomCode(),
      p_total_rounds: hostRounds,
      p_route_length: hostLength,
      p_claim_token: claimToken,
    });

    if (error || !(data as RouteDuelRoom | null)?.id) {
      setErrorMsg(describeRouteDuelRpcError(error) ?? "Oda oluşturulamadı. Bağlantıyı kontrol et.");
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    const createdRoom = data as RouteDuelRoom;
    const { data: ps } = await supabase
      .from("route_duel_players")
      .select("*")
      .eq("room_id", createdRoom.id)
      .order("joined_at", { ascending: true });

    setRoom(createdRoom);
    setPlayers((ps ?? []) as RouteDuelPlayer[]);
    saveRoomSession(createdRoom.id, createdRoom.code, freshId);
    setStatusMsg(null);
    setPhase("lobby");
  }

  async function joinRoomByCode() {
    playSound("click");
    const overrideCode = inviteOverrideCodeRef.current;
    const overrideName = inviteOverrideNameRef.current;
    inviteOverrideCodeRef.current = null;
    inviteOverrideNameRef.current = null;

    const effectiveName = overrideName ?? playerName;
    const nameErr = validateName(effectiveName);
    if (nameErr) { setErrorMsg(nameErr); return; }

    const normalized = normalizeRoomCode(overrideCode ?? joinCode);
    if (normalized.length !== 6) {
      setErrorMsg("Oda kodu 6 karakter olmalı.");
      return;
    }

    setErrorMsg(null);
    setHostClosedRoom(false);
    setStatusMsg("Odaya bağlanılıyor…");
    setPhase("creating");

    clearRouteDuelSession();
    const freshId = freshPlayerId();
    const claimToken = freshClaimToken();
    myIdRef.current = freshId;
    myClaimTokenRef.current = claimToken;

    const profileId = profile?.id ?? null;
    const guestId = profileId ? null : freshId;

    const { data, error } = await supabase.rpc("route_duel_join_room", {
      p_code: normalized,
      p_player_id: freshId,
      p_profile_id: profileId,
      p_guest_id: guestId,
      p_name: effectiveName.trim(),
      p_claim_token: claimToken,
    });

    if (error || !(data as RouteDuelRoom | null)?.id) {
      setErrorMsg(describeRouteDuelRpcError(error) ?? "Odaya katılınamadı.");
      setStatusMsg(null);
      setPhase("setup");
      return;
    }

    const targetRoom = data as RouteDuelRoom;
    const { data: ps } = await supabase
      .from("route_duel_players")
      .select("*")
      .eq("room_id", targetRoom.id)
      .order("joined_at", { ascending: true });

    setRoom(targetRoom);
    setPlayers((ps ?? []) as RouteDuelPlayer[]);
    saveRoomSession(targetRoom.id, targetRoom.code, freshId);
    setStatusMsg(null);
    setPhase("lobby");
  }

  const leaveRoom = useCallback(async () => {
    const currentRoom = roomRef.current;
    const currentMyId = myIdRef.current;
    const currentClaim = myClaimTokenRef.current;

    setRoom(null);
    setPlayers([]);
    setErrorMsg(null);
    setStatusMsg(null);
    setOppStaleSeconds(null);
    setIRequestedRematchLocally(false);
    quickMatchJoinedRef.current = false;
    setPhase("setup");
    clearRouteDuelSession();

    if (!currentRoom) return;
    const { error } = await supabase.rpc("route_duel_leave_room", {
      p_room_id: currentRoom.id,
      p_player_id: currentMyId,
      p_claim_token: currentClaim,
    });
    if (error) console.error("[RouteDuel] leave_room failed", error);
  }, []);

  async function startGame() {
    playSound("click");
    const r = roomRef.current;
    if (!r || !isHost || players.length < 2) return;

    // Rota + tur zamanlaması SUNUCUDA kurulur; client parametre GÖNDERMEZ.
    const { data, error } = await supabase.rpc("route_duel_start_game", {
      p_room_id: r.id,
      p_host_player_id: myIdRef.current,
      p_claim_token: myClaimTokenRef.current,
    });

    if (error || !(data as RouteDuelRoom | null)?.id) {
      setErrorMsg(describeRouteDuelRpcError(error) ?? "Oyun başlatılamadı. Tekrar dene.");
      return;
    }
    setRoom(data as RouteDuelRoom);
    setPhase("playing");
  }

  async function updateHostSetting(next: { total_rounds?: number; route_length?: RouteDuelLength }) {
    const r = roomRef.current;
    if (!r || !isHost) return;

    // Optimistic; realtime echo sunucu değerini geri getirir.
    setRoom(prev => (prev ? { ...prev, ...next } : prev));

    const { error } = await supabase.rpc("route_duel_update_settings", {
      p_room_id: r.id,
      p_host_player_id: myIdRef.current,
      p_claim_token: myClaimTokenRef.current,
      p_total_rounds: next.total_rounds ?? null,
      p_route_length: next.route_length ?? null,
    });
    if (error) console.error("[RouteDuel] update_settings failed", error);
  }

  const submitMove = useCallback(async (countryKey: string): Promise<RouteDuelMoveResult> => {
    const r = roomRef.current;
    if (!r) return { accepted: false, finished: false, won: false, reason: "no_room" };

    const { data, error } = await supabase.rpc("route_duel_submit_move", {
      p_room_id: r.id,
      p_player_id: myIdRef.current,
      p_claim_token: myClaimTokenRef.current,
      p_country_key: countryKey,
    });

    if (error) {
      console.error("[RouteDuel] submit_move failed", error);
      return { accepted: false, finished: false, won: false, reason: "rpc_error" };
    }
    const res = (data ?? {}) as Partial<RouteDuelMoveResult>;
    return {
      accepted: !!res.accepted,
      finished: !!res.finished,
      won: !!res.won,
      reason: typeof res.reason === "string" ? res.reason : undefined,
    };
  }, []);

  /* ═══════════════ QUICK MATCH ═══════════════ */

  const joinQuickMatchRoom = useCallback(async (roomId: string, playerId: string, opponentName?: string) => {
    if (quickMatchJoinedRef.current) return;
    quickMatchJoinedRef.current = true;

    if (quickMatchTickRef.current) { clearInterval(quickMatchTickRef.current); quickMatchTickRef.current = null; }
    if (quickMatchSecondsRef.current) { clearInterval(quickMatchSecondsRef.current); quickMatchSecondsRef.current = null; }
    quickMatchAbortRef.current = true;

    myIdRef.current = playerId;
    // claim token QM RPC'sine parametre olarak gitti; ref zaten güncel.

    const { data: roomData, error: roomErr } = await supabase
      .from("route_duel_rooms")
      .select("*")
      .eq("id", roomId)
      .maybeSingle();

    if (roomErr || !roomData) {
      quickMatchJoinedRef.current = false;
      setErrorMsg("Eşleşilen oda bulunamadı, tekrar dene.");
      setPhase("setup");
      return;
    }

    const { data: ps } = await supabase
      .from("route_duel_players")
      .select("*")
      .eq("room_id", roomId)
      .order("joined_at", { ascending: true });

    const matchedRoom = roomData as RouteDuelRoom;
    setRoom(matchedRoom);
    setPlayers((ps ?? []) as RouteDuelPlayer[]);
    saveRoomSession(matchedRoom.id, matchedRoom.code, playerId);
    setStatusMsg(opponentName ? `Rakip bulundu: ${opponentName}` : null);
    setErrorMsg(null);
    setPhase("playing");
  }, []);

  const cancelQuickMatchRef = useRef<(() => void) | null>(null);

  const quickMatchTick = useCallback(async () => {
    if (quickMatchAbortRef.current) return;
    if (!profile?.id) return;
    const myProfileId = profile.id;

    // SELECT-first guard: bekleyen taraf realtime'ı kaçırdıysa kendi queue
    // satırından matched_room_id'yi yakalar (kendi satırı RLS'e açık).
    const { data: selfRow } = await supabase
      .from("route_duel_queue")
      .select("matched_room_id, player_id")
      .eq("profile_id", myProfileId)
      .maybeSingle();

    if (quickMatchAbortRef.current) return;

    if (selfRow?.matched_room_id && selfRow.player_id) {
      await joinQuickMatchRoom(selfRow.matched_room_id, selfRow.player_id);
      return;
    }

    const elapsed = Math.floor((Date.now() - quickMatchStartMsRef.current) / 1000);
    const { data, error } = await supabase.rpc("route_duel_quick_match", {
      p_profile_id: myProfileId,
      p_player_id: myIdRef.current,
      p_player_name: (profile.username ?? "").trim(),
      p_claim_token: myClaimTokenRef.current,
      p_total_rounds: hostRoundsRef.current,
      p_route_length: hostLengthRef.current,
      p_max_level_diff: quickMatchBracket(elapsed),
      p_room_code: generateRouteDuelRoomCode(),
    });

    if (quickMatchAbortRef.current) return;

    if (error) {
      console.error("[RouteDuel] quick_match failed", error);
      setErrorMsg(describeRouteDuelRpcError(error) ?? "Hızlı eşleş hatası. Tekrar dene.");
      cancelQuickMatchRef.current?.();
      return;
    }

    const res = data as {
      matched: boolean;
      room_id?: string;
      my_player_id?: string;
      opponent_name?: string;
    };
    if (res?.matched && res.room_id && res.my_player_id) {
      await joinQuickMatchRoom(res.room_id, res.my_player_id, res.opponent_name);
    }
  }, [profile?.id, profile?.username, joinQuickMatchRoom]);

  const cancelQuickMatch = useCallback(async () => {
    quickMatchAbortRef.current = true;
    if (quickMatchTickRef.current) { clearInterval(quickMatchTickRef.current); quickMatchTickRef.current = null; }
    if (quickMatchSecondsRef.current) { clearInterval(quickMatchSecondsRef.current); quickMatchSecondsRef.current = null; }
    setSearchSeconds(0);
    setStatusMsg(null);
    setPhase("setup");
    if (profile?.id) {
      try {
        await supabase.rpc("route_duel_cancel_quick_match", { p_profile_id: profile.id });
      } catch { /* best effort */ }
    }
  }, [profile?.id]);

  useEffect(() => { cancelQuickMatchRef.current = cancelQuickMatch; }, [cancelQuickMatch]);

  const startQuickMatch = useCallback(async () => {
    playSound("click");
    setErrorMsg(null);
    setHostClosedRoom(false);

    if (!profile?.id || !profile.username) {
      setErrorMsg("Hızlı eşleş için giriş gerekli.");
      return;
    }

    clearRouteDuelSession();
    const freshId = freshPlayerId();
    const claimToken = freshClaimToken();
    myIdRef.current = freshId;
    myClaimTokenRef.current = claimToken;

    quickMatchAbortRef.current = false;
    quickMatchJoinedRef.current = false;
    quickMatchStartMsRef.current = Date.now();
    setSearchSeconds(0);
    setPhase("searching");

    // Önceki (bitmiş maçtan kalan) matched satırı temizle, sonra aramaya gir.
    try {
      await supabase.rpc("route_duel_reset_quick_match", { p_profile_id: profile.id });
    } catch { /* best effort */ }

    quickMatchSecondsRef.current = setInterval(() => {
      setSearchSeconds(Math.floor((Date.now() - quickMatchStartMsRef.current) / 1000));
    }, 1000);

    await quickMatchTick();
    quickMatchTickRef.current = setInterval(() => void quickMatchTick(), QUICK_MATCH_TICK_MS);
  }, [profile?.id, profile?.username, quickMatchTick]);

  /* Hızlı Eşleş auto-start (App intent'i). */
  const autoQuickMatchFiredRef = useRef(false);
  useEffect(() => {
    if (!autoQuickMatch) return;
    if (autoQuickMatchFiredRef.current) return;
    if (!profile?.id || !profile.username) return;
    autoQuickMatchFiredRef.current = true;
    onQuickMatchConsumed?.();
    void startQuickMatch();
  }, [autoQuickMatch, profile?.id, profile?.username, startQuickMatch, onQuickMatchConsumed]);

  /* Bekleyen taraf: kendi queue satırının matched_room_id UPDATE'ini dinle. */
  useEffect(() => {
    if (phase !== "searching") return;
    if (!profile?.id) return;
    const myProfileId = profile.id;

    const chan = supabase
      .channel(`route-duel-queue:${myProfileId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "route_duel_queue", filter: `profile_id=eq.${myProfileId}` },
        payload => {
          const row = payload.new as { matched_room_id: string | null; player_id: string };
          if (!row.matched_room_id) return;
          if (quickMatchJoinedRef.current) return;
          void joinQuickMatchRoom(row.matched_room_id, row.player_id);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(chan);
    };
  }, [phase, profile?.id, joinQuickMatchRoom]);

  /* Unmount: arama sürüyorsa queue satırını best-effort temizle. */
  useEffect(() => {
    return () => {
      if (quickMatchTickRef.current) clearInterval(quickMatchTickRef.current);
      if (quickMatchSecondsRef.current) clearInterval(quickMatchSecondsRef.current);
      if (profile?.id && !quickMatchJoinedRef.current) {
        void supabase.rpc("route_duel_cancel_quick_match", { p_profile_id: profile.id });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ═══════════════════════════════════════════════════════════════
     RENDER
  ═══════════════════════════════════════════════════════════════ */

  // Zümrüt tema: Rota Duel pre-game/lobby yüzeyleri HER ZAMAN Zümrüt Vadi
  // (dark-space) token ailesini kullanır (görev gereksinimi: koyu zümrüt
  // paneller + turkuaz CTA; mavi kurumsal görünüm YOK). Arka plan görseli
  // yine kullanıcının aktif ana ekran temasından gelir.
  const homeTheme = readStoredHomeTheme();
  const isPreGamePhase = phase !== "playing" && phase !== "finished";
  const themeBgStyle = isPreGamePhase ? getThemeBackgroundStyle(homeTheme) : undefined;
  const themeDataAttr = isPreGamePhase ? "dark-space" : undefined;

  return (
    <div className="app duel-screen rd-screen" style={themeBgStyle} data-theme={themeDataAttr}>
      {/* ════════ HEADER ════════ */}
      <div className="duel-header">
        <button
          className="back-btn"
          onClick={() => {
            playSound("click");
            if (phase === "playing") {
              setQuitModal(true);
              return;
            }
            if (room) void leaveRoom();
            onHome();
          }}
          title="Ana Menü"
        >
          <span>←</span>
          <span className="back-label">Menü</span>
        </button>

        <div className="duel-header-center">
          <span className="duel-mode-label">🧭 Rota · Online 1v1</span>
          {room && phase !== "setup" && (
            <>
              <span className="duel-code-badge">#{room.code}</span>
              <span className="duel-region-badge">
                {roundsLabel(room.total_rounds)} · {routeLengthLabel(room.route_length)}
              </span>
            </>
          )}
        </div>

        <div style={{ width: 80 }} />
      </div>

      {/* ════════ SETUP ════════ */}
      {(phase === "setup" || phase === "creating") && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">🧭 Rota · Online 1v1</h2>
            <p className="duel-lobby-desc">
              İki oyuncu aynı başlangıç→hedef rotasında yarışır. Komşu ülkelerden
              ilerleyip hedefe İLK ulaşan turu kazanır.
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
                  <label className="duel-select-label">Tur Sayısı</label>
                  <div className="duel-select-box">
                    <select
                      className="duel-select"
                      value={hostRounds}
                      onChange={e => applyHostRounds(Number(e.target.value))}
                      disabled={phase === "creating"}
                    >
                      {ROUTE_DUEL_ROUND_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>

                <div className="duel-select-wrap">
                  <label className="duel-select-label">Rota Uzunluğu</label>
                  <div className="duel-select-box">
                    <select
                      className="duel-select"
                      value={hostLength}
                      onChange={e => applyHostLength(e.target.value as RouteDuelLength)}
                      disabled={phase === "creating"}
                    >
                      {ROUTE_DUEL_LENGTH_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>
              </div>

              <button
                className="btn btn-accent duel-create-btn"
                onClick={() => void createRoom()}
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
                  onClick={() => void joinRoomByCode()}
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
              <button className="btn duel-quickmatch-btn" disabled title="Hızlı eşleş için giriş gerekli">
                ⚡ Hızlı Eşleş <span style={{ opacity: 0.65 }}>(Giriş Gerekli)</span>
              </button>
            ) : (
              <button
                className="btn btn-accent duel-quickmatch-btn"
                onClick={() => void startQuickMatch()}
                disabled={phase === "creating"}
                title="Aynı tur sayısı + rota uzunluğu seçen biriyle otomatik eşleş"
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

      {/* ════════ SEARCHING (Hızlı Eşleş) ════════ */}
      {phase === "searching" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card" style={{ textAlign: "center" }}>
            <h2 className="duel-lobby-title">⚡ Hızlı Eşleş</h2>
            <p className="duel-lobby-desc">
              Aynı tur sayısı ve rota uzunluğunu seçen, seviyene yakın bir rakip aranıyor…
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "16px 0", fontSize: 14 }}>
              <div>
                <strong>Tur:</strong> {roundsLabel(hostRounds)}{" "}
                <span style={{ opacity: 0.5 }}>·</span>{" "}
                <strong>Rota:</strong> {routeLengthLabel(hostLength)}
              </div>
              <div style={{ opacity: 0.85 }}>
                Bekleme: {Math.floor(searchSeconds / 60)}:{String(searchSeconds % 60).padStart(2, "0")}
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
              🧭
            </div>

            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                playSound("click");
                void cancelQuickMatch();
              }}
            >
              ✕ Aramayı İptal Et
            </button>

            {errorMsg && <p className="duel-error" style={{ marginTop: 12 }}>{errorMsg}</p>}
          </div>
        </div>
      )}

      {/* ════════ LOBBY ════════ */}
      {phase === "lobby" && room && (
        <RouteDuelLobby
          room={room}
          players={players}
          myId={myIdRef.current}
          myClaimToken={myClaimTokenRef.current}
          isHost={isHost}
          playerName={playerName}
          shareLink={shareLink}
          inviteMessage={inviteMessage}
          rosterProfiles={rosterProfiles}
          errorMsg={errorMsg}
          onUpdateSetting={next => void updateHostSetting(next)}
          onStart={() => void startGame()}
          onLeave={() => void leaveRoom()}
        />
      )}

      {/* ════════ PLAYING (finished'da da render — arka plan blur altı) ════════ */}
      {(phase === "playing" || phase === "finished") && room && (
        <RouteDuelPlay
          room={room}
          me={me}
          opp={opp}
          keyToTopoId={keyToTopoId}
          oppStaleSeconds={oppStaleSeconds}
          onSubmitMove={submitMove}
        />
      )}

      {/* ════════ SONUÇ OVERLAY ════════ */}
      {phase === "finished" && room && (
        <RouteDuelResult
          room={room}
          me={me}
          opp={opp}
          myId={myIdRef.current}
          isLoggedIn={!!profile?.username}
          onRequestRematch={() => {
            playSound("click");
            void requestRematch();
          }}
          onQuickMatch={() => {
            playSound("click");
            // Oda ayarlarıyla yeniden kuyruğa gir: ref aynası anında güncellenir
            // (quickMatchTick ref okur → setState flush'una bağımlılık yok).
            const r = roomRef.current;
            if (r) {
              applyHostRounds(r.total_rounds);
              applyHostLength(r.route_length);
            }
            void leaveRoom();
            void Promise.resolve().then(() => startQuickMatch());
          }}
          onHome={() => {
            playSound("click");
            void leaveRoom();
            onHome();
          }}
        />
      )}

      {/* ════════ ODA KAPATILDI (host ayrıldı) ════════ */}
      {hostClosedRoom && (
        <div
          className="fd-room-closed-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rd-room-closed-title"
        >
          <div className="fd-room-closed-modal">
            <div className="fd-room-closed-icon" aria-hidden="true">🚪</div>
            <h2 id="rd-room-closed-title" className="fd-room-closed-title">ODA KAPATILDI</h2>
            <p className="fd-room-closed-sub">Oda sahibi odadan ayrıldı ve oturumu sonlandırdı.</p>
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

      {/* ════════ ÇIKIŞ ONAYI (aktif maç) ════════ */}
      {quitModal && (
        <div className="duel-quit-backdrop" onClick={() => setQuitModal(false)}>
          <div className="duel-quit-modal" onClick={e => e.stopPropagation()}>
            <h3 className="duel-quit-title">Maçtan çıkmak istiyor musun?</h3>
            <p className="duel-quit-sub">Çıkış yapan oyuncu maçı bırakmış sayılır; rakip kazanır.</p>
            <div className="duel-quit-actions">
              <button
                className="btn duel-quit-action forfeit"
                onClick={() => {
                  setQuitModal(false);
                  void leaveRoom();
                  onHome();
                }}
              >
                🏳️ Evet, Çık
              </button>
              <button className="btn duel-quit-action cancel" onClick={() => setQuitModal(false)}>
                ↩ Vazgeç
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
