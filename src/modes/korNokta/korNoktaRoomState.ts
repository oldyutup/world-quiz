/**
 * korNoktaRoomState.ts — Kör Nokta odasının TEK okuma yolu + canlı abonelik.
 *
 * TEK OKUMA YOLU
 * ──────────────
 * Oda satırı ve oyuncu listesi HER İKİ kullanıcı türü için de
 * `tevatur_get_room_state` yetkili RPC'sinden okunur. `tevatur_rooms` /
 * `tevatur_players` tablolarına doğrudan `select` YAPILMAZ — 20260811120000
 * o yolu `anon` rolüne kapattı (misafirin oda/oyuncu enumerasyonu yapmasını
 * engellemek için). Kayıtlı kullanıcıda tablo hâlâ okunabilir olsa da tek
 * yol kullanılır: iki ayrı okuma yolu olsaydı biri değişip diğeri unutulurdu.
 *
 * İKİ TAŞIYICI (yalnız "değişti" haberi farklı gelir)
 * ───────────────────────────────────────────────────
 *   • KAYITLI kullanıcı → `postgres_changes`.
 *     Tabloların SELECT policy'si `authenticated` rolüne açık olduğu için
 *     Realtime bu aboneye satır olaylarını gönderebilir. Bu yol DEĞİŞMEDİ.
 *
 *   • MİSAFİR → private broadcast kanalı `kornokta:<room_id>` + yoklama.
 *     RLS kapandığı an `postgres_changes` misafire olay göndermeyi bırakır —
 *     bu KAÇINILMAZ, çünkü Realtime satır yetkisini RLS'e sorar. Yerine
 *     sunucudaki trigger'lar odaya özel bir kanala SİNYAL yollar; sinyal
 *     oyuncu adı, takım, rol, rapor, cevap ya da claim_token TAŞIMAZ —
 *     yalnız `{room_id, op, src}`. Gerçek veri her zaman yetkili RPC'den
 *     okunur.
 *
 * NEDEN AYRICA YOKLAMA VAR
 * ------------------------
 * Private kanal `realtime.messages` üzerindeki bir policy'ye bağlıdır ve o
 * şema Supabase tarafından yönetilir; migration policy'yi kuramazsa UYARI
 * bırakıp devam eder. O durumda sinyal HİÇ gelmez. Yoklama olmasaydı
 * misafirin ekranı sessizce donardı:
 *
 *   • Sinyal gelmiyorsa → hızlı yoklama (POLL_FAST_MS).
 *   • Sinyal geliyorsa  → yavaş yoklama (POLL_SLOW_MS); emniyet ağı.
 *
 * Yaşam döngüsü: çağıran dönen handle'ı saklar ve unmount'ta `unsubscribe()`
 * çağırır.
 */

import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase, type TevaturPlayer, type TevaturRoom } from "../../lib/supabase";

/** Sinyal akarken kullanılan emniyet-ağı aralığı. */
const POLL_SLOW_MS = 10_000;
/** Hiç sinyal gelmediğinde kullanılan aralık (tek canlılık kaynağı budur). */
const POLL_FAST_MS = 1_200;
/** Arka arkaya gelen sinyalleri tek okumaya indirger. */
const SIGNAL_DEBOUNCE_MS = 80;
/** Bu süre boyunca sinyal gelmezse kanal ölü sayılır → hızlı yoklamaya dön. */
const SIGNAL_STALE_MS = 30_000;

/* ═══════════════════════════════════════════════════════════════
   OKUMA
═══════════════════════════════════════════════════════════════ */

export type KnRoomStateResult =
  | { status: "ok"; room: TevaturRoom; players: TevaturPlayer[] }
  /** Artık bu odanın üyesi değilim (atıldım ya da oda kapandı). Geçici ağ
   *  hatasından AYRI bir durum — oyuncu güvenle odadan çıkarılabilir. */
  | { status: "lost" }
  /** Geçici hata (ağ/sunucu). Durum BİLİNMİYOR → hiçbir şey yapma, tekrar dene. */
  | { status: "error" };

/**
 * Odanın kanonik durumunu okur. Sunucu üyeliği claim_token ile doğrular ve
 * YALNIZ üyesi olunan odayı döndürür; başka bir room_id verilirse
 * `not_a_member` döner (odanın var olup olmadığı bilgisi sızmaz).
 */
export async function fetchKorNoktaRoomState(
  roomId:     string,
  playerId:   string,
  claimToken: string,
): Promise<KnRoomStateResult> {
  if (!roomId || !playerId || !claimToken) return { status: "error" };

  const { data, error } = await supabase.rpc("tevatur_get_room_state", {
    p_room_id:     roomId,
    p_player_id:   playerId,
    p_claim_token: claimToken,
  });

  // Ağ/sunucu hatası: üyelik BİTMİŞ SAYILMAZ. Aksi hâlde tek bir kopukluk
  // oyuncuyu odadan atardı.
  if (error || !data || typeof data !== "object") return { status: "error" };

  const payload = data as {
    ok?: boolean;
    reason?: string;
    room?: TevaturRoom;
    players?: TevaturPlayer[];
  };

  if (!payload.ok) {
    // not_a_member / room_gone → üyelik bitti. Diğer (beklenmeyen) sebepler
    // geçici sayılır.
    return payload.reason === "not_a_member" || payload.reason === "room_gone"
      ? { status: "lost" }
      : { status: "error" };
  }

  if (!payload.room) return { status: "error" };

  return {
    status:  "ok",
    room:    payload.room,
    players: Array.isArray(payload.players) ? payload.players : [],
  };
}

/* ═══════════════════════════════════════════════════════════════
   ABONELİK
═══════════════════════════════════════════════════════════════ */

/** Üyeliğin bitme sebebi — kullanıcıya gösterilecek bildirimi belirler. */
export type KnMembershipLostCause = "kicked" | "room_closed";

export interface KnRoomSubscriptionHandlers {
  /** Oda satırı değişti (ayarlar, durum, game_state…). */
  onRoomUpdate?:     (room: TevaturRoom) => void;
  /** Oyuncu listesi değişti — her zaman TAM ve sıralı liste gelir. */
  onPlayersChange?:  (players: TevaturPlayer[]) => void;
  /** Artık odanın üyesi değilim. */
  onMembershipLost?: (cause: KnMembershipLostCause) => void;
}

export interface KnRoomSubscriptionArgs {
  roomId:     string;
  playerId:   string;
  claimToken: string;
  /** Hesabı olmayan oyuncu mu? (postgres_changes yerine sinyal + yoklama.) */
  isGuest:    boolean;
  handlers:   KnRoomSubscriptionHandlers;
}

export interface KnRoomSubscription {
  unsubscribe: () => void;
}

export function subscribeToKorNoktaRoom(
  args: KnRoomSubscriptionArgs,
): KnRoomSubscription {
  const { roomId, playerId, claimToken, isGuest, handlers } = args;

  return isGuest
    ? subscribeAsGuest(roomId, playerId, claimToken, handlers)
    : subscribeAsMember(roomId, playerId, claimToken, handlers);
}

// ─────────────────────────────────────────────────────────────────────────────
// KAYITLI kullanıcı — postgres_changes (mevcut davranış)
// ─────────────────────────────────────────────────────────────────────────────

function subscribeAsMember(
  roomId:     string,
  playerId:   string,
  claimToken: string,
  handlers:   KnRoomSubscriptionHandlers,
): KnRoomSubscription {
  let disposed = false;

  const channel = supabase
    .channel(`kornokta:${roomId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "tevatur_rooms", filter: `id=eq.${roomId}` },
      payload => {
        if (payload.new) handlers.onRoomUpdate?.(payload.new as TevaturRoom);
      },
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "tevatur_rooms", filter: `id=eq.${roomId}` },
      () => { handlers.onMembershipLost?.("room_closed"); },
    )
    // Herhangi bir oyuncu değişikliği → tam listeyi yetkili RPC'den yeniden
    // oku (sıralama/sayım otoritesi sunucuda kalsın). Odalar küçük, ucuz.
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "tevatur_players", filter: `room_id=eq.${roomId}` },
      () => {
        void fetchKorNoktaRoomState(roomId, playerId, claimToken).then(result => {
          if (disposed) return;
          if (result.status === "ok") {
            handlers.onPlayersChange?.(result.players);
            return;
          }
          // Kendi satırım gitmiş → atıldım. (Oda silinmiş olsaydı yukarıdaki
          // DELETE aboneliği ayrıca haber verirdi.)
          if (result.status === "lost") handlers.onMembershipLost?.("kicked");
        });
      },
    )
    .subscribe();

  return {
    unsubscribe: () => {
      disposed = true;
      void supabase.removeChannel(channel);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MİSAFİR — sunucu sinyali + yetkili okuma + yoklama emniyet ağı
// ─────────────────────────────────────────────────────────────────────────────

function subscribeAsGuest(
  roomId:     string,
  playerId:   string,
  claimToken: string,
  handlers:   KnRoomSubscriptionHandlers,
): KnRoomSubscription {
  let disposed        = false;
  let inFlight        = false;
  let lastRoomJson    = "";
  let lastPlayersJson = "";
  let lastSignalAt    = 0;
  let debounce:  ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  /** Son başarılı okumadan BU YANA görülen silinme sinyali.
   *  Üyelik bittiğinde "atıldım" ile "oda kapandı"yı ayırmak için tek ipucu
   *  budur: sinyal yükü veri taşımadığı için sunucuya "oda hâlâ duruyor mu?"
   *  diye SORAMAYIZ — o soru üye olmayana oda varlığını sızdırırdı.
   *  Bilgi yoksa "oda kapandı" varsayılır: hem daha sık görülen durum budur
   *  hem de yanlış "odadan atıldın" demekten daha az rahatsız edicidir. */
  let lastDeleteSrc: "rooms" | "players" | null = null;

  /** Sinyal son SIGNAL_STALE_MS içinde geldiyse kanal sağlıklı sayılır. */
  const signalsHealthy = () =>
    lastSignalAt > 0 && Date.now() - lastSignalAt < SIGNAL_STALE_MS;

  async function refresh(): Promise<void> {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      const result = await fetchKorNoktaRoomState(roomId, playerId, claimToken);
      if (disposed) return;

      if (result.status === "lost") {
        handlers.onMembershipLost?.(
          lastDeleteSrc === "players" ? "kicked" : "room_closed",
        );
        return;
      }
      if (result.status !== "ok") return;   // geçici hata → bir sonraki tur

      lastDeleteSrc = null;   // hâlâ üyeyim → eski silinme ipuçları geçersiz

      // Değişmemiş veriyi yukarı göndermeyiz: yoklama saniyede bir koşuyor,
      // her turda yeni nesne yollamak sürekli yeniden render demek olurdu.
      const roomJson = JSON.stringify(result.room);
      if (roomJson !== lastRoomJson) {
        lastRoomJson = roomJson;
        handlers.onRoomUpdate?.(result.room);
      }

      const playersJson = JSON.stringify(result.players);
      if (playersJson !== lastPlayersJson) {
        lastPlayersJson = playersJson;
        handlers.onPlayersChange?.(result.players);
      }
    } finally {
      inFlight = false;
    }
  }

  function scheduleRefresh(): void {
    if (disposed || debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      void refresh();
    }, SIGNAL_DEBOUNCE_MS);
  }

  function scheduleNextPoll(): void {
    if (disposed) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      await refresh();
      scheduleNextPoll();
    }, signalsHealthy() ? POLL_SLOW_MS : POLL_FAST_MS);
  }

  // Sunucu trigger'ları bu konuya yalnız SİNYAL gönderir; oda verisi kanaldan
  // GEÇMEZ (bkz. migration 20260811120000 §5). Kanal private'tır: dinleme
  // yetkisi realtime.messages policy'sine bağlıdır.
  const channel: RealtimeChannel = supabase.channel(
    `kornokta:${roomId}`,
    { config: { private: true } },
  );

  channel
    .on("broadcast", { event: "kornokta_change" }, message => {
      lastSignalAt = Date.now();
      const payload = (message as { payload?: { op?: string; src?: string } }).payload;
      if (payload?.op === "DELETE") {
        // Oda silinmesi oyuncu satırlarını da cascade siler → iki sinyal de
        // gelir. "rooms" daha kesin bilgidir, "players" ile EZİLMEZ.
        if (payload.src === "rooms") lastDeleteSrc = "rooms";
        else if (lastDeleteSrc !== "rooms" && payload.src === "players") lastDeleteSrc = "players";
      }
      scheduleRefresh();
    })
    .subscribe();

  // İlk kare boş kalmasın.
  void refresh();
  scheduleNextPoll();

  return {
    unsubscribe: () => {
      disposed = true;
      if (debounce)  clearTimeout(debounce);
      if (pollTimer) clearTimeout(pollTimer);
      void supabase.removeChannel(channel);
    },
  };
}
