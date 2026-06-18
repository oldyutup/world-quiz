/**
 * DMChatModal.tsx — birebir özel sohbet modalı (V1: yalnız düz metin).
 *
 * Torble'ın koyu lacivert cam panel diliyle uyumlu, küçük ve premium görünümlü
 * bir modal. Üstte arkadaş avatarı + presence noktası + @kullanıcıadı + üç-nokta
 * menü + kapatma; ortada kaydırılır mesaj geçmişi; altta (offline ise) sade bir
 * bilgi + metin alanı + gönder.
 *
 * VERİ KAYNAĞI = SERVER (kritik):
 *   - Modal her açılışında geçmiş DOĞRUDAN dm_list_messages RPC'sinden yeniden
 *     yüklenir. Realtime/local state YALNIZ optimizasyondur; tek gerçek kaynak
 *     asla local değildir. Modal kapalıyken gelen mesaj DB'de durur; modal
 *     açılınca server'dan tekrar gelir (kaybolmaz).
 *   - Sıra GÜVENLİ: önce geçmiş fetch → sonra mark-read. mark-read mesaj
 *     listesini boşaltmaz. Sekmeye dönünce (focus/visible) tekrar fetch eder
 *     (kaçan realtime'a karşı emniyet ağı).
 *   - Dedupe: initial fetch listeyi komple değiştirir; realtime/optimistic ekler
 *     id üzerinden tekilleştirilir → aynı mesaj iki kez render edilmez.
 *
 * Davranış:
 *   - Enter → gönder, Shift+Enter → alt satır.
 *   - ESC / dışarı tık → kapat (önce açık menü/onay kapanır).
 *   - "Sohbeti temizle" → onay → YALNIZ benim görünümüm temizlenir (server
 *     cleared_at; global silme YOK).
 *
 * Gönderme yalnız dm_send_message RPC'sinden geçer; sender server'da belirlenir.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "../lib/useIsMobile";
import {
  sendDirectMessage,
  fetchConversationHistory,
  markConversationRead,
  clearConversationForMe,
  type DmMessage,
} from "../lib/dm";
import { PlayerAvatar } from "./PlayerAvatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { useDm, type DmFriend } from "./DmContext";
import { usePresenceOptional } from "./PresenceContext";

const MAX_LEN = 500;

interface DMChatModalProps {
  friend: DmFriend;
  conversationId: string | null;
  loading: boolean;
  myProfileId: string | null;
}

export function DMChatModal({ friend, conversationId, loading, myProfileId }: DMChatModalProps) {
  const dm = useDm();
  const presence = usePresenceOptional();
  const { isMobile } = useIsMobile();

  const draftKey = friend.profileId;
  const [messages, setMessages] = useState<DmMessage[]>([]);
  // Geçmiş yükleme durumu — açık state'lerle: yükleniyor / hazır / hata.
  const [historyStatus, setHistoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [draft, setDraftState] = useState<string>(() => dm.getDraft(draftKey));
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  // En az bir kez geçmiş BAŞARIYLA yüklendi mi? (Arka plan tazeleme hatası, hazır
  // görünümü hata ekranına düşürmesin diye.)
  const hasLoadedOnce = useRef(false);

  const refreshPresence = presence.refresh; // stabil kimlik (useCallback)
  const username = friend.username ?? "—";
  const online = presence.isOnline(friend.profileId);

  /* ── Açılışta online arkadaş kümesini hemen tazele (başlık noktası doğru olsun). ── */
  useEffect(() => {
    void refreshPresence();
  }, [refreshPresence]);

  /* ── Taslak: her değişimde DmContext'e yaz (modal kapanırsa korunur). ── */
  const setDraft = useCallback(
    (value: string) => {
      const v = value.slice(0, MAX_LEN);
      setDraftState(v);
      dm.setDraft(draftKey, v);
    },
    [dm, draftKey]
  );

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => {
      setNotice(null);
      noticeTimer.current = null;
    }, 2800);
  }, []);
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollIntoView({ behavior, block: "end" });
    });
  }, []);

  /* ── Mesaj ekleyici (realtime + optimistic ortak): dedupe by id. ── */
  const addMessage = useCallback((msg: DmMessage) => {
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  }, []);

  /* ── Server hydration: geçmişi DB'den yükle → SADECE başarıda mark-read. ──
       Tek gerçek kaynak server. Açık state makinesi:
         - isInitial: önce "loading" göster.
         - ok  → mesajları yaz, "ready", SONRA mark-read (kullanıcı görmeden
                 okunmuş sayılmaz; sıra güvenli; başarılı boş = gerçekten boş).
         - !ok → mark-read YOK, bilinen-iyi listeyi boşaltma. Hiç başarılı
                 yükleme olmadıysa "error" (boş state DEĞİL → retry); olduysa
                 arka plan tazelemesi sessiz başarısız, "ready" korunur. */
  const hydrate = useCallback(
    async (convId: string, isInitial: boolean) => {
      if (isInitial) setHistoryStatus("loading");
      const { ok, rows } = await fetchConversationHistory(convId);
      if (ok) {
        setMessages(rows);
        hasLoadedOnce.current = true;
        setHistoryStatus("ready");
        scrollToBottom("auto");
        await markConversationRead(convId);
        void dm.refreshUnread();
      } else if (!hasLoadedOnce.current) {
        setHistoryStatus("error");
      }
    },
    [dm, scrollToBottom]
  );

  /* ── Konuşma hazır olunca: hydrate + realtime bağla. ── */
  useEffect(() => {
    if (!conversationId) return;
    hasLoadedOnce.current = false; // yeni konuşma → temiz başla
    // Her açılışta geçmişi SERVER'dan yeniden yükle (tek gerçek kaynak).
    void hydrate(conversationId, true);
    // Realtime: bu konuşmaya gelen mesajları doğrudan listeye düşür (dedupe id).
    dm.bindIncoming(conversationId, (m) => {
      addMessage(m);
      scrollToBottom("smooth");
    });
    return () => {
      dm.unbindIncoming();
    };
    // dm yöntemleri stabil (useCallback); conversationId değişiminde yeniden bağla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, addMessage, scrollToBottom, hydrate]);

  /* ── Emniyet ağı: sekmeye/pencereye dönünce geçmişi DB'den tazele (arka planda
       kaçan realtime olabilir; tek gerçek kaynak yine server). ── */
  useEffect(() => {
    if (!conversationId) return;
    const onActive = () => {
      if (document.visibilityState === "visible") void hydrate(conversationId, false);
    };
    window.addEventListener("focus", onActive);
    document.addEventListener("visibilitychange", onActive);
    return () => {
      window.removeEventListener("focus", onActive);
      document.removeEventListener("visibilitychange", onActive);
    };
  }, [conversationId, hydrate]);

  /* ── ESC: önce açık menü/onay kapanır, yoksa sohbeti kapat. ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      if (confirmClear) {
        setConfirmClear(false);
        return;
      }
      dm.closeChat();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dm, menuOpen, confirmClear]);

  /* ── Üç-nokta menüsü: dışarı tık ile kapan. ── */
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!loading && conversationId) {
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [loading, conversationId]);

  /* ── Gönder: optimistic + dm_send_message RPC. ── */
  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || !conversationId || !myProfileId) return;

    setSending(true);
    setDraft("");

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const optimistic: DmMessage = {
      id: tempId,
      conversationId,
      senderId: myProfileId,
      recipientId: friend.profileId,
      content: text,
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    setMessages((prev) => [...prev, optimistic]);
    scrollToBottom("smooth");

    const res = await sendDirectMessage(friend.profileId, text);
    if (res.ok && res.message) {
      setMessages((prev) => prev.map((m) => (m.id === tempId ? res.message! : m)));
    } else {
      // Geri al; rate-limit/duplicate/unread-limit'te draft'ı geri koyma (döngü olmasın).
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      if (
        res.code === "rate_limited" ||
        res.code === "duplicate_message" ||
        res.code === "unread_limit"
      ) {
        showNotice(res.error ?? "Mesaj gönderilemedi.");
      } else {
        setDraft(text);
        showNotice(res.error ?? "Mesaj gönderilemedi.");
      }
    }
    setSending(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [draft, sending, conversationId, myProfileId, friend.profileId, setDraft, scrollToBottom, showNotice]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  /* ── Sohbeti temizle (yalnız benim görünümüm; global silme YOK). ── */
  const doClear = useCallback(async () => {
    if (!conversationId || clearing) return;
    setClearing(true);
    const ok = await clearConversationForMe(conversationId);
    setClearing(false);
    if (ok) {
      setMessages([]); // boş duruma dön; karşı taraf etkilenmez
      void dm.refreshUnread();
      setConfirmClear(false);
    } else {
      setConfirmClear(false);
      showNotice("Sohbet temizlenemedi, tekrar dene.");
    }
  }, [conversationId, clearing, dm, showNotice]);

  const ready = !loading && !!conversationId;

  return (
    <div
      className={`dm-overlay${isMobile ? " dm-overlay--sheet" : ""}`}
      onClick={() => dm.closeChat()}
      role="presentation"
    >
      <div className="dm-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="dm-head">
          <span className="dm-head-avatar-wrap">
            <PlayerAvatar
              avatarId={friend.avatarId}
              username={friend.username}
              size="sm"
              frameId={friend.frameId}
              className="dm-head-avatar"
            />
            <span
              className={`presence-dot presence-dot--head presence-dot--${online ? "online" : "offline"}`}
              aria-hidden="true"
            />
          </span>
          <div className="dm-head-id">
            <span className="dm-head-name">@{username}</span>
            <span className={`dm-head-sub${online ? " dm-head-sub--online" : ""}`}>
              {online ? "Çevrimiçi" : "Özel mesaj"}
            </span>
          </div>

          <div className="dm-head-actions">
            <div className="dm-menu-wrap" ref={menuWrapRef}>
              <button
                type="button"
                className="dm-menu-btn"
                onClick={() => setMenuOpen((o) => !o)}
                aria-label="Sohbet seçenekleri"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                  <circle cx="12" cy="5" r="1.8" fill="currentColor" />
                  <circle cx="12" cy="12" r="1.8" fill="currentColor" />
                  <circle cx="12" cy="19" r="1.8" fill="currentColor" />
                </svg>
              </button>
              {menuOpen && (
                <div className="dm-menu" role="menu">
                  <button
                    type="button"
                    className="dm-menu-item dm-menu-item--danger"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmClear(true);
                    }}
                    disabled={!ready}
                  >
                    Sohbeti temizle
                  </button>
                </div>
              )}
            </div>
            <button type="button" className="dm-close" onClick={() => dm.closeChat()} aria-label="Kapat">
              ×
            </button>
          </div>
        </header>

        <div className="dm-body">
          {!ready || historyStatus === "loading" ? (
            <div className="dm-loading">Sohbet yükleniyor…</div>
          ) : historyStatus === "error" ? (
            <div className="dm-error">
              <span className="dm-error-text">Mesajlar yüklenemedi.</span>
              <button
                type="button"
                className="dm-retry"
                onClick={() => conversationId && void hydrate(conversationId, true)}
              >
                Tekrar dene
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="dm-empty">Henüz mesaj yok. İlk mesajı sen gönder.</div>
          ) : (
            <div className="dm-messages">
              {messages.map((m) => {
                const isMe = m.senderId === myProfileId;
                return (
                  <div key={m.id} className={`dm-msg ${isMe ? "dm-msg--me" : "dm-msg--them"}`}>
                    <span className="dm-bubble">{m.content}</span>
                  </div>
                );
              })}
              <div ref={scrollRef} />
            </div>
          )}
        </div>

        {notice && (
          <div className="dm-notice" role="status" aria-live="polite">
            {notice}
          </div>
        )}

        {ready && !online && (
          <div className="dm-offline-hint" role="note">
            @{username} şu anda çevrimdışı. Oyuna girdiğinde mesajını görecek.
          </div>
        )}

        <div className="dm-input-row">
          <textarea
            ref={inputRef}
            className="dm-input"
            placeholder="Mesaj yaz…"
            rows={1}
            maxLength={MAX_LEN}
            value={draft}
            disabled={!ready}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="sentences"
            spellCheck={false}
          />
          <button
            type="button"
            className="dm-send"
            onMouseDown={(e) => {
              e.preventDefault();
              void send();
            }}
            disabled={!ready || !draft.trim() || sending}
            aria-label="Gönder"
          >
            ➤
          </button>
        </div>
      </div>

      {confirmClear && (
        // stopPropagation: onay diyaloğu üstte (.dm-overlay içinde) ama backdrop
        // tıklaması dıştaki "tıklayınca sohbeti kapat" handler'ına SIZMAMALI.
        <div onClick={(e) => e.stopPropagation()} role="presentation">
          <ConfirmDialog
            title="Sohbet temizlensin mi?"
            description="Bu işlem yalnızca senin mesaj geçmişini temizler. Karşı tarafın konuşması silinmez."
            confirmLabel="Sohbeti temizle"
            cancelLabel="Vazgeç"
            destructive
            busy={clearing}
            onConfirm={() => void doClear()}
            onCancel={() => setConfirmClear(false)}
          />
        </div>
      )}
    </div>
  );
}
