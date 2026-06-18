/**
 * PresenceContext.tsx — oturum-genel "hangi arkadaşım çevrimiçi" durumu.
 *
 * GİZLİLİK-ÖNCELİKLİ TASARIM (global Realtime Presence DEĞİL):
 *   Supabase Realtime Presence, bir kanala katılan her istemciye o kanaldaki TÜM
 *   üyelerin id'lerini yayar; tek global "online-users" kanalı, arkadaş olmayan
 *   kullanıcıların online id'lerini de tel üzerinden sızdırırdı. Bunun yerine
 *   SERVER-OTORİTELİ heartbeat/expiry kullanılır:
 *     - presence_heartbeat() ile kendi varlığımı periyodik bildiririm,
 *     - friends_presence() ile YALNIZ arkadaşlarımın online id'lerini alırım
 *       (arkadaşlık + block server'da zorlanır → yabancı verisi istemciye GELMEZ).
 *
 *   Bu yüzden burada hiçbir realtime kanalı açılmaz; arkadaş satırı başına da
 *   abonelik yoktur. Tek merkezi context, tek periyodik sorgu.
 *
 * GÖRÜNÜRLÜK: heartbeat YALNIZ sekme görünürken atılır. Sekme gizlenince (başka
 *   sekmeye geçme / minimize) beat durur → arka planda saatlerce açık kalan sekme
 *   sürekli yeşil görünmez; görünür olunca anında beat ile tekrar online.
 * ÇOKLU SEKME: her görünür sekme aynı tek user_presence satırını günceller → en
 *   az bir görünür sekme beat attıkça yeşil; hepsi gizli/durunca pencere (90sn)
 *   dolunca gri.
 * BELİRSİZLİK = GRİ: RPC eksik/başarısızsa küme boş → herkes gri (yanlış yeşil yok).
 *
 * DB: 20260718180000_friend_presence_heartbeat.sql gerektirir (uygulanana kadar
 * RPC'ler yok → güvenli şekilde hep gri).
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
import type { Profile } from "../lib/auth";
import {
  fetchOnlineFriendIds,
  sendPresenceHeartbeat,
  PRESENCE_WINDOW_SECONDS,
} from "../lib/presence";

/** Kendi varlığımı bildirme aralığı; pencereden (90sn) kısa. */
const HEARTBEAT_MS = 30_000;
/** Arkadaş online kümesini tazeleme aralığı. */
const POLL_MS = 30_000;

interface PresenceContextValue {
  /** id şu an (son ~90sn içinde) çevrimiçi bir ARKADAŞIM mı? Bilinmiyorsa false. */
  isOnline: (profileId: string | null | undefined) => boolean;
  /** Online arkadaş kümesini hemen tazele (panel/modal açılışında çağrılır). */
  refresh: () => Promise<void>;
}

const Ctx = createContext<PresenceContextValue | null>(null);

/** Provider yoksa "herkes offline" diyen güvenli varyant (opsiyonel tüketiciler). */
export function usePresenceOptional(): PresenceContextValue {
  return (
    useContext(Ctx) ?? {
      isOnline: () => false,
      refresh: async () => {},
    }
  );
}

interface PresenceProviderProps {
  profile: Profile | null;
  children: ReactNode;
}

export function PresenceProvider({ profile, children }: PresenceProviderProps) {
  const profileId = profile?.id ?? null;
  const [onlineIds, setOnlineIds] = useState<Set<string>>(() => new Set());
  // En güncel profileId'yi refresh içinde kapatma (closure) tazeliği için tut.
  const profileIdRef = useRef<string | null>(profileId);
  profileIdRef.current = profileId;

  const refresh = useCallback(async () => {
    if (!profileIdRef.current) return;
    const ids = await fetchOnlineFriendIds(PRESENCE_WINDOW_SECONDS);
    // Sorgu sırasında logout olduysak boş bırak.
    if (profileIdRef.current) setOnlineIds(ids);
  }, []);

  useEffect(() => {
    if (!profileId) {
      setOnlineIds(new Set());
      return;
    }

    let hbTimer: number | null = null;
    let pollTimer: number | null = null;

    const beat = () => void sendPresenceHeartbeat();
    const poll = () => void refresh();

    const startTimers = () => {
      if (hbTimer === null) hbTimer = window.setInterval(beat, HEARTBEAT_MS);
      if (pollTimer === null) pollTimer = window.setInterval(poll, POLL_MS);
    };
    const stopTimers = () => {
      if (hbTimer !== null) { window.clearInterval(hbTimer); hbTimer = null; }
      if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
    };

    // GÖRÜNÜRLÜK = "Torble'da aktif" ölçütü. Sekme görünürken beat at + arkadaşları
    // poll'la; GİZLENİNCE beat'i DURDUR → arka planda saatlerce açık kalan sekme
    // sürekli yeşil görünmez (pencere dolunca arkadaşlar beni gri görür).
    const apply = () => {
      if (document.visibilityState === "visible") {
        beat();        // anında online
        poll();        // arkadaş kümesini tazele
        startTimers(); // düzenli beat/poll (idempotent)
      } else {
        stopTimers();  // gizliyken beat ETME
      }
    };

    apply(); // ilk durum
    window.addEventListener("focus", apply);
    document.addEventListener("visibilitychange", apply);

    return () => {
      stopTimers();
      window.removeEventListener("focus", apply);
      document.removeEventListener("visibilitychange", apply);
    };
  }, [profileId, refresh]);

  const isOnline = useCallback(
    (id: string | null | undefined) => (id ? onlineIds.has(id) : false),
    [onlineIds]
  );

  const value = useMemo<PresenceContextValue>(
    () => ({ isOnline, refresh }),
    [isOnline, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
