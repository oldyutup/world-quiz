/**
 * NotificationCenter.tsx — ortak bildirim merkezi (tetikleyici + badge + panel).
 *
 * Desktop web: sağ üst sosyal blokta etiketli "🔔 Bildirimler" butonu (variant
 *   "bar"), tıklayınca dropdown panel.
 * Mobil web: aynı buton; panel bottom-sheet olarak açılır.
 * Native iOS/app: bildirimler ayrı buton değil — Arkadaşlar sosyal merkezinin
 *   "Bildirimler" sekmesinde NotificationList ile gösterilir.
 *
 * Liste gövdesi + aksiyonlar NotificationList'e taşındı (native sosyal merkezle
 * paylaşılır). Bu dosya yalnızca tetikleyici + panel kabuğunu yönetir.
 *
 * Variant:
 *   - "bar"  (varsayılan) → sosyal blokta etiketli buton + badge.
 *   - "icon"              → kompakt 38px zil (eski yerleşim / yedek).
 *   - "row"               → native profil panelinde tam-genişlik menü satırı.
 */
import { useEffect, useRef, useState } from "react";
import { useIsMobile } from "../lib/useIsMobile";
import { useSocial } from "./SocialContext";
import { NotificationList } from "./NotificationList";
import { EmojiIcon } from "./EmojiIcon";

interface NotificationCenterProps {
  variant?: "bar" | "icon" | "row";
}

export function NotificationCenter({ variant = "bar" }: NotificationCenterProps) {
  const social = useSocial();
  const { isMobile } = useIsMobile();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { unreadCount, markAllRead, refreshNotifications } = social;

  // Açılışta taze veri (realtime fallback).
  useEffect(() => {
    if (open) void refreshNotifications();
  }, [open, refreshNotifications]);

  // Dışarı tık / ESC kapatma (desktop dropdown).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Oturum yoksa gösterme.
  if (!social.profile) return null;

  const badge =
    unreadCount > 0 ? (
      <span
        className={variant === "bar" ? "social-btn-badge" : variant === "row" ? "social-menu-row-badge" : "notif-badge"}
        aria-label={`${unreadCount} okunmamış bildirim`}
      >
        {unreadCount > 99 ? "99+" : unreadCount}
      </span>
    ) : null;

  const trigger =
    variant === "row" ? (
      <button
        type="button"
        className="social-menu-row"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="social-menu-row-icon" aria-hidden="true"><EmojiIcon name="bell" /></span>
        <span className="social-menu-row-label">Bildirimler</span>
        {badge}
      </button>
    ) : variant === "bar" ? (
      <button
        type="button"
        className={`social-btn${open ? " social-btn--open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Bildirimler"
        aria-expanded={open}
      >
        <span className="social-btn-icon" aria-hidden="true"><EmojiIcon name="bell" /></span>
        <span className="social-btn-label">Bildirimler</span>
        {badge}
      </button>
    ) : (
      <button
        type="button"
        className={`notif-bell${open ? " notif-bell--open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Bildirimler"
        aria-expanded={open}
      >
        <span className="notif-bell-icon" aria-hidden="true"><EmojiIcon name="bell" /></span>
        {badge}
      </button>
    );

  return (
    <div className="notif-wrap" ref={wrapRef}>
      {trigger}

      {open && (
        <>
          {isMobile && <div className="notif-sheet-backdrop" onClick={() => setOpen(false)} />}
          <div className={`notif-panel${isMobile ? " notif-panel--sheet" : ""}`}>
            <div className="notif-panel-head">
              <span className="notif-panel-title">Bildirimler</span>
              {unreadCount > 0 && (
                <button type="button" className="notif-markall" onClick={() => void markAllRead()}>
                  Tümünü okundu yap
                </button>
              )}
            </div>
            <NotificationList onNavigate={() => setOpen(false)} />
          </div>
        </>
      )}
    </div>
  );
}
