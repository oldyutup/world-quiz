/**
 * DmContext.tsx — birebir özel mesaj (DM) oturum-genel durumu.
 *
 * SocialContext'in yanında, ayrı bir provider olarak App kökünde mount edilir
 * (DM, sosyal bildirimlerden bağımsız bir endişe). Şunları tutar:
 *   - Okunmamış DM özeti (toplam + arkadaş başına) → Arkadaşlar butonu badge'i
 *     ve arkadaş satırı kırmızı noktaları.
 *   - dm_messages INSERT realtime aboneliği (yalnız recipient_id=<me>):
 *       * açık modal o konuşmadaysa mesaj doğrudan düşer + okundu işaretlenir,
 *       * değilse okunmamış badge artar.
 *   - Tek aktif sohbet modalı (hangi arkadaş + conversation id) + taslak metin
 *     korunması.
 *
 * Lobby chat'ten tamamen ayrı: kendi tablosu, kendi realtime kanalı.
 * Desktop web, mobil web ve native aynı provider'ı kullanır.
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
  EMPTY_DM_UNREAD,
  fetchDmUnreadSummary,
  getOrCreateConversation,
  markConversationRead,
  subscribeDirectMessages,
  type DmMessage,
  type DmUnreadSummary,
} from "../lib/dm";
import { useSocialOptional } from "./SocialContext";
import { DMChatModal } from "./DMChatModal";

/** Sohbet açmak için gereken minimum arkadaş bilgisi (FriendRow ile uyumlu). */
export interface DmFriend {
  profileId: string;
  username: string | null;
  avatarId: string | null;
  frameId: string | null;
}

interface DmModalState {
  open: boolean;
  friend: DmFriend | null;
  conversationId: string | null;
  loading: boolean;
}

interface DmContextValue {
  unread: DmUnreadSummary;
  totalUnread: number;
  unreadFor: (profileId: string) => number;
  refreshUnread: () => Promise<void>;

  openChatWith: (friend: DmFriend) => void;
  closeChat: () => void;
  modal: DmModalState;

  /** Taslak metin korunması — modal kapanıp açılınca yazılan metin kalır. */
  getDraft: (key: string) => string;
  setDraft: (key: string, value: string) => void;

  /** Modal, aktif konuşmaya gelen realtime mesajlar için handler bağlar/çözer. */
  bindIncoming: (conversationId: string, handler: (m: DmMessage) => void) => void;
  unbindIncoming: () => void;
}

const Ctx = createContext<DmContextValue | null>(null);

export function useDm(): DmContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDm must be used within <DmProvider>");
  return v;
}

/** Provider dışında çağrılırsa null döner (opsiyonel tüketiciler). */
export function useDmOptional(): DmContextValue | null {
  return useContext(Ctx);
}

interface DmProviderProps {
  profile: Profile | null;
  children: ReactNode;
}

export function DmProvider({ profile, children }: DmProviderProps) {
  const social = useSocialOptional();
  const profileId = profile?.id ?? null;

  const [unread, setUnread] = useState<DmUnreadSummary>(EMPTY_DM_UNREAD);
  const [modal, setModal] = useState<DmModalState>({
    open: false,
    friend: null,
    conversationId: null,
    loading: false,
  });

  // Taslaklar: arkadaş profil id → yazılmakta olan metin.
  const draftsRef = useRef<Record<string, string>>({});
  // Aktif konuşma + modalın mesaj ekleyici handler'ı (realtime yönlendirme için).
  const activeConvRef = useRef<string | null>(null);
  const activeHandlerRef = useRef<((m: DmMessage) => void) | null>(null);

  const refreshUnread = useCallback(async () => {
    if (!profileId) {
      setUnread(EMPTY_DM_UNREAD);
      return;
    }
    const summary = await fetchDmUnreadSummary();
    setUnread(summary);
  }, [profileId]);

  // İlk yükleme + login değişiminde okunmamış özetini çek.
  useEffect(() => {
    void refreshUnread();
  }, [refreshUnread]);

  // Sekmeye geri dönünce / görünür olunca okunmamışları tazele (başka sekmede
  // okunmuş olabilir ya da arka planda kaçan realtime olabilir).
  useEffect(() => {
    if (!profileId) return;
    const onActive = () => {
      if (document.visibilityState === "visible") void refreshUnread();
    };
    window.addEventListener("focus", onActive);
    document.addEventListener("visibilitychange", onActive);
    return () => {
      window.removeEventListener("focus", onActive);
      document.removeEventListener("visibilitychange", onActive);
    };
  }, [profileId, refreshUnread]);

  // Realtime: bana gelen yeni DM'ler.
  useEffect(() => {
    if (!profileId) return;
    const channel: RealtimeChannel = subscribeDirectMessages(profileId, (msg) => {
      // Açık modal bu konuşmadaysa: doğrudan düşür + okundu tut (badge artmaz).
      if (activeConvRef.current === msg.conversationId && activeHandlerRef.current) {
        activeHandlerRef.current(msg);
        void markConversationRead(msg.conversationId).then(() => void refreshUnread());
        return;
      }
      // Aksi halde: o arkadaştan okunmamış sayısını artır.
      setUnread((prev) => {
        const byUser = { ...prev.byUser };
        byUser[msg.senderId] = (byUser[msg.senderId] ?? 0) + 1;
        return { total: prev.total + 1, byUser };
      });
    });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [profileId, refreshUnread]);

  const unreadFor = useCallback(
    (id: string) => unread.byUser[id] ?? 0,
    [unread]
  );

  const getDraft = useCallback((key: string) => draftsRef.current[key] ?? "", []);
  const setDraft = useCallback((key: string, value: string) => {
    draftsRef.current[key] = value;
  }, []);

  const bindIncoming = useCallback(
    (conversationId: string, handler: (m: DmMessage) => void) => {
      activeConvRef.current = conversationId;
      activeHandlerRef.current = handler;
    },
    []
  );
  const unbindIncoming = useCallback(() => {
    activeConvRef.current = null;
    activeHandlerRef.current = null;
  }, []);

  const closeChat = useCallback(() => {
    activeConvRef.current = null;
    activeHandlerRef.current = null;
    setModal({ open: false, friend: null, conversationId: null, loading: false });
  }, []);

  const openChatWith = useCallback(
    (friend: DmFriend) => {
      if (!profileId || !friend.profileId || friend.profileId === profileId) return;
      setModal({ open: true, friend, conversationId: null, loading: true });
      void getOrCreateConversation(friend.profileId).then((convId) => {
        if (!convId) {
          social?.toast("Bu kişiyle sohbet başlatılamadı.");
          setModal({ open: false, friend: null, conversationId: null, loading: false });
          return;
        }
        setModal((prev) =>
          // Kullanıcı bu arada modalı kapatıp başkasını açtıysa eski sonucu yutma.
          prev.open && prev.friend?.profileId === friend.profileId
            ? { ...prev, conversationId: convId, loading: false }
            : prev
        );
      });
    },
    [profileId, social]
  );

  const value = useMemo<DmContextValue>(
    () => ({
      unread,
      totalUnread: unread.total,
      unreadFor,
      refreshUnread,
      openChatWith,
      closeChat,
      modal,
      getDraft,
      setDraft,
      bindIncoming,
      unbindIncoming,
    }),
    [
      unread,
      unreadFor,
      refreshUnread,
      openChatWith,
      closeChat,
      modal,
      getDraft,
      setDraft,
      bindIncoming,
      unbindIncoming,
    ]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {modal.open && modal.friend && (
        <DMChatModal
          friend={modal.friend}
          conversationId={modal.conversationId}
          loading={modal.loading}
          myProfileId={profileId}
        />
      )}
    </Ctx.Provider>
  );
}
