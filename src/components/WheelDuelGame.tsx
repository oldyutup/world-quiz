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
import type { Profile } from "../lib/auth";
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
  getFlagPool,
  getContinentIds,
  TOPOID_TO_DISPLAY,
  type Continent,
} from "../data/countries";

/* ═══════════════════════════════════════════════════════════════
   TYPES & CONSTANTS
═══════════════════════════════════════════════════════════════ */

type Phase = "setup" | "creating" | "lobby" | "playing" | "finished";

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

  /* ── Gameplay state ───────────────────────────────────────── */
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [wrongId, setWrongId] = useState<string | null>(null);
  const [lastClaimedTopoId, setLastClaimedTopoId] = useState<string | null>(null);
  /** Lokal "pas oyumu gönderdim" bayrağı. UI optimistic state + lost-vote
   *  auto-retry sinyali. Hedef değişince otomatik sıfırlanır. */
  const [iPressedLocally, setIPressedLocally] = useState(false);

  /* ── Identity (set fresh on create/join) ──────────────────── */
  const myIdRef = useRef<string>("");

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

    await supabase
      .from("wheel_duel_rooms")
      .update({
        // used_target_topoids burada büyütülmez — aktif hedef bu listede
        // olursa WorldMap onu "claim edilmiş" gibi yeşil gösterir. Liste
        // sadece bir oyuncu doğru tıkladığında handleMapClick içinde büyür.
        current_target_topoid: next,
        // Yeni hedefe geçildi → pas oyları temizlenir (savunma; çoğunlukla
        // zaten claim/skip atomik UPDATE'inde temizlenmiş olur).
        pass_requested_by: [],
        pass_target_topoid: null,
      })
      .eq("id", r.id)
      .eq("status", "playing")
      .is("current_target_topoid", null);
  }, [buildTargetPool]);

  const finishGame = useCallback(async (reason: "timeout" | "pool") => {
    const r = roomRef.current;
    if (!r) return;
    if (r.host_player_id !== myIdRef.current) return;
    if (endingRef.current) return;
    endingRef.current = true;

    // En güncel skorları DB'den çek (stale state riskine karşı)
    const { data: ps } = await supabase
      .from("wheel_duel_players")
      .select("id, score")
      .eq("room_id", r.id);

    let winnerId: string | null = null;
    if (ps && ps.length > 0) {
      const sorted = [...ps].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      if (sorted.length === 1) {
        winnerId = sorted[0].id;
      } else if ((sorted[0].score ?? 0) > (sorted[1].score ?? 0)) {
        winnerId = sorted[0].id;
      }
    }

    const { error } = await supabase
      .from("wheel_duel_rooms")
      .update({
        status: "finished",
        finished_at: new Date().toISOString(),
        finished_reason: reason,
        winner_player_id: winnerId,
        current_target_topoid: null,
      })
      .eq("id", r.id)
      .eq("status", "playing");

    if (error) {
      console.error("[WheelDuel] finishGame failed", error);
      endingRef.current = false;
    }
  }, []);

  const handleMapClick = useCallback(
    async (topoId: string) => {
      const r = roomRef.current;
      if (!r || r.status !== "playing") return;
      if (!r.current_target_topoid) return;
      if (timeLeftRef.current <= 0) return;

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

      // Doğru: atomic claim
      const newUsed = [...(r.used_target_topoids ?? []), topoId];
      const claimedTarget = topoId;
      const { data: claimRows, error: claimErr } = await supabase
        .from("wheel_duel_rooms")
        .update({
          current_target_topoid: null,
          used_target_topoids: newUsed,
          // Hedef değiştiği için pas state'i temizlenir — aynı oylar yeni
          // hedef için yanlışlıkla geçerli sayılmasın.
          pass_requested_by: [],
          pass_target_topoid: null,
        })
        .eq("id", r.id)
        .eq("current_target_topoid", claimedTarget)
        .select("id");

      if (claimErr) {
        console.error("[WheelDuel] claim failed", claimErr);
        return;
      }

      if (!claimRows || claimRows.length === 0) {
        // Rakip kapmış — sessizce no-op
        return;
      }

      playSound("correct");

      // ── Skor: DB'den fresh oku, +1 ile yaz (stale local state'e güvenme) ──
      const myId = myIdRef.current;
      const { data: meRow } = await supabase
        .from("wheel_duel_players")
        .select("score")
        .eq("id", myId)
        .maybeSingle();

      const latestScore = meRow?.score ?? 0;
      const { error: scoreErr } = await supabase
        .from("wheel_duel_players")
        .update({ score: latestScore + 1 })
        .eq("id", myId);

      if (scoreErr) {
        console.error("[WheelDuel] score update failed", scoreErr);
      }
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
      const remaining = Math.max(0, Math.ceil(duration - elapsed));
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

    const newVotes = [...existing, myId];
    setIPressedLocally(true);

    const { error } = await supabase
      .from("wheel_duel_rooms")
      .update({
        pass_requested_by: newVotes,
        pass_target_topoid: target,
      })
      .eq("id", r.id)
      .eq("current_target_topoid", target); // 🔒 hedef bayatladıysa yazma

    if (error) {
      console.error("[WheelDuel] requestPass failed", error);
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

    const target = r.current_target_topoid;
    const newUsed = [...(r.used_target_topoids ?? []), target];

    const { error } = await supabase
      .from("wheel_duel_rooms")
      .update({
        current_target_topoid: null,
        used_target_topoids: newUsed,
        pass_requested_by: [],
        pass_target_topoid: null,
      })
      .eq("id", r.id)
      .eq("current_target_topoid", target)
      .eq("status", "playing");

    if (error) {
      console.error("[WheelDuel] processSkip failed", error);
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
    setTimeLeft(0);
    setWrongId(null);
    setLastClaimedTopoId(null);
    setIPressedLocally(false);
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

    // setPhase("playing") burada ÇAĞIRMIYORUZ. UPDATE dönüp room.started_at
    // lokal state'e oturduktan sonra phase'i flip ediyoruz; aksi halde
    // "phase=playing + room.started_at=null" tek render bile finish effect'in
    // anında tetiklenmesine yol açıyor.
    const { data: updated, error } = await supabase
      .from("wheel_duel_rooms")
      .update({
        status: "playing",
        started_at: startedAt,
        current_target_topoid: firstTarget,
        // used_target_topoids sadece claim'lerle büyür; aktif hedef burada
        // EKLENMEZ — yoksa hedef oyuncu tıklamadan haritada yeşil görünür.
        used_target_topoids: [],
      })
      .eq("id", room.id)
      .select("*")
      .single();

    console.log("[WD/startGame] update result", { error, updated });

    if (error || !updated) {
      setErrorMsg("Oyun başlatılamadı. Tekrar dene.");
      return;
    }

    console.log("[WD/startGame] state set", {
      updatedStatus: (updated as WheelDuelRoom).status,
      updatedStartedAt: (updated as WheelDuelRoom).started_at,
      updatedDuration: (updated as WheelDuelRoom).duration_seconds,
      updatedTarget: (updated as WheelDuelRoom).current_target_topoid,
    });

    setRoom(updated as WheelDuelRoom);  // started_at + status dolu satır
    setPhase("playing");                // güvenli: room artık tutarlı
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
              Odanı kur, kodu arkadaşına gönder. Çarkın seçtiği ülkeyi haritada ilk bulan puanı kapar.
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
                  className="wheel-ghost-btn"
                  disabled
                  title="Yakında"
                >
                  ↺ Rövanş · Yakında
                </button>
                <button
                  type="button"
                  className="wheel-ghost-btn"
                  disabled
                  title="Yakında"
                >
                  ⚡ Hızlı Eşleş · Yakında
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
