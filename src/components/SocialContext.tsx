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
  fetchFriendRequestStatuses,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  resolveRoomInviteInvalid,
  subscribeNotifications,
  type ClearNotificationsResult,
  type FriendRequestStatus,
  type NotificationRow,
} from "../lib/social";
import {
  claimDailyBonusAsync,
  refreshDailyReward,
  useDailyReward,
} from "../lib/gold";
import { NotificationToaster } from "./NotificationToaster";

/** Düz bilgi/onay toast'ı (ör. "Davet gönderildi."). Kısa ömürlü. */
export interface InfoToast {
  toastId: number;
  kind: "info";
  message: string;
}

/** Gerçek bir bildirim satırından doğan, aksiyon taşıyabilen toast. */
export interface NotifToast {
  toastId: number;
  kind: "notification";
  notification: NotificationRow;
}

/** Toaster'ın çözüp DM toast'ının `open` çağrısına geçirdiği gönderen profili. */
export interface DmToastActor {
  username: string | null;
  avatarId: string | null;
  frameId: string | null;
}

/**
 * Arkadaştan gelen yeni bir DM için sağ-alt toast. Tıklanınca ilgili sohbeti
 * açar (`open` closure'ı DmProvider'dan gelir; sağlayıcı sınırını aşmadan
 * çalışır). Avatar/kullanıcı adı toaster tarafında (useRosterProfiles) çözülür.
 */
export interface DmToast {
  toastId: number;
  kind: "dm";
  /** Gönderen (arkadaş) profil id — avatar/ad çözümü ve sohbet açımı için. */
  senderId: string;
  /** Tek satırlık, temizlenmiş mesaj önizlemesi. */
  preview: string;
  /** Toast'a tıklanınca sohbeti açar (toaster çözdüğü profili geçirir). */
  open: (actor: DmToastActor | null) => void;
}

export type ActiveToast = InfoToast | NotifToast | DmToast;

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
  /** Bir oda/oyun davetini KALICI olarak "geçersiz" işaretler (oda kapanmış/
   *  başlamış/silinmiş). Anında pasif duruma geçirir + server'a damgalar. */
  markInviteInvalid: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** Bildirimleri temizler (aksiyon gerektirenler korunur); sonucu döndürür. */
  clearNotifications: () => Promise<ClearNotificationsResult>;

  /** friend_request bildirimlerinin kaynak istek durumu (id→status). Kartlar
   *  bayat "Kabul/Reddet" göstermesin diye payload'a değil buna bakar. */
  friendRequestStatuses: Record<string, FriendRequestStatus>;
  /** Bir kaynak isteğin durumunu iyimser (anlık) günceller — kabul/reddet
   *  sonrası buton hemen kalksın; refreshNotifications ardından DB'den teyit eder. */
  setFriendRequestStatus: (requestId: string, status: FriendRequestStatus) => void;

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
  /** Kendi profilimi düzenleme modallarından biri açık mı (App bağlar). Profil
   *  kartı, üstte açık editör varken ESC ile kapanmaz; editör kapanınca kart
   *  kendini tazeler. */
  profileEditorOpen?: boolean;
  /** reward_ready bildirimi → ödül toplama ekranı (App bağlar). */
  onOpenRewards?: () => void;
  /** room_invite "Katıl" → oda linkine yönlendirme (App bağlar). */
  onJoinRoom?: (roomUrl: string) => void;

  /** Düz bilgi/onay toast'ı gösterir (kısa ömürlü). */
  toast: (message: string) => void;
  /** Arkadaş DM'i için sağ-alt toast'ı kuyruğa alır (aynı gönderenden varsa
   *  yenisiyle güncellenir → duplicate kart yığmaz). DmProvider çağırır. */
  pushDmToast: (payload: {
    senderId: string;
    preview: string;
    open: (actor: DmToastActor | null) => void;
  }) => void;
  /** Ekranda + sırada bekleyen tüm toast'lar (NotificationToaster tüketir). */
  activeToasts: ActiveToast[];
  /** Bir toast'ı kapatır (× / aksiyon / otomatik süre). */
  dismissToast: (toastId: number) => void;
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
  profileEditorOpen?: boolean;
  children: ReactNode;
}

export function SocialProvider({
  profile,
  onEditProfile,
  onChangeAvatar,
  onShowcaseBadges,
  onOpenRewards,
  onJoinRoom,
  profileEditorOpen,
  children,
}: SocialProviderProps) {
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [friendRequestStatuses, setFriendRequestStatuses] = useState<
    Record<string, FriendRequestStatus>
  >({});
  const [roomContext, setRoomContext] = useState<RoomContext | null>(null);
  const [activeToasts, setActiveToasts] = useState<ActiveToast[]>([]);
  const [friendsRefreshKey, setFriendsRefreshKey] = useState(0);
  const toastSeq = useRef(0);
  // Aynı bildirimi iki kez toast etmemek için (realtime replay/yeniden bağlanma).
  const toastedNotifIds = useRef<Set<string>>(new Set());

  const bumpFriends = useCallback(() => setFriendsRefreshKey((k) => k + 1), []);

  const profileId = profile?.id ?? null;

  const refreshNotifications = useCallback(async () => {
    if (!profileId) {
      setNotifications([]);
      setFriendRequestStatuses({});
      return;
    }
    const rows = await fetchNotifications();
    // friend_request kartlarının bayat aksiyon göstermemesi için kaynak
    // isteklerin CANONICAL durumunu da çek (payload'a değil kayda dayan). İkisini
    // birlikte set ederiz → "bildirim var ama durum yok" ara-render'ı olmaz,
    // dolayısıyla eski/çözülmüş istekte buton bir an bile görünmez.
    const reqIds = rows
      .filter((n) => n.type === "friend_request")
      .map((n) => n.payload?.friendRequestId as string | undefined)
      .filter((x): x is string => !!x);
    const statuses = await fetchFriendRequestStatuses(reqIds);
    setNotifications(rows);
    setFriendRequestStatuses(Object.fromEntries(statuses));
  }, [profileId]);

  // Kabul/Reddet sonrası anlık iyimser güncelleme (DB teyidi refreshNotifications'da).
  const setFriendRequestStatus = useCallback(
    (requestId: string, status: FriendRequestStatus) => {
      if (!requestId) return;
      setFriendRequestStatuses((m) => ({ ...m, [requestId]: status }));
    },
    []
  );

  const dismissToast = useCallback((toastId: number) => {
    setActiveToasts((prev) => prev.filter((t) => t.toastId !== toastId));
  }, []);

  // Düz bilgi/onay toast'ı. Otomatik kapanma süresi kart tarafında (kuyrukta
  // bekleyen toast sayacı başlatmaz) yönetilir; burada yalnız kuyruğa ekleriz.
  const toast = useCallback((message: string) => {
    const toastId = ++toastSeq.current;
    setActiveToasts((prev) => [...prev, { toastId, kind: "info", message }]);
  }, []);

  // Arkadaş DM toast'ı. Aynı gönderenden zaten aktif bir DM kartı varsa onu
  // kaldırıp yenisini ekler → tek gönderenden mesaj yağarken kart yığılmaz ve
  // her zaman en güncel önizleme + taze sayaç gösterilir ("duplicate toast" yok).
  const pushDmToast = useCallback(
    (payload: { senderId: string; preview: string; open: (actor: DmToastActor | null) => void }) => {
      setActiveToasts((prev) => {
        const withoutSameSender = prev.filter(
          (t) => !(t.kind === "dm" && t.senderId === payload.senderId)
        );
        const toastId = ++toastSeq.current;
        return [
          ...withoutSameSender,
          {
            toastId,
            kind: "dm",
            senderId: payload.senderId,
            preview: payload.preview,
            open: payload.open,
          },
        ];
      });
    },
    []
  );

  // Bir bildirim satırını canlı toast olarak kuyruğa alır (id-bazlı dedupe).
  const pushNotificationToast = useCallback((row: NotificationRow) => {
    if (toastedNotifIds.current.has(row.id)) return;
    toastedNotifIds.current.add(row.id);
    const toastId = ++toastSeq.current;
    setActiveToasts((prev) => [...prev, { toastId, kind: "notification", notification: row }]);
  }, []);

  // Oturum değişiminde toast kuyruğunu ve dedupe setini sıfırla.
  useEffect(() => {
    setActiveToasts([]);
    toastedNotifIds.current = new Set();
  }, [profileId]);

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
      // Realtime ile GELEN bir friend_request tanım gereği 'pending'tir (henüz
      // yeni oluşturuldu). Durumu haritaya hemen yaz → kart, ayrı bir status
      // fetch'ini beklemeden doğru "Kabul/Reddet" aksiyonunu gösterir.
      if (row.type === "friend_request") {
        const reqId = row.payload?.friendRequestId as string | undefined;
        if (reqId) setFriendRequestStatuses((m) => ({ ...m, [reqId]: "pending" }));
      }
      // Yalnız taze ekleri (son 60 sn) toast et — olası realtime replay / yeniden
      // bağlanma sonrası eski satırların toplu toast olmasını engeller.
      const ageMs = Date.now() - new Date(row.created_at).getTime();
      if (Number.isFinite(ageMs) && ageMs <= 60_000) pushNotificationToast(row);
    });
    return () => {
      void supabaseRemoveChannel(channel);
    };
  }, [profileId, pushNotificationToast]);

  const markRead = useCallback(async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n))
    );
    await markNotificationRead(id);
  }, []);

  const markInviteInvalid = useCallback(async (id: string) => {
    // Anlık (iyimser): read_at + payload.inviteState='invalid' → kart bu anda
    // "Davet artık geçerli değil"e döner ve Katıl/Reddet kalkar.
    setNotifications((prev) =>
      prev.map((n) =>
        n.id === id
          ? {
              ...n,
              read_at: n.read_at ?? new Date().toISOString(),
              payload: { ...n.payload, inviteState: "invalid" },
            }
          : n
      )
    );
    // Kalıcı: payload'ı server'a damgala. RPC deploy edilmemişse en azından
    // read_at'i kalıcı yap (butonlar yine geri gelmez; pasif metin genelleşir).
    const ok = await resolveRoomInviteInvalid(id);
    if (!ok) await markNotificationRead(id);
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
      markInviteInvalid,
      markAllRead,
      clearNotifications,
      friendRequestStatuses,
      setFriendRequestStatus,
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
      profileEditorOpen,
      toast,
      pushDmToast,
      activeToasts,
      dismissToast,
    }),
    [
      profile,
      notifications,
      unreadCount,
      refreshNotifications,
      markRead,
      markInviteInvalid,
      markAllRead,
      clearNotifications,
      friendRequestStatuses,
      setFriendRequestStatus,
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
      profileEditorOpen,
      toast,
      pushDmToast,
      activeToasts,
      dismissToast,
    ]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Premium global toast katmanı — proje genelinde tek mount; route değişse
          bile (provider kökte) yaşamaya devam eder. */}
      <NotificationToaster />
    </Ctx.Provider>
  );
}

// supabase.removeChannel için küçük sarmalayıcı (channel null olabilir).
function supabaseRemoveChannel(channel: RealtimeChannel | null): void {
  if (channel) void supabase.removeChannel(channel);
}
