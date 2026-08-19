/**
 * Conquest (Kuşatma) — lobby-only broadcast channel.
 *
 * Carries ephemeral state that lives only while players are in the waiting
 * room and has no gameplay binding yet:
 *   - bonus distribution mode ("random" | "vote")
 *   - per-player bonus votes (which bonus types each player picked)
 *
 * No Supabase tables back this — it rides on a dedicated Supabase Realtime
 * broadcast channel keyed by room id.  Late joiners request a snapshot; the
 * room host (when present) replies with the current state.  Toggle/mode
 * events fan out to every connected client.
 *
 * Persistence note: when the host disconnects with the lobby otherwise empty,
 * state is lost.  That's intentional for this phase — the votes never make
 * it into a match (gameplay wiring lands later).
 */

import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";
import type {
  ConquestBonusDistribution,
  ConquestRegionBonusType,
} from "./types";

/** playerId → set of bonus types they have voted for. */
export type ConquestLobbyVotes = Record<string, ConquestRegionBonusType[]>;

export interface ConquestLobbyBroadcastState {
  bonusDistribution: ConquestBonusDistribution;
  votes:             ConquestLobbyVotes;
  /** Players who have clicked "Lobiye Dön" from the post-match screen and
   *  want to be included in the next game.  Spans both lobby and game
   *  phases so the host can see who's back while still in the finished
   *  panel themselves. */
  readyPlayerIds:    string[];
}

export const EMPTY_LOBBY_BROADCAST_STATE: ConquestLobbyBroadcastState = {
  bonusDistribution: "random",
  votes:             {},
  readyPlayerIds:    [],
};

interface SnapshotPayload {
  state: ConquestLobbyBroadcastState;
}

interface ModeChangePayload {
  bonusDistribution: ConquestBonusDistribution;
}

interface VoteTogglePayload {
  playerId:  string;
  bonusType: ConquestRegionBonusType;
  /** When true, force-add (vote in). When false, force-remove (vote out).
   *  When undefined, the receiver toggles. */
  add?:      boolean;
}

interface ClearVotesPayload {
  playerId: string;
}

interface ReadyForNextPayload {
  playerId: string;
  /** When false, the sender is retracting their ready-state (e.g. they
   *  navigated back to the finished panel via browser back).  Currently
   *  only `true` is emitted; field reserved for future use. */
  ready:    boolean;
}

export interface ConquestLobbyBroadcastHandlers {
  /** Called when a snapshot arrives from another client. */
  onSnapshot:    (state: ConquestLobbyBroadcastState) => void;
  /** Called when the host emits a mode change. */
  onModeChange:  (mode:  ConquestBonusDistribution)   => void;
  /** Called when any client emits a vote toggle. */
  onVoteToggle:  (payload: VoteTogglePayload)         => void;
  /** Called when a client clears all their own votes (e.g. mode flip back). */
  onClearVotes:  (playerId: string)                   => void;
  /** Called when a client reports they're back in the lobby and ready for
   *  the next game.  Host aggregates this into the start filter. */
  onReadyForNext: (payload: ReadyForNextPayload) => void;
  /** Called when the host resets the ready set (typically after starting a
   *  new game or returning to a fresh lobby). */
  onClearReady:   () => void;
  /** Called when another client requests a snapshot — only the host
   *  responds (caller decides), but every client receives the ping so they
   *  could fall back if needed. */
  onRequestSnapshot: () => void;
}

/**
 * Apply a vote toggle to a votes map.  Pure helper exposed for reducers in
 * components — the broadcast layer itself is stateless.
 *
 * Caps the player's vote count at `cap` when the toggle would add a new vote
 * AND the player is already at cap — the toggle is rejected (no-op).
 */
export function applyVoteToggle(
  votes:    ConquestLobbyVotes,
  payload:  VoteTogglePayload,
  cap:      number,
): ConquestLobbyVotes {
  const cur = votes[payload.playerId] ?? [];
  const has = cur.includes(payload.bonusType);
  const shouldAdd = payload.add !== undefined ? payload.add : !has;
  if (shouldAdd && has) return votes;
  if (!shouldAdd && !has) return votes;
  if (shouldAdd && !has && cur.length >= cap) {
    // Reject add-when-full silently.
    return votes;
  }
  const nextList = shouldAdd
    ? [...cur, payload.bonusType]
    : cur.filter(t => t !== payload.bonusType);
  return { ...votes, [payload.playerId]: nextList };
}

/**
 * Drop every vote held by a player.  Used when a player leaves OR when the
 * mode flips back to "random" and we reset.
 */
export function clearPlayerVotes(
  votes:    ConquestLobbyVotes,
  playerId: string,
): ConquestLobbyVotes {
  if (!(playerId in votes)) return votes;
  const next = { ...votes };
  delete next[playerId];
  return next;
}

/** Aggregate vote count per bonus type. */
export function tallyVotes(
  votes: ConquestLobbyVotes,
): Map<ConquestRegionBonusType, number> {
  const out = new Map<ConquestRegionBonusType, number>();
  for (const list of Object.values(votes)) {
    for (const t of list) out.set(t, (out.get(t) ?? 0) + 1);
  }
  return out;
}

interface SubscribeArgs {
  roomId:   string;
  isHost:   boolean;
  /**
   * GÜVENLİK (T-02): gelen bir broadcast'in adı geçen oyuncusu, DB'den bilinen
   * (conquest_players) oyuncu listesinde var mı?  Sağlanmazsa doğrulama
   * atlanır (eski davranış) — çağıranın vermesi beklenir.
   */
  isKnownPlayer?: (playerId: string) => boolean;
  /** Read latest local snapshot.  Used so the host can respond to a
   *  newcomer's snapshot request without us holding the state. */
  getState: () => ConquestLobbyBroadcastState;
  handlers: ConquestLobbyBroadcastHandlers;
}

/**
 * Returns a handle exposing emit functions and an unsubscribe.  The caller
 * is responsible for calling `unsubscribe()` on unmount.
 */
export interface ConquestLobbyBroadcastHandle {
  emitSnapshot:    (state: ConquestLobbyBroadcastState) => void;
  emitModeChange:  (mode:  ConquestBonusDistribution)   => void;
  emitVoteToggle:  (payload: VoteTogglePayload)         => void;
  emitClearVotes:  (playerId: string)                   => void;
  emitReadyForNext: (playerId: string) => void;
  emitClearReady:  () => void;
  emitRequestSnapshot: ()                                => void;
  unsubscribe:     () => void;
}

export function subscribeLobbyBroadcast(
  args: SubscribeArgs,
): ConquestLobbyBroadcastHandle {
  const { roomId, isHost, isKnownPlayer, getState, handlers } = args;

  const channel: RealtimeChannel = supabase.channel(
    `conquest-lobby:${roomId}`,
    { config: { broadcast: { self: false } } },
  );

  /* ── GÜVENLİK (T-02) — bu kanal PUBLIC'tir ────────────────────────────────
     `conquest-lobby:<roomId>` konusuna, publishable key'i taşıyan herkes
     katılıp payload yayınlayabilir; payload'da gönderen kimliği YOKTUR.
     Kanalı `private: true` yapmak çözüm DEĞİLDİR — `private` bayrağını istemci
     kendi seçer, saldırgan aynı konuya `private:false` ile katılmaya devam
     eder (canlı probe ile doğrulandı). Bu yüzden kanalı kapatmak yerine
     PAYLOAD'A GÜVENİ AZALTIYORUZ.

     Oyun/territory/skor state'i bu kanaldan GEÇMEZ (o, private `conquest:`
     sinyal kanalı + RPC otoritesindedir) — burada yalnız lobi state'i vardır:
     bonusDistribution, votes, readyPlayerIds.

     Üç kapı — HEPSİ "host lobi state'inin sahibidir" ilkesine dayanır:
       1) snapshot → HOST'ta yok sayılır. Host zaten kaynak-otoritedir: yalnız
          non-host'lar `request_snapshot` gönderir (aşağıdaki subscribe), host
          ise kendi state'ini yayınlar. Host'un dışarıdan toplu state alması
          için MEŞRU bir durum yoktur → dışarıdan state ezme host'ta kapanır.
          Non-host'lar host'un snapshot'ını uygulamaya DEVAM eder; host maç içi
          oy-kapasitesi zorlamasında (ConquestMode:627) ve mod değişiminde
          (:1128) snapshot yeniden yayınladığı için bu akış BOZULMAZ.
       2) mode_change → HOST'ta yok sayılır. Ayarın sahibi host'tur ve bu değer
          başlayan maça giriyor (ConquestMode: lobbyExtra → settings), yani
          dışarıdan çevrilmesi gerçek bir maç-etkisiydi. Non-host'lar host'un
          yayınını uygulamaya devam eder → görünür davranış aynı kalır.
       3) vote/ready/clear_votes → adı geçen playerId DB'den bilinen oyuncu
          listesinde değilse yok sayılır (hayalet oyuncu enjeksiyonu kapanır).

     KALAN KABUL EDİLEN RİSK: bir non-host istemcinin YEREL lobi görünümü hâlâ
     karıştırılabilir (kendi ekranında yanlış oy/mod görebilir). Maça giren
     ayarı host taşıdığı ve maç state'i RPC otoritesinde olduğu için bu, maç
     bütünlüğüne ULAŞMAZ. Tam eliminasyon lobi state'ini DB'ye taşımayı
     gerektirir → bilinçli olarak sonraki tura ertelendi.
     ──────────────────────────────────────────────────────────────────────── */
  const knownPlayer = (playerId: unknown): boolean => {
    if (typeof playerId !== "string" || playerId.length === 0) return false;
    // Doğrulayıcı verilmediyse eski davranış korunur (regresyon yok).
    return isKnownPlayer ? isKnownPlayer(playerId) : true;
  };

  channel
    .on("broadcast", { event: "snapshot" }, ({ payload }) => {
      const p = payload as SnapshotPayload | undefined;
      if (!p?.state) return;
      if (isHost) return;            // (1) host kendi state'ini dışarıdan almaz
      handlers.onSnapshot(p.state);
    })
    .on("broadcast", { event: "mode_change" }, ({ payload }) => {
      const p = payload as ModeChangePayload | undefined;
      if (!p) return;
      if (isHost) return;            // (2) host kendi ayarını dışarıdan almaz
      handlers.onModeChange(p.bonusDistribution);
    })
    .on("broadcast", { event: "vote_toggle" }, ({ payload }) => {
      const p = payload as VoteTogglePayload | undefined;
      if (!p || !knownPlayer(p.playerId)) return;   // (3)
      handlers.onVoteToggle(p);
    })
    .on("broadcast", { event: "clear_votes" }, ({ payload }) => {
      const p = payload as ClearVotesPayload | undefined;
      if (!p || !knownPlayer(p.playerId)) return;   // (3)
      handlers.onClearVotes(p.playerId);
    })
    .on("broadcast", { event: "ready_for_next" }, ({ payload }) => {
      const p = payload as ReadyForNextPayload | undefined;
      if (!p || !knownPlayer(p.playerId)) return;   // (3)
      handlers.onReadyForNext(p);
    })
    .on("broadcast", { event: "clear_ready" }, () => {
      handlers.onClearReady();
    })
    .on("broadcast", { event: "request_snapshot" }, () => {
      handlers.onRequestSnapshot();
      // Host auto-responds with current snapshot so newcomers stay in sync.
      if (isHost) {
        void channel.send({
          type:    "broadcast",
          event:   "snapshot",
          payload: { state: getState() } satisfies SnapshotPayload,
        });
      }
    })
    .subscribe(status => {
      // Once we're in, ask whoever's listening for the latest snapshot so we
      // don't render against an empty state for our first frames.
      if (status === "SUBSCRIBED" && !isHost) {
        void channel.send({
          type:    "broadcast",
          event:   "request_snapshot",
          payload: {},
        });
      }
    });

  return {
    emitSnapshot: (state) =>
      void channel.send({
        type:    "broadcast",
        event:   "snapshot",
        payload: { state } satisfies SnapshotPayload,
      }),
    emitModeChange: (bonusDistribution) =>
      void channel.send({
        type:    "broadcast",
        event:   "mode_change",
        payload: { bonusDistribution } satisfies ModeChangePayload,
      }),
    emitVoteToggle: (payload) =>
      void channel.send({
        type:    "broadcast",
        event:   "vote_toggle",
        payload,
      }),
    emitClearVotes: (playerId) =>
      void channel.send({
        type:    "broadcast",
        event:   "clear_votes",
        payload: { playerId } satisfies ClearVotesPayload,
      }),
    emitReadyForNext: (playerId) =>
      void channel.send({
        type:    "broadcast",
        event:   "ready_for_next",
        payload: { playerId, ready: true } satisfies ReadyForNextPayload,
      }),
    emitClearReady: () =>
      void channel.send({
        type:    "broadcast",
        event:   "clear_ready",
        payload: {},
      }),
    emitRequestSnapshot: () =>
      void channel.send({
        type:    "broadcast",
        event:   "request_snapshot",
        payload: {},
      }),
    unsubscribe: () => {
      supabase.removeChannel(channel);
    },
  };
}
