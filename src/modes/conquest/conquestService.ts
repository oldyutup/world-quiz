/**
 * Conquest (Kuşatma) — Supabase service layer.
 *
 * All CRUD operations for conquest_rooms and conquest_players.  Realtime
 * subscription helpers live in conquestRealtime.ts.
 *
 * Phase-5 scope: room create/join/leave/update + public list query +
 * code/invite-link lookup.  No gameplay sync.
 *
 * Design principles
 * ─────────────────
 *   • Pure async helpers — no React, no global state.
 *   • Discriminated-union results (`JoinResult`) keep error handling explicit
 *     so callers don't accidentally swallow "room full" as a generic failure.
 *   • Frontend guards (e.g. "logged-in only for createRoom") live here; DB
 *     RLS is permissive (see migration header for rationale).
 *   • All host-mutation paths require the caller to pass the host player id
 *     so the service can never blindly trust a "host" claim.
 */

import type { Profile } from "../../lib/auth";
import {
  supabase,
  type ConquestPlayerRow,
  type ConquestRoomRow,
} from "../../lib/supabase";
import type {
  ConquestMapId,
  ConquestPlayerColor,
  ConquestRoomSettings,
  ConquestTeamId,
  ConquestTeamMode,
} from "./types";
import {
  freshConquestPlayerId,
  generateConquestRoomCode,
} from "./utils";
import { pickNextConquestColor } from "./conquestState";
import {
  forgetConquestClaim,
  generateConquestClaim,
  recallConquestClaim,
  rememberConquestClaim,
} from "./conquestClaim";

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export type ConquestJoinFailReason =
  | "not-found"   // No room with this code
  | "full"        // Room at max_players
  | "started"     // Room status="playing"
  | "closed"      // Room status="finished" or "closed"
  | "guest-only"  // Public list requires login (frontend-enforced)
  | "error";      // Network / DB error

export interface ConquestJoinSuccess {
  ok: true;
  room:    ConquestRoomRow;
  me:      ConquestPlayerRow;
  players: ConquestPlayerRow[];
}

export interface ConquestJoinFail {
  ok: false;
  reason:  ConquestJoinFailReason;
  message: string;
}

export type ConquestJoinResult = ConquestJoinSuccess | ConquestJoinFail;

export interface ConquestCreateSuccess {
  ok: true;
  room:    ConquestRoomRow;
  me:      ConquestPlayerRow;
}

export interface ConquestCreateFail {
  ok: false;
  message: string;
}

export type ConquestCreateResult = ConquestCreateSuccess | ConquestCreateFail;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Localized join-failure messages used by lobby/join screens. */
const FAIL_MESSAGES: Record<ConquestJoinFailReason, string> = {
  "not-found":   "Kuşatma odası bulunamadı.",
  "full":        "Bu Kuşatma odası dolu.",
  "started":     "Bu Kuşatma oyunu başlamış.",
  "closed":      "Bu Kuşatma odası kapanmış.",
  "guest-only":  "Açık Kuşatma odalarına katılmak için giriş yapmalısın.",
  "error":       "Bağlantı sorunu. Lütfen tekrar dene.",
};

export function conquestFail(
  reason: ConquestJoinFailReason,
  override?: string,
): ConquestJoinFail {
  return { ok: false, reason, message: override ?? FAIL_MESSAGES[reason] };
}

/** Normalise a room code to canonical form (uppercase, no whitespace). */
export function normalizeConquestRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

/** Quick joinability check given a room row + current player count. */
function evaluateJoinable(
  room: ConquestRoomRow,
  currentCount: number,
): ConquestJoinFailReason | null {
  if (room.status === "playing")                     return "started";
  if (room.status === "finished" || room.status === "closed") return "closed";
  if (currentCount >= room.max_players)              return "full";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Create room
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new Kuşatma room with the given host profile.
 * Guest hosts are blocked at the frontend (ConquestSetup); this function
 * defensively requires a non-null profile to enforce the same rule.
 *
 * On success returns the room row and the host player row.
 */
export async function createConquestRoom(
  profile: Profile,
  hostName: string,
  settings: ConquestRoomSettings,
): Promise<ConquestCreateResult> {
  const trimmed = hostName.trim();
  if (!profile?.id) {
    return { ok: false, message: "Kuşatma odası kurmak için giriş yapmalısın." };
  }
  if (trimmed.length < 2) {
    return { ok: false, message: "Oyuncu adı geçersiz." };
  }

  // Best-effort collision retry: room_code is a 6-char "K"+5 random; collisions
  // are astronomically rare but we retry up to 3 times if the unique check fails.
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateConquestRoomCode();
    const hostPlayerId = freshConquestPlayerId();

    // Yeni odalar varsayılan olarak "individual" açılır. Eski odadan gelen
    // teamMode state'i taşınmaz — Layer 1 spec: yeni oda kurunca eski takım
    // state'i taşınmasın.
    const { data: roomData, error: roomErr } = await supabase
      .from("conquest_rooms")
      .insert({
        room_code:       code,
        host_profile_id: profile.id,
        host_player_id:  hostPlayerId,
        host_name:       trimmed,
        status:          "waiting",
        map_id:          settings.map,
        max_players:     settings.maxPlayers,
        round_count:     settings.rounds,
        visibility:      settings.visibility,
        team_mode:       "individual",
      })
      .select("*")
      .single();

    if (roomErr || !roomData?.id) {
      // 23505 = unique_violation. Treat as code collision → retry.
      if (roomErr?.code === "23505") {
        lastError = "Oda kodu çakıştı, yeniden deneniyor…";
        continue;
      }
      return {
        ok: false,
        message: roomErr?.message
          ? `Oda oluşturulamadı: ${roomErr.message}`
          : "Oda oluşturulamadı.",
      };
    }

    const createdRoom = roomData as ConquestRoomRow;

    const hostColor = pickNextConquestColor([]);
    const claimToken = generateConquestClaim();
    const { data: playerData, error: playerErr } = await supabase.rpc(
      "conquest_register_player",
      {
        p_room_id:     createdRoom.id,
        p_player_id:   hostPlayerId,
        p_profile_id:  profile.id,
        p_guest_id:    null,
        p_name:        trimmed,
        p_color:       hostColor,
        p_is_host:     true,
        p_claim_token: claimToken,
      },
    );

    if (playerErr || !playerData) {
      // Roll back the empty room so it doesn't pollute the public list.
      await supabase.from("conquest_rooms").delete().eq("id", createdRoom.id);
      return {
        ok: false,
        message: playerErr?.message
          ? `Oyuncu eklenemedi: ${playerErr.message}`
          : "Oyuncu eklenemedi.",
      };
    }

    const me = playerData as ConquestPlayerRow;
    rememberConquestClaim(me.id, claimToken);

    return {
      ok: true,
      room: createdRoom,
      me,
    };
  }

  return { ok: false, message: lastError ?? "Oda kodu üretilemedi." };
}

// ─────────────────────────────────────────────────────────────────────────────
// Join room
// ─────────────────────────────────────────────────────────────────────────────

interface JoinIdentity {
  /** Logged-in user — null for guests. */
  profile:    Profile | null;
  /** Display name (already trimmed/validated by caller). */
  name:       string;
  /** Source: code-input, public-list, or invite-link. Used for telemetry only. */
  source?:    "code" | "public" | "invite";
}

/**
 * Join an existing room by its room_code (case-insensitive, normalised).
 * Guest path is allowed (frontend-controlled) so invite links keep working
 * for users without an account.
 */
export async function joinConquestRoomByCode(
  rawCode: string,
  identity: JoinIdentity,
): Promise<ConquestJoinResult> {
  const code = normalizeConquestRoomCode(rawCode);
  if (code.length !== 6) {
    return conquestFail("not-found", "Oda kodu 6 karakter olmalı.");
  }

  const { data: roomData, error: roomErr } = await supabase
    .from("conquest_rooms")
    .select("*")
    .eq("room_code", code)
    .maybeSingle();

  if (roomErr) {
    return conquestFail("error", `Oda aranamadı: ${roomErr.message}`);
  }
  if (!roomData) {
    return conquestFail("not-found");
  }

  return joinConquestRoom(roomData as ConquestRoomRow, identity);
}

/**
 * Insert the current user into a room.  Re-fetches the player list under
 * the same call so the caller can update its local state atomically.
 *
 * If the same logged-in profile already has a row in this room (e.g. re-join
 * from another tab), the existing row is returned without inserting a
 * duplicate — the partial unique index would reject the insert anyway.
 */
export async function joinConquestRoom(
  room:     ConquestRoomRow,
  identity: JoinIdentity,
): Promise<ConquestJoinResult> {
  // Refresh player count from DB so the joinability check is authoritative.
  const { data: existing, error: pErr } = await supabase
    .from("conquest_players")
    .select("*")
    .eq("room_id", room.id)
    .order("joined_at", { ascending: true });

  if (pErr) {
    return conquestFail("error", `Oyuncular yüklenemedi: ${pErr.message}`);
  }

  const players = (existing ?? []) as ConquestPlayerRow[];

  // Already in this room as a logged-in user? Return existing row.
  if (identity.profile?.id) {
    const mine = players.find(p => p.profile_id === identity.profile!.id);
    if (mine) {
      return { ok: true, room, me: mine, players };
    }
  }

  const blocker = evaluateJoinable(room, players.length);
  if (blocker) return conquestFail(blocker);

  const guestId = identity.profile ? null : freshConquestPlayerId();
  const trimmed = identity.name.trim();
  const joinColor = pickNextConquestColor(players.map(p => p.color));
  const claimToken = generateConquestClaim();

  const { data: inserted, error: insertErr } = await supabase.rpc(
    "conquest_register_player",
    {
      p_room_id:     room.id,
      p_player_id:   null,
      p_profile_id:  identity.profile?.id ?? null,
      p_guest_id:    guestId,
      p_name:        trimmed,
      p_color:       joinColor,
      p_is_host:     false,
      p_claim_token: claimToken,
    },
  );

  if (insertErr || !inserted) {
    // 23505: partial-unique violation → treat as "already joined", refetch
    if (insertErr?.code === "23505" && identity.profile?.id) {
      const { data: refetch } = await supabase
        .from("conquest_players")
        .select("*")
        .eq("room_id", room.id)
        .eq("profile_id", identity.profile.id)
        .maybeSingle();
      if (refetch) {
        return { ok: true, room, me: refetch as ConquestPlayerRow, players };
      }
    }
    return conquestFail("error", insertErr?.message ?? "Odaya katılınamadı.");
  }

  // The RPC also touches conquest_rooms.updated_at so the public list refresh
  // is handled server-side; no extra UPDATE here (which would now be denied
  // by the hardened RLS for non-host clients anyway).

  const me = inserted as ConquestPlayerRow;
  rememberConquestClaim(me.id, claimToken);
  return { ok: true, room, me, players: [...players, me] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Leave / lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove the current player from a room.  If the leaver is the host, the
 * room is closed (status='closed') so it disappears from the public list.
 *
 * Phase-5 choice: closing on host leave keeps the lifecycle simple.  A
 * "transfer host" path can be added later if needed (see WheelGroup).
 */
export async function leaveConquestRoom(
  roomId:   string,
  playerId: string,
  _isHost:  boolean,
): Promise<void> {
  // Under hardened RLS direct DELETE/UPDATE on these tables is denied. The
  // RPC verifies caller identity (auth.uid() or claim_token) and handles the
  // host-close transition atomically. _isHost is kept in the signature for
  // call-site compatibility but is no longer load-bearing — the RPC reads
  // is_host server-side.
  const claimToken = recallConquestClaim(playerId);
  await supabase.rpc("conquest_leave_room", {
    p_room_id:     roomId,
    p_player_id:   playerId,
    p_claim_token: claimToken,
  });
  forgetConquestClaim(playerId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings update (host only — checked frontend-side)
// ─────────────────────────────────────────────────────────────────────────────

export interface ConquestSettingsPatch {
  map?:        ConquestMapId;
  maxPlayers?: number;
  rounds?:     number;
  visibility?: "public" | "private";
}

/**
 * Persist host edits to room settings.  Returns the updated row, or null on
 * error.  Callers should pass only the fields that changed.
 */
export async function updateConquestRoomSettings(
  roomId: string,
  patch:  ConquestSettingsPatch,
): Promise<ConquestRoomRow | null> {
  const dbPatch: Record<string, unknown> = {};
  if (patch.map        !== undefined) dbPatch.map_id      = patch.map;
  if (patch.maxPlayers !== undefined) dbPatch.max_players = patch.maxPlayers;
  if (patch.rounds     !== undefined) dbPatch.round_count = patch.rounds;
  if (patch.visibility !== undefined) dbPatch.visibility  = patch.visibility;

  if (Object.keys(dbPatch).length === 0) return null;

  const { data, error } = await supabase
    .from("conquest_rooms")
    .update(dbPatch)
    .eq("id", roomId)
    .select("*")
    .single();

  if (error || !data) return null;
  return data as ConquestRoomRow;
}

/**
 * Update a single player's color choice.  Performs a frontend-side conflict
 * check (re-reads the room's current colors) before writing so two players
 * cannot end up on the same tint.  Returns the updated row on success.
 *
 * Race window: between the read and the write another client could claim the
 * same color.  The realtime echo would still show the conflict locally so the
 * picker can re-disable the swatch on the next render; rare in practice with
 * ≤4 players clicking deliberately.
 */
export interface ConquestColorUpdateOk    { ok: true;  player: ConquestPlayerRow; }
export interface ConquestColorUpdateFail  { ok: false; reason: "taken" | "error"; message: string; }
export type ConquestColorUpdateResult = ConquestColorUpdateOk | ConquestColorUpdateFail;

export async function updateConquestPlayerColor(
  _roomId:  string,
  playerId: string,
  color:    ConquestPlayerColor,
): Promise<ConquestColorUpdateResult> {
  // Conflict detection and the actual UPDATE both moved server-side into
  // conquest_update_player_color RPC, which raises 'color_taken' (SQLSTATE
  // P0001) when another player in the room already owns the requested swatch
  // and 'unauthorized' (42501) if the caller can't prove ownership of the
  // player row. _roomId stays in the signature so call sites don't change.
  const claimToken = recallConquestClaim(playerId);
  const { data, error } = await supabase.rpc("conquest_update_player_color", {
    p_player_id:   playerId,
    p_claim_token: claimToken,
    p_color:       color,
  });

  if (error) {
    if (error.message?.includes("color_taken")) {
      return { ok: false, reason: "taken", message: "Bu renk başka bir oyuncu tarafından seçildi." };
    }
    return { ok: false, reason: "error", message: error.message ?? "Renk güncellenemedi." };
  }
  if (!data) {
    return { ok: false, reason: "error", message: "Renk güncellenemedi." };
  }
  return { ok: true, player: data as ConquestPlayerRow };
}

/**
 * Mark a room as started (host only).  Phase-5 sets status='playing' and
 * stamps started_at so the row drops out of the public list.  Real gameplay
 * sync arrives later.
 */
export async function markConquestRoomStarted(
  roomId: string,
): Promise<ConquestRoomRow | null> {
  const { data, error } = await supabase
    .from("conquest_rooms")
    .update({
      status:     "playing",
      started_at: new Date().toISOString(),
    })
    .eq("id", roomId)
    .select("*")
    .single();

  if (error || !data) return null;
  return data as ConquestRoomRow;
}

/**
 * Flip a started room back to 'waiting' (host only).  Used when the host
 * exits the placeholder game screen so other clients re-enter the lobby
 * via realtime.
 */
export async function markConquestRoomWaiting(
  roomId: string,
): Promise<ConquestRoomRow | null> {
  const { data, error } = await supabase
    .from("conquest_rooms")
    .update({
      status:     "waiting",
      started_at: null,
    })
    .eq("id", roomId)
    .select("*")
    .single();

  if (error || !data) return null;
  return data as ConquestRoomRow;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export interface ConquestPublicRoomSummary {
  room:        ConquestRoomRow;
  playerCount: number;
}

/**
 * Active-player horizon (ms). conquest_players satırının last_seen_at değeri
 * bu eşikten daha eskiyse oyuncu "stale" sayılır ve public listede oda
 * doluluğunu artırmaz. Bkz: 20260531130000_conquest_player_heartbeat.sql.
 */
const CONQUEST_ACTIVE_PLAYER_WINDOW_MS = 60_000;

/**
 * List public, joinable Kuşatma rooms.  Filters:
 *   • visibility = 'public'
 *   • status     = 'waiting'
 *   • updated_at within the last 6 hours (drops abandoned rooms)
 *   • playerCount > 0 ve < max (sadece aktif heartbeat'li oyuncular sayılır)
 *
 * Stale oyuncular (browser kapatma / bağlantı kopması) listeden düşürülür:
 * `last_seen_at >= now() - 60s` olanlar aktif sayılır. Böylece "0/4" ya da
 * "1/4 ama gerçekte boş" gibi hayalet odalar listede yer kaplamaz.
 */
export async function fetchPublicConquestRooms(): Promise<ConquestPublicRoomSummary[]> {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const activeSince = new Date(Date.now() - CONQUEST_ACTIVE_PLAYER_WINDOW_MS).toISOString();

  const { data: rooms, error: roomErr } = await supabase
    .from("conquest_rooms")
    .select("*")
    .eq("visibility", "public")
    .eq("status", "waiting")
    .gte("updated_at", sixHoursAgo)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (roomErr || !rooms || rooms.length === 0) return [];

  const ids = rooms.map(r => r.id);
  // Sadece aktif (heartbeat'i son 60sn içinde olan) oyuncuları say. Eski/null
  // last_seen_at değerleri filtreyi geçemez, dolayısıyla ghost oyuncular oda
  // doluluk göstergesini şişiremez.
  const { data: players } = await supabase
    .from("conquest_players")
    .select("room_id")
    .in("room_id", ids)
    .gte("last_seen_at", activeSince);

  const counts = new Map<string, number>();
  for (const p of (players ?? []) as { room_id: string }[]) {
    counts.set(p.room_id, (counts.get(p.room_id) ?? 0) + 1);
  }

  return (rooms as ConquestRoomRow[])
    .map(room => ({
      room,
      playerCount: counts.get(room.id) ?? 0,
    }))
    // Aktif oyuncusu kalmamış / dolmuş odalar listede yer almaz.
    .filter(s => s.playerCount > 0 && s.playerCount < s.room.max_players);
}

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lobby açıkken aktif olduğumuzu bildirir: conquest_players.last_seen_at ve
 * conquest_rooms.updated_at değerlerini SECURITY DEFINER RPC üzerinden now()'a
 * çeker. Yetki conquest_authorize_player ile doğrulanır:
 *   • Logged-in : auth.uid() == conquest_players.profile_id
 *   • Misafir   : localStorage'daki claim_token, conquest_player_claims ile
 *                 eşleşmeli.
 * Hata sessizce yutulur — bu çağrı 20 saniyede bir tetikleniyor; geçici ağ
 * kesintilerini konsol spam'ine çevirmek istemiyoruz.
 */
export async function heartbeatConquestPlayer(playerId: string): Promise<void> {
  const claimToken = recallConquestClaim(playerId);
  try {
    await supabase.rpc("conquest_heartbeat_player", {
      p_player_id:   playerId,
      p_claim_token: claimToken,
    });
  } catch {
    /* network blip — next tick will retry */
  }
}

/** Fetch room+players for a known room id (used after realtime UPDATE events). */
export async function fetchConquestRoomState(
  roomId: string,
): Promise<{ room: ConquestRoomRow; players: ConquestPlayerRow[] } | null> {
  const [{ data: room }, { data: players }] = await Promise.all([
    supabase.from("conquest_rooms").select("*").eq("id", roomId).maybeSingle(),
    supabase
      .from("conquest_players")
      .select("*")
      .eq("room_id", roomId)
      .order("joined_at", { ascending: true }),
  ]);

  if (!room) return null;
  return {
    room:    room as ConquestRoomRow,
    players: (players ?? []) as ConquestPlayerRow[],
  };
}

/** Refresh just the player list for a room. */
export async function fetchConquestPlayers(
  roomId: string,
): Promise<ConquestPlayerRow[]> {
  const { data } = await supabase
    .from("conquest_players")
    .select("*")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });
  return (data ?? []) as ConquestPlayerRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 2v2 Takımlı mod — Layer 1
// ─────────────────────────────────────────────────────────────────────────────

export interface ConquestTeamModeUpdateOk   { ok: true;  room: ConquestRoomRow; }
export interface ConquestTeamModeUpdateFail { ok: false; reason: "capacity" | "unauthorized" | "error"; message: string; }
export type ConquestTeamModeUpdateResult = ConquestTeamModeUpdateOk | ConquestTeamModeUpdateFail;

/**
 * Host: oda team_mode'unu değiştir.  teams_2v2 sadece kapasite 4 iken
 * seçilebilir.  individual'a dönülürse server-side tüm team_id'ler temizlenir.
 */
export async function setConquestTeamMode(
  roomId:    string,
  playerId:  string,
  teamMode:  ConquestTeamMode,
): Promise<ConquestTeamModeUpdateResult> {
  const claimToken = recallConquestClaim(playerId);
  const { data, error } = await supabase.rpc("set_conquest_team_mode", {
    p_room_id:     roomId,
    p_player_id:   playerId,
    p_claim_token: claimToken,
    p_team_mode:   teamMode,
  });
  if (error) {
    if (error.message?.includes("team_mode_requires_capacity_4")) {
      return { ok: false, reason: "capacity", message: "2v2 Takımlı mod için oda kapasitesi 4 olmalı." };
    }
    if (error.message?.includes("unauthorized")) {
      return { ok: false, reason: "unauthorized", message: "Bu işlem için yetkin yok." };
    }
    return { ok: false, reason: "error", message: error.message ?? "Oyun tipi güncellenemedi." };
  }
  if (!data) return { ok: false, reason: "error", message: "Oyun tipi güncellenemedi." };
  return { ok: true, room: data as ConquestRoomRow };
}

export interface ConquestSelectTeamOk   { ok: true;  player: ConquestPlayerRow; }
export interface ConquestSelectTeamFail { ok: false; reason: "team_full" | "not_team_mode" | "unauthorized" | "error"; message: string; }
export type ConquestSelectTeamResult = ConquestSelectTeamOk | ConquestSelectTeamFail;

/**
 * Oyuncu: kendi takımını seç.  Hedef takımda 2 oyuncu varsa "team_full",
 * oda team_mode='teams_2v2' değilse "not_team_mode" döner.
 */
export async function selectConquestTeam(
  roomId:   string,
  playerId: string,
  teamId:   ConquestTeamId,
): Promise<ConquestSelectTeamResult> {
  const claimToken = recallConquestClaim(playerId);
  const { data, error } = await supabase.rpc("select_conquest_team", {
    p_room_id:     roomId,
    p_player_id:   playerId,
    p_claim_token: claimToken,
    p_team_id:     teamId,
  });
  if (error) {
    if (error.message?.includes("team_full")) {
      return { ok: false, reason: "team_full", message: "Bu takım dolu." };
    }
    if (error.message?.includes("team_mode_not_teams")) {
      return { ok: false, reason: "not_team_mode", message: "Takım seçimi yalnız 2v2 Takımlı modda yapılabilir." };
    }
    if (error.message?.includes("unauthorized")) {
      return { ok: false, reason: "unauthorized", message: "Bu işlem için yetkin yok." };
    }
    return { ok: false, reason: "error", message: error.message ?? "Takım seçimi başarısız." };
  }
  if (!data) return { ok: false, reason: "error", message: "Takım seçimi başarısız." };
  return { ok: true, player: data as ConquestPlayerRow };
}

export interface ConquestShuffleTeamsOk   { ok: true;  players: ConquestPlayerRow[]; }
export interface ConquestShuffleTeamsFail { ok: false; reason: "needs_4" | "not_team_mode" | "unauthorized" | "error"; message: string; }
export type ConquestShuffleTeamsResult = ConquestShuffleTeamsOk | ConquestShuffleTeamsFail;

/**
 * Host: 4 oyuncuyu rastgele 2-2 takımlara dağıt.  Oda 4 oyuncudan azsa
 * "needs_4" döner.
 */
export async function shuffleConquestTeams(
  roomId:   string,
  playerId: string,
): Promise<ConquestShuffleTeamsResult> {
  const claimToken = recallConquestClaim(playerId);
  const { data, error } = await supabase.rpc("shuffle_conquest_teams", {
    p_room_id:     roomId,
    p_player_id:   playerId,
    p_claim_token: claimToken,
  });
  if (error) {
    if (error.message?.includes("team_shuffle_requires_4_players")) {
      return { ok: false, reason: "needs_4", message: "Takımları karıştırmak için 4 oyuncu gerekli." };
    }
    if (error.message?.includes("team_mode_not_teams")) {
      return { ok: false, reason: "not_team_mode", message: "Takımları karıştırma yalnız 2v2 Takımlı modda yapılabilir." };
    }
    if (error.message?.includes("unauthorized")) {
      return { ok: false, reason: "unauthorized", message: "Bu işlem için yetkin yok." };
    }
    return { ok: false, reason: "error", message: error.message ?? "Takımlar karıştırılamadı." };
  }
  return { ok: true, players: (data ?? []) as ConquestPlayerRow[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hızlı Eşleş (Quick Match) — 1v1, server-authoritative
// ─────────────────────────────────────────────────────────────────────────────
// Backend: conquest_quick_match / cancel / reset RPCs + conquest_quick_match_queue
// (supabase/migrations/20260719120000_conquest_quick_match.sql). Mirrors the
// duel quick-match desen: client tick'ler, RPC iki bekleyeni atomik eşleştirip
// status='waiting' oda + 2 conquest_players kurar. İlk gameplay_state'i host
// istemci (host_player_id === myPlayerId) mevcut start akışıyla yazar.

/** RPC dönüş şekli. matched=false iken yalnız search_age_seconds dolu. */
export interface ConquestQuickMatchResult {
  matched:             boolean;
  room_id?:            string;
  my_player_id?:       string;
  host_player_id?:     string | null;
  opponent_name?:      string | null;
  search_age_seconds?: number;
}

/**
 * Bir quick-match tick'i. Eşleşene kadar her ~3 sn'de bir çağrılır; bracket
 * (max_level_diff) bekleme süresine göre genişler. Auth/param hatalarında
 * `{ error }` döndürür (rpc in-band error). map yalnız 'turkey'.
 */
export async function conquestQuickMatchTick(args: {
  profileId:     string;
  playerId:      string;
  playerName:    string;
  roundCount:    number;
  mapId:         string;
  maxLevelDiff:  number;
}): Promise<{ result: ConquestQuickMatchResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc("conquest_quick_match", {
    p_profile_id:     args.profileId,
    p_player_id:      args.playerId,
    p_player_name:    args.playerName,
    p_round_count:    args.roundCount,
    p_map_id:         args.mapId,
    p_max_level_diff: args.maxLevelDiff,
  });
  if (error) return { result: null, error: error.message ?? "Hızlı eşleş hatası" };
  return { result: (data ?? null) as ConquestQuickMatchResult | null, error: null };
}

/** Aramayı iptal et — yalnız eşleşmemiş queue satırını siler. */
export async function cancelConquestQuickMatch(profileId: string): Promise<void> {
  try {
    await supabase.rpc("conquest_cancel_quick_match", { p_profile_id: profileId });
  } catch (e) {
    console.warn("[Conquest] cancel_quick_match RPC failed", e);
  }
}

/** Yeni aramadan önce stale satırı koşulsuz temizle (cancel matched satırı bırakır). */
export async function resetConquestQuickMatch(profileId: string): Promise<void> {
  try {
    await supabase.rpc("conquest_reset_quick_match", { p_profile_id: profileId });
  } catch (e) {
    console.warn("[Conquest] reset_quick_match RPC failed", e);
  }
}

/**
 * Eşleşme bulunduktan sonra odayı + oyuncularını tek seferde yükle. Lobby
 * state'ini (roomRow/playerRows/myPlayerId) doldurmak için kullanılır; mevcut
 * join akışıyla aynı şekil. matched satırın player_id'si zaten conquest_players
 * içinde (RPC server-side ekledi).
 */
export async function fetchConquestRoomWithPlayers(
  roomId: string,
): Promise<{ room: ConquestRoomRow; players: ConquestPlayerRow[] } | null> {
  const { data: room, error: rErr } = await supabase
    .from("conquest_rooms")
    .select("*")
    .eq("id", roomId)
    .maybeSingle();
  if (rErr || !room) return null;

  const { data: players, error: pErr } = await supabase
    .from("conquest_players")
    .select("*")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });
  if (pErr) return null;

  return {
    room:    room as ConquestRoomRow,
    players: (players ?? []) as ConquestPlayerRow[],
  };
}
