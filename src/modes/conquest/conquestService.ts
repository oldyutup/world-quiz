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
import {
  conquestFail,
  mapConquestJoinFailure,
  type ConquestJoinFail,
} from "./conquestJoinFlow";

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

// Hata sebepleri, kullanıcı metinleri ve sunucu-kodu eşlemesi SAF modülde
// (conquestJoinFlow.ts) durur — böylece Supabase istemcisi yüklenmeden test
// edilebilirler. Buradan re-export edilirler ki mevcut import yolları
// (`from "./conquestService"`) değişmesin.
export type { ConquestJoinFailReason, ConquestJoinFail } from "./conquestJoinFlow";
export { conquestFail } from "./conquestJoinFlow";

export interface ConquestJoinSuccess {
  ok: true;
  room:    ConquestRoomRow;
  me:      ConquestPlayerRow;
  players: ConquestPlayerRow[];
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

/** Normalise a room code to canonical form (uppercase, no whitespace). */
export function normalizeConquestRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

// NOT: eski `evaluateJoinable(room, currentCount)` yardımcısı KALDIRILDI.
// Kapasite kararı artık sunucudadır (`conquest_register_player` oda satırını
// kilitleyip sayar) — istemcide ikinci bir kapasite kuralı tutmak, ikisinin
// sessizce ayrışması demektir. Oda DURUMUNA bakan kısa kontrol
// joinConquestRoom içinde, yalnız daha iyi hata metni için durur.

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
 * Guest path is allowed so invite links keep working for users without an
 * account — bu, ürün kuralının misafire AÇIK olan tek Kuşatma girişidir.
 *
 * Oda arama `conquest_find_room_by_code` RPC'sinden geçer (20260809120000,
 * Bölüm A2): adı üstünde TEK bir kodu çözer, en fazla bir satır döndürür ve
 * filtresiz çağrılamaz. Böylece "bildiğim kodu doğrula" misafire açık kalırken
 * "kod havuzunu tara" yolu açılmaz — açık oda listesinin yetkili uç noktası
 * (`conquest_list_public_rooms`) ayrıdır ve misafire kapalıdır.
 */
export async function joinConquestRoomByCode(
  rawCode: string,
  identity: JoinIdentity,
): Promise<ConquestJoinResult> {
  const code = normalizeConquestRoomCode(rawCode);
  if (code.length !== 6) {
    return conquestFail("not-found", "Oda kodu 6 karakter olmalı.");
  }

  const { data: roomData, error: roomErr } = await supabase.rpc(
    "conquest_find_room_by_code",
    { p_code: code },
  );

  if (roomErr) {
    return conquestFail("error", `Oda aranamadı: ${roomErr.message}`);
  }
  // `.id` de kontrol edilir: composite döndüren bir RPC, satır bulunamadığında
  // yanlışlıkla "alanları NULL olan bir nesne" döndürebilir (PL/pgSQL SELECT
  // INTO davranışı). Fonksiyon bunu `if not found then return null` ile
  // engelliyor; bu kontrol o sözleşme bozulursa katılmanın anlaşılmaz bir
  // hataya dönüşmesini önler.
  const found = roomData as ConquestRoomRow | null;
  if (!found?.id) {
    return conquestFail("not-found");
  }

  return joinConquestRoom(found, identity);
}

/**
 * Insert the current user into a room.
 *
 * KATILMADAN ÖNCE OYUNCU TABLOSU OKUNMAZ.
 * Eskiden bu fonksiyon önce `conquest_players` tablosunu ham okuyup
 * (a) kapasiteyi kontrol ediyor, (b) boş rengi seçiyordu. 20260810120000 o
 * tabloyu `anon` rolüne kapattı (misafirin açık odaları enumerasyonla
 * listelemesini engellemek için), dolayısıyla her iki karar da SUNUCUYA
 * taşındı — `conquest_register_player` oda satırını kilitleyip kapasiteyi
 * sayar, rengi paletten atar ve aynı hesap zaten odadaysa mevcut satırı
 * döndürür. Sunucu zaten tek otoriteydi; artık tek KARAR VEREN de o.
 *
 * Oyuncu listesi katılma BAŞARILI olduktan sonra, üyeliği kanıtlanmış
 * `conquest_get_room_state` RPC'siyle okunur.
 */
export async function joinConquestRoom(
  room:     ConquestRoomRow,
  identity: JoinIdentity,
): Promise<ConquestJoinResult> {
  // Odanın kendi satırından okunabilen engeller (durum) için erken ve net bir
  // mesaj: sunucu bunları yine reddeder, bu yalnız daha iyi bir UI cevabıdır.
  if (room.status === "playing")  return conquestFail("started");
  if (room.status === "finished" || room.status === "closed") {
    return conquestFail("closed");
  }

  const guestId = identity.profile ? null : freshConquestPlayerId();
  const trimmed = identity.name.trim();
  const claimToken = generateConquestClaim();

  const { data: inserted, error: insertErr } = await supabase.rpc(
    "conquest_register_player",
    {
      p_room_id:     room.id,
      p_player_id:   null,
      p_profile_id:  identity.profile?.id ?? null,
      p_guest_id:    guestId,
      p_name:        trimmed,
      // null → rengi sunucu seçer (odadaki dolu renkleri okuyabilen tek taraf).
      p_color:       null,
      p_is_host:     false,
      p_claim_token: claimToken,
    },
  );

  if (insertErr || !inserted) {
    // Sunucu tarafı kararlar (kapasite, oda durumu, görünen ad) diğer modlarla
    // AYNI kullanıcı-dostu metinlere çevrilir; ham Postgres mesajı UI'ya sızmaz.
    // Eşleme saf modüldedir (conquestJoinFlow) ve orada test edilir.
    const raw = `${insertErr?.message ?? ""} ${insertErr?.details ?? ""}`;
    return mapConquestJoinFailure(raw, insertErr?.message);
  }

  // The RPC also touches conquest_rooms.updated_at so the public list refresh
  // is handled server-side; no extra UPDATE here (which would now be denied
  // by the hardened RLS for non-host clients anyway).

  const me = inserted as ConquestPlayerRow;
  rememberConquestClaim(me.id, claimToken);

  // Artık üyeyiz → yetkili okuma yolu açık. Liste alınamazsa katılma yine de
  // başarılıdır; abonelik ilk turunda listeyi zaten tazeleyecek.
  const state = await fetchConquestRoomState(room.id, me.id);
  return state.status === "ok"
    ? { ok: true, room: state.room, me, players: state.players }
    : { ok: true, room, me, players: [me] };
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

/** `fetchPublicConquestRooms` giriş yapılmamış çağrıda bunu fırlatır.
 *  ConquestRoomList bunu yakalayıp "giriş yap" ekranını gösterir. */
export class ConquestAuthRequiredError extends Error {
  constructor() {
    super("Açık odaları görüntülemek için giriş yapmalısın.");
    this.name = "ConquestAuthRequiredError";
  }
}

/**
 * List public, joinable Kuşatma rooms.
 *
 * YETKİ: SUNUCU TARAFINDA. Liste artık `conquest_list_public_rooms()`
 * SECURITY DEFINER RPC'sinden gelir; o fonksiyon yalnız `authenticated`a
 * grant'lidir ve gövdesinin ilk satırında auth.uid()'yi kontrol edip misafir
 * için `auth_required` fırlatır (20260809120000, Bölüm A1).
 *
 * ÖNCEDEN bu fonksiyon `conquest_rooms` tablosunu doğrudan sorguluyordu ve
 * "kim listeleyebilir" kontrolü YALNIZCA React tarafındaki `isLoggedIn`
 * bayrağıydı — yani gerçek bir kontrol değildi. Filtre mantığı (public +
 * waiting + son 6 saat + aktif heartbeat'li oyuncu sayısı) RPC'ye BİREBİR
 * taşındı; kayıtlı kullanıcının gördüğü liste değişmez.
 *
 * Oyuncu sayımı da sunucuda yapılır → istemci artık `conquest_players`
 * tablosunu toplu sorgulamaz (oda kodu/host/oyuncu bilgisi tek uç noktadan
 * ve yalnız yetkili çağrıya döner).
 */
export async function fetchPublicConquestRooms(): Promise<ConquestPublicRoomSummary[]> {
  const { data, error } = await supabase.rpc("conquest_list_public_rooms");

  if (error) {
    // Sessiz boş liste DÖNDÜRMEYİZ: yetki eksikliği ile "hiç oda yok" durumu
    // kullanıcıya farklı görünmeli.
    if (
      error.message?.includes("auth_required") ||
      error.code === "42501" ||
      error.code === "PGRST202"
    ) {
      throw new ConquestAuthRequiredError();
    }
    throw new Error(error.message ?? "Oda listesi alınamadı.");
  }

  type ListRow = ConquestRoomRow & { player_count: number };

  return ((data ?? []) as ListRow[]).map(row => {
    const { player_count, ...room } = row;
    return { room: room as ConquestRoomRow, playerCount: player_count ?? 0 };
  });
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

/**
 * Bir odanın durumu okunmaya çalışıldığında dönen sonuç.
 *
 * `lost` ayrı bir durumdur ve AĞ HATASI DEĞİLDİR: sunucu "sen bu odanın üyesi
 * değilsin" ya da "oda yok" dedi. Çağıran bunu oyuncuyu odadan çıkarmak için
 * kullanır; geçici hata (`error`) ile karıştırılmamalıdır, yoksa tek bir kopuk
 * istek oyuncuyu odadan atardı.
 */
export type ConquestRoomStateResult =
  | { status: "ok"; room: ConquestRoomRow; players: ConquestPlayerRow[] }
  | { status: "lost"; reason: "not_a_member" | "room_gone" }
  | { status: "error" };

/**
 * Bir odanın satırını + oyuncularını okur.
 *
 * TEK OKUMA YOLU: `conquest_get_room_state` SECURITY DEFINER RPC'si.
 * Ham `conquest_rooms` / `conquest_players` sorgusu KASTEN kullanılmaz —
 * 20260810120000 ile o tablolar `anon` rolüne kapatıldı (misafirin açık oda
 * listesini enumerasyonla çıkarmasını engellemek için). RPC, çağıranın O
 * ODADAKİ oyuncu satırının sahibi olduğunu (auth.uid() veya claim_token)
 * kanıtlamasını ister ve TEK bir odayı döndürür; filtre/limit/sıralama kabul
 * etmez.
 *
 * Kayıtlı kullanıcı da aynı yolu kullanır — misafir/kayıtlı için iki ayrı
 * okuma yolu tutmak, ikisinden birinin sessizce ayrışması demektir.
 */
export async function fetchConquestRoomState(
  roomId:   string,
  playerId: string,
): Promise<ConquestRoomStateResult> {
  const claimToken = recallConquestClaim(playerId);
  const { data, error } = await supabase.rpc("conquest_get_room_state", {
    p_room_id:     roomId,
    p_player_id:   playerId,
    p_claim_token: claimToken,
  });

  if (error || !data) return { status: "error" };

  const payload = data as {
    ok?:      boolean;
    reason?:  string;
    room?:    ConquestRoomRow;
    players?: ConquestPlayerRow[];
  };

  if (payload.ok !== true) {
    const reason = payload.reason === "room_gone" ? "room_gone" : "not_a_member";
    return { status: "lost", reason };
  }
  if (!payload.room) return { status: "error" };

  return {
    status:  "ok",
    room:    payload.room,
    players: payload.players ?? [],
  };
}

/**
 * Yalnız oyuncu listesini tazeler. Aynı yetkili RPC'yi kullanır (sunucuda
 * oyuncuları odadan ayrı okumanın bir yolu yoktur — ve olmamalıdır).
 *
 * Yetki/oda kaybı durumunda `null` döner; çağıran bunu "listeyi değiştirme"
 * olarak yorumlar, çünkü kick/oda-kapandı kararı asıl abonelik akışında
 * verilir.
 */
export async function fetchConquestPlayers(
  roomId:   string,
  playerId: string,
): Promise<ConquestPlayerRow[] | null> {
  const result = await fetchConquestRoomState(roomId, playerId);
  return result.status === "ok" ? result.players : null;
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
  roomId:   string,
  playerId: string,
): Promise<{ room: ConquestRoomRow; players: ConquestPlayerRow[] } | null> {
  // Hızlı Eşleş yalnız kayıtlı kullanıcıya açıktır, yani bu çağrı teknik
  // olarak `authenticated` RLS'iyle de çalışırdı. Yine de ortak yetkili RPC
  // kullanılır: istemcide Kuşatma odalarına ham tablo sorgusu atan TEK BİR
  // yol bile kalmasın (yarın biri bu fonksiyonu misafir akışında çağırırsa
  // sessizce enumerasyon kapısı açılmasın).
  const result = await fetchConquestRoomState(roomId, playerId);
  if (result.status !== "ok") return null;
  return { room: result.room, players: result.players };
}
