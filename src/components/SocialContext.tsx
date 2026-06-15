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
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  subscribeNotifications,
  type NotificationRow,
} from "../lib/social";

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

  roomContext: RoomContext | null;
  setRoomContext: (ctx: RoomContext | null) => void;

  /** Arkadaş listesi değişti sinyali (kabul/çıkarma sonrası panel yeniler). */
  friendsRefreshKey: number;
  bumpFriends: () => void;

  /** Profil kartı self aksiyonları (App bağlar). */
  onEditProfile?: () => void;
  onChangeAvatar?: () => void;
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
      roomContext,
      setRoomContext,
      friendsRefreshKey,
      bumpFriends,
      onEditProfile,
      onChangeAvatar,
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
      roomContext,
      friendsRefreshKey,
      bumpFriends,
      onEditProfile,
      onChangeAvatar,
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
