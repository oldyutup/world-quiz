/**
 * Conquest (Kuşatma) — canlı oda aboneliği.
 *
 * İKİ TAŞIYICI, TEK OKUMA YOLU
 * ────────────────────────────
 * Oda verisi HER İKİ durumda da `conquest_get_room_state` yetkili RPC'sinden
 * okunur (bkz. conquestService.fetchConquestRoomState). Değişen yalnızca
 * "bir şey değişti" haberinin nereden geldiğidir:
 *
 *   • KAYITLI kullanıcı → `postgres_changes`.
 *     `conquest_rooms` / `conquest_players` SELECT policy'si `authenticated`
 *     rolüne açık olduğu için Realtime bu aboneye satır olaylarını gönderebilir.
 *     Bu yol DEĞİŞMEDİ — mevcut kayıtlı kullanıcı akışı aynen korunur.
 *
 *   • MİSAFİR → private broadcast kanalı `conquest:<room_id>` + yoklama.
 *     20260810120000 ham tablo okumasını `anon` rolüne kapattı (misafirin açık
 *     oda listesini enumerasyonla çıkarmasını engellemek için). RLS kapandığı
 *     an `postgres_changes` misafire olay göndermeyi bırakır — bu KAÇINILMAZ,
 *     çünkü Realtime satır yetkisini RLS'e sorar. Yerine sunucudaki trigger'lar
 *     odaya özel bir kanala SİNYAL yollar; sinyal veri TAŞIMAZ, istemci veriyi
 *     her zaman yetkili RPC'den okur.
 *
 * NEDEN AYRICA YOKLAMA VAR
 * ------------------------
 * Private kanal `realtime.messages` üzerinde bir RLS policy'sine bağlıdır ve o
 * şema Supabase tarafından yönetilir; migration policy'yi kuramazsa (sürüm/
 * yetki farkı) UYARI bırakıp devam eder. O durumda sinyal HİÇ gelmez.
 * Yoklama olmasaydı misafirin ekranı sessizce donardı — donmuş bir tahta,
 * gecikmeli bir tahtadan çok daha kötüdür. Bu yüzden yoklama bir "yedek" değil,
 * doğruluk garantisidir:
 *
 *   • Sinyal gelmiyorsa   → hızlı yoklama (POLL_FAST_MS).
 *   • Sinyal geliyorsa    → yavaş yoklama (POLL_SLOW_MS); güncellemeler zaten
 *                           anında geldiği için yoklama yalnız emniyet ağıdır.
 *
 * Yaşam döngüsü: çağıran dönen handle'ı saklar ve unmount'ta `unsubscribe()`
 * çağırır.
 */

import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  supabase,
  type ConquestPlayerRow,
  type ConquestRoomRow,
} from "../../lib/supabase";
import { fetchConquestRoomState } from "./conquestService";

/** Sinyal akarken kullanılan emniyet-ağı aralığı. */
const POLL_SLOW_MS = 10_000;
/** Hiç sinyal gelmediğinde kullanılan aralık (tek canlılık kaynağı budur). */
const POLL_FAST_MS = 1_200;
/** Arka arkaya gelen sinyalleri tek okumaya indirger. */
const SIGNAL_DEBOUNCE_MS = 80;
/** Bu süre boyunca sinyal gelmezse kanal ölü sayılır → hızlı yoklamaya dön. */
const SIGNAL_STALE_MS = 30_000;

export interface ConquestRoomSubscriptionHandlers {
  /** Oda satırı değiştiğinde (ayarlar, durum, gameplay_state…). */
  onRoomUpdate?:  (room: ConquestRoomRow) => void;
  /** Oda satırı silindiğinde ya da artık okunamadığında (üyelik bitti). */
  onRoomDelete?:  () => void;
  /** Oyuncu listesi değiştiğinde — her zaman TAM ve sıralı liste gelir. */
  onPlayersChange?: (players: ConquestPlayerRow[]) => void;
}

export interface ConquestRoomSubscriptionArgs {
  roomId:   string;
  /** Çağıranın kendi oyuncu satırı — yetkili okuma yolu bunu ister. */
  playerId: string | null;
  /** Hesabı olmayan oyuncu mu? (postgres_changes yerine sinyal + yoklama.) */
  isGuest:  boolean;
  handlers: ConquestRoomSubscriptionHandlers;
}

export interface ConquestRoomSubscription {
  unsubscribe: () => void;
}

/**
 * Tek bir odanın satırına + oyuncu listesine abone olur.
 */
export function subscribeToConquestRoom(
  args: ConquestRoomSubscriptionArgs,
): ConquestRoomSubscription {
  const { roomId, playerId, isGuest, handlers } = args;

  return isGuest && playerId
    ? subscribeAsGuest(roomId, playerId, handlers)
    : subscribeAsMember(roomId, playerId, handlers);
}

// ─────────────────────────────────────────────────────────────────────────────
// KAYITLI kullanıcı — postgres_changes (mevcut davranış)
// ─────────────────────────────────────────────────────────────────────────────

function subscribeAsMember(
  roomId:   string,
  playerId: string | null,
  handlers: ConquestRoomSubscriptionHandlers,
): ConquestRoomSubscription {
  const channel = supabase
    .channel(`conquest:${roomId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "conquest_rooms", filter: `id=eq.${roomId}` },
      payload => {
        if (handlers.onRoomUpdate && payload.new) {
          handlers.onRoomUpdate(payload.new as ConquestRoomRow);
        }
      },
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "conquest_rooms", filter: `id=eq.${roomId}` },
      () => { handlers.onRoomDelete?.(); },
    )
    // Herhangi bir oyuncu değişikliği → tam listeyi yeniden oku (sıralama ve
    // sayım otoritesi sunucuda kalsın). Kuşatma odaları küçük olduğu için ucuz.
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "conquest_players", filter: `room_id=eq.${roomId}` },
      () => {
        if (!handlers.onPlayersChange || !playerId) return;
        void fetchConquestRoomState(roomId, playerId).then(result => {
          if (result.status === "ok") handlers.onPlayersChange!(result.players);
        });
      },
    )
    .subscribe();

  return {
    unsubscribe: () => { void supabase.removeChannel(channel); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MİSAFİR — sunucu sinyali + yetkili okuma + yoklama emniyet ağı
// ─────────────────────────────────────────────────────────────────────────────

function subscribeAsGuest(
  roomId:   string,
  playerId: string,
  handlers: ConquestRoomSubscriptionHandlers,
): ConquestRoomSubscription {
  let disposed      = false;
  let inFlight      = false;
  let lastRoomJson  = "";
  let lastPlayersJson = "";
  let lastSignalAt  = 0;
  let debounce:  ReturnType<typeof setTimeout>  | null = null;
  let pollTimer: ReturnType<typeof setTimeout>  | null = null;

  /** Sinyal son SIGNAL_STALE_MS içinde geldiyse kanal sağlıklı sayılır. */
  const signalsHealthy = () =>
    lastSignalAt > 0 && Date.now() - lastSignalAt < SIGNAL_STALE_MS;

  async function refresh(): Promise<void> {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      const result = await fetchConquestRoomState(roomId, playerId);
      if (disposed) return;

      if (result.status === "lost") {
        // Üyelik bitti (atıldı) ya da oda silindi. Geçici ağ hatasından AYRI
        // bir durum — bu yüzden oyuncuyu güvenle odadan çıkarabiliriz.
        handlers.onRoomDelete?.();
        return;
      }
      if (result.status !== "ok") return;   // geçici hata → bir sonraki tur

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
  // GEÇMEZ (bkz. migration A4). Kanal private'tır: dinleme yetkisi
  // realtime.messages policy'sine bağlıdır.
  const channel: RealtimeChannel = supabase.channel(
    `conquest:${roomId}`,
    { config: { private: true } },
  );

  channel
    .on("broadcast", { event: "conquest_change" }, () => {
      lastSignalAt = Date.now();
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
