/**
 * CizimTestMode.tsx — "Çizim Test" prototip modu (arkadaşlarla test amaçlı).
 *
 * Akış: menü (Oda Kur / Kodla Katıl) → kanal-üstü lobi → 10 × 10 sn çizim
 * turu → eşleştirme tahtası → sonuç.
 *
 * MİMARİ (bilinçli prototip kararları):
 *   - DB YOK, migration YOK. Oda = Supabase Realtime kanalı
 *     (`cizim-test:{KOD}`); lobi presence ile, oyun broadcast ile yürür
 *     (Kör Nokta maç-içi kanal deseni). Host otoritedir: kelimeleri seçer,
 *     tahtaları kurar, maç sonunu ilan eder.
 *   - Eşleştirme tahtası event-sourced deterministik state machine'dir
 *     (cizimTestMatch.ts) — tüm client'lar aynı event akışına aynı reducer'ı
 *     uygular; sunucu satırı gerekmez.
 *   - Çizim turları `game_start.t0` (serverClock senkron) takvimiyle yürür;
 *     tur başına ek broadcast yoktur.
 *   - Sayfa yenileme oyunu düşürür (DB'siz oturum) — prototip sınırı.
 *
 * Login: App tarafında ONLINE_GATED_SCREENS ("multi-gate") ile korunur;
 * buraya profil hep dolu gelir (güvence için yine de guard var).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";
import type { Profile } from "../../lib/auth";
import {
  getCountdownSoundMode,
  playSound,
  stopSound,
} from "../../lib/sound";
import {
  getSyncedNowMs,
  initServerClockSync,
} from "../../lib/serverClock";
import { PlayerAvatar } from "../../components/PlayerAvatar";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DrawingCanvas, type DrawingCanvasHandle } from "./DrawingCanvas";
import { pickCizimWords } from "./cizimTestWords";
import {
  applyBoardEvent,
  buildBoardCards,
  createBoard,
  currentPlayer,
  resolveBoard,
  type CtBoardEvent,
  type CtBoardState,
  type CtCard,
  type CtTeam,
} from "./cizimTestMatch";
import "./CizimTest.css";

/* ── Zamanlama sabitleri ── */
const WORD_COUNT = 10;
const DRAW_MS = 10_000; // tur başına çizim süresi
const GAP_MS = 3_000; // turlar arası "kalem bırak" payı (export + yayın)
const INTRO_MS = 4_000; // game_start → ilk tur arası hazırlık sayacı
const FIRST_FLIP_MS = 3_000; // ilk açık kart ikinci seçim penceresi
const IDLE_TURN_MS = 12_000; // hiç kart açmayan oyuncuya sıra pası
const HOST_GRACE_MS = 2_500; // host'un takılan oyuncu adına pas payı
const RESOLVE_CORRECT_MS = 900; // doğru çift gösterim süresi
const RESOLVE_WRONG_MS = 1_500; // yanlış çift gösterim süresi
const COLLECT_TIMEOUT_MS = 5_000; // eksik çizim olsa da maça geç
const JOIN_PROBE_MS = 6_000; // katılımda host presence bekleme süresi (sync gecikebilir)
/* countdown20.mp3 ~19.5 sn; 10 sn'lik turda sondan hizala (bkz. sound.ts). */
const COUNTDOWN_AUDIO_SECONDS = 19.5;
const COUNTDOWN_SEEK_S = Math.max(0, COUNTDOWN_AUDIO_SECONDS - DRAW_MS / 1000);

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPRSTUVYZ23456789";
const ROOM_CODE_LEN = 5;

type Phase =
  | "menu"
  | "lobby"
  | "countdown"
  | "draw"
  | "collect"
  | "match"
  | "finished"
  | "halted";

type GameMode = "1v1" | "2v2";

interface PresenceInfo {
  playerId: string;
  name: string;
  avatarId: string | null;
  team: CtTeam;
  joinedAt: number;
  host: boolean;
  /** Yalnız host'un değeri anlamlıdır — lobide mod seçimini taşır. */
  mode: GameMode;
}

interface RosterPlayer {
  playerId: string;
  name: string;
  avatarId: string | null;
  team: CtTeam;
}

interface GameInfo {
  gameSeq: number;
  mode: GameMode;
  words: string[];
  roster: RosterPlayer[];
  t0: number;
}

interface DrawView {
  stage: "intro" | "draw" | "gap";
  round: number;
  secLeft: number;
}

interface FinishedInfo {
  /** 2v2: kazanan takım. 1v1: null. */
  winnerTeam: CtTeam | null;
  /** 1v1: kazanan oyuncu id'leri (beraberlikte 2 eleman). */
  winnerIds: string[];
  tie: boolean;
}

function makeRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function shuffled<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const TEAM_LABEL: Record<CtTeam, string> = { blue: "Mavi", red: "Kırmızı" };

interface CizimTestModeProps {
  onHome: () => void;
  profile: Profile | null;
}

export default function CizimTestMode({ onHome, profile }: CizimTestModeProps) {
  const myId = profile?.id ?? "";
  const myName = profile?.username ?? "Oyuncu";
  const myAvatar = profile?.avatar_id ?? null;

  const [phase, setPhase] = useState<Phase>("menu");
  const [roomCode, setRoomCode] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [joinInput, setJoinInput] = useState("");
  const [menuNotice, setMenuNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [lobbyPlayers, setLobbyPlayers] = useState<PresenceInfo[]>([]);
  const [myTeam, setMyTeam] = useState<CtTeam>("blue");
  const [hostMode, setHostMode] = useState<GameMode>("1v1");
  const [game, setGame] = useState<GameInfo | null>(null);
  const [drawView, setDrawView] = useState<DrawView>({ stage: "intro", round: 0, secLeft: 4 });
  const [collectedCount, setCollectedCount] = useState(0);
  const [boards, setBoards] = useState<Partial<Record<CtTeam, CtBoardState>>>({});
  const [finished, setFinished] = useState<FinishedInfo | null>(null);
  const [haltedMsg, setHaltedMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  /* Handler'lar (kanal callback'leri) için güncel-durum ref aynaları. */
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const gameRef = useRef(game);
  gameRef.current = game;
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const myTeamRef = useRef(myTeam);
  myTeamRef.current = myTeam;
  const lobbyPlayersRef = useRef(lobbyPlayers);
  lobbyPlayersRef.current = lobbyPlayers;

  const chanRef = useRef<RealtimeChannel | null>(null);
  const presenceRef = useRef<Omit<PresenceInfo, "joinedAt"> & { joinedAt: number } | null>(null);
  const canvasRef = useRef<DrawingCanvasHandle>(null);
  const drawingsRef = useRef<Map<string, string>>(new Map());
  const submittedRef = useRef<Set<number>>(new Set());
  const gameSeqRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const roundSoundRef = useRef(-1);
  const collectDoneRef = useRef(false);
  const matchStartSentRef = useRef(false);
  const gameOverSentRef = useRef(false);
  const finishedRef = useRef(false);
  const joinProbeRef = useRef<number | null>(null);
  /** Bu odada host presence'ını en az bir kez gördük mü? İlk sync çoğu zaman
   *  yalnız KENDİ presence'ımızı içerir — host'u hiç görmeden "host ayrıldı"
   *  kararı verilmez (o karar join probe'unundur). */
  const hostSeenRef = useRef(false);
  /** Oyun ortası kopma tespiti debounce'u: presence flap'ları (geçici eksik
   *  görünüm) maçı yanlışlıkla durdurmasın; eksiklik ~3.5 sn sürerse gerçektir. */
  const haltCheckTimerRef = useRef<number | null>(null);
  const collectTimersRef = useRef<number[]>([]);
  const resolveScheduledRef = useRef<Set<string>>(new Set());
  const resolveTimersRef = useRef<number[]>([]);
  const passTimersRef = useRef<number[]>([]);
  /** Takım başına, sesi çalınmış resolving'in turnSeq'i (çift ses guard'ı). */
  const soundSeqRef = useRef<Partial<Record<CtTeam, number>>>({});

  /* ── Server clock: diğer online modlarla aynı desen ── */
  useEffect(() => {
    const handle = initServerClockSync();
    return () => handle.dispose();
  }, []);

  /* ── Ortak temizlik ── */
  const clearGameTimers = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    collectTimersRef.current.forEach((t) => window.clearTimeout(t));
    collectTimersRef.current = [];
    resolveTimersRef.current.forEach((t) => window.clearTimeout(t));
    resolveTimersRef.current = [];
    passTimersRef.current.forEach((t) => window.clearTimeout(t));
    passTimersRef.current = [];
    stopSound("countdown20");
  }, []);

  const resetGameState = useCallback(() => {
    clearGameTimers();
    drawingsRef.current.clear();
    submittedRef.current.clear();
    roundSoundRef.current = -1;
    collectDoneRef.current = false;
    matchStartSentRef.current = false;
    gameOverSentRef.current = false;
    finishedRef.current = false;
    resolveScheduledRef.current.clear();
    setCollectedCount(0);
    setBoards({});
    setFinished(null);
    setGame(null);
  }, [clearGameTimers]);

  const leaveRoom = useCallback(
    (notice?: string) => {
      if (joinProbeRef.current !== null) {
        window.clearTimeout(joinProbeRef.current);
        joinProbeRef.current = null;
      }
      if (haltCheckTimerRef.current !== null) {
        window.clearTimeout(haltCheckTimerRef.current);
        haltCheckTimerRef.current = null;
      }
      hostSeenRef.current = false;
      if (chanRef.current) {
        void supabase.removeChannel(chanRef.current);
        chanRef.current = null;
      }
      resetGameState();
      setLobbyPlayers([]);
      setRoomCode("");
      setIsHost(false);
      setMyTeam("blue");
      setHostMode("1v1");
      setConnecting(false);
      setMenuNotice(notice ?? null);
      setPhase("menu");
    },
    [resetGameState],
  );

  useEffect(() => {
    return () => {
      // Unmount: kanalı ve zamanlayıcıları bırak.
      if (chanRef.current) void supabase.removeChannel(chanRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      collectTimersRef.current.forEach((t) => window.clearTimeout(t));
      resolveTimersRef.current.forEach((t) => window.clearTimeout(t));
      passTimersRef.current.forEach((t) => window.clearTimeout(t));
      if (joinProbeRef.current !== null) window.clearTimeout(joinProbeRef.current);
      if (haltCheckTimerRef.current !== null) window.clearTimeout(haltCheckTimerRef.current);
      stopSound("countdown20");
    };
  }, []);

  /* ── Broadcast gönderimi ── */
  const send = useCallback((event: string, payload: unknown) => {
    void chanRef.current?.send({ type: "broadcast", event, payload });
  }, []);

  /* ── game_start (host + self-broadcast ile herkes aynı yoldan) ── */
  const handleGameStart = useCallback((p: GameInfo) => {
    gameSeqRef.current = p.gameSeq;
    drawingsRef.current.clear();
    submittedRef.current.clear();
    roundSoundRef.current = -1;
    collectDoneRef.current = false;
    matchStartSentRef.current = false;
    gameOverSentRef.current = false;
    finishedRef.current = false;
    resolveScheduledRef.current.clear();
    soundSeqRef.current = {};
    setCollectedCount(0);
    setBoards({});
    setFinished(null);
    setGame(p);
    setDrawView({ stage: "intro", round: 0, secLeft: Math.ceil(INTRO_MS / 1000) });
    setPhase("countdown");
  }, []);

  /* ── match_start: tahtaları kur ── */
  const handleMatchStart = useCallback(
    (p: {
      gameSeq: number;
      boards: Partial<Record<CtTeam, CtCard[]>>;
      turnOrders: Partial<Record<CtTeam, string[]>>;
    }) => {
      if (p.gameSeq !== gameSeqRef.current) return;
      if (phaseRef.current !== "draw" && phaseRef.current !== "collect") return;
      stopSound("countdown20");
      const next: Partial<Record<CtTeam, CtBoardState>> = {};
      (Object.keys(p.boards) as CtTeam[]).forEach((team) => {
        const cards = p.boards[team];
        const order = p.turnOrders[team];
        if (cards && order) next[team] = createBoard(cards, order);
      });
      setBoards(next);
      setPhase("match");
    },
    [],
  );

  /* ── 1v1 bitişi (deterministik, lokal) + 2v2 host ilanı ──
     setState updater'ları İÇİNDEN çağrılmaz (render sırasında setState
     yasak); boards değişimini izleyen effect'ten tetiklenir. */
  const maybeFinish = useCallback(
    (nextBoards: Partial<Record<CtTeam, CtBoardState>>) => {
      const g = gameRef.current;
      if (!g || finishedRef.current) return;
      if (g.mode === "1v1") {
        const board = nextBoards.blue;
        if (!board?.complete) return;
        finishedRef.current = true;
        const entries = Object.entries(board.pairsByPlayer);
        const best = Math.max(...entries.map(([, n]) => n));
        const winnerIds = entries.filter(([, n]) => n === best).map(([id]) => id);
        setFinished({ winnerTeam: null, winnerIds, tie: winnerIds.length > 1 });
        setPhase("finished");
      } else if (isHostRef.current && !gameOverSentRef.current) {
        // 2v2: iki tahta yarışır; host, İLK tamamlanan tahtayı ilan eder.
        const done = (Object.keys(nextBoards) as CtTeam[]).find(
          (t) => nextBoards[t]?.complete,
        );
        if (done) {
          gameOverSentRef.current = true;
          send("game_over", { gameSeq: gameSeqRef.current, winnerTeam: done });
        }
      }
    },
    [send],
  );

  const handleGameOver = useCallback((p: { gameSeq: number; winnerTeam: CtTeam }) => {
    if (p.gameSeq !== gameSeqRef.current || finishedRef.current) return;
    finishedRef.current = true;
    setFinished({ winnerTeam: p.winnerTeam, winnerIds: [], tie: false });
    setPhase("finished");
  }, []);

  /* ── board_event: reducer'ı uygula + ses ── */
  const handleBoardEvent = useCallback(
    (p: { gameSeq: number; team: CtTeam; ev: CtBoardEvent }) => {
      if (p.gameSeq !== gameSeqRef.current) return;
      if (phaseRef.current !== "match") return;
      setBoards((prev) => {
        const board = prev[p.team];
        if (!board) return prev;
        const applied = applyBoardEvent(board, p.ev);
        if (applied === board) return prev;
        return { ...prev, [p.team]: applied };
      });
    },
    [],
  );

  /* Çift-sonucu sesi: resolving'in null→dolu geçişini izle (updater içinde
     yan etki yok — StrictMode double-invoke'ta da tek ses). */
  useEffect(() => {
    if (phase !== "match") return;
    (Object.keys(boards) as CtTeam[]).forEach((team) => {
      const board = boards[team];
      if (!board?.resolving) return;
      if (soundSeqRef.current[team] === board.turnSeq) return;
      soundSeqRef.current[team] = board.turnSeq;
      const visible = gameRef.current?.mode === "1v1" || team === myTeamRef.current;
      if (visible) playSound(board.resolving.correct ? "correct" : "wrong");
    });
  }, [phase, boards]);

  /* Bitiş kontrolü: her tahta değişiminde (resolve dahil) effect'ten. */
  useEffect(() => {
    if (phase !== "match") return;
    maybeFinish(boards);
  }, [phase, boards, maybeFinish]);

  const handleReturnLobby = useCallback(() => {
    resetGameState();
    setPhase((cur) => (cur === "menu" ? cur : "lobby"));
  }, [resetGameState]);

  /* ── Presence sync: lobi listesi + kopan oyuncu tespiti ── */
  const handlePresenceSync = useCallback(() => {
    const chan = chanRef.current;
    if (!chan) return;
    const state = chan.presenceState<PresenceInfo>();
    const seen = new Set<string>();
    const players: PresenceInfo[] = [];
    Object.values(state)
      .flat()
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .forEach((p) => {
        if (!p.playerId || seen.has(p.playerId)) return;
        seen.add(p.playerId);
        players.push({
          playerId: p.playerId,
          name: p.name,
          avatarId: p.avatarId ?? null,
          team: p.team === "red" ? "red" : "blue",
          joinedAt: p.joinedAt,
          host: !!p.host,
          mode: p.mode === "2v2" ? "2v2" : "1v1",
        });
      });
    setLobbyPlayers(players);

    const hostEntry = players.find((p) => p.host);
    if (hostEntry) {
      hostSeenRef.current = true;
      setHostMode(hostEntry.mode);
    }

    const ph = phaseRef.current;

    // Misafir tarafı: host lobiden ayrıldıysa oda kapandı. Yalnız host'u
    // DAHA ÖNCE görmüşsek — ilk sync'ler parçalı gelebilir (sadece kendimiz);
    // "oda hiç yok" kararı join probe'una aittir.
    if (!isHostRef.current && ph === "lobby" && hostSeenRef.current && !hostEntry) {
      leaveRoom("Oda kapatıldı — kurucu ayrıldı.");
      return;
    }

    // Oda dolu: 4'ten fazla oyuncu olduysa en yeni katılan kendini çıkarır.
    if (!isHostRef.current && ph === "lobby" && players.length > 4) {
      const newest = players.reduce((a, b) => (a.joinedAt > b.joinedAt ? a : b));
      if (newest.playerId === myId) {
        leaveRoom("Oda dolu (en fazla 4 oyuncu).");
        return;
      }
    }

    // Oyun ortasında roster'dan biri koptuysa maçı durdur (prototip kuralı).
    // DEBOUNCE: presence flap'ı (heartbeat gecikmesi vb.) anlık eksik görünüm
    // yaratabilir; eksiklik ~3.5 sn sonra hâlâ sürüyorsa gerçek kopmadır.
    const g = gameRef.current;
    const inGamePhase =
      ph === "countdown" || ph === "draw" || ph === "collect" || ph === "match";
    if (g && inGamePhase) {
      const missing = g.roster.find((r) => !seen.has(r.playerId));
      if (missing && haltCheckTimerRef.current === null) {
        haltCheckTimerRef.current = window.setTimeout(() => {
          haltCheckTimerRef.current = null;
          const chan = chanRef.current;
          const g2 = gameRef.current;
          const ph2 = phaseRef.current;
          if (!chan || !g2) return;
          if (ph2 !== "countdown" && ph2 !== "draw" && ph2 !== "collect" && ph2 !== "match") return;
          const ids = new Set(
            Object.values(chan.presenceState<PresenceInfo>())
              .flat()
              .map((p) => p.playerId),
          );
          const still = g2.roster.find((r) => !ids.has(r.playerId));
          if (still) {
            clearGameTimers();
            setHaltedMsg(`${still.name} oyundan ayrıldı.`);
            setPhase("halted");
          }
        }, 3_500);
      } else if (!missing && haltCheckTimerRef.current !== null) {
        window.clearTimeout(haltCheckTimerRef.current);
        haltCheckTimerRef.current = null;
      }
    }
  }, [clearGameTimers, leaveRoom, myId]);

  /* ── Kanal kurulumu (oda kur / katıl ortak) ── */
  const connect = useCallback(
    (code: string, asHost: boolean) => {
      setConnecting(true);
      setMenuNotice(null);
      hostSeenRef.current = false;
      const presenceKey = `${myId}:${Math.random().toString(36).slice(2, 8)}`;
      const chan = supabase.channel(`cizim-test:${code}`, {
        config: {
          presence: { key: presenceKey },
          // self: true → host dahil herkes AYNI handler yolundan geçer.
          broadcast: { self: true },
        },
      });
      chanRef.current = chan;

      chan
        .on("presence", { event: "sync" }, handlePresenceSync)
        .on("broadcast", { event: "game_start" }, ({ payload }) =>
          handleGameStart(payload as GameInfo),
        )
        .on("broadcast", { event: "drawing" }, ({ payload }) => {
          const p = payload as {
            gameSeq: number;
            round: number;
            playerId: string;
            img: string;
          };
          if (p.gameSeq !== gameSeqRef.current) return;
          drawingsRef.current.set(`${p.round}:${p.playerId}`, p.img);
          setCollectedCount(drawingsRef.current.size);
        })
        .on("broadcast", { event: "match_start" }, ({ payload }) =>
          handleMatchStart(
            payload as {
              gameSeq: number;
              boards: Partial<Record<CtTeam, CtCard[]>>;
              turnOrders: Partial<Record<CtTeam, string[]>>;
            },
          ),
        )
        .on("broadcast", { event: "board_event" }, ({ payload }) =>
          handleBoardEvent(payload as { gameSeq: number; team: CtTeam; ev: CtBoardEvent }),
        )
        .on("broadcast", { event: "game_over" }, ({ payload }) =>
          handleGameOver(payload as { gameSeq: number; winnerTeam: CtTeam }),
        )
        .on("broadcast", { event: "return_lobby" }, handleReturnLobby)
        .subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            const info = {
              playerId: myId,
              name: myName,
              avatarId: myAvatar,
              team: "blue" as CtTeam,
              joinedAt: Date.now(),
              host: asHost,
              mode: "1v1" as GameMode,
            };
            presenceRef.current = info;
            await chan.track(info);
            setConnecting(false);
            setRoomCode(code);
            setIsHost(asHost);
            setMyTeam("blue");
            setPhase("lobby");
            if (!asHost) {
              // Kanal her kodda "var" — host presence yoksa oda yok demektir.
              joinProbeRef.current = window.setTimeout(() => {
                joinProbeRef.current = null;
                const hasHost = lobbyPlayersRef.current.some((p) => p.host);
                if (!hasHost && phaseRef.current === "lobby") {
                  leaveRoom("Oda bulunamadı. Kodu kontrol edin.");
                }
              }, JOIN_PROBE_MS);
            }
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            leaveRoom("Bağlantı kurulamadı. Tekrar deneyin.");
          }
        });
    },
    [
      handleBoardEvent,
      handleGameOver,
      handleGameStart,
      handleMatchStart,
      handlePresenceSync,
      handleReturnLobby,
      leaveRoom,
      myAvatar,
      myId,
      myName,
    ],
  );

  const createRoom = useCallback(() => {
    playSound("click");
    connect(makeRoomCode(), true);
  }, [connect]);

  const joinRoom = useCallback(() => {
    const code = joinInput.trim().toUpperCase();
    if (code.length !== ROOM_CODE_LEN) {
      setMenuNotice(`Oda kodu ${ROOM_CODE_LEN} karakter olmalı.`);
      return;
    }
    playSound("click");
    connect(code, false);
  }, [connect, joinInput]);

  /* ── Presence güncelleme (takım / mod) ── */
  const retrack = useCallback((patch: Partial<Omit<PresenceInfo, "playerId">>) => {
    const cur = presenceRef.current;
    const chan = chanRef.current;
    if (!cur || !chan) return;
    const next = { ...cur, ...patch };
    presenceRef.current = next;
    void chan.track(next);
  }, []);

  const toggleMyTeam = useCallback(() => {
    playSound("click");
    const next: CtTeam = myTeamRef.current === "blue" ? "red" : "blue";
    setMyTeam(next);
    retrack({ team: next });
  }, [retrack]);

  const selectMode = useCallback(
    (mode: GameMode) => {
      playSound("click");
      setHostMode(mode);
      retrack({ mode });
    },
    [retrack],
  );

  /* ── Host: oyunu başlat ── */
  const startValidation = useMemo(() => {
    if (hostMode === "1v1") {
      if (lobbyPlayers.length !== 2) return "1v1 için tam 2 oyuncu gerekli.";
      return null;
    }
    if (lobbyPlayers.length !== 4) return "2v2 için tam 4 oyuncu gerekli.";
    const blue = lobbyPlayers.filter((p) => p.team === "blue").length;
    if (blue !== 2) return "Takımlar 2'ye 2 olmalı.";
    return null;
  }, [hostMode, lobbyPlayers]);

  const startGame = useCallback(() => {
    if (!isHostRef.current || startValidation) return;
    playSound("click");
    const players = lobbyPlayersRef.current;
    const roster: RosterPlayer[] = players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      avatarId: p.avatarId,
      // 1v1 tek ortak tahta "blue" anahtarında yaşar.
      team: hostMode === "1v1" ? "blue" : p.team,
    }));
    const payload: GameInfo = {
      gameSeq: gameSeqRef.current + 1,
      mode: hostMode,
      words: pickCizimWords(WORD_COUNT),
      roster,
      t0: getSyncedNowMs() + INTRO_MS,
    };
    send("game_start", payload);
  }, [hostMode, send, startValidation]);

  /* ── Çizim fazı ticker'ı (t0 takvimi, rAF) ── */
  useEffect(() => {
    if (phase !== "countdown" && phase !== "draw") return;
    const g = game;
    if (!g) return;

    const submitRound = (round: number) => {
      if (submittedRef.current.has(round)) return;
      submittedRef.current.add(round);
      stopSound("countdown20");
      const img = canvasRef.current?.exportPng() ?? "";
      send("drawing", {
        gameSeq: g.gameSeq,
        round,
        playerId: myId,
        img,
      });
    };

    const slot = DRAW_MS + GAP_MS;
    let lastView = "";

    const tick = () => {
      const rel = getSyncedNowMs() - g.t0;
      let view: DrawView;

      if (rel < 0) {
        view = { stage: "intro", round: 0, secLeft: Math.ceil(-rel / 1000) };
      } else {
        const i = Math.floor(rel / slot);
        if (i >= WORD_COUNT) {
          if (!collectDoneRef.current) {
            collectDoneRef.current = true;
            submitRound(WORD_COUNT - 1);
            setPhase("collect");
          }
          return;
        }
        const within = rel - i * slot;
        if (within < DRAW_MS) {
          if (phaseRef.current === "countdown") setPhase("draw");
          // Yeni tur: kanvası temizle, geri sayım sesini başlat.
          if (roundSoundRef.current !== i) {
            roundSoundRef.current = i;
            canvasRef.current?.clear();
            if (getCountdownSoundMode() !== "off") {
              playSound("countdown20", { seekSeconds: COUNTDOWN_SEEK_S });
            }
          }
          view = { stage: "draw", round: i, secLeft: Math.ceil((DRAW_MS - within) / 1000) };
        } else {
          submitRound(i);
          view = { stage: "gap", round: i, secLeft: Math.ceil((slot - within) / 1000) };
        }
      }

      const key = `${view.stage}:${view.round}:${view.secLeft}`;
      if (key !== lastView) {
        lastView = key;
        setDrawView(view);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === "countdown" || phase === "draw", game?.gameSeq]);

  /* ── Collect fazı: host tüm çizimler gelince (veya timeout) maçı başlatır ── */
  useEffect(() => {
    if (phase !== "collect" || !isHost) return;
    const g = gameRef.current;
    if (!g) return;

    const startMatch = () => {
      if (matchStartSentRef.current) return;
      matchStartSentRef.current = true;
      const teams: Partial<Record<CtTeam, string[]>> =
        g.mode === "1v1"
          ? { blue: g.roster.map((r) => r.playerId) }
          : {
              blue: g.roster.filter((r) => r.team === "blue").map((r) => r.playerId),
              red: g.roster.filter((r) => r.team === "red").map((r) => r.playerId),
            };
      const boardsPayload: Partial<Record<CtTeam, CtCard[]>> = {};
      const turnOrders: Partial<Record<CtTeam, string[]>> = {};
      (Object.keys(teams) as CtTeam[]).forEach((team) => {
        const members = teams[team]!;
        boardsPayload[team] = buildBoardCards(WORD_COUNT, members);
        turnOrders[team] = shuffled(members);
      });
      send("match_start", { gameSeq: g.gameSeq, boards: boardsPayload, turnOrders });
    };

    const expected = g.roster.length * WORD_COUNT;
    const poll = window.setInterval(() => {
      if (drawingsRef.current.size >= expected) {
        window.clearInterval(poll);
        startMatch();
      }
    }, 250);
    const hardStop = window.setTimeout(() => {
      window.clearInterval(poll);
      startMatch();
    }, COLLECT_TIMEOUT_MS);
    collectTimersRef.current.push(hardStop);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(hardStop);
    };
  }, [phase, isHost, send]);

  /* ── Match: ikinci-kart sonucunu tüm client'larda aynı gecikmeyle uygula ── */
  useEffect(() => {
    if (phase !== "match") return;
    (Object.keys(boards) as CtTeam[]).forEach((team) => {
      const board = boards[team];
      if (!board?.resolving) return;
      const key = `${team}:${board.turnSeq}`;
      if (resolveScheduledRef.current.has(key)) return;
      resolveScheduledRef.current.add(key);
      const delay = board.resolving.correct ? RESOLVE_CORRECT_MS : RESOLVE_WRONG_MS;
      const t = window.setTimeout(() => {
        setBoards((prev) => {
          const b = prev[team];
          if (!b?.resolving) return prev; // reducer auto-resolve önce davranmış
          return { ...prev, [team]: resolveBoard(b) };
        });
      }, delay);
      resolveTimersRef.current.push(t);
    });
  }, [phase, boards]);

  /* ── Match: sıra zaman aşımı (aktif oyuncu + host güvence pası) ── */
  useEffect(() => {
    if (phase !== "match") return;
    passTimersRef.current.forEach((t) => window.clearTimeout(t));
    passTimersRef.current = [];

    (Object.keys(boards) as CtTeam[]).forEach((team) => {
      const board = boards[team];
      if (!board || board.complete || board.resolving) return;
      const active = currentPlayer(board);
      const deadline = board.open.length === 1 ? FIRST_FLIP_MS : IDLE_TURN_MS;
      const sendPass = () =>
        send("board_event", {
          gameSeq: gameSeqRef.current,
          team,
          ev: { kind: "pass", playerId: active, turnSeq: board.turnSeq },
        });
      if (active === myId) {
        passTimersRef.current.push(window.setTimeout(sendPass, deadline));
      } else if (isHostRef.current) {
        // Aktif oyuncu takıldıysa/koptuysa host onun adına pas geçer.
        passTimersRef.current.push(
          window.setTimeout(sendPass, deadline + HOST_GRACE_MS),
        );
      }
    });
    return () => {
      passTimersRef.current.forEach((t) => window.clearTimeout(t));
      passTimersRef.current = [];
    };
  }, [phase, boards, myId, send]);

  /* ── Bitiş sesi ── */
  useEffect(() => {
    if (phase !== "finished" || !finished) return;
    const g = gameRef.current;
    if (!g) return;
    if (finished.tie) return;
    const iWon =
      g.mode === "1v1"
        ? finished.winnerIds.includes(myId)
        : finished.winnerTeam === g.roster.find((r) => r.playerId === myId)?.team;
    playSound(iWon ? "win" : "lose");
  }, [phase, finished, myId]);

  /* ── Kart tıklama ── */
  const myBoardTeam: CtTeam =
    game?.mode === "1v1"
      ? "blue"
      : game?.roster.find((r) => r.playerId === myId)?.team ?? "blue";

  const flipCard = useCallback(
    (team: CtTeam, cardId: number) => {
      const board = boardsRef.current[team];
      if (!board || board.complete || board.resolving) return;
      if (currentPlayer(board) !== myId) return;
      if (board.removed[cardId] || board.open.includes(cardId)) return;
      playSound("click");
      send("board_event", {
        gameSeq: gameSeqRef.current,
        team,
        ev: { kind: "flip", playerId: myId, cardId, turnSeq: board.turnSeq },
      });
    },
    [myId, send],
  );

  /* ── Geri / ayrıl ── */
  const inGame =
    phase === "countdown" || phase === "draw" || phase === "collect" || phase === "match";
  const onBack = useCallback(() => {
    playSound("click");
    if (phase === "menu") {
      onHome();
    } else if (inGame) {
      setConfirmLeave(true);
    } else {
      leaveRoom();
    }
  }, [phase, inGame, leaveRoom, onHome]);

  const copyCode = useCallback(() => {
    playSound("click");
    void navigator.clipboard?.writeText(roomCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [roomCode]);

  /* ═══════════════ RENDER ═══════════════ */

  if (!profile?.id) {
    // App'in multi-gate'i burayı normalde engeller; emniyet kemeri.
    return (
      <div className="app ct-screen">
        <div className="ct-center-panel">
          <p>Çizim Test için giriş yapman gerekiyor.</p>
          <button className="btn btn-accent" onClick={onHome}>
            Ana Menü
          </button>
        </div>
      </div>
    );
  }

  const words = game?.words ?? [];
  const rosterById = new Map((game?.roster ?? []).map((r) => [r.playerId, r]));
  const nameOf = (id: string) => rosterById.get(id)?.name ?? "?";
  const drawingOf = (wordIdx: number, ownerId: string) =>
    drawingsRef.current.get(`${wordIdx}:${ownerId}`) ?? null;

  /* ── Alt render parçaları ── */

  const renderMenu = () => (
    <section className="ct-menu">
      <h1 className="ct-title">Çizim Test</h1>
      <p className="ct-menu-sub">
        Aynı kelimeleri çizin, sonra kartları açıp çizim çiftlerini eşleştirin.
        En çok çifti bulan kazanır.
      </p>
      {menuNotice && <div className="ct-notice">{menuNotice}</div>}
      <div className="ct-menu-actions">
        <button
          className="btn btn-accent ct-big-btn"
          onClick={createRoom}
          disabled={connecting}
        >
          {connecting ? "Bağlanıyor…" : "Oda Kur"}
        </button>
        <div className="ct-join-row">
          <input
            className="ct-code-input"
            value={joinInput}
            onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") joinRoom();
            }}
            placeholder="ODA KODU"
            maxLength={ROOM_CODE_LEN}
            disabled={connecting}
          />
          <button className="btn ct-join-btn" onClick={joinRoom} disabled={connecting}>
            Katıl
          </button>
        </div>
      </div>
      <div className="ct-rules">
        <h3>Nasıl oynanır?</h3>
        <ol>
          <li>Herkese aynı 10 kelime gelir — her kelimeyi 10 saniyede çiz.</li>
          <li>Çizimler kapalı kartlara dönüşür; sırayla ikişer kart aç.</li>
          <li>Aynı kelimenin iki çizimini yakala: çift senindir, sıra sende kalır.</li>
        </ol>
      </div>
      <p className="ct-note">
        Prototip: masaüstü + mouse için tasarlandı. Sayfayı yenilersen oyundan düşersin.
      </p>
    </section>
  );

  const renderLobby = () => {
    const blues = lobbyPlayers.filter((p) => p.team === "blue");
    const reds = lobbyPlayers.filter((p) => p.team === "red");
    const playerChip = (p: PresenceInfo) => (
      <div key={p.playerId} className="ct-player-chip">
        <PlayerAvatar avatarId={p.avatarId} username={p.name} size="sm" highlight={p.host} />
        <span className="ct-player-name">
          {p.name}
          {p.playerId === myId && <em> (sen)</em>}
        </span>
        {p.host && <span className="ct-host-tag">Kurucu</span>}
        {hostMode === "2v2" && p.playerId === myId && (
          <button className="ct-team-toggle" onClick={toggleMyTeam}>
            Takım Değiştir
          </button>
        )}
      </div>
    );

    return (
      <section className="ct-lobby">
        <div className="ct-code-box">
          <span className="ct-code-label">Oda Kodu</span>
          <span className="ct-code-value">{roomCode}</span>
          <button className="btn ct-copy-btn" onClick={copyCode}>
            {copied ? "Kopyalandı ✓" : "Kopyala"}
          </button>
        </div>
        <p className="ct-lobby-hint">
          Arkadaşların Çizim Test menüsünden bu kodla katılabilir.
        </p>

        <div className="ct-mode-row" role="radiogroup" aria-label="Oyun tipi">
          {(["1v1", "2v2"] as GameMode[]).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={hostMode === m}
              className={"ct-mode-btn" + (hostMode === m ? " is-active" : "")}
              onClick={() => isHost && selectMode(m)}
              disabled={!isHost}
            >
              {m === "1v1" ? "1v1 — Ortak Tahta" : "2v2 — Takım Yarışı"}
            </button>
          ))}
          {!isHost && <span className="ct-mode-note">Oyun tipini kurucu seçer.</span>}
        </div>

        {hostMode === "1v1" ? (
          <div className="ct-player-list">{lobbyPlayers.map(playerChip)}</div>
        ) : (
          <div className="ct-team-cols">
            <div className="ct-team-col ct-team-col--blue">
              <h4>Mavi Takım</h4>
              {blues.map(playerChip)}
              {blues.length === 0 && <p className="ct-empty">Boş</p>}
            </div>
            <div className="ct-team-col ct-team-col--red">
              <h4>Kırmızı Takım</h4>
              {reds.map(playerChip)}
              {reds.length === 0 && <p className="ct-empty">Boş</p>}
            </div>
          </div>
        )}

        {isHost ? (
          <div className="ct-start-row">
            <button
              className="btn btn-accent ct-big-btn"
              onClick={startGame}
              disabled={!!startValidation}
            >
              Oyunu Başlat
            </button>
            {startValidation && <span className="ct-start-note">{startValidation}</span>}
          </div>
        ) : (
          <p className="ct-start-note">Kurucunun oyunu başlatması bekleniyor…</p>
        )}
      </section>
    );
  };

  const renderCountdown = () => (
    <section className="ct-intro">
      <h2>Hazırlan!</h2>
      <div className="ct-intro-count">{drawView.secLeft}</div>
      <p>Her kelime için 10 saniyen var. Güzel çizmek yok, hızlı çizmek var!</p>
    </section>
  );

  const renderDraw = () => {
    const isGap = drawView.stage === "gap";
    const word = words[drawView.round] ?? "";
    const urgent = !isGap && drawView.secLeft <= 3;
    return (
      <section className="ct-draw">
        <div className="ct-draw-top">
          <span className="ct-round-pill">
            {drawView.round + 1}/{WORD_COUNT}
          </span>
          <div className="ct-word-banner" aria-live="polite">
            {word}
          </div>
          <span
            className={
              "ct-timer" + (urgent ? " is-urgent" : "") + (isGap ? " is-gap" : "")
            }
          >
            {isGap ? "✋" : drawView.secLeft}
          </span>
        </div>
        <div className={"ct-paper-wrap" + (isGap ? " is-locked" : "")}>
          <div className="ct-paper">
            <DrawingCanvas ref={canvasRef} enabled={!isGap} />
          </div>
          {isGap && (
            <div className="ct-gap-overlay">
              <strong>Kalem bırak!</strong>
              <span>
                {drawView.round + 1 < WORD_COUNT
                  ? "Sıradaki kelime geliyor…"
                  : "Çizimler toplanıyor…"}
              </span>
            </div>
          )}
        </div>
        <div className="ct-draw-tools">
          <button
            className="btn ct-clear-btn"
            onClick={() => {
              playSound("click");
              canvasRef.current?.clear();
            }}
            disabled={isGap}
          >
            Temizle
          </button>
          <span className="ct-draw-hint">Süre bitince çizim otomatik gönderilir.</span>
        </div>
      </section>
    );
  };

  const renderCollect = () => {
    const expected = (game?.roster.length ?? 0) * WORD_COUNT;
    return (
      <section className="ct-intro">
        <h2>Çizimler toplanıyor…</h2>
        <div className="ct-collect-bar">
          <div
            className="ct-collect-fill"
            style={{ width: `${Math.min(100, (collectedCount / Math.max(1, expected)) * 100)}%` }}
          />
        </div>
        <p>
          {Math.min(collectedCount, expected)}/{expected} çizim geldi. Eşleştirme
          tahtası kuruluyor.
        </p>
      </section>
    );
  };

  const renderScoreChips = (board: CtBoardState) => (
    <div className="ct-score-chips">
      {board.turnOrder.map((id) => (
        <span
          key={id}
          className={
            "ct-score-chip" +
            (!board.complete && !board.resolving && currentPlayer(board) === id
              ? " is-turn"
              : "")
          }
        >
          <PlayerAvatar avatarId={rosterById.get(id)?.avatarId} username={nameOf(id)} size={24} />
          {nameOf(id)}
          <strong>{board.pairsByPlayer[id] ?? 0}</strong>
        </span>
      ))}
    </div>
  );

  const renderMatch = () => {
    const board = boards[myBoardTeam];
    if (!board) return null;
    const active = currentPlayer(board);
    const myTurn = !board.complete && !board.resolving && active === myId;
    const oppTeam: CtTeam = myBoardTeam === "blue" ? "red" : "blue";
    const oppBoard = game?.mode === "2v2" ? boards[oppTeam] : undefined;

    return (
      <section className="ct-match">
        <div className="ct-match-top">
          <div className={"ct-turn-banner" + (myTurn ? " is-mine" : "")}>
            {board.resolving
              ? board.resolving.correct
                ? "Eşleşme! 🎉"
                : "Olmadı…"
              : myTurn
                ? "SIRA SENDE — iki kart aç"
                : `Sıra: ${nameOf(active)}`}
          </div>
          {renderScoreChips(board)}
          {game?.mode === "2v2" && (
            <div className="ct-opp-progress">
              {TEAM_LABEL[oppTeam]} Takım: {oppBoard?.matched.length ?? 0}/{WORD_COUNT}
            </div>
          )}
        </div>

        <div className="ct-match-body">
          <div
            className="ct-board"
            data-turn-seq={board.turnSeq}
            role="grid"
            aria-label="Eşleştirme tahtası"
          >
            {board.cards.map((card) => {
              const isOpen = board.open.includes(card.cardId);
              const isRemoved = board.removed[card.cardId];
              const img = drawingOf(card.wordIdx, card.ownerId);
              const wrongNow =
                !!board.resolving &&
                !board.resolving.correct &&
                (board.resolving.a === card.cardId || board.resolving.b === card.cardId);
              return (
                <button
                  key={card.cardId}
                  className={
                    "ct-card" +
                    (isOpen ? " is-open" : "") +
                    (isRemoved ? " is-removed" : "") +
                    (wrongNow ? " is-wrong" : "")
                  }
                  onClick={() => flipCard(myBoardTeam, card.cardId)}
                  disabled={!myTurn || isRemoved || isOpen}
                  aria-label={isOpen ? `Açık kart: ${words[card.wordIdx]}` : "Kapalı kart"}
                >
                  <span className="ct-card-inner">
                    <span className="ct-card-back" aria-hidden="true">
                      ?
                    </span>
                    <span className="ct-card-front">
                      {img ? (
                        <img src={img} alt="" draggable={false} />
                      ) : (
                        <span className="ct-card-missing">çizim gelmedi</span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <aside className="ct-matched-rail">
            <h4>
              Bulunan Çiftler <span>{board.matched.length}/{WORD_COUNT}</span>
            </h4>
            {board.matched.length === 0 && (
              <p className="ct-empty">Henüz çift bulunmadı.</p>
            )}
            {board.matched.map((m) => (
              <div key={m.wordIdx} className="ct-matched-pair">
                <div className="ct-matched-thumbs">
                  {m.cardIds.map((cid) => {
                    const c = board.cards[cid];
                    const img = drawingOf(c.wordIdx, c.ownerId);
                    return img ? (
                      <img key={cid} src={img} alt="" draggable={false} />
                    ) : (
                      <span key={cid} className="ct-card-missing">?</span>
                    );
                  })}
                </div>
                <div className="ct-matched-meta">
                  <strong>{words[m.wordIdx]}</strong>
                  <span>{nameOf(m.byPlayerId)} buldu</span>
                </div>
              </div>
            ))}
          </aside>
        </div>
      </section>
    );
  };

  const renderFinished = () => {
    if (!finished || !game) return null;
    const board = boards[myBoardTeam];
    let headline: string;
    if (game.mode === "1v1") {
      headline = finished.tie
        ? "Berabere!"
        : finished.winnerIds.includes(myId)
          ? "Kazandın! 🏆"
          : `${nameOf(finished.winnerIds[0] ?? "")} kazandı!`;
    } else {
      const myTeamWon = finished.winnerTeam === myBoardTeam;
      headline = myTeamWon
        ? `${TEAM_LABEL[myBoardTeam]} Takım kazandı! 🏆`
        : `${TEAM_LABEL[finished.winnerTeam ?? "blue"]} Takım kazandı.`;
    }
    return (
      <section className="ct-finished">
        <h2>{headline}</h2>
        {board && renderScoreChips(board)}
        {game.mode === "2v2" && (
          <p className="ct-finished-note">
            Takımının bulduğu çift: {boards[myBoardTeam]?.matched.length ?? 0}/{WORD_COUNT}
          </p>
        )}
        <div className="ct-finished-actions">
          {isHost ? (
            <button
              className="btn btn-accent"
              onClick={() => {
                playSound("click");
                send("return_lobby", {});
              }}
            >
              Lobiye Dön
            </button>
          ) : (
            <p className="ct-start-note">Kurucu lobiye dönebilir; bekleniyor…</p>
          )}
          <button className="btn" onClick={() => leaveRoom()}>
            Odadan Ayrıl
          </button>
        </div>
      </section>
    );
  };

  const renderHalted = () => (
    <section className="ct-finished">
      <h2>Oyun durdu</h2>
      <p>{haltedMsg}</p>
      <div className="ct-finished-actions">
        {isHost && (
          <button
            className="btn btn-accent"
            onClick={() => {
              playSound("click");
              send("return_lobby", {});
            }}
          >
            Lobiye Dön
          </button>
        )}
        <button className="btn" onClick={() => leaveRoom()}>
          Odadan Ayrıl
        </button>
      </div>
    </section>
  );

  return (
    <div className="app ct-screen">
      <header className="ct-header">
        <button className="btn ct-back-btn" onClick={onBack}>
          ← {phase === "menu" ? "Ana Menü" : "Ayrıl"}
        </button>
        <div className="ct-header-title">
          ÇİZİM TEST <span className="ct-proto-badge">Prototip</span>
        </div>
        {roomCode && phase !== "menu" ? (
          <div className="ct-header-code">Oda: {roomCode}</div>
        ) : (
          <div className="ct-header-code" aria-hidden="true" />
        )}
      </header>
      <main className="ct-main" data-phase={phase}>
        {phase === "menu" && renderMenu()}
        {phase === "lobby" && renderLobby()}
        {phase === "countdown" && renderCountdown()}
        {phase === "draw" && renderDraw()}
        {phase === "collect" && renderCollect()}
        {phase === "match" && renderMatch()}
        {phase === "finished" && renderFinished()}
        {phase === "halted" && renderHalted()}
      </main>
      {confirmLeave && (
        <ConfirmDialog
          title="Oyundan ayrıl?"
          description="Maç devam ediyor. Ayrılırsan oyun diğer oyuncular için de durur."
          confirmLabel="Ayrıl"
          cancelLabel="Devam Et"
          destructive
          onConfirm={() => {
            setConfirmLeave(false);
            leaveRoom();
          }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
    </div>
  );
}
