/**
 * SocialContext.tsx — sosyal sistemin oturum-genel durumu.
 *
 * Tek bir provider App kökünde mount edilir ve şunları tutar:
 *   - Oturum açık kullanıcının bildirimleri + okunmamış sayısı
 *   - notifications tablosuna realtime aboneliği (yeni bildirim → badge + toast)
 *   - Aktif "oda context"i (code/mode/url) — lobiler odaya girince set eder;
 *     PlayerProfileCard "Davet Et" bununla aktifleşir
 *   - Profil kartındaki KENDİ aksiyonlarım (Profili Düzenle / Avatarı Değiştir)
 *     ve reward/davet yönlendirmeleri için App'ten gelen callback'ler
 *   - Hafif global toast (proje genelinde ortak toast yoktu)
 *
 * Desktop web, mobil web ve native iOS/app aynı provider'ı kullanır.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { Profile } from "../lib/auth";
import { supabase } from "../lib/supabase";
import {
  clearMyNotifications,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  subscribeNotifications,
  type ClearNotificationsResult,
  type NotificationRow,
} from "../lib/social";
import {
  claimDailyBonusAsync,
  refreshDailyReward,
  useDailyReward,
} from "../lib/gold";

export interface RoomContext {
  /** 6 karakterli oda kodu. */
  code: string;
  /** Mod anahtarı (conquest, duel, flagDuel, wheelDuel, wheelGroup, korNokta). */
  mode: string;
  /** Davet linki — örn. "/?conquest=K6MEDT". */
  roomUrl: string;
}

interface SocialContextValue {
  profile: Profile | null;
  notifications: NotificationRow[];
  unreadCount: number;
  refreshNotifications: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** Bildirimleri temizler (aksiyon gerektirenler korunur); sonucu döndürür. */
  clearNotifications: () => Promise<ClearNotificationsResult>;

  /** Günlük +50 Gold bonusu şu an alınabilir mi? (server-otoriteli) */
  dailyRewardAvailable: boolean;
  /** "+50 Gold'u Al" — claim_daily_gold_bonus üzerinden alır, toast gösterir. */
  claimDailyReward: () => Promise<void>;

  roomContext: RoomContext | null;
  setRoomContext: (ctx: RoomContext | null) => void;

  /** Arkadaş listesi değişti sinyali (kabul/çıkarma sonrası panel yeniler). */
  friendsRefreshKey: number;
  bumpFriends: () => void;

  /** Profil kartı self aksiyonları (App bağlar). */
  onEditProfile?: () => void;
  onChangeAvatar?: () => void;
  /** Rozet slotuna tıklayınca sergileme editörünü açar (App bağlar). */
  onShowcaseBadges?: () => void;
  /** reward_ready bildirimi → ödül toplama ekranı (App bağlar). */
  onOpenRewards?: () => void;
  /** room_invite "Katıl" → oda linkine yönlendirme (App bağlar). */
  onJoinRoom?: (roomUrl: string) => void;

  toast: (message: string) => void;
}

const Ctx = createContext<SocialContextValue | null>(null);

export function useSocial(): SocialContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error("useSocial must be used within <SocialProvider>");
  }
  return v;
}

/** Provider dışında çağrılırsa patlamayan güvenli varyant (opsiyonel tüketiciler). */
export function useSocialOptional(): SocialContextValue | null {
  return useContext(Ctx);
}

interface SocialProviderProps {
  profile: Profile | null;
  onEditProfile?: () => void;
  onChangeAvatar?: () => void;
  onShowcaseBadges?: () => void;
  onOpenRewards?: () => void;
  onJoinRoom?: (roomUrl: string) => void;
  children: ReactNode;
}

interface ToastItem {
  id: number;
  message: string;
}

export function SocialProvider({
  profile,
  onEditProfile,
  onChangeAvatar,
  onShowcaseBadges,
  onOpenRewards,
  onJoinRoom,
  children,
}: SocialProviderProps) {
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [roomContext, setRoomContext] = useState<RoomContext | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [friendsRefreshKey, setFriendsRefreshKey] = useState(0);
  const toastSeq = useRef(0);

  const bumpFriends = useCallback(() => setFriendsRefreshKey((k) => k + 1), []);

  const profileId = profile?.id ?? null;

  const refreshNotifications = useCallback(async () => {
    if (!profileId) {
      setNotifications([]);
      return;
    }
    const rows = await fetchNotifications();
    setNotifications(rows);
  }, [profileId]);

  const toast = useCallback((message: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  // İlk yükleme + login değişiminde fetch.
  useEffect(() => {
    void refreshNotifications();
  }, [refreshNotifications]);

  // Realtime: yeni bildirim → listeye ekle + toast. Final hedef realtime;
  // panel açılışında ayrıca fetch (NotificationCenter) fallback sağlar.
  useEffect(() => {
    if (!profileId) return;
    const channel = subscribeNotifications(profileId, (row) => {
      setNotifications((prev) => {
        if (prev.some((n) => n.id === row.id)) return prev;
        return [row, ...prev];
      });
      toast(row.title);
    });
    return () => {
      void supabaseRemoveChannel(channel);
    };
  }, [profileId, toast]);

  const markRead = useCallback(async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n))
    );
    await markNotificationRead(id);
  }, []);

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    setNotifications((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: now })));
    await markAllNotificationsRead();
  }, []);

  const clearNotifications = useCallback(async (): Promise<ClearNotificationsResult> => {
    const res = await clearMyNotifications();
    // Server hangi satırları koruduğunun otoritesi → başarıda yeniden fetch.
    // (Realtime yalnız INSERT dinler; DELETE push'u yok, bu yüzden manuel refresh.)
    if (res.ok) await refreshNotifications();
    return res;
  }, [refreshNotifications]);

  /* ── Günlük +50 Gold bonusu (server-otoriteli, gold.ts gözlemlenebilir) ──
   * Tek otorite: claim_daily_gold_bonus + gold_transactions. Burada yalnız
   * uygunluğu tazeleyip badge'e + bildirim kartına yansıtıyoruz. İkinci bir
   * sayaç/state yok; "+50 Gold'u Al" yine mevcut RPC'den geçer. */
  const daily = useDailyReward();

  // Login değişiminde uygunluğu server'dan tazele.
  useEffect(() => {
    if (profileId) void refreshDailyReward();
  }, [profileId]);

  // Sekmeye geri dönünce / görünür olunca tazele (gün dönmüş olabilir,
  // ya da başka sekmede claim edilmiş olabilir).
  useEffect(() => {
    if (!profileId) return;
    const onActive = () => {
      if (document.visibilityState === "visible") void refreshDailyReward();
    };
    window.addEventListener("focus", onActive);
    document.addEventListener("visibilitychange", onActive);
    return () => {
      window.removeEventListener("focus", onActive);
      document.removeEventListener("visibilitychange", onActive);
    };
  }, [profileId]);

  // Uygulama açıkken bonus zamanı gelince (server availableAt) durumu yenile.
  useEffect(() => {
    if (!profileId || daily.available || !daily.availableAt) return;
    const ms = new Date(daily.availableAt).getTime() - Date.now();
    if (ms <= 0) {
      void refreshDailyReward();
      return;
    }
    // setTimeout 32-bit sınırı; uzun beklemede de güvenli.
    const t = window.setTimeout(() => void refreshDailyReward(), Math.min(ms + 1000, 2_000_000_000));
    return () => window.clearTimeout(t);
  }, [profileId, daily.available, daily.availableAt]);

  const claimDailyReward = useCallback(async () => {
    const res = await claimDailyBonusAsync();
    if (res.ok) {
      toast("Günlük bonusun hesabına eklendi: +50 Gold 🎁");
    } else if (res.code === "already_claimed") {
      toast("Günlük bonusu bugün zaten aldın.");
    } else {
      toast("Bonus alınamadı, tekrar dene.");
    }
    // Bir sonraki uygunluk anını (availableAt) server'dan al.
    void refreshDailyReward();
  }, [toast]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read_at).length,
    [notifications]
  );

  const value = useMemo<SocialContextValue>(
    () => ({
      profile,
      notifications,
      unreadCount,
      refreshNotifications,
      markRead,
      markAllRead,
      clearNotifications,
      dailyRewardAvailable: daily.available,
      claimDailyReward,
      roomContext,
      setRoomContext,
      friendsRefreshKey,
      bumpFriends,
      onEditProfile,
      onChangeAvatar,
      onShowcaseBadges,
      onOpenRewards,
      onJoinRoom,
      toast,
    }),
    [
      profile,
      notifications,
      unreadCount,
      refreshNotifications,
      markRead,
      markAllRead,
      clearNotifications,
      daily.available,
      claimDailyReward,
      roomContext,
      friendsRefreshKey,
      bumpFriends,
      onEditProfile,
      onChangeAvatar,
      onShowcaseBadges,
      onOpenRewards,
      onJoinRoom,
      toast,
    ]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {toasts.length > 0 && (
        <div className="social-toast-host" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="social-toast">
              {t.message}
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}

// supabase.removeChannel için küçük sarmalayıcı (channel null olabilir).
function supabaseRemoveChannel(channel: RealtimeChannel | null): void {
  if (channel) void supabase.removeChannel(channel);
}
