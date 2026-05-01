import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// POST /api/disconnect  (called via navigator.sendBeacon from the browser)
// Body: { roomId: string, playerId: string, disconnect_at: string }
//
// Updates duel_rooms:
//   disconnected_player_id = playerId
//   disconnect_at          = disconnect_at
// WHERE id = roomId
//
// No WHERE on player_id — the browser may have any role (host or joined).

Deno.serve(async (req: Request) => {
  // sendBeacon always sends POST; allow OPTIONS for local testing
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: { roomId?: string; playerId?: string; disconnect_at?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const { roomId, playerId, disconnect_at } = body;

  if (!roomId || !playerId || !disconnect_at) {
    return new Response("Missing fields", { status: 400 });
  }

  // Use service-role key so RLS doesn't block the update
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { error } = await supabase
    .from("duel_rooms")
    .update({
      disconnected_player_id: playerId,
      disconnect_at,
    })
    .eq("id", roomId)
    .eq("status", "playing"); // only update if game is still active

  if (error) {
    console.error("[disconnect fn] update error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  console.log("[disconnect fn] updated roomId:", roomId, "playerId:", playerId);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
});
