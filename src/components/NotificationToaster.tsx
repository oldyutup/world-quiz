/**
 * NotificationToaster.tsx — uygulama geneli premium bildirim toast katmanı.
 *
 * SocialProvider kökünde TEK kez mount edilir; kullanıcı hangi ekranda olursa
 * olsun (ana menü, profil, sıralama, herhangi bir lobby/oyun) yeni bildirimler
 * buraya düşer. Görsel bir oyuncak değil: aksiyon gerektiren kartlar (arkadaşlık
 * isteği, oyun daveti) gerçek RPC akışlarını (useNotificationActions) çalıştırır
 * ve kullanıcı toast'ı kaçırsa bile aynı aksiyonlar bildirim merkezinde kalır.
 *
 * Davranış (görev sözleşmesi):
 *   - Kart 20 sn sonra otomatik kaybolur; hover/focus ve aksiyon işlenirken sayaç durur.
 *   - Aynı event iki kez toast olmaz (SocialContext id-bazlı dedupe eder).
 *   - Eşzamanlı en fazla: desktop 3, mobil 1 kart; fazlası sıraya alınır.
 *   - Kapatma × kontrolü; modal DEĞİL (oyun/lobi akışını kilitlemez).
 *   - Yumuşak giriş/çıkış; prefers-reduced-motion'da yalnız fade.
 *   - Yerleşim ve safe-area/dock offset'leri responsive (App.css + useToastOffset).
 *
 * Desktop web, mobil web ve native iOS/app aynı bileşeni kullanır.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { EmojiIcon, type EmojiIconName } from "./EmojiIcon";
import { useIsMobile } from "../lib/useIsMobile";
import { useRosterProfiles } from "../lib/useRosterProfiles";
import { useNotificationActions } from "../lib/notificationActions";
import type { PublicProfileLite } from "../lib/social";
import { useSocial, type ActiveToast, type NotifToast } from "./SocialContext";

/** Bildirim toast'ının yaşam süresi (görev: 20 sn). Düz bilgi toast'ı daha kısa. */
const NOTIF_TTL_MS = 20_000;
const INFO_TTL_MS = 5_000;
/** Çıkış animasyonu süresi (App.css ile eş). */
const LEAVE_MS = 220;

type ToastTone = "action" | "info";

interface TypeMeta {
  tone: ToastTone;
  /** Avatar yoksa / sistem bildiriminde gösterilecek ikon. */
  icon: EmojiIconName;
  /** Gönderen avatarı (köşe rozetiyle) gösterilsin mi? */
  useAvatar: boolean;
  /** Sabit başlık (yoksa satırın kendi title'ı kullanılır). */
  title?: string;
}

function metaForType(type: string): TypeMeta {
  switch (type) {
    case "friend_request":
      return { tone: "action", icon: "handshake", useAvatar: true, title: "Arkadaşlık isteği" };
    case "room_invite":
    case "game_invite":
      return { tone: "action", icon: "swords", useAvatar: true, title: "Oyun daveti" };
    case "friend_request_accepted":
      return { tone: "info", icon: "party", useAvatar: true };
    case "reward_ready":
    case "achievement_unlocked":
      return { tone: "info", icon: "trophy", useAvatar: false };
    default:
      return { tone: "info", icon: "bell", useAvatar: false };
  }
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

/* ──────────────────────────────────────────────────────────────────────────
   Tek toast kartı
   ────────────────────────────────────────────────────────────────────────── */

interface ToastCardProps {
  toast: ActiveToast;
  actorMap: Map<string, PublicProfileLite>;
  onDismiss: (toastId: number) => void;
  reducedMotion: boolean;
}

function ToastCard({ toast, actorMap, onDismiss, reducedMotion }: ToastCardProps) {
  const actions = useNotificationActions();
  const [leaving, setLeaving] = useState(false);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);

  // Sayaç bookkeeping'i: hover/focus/işlem sırasında durur, kalan süreden devam eder.
  const remainingRef = useRef(toast.kind === "notification" ? NOTIF_TTL_MS : INFO_TTL_MS);
  const startRef = useRef(0);

  const dismiss = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => onDismiss(toast.toastId), reducedMotion ? 0 : LEAVE_MS);
  }, [onDismiss, toast.toastId, reducedMotion]);

  // Otomatik kapatma — JS sayacı otorite (reduced-motion'da CSS bar dursa bile çalışır).
  useEffect(() => {
    if (leaving || paused) return;
    startRef.current = Date.now();
    const id = window.setTimeout(dismiss, Math.max(0, remainingRef.current));
    return () => {
      window.clearTimeout(id);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startRef.current));
    };
  }, [paused, leaving, dismiss]);

  const runAction = useCallback(
    async (fn: () => Promise<{ ok: boolean }>) => {
      if (busy) return;
      setBusy(true);
      setPaused(true); // işlenirken otomatik kapanma
      const res = await fn();
      setBusy(false);
      if (res.ok) {
        dismiss();
      } else {
        // Hata: kart açık kalsın, sayaç devam etsin (kullanıcı tekrar deneyebilir).
        setPaused(false);
      }
    },
    [busy, dismiss]
  );

  // Düz bilgi toast'ı (aksiyon yok, kısa).
  if (toast.kind === "info") {
    return (
      <div
        className={`app-toast app-toast--info app-toast--plain${leaving ? " app-toast--leaving" : ""}`}
        role="status"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <span className="app-toast-figure app-toast-figure--icon" aria-hidden="true">
          <EmojiIcon name="bell" />
        </span>
        <div className="app-toast-body">
          <span className="app-toast-title">{toast.message}</span>
        </div>
        <button type="button" className="app-toast-close" aria-label="Kapat" onClick={dismiss}>
          ×
        </button>
        <span
          className="app-toast-progress"
          aria-hidden="true"
          style={{ animationDuration: `${INFO_TTL_MS}ms`, animationPlayState: paused ? "paused" : "running" }}
        />
      </div>
    );
  }

  const n = (toast as NotifToast).notification;
  const meta = metaForType(n.type);
  const resolved = n.actor_profile_id ? actorMap.get(n.actor_profile_id) : undefined;
  const actorAvatar = resolved?.avatarId ?? null;
  const actorName =
    (n.payload?.actorUsername as string | undefined) ?? resolved?.username ?? null;
  const isFriendReq = n.type === "friend_request";
  const isInvite = n.type === "room_invite" || n.type === "game_invite";
  const isReward = n.type === "reward_ready" || n.type === "achievement_unlocked";

  return (
    <div
      className={`app-toast app-toast--${meta.tone}${leaving ? " app-toast--leaving" : ""}`}
      role="group"
      aria-label={meta.title ?? n.title}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => {
        if (!busy) setPaused(false);
      }}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(e) => {
        if (!busy && !e.currentTarget.contains(e.relatedTarget as Node)) setPaused(false);
      }}
    >
      {meta.useAvatar ? (
        <span className="app-toast-figure app-toast-avatar">
          <Avatar avatarId={actorAvatar} username={actorName} size={42} />
          <span className="app-toast-figure-badge" aria-hidden="true">
            <EmojiIcon name={meta.icon} />
          </span>
        </span>
      ) : (
        <span className="app-toast-figure app-toast-figure--icon" aria-hidden="true">
          <EmojiIcon name={meta.icon} />
        </span>
      )}

      <div className="app-toast-body">
        <span className="app-toast-title">{meta.title ?? n.title}</span>
        {n.body && <span className="app-toast-text">{n.body}</span>}

        {isFriendReq && (
          <div className="app-toast-actions">
            <button
              type="button"
              className="app-toast-btn app-toast-btn--accept"
              disabled={busy}
              onClick={() => void runAction(() => actions.respondFriend(n, "accepted"))}
            >
              Kabul Et
            </button>
            <button
              type="button"
              className="app-toast-btn app-toast-btn--ghost"
              disabled={busy}
              onClick={() => void runAction(() => actions.respondFriend(n, "rejected"))}
            >
              Reddet
            </button>
          </div>
        )}

        {isInvite && (
          <div className="app-toast-actions">
            <button
              type="button"
              className="app-toast-btn app-toast-btn--accept"
              disabled={busy}
              onClick={() => void runAction(() => actions.joinRoom(n))}
            >
              Katıl
            </button>
            <button
              type="button"
              className="app-toast-btn app-toast-btn--ghost"
              disabled={busy}
              onClick={() => void runAction(() => actions.declineInvite(n))}
            >
              Reddet
            </button>
          </div>
        )}

        {isReward && (
          <div className="app-toast-actions">
            <button
              type="button"
              className="app-toast-btn app-toast-btn--accept"
              disabled={busy}
              onClick={() => void runAction(() => actions.openRewards(n))}
            >
              Görüntüle
            </button>
          </div>
        )}
      </div>

      <button type="button" className="app-toast-close" aria-label="Kapat" onClick={dismiss}>
        ×
      </button>
      <span
        className="app-toast-progress"
        aria-hidden="true"
        style={{ animationDuration: `${NOTIF_TTL_MS}ms`, animationPlayState: paused ? "paused" : "running" }}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Yığın + sıra yönetimi
   ────────────────────────────────────────────────────────────────────────── */

export function NotificationToaster() {
  const social = useSocial();
  const { isMobile } = useIsMobile();
  const reducedMotion = usePrefersReducedMotion();

  const maxVisible = isMobile ? 1 : 3;
  const toasts = social.activeToasts;
  // Geliş sırasına göre ilk N görünür; gerisi sıraya alınır (FIFO).
  const visible = toasts.slice(0, maxVisible);
  const queued = toasts.length - visible.length;

  // Görünür aksiyon kartlarındaki gönderen avatarını TEK batched RPC ile çöz.
  const actorIds = visible
    .filter((t): t is NotifToast => t.kind === "notification")
    .map((t) => t.notification.actor_profile_id)
    .filter((x): x is string => !!x);
  const actorMap = useRosterProfiles(actorIds);

  // Bildirim toast'ları zaten yalnız oturum açık kullanıcıya gelir (realtime
  // abonelik profile'a bağlı); düz bilgi toast'ları her durumda gösterilebilsin.
  if (visible.length === 0) return null;

  return (
    <div className="app-toast-host" role="region" aria-label="Bildirimler" aria-live="polite">
      {visible.map((t) => (
        <ToastCard
          key={t.toastId}
          toast={t}
          actorMap={actorMap}
          onDismiss={social.dismissToast}
          reducedMotion={reducedMotion}
        />
      ))}
      {queued > 0 && (
        <div className="app-toast-queue" aria-hidden="true">
          +{queued} bildirim sırada
        </div>
      )}
    </div>
  );
}
