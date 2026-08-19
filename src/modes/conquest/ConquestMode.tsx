/**
 * ConquestMode — orchestrates the Kuşatma flow against Supabase.
 *
 *   setup      → ConquestSetup        (room creation form)
 *   rooms      → ConquestRoomList     (browse open public rooms)
 *   join-code  → ConquestJoinByCode   (paste 6-char room code)
 *   joining    → loading screen       (auto-join from invite link)
 *   lobby      → ConquestLobby        (3-panel waiting room, realtime)
 *   game       → ConquestGame         (placeholder game screen)
 *
 * Phase 5 wires room state to public.conquest_rooms / public.conquest_players
 * with realtime subscriptions.  Each lobby owns a single Supabase channel
 * filtered by room id — no global fan-out — so the design scales to many
 * small rooms.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getGuestName, setGuestName, linkGuestPlayerToAccount } from "../../lib/guestSession";
import { EmojiIcon } from "../../components/EmojiIcon";
import type { Profile } from "../../lib/auth";
import { playSound } from "../../lib/sound";
import { useRoomExitHandler } from "../../lib/roomExit";
import {
  getThemeBackgroundStyle,
  getThemeDataAttr,
  readStoredHomeTheme,
} from "../../lib/themeBackgrounds";
// NOT: bu ekran artık `supabase` istemcisini DOĞRUDAN kullanmaz. Kuşatma oda
// verisinin tek okuma yolu conquestService'teki yetkili RPC sarmalayıcılarıdır
// (20260810120000: ham conquest_rooms / conquest_players sorgusu `anon` rolüne
// kapalıdır).
import type {
  ConquestPlayerRow,
  ConquestRoomRow,
} from "../../lib/supabase";
import ConquestSetup from "./ConquestSetup";
import ConquestLobby from "./ConquestLobby";
import ConquestRoomList from "./ConquestRoomList";
import ConquestGame from "./ConquestGame";
import ConquestJoinByCode from "./ConquestJoinByCode";
import {
  CONQUEST_DEFAULT_SETTINGS,
  CONQUEST_MIN_PLAYERS,
  mapLabel,
  type ConquestBonusDistribution,
  type ConquestMapId,
  type ConquestMaxPlayers,
  type ConquestPlayer,
  type ConquestPlayerColor,
  type ConquestRegionBonusType,
  type ConquestRoomSettings,
  type ConquestRoundCount,
  type ConquestTeamId,
  type ConquestTeamMode,
} from "./types";
import {
  EMPTY_LOBBY_BROADCAST_STATE,
  applyVoteToggle,
  clearPlayerVotes,
  subscribeLobbyBroadcast,
  type ConquestLobbyBroadcastHandle,
  type ConquestLobbyBroadcastState,
} from "./conquestLobbyBroadcast";
import { resolveActiveBonusTypesFromVotes, voteBonusCountForPlayers } from "./bonusPool";
import {
  cancelConquestQuickMatch,
  conquestQuickMatchTick,
  createConquestRoom,
  fetchConquestPlayers,
  fetchConquestRoomWithPlayers,
  heartbeatConquestPlayer,
  joinConquestRoomByCode,
  leaveConquestRoom,
  resetConquestQuickMatch,
  selectConquestTeam,
  setConquestTeamMode,
  shuffleConquestTeams,
  updateConquestPlayerColor,
  updateConquestRoomSettings,
  type ConquestJoinResult,
} from "./conquestService";
import {
  resolveConquestJoinFailure,
  type ConquestJoinDraft,
  type ConquestJoinOrigin,
} from "./conquestJoinFlow";
import type { ConquestJoinFormError } from "./ConquestJoinByCode";
import { freshConquestPlayerId } from "./utils";
import { recallConquestClaim } from "./conquestClaim";
import { quickMatchBracket, quickMatchBracketLabel } from "../../lib/quickMatch";
import { subscribeToConquestRoom } from "./conquestRealtime";
import { getConquestMapConfig } from "./maps";
import { createInitialConquestGameState } from "./conquestGameplay";
import {
  fetchConquestServerTimeOffset,
  initConquestClockSync,
  isConquestClockSynced,
} from "./conquestClock";
import {
  deserializeConquestGameState,
  initializeConquestGameplayState,
  updateConquestGameplayState,
} from "./conquestGameSync";
import type { ConquestGameState } from "./types";

type Phase = "setup" | "rooms" | "join-code" | "joining" | "lobby" | "game" | "qm-searching";

interface Props {
  initialPhase: "setup" | "rooms" | "join-code" | "create";
  profile:      Profile | null;
  onHome:       () => void;
  /** Hızlı Eşleş (native/mobil-web) 1v1: when present the screen mounts into
   *  the quick-match search instead of the setup/create flow. Türkiye-only map
   *  is enforced both here and server-side (conquest_quick_match RPC). */
  autoQuickMatch?: { rounds: number; map: "turkey" } | null;
  /** Fired once the search actually kicks off, so App can clear the intent. */
  onQuickMatchConsumed?: () => void;
  /** Misafir "Odalara Göz At" ekranına düştü → App giriş/kayıt modalını açar
   *  ve bekleyen işlemi saklar (giriş sonrası liste ekranına döner). */
  onAuthRequired?: (choice: "login" | "signup") => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row → UI mappers
// ─────────────────────────────────────────────────────────────────────────────

function roomToSettings(room: ConquestRoomRow): ConquestRoomSettings {
  return {
    map:        room.map_id as ConquestMapId,
    maxPlayers: room.max_players as ConquestMaxPlayers,
    rounds:     room.round_count as ConquestRoundCount,
    visibility: room.visibility,
    teamMode:   (room.team_mode ?? "individual") as ConquestTeamMode,
  };
}

function rowToPlayer(row: ConquestPlayerRow): ConquestPlayer {
  return {
    id:     row.id,
    name:   row.name,
    profileId: row.profile_id ?? null,
    isHost: row.is_host,
    color:  (row.color ?? undefined) as ConquestPlayerColor | undefined,
    teamId: (row.team_id ?? null) as ConquestTeamId | null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function ConquestMode({ initialPhase, profile, onHome, autoQuickMatch = null, onQuickMatchConsumed, onAuthRequired }: Props) {
  // Mount snapshot: qmTick reads rounds/map repeatedly, so capture once. App
  // clears the live prop after onQuickMatchConsumed; the ref keeps the search
  // alive while the cleared prop prevents a stale auto-search on re-entry.
  const autoQuickMatchRef = useRef(autoQuickMatch);

  const [phase, setPhase] = useState<Phase>(
    autoQuickMatch
      ? "qm-searching"
      : initialPhase === "create" ? "joining" : initialPhase,
  );

  // Active room state — populated when phase ∈ { lobby, game }.
  const [roomRow,     setRoomRow]     = useState<ConquestRoomRow | null>(null);
  const [playerRows,  setPlayerRows]  = useState<ConquestPlayerRow[]>([]);
  const [myPlayerId,  setMyPlayerId]  = useState<string | null>(null);
  const [statusMsg,   setStatusMsg]   = useState<string | null>(null);
  const [hostClosed,  setHostClosed]  = useState(false);

  // ── Post-match return-to-lobby flow ────────────────────────────────────
  // Shown when a player still on the finished panel clicks "Lobiye Dön"
  // AFTER the host has already started the next game without them.  The
  // body offers Ana Menüye Dön / Tamam — no auto spectator (V1).
  const [lateReturnModalOpen, setLateReturnModalOpen] = useState(false);
  // Soft banner shown to the new host or remaining players when the host
  // role transfers due to a leave.  Auto-clears after a few seconds.
  const [hostTransferBanner, setHostTransferBanner] = useState<string | null>(null);
  // Inline error surfaced when the host clicks "Yeni Oyunu Başlat" but
  // fewer than CONQUEST_MIN_PLAYERS have returned to lobby.
  const [startBlockedMsg, setStartBlockedMsg] = useState<string | null>(null);
  // 2v2 Takımlı mod — geçici bilgilendirme (örn. "Bu takım dolu.").
  const [teamNotice, setTeamNotice] = useState<string | null>(null);

  // Lobby-only ephemeral state: bonus distribution mode + per-player votes.
  // Synced via Supabase Realtime broadcast (see conquestLobbyBroadcast.ts).
  // Not persisted in any table and intentionally not wired into match start
  // yet — gameplay binding lands in a follow-up.
  const [lobbyExtra, setLobbyExtra] = useState<ConquestLobbyBroadcastState>(EMPTY_LOBBY_BROADCAST_STATE);
  const lobbyExtraRef    = useRef<ConquestLobbyBroadcastState>(lobbyExtra);
  useEffect(() => { lobbyExtraRef.current = lobbyExtra; }, [lobbyExtra]);
  // GÜVENLİK (T-02): public lobi kanalından gelen playerId'leri DB'den bilinen
  // oyuncu listesine karşı doğrulamak için. Ref, realtime callback'lerindeki
  // stale-closure tuzağını önler (aynı desen: lobbyExtraRef).
  const playerRowsRef    = useRef<ConquestPlayerRow[]>(playerRows);
  useEffect(() => { playerRowsRef.current = playerRows; }, [playerRows]);
  const lobbyChannelRef  = useRef<ConquestLobbyBroadcastHandle | null>(null);

  // Refs that mirror state — read inside realtime callbacks where stale
  // closures would otherwise trip us up.
  const myPlayerIdRef = useRef<string | null>(null);
  const phaseRef      = useRef<Phase>(initialPhase === "create" ? "joining" : initialPhase);
  const roomRowRef    = useRef<ConquestRoomRow | null>(null);
  useEffect(() => { myPlayerIdRef.current = myPlayerId; }, [myPlayerId]);
  useEffect(() => { phaseRef.current      = phase;      }, [phase]);
  useEffect(() => { roomRowRef.current    = roomRow;    }, [roomRow]);

  // ── Per-room ephemeral state reset ──────────────────────────────────────
  // `lobbyExtra` (rematch readyPlayerIds, bonus votes, bonus distribution)
  // lives in component state, so without an explicit reset it would carry
  // over when the same user leaves one room and joins/creates another in
  // the same session. The bug surfaced as: brand-new room with all players
  // tagged "Sonuç ekranında" because a stale readyPlayerIds from the
  // previous room made ConquestLobby think it was in rematch mode.
  const prevRoomIdRef = useRef<string | null>(null);
  useEffect(() => {
    const nextId = roomRow?.id ?? null;
    if (prevRoomIdRef.current !== nextId) {
      prevRoomIdRef.current = nextId;
      setLobbyExtra(EMPTY_LOBBY_BROADCAST_STATE);
    }
  }, [roomRow?.id]);

  const isLoggedIn = !!profile?.username;

  // ── Derived UI shapes ────────────────────────────────────────────────────
  const settings = useMemo<ConquestRoomSettings>(
    () => {
      const base = roomRow ? roomToSettings(roomRow) : CONQUEST_DEFAULT_SETTINGS;
      // Bonus distribution is carried on lobby broadcast state, not on the
      // conquest_rooms row — fold it into settings here so the lobby props
      // can stay a single object.  teamMode is persisted on the row.
      return { ...base, bonusDistribution: lobbyExtra.bonusDistribution };
    },
    [roomRow, lobbyExtra.bonusDistribution],
  );

  // playerId → teamId|null lookup, derived from the live conquest_players rows.
  const teamAssignments = useMemo<Record<string, ConquestTeamId | null>>(
    () => {
      const out: Record<string, ConquestTeamId | null> = {};
      for (const r of playerRows) {
        out[r.id] = (r.team_id ?? null) as ConquestTeamId | null;
      }
      return out;
    },
    [playerRows],
  );

  const uiPlayers = useMemo<ConquestPlayer[]>(
    () => playerRows.map(rowToPlayer),
    [playerRows],
  );

  // playerId → last_seen_at ISO timestamp.  Carried into ConquestGame so the
  // host-only "tek aktif oyuncu kalınca otomatik galibiyet" effect can decide
  // whether a player is fresh (heartbeat within the active window) or stale
  // (no heartbeat past the reconnect tolerance).  Updated by the same realtime
  // stream that drives `playerRows`, so it stays consistent with the live
  // roster without a second fetch.
  const lastSeenByPlayerId = useMemo<Record<string, string>>(
    () => {
      const out: Record<string, string> = {};
      for (const r of playerRows) out[r.id] = r.last_seen_at;
      return out;
    },
    [playerRows],
  );

  const me      = useMemo(
    () => playerRows.find(p => p.id === myPlayerId) ?? null,
    [playerRows, myPlayerId],
  );
  const isHost  = !!me?.is_host;
  const myName  = me?.name ?? "";

  /* ── MİSAFİR → KAYITLI HESAP slot devri (Kuşatma, YERİNDE tetikleyici) ───
   * App.tsx'teki auth-flip uzlaştırması Kuşatma'yı da kapsıyor (claim
   * anahtarlarını tarayarak) — bu effect ONUN YERİNE DEĞİL, ÜSTÜNE çalışır ve
   * tek bir ek işi vardır: devirden hemen sonra satırı TAZELEYİP "Misafir"
   * etiketini yeni tur başlamadan düşürmek. Uzlaştırma reload'dan sağ çıkan
   * ağdır; bu ise ekran açıkken anlık geri bildirimdir. İkisi de aynı
   * idempotent RPC'yi çağırdığı için çakışmaları zararsızdır.
   *
   * Koşul: giriş yapılmış + odadaki satırım hâlâ MİSAFİR satırı
   * (profile_id null). Sunucu ayrıca claim_token doğrular; başka birinin
   * slotu devralınamaz. Başarısızlık ölümcül değildir — oyuncu misafir
   * olarak devam eder.
   *
   * REF KİLİDİ YALNIZ KESİN SONUÇTA: eskiden ref denemeden ÖNCE set ediliyordu,
   * yani tek bir geçici ağ hatası devri o oturum boyunca KALICI olarak
   * kaybettiriyordu (audit m2). Artık `error` sonucunda kilit açılıyor ve bir
   * sonraki render/realtime güncellemesi yeniden deniyor.
   *
   * XP AKTARMAZ: misafirken BAŞLAYAN maç, başlangıçta maç kimliğiyle
   * işaretlendiği için (ConquestGame, noteGuestOriginMatch) devirden sonra da
   * ödül yazılmaz; yeni maçlar normal kazanır. */
  const linkAttemptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!profile?.id) return;
    if (!me || me.profile_id) return;          // zaten kayıtlı satır
    if (linkAttemptedRef.current === me.id) return;
    linkAttemptedRef.current = me.id;

    const token = recallConquestClaim(me.id);
    if (!token) return;

    const playerId = me.id;
    const rid = me.room_id;

    void linkGuestPlayerToAccount({
      mode: "conquest",
      playerId,
      claimToken: token,
    }).then((outcome) => {
      // Geçici hata → kilidi AÇ ki tekrar denenebilsin.
      if (outcome.status === "error") {
        if (linkAttemptedRef.current === playerId) linkAttemptedRef.current = null;
        return;
      }
      if (outcome.status !== "linked" || !rid) return;
      // Satırı tazele ki "Misafir" etiketi YENİ TURDAN ÖNCE kalksın.
      void fetchConquestPlayers(rid, playerId).then(rows => {
        if (rows) setPlayerRows(rows);
      });
    });
  }, [profile?.id, me]);

  // ── Mount: detect invite link ?conquest=CODE and auto-join ──────────────
  // Kayıtlı kullanıcı hesap adıyla, MİSAFİR ise GuestJoinScreen'de seçtiği
  // adla otomatik katılır (App.tsx misafiri buraya ancak nick onaylandıktan
  // sonra yönlendirir). Ad hiç yoksa ana ekrana düşülür — bu yalnız doğrudan
  // deep-link kurcalama gibi uç durumlarda olur.
  // Oda KURMA misafire kapalıdır (ConquestSetup + sunucu RLS); yalnız
  // katılma açıktır (conquest_register_player anon'a grant'li).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code   = params.get("conquest");
    if (!code) return;

    // Always strip the param from the URL so a refresh after leaving the
    // lobby doesn't loop the user back into the join flow.
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("conquest");
    window.history.replaceState({}, "", cleanUrl.toString());

    // Also clear the sessionStorage failsafe App.tsx wrote, so refreshes /
    // re-navigations don't retry the join after a failure.
    try { sessionStorage.removeItem("pending_conquest_invite_code"); }
    catch { /* ignore */ }

    const joinName = profile?.username ?? getGuestName() ?? "";
    if (joinName.trim()) {
      void doAutoJoin(code, joinName.trim());
    } else {
      onHome();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Katılma formu taslağı + hatası ──────────────────────────────────────
   * Oda kodu + nick, BAŞARISIZ bir denemeden sonra da yaşamalıdır: sunucu
   * adı reddettiğinde kullanıcı aynı formda kalıp adını düzeltebilmeli,
   * baştan başlamamalı. Taslak "joining" fazını atlatabilmek için burada
   * (form bileşeninin dışında) tutulur — davet linki yolunda form o anda
   * henüz monte bile değildir. */
  const [joinDraft, setJoinDraft] = useState<ConquestJoinDraft>({ code: "", name: "" });
  const [joinError, setJoinError] = useState<ConquestJoinFormError | null>(null);
  /** Katılma isteği uçuşta — form monte kalır, yalnız buton kilitlenir. */
  const [joinBusy,  setJoinBusy]  = useState(false);

  // ── Auto-create: when launched from "Oda Kur" menu button ───────────────
  // Fires once on mount; creates a room with defaults so the user lands
  // straight in the lobby without a redundant settings form.
  const didAutoCreate = useRef(false);
  useEffect(() => {
    if (autoQuickMatch) return;  // Hızlı Eşleş kendi arama akışını sürer.
    if (initialPhase !== "create" || didAutoCreate.current) return;
    didAutoCreate.current = true;
    if (!profile?.username) {
      setStatusMsg("Kuşatma odası kurmak için giriş yapmalısın.");
      setPhase("setup");
      return;
    }
    setStatusMsg("Oda kuruluyor…");
    void createConquestRoom(profile, profile.username, CONQUEST_DEFAULT_SETTINGS).then(result => {
      if (!result.ok) {
        setStatusMsg(result.message);
        setPhase("setup");
        return;
      }
      setRoomRow(result.room);
      setPlayerRows([result.me]);
      setMyPlayerId(result.me.id);
      setStatusMsg(null);
      setPhase("lobby");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Realtime subscription bound to the active room ──────────────────────
  useEffect(() => {
    if (!roomRow?.id) return;
    if (phase !== "lobby" && phase !== "game") return;

    let cancelled = false;

    // Misafirin canlı akışı KAYITLI kullanıcınınkinden farklı taşıyıcı kullanır
    // (postgres_changes yerine sunucu sinyali + yetkili okuma). Bu ayrım
    // conquestRealtime içinde kapsüllenir; buradaki handler'lar aynı kalır.
    const subscription = subscribeToConquestRoom({
      roomId:   roomRow.id,
      playerId: myPlayerIdRef.current,
      isGuest:  !profile?.id,
      handlers: {
      onRoomUpdate: (next) => {
        if (cancelled) return;

        // ── New-game detection (rematch path) ─────────────────────────
        // The host writes a fresh gameplay_state every match start, so a
        // change in the inner `startedAt` tells us a new round began —
        // regardless of whether room.status flipped.  Clients in lobby
        // phase who are part of the new players list transition to game;
        // clients on the (frozen) finished panel are handled by
        // ConquestGame's snapshot lock and the late-return modal.
        const prev      = roomRowRef.current;
        const prevState = deserializeConquestGameState(prev?.gameplay_state);
        const nextState = deserializeConquestGameState(next.gameplay_state);
        const myId      = myPlayerIdRef.current;
        const newMatchStarted =
          !!nextState &&
          nextState.phase !== "finished" &&
          (!prevState || prevState.startedAt !== nextState.startedAt);

        // Host transfer detection — surface a one-shot banner so the new
        // host (and everyone else) knows who's in charge now.  Skipped
        // when the host id is unchanged or when the room is being closed.
        if (
          prev &&
          prev.host_player_id !== next.host_player_id &&
          next.host_player_id != null &&
          next.status !== "closed" &&
          next.status !== "finished"
        ) {
          if (myId && next.host_player_id === myId) {
            setHostTransferBanner("Yeni oda yöneticisi sensin.");
          } else {
            setHostTransferBanner(`Host ayrıldı. Yeni oda yöneticisi: ${next.host_name}`);
          }
        }

        setRoomRow(next);

        // Status-driven transitions
        if (
          (next.status === "closed" || next.status === "finished") &&
          next.host_player_id !== myId
        ) {
          // Someone else closed the room — eject locally.
          setHostClosed(true);
          setRoomRow(null);
          setPlayerRows([]);
          setMyPlayerId(null);
          setPhase("setup");
          return;
        }

        // Fresh match started.
        if (newMatchStarted && nextState) {
          const meInNewGame = !!myId && nextState.players.some(p => p.id === myId);
          if (meInNewGame) {
            // I'm part of this round — go to game screen if I was waiting
            // in lobby.  Clients already in game phase (e.g. host who
            // just clicked start) just see their state update.
            if (phaseRef.current === "lobby") setPhase("game");
          } else {
            // I'm NOT included in this round.  If I'm in lobby view,
            // stay there with the start message; if I'm still on the
            // finished panel, ConquestGame's snapshot lock keeps the
            // old standings visible until I click "Lobiye Dön" and hit
            // the late-return modal.
          }
        }
      },
      onRoomDelete: () => {
        if (cancelled) return;
        if (roomRow.host_player_id !== myPlayerIdRef.current) {
          setHostClosed(true);
          setRoomRow(null);
          setPlayerRows([]);
          setMyPlayerId(null);
          setPhase("setup");
        }
      },
      onPlayersChange: (rows) => {
        if (cancelled) return;
        setPlayerRows(rows);

        // Kick detection: if my row is gone while still in lobby, eject.
        const myId = myPlayerIdRef.current;
        if (myId && !rows.some(r => r.id === myId) && phaseRef.current === "lobby") {
          setMyPlayerId(null);
          setRoomRow(null);
          setPlayerRows([]);
          setPhase("setup");
        }
      },
      },
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
    // profile?.id: misafir oyun ortasında hesap açarsa (torble_link_guest_player)
    // taşıyıcı postgres_changes'e geçmelidir.
  }, [roomRow?.id, phase, profile?.id]);

  // ── Server-clock sync ──────────────────────────────────────────────────
  // Kuşatma's per-match timeline (challenge.startedAt/endsAt, gameIntroEndsAt,
  // duel/action timers) is interpreted on every client.  Local Date.now()
  // drift across machines used to land host and guest on different
  // roundIntroMsRemaining values.  initConquestClockSync samples
  // public.get_server_time_ms() so every client converges on the same epoch
  // reference.  Active while the user is in lobby or game; torn down on
  // leave so unrelated screens don't pay the periodic probe cost.
  useEffect(() => {
    if (phase !== "lobby" && phase !== "game") return;
    const handle = initConquestClockSync();
    return () => handle.dispose();
  }, [phase]);

  // ── Lobby-only broadcast channel (bonus mode + votes) ───────────────────
  // Owns its own Supabase channel separate from the postgres_changes one so
  // ephemeral lobby state never touches the DB.  Only active while phase
  // === "lobby"; tears down on game start or leave.
  const isHostRef = useRef(false);
  useEffect(() => { isHostRef.current = !!me?.is_host; }, [me?.is_host]);

  // Active during BOTH lobby and game phases: the post-match
  // "Lobiye Dön" flow needs to broadcast ready-for-next while the
  // sender is technically still in phase==='game' (rendering the
  // finished panel) and the receiver may be in phase==='lobby'.
  useEffect(() => {
    if (!roomRow?.id) return;
    if (phase !== "lobby" && phase !== "game") return;

    const handle = subscribeLobbyBroadcast({
      roomId:   roomRow.id,
      isHost:   !!me?.is_host,
      // GÜVENLİK (T-02): lobi kanalı PUBLIC. Gelen vote/ready/clear_votes
      // olaylarının adı geçen oyuncusu, DB'den (conquest_players) bilinen
      // listede yoksa yok sayılır. Ref üzerinden okunur → liste değiştikçe
      // kanal yeniden kurulmaz (effect deps'i bilinçli olarak dar).
      isKnownPlayer: (playerId) =>
        playerRowsRef.current.some(p => p.id === playerId),
      getState: () => lobbyExtraRef.current,
      handlers: {
        onSnapshot:    (state) => setLobbyExtra(state),
        onModeChange:  (mode)  => setLobbyExtra(prev => ({ ...prev, bonusDistribution: mode })),
        onVoteToggle:  (payload) => {
          // The host enforces the per-player cap so all clients agree on the
          // outcome; non-host clients always apply the toggle as instructed
          // because vote_toggle senders only ever flip their OWN vote.
          setLobbyExtra(prev => ({
            ...prev,
            votes: applyVoteToggle(prev.votes, payload, voteBonusCountForPlayers(playerRows.length || 0) || 99),
          }));
        },
        onClearVotes:  (playerId) => {
          setLobbyExtra(prev => ({ ...prev, votes: clearPlayerVotes(prev.votes, playerId) }));
        },
        onReadyForNext: ({ playerId, ready }) => {
          setLobbyExtra(prev => {
            const has = prev.readyPlayerIds.includes(playerId);
            if (ready && !has) {
              return { ...prev, readyPlayerIds: [...prev.readyPlayerIds, playerId] };
            }
            if (!ready && has) {
              return { ...prev, readyPlayerIds: prev.readyPlayerIds.filter(id => id !== playerId) };
            }
            return prev;
          });
        },
        onClearReady: () => {
          setLobbyExtra(prev => prev.readyPlayerIds.length === 0
            ? prev
            : { ...prev, readyPlayerIds: [] });
        },
        onRequestSnapshot: () => { /* host auto-responds inside the helper */ },
      },
    });
    lobbyChannelRef.current = handle;

    return () => {
      handle.unsubscribe();
      lobbyChannelRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomRow?.id, phase, me?.is_host]);

  // ── Heartbeat: keep conquest_players.last_seen_at fresh ────────────────
  // Lobby: public oda listesi son 60 sn'de heartbeat atan oyuncuları sayar.
  // Game: in-match "tek aktif oyuncu kalınca otomatik galibiyet" mantığı
  // de aynı 60 sn pencereye yaslanıyor — heartbeat olmadığında 60 sn sonra
  // herkes "stale" görünür ve yanlış otomatik finish tetiklenir. 20 sn'lik
  // ping ikisini de güvenli marjla içeride tutar.
  useEffect(() => {
    if (!roomRow?.id || !myPlayerId) return;
    if (phase !== "lobby" && phase !== "game") return;

    void heartbeatConquestPlayer(myPlayerId);
    const interval = window.setInterval(() => {
      void heartbeatConquestPlayer(myPlayerId);
    }, 20_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [roomRow?.id, myPlayerId, phase]);

  // ── Drop votes for any player who has left the room ─────────────────────
  useEffect(() => {
    if (phase !== "lobby") return;
    const alive = new Set(playerRows.map(p => p.id));
    const stale = Object.keys(lobbyExtra.votes).filter(pid => !alive.has(pid));
    if (stale.length === 0) return;
    setLobbyExtra(prev => {
      let next = prev.votes;
      for (const pid of stale) next = clearPlayerVotes(next, pid);
      return { ...prev, votes: next };
    });
    // Host re-broadcasts the cleaned snapshot so everyone agrees.
    if (isHostRef.current && lobbyChannelRef.current) {
      let next = lobbyExtra.votes;
      for (const pid of stale) next = clearPlayerVotes(next, pid);
      lobbyChannelRef.current.emitSnapshot({ ...lobbyExtra, votes: next });
    }
  }, [playerRows, lobbyExtra, phase]);

  // ─────────────────────────────────────────────────────────────────────────
  // Actions
  // ─────────────────────────────────────────────────────────────────────────

  const handleCreateRoom = useCallback(
    async (playerName: string, s: ConquestRoomSettings) => {
      if (!profile) {
        setStatusMsg("Kuşatma odası kurmak için giriş yapmalısın.");
        return;
      }
      setStatusMsg("Oda kuruluyor…");
      setPhase("joining");

      const result = await createConquestRoom(profile, playerName, s);
      if (!result.ok) {
        setStatusMsg(null);
        setPhase("setup");
        // Surface as a transient error via host-closed flag isn't quite right;
        // simplest: lean on browser alert sparingly (matches existing patterns).
        // Reuse setStatusMsg as a soft inline message instead.
        setStatusMsg(result.message);
        return;
      }

      setRoomRow(result.room);
      setPlayerRows([result.me]);
      setMyPlayerId(result.me.id);
      setStatusMsg(null);
      setPhase("lobby");
    },
    [profile],
  );

  /**
   * Katılma sonucunu uygula.
   *
   * BAŞARI dalı değişmedi: oda + oyuncu listesi yazılır, lobiye geçilir.
   *
   * HATA dalı ESKİDEN koşulsuz `setPhase("setup")` diyordu. Sonucu: sunucu
   * görünen adı reddettiğinde (örn. `registered_username_taken`) oyuncu oda
   * kodu + nick formundan DÜŞÜP "Oda Kur" ekranına atılıyordu — yazdığı kod
   * ve nick de form unmount olduğu için siliniyordu. Artık nereye dönüleceği
   * kararı saf `resolveConquestJoinFailure`e aittir: kullanıcı GELDİĞİ
   * ekranda kalır, yazdıkları taslakta korunur, hata yerinde gösterilir.
   */
  const applyJoinResult = useCallback((
    result:    ConquestJoinResult,
    origin:    ConquestJoinOrigin,
    attempted: ConquestJoinDraft,
  ) => {
    if (!result.ok) {
      const outcome = resolveConquestJoinFailure(origin, attempted, result);
      setJoinDraft(outcome.draft);
      setJoinError({
        message:   outcome.message,
        focusName: outcome.focusName,
        at:        Date.now(),
      });
      setJoinBusy(false);
      // Formda hata inline gösterilir; oda listesinde üstteki banner taşır.
      setStatusMsg(outcome.phase === "rooms" ? outcome.message : null);
      setPhase(outcome.phase);
      return;
    }
    // Misafir DÜZELTİLMİŞ adıyla girdiyse o ad hatırlansın — aksi hâlde bir
    // sonraki davet linki reddedilen eski adı tekrar dener. Kaynak sunucunun
    // döndürdüğü satırdır (profile_id NULL ⇒ misafir), istemci tahmini değil.
    if (!result.me.profile_id && result.me.name) setGuestName(result.me.name);

    setJoinError(null);
    setJoinBusy(false);
    setRoomRow(result.room);
    setPlayerRows(result.players);
    setMyPlayerId(result.me.id);
    setStatusMsg(null);
    setPhase("lobby");
  }, []);

  /** Davet linki / çözümlenmiş oda kodu → otomatik katılma. Form henüz monte
   *  değil, o yüzden tam ekran "bağlanılıyor" paneli gösterilir; hata olursa
   *  kod + nick DOLU olarak katılma formuna düşülür (ana menüye DEĞİL). */
  const doAutoJoin = useCallback(
    async (code: string, displayName: string) => {
      setStatusMsg("Odaya bağlanılıyor…");
      setJoinError(null);
      setPhase("joining");
      const result = await joinConquestRoomByCode(code, {
        profile,
        name:    displayName,
        source:  "invite",
      });
      applyJoinResult(result, "invite", { code, name: displayName });
    },
    [profile, applyJoinResult],
  );

  /** "Oda Koduyla Katıl" formu. Faz KASTEN değiştirilmez — form monte kalır,
   *  böylece hata dönerse kod, nick ve odak olduğu gibi durur. */
  const handleJoinByCode = useCallback(
    async (code: string, displayName: string) => {
      setJoinDraft({ code, name: displayName });
      setJoinError(null);
      setStatusMsg(null);
      setJoinBusy(true);
      const result = await joinConquestRoomByCode(code, {
        profile,
        name:    displayName,
        source:  "code",
      });
      applyJoinResult(result, "code", { code, name: displayName });
    },
    [profile, applyJoinResult],
  );

  /** Açık oda listesinden katılma (yalnız girişli kullanıcı). Hata olursa
   *  liste ekranında kalınır, banner hatayı gösterir. */
  const handleJoinFromList = useCallback(
    async (code: string) => {
      if (!profile?.username) return;
      setStatusMsg("Odaya katılınıyor…");
      setJoinError(null);
      setPhase("joining");
      const result = await joinConquestRoomByCode(code, {
        profile,
        name:    profile.username,
        source:  "public",
      });
      applyJoinResult(result, "public", { code, name: profile.username });
    },
    [profile, applyJoinResult],
  );

  const handleLeaveLobby = useCallback(async () => {
    playSound("click");
    const roomId = roomRow?.id;
    const meId   = myPlayerIdRef.current;
    const wasHost = isHost;

    setRoomRow(null);
    setPlayerRows([]);
    setMyPlayerId(null);
    setStatusMsg(null);
    setPhase("setup");

    if (roomId && meId) {
      await leaveConquestRoom(roomId, meId, wasHost);
    }
  }, [roomRow?.id, isHost]);

  /**
   * Finished-panel "Lobiye Dön" — solo transition.
   *
   * The player stays in the room (no DB delete, no status flip) and just
   * switches their own view to the lobby.  A broadcast tells everyone
   * (host included) that this player is ready to be folded into the next
   * match.  If the host has already started the next game without us,
   * surface the late-return info modal instead.
   */
  const handleReturnToLobby = useCallback(() => {
    if (!myPlayerId) return;
    playSound("click");

    // Check the live gameplay_state, not stale closure state — by the time
    // a slow player taps the button, the host's start may have landed.
    const liveState = deserializeConquestGameState(roomRowRef.current?.gameplay_state);
    const newRoundInFlight =
      !!liveState &&
      liveState.phase !== "finished" &&
      !liveState.players.some(p => p.id === myPlayerId);

    if (newRoundInFlight) {
      setLateReturnModalOpen(true);
      return;
    }

    setLobbyExtra(prev => prev.readyPlayerIds.includes(myPlayerId)
      ? prev
      : { ...prev, readyPlayerIds: [...prev.readyPlayerIds, myPlayerId] });
    lobbyChannelRef.current?.emitReadyForNext(myPlayerId);
    setStartBlockedMsg(null);
    setPhase("lobby");
  }, [myPlayerId]);

  /**
   * Mid-game "Odadan Ayrıl" — leaves the room outright.
   *
   * Used by the in-progress back button and the leave-confirmation modal.
   * Host transfer is handled server-side by conquest_leave_room.
   */
  const handleLeaveRoomFromGame = useCallback(async () => {
    await handleLeaveLobby();
  }, [handleLeaveLobby]);

  /* Davet kabulünde güvenli çıkış (bkz. lib/roomExit.ts). Bu modda lobi ve
   * savaş için ayrılma semantiği ZATEN aynı: `handleLeaveRoomFromGame` de
   * `handleLeaveLobby`ye delege ediyor → conquest_leave_room (host ise oda
   * status='closed', değilse self-delete; sunucuda). Yeni mantık yok. */
  useRoomExitHandler("conquest", {
    canExit: () => !!roomRowRef.current?.id && !!myPlayerIdRef.current,
    exit: handleLeaveRoomFromGame,
  });

  const handleStartGame = useCallback(async () => {
    if (!roomRow || !isHost) return;
    const mapConfig = getConquestMapConfig(settings.map);
    if (!mapConfig) return;

    // ── Filter participants to "ready" players only ─────────────────
    // First-start path: nobody is "ready" yet (no prior match), so we
    // fall back to the full player roster — same as before.  Rematch
    // path: only players who clicked "Lobiye Dön" from the finished
    // panel make it in; stragglers on the result screen are skipped.
    // The host gets into readyPlayerIds through their own
    // handleReturnToLobby call, so no silent host-auto-include — that
    // would make the UI roster (which uses the same set) drift from the
    // actual game start filter.
    const ready = new Set(lobbyExtra.readyPlayerIds);
    const isRematch = ready.size > 0;
    const includedPlayers = isRematch
      ? uiPlayers.filter(p => ready.has(p.id))
      : uiPlayers;

    // 2v2 Takımlı mod start gate (Layer 1):
    //   • Kapasite 4 olmalı
    //   • 4 aktif oyuncu olmalı
    //   • 2 Mavi + 2 Kırmızı
    const teamMode = (roomRow.team_mode ?? "individual") as ConquestTeamMode;
    if (teamMode === "teams_2v2") {
      if (roomRow.max_players !== 4) {
        setStartBlockedMsg("2v2 Takımlı mod için oda kapasitesi 4 olmalı.");
        return;
      }
      if (includedPlayers.length !== 4) {
        setStartBlockedMsg("2v2 Takımlı mod için 4 oyuncu gerekli.");
        return;
      }
      const blue = includedPlayers.filter(p => teamAssignments[p.id] === 1).length;
      const red  = includedPlayers.filter(p => teamAssignments[p.id] === 2).length;
      if (blue !== 2 || red !== 2) {
        setStartBlockedMsg("Takımlı mod için takımlar 2'ye 2 olmalı.");
        return;
      }
    } else if (includedPlayers.length < CONQUEST_MIN_PLAYERS) {
      setStartBlockedMsg(
        `Yeni oyun için en az ${CONQUEST_MIN_PLAYERS} aktif oyuncu gerekli.`,
      );
      return;
    }

    setStartBlockedMsg(null);

    // Best-effort: make sure the server-clock offset is fresh before we
    // stamp the initial gameplay state's wall-clock timestamps.  The init
    // effect already started a periodic refresh when the host entered the
    // lobby, so by this point we almost always have a value; the await is
    // a defensive top-up for tabs that just resumed from background.  If
    // the probe fails, we fall through to Date.now() — same as pre-fix for
    // this one tab, with a console.warn surfacing the regression.
    if (!isConquestClockSynced()) {
      await fetchConquestServerTimeOffset();
    }

    const selectedBonusTypes =
      lobbyExtra.bonusDistribution === "vote"
        ? resolveActiveBonusTypesFromVotes(
            lobbyExtra.votes,
            includedPlayers.length,
            Date.now(),
          )
        : undefined;
    const initialState = createInitialConquestGameState(
      mapConfig,
      includedPlayers,
      settings.rounds,
      selectedBonusTypes,
    );

    // Layer 1: takım moduyla başlatılan oyunlarda gameState'e back-compat
    // takım metadatasını yaz.  Gameplay henüz bu alanları kullanmıyor;
    // Layer 2'de saldırı yasağı / skor / kazanan vb. burada okunacak.
    if (teamMode === "teams_2v2") {
      initialState.teamMode = "teams_2v2";
      const assignments: Record<string, ConquestTeamId> = {};
      for (const p of includedPlayers) {
        const tid = teamAssignments[p.id];
        if (tid === 1 || tid === 2) assignments[p.id] = tid;
      }
      initialState.teamAssignments = assignments;
    }

    const updated = await initializeConquestGameplayState(roomRow.id, initialState);
    if (updated) {
      setRoomRow(updated);
      // Clear the local ready set on the host immediately AND broadcast
      // so every client drops the previous match's ready flags before
      // the new finished panel can collect a fresh set.
      setLobbyExtra(prev => prev.readyPlayerIds.length === 0
        ? prev
        : { ...prev, readyPlayerIds: [] });
      lobbyChannelRef.current?.emitClearReady();
      setPhase("game");
    }
  }, [roomRow, isHost, settings.map, settings.rounds, uiPlayers, lobbyExtra, teamAssignments]);

  // ════════════════════════════════════════════════════════════════════════
  // Hızlı Eşleş (Quick Match) — 1v1 arama akışı (native / mobil-web)
  // ----------------------------------------------------------------------------
  // Düello deseninin Kuşatma karşılığı: client tick'ler, conquest_quick_match
  // RPC iki bekleyeni atomik eşleştirip status='waiting' oda + 2 oyuncu kurar.
  // Eşleşince host istemci (host_player_id === myPlayerId) mevcut handleStartGame
  // ile ilk gameplay_state'i yazar; karşı taraf realtime status='playing' ile
  // oyuna geçer. Yeni oda/queue sistemi YOK — canonical conquest_rooms akışı.
  // ════════════════════════════════════════════════════════════════════════
  const QM_TICK_MS = 3000;
  const [qmSearchSeconds, setQmSearchSeconds] = useState(0);
  const [qmError,         setQmError]         = useState<string | null>(null);
  // true: eşleşme bulundu, host başlatması bekleniyor → lobby UI yerine
  // "başlıyor" paneli göster. phase 'game' olunca temizlenir (maç sonrası
  // lobiye dönüşte normal lobby/rövanş görünsün).
  const [qmActive,        setQmActive]        = useState(false);
  const qmTickRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const qmSecondsRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const qmStartMsRef     = useRef(0);
  const qmAbortRef       = useRef(false);
  const qmMatchedRef     = useRef(false);
  const qmPlayerIdRef    = useRef<string>("");
  const qmAutoStartedRef = useRef(false);

  const stopQmTimers = useCallback(() => {
    if (qmTickRef.current)    { clearInterval(qmTickRef.current);    qmTickRef.current = null; }
    if (qmSecondsRef.current) { clearInterval(qmSecondsRef.current); qmSecondsRef.current = null; }
  }, []);

  const qmTick = useCallback(async () => {
    if (qmAbortRef.current || qmMatchedRef.current) return;
    const intent = autoQuickMatchRef.current;
    if (!profile?.id || !profile.username || !intent) return;

    const elapsed = Math.floor((Date.now() - qmStartMsRef.current) / 1000);
    const { result, error } = await conquestQuickMatchTick({
      profileId:    profile.id,
      playerId:     qmPlayerIdRef.current,
      playerName:   (profile.username ?? "").trim(),
      roundCount:   intent.rounds,
      mapId:        intent.map,
      maxLevelDiff: quickMatchBracket(elapsed),
    });
    if (qmAbortRef.current || qmMatchedRef.current) return;

    if (error) {
      setQmError("Hızlı eşleş hatası: " + error);
      stopQmTimers();
      return;
    }
    if (result?.matched && result.room_id && result.my_player_id) {
      qmMatchedRef.current = true;
      stopQmTimers();
      const loaded = await fetchConquestRoomWithPlayers(result.room_id, result.my_player_id);
      if (qmAbortRef.current) return;
      if (!loaded) { setQmError("Oda yüklenemedi."); return; }
      setRoomRow(loaded.room);
      setPlayerRows(loaded.players);
      setMyPlayerId(result.my_player_id);
      setQmActive(true);
      setPhase("lobby");  // realtime aboneliğini açar; host otomatik başlatır
    }
  }, [profile?.id, profile?.username, stopQmTimers]);

  const cancelQuickMatch = useCallback(async () => {
    qmAbortRef.current = true;
    stopQmTimers();
    setQmSearchSeconds(0);
    setQmError(null);
    if (profile?.id) await cancelConquestQuickMatch(profile.id);
    onHome();
  }, [profile?.id, stopQmTimers, onHome]);

  // Arama başlat: autoQuickMatch + giriş hazır olunca (bir kez). Profil OAuth
  // dönüşünde geç gelebilir → effect profile'a bağlı, ref ile tek-sefer guard'lı
  // (login gelene kadar qm-searching ekranında bekler, home'a bouncE etmez).
  const qmStartedRef = useRef(false);
  useEffect(() => {
    if (qmStartedRef.current || !autoQuickMatchRef.current) return;
    if (!profile?.id || !profile.username) return;
    qmStartedRef.current = true;

    qmAbortRef.current    = false;
    qmMatchedRef.current  = false;
    qmPlayerIdRef.current = freshConquestPlayerId();
    qmStartMsRef.current  = Date.now();
    setQmSearchSeconds(0);
    setQmError(null);

    const profileId = profile.id;
    void (async () => {
      // Önceki bitmiş/iptal maçtan kalan stale satırı temizle (cancel matched
      // satırı bırakır; reset koşulsuz siler).
      await resetConquestQuickMatch(profileId);
      if (qmAbortRef.current) return;
      qmSecondsRef.current = setInterval(() => {
        setQmSearchSeconds(Math.floor((Date.now() - qmStartMsRef.current) / 1000));
      }, 1000);
      await qmTick();
      if (qmAbortRef.current || qmMatchedRef.current) return;
      qmTickRef.current = setInterval(() => { void qmTick(); }, QM_TICK_MS);
    })();

    onQuickMatchConsumed?.();
  }, [profile?.id, profile?.username, qmTick, onQuickMatchConsumed]);

  // Unmount: arama timer'larını temizle (ekrandan ayrılırken sızıntı olmasın).
  useEffect(() => () => { qmAbortRef.current = true; stopQmTimers(); }, [stopQmTimers]);

  // Host auto-start: eşleşince host istemci ilk gameplay_state'i yazar — el
  // değmeden. handleStartGame içeride setPhase('game') yapar; karşı taraf
  // realtime ile geçer. Ref tek-sefer guard'ı, çift yazımı engeller.
  useEffect(() => {
    if (!qmActive || qmAutoStartedRef.current) return;
    if (phase !== "lobby" || !roomRow || !isHost) return;
    if (roomRow.status !== "waiting") return;
    if (playerRows.length < CONQUEST_MIN_PLAYERS) return;
    qmAutoStartedRef.current = true;
    void handleStartGame();
  }, [qmActive, phase, roomRow, isHost, playerRows.length, handleStartGame]);

  // phase 'game' olunca quick-match overlay'ini bırak (maç sonrası normal lobby).
  useEffect(() => {
    if (phase === "game" && qmActive) setQmActive(false);
  }, [phase, qmActive]);

  /**
   * Push a new gameplay snapshot to Supabase.  Centralised here so
   * ConquestGame can stay pure (controlled component); all DB writes flow
   * through this single helper.  Realtime echoes the update back to every
   * client (including the writer) so the UI re-renders from the canonical
   * row, not from optimistic local state.
   */
  const handlePushGameplayState = useCallback(
    async (next: ConquestGameState) => {
      if (!roomRow || !myPlayerId) return;
      await updateConquestGameplayState(roomRow.id, myPlayerId, next);
    },
    [roomRow, myPlayerId],
  );

  // Decoded gameplay state from the synced room row.  Null while the room
  // is still in lobby or while the first state write is in flight.
  const syncedGameState = useMemo<ConquestGameState | null>(
    () => deserializeConquestGameState(roomRow?.gameplay_state),
    [roomRow?.gameplay_state],
  );

  // ── Rematch lobby detection ────────────────────────────────────────────
  // Drives the "Hazır X/Y" counter + per-player "Sonuç ekranında" tags in
  // ConquestLobby. We derive it from the canonical row state rather than
  // from `readyPlayerIds.length > 0`, so a stale ready-set carried in by
  // bug or a transient broadcast cannot accidentally flip a fresh lobby
  // into rematch mode. Reset to false the moment a new gameplay_state is
  // initialized (initializeConquestGameplayState writes a non-finished
  // phase), and re-armed automatically when the next match ends.
  const rematchMode = syncedGameState?.phase === "finished";

  const handleChangeColor = useCallback(
    async (color: ConquestPlayerColor) => {
      if (!roomRow || !myPlayerId) return;
      // Optimistic local update so the picker feels instant; realtime echo
      // confirms (or replaces) it within a frame.
      setPlayerRows(prev =>
        prev.map(r => (r.id === myPlayerId ? { ...r, color } : r)),
      );
      const result = await updateConquestPlayerColor(roomRow.id, myPlayerId, color);
      if (!result.ok) {
        // Roll back optimistic write and surface the reason in the banner.
        const refreshed = await fetchConquestPlayers(roomRow.id, myPlayerId);
        if (refreshed) setPlayerRows(refreshed);
        setStatusMsg(result.message);
      }
    },
    [roomRow, myPlayerId],
  );

  const handleChangeBonusDistribution = useCallback(
    (mode: ConquestBonusDistribution) => {
      if (!isHost) return;
      setLobbyExtra(prev => {
        // Flipping back to "random" wipes votes so a future "vote" toggle
        // starts from a clean slate.
        if (mode === "random") {
          return { bonusDistribution: mode, votes: {}, readyPlayerIds: prev.readyPlayerIds };
        }
        return { ...prev, bonusDistribution: mode };
      });
      const handle = lobbyChannelRef.current;
      if (handle) {
        handle.emitModeChange(mode);
        if (mode === "random") {
          // Reset votes everywhere too.
          handle.emitSnapshot({
            bonusDistribution: mode,
            votes: {},
            readyPlayerIds: lobbyExtraRef.current.readyPlayerIds,
          });
        }
      }
    },
    [isHost],
  );

  const handleToggleBonusVote = useCallback(
    (bonusType: ConquestRegionBonusType) => {
      if (!myPlayerId) return;
      const cap = voteBonusCountForPlayers(playerRows.length);
      // Optimistic local apply so the chip feels instant.
      setLobbyExtra(prev => ({
        ...prev,
        votes: applyVoteToggle(prev.votes, { playerId: myPlayerId, bonusType }, cap),
      }));
      lobbyChannelRef.current?.emitVoteToggle({ playerId: myPlayerId, bonusType });
    },
    [myPlayerId, playerRows.length],
  );

  const handleUpdateSettings = useCallback(
    async (patch: Partial<ConquestRoomSettings>) => {
      if (!roomRow || !isHost) return;

      // Guard: maxPlayers cannot drop below current player count.
      if (
        patch.maxPlayers !== undefined &&
        patch.maxPlayers < playerRows.length
      ) {
        return;
      }

      // Kapasite 4 dışına düşerse 2v2 Takımlı modu otomatik bireysele
      // çevir (server-side team_id'leri de temizler).
      const willDropBelow4 =
        patch.maxPlayers !== undefined && patch.maxPlayers !== 4;
      const currentlyTeams = (roomRow.team_mode ?? "individual") === "teams_2v2";

      // Optimistic local update for snappy host UX; realtime UPDATE will
      // confirm.
      const next: ConquestRoomRow = {
        ...roomRow,
        ...(patch.map        !== undefined && { map_id:      patch.map }),
        ...(patch.maxPlayers !== undefined && { max_players: patch.maxPlayers }),
        ...(patch.rounds     !== undefined && { round_count: patch.rounds }),
        ...(patch.visibility !== undefined && { visibility:  patch.visibility }),
        ...(willDropBelow4 && currentlyTeams && { team_mode: "individual" as const }),
      };
      setRoomRow(next);

      await updateConquestRoomSettings(roomRow.id, {
        map:        patch.map,
        maxPlayers: patch.maxPlayers,
        rounds:     patch.rounds,
        visibility: patch.visibility,
      });

      // Kapasite 4 dışına düştü ve halen teams_2v2'ydi → server-side
      // team_mode='individual' set et (RPC team_id'leri temizler).
      if (willDropBelow4 && currentlyTeams && myPlayerId) {
        const result = await setConquestTeamMode(roomRow.id, myPlayerId, "individual");
        if (!result.ok) {
          setTeamNotice(result.message);
        }
      }
    },
    [roomRow, isHost, playerRows.length, myPlayerId],
  );

  // ── 2v2 Takımlı mod handlers ─────────────────────────────────────────────
  const handleChangeTeamMode = useCallback(
    async (mode: ConquestTeamMode) => {
      if (!roomRow || !isHost || !myPlayerId) return;
      if (mode === "teams_2v2" && roomRow.max_players !== 4) {
        setTeamNotice("2v2 Takımlı mod için oda kapasitesi 4 olmalı.");
        return;
      }
      // Optimistic: realtime room update will confirm.
      setRoomRow(prev => prev ? { ...prev, team_mode: mode } : prev);
      const result = await setConquestTeamMode(roomRow.id, myPlayerId, mode);
      if (!result.ok) {
        setTeamNotice(result.message);
        // Rollback: realtime row is authoritative; force a manual reset is
        // not strictly needed because Supabase realtime will echo the actual
        // server state, but we keep the optimistic value for now.
      }
    },
    [roomRow, isHost, myPlayerId],
  );

  const handleSelectTeam = useCallback(
    async (teamId: ConquestTeamId) => {
      if (!roomRow || !myPlayerId) return;
      // Optimistic local update.
      setPlayerRows(prev =>
        prev.map(r => (r.id === myPlayerId ? { ...r, team_id: teamId } : r)),
      );
      const result = await selectConquestTeam(roomRow.id, myPlayerId, teamId);
      if (!result.ok) {
        setTeamNotice(result.message);
        // Roll back from server.
        const refreshed = await fetchConquestPlayers(roomRow.id, myPlayerId);
        if (refreshed) setPlayerRows(refreshed);
      }
    },
    [roomRow, myPlayerId],
  );

  const handleShuffleTeams = useCallback(async () => {
    if (!roomRow || !isHost || !myPlayerId) return;
    const result = await shuffleConquestTeams(roomRow.id, myPlayerId);
    if (!result.ok) {
      setTeamNotice(result.message);
      return;
    }
    // Realtime echo will refresh playerRows; also nudge locally so it's
    // instant for the host.
    if (result.players.length > 0) {
      setPlayerRows(result.players);
    }
  }, [roomRow, isHost, myPlayerId]);

  // Auto-clear the host-transfer banner so it doesn't linger forever.
  useEffect(() => {
    if (!hostTransferBanner) return;
    const t = window.setTimeout(() => setHostTransferBanner(null), 6000);
    return () => window.clearTimeout(t);
  }, [hostTransferBanner]);

  // Auto-clear the team-notice banner.
  useEffect(() => {
    if (!teamNotice) return;
    const t = window.setTimeout(() => setTeamNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [teamNotice]);

  // ── Initial phase prop change (e.g. Home → Browse) ──────────────────────
  useEffect(() => {
    if (autoQuickMatch) return;  // quick-match phase'i kendi yönetir
    if (phase === "lobby" || phase === "game" || phase === "joining" || phase === "qm-searching") return;
    if (initialPhase === "create") return;
    setPhase(initialPhase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPhase]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  const homeTheme  = readStoredHomeTheme();
  const themeStyle = getThemeBackgroundStyle(homeTheme);
  const themeAttr  = getThemeDataAttr(homeTheme);

  // Game screen owns its own full-screen layout.
  if (phase === "game" && roomRow) {
    return (
      <>
        <ConquestGame
          roomCode={roomRow.room_code}
          roomId={roomRow.id}
          settings={settings}
          players={uiPlayers}
          lastSeenByPlayerId={lastSeenByPlayerId}
          gameState={syncedGameState}
          isHost={isHost}
          myPlayerId={myPlayerId}
          profile={profile}
          onPushGameState={handlePushGameplayState}
          onReturnToLobby={handleReturnToLobby}
          onLeaveRoom={handleLeaveRoomFromGame}
        />
        {lateReturnModalOpen && (
          <LateReturnModal
            onHome={() => {
              setLateReturnModalOpen(false);
              void handleLeaveLobby();
              setTimeout(onHome, 0);
            }}
            onDismiss={() => setLateReturnModalOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <div className="app duel-screen cq-screen" style={themeStyle} data-theme={themeAttr}>
      <div className="duel-header">
        <button
          className="back-btn"
          onClick={() => {
            playSound("click");
            // qm-searching → aramayı güvenle iptal et (queue'dan çık) + home.
            // lobby → leave first; otherwise straight home.
            if (phase === "qm-searching") {
              void cancelQuickMatch();
            } else if (phase === "lobby") {
              void handleLeaveLobby();
              setTimeout(onHome, 0);
            } else {
              onHome();
            }
          }}
          title="Ana Menü"
        >
          <span>←</span>
          <span className="back-label">Menü</span>
        </button>

        <div className="duel-header-center">
          <span className="duel-mode-label"><EmojiIcon name="shield" /> Kuşatma</span>
          {phase === "lobby" && roomRow && (
            <>
              <span className="duel-code-badge">#{roomRow.room_code}</span>
              <span className="duel-region-badge">{mapLabel(settings.map)}</span>
            </>
          )}
        </div>

        <div style={{ width: 80 }} />
      </div>

      {/* Transient notification banner: host-closed event or last action error.
          Setup fazında oda kurma formunun üstünde durur; "rooms" fazında da
          gösterilir çünkü açık listeden katılma hatası artık kullanıcıyı
          setup'a atmak yerine listede bırakıyor. */}
      {(phase === "setup" || phase === "rooms") && (hostClosed || statusMsg) && (
        <div className="cq-banner-wrap" role="status">
          <div className="cq-banner">
            <span className="cq-banner-msg">
              {hostClosed ? <><EmojiIcon name="cross-mark" /> Oda sahibi ayrıldığı için oda kapatıldı.</> : statusMsg}
            </span>
            <button
              type="button"
              className="cq-banner-close"
              aria-label="Kapat"
              onClick={() => { setHostClosed(false); setStatusMsg(null); }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Host-transfer banner: shown briefly in the lobby after a leave-
          driven promotion so the new admin (and everyone else) knows. */}
      {phase === "lobby" && hostTransferBanner && (
        <div className="cq-banner-wrap" role="status">
          <div className="cq-banner">
            <span className="cq-banner-msg"><EmojiIcon name="crown" /> {hostTransferBanner}</span>
            <button
              type="button"
              className="cq-banner-close"
              aria-label="Kapat"
              onClick={() => setHostTransferBanner(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Start-blocked notice: host clicked "Yeni Oyunu Başlat" but the
          ready-set has fewer than CONQUEST_MIN_PLAYERS active players. */}
      {phase === "lobby" && startBlockedMsg && (
        <div className="cq-banner-wrap" role="status">
          <div className="cq-banner">
            <span className="cq-banner-msg"><EmojiIcon name="warning" /> {startBlockedMsg}</span>
            <button
              type="button"
              className="cq-banner-close"
              aria-label="Kapat"
              onClick={() => setStartBlockedMsg(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {phase === "setup" && (
        <ConquestSetup
          profile={profile}
          onBack={onHome}
          onCreate={handleCreateRoom}
        />
      )}

      {phase === "rooms" && (
        <ConquestRoomList
          isLoggedIn={isLoggedIn}
          onBack={onHome}
          onCreate={() => setPhase("setup")}
          onJoin={handleJoinFromList}
          onAuthRequired={onAuthRequired}
        />
      )}

      {phase === "join-code" && (
        <ConquestJoinByCode
          profile={profile}
          initialCode={joinDraft.code}
          initialName={joinDraft.name}
          joinError={joinError}
          busy={joinBusy}
          onBack={() => {
            setJoinDraft({ code: "", name: "" });
            setJoinError(null);
            setJoinBusy(false);
            setPhase("setup");
          }}
          onJoin={handleJoinByCode}
        />
      )}

      {phase === "joining" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card cq-setup-card">
            <h2 className="duel-lobby-title"><EmojiIcon name="shield" /> Kuşatma</h2>
            <p className="duel-lobby-desc">{statusMsg ?? "Yükleniyor…"}</p>
          </div>
        </div>
      )}

      {/* Hızlı Eşleş arama ekranı — düello search ekranıyla aynı davranış:
          bekleme arttıkça seviye penceresi genişler, iptal queue'dan çıkarır. */}
      {phase === "qm-searching" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card" style={{ textAlign: "center" }}>
            <h2 className="duel-lobby-title">⚡ Hızlı Eşleş</h2>
            <p className="duel-lobby-desc">
              Seviyene yakın bir rakip aranıyor…
            </p>

            <div style={{
              display: "flex", flexDirection: "column",
              gap: 6, margin: "16px 0", fontSize: 14,
            }}>
              <div>
                <strong>Mod:</strong> Kuşatma{" "}
                <span style={{ opacity: 0.5 }}>·</span>{" "}
                <strong>Tur:</strong> {autoQuickMatchRef.current?.rounds ?? "—"}{" "}
                <span style={{ opacity: 0.5 }}>·</span>{" "}
                <strong>Harita:</strong> {mapLabel("turkey")}
              </div>
              <div style={{ opacity: 0.85 }}>
                Bekleme: {Math.floor(qmSearchSeconds / 60)}:
                {String(qmSearchSeconds % 60).padStart(2, "0")}
                <span style={{ opacity: 0.5 }}> · </span>
                Aralık: {quickMatchBracketLabel(qmSearchSeconds)}
              </div>
            </div>

            <div style={{
              fontSize: 36, margin: "8px 0 16px",
              animation: "wd-spin 1.4s linear infinite",
              display: "inline-block",
            }}>
              🛡️
            </div>

            <div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => { playSound("click"); void cancelQuickMatch(); }}
              >
                ✕ Aramayı İptal Et
              </button>
            </div>

            {qmError && (
              <p className="duel-error" style={{ marginTop: 12 }}>{qmError}</p>
            )}
          </div>
        </div>
      )}

      {/* Eşleşme bulundu → host ilk state'i yazana kadar kısa "başlıyor"
          paneli (ConquestLobby chrome'unu flash etmemek için). */}
      {phase === "lobby" && qmActive && (
        <div className="duel-lobby">
          <div className="duel-lobby-card" style={{ textAlign: "center" }}>
            <h2 className="duel-lobby-title">⚡ Rakip Bulundu!</h2>
            <p className="duel-lobby-desc">Oyun başlıyor…</p>
            <div style={{
              fontSize: 36, margin: "12px 0",
              animation: "wd-spin 1.4s linear infinite",
              display: "inline-block",
            }}>
              🛡️
            </div>
          </div>
        </div>
      )}

      {phase === "lobby" && !qmActive && roomRow && (
        <ConquestLobby
          roomCode={roomRow.room_code}
          hostName={roomRow.host_name}
          myName={myName}
          myPlayerId={myPlayerId}
          settings={settings}
          players={uiPlayers}
          isHost={isHost}
          isLoggedIn={isLoggedIn}
          bonusVotes={lobbyExtra.votes}
          readyPlayerIds={lobbyExtra.readyPlayerIds}
          rematchMode={rematchMode}
          waitingForHost={!isHost && rematchMode && lobbyExtra.readyPlayerIds.includes(myPlayerId ?? "")}
          onUpdateSettings={handleUpdateSettings}
          onChangeBonusDistribution={handleChangeBonusDistribution}
          onToggleBonusVote={handleToggleBonusVote}
          onChangeColor={handleChangeColor}
          onStart={handleStartGame}
          onLeave={handleLeaveLobby}
          teamAssignments={teamAssignments}
          onChangeTeamMode={handleChangeTeamMode}
          onSelectTeam={handleSelectTeam}
          onShuffleTeams={handleShuffleTeams}
          teamNotice={teamNotice}
          onDismissTeamNotice={() => setTeamNotice(null)}
        />
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LateReturnModal — shown when a player clicks "Lobiye Dön" from the finished
// panel AFTER the host has already started the next game without them.
// No spectator option in V1: the user either leaves to home or dismisses and
// keeps idling on their frozen finished screen.
// ─────────────────────────────────────────────────────────────────────────────

interface LateReturnModalProps {
  onHome:    () => void;
  onDismiss: () => void;
}

function LateReturnModal({ onHome, onDismiss }: LateReturnModalProps) {
  return (
    <div
      className="modal-backdrop cq-confirm-leave-backdrop"
      role="presentation"
      onClick={onDismiss}
    >
      <div
        className="modal cq-confirm-leave-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cq-late-return-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="cq-late-return-title" className="cq-confirm-leave-title">
          Yeni oyun başladı
        </h2>
        <p className="cq-confirm-leave-desc">
          Bu lobide yeni oyun başladı. Oyunun bitmesini bekleyebilir veya ana menüye dönebilirsin.
        </p>
        <div className="cq-confirm-leave-actions">
          <button
            type="button"
            className="btn btn-accent cq-confirm-leave-cancel"
            onClick={() => { playSound("click"); onDismiss(); }}
            autoFocus
          >
            Tamam
          </button>
          <button
            type="button"
            className="btn cq-confirm-leave-confirm"
            onClick={() => { playSound("click"); onHome(); }}
          >
            Ana Menüye Dön
          </button>
        </div>
      </div>
    </div>
  );
}
