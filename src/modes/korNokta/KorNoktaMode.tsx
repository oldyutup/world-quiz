/**
 * KorNoktaMode.tsx — Kör Nokta çok oyunculu oda/lobi + gameplay V1 (3–5 kişi)
 *
 * Bu dosya oda kurma / katılma / lobi akışını yönetir. Oyun içeriği
 * (dedektif/raporcu/köstebek tur döngüsü) KorNoktaGame.tsx'tedir ve
 * room.status 'playing'/'finished' + game_state doluyken lobi yerine
 * render edilir. Host "Oyunu Başlat" → tevatur_kn_start_game RPC'si
 * (20260713120000 migration'ı); sonrası mevcut tevatur_rooms realtime
 * UPDATE aboneliğiyle tüm oyunculara akar.
 *
 * Altyapı NOT'u: Kör Nokta, eski Tevatür iskeletinin devamıdır. DB tarafı
 * tevatur_* tablolarını/RPC'lerini aynen kullanır (en düşük riskli yol):
 *   • Tablolar: tevatur_rooms / tevatur_players (+ tevatur_player_claims)
 *   • Tüm yazma yolları SECURITY DEFINER RPC'ler üzerinden
 *     (tevatur_create_room / join_room / update_settings / kick_player /
 *      leave_room / send_message)
 *   • Chat: mevcut duel_messages tablosu reuse edilir (LobbyChat,
 *     sendMode="tevatur" → tevatur_send_message RPC).
 *   • Oda kodu "N" ile başlar (N = Kör Nokta) → diğer modların kodlarıyla
 *     duel_messages.room_code alanında karışmaz
 *     (K=Conquest, M=WheelGroup, W=WheelDuel, T=eski Tevatür).
 *
 * Mod kuralları:
 *   • LOGIN-ONLY: misafir oyuncu yok. Oyuncu adı server-side
 *     profiles.username'den resolve edilir; client ad göndermez.
 *   • 3–5 oyuncu. "Oyunu Başlat" min 3 oyuncuyla aktifleşir ama şimdilik
 *     yalnız "sonraki adımda" bilgisi gösterir (start RPC'si henüz yok).
 *   • Ayarlar: Tur Sayısı (5/7/10/15/20, varsayılan 7). "Roller" ayarı
 *     UI hazırlığı olarak disabled durur (köstebek sistemi sonraki fazda).
 *   • Rol dağılımı (ileriki faz için referans): 3 kişi → 1 Dedektif +
 *     2 Raporcu, 4 kişi → 1+3, 5 kişi → 1+4. Her turda dedektif sırayla
 *     değişir; köstebek olasılığı sonraki adımda eklenecek.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LobbyChat from "../../components/LobbyChat";
import type { Profile } from "../../lib/auth";
import { useInviteJoin } from "../../lib/useInviteJoin";
import { readStoredHomeTheme, getThemeBackgroundStyle, getThemeDataAttr } from "../../lib/themeBackgrounds";
import { supabase, type TevaturRoom, type TevaturPlayer } from "../../lib/supabase";
import { PlayerAvatar } from "../../components/PlayerAvatar";
import { PlayerProfileTrigger } from "../../components/PlayerProfileTrigger";
import { LobbyInviteBar } from "../../components/LobbyInviteBar";
import { useRosterProfiles } from "../../lib/useRosterProfiles";
import { useSocialOptional } from "../../components/SocialContext";
import { playSound } from "../../lib/sound";
import KorNoktaGame from "./KorNoktaGame";
import { buildKnScenePlan, parseKnGameState } from "./korNoktaGameTypes";
import { buildKnQuestionPool } from "./korNoktaQuestions";

/* ═══════════════════════════════════════════════════════════════
   TYPES & CONSTANTS
═══════════════════════════════════════════════════════════════ */

type Phase = "join" | "creating" | "lobby";
type KnTeam = "blue" | "red";

/** Maksimum oyuncu (5v5). */
const TOTAL_SLOTS = 10;
/** Takım başına gösterilen slot sayısı. */
const TEAM_SLOTS = 5;
/** Oyun başlatılabilen toplam oyuncu sayıları (eşit takım). */
const VALID_TEAM_COUNTS = [4, 6, 8, 10];

const ROUND_OPTIONS: { label: string; value: number }[] = [
  { label: "5 tur",  value: 5  },
  { label: "10 tur", value: 10 },
  { label: "15 tur", value: 15 },
  { label: "20 tur", value: 20 },
];

const DEFAULT_ROUND_COUNT = 10;
/** Legacy DB kolonu: fotoğraf süresi ayarı UI'dan kaldırıldı ama
 *  tevatur_create_room RPC'si parametreyi zorunlu tutuyor. Sabit gönderilir;
 *  gameplay fazında ya yeniden kullanılır ya da migration'la kaldırılır. */
const LEGACY_PHOTO_SECONDS = 10;

const PLAYER_ID_KEY   = "geoquiz_kornokta_player_id";
const ROOM_KEY        = "geoquiz_kornokta_room";
const CLAIM_TOKEN_KEY = "geoquiz_kornokta_claim_token";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */

/** "N" + 5 random char → 6 toplam. N = Kör Nokta. */
function generateRoomCode(): string {
  let out = "N";
  for (let i = 0; i < 5; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

/** Oyuncuları takıma ayırır (team null → Mavi varsayılır, eski satır güvenliği). */
function splitTeams(players: TevaturPlayer[]): Record<KnTeam, TevaturPlayer[]> {
  const blue: TevaturPlayer[] = [];
  const red: TevaturPlayer[] = [];
  for (const p of players) {
    if (p.team === "red") red.push(p);
    else blue.push(p);
  }
  return { blue, red };
}

function freshPlayerId(): string {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(PLAYER_ID_KEY, id);
  return id;
}

function freshClaimToken(): string {
  const tok =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(CLAIM_TOKEN_KEY, tok);
  return tok;
}

function clearKorNoktaSession() {
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

/** RPC hata etiketlerini kullanıcı dostu Türkçe karşılıklarına çevirir
 *  (wheel_group describe pattern'i). */
function describeKorNoktaRpcError(
  error: { code?: string; message?: string } | null | undefined,
): string | null {
  if (!error) return null;
  const msg = (error.message ?? "").toLowerCase();
  if (msg.includes("code_taken"))           return "Bu oda kodu az önce kullanıldı. Tekrar dene.";
  if (msg.includes("auth_required"))        return "Kör Nokta için giriş yapmalısın.";
  if (msg.includes("username_required"))    return "Hesabında bir kullanıcı adı yok.";
  if (msg.includes("already_in_room"))      return "Zaten bu odadasın (başka bir sekmede olabilir).";
  if (msg.includes("room_full"))            return "Oda dolu.";
  if (msg.includes("room_finished"))        return "Bu oda kapanmış.";
  if (msg.includes("room_in_progress"))     return "Oyun başlamış. Katılamazsın.";
  if (msg.includes("room_unavailable"))     return "Oda şu an müsait değil.";
  if (msg.includes("room_not_found"))       return "Oda bulunamadı. Kodu kontrol et.";
  if (msg.includes("room_not_waiting"))     return "Oda artık lobi fazında değil.";
  if (msg.includes("round_count_invalid"))  return "Geçersiz tur sayısı.";
  if (msg.includes("photo_seconds_invalid")) return "Geçersiz fotoğraf süresi.";
  if (msg.includes("player_count_invalid")) return "Takımlar eşit olmalı: 2v2, 3v3, 4v4 veya 5v5 oynanabilir.";
  if (msg.includes("team_invalid"))         return "Geçersiz takım.";
  if (msg.includes("scenes_invalid"))       return "Sahne planı oluşturulamadı. Tekrar dene.";
  if (msg.includes("game_not_active"))      return "Oyun aktif değil.";
  if (msg.includes("cannot_kick_self"))     return "Kendini kickleyemezsin.";
  if (msg.includes("claim_token_required"))
    return "Oturum bilgin eksik. Sayfayı yenileyip tekrar dene.";
  if (msg.includes("unauthorized"))
    return "Bu işlem için yetkin yok. Oturumun bayatlamış olabilir.";
  if (error.code === "42P01")
    return "Veritabanı tabloları hazır değil. Migration çalıştırılmamış olabilir.";
  if (error.code === "42501")
    return "Veritabanı izin hatası. Giriş yaptığından emin ol.";
  return null;
}

/* ═══════════════════════════════════════════════════════════════
   COMPONENT
═══════════════════════════════════════════════════════════════ */

interface Props {
  onHome: () => void;
  profile: Profile | null;
  /** "create" → mount'ta oda kur; "join" → oda kodu ekranı göster. */
  initialAction: "create" | "join";
}

export default function KorNoktaMode({ onHome, profile, initialAction }: Props) {
  const [phase, setPhase] = useState<Phase>(initialAction === "join" ? "join" : "creating");

  const isLoggedInPlayer = !!profile?.username;

  /* ── Form / status state ─────────────────────────────────── */
  const [joinCode, setJoinCode]   = useState<string>("");
  const [errorMsg, setErrorMsg]   = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [starting, setStarting]   = useState(false);

  /* ── Modal state ─────────────────────────────────────────── */
  const [kickTarget, setKickTarget]             = useState<TevaturPlayer | null>(null);
  const [kickedNoticeOpen, setKickedNoticeOpen] = useState(false);
  const [roomClosedNoticeOpen, setRoomClosedNoticeOpen] = useState(false);
  const [newHostModalOpen, setNewHostModalOpen] = useState(false);

  /* ── Lobby state (Supabase-bound) ────────────────────────── */
  const [room, setRoom]       = useState<TevaturRoom | null>(null);
  const [players, setPlayers] = useState<TevaturPlayer[]>([]);
  // Sosyal: roster avatarları + odadayken davet için room context.
  const rosterProfiles = useRosterProfiles(players.map((p) => p.profile_id ?? null));
  const social = useSocialOptional();
  useEffect(() => {
    if (!social) return;
    const code = room?.code;
    if (code) social.setRoomContext({ code, mode: "korNokta", roomUrl: `/?korNokta=${code}` });
    return () => social.setRoomContext(null);
  }, [social, room?.code]);

  /* ── Mobile sheets ───────────────────────────────────────── */
  const [playersSheetOpen, setPlayersSheetOpen] = useState(false);
  const [chatSheetOpen, setChatSheetOpen]       = useState(false);

  /* ── Identity ── */
  const myIdRef         = useRef<string>("");
  const myClaimTokenRef = useRef<string>("");

  /* ── Refs that callbacks read ── */
  const roomRef = useRef<TevaturRoom | null>(null);
  useEffect(() => { roomRef.current = room; }, [room]);

  /** Davet linkinden gelen oda kodu override (auto-join akışı için). */
  const inviteOverrideCodeRef = useRef<string | null>(null);

  /* ── Derived ── */
  const isHost = !!room && room.host_player_id === myIdRef.current;

  /** game_state dolu + status playing/finished → lobi yerine oyun ekranı. */
  const knGameState = room ? parseKnGameState(room.game_state) : null;
  const knInGame =
    !!room && !!knGameState &&
    (room.status === "playing" || room.status === "finished");

  /** Hem realtime echo'su hem RPC cevabı buradan geçer; updated_at'i daha
   *  eski olan satır mevcut state'i EZMEZ (out-of-order koruması). */
  const applyRoomUpdate = useCallback((r: TevaturRoom) => {
    setRoom(prev => {
      if (prev && prev.id === r.id) {
        const prevT = Date.parse(prev.updated_at ?? "") || 0;
        const nextT = Date.parse(r.updated_at ?? "") || 0;
        if (nextT < prevT) return prev;
      }
      return r;
    });
  }, []);

  /* ── Share/invite ── */
  const shareLink = useMemo(() => {
    if (!room) return "";
    const origin = window.location.origin;
    const pathname = window.location.pathname;
    return `${origin}${pathname}?korNokta=${room.code}`;
  }, [room]);

  const inviteMessage = useMemo(() => {
    if (!room) return "";
    return (
      `Torble Kör Nokta odama katıl:\n` +
      `${shareLink}\n` +
      `Oda kodu: ${room.code}`
    );
  }, [room, shareLink]);

  /* ═══════════════════════════════════════════════════════════
     ACTIONS
  ═══════════════════════════════════════════════════════════ */

  const createRoom = useCallback(async () => {
    if (!profile?.username) {
      setErrorMsg("Kör Nokta odası kurmak için giriş yapmalısın.");
      setStatusMsg(null);
      return;
    }

    setErrorMsg(null);
    setStatusMsg("Oda kuruluyor…");
    setPhase("creating");

    clearKorNoktaSession();
    const freshId = freshPlayerId();
    const claimToken = freshClaimToken();
    myIdRef.current = freshId;
    myClaimTokenRef.current = claimToken;

    const code = generateRoomCode();

    // Tek RPC: oda + host player + claim transaction'da. Ad server-side
    // profiles.username'den resolve edilir.
    const { data: roomData, error: roomErr } = await supabase.rpc(
      "tevatur_create_room",
      {
        p_player_id:     freshId,
        p_code:          code,
        p_round_count:   DEFAULT_ROUND_COUNT,
        p_photo_seconds: LEGACY_PHOTO_SECONDS,
        p_claim_token:   claimToken,
      },
    );

    if (roomErr || !roomData?.id) {
      const friendly =
        describeKorNoktaRpcError(roomErr) ??
        "Oda oluşturulamadı. Bağlantıyı kontrol et.";
      setErrorMsg(friendly);
      setStatusMsg(null);
      return;
    }

    const createdRoom = roomData as TevaturRoom;

    // İlk player listesini çek (realtime devreye girene kadar UI hazır olsun).
    const { data: ps } = await supabase
      .from("tevatur_players")
      .select("*")
      .eq("room_id", createdRoom.id)
      .order("joined_at", { ascending: true });

    setRoom(createdRoom);
    setPlayers((ps ?? []) as TevaturPlayer[]);
    saveRoomSession(createdRoom.id, createdRoom.code, freshId);
    setStatusMsg(null);
    setPhase("lobby");
  }, [profile?.username]);

  /* ── initialAction="create": mount'ta odayı kur (StrictMode guard) ── */
  const createAttemptedRef = useRef(false);
  useEffect(() => {
    if (initialAction !== "create") return;
    if (createAttemptedRef.current) return;
    if (!profile?.username) return; // login-guard ekranı render edilir
    createAttemptedRef.current = true;
    void createRoom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAction, profile?.username]);

  async function joinRoomByCode() {
    playSound("click");
    const overrideCode = inviteOverrideCodeRef.current;
    inviteOverrideCodeRef.current = null;

    if (!profile?.username) {
      setErrorMsg("Kör Nokta moduna katılmak için giriş yapmalısın.");
      return;
    }
    const normalized = normalizeRoomCode(overrideCode ?? joinCode);
    if (normalized.length !== 6) {
      setErrorMsg("Oda kodu 6 karakter olmalı.");
      return;
    }

    setErrorMsg(null);
    setStatusMsg("Odaya bağlanılıyor…");
    setPhase("creating");

    clearKorNoktaSession();
    const freshId = freshPlayerId();
    const claimToken = freshClaimToken();
    myIdRef.current = freshId;
    myClaimTokenRef.current = claimToken;

    const { data: roomData, error: joinErr } = await supabase.rpc(
      "tevatur_join_room",
      {
        p_code:        normalized,
        p_player_id:   freshId,
        p_claim_token: claimToken,
      },
    );

    if (joinErr || !roomData?.id) {
      const friendly =
        describeKorNoktaRpcError(joinErr) ?? "Odaya katılınamadı.";
      setErrorMsg(friendly);
      setStatusMsg(null);
      setPhase("join");
      return;
    }

    const targetRoom = roomData as TevaturRoom;

    const { data: ps } = await supabase
      .from("tevatur_players")
      .select("*")
      .eq("room_id", targetRoom.id)
      .order("joined_at", { ascending: true });

    setRoom(targetRoom);
    setPlayers((ps ?? []) as TevaturPlayer[]);
    saveRoomSession(targetRoom.id, targetRoom.code, freshId);
    setStatusMsg(null);
    setPhase("lobby");
  }

  /** Lobiden çıkış. Server RPC üç dalı tek transaction'da yönetir:
   *  host transfer / oda silme / self DELETE (wheel_group pattern'i). */
  async function leaveRoom() {
    const currentRoom = roomRef.current;
    const currentMyId = myIdRef.current;
    const currentClaim = myClaimTokenRef.current;

    setRoom(null);
    setPlayers([]);
    setErrorMsg(null);
    setStatusMsg(null);
    setStarting(false);
    clearKorNoktaSession();

    if (!currentRoom) return;

    const { error } = await supabase.rpc("tevatur_leave_room", {
      p_room_id:     currentRoom.id,
      p_player_id:   currentMyId,
      p_claim_token: currentClaim,
    });
    if (error) {
      console.error("[KorNokta] leave_room RPC failed", error);
    }
  }

  /** Host: lobi → gameplay. Sahne planı client'ta kurulur (havuz client
   *  bundle'ında), server doğrular + game_state'i yazar; realtime UPDATE
   *  tüm oyuncuları aynı anda oyun ekranına geçirir. */
  async function startGame() {
    if (!room || !isHost || starting) return;
    const { blue, red } = splitTeams(players);
    if (blue.length !== red.length || !VALID_TEAM_COUNTS.includes(players.length)) return;
    playSound("click");
    setStarting(true);
    setErrorMsg(null);

    const { data, error } = await supabase.rpc("tevatur_kn_start_game", {
      p_room_id:        room.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    myClaimTokenRef.current,
      p_scenes:         buildKnScenePlan(room.round_count),
      p_question_pool:  buildKnQuestionPool(),
    });

    if (error) {
      setErrorMsg(
        describeKorNoktaRpcError(error) ?? "Oyun başlatılamadı. Tekrar dene.",
      );
      setStarting(false);
      return;
    }
    if (data?.id) {
      applyRoomUpdate(data as TevaturRoom);
    }
    setStarting(false);
  }

  async function updateRoundCount(roundCount: number) {
    if (!room || !isHost) return;
    // Optimistic — rollback realtime echo'ya bırakılır.
    setRoom(prev => (prev ? { ...prev, round_count: roundCount } : prev));

    const { error } = await supabase.rpc("tevatur_update_settings", {
      p_room_id:        room.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    myClaimTokenRef.current,
      p_round_count:    roundCount,
      p_photo_seconds:  null,
    });
    if (error) {
      console.error("[KorNokta] update_settings RPC failed", error);
    }
  }

  /** Host: bir oyuncuyu diğer takıma alır (yalnız lobide). */
  async function setPlayerTeam(targetId: string, team: KnTeam) {
    if (!room || !isHost) return;
    playSound("click");
    // Optimistic — rollback realtime echo'ya bırakılır.
    setPlayers(prev => prev.map(p => (p.id === targetId ? { ...p, team } : p)));
    const { error } = await supabase.rpc("tevatur_kn_set_team", {
      p_room_id:          room.id,
      p_host_player_id:   myIdRef.current,
      p_claim_token:      myClaimTokenRef.current,
      p_target_player_id: targetId,
      p_team:             team,
    });
    if (error) {
      console.error("[KorNokta] set_team RPC failed", error);
    }
  }

  /** Host: köstebek ayarını açar/kapatır (yalnız 3v3+ etkin). */
  async function setMoleEnabled(enabled: boolean) {
    if (!room || !isHost) return;
    playSound("click");
    setRoom(prev => (prev ? { ...prev, mole_enabled: enabled } : prev));
    const { error } = await supabase.rpc("tevatur_kn_set_mole", {
      p_room_id:        room.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    myClaimTokenRef.current,
      p_enabled:        enabled,
    });
    if (error) {
      console.error("[KorNokta] set_mole RPC failed", error);
    }
  }

  async function kickPlayer(targetId: string) {
    if (!room || !isHost) return;
    if (targetId === myIdRef.current) return;
    const { error } = await supabase.rpc("tevatur_kick_player", {
      p_room_id:          room.id,
      p_host_player_id:   myIdRef.current,
      p_host_claim_token: myClaimTokenRef.current,
      p_target_player_id: targetId,
    });
    if (error) {
      console.error("[KorNokta] kick_player RPC failed", error);
      setErrorMsg(
        describeKorNoktaRpcError(error) ?? "Oyuncu odadan çıkarılamadı.",
      );
      return;
    }
    setPlayers(prev => prev.filter(p => p.id !== targetId));
    setKickTarget(null);
  }


  /* ═══════════════════════════════════════════════════════════
     REALTIME: oda + oyuncular
  ═══════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (!room) return;
    const roomId = room.id;

    const chan = supabase
      .channel(`kornokta:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "tevatur_rooms",
          filter: `id=eq.${roomId}`,
        },
        payload => {
          const r = payload.new as TevaturRoom;

          // Yeni host detection: önceki host ben değilken yeni host ben oldum
          if (
            r.host_player_id === myIdRef.current &&
            roomRef.current?.host_player_id !== myIdRef.current
          ) {
            setNewHostModalOpen(true);
          }

          applyRoomUpdate(r);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "tevatur_rooms",
          filter: `id=eq.${roomId}`,
        },
        () => {
          // Oda silindi (host son kişiyken kapattı). Kendim host değilsem
          // bildirim göster — Tamam ile ana menüye dönülür.
          if (roomRef.current?.host_player_id !== myIdRef.current) {
            setRoom(null);
            setPlayers([]);
            clearKorNoktaSession();
            setRoomClosedNoticeOpen(true);
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tevatur_players",
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          supabase
            .from("tevatur_players")
            .select("*")
            .eq("room_id", roomId)
            .order("joined_at", { ascending: true })
            .then(({ data }) => {
              if (data) setPlayers(data as TevaturPlayer[]);
            });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(chan);
    };
  }, [room?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Kick detection: lobide kendimi listede bulamıyorsam atıldım ── */
  useEffect(() => {
    if (phase !== "lobby") return;
    if (!room) return;
    if (!myIdRef.current) return;
    if (players.length === 0) return;
    const meInRoom = players.some(p => p.id === myIdRef.current);
    if (!meInRoom) {
      clearKorNoktaSession();
      setRoom(null);
      setPlayers([]);
      setKickedNoticeOpen(true);
    }
  }, [phase, players, room]);

  /* ── Davet linki: ?korNokta=KOD prefill + giriş yapmışsa auto-join ── */
  useInviteJoin({
    paramKey: "korNokta",
    setJoinCode,
    canAutoJoin: isLoggedInPlayer && phase === "join" && !room,
    triggerJoin: (code) => {
      inviteOverrideCodeRef.current = code;
      void joinRoomByCode();
    },
  });

  /* ═══════════════════════════════════════════════════════════
     RENDER
  ═══════════════════════════════════════════════════════════ */

  const homeTheme = readStoredHomeTheme();
  const themeBgStyle = getThemeBackgroundStyle(homeTheme);
  const themeDataAttr = getThemeDataAttr(homeTheme);

  /* ── Takım dağılımı + başlatma/köstebek koşulları ── */
  const teams = splitTeams(players);
  const teamsEqual = teams.blue.length === teams.red.length;
  const validCount = VALID_TEAM_COUNTS.includes(players.length);
  const canStart = isHost && teamsEqual && validCount && !starting;
  // Köstebek yalnız 3v3+ (her takımda >=3 oyuncu) etkin.
  const moleEligible = teams.blue.length >= 3 && teams.red.length >= 3;
  const moleOn = (room?.mole_enabled ?? true) && moleEligible;

  /** Tek takım panelini render eder (Mavi/Kırmızı). */
  const renderTeamPanel = (team: KnTeam, onClose?: () => void) => {
    const list = teams[team];
    const label = team === "blue" ? "🔵 Mavi Takım" : "🔴 Kırmızı Takım";
    const other: KnTeam = team === "blue" ? "red" : "blue";
    return (
      <div className={"kn-team-panel kn-team-panel--" + team}>
        <div className="kn-team-panel__head">
          <span className="kn-team-panel__title">{label}</span>
          <span className="wgg-max-badge">{list.length}/{TEAM_SLOTS}</span>
        </div>
        <div className="wgg-player-list">
          {Array.from({ length: TEAM_SLOTS }, (_, i) => {
            const p = list[i] ?? null;
            if (!p) {
              return (
                <div key={`empty-${team}-${i}`} className="kn-team-slot-empty">
                  <span className="wgg-ps-dot-empty" />
                  <span style={{ fontSize: 12, fontStyle: "italic" }}>Boş slot</span>
                </div>
              );
            }
            const isMe = p.id === myIdRef.current;
            const isPlayerHost = p.id === room?.host_player_id;
            const rp = rosterProfiles.get(p.profile_id ?? "");
            return (
              <div
                key={p.id}
                className={"duel-player-chip" + (isMe ? " mine" : "")}
                style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 5, paddingBottom: 5, minWidth: 0 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
                  <PlayerProfileTrigger profileId={p.profile_id} as="span" className="duel-player-id">
                    <PlayerAvatar
                      avatarId={rp?.avatarId}
                      username={p.name}
                      size="sm"
                      highlight={isPlayerHost}
                      className="duel-player-avatar"
                    />
                    <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name}
                    </span>
                  </PlayerProfileTrigger>
                  {rp?.level != null && <span className="kn-team-level">Sv {rp.level}</span>}
                  {isMe && <span className="duel-tag" style={{ flexShrink: 0, marginLeft: 2 }}>Sen</span>}
                  {isPlayerHost && <span className="duel-tag host" style={{ flexShrink: 0, marginLeft: 2 }}>👑</span>}
                </div>
                {isHost && (
                  <button
                    type="button"
                    className="kn-team-move-btn"
                    title={"Diğer takıma al"}
                    onClick={() => { setPlayerTeam(p.id, other); onClose?.(); }}
                  >
                    ↔
                  </button>
                )}
                {isHost && !isPlayerHost && (
                  <button type="button" className="dgg-kick-btn" style={{ flexShrink: 0 }} onClick={() => { setKickTarget(p); onClose?.(); }}>
                    At
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="app duel-screen" style={themeBgStyle} data-theme={themeDataAttr}>
      {/* ════════ HEADER ════════ */}
      <div className="duel-header">
        <button
          className="back-btn"
          onClick={() => {
            playSound("click");
            if (room) void leaveRoom();
            onHome();
          }}
          title="Ana Menü"
        >
          <span>←</span>
          <span className="back-label">Menü</span>
        </button>

        <div className="duel-header-center">
          <span className="duel-mode-label">🕵️‍♂️ Kör Nokta</span>
          {room && (
            <span className="duel-code-badge">#{room.code}</span>
          )}
        </div>

        <div style={{ width: 80 }} />
      </div>

      {/* ════════ LOGIN GUARD (davet linkiyle gelen misafir vb.) ════════ */}
      {!isLoggedInPlayer && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">🕵️‍♂️ Kör Nokta</h2>
            <p className="duel-lobby-desc">
              İki takım, mesafe yarışı. 2v2 · 3v3 · 4v4 · 5v5.
            </p>
            <p className="duel-error">
              🔒 Kör Nokta moduna katılmak için giriş yapmalısın. Ana menüden
              giriş yapıp tekrar dene.
            </p>
            <button
              className="btn btn-ghost"
              style={{ width: "100%", minHeight: 44, borderRadius: 12 }}
              onClick={() => { playSound("click"); onHome(); }}
            >
              ← Ana Menü
            </button>
          </div>
        </div>
      )}

      {/* ════════ JOIN — oda kodu ekranı ════════ */}
      {isLoggedInPlayer && phase === "join" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">🕵️‍♂️ Kör Nokta · Odaya Katıl</h2>
            <p className="duel-lobby-desc">
              Arkadaşının verdiği 6 haneli oda kodunu gir.
            </p>

            <div className="duel-field-row">
              <label className="duel-field-label">Oda Kodu</label>
              <input
                className="duel-name-input"
                type="text"
                value={joinCode}
                onChange={e => setJoinCode(normalizeRoomCode(e.target.value))}
                onKeyDown={e => { if (e.key === "Enter") void joinRoomByCode(); }}
                placeholder="N_____"
                autoComplete="off"
                spellCheck={false}
                maxLength={6}
                style={{
                  fontFamily: "monospace",
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                }}
              />
            </div>

            <div className="duel-field-row">
              <label className="duel-field-label">Oyuncu Adın</label>
              <div
                className="duel-name-input"
                aria-readonly="true"
                title="Login olduğun için adın profil hesabından alınır"
                style={{ display: "flex", alignItems: "center", gap: 8, cursor: "default", opacity: 0.95 }}
              >
                <span
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "4px 10px", borderRadius: 999,
                    background: "rgba(79,139,255,0.18)",
                    border: "1px solid rgba(79,139,255,0.55)",
                    fontWeight: 800, fontSize: 14, letterSpacing: "0.01em",
                  }}
                >
                  <span aria-hidden>👤</span>
                  <span>@{profile?.username}</span>
                </span>
                <span style={{ fontSize: 12, opacity: 0.65 }}>olarak katılıyorsun</span>
              </div>
            </div>

            <button
              className="btn btn-accent duel-create-btn"
              onClick={joinRoomByCode}
              type="button"
            >
              🚪 Odaya Katıl
            </button>

            {errorMsg && <p className="duel-error">{errorMsg}</p>}
          </div>
        </div>
      )}

      {/* ════════ CREATING — durum / hata ekranı ════════ */}
      {isLoggedInPlayer && phase === "creating" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">🕵️‍♂️ Kör Nokta</h2>
            {!errorMsg && (
              <p className="duel-status">{statusMsg ?? "Hazırlanıyor…"}</p>
            )}
            {errorMsg && (
              <>
                <p className="duel-error">{errorMsg}</p>
                <button
                  className="btn btn-accent duel-create-btn"
                  onClick={() => { playSound("click"); void createRoom(); }}
                >
                  🔁 Tekrar Dene
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ width: "100%", minHeight: 44, borderRadius: 12, marginTop: 8 }}
                  onClick={() => { playSound("click"); onHome(); }}
                >
                  ← Ana Menü
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ════════ GAMEPLAY — Kör Nokta tur döngüsü ════════ */}
      {isLoggedInPlayer && phase === "lobby" && room && knInGame && (
        <KorNoktaGame
          room={room}
          players={players}
          myId={myIdRef.current}
          claimToken={myClaimTokenRef.current}
          isHost={isHost}
          onRoomUpdate={applyRoomUpdate}
          onExit={() => {
            void leaveRoom();
            onHome();
          }}
        />
      )}

      {/* ════════ LOBBY — 3-card grid (WheelGroup düzeni) ════════ */}
      {isLoggedInPlayer && phase === "lobby" && room && !knInGame && (
        <>
        <div className="duel-lobby">
          <div className="wgg-grid">

            {/* ══ SOL KART: Takımlar (Mavi / Kırmızı) ══ */}
            <div className="duel-lobby-card wgg-players-card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexShrink: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.02em" }}>👥 Takımlar</span>
                <span className="wgg-max-badge">
                  {players.length}/{TOTAL_SLOTS}
                </span>
              </div>

              <div className="kn-teams-wrap">
                {renderTeamPanel("blue")}
                {renderTeamPanel("red")}
              </div>

              {!canStart && (
                <div style={{ marginTop: 10, flexShrink: 0 }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    fontSize: 12, fontWeight: 700, padding: "4px 12px", borderRadius: 999,
                    background: "rgba(212,160,44,0.16)", border: "1px solid rgba(212,160,44,0.45)",
                    color: "var(--amber, #d4a02c)", letterSpacing: "0.02em", lineHeight: 1.3,
                  }}>
                    Takımlar eşit olmalı: 2v2, 3v3, 4v4 veya 5v5 oynanabilir.
                  </span>
                </div>
              )}
            </div>

            {/* ══ ORTA KART: Oda bilgisi + Ayarlar + Aksiyon ══ */}
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

              {/* Davet bölümü */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                <LobbyInviteBar
                  inviteMessage={inviteMessage}
                  shareLink={shareLink}
                  roomCode={room.code}
                  mode="korNokta"
                  roomUrl={`/?korNokta=${room.code}`}
                />
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

              {/* Oyun Ayarları: Tur Sayısı + Köstebek (host) */}
              <section aria-label="Oyun Ayarları" style={{
                display: "flex", flexDirection: "column",
                gap: 8, padding: "10px 12px",
                background: "rgba(10,18,32,0.55)", border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 12, boxSizing: "border-box", flexShrink: 0,
              }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.7 }}>
                  ⚙️ Oyun Ayarları
                </span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div className="duel-select-wrap" style={{ minWidth: 0, gap: 3 }}>
                    <label className="duel-select-label" style={{ fontSize: "0.62rem" }}>🔁 Tur Sayısı</label>
                    <div className="duel-select-box">
                      <select className="duel-select" value={room.round_count} disabled={!isHost}
                        onChange={e => updateRoundCount(Number(e.target.value))}
                        style={{ height: 34, fontSize: 12.5, padding: "0 26px 0 10px", opacity: isHost ? 1 : 0.7, cursor: isHost ? "pointer" : "not-allowed" }}
                      >
                        {ROUND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <span className="duel-select-caret">▾</span>
                    </div>
                  </div>
                  <div className="duel-select-wrap" style={{ minWidth: 0, gap: 3 }}>
                    <label className="duel-select-label" style={{ fontSize: "0.62rem" }}>🎭 Casus</label>
                    <div className="duel-select-box" title={moleEligible ? "Casus 3v3 ve üzerinde etkin" : "Casus yalnız 3v3+ açılabilir (2v2'de yok)"}>
                      <select
                        className="duel-select"
                        value={(room.mole_enabled ?? true) ? "on" : "off"}
                        disabled={!isHost || !moleEligible}
                        onChange={e => setMoleEnabled(e.target.value === "on")}
                        style={{ height: 34, fontSize: 12.5, padding: "0 26px 0 10px", opacity: (isHost && moleEligible) ? 1 : 0.55, cursor: (isHost && moleEligible) ? "pointer" : "not-allowed" }}
                      >
                        <option value="on">Açık</option>
                        <option value="off">Kapalı</option>
                      </select>
                      <span className="duel-select-caret">▾</span>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 11, opacity: 0.55, lineHeight: 1.5 }}>
                  🕵️ Dedektif 5 soru seçer; raporcular Evet/Hayır/Emin değilim ile cevaplar.
                  <br />
                  🎭 Casus: {moleOn
                    ? "açık — her takımda 1, cevapları karşı takım dedektifine gider."
                    : (moleEligible ? "kapalı." : "2v2'de yok (3v3+ gerekir).")}
                </div>
              </section>

              {/* Spacer: butonları alta iter */}
              <div style={{ flex: 1 }} />

              {/* Aksiyonlar */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
                {isHost && (
                    <button
                      className={canStart ? "btn btn-accent" : "btn btn-ghost"}
                      onClick={() => { void startGame(); }}
                      disabled={!canStart}
                      title={canStart ? "Oyunu başlat" : "Takımlar eşit olmalı: 2v2/3v3/4v4/5v5"}
                      style={{
                        width: "100%", minHeight: 44, fontSize: 15, fontWeight: 800,
                        borderRadius: 12, letterSpacing: "0.02em",
                        opacity: canStart ? 1 : 0.65, cursor: canStart ? "pointer" : "not-allowed",
                        boxSizing: "border-box",
                      }}
                    >
                      {starting
                        ? "⏳ Başlatılıyor…"
                        : `🚀 Oyunu Başlat (${teams.blue.length}v${teams.red.length})`}
                    </button>
                )}
                <button
                  className="btn btn-ghost"
                  onClick={() => { playSound("click"); void leaveRoom(); onHome(); }}
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
                playerName={(profile?.username ?? "").trim()}
                mobileSheetOpen={chatSheetOpen}
                onMobileSheetOpenChange={v => { setChatSheetOpen(v); if (v) setPlayersSheetOpen(false); }}
                hideMobileFab={chatSheetOpen || playersSheetOpen}
                sendMode="tevatur"
                playerId={myIdRef.current}
                claimToken={myClaimTokenRef.current}
              />
            </div>
          </div>
        </div>

        {/* ════ MOBİL: Oyuncular FAB ════ */}
        {!chatSheetOpen && !playersSheetOpen && (
          <button
            type="button"
            className="wgg-players-fab"
            aria-label="Oyuncuları aç"
            onClick={() => { setPlayersSheetOpen(true); setChatSheetOpen(false); }}
          >
            <span>👥</span>
            <span>Takımlar</span>
            <span className="wgg-players-fab-badge">{players.length}/{TOTAL_SLOTS}</span>
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
                  <span>Takımlar</span>
                </span>
                <span className="wgg-max-badge wgg-max-badge--sheet">
                  {players.length}/{TOTAL_SLOTS}
                </span>
                <button
                  type="button"
                  className="wgg-ps-close"
                  onClick={() => setPlayersSheetOpen(false)}
                  aria-label="Kapat"
                >
                  ✕
                </button>
              </header>
              <div className="wgg-ps-list">
                <div className="kn-teams-wrap">
                  {renderTeamPanel("blue", () => setPlayersSheetOpen(false))}
                  {renderTeamPanel("red", () => setPlayersSheetOpen(false))}
                </div>
              </div>
              {!canStart && (
                <div className="wgg-ps-warning">
                  Takımlar eşit olmalı: 2v2, 3v3, 4v4 veya 5v5 oynanabilir.
                </div>
              )}
            </div>
          </div>
        )}
        </>
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
          <div className="dgg-confirm-modal" onClick={e => e.stopPropagation()}>
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
          onClick={() => { setKickedNoticeOpen(false); onHome(); }}
        >
          <div className="dgg-confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="dgg-confirm-icon">🚪</div>
            <h3>Odadan Çıkarıldın</h3>
            <p>Oda sahibi seni odadan çıkardı.</p>
            <div className="dgg-confirm-actions single">
              <button
                type="button"
                className="btn btn-accent"
                onClick={() => { setKickedNoticeOpen(false); onHome(); }}
              >
                Tamam
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ ROOM CLOSED NOTICE ════════ */}
      {roomClosedNoticeOpen && (
        <div
          className="dgg-confirm-backdrop"
          onClick={() => { setRoomClosedNoticeOpen(false); onHome(); }}
        >
          <div className="dgg-confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="dgg-confirm-icon">🏠</div>
            <h3>Oda Kapatıldı</h3>
            <p>Ev sahibi odayı kapattı.</p>
            <div className="dgg-confirm-actions single">
              <button
                type="button"
                className="btn btn-accent"
                onClick={() => { setRoomClosedNoticeOpen(false); onHome(); }}
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
