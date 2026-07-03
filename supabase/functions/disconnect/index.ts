import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// POST /api/disconnect
// Body: { roomId: string, playerId: string, claimToken?: string }
//
// Records that the CALLER (playerId) has disconnected from their own active
// duel room, so the opponent's client can later finish the match via the
// duel_handle_disconnect RPC. Effect:
//   duel_rooms.disconnected_player_id = playerId   (only the caller's own id)
//   duel_rooms.disconnect_at          = <server clock>
//   WHERE id = roomId AND status = 'playing'
//
// SECURITY MODEL
// --------------
// This endpoint uses the service-role key, which BYPASSES RLS. Every other
// duel write goes through SECURITY DEFINER RPCs guarded by
// duel_authorize_player (claim_token or auth.uid()); after the M2/M3
// hardening, direct client writes to duel_rooms are denied. Therefore this
// function MUST reproduce the same ownership proof before it writes, or it
// re-opens the exact hole the RLS lockdown closed (any anon caller could
// otherwise spoof the disconnect state of any live match / any player, since
// duel_rooms is publicly SELECTable and room/player ids are discoverable).
//
// The service-role key is used for TWO things only, and only AFTER ownership
// is proven: (1) reading the RLS-locked duel_player_claims table to VERIFY the
// caller's claim_token, and (2) performing the final scoped write. Client
// input is never trusted.
//
// The CORS headers below are a browser convenience, NOT a security boundary
// (CORS is enforced by browsers, not by the server). Security comes solely
// from the ownership checks in this handler.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
} as const;

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body: { roomId?: unknown; playerId?: unknown; claimToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const roomId = typeof body?.roomId === "string" ? body.roomId : "";
  const playerId = typeof body?.playerId === "string" ? body.playerId : "";
  const claimToken = typeof body?.claimToken === "string" ? body.claimToken : "";

  if (!roomId || !playerId) {
    return json({ error: "missing_fields" }, 400);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // 1) The player must exist and actually belong to the claimed room. A bad
  //    uuid makes this query error → fail closed. This prevents marking a
  //    player from a *different* room as disconnected.
  const { data: player, error: playerErr } = await admin
    .from("duel_players")
    .select("id, room_id, profile_id")
    .eq("id", playerId)
    .maybeSingle();

  if (playerErr || !player || player.room_id !== roomId) {
    return json({ error: "not_authorized" }, 403);
  }

  // 2) Ownership proof — mirrors public.duel_authorize_player:
  //    (a) logged-in caller whose verified JWT subject == duel_players.profile_id, or
  //    (b) guest/any caller who presents the matching claim_token.
  //    Both cover the real disconnect flows; (b) also works with
  //    navigator.sendBeacon, which cannot attach an Authorization header — the
  //    claim_token travels in the request body (over HTTPS), never the URL.
  let authorized = false;

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (jwt && player.profile_id) {
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (!userErr && userData?.user?.id && userData.user.id === player.profile_id) {
      authorized = true;
    }
  }

  if (!authorized && claimToken) {
    const { data: claim, error: claimErr } = await admin
      .from("duel_player_claims")
      .select("claim_token")
      .eq("player_id", playerId)
      .maybeSingle();
    if (!claimErr && claim?.claim_token && claim.claim_token === claimToken) {
      authorized = true;
    }
  }

  if (!authorized) {
    return json({ error: "not_authorized" }, 403);
  }

  // 3) Never trust a client-supplied timestamp — it feeds the grace/finish
  //    threshold. Compute it from the server clock.
  const disconnectAt = new Date().toISOString();

  // 4) A player may only mark THEMSELVES disconnected, only while the game is
  //    still active.
  const { error: updErr } = await admin
    .from("duel_rooms")
    .update({
      disconnected_player_id: playerId,
      disconnect_at: disconnectAt,
    })
    .eq("id", roomId)
    .eq("status", "playing");

  if (updErr) {
    console.error("[disconnect fn] update error:", updErr);
    return json({ error: "update_failed" }, 500);
  }

  return json({ ok: true }, 200);
});
