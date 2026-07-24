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
import { reportDmMessage } from "../lib/moderation";
import { PlayerAvatar } from "./PlayerAvatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { ReportModal } from "./ReportModal";
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
  // KRİTİK: Bağlam metotları (useCallback ile) STABİL kimliklidir; ama `dm`
  // (context value) `unread` her değişince YENİDEN oluşur. Bu metotları ayrı
  // çekmezsek hydrate effect'i her unread güncellemesinde yeniden tetiklenir →
  // sonsuz dm_list_messages/dm_mark_read/dm_unread_summary döngüsü. Stabil
  // referansları kullanmak bu döngüyü kıran asıl düzeltmedir.
  const { refreshUnread, bindIncoming, unbindIncoming, closeChat, getDraft, setDraft: setCtxDraft } = dm;
  const presence = usePresenceOptional();
  const { isMobile } = useIsMobile();

  const draftKey = friend.profileId;
  const [messages, setMessages] = useState<DmMessage[]>([]);
  // Geçmiş yükleme durumu — açık state'lerle: yükleniyor / hazır / hata.
  const [historyStatus, setHistoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [draft, setDraftState] = useState<string>(() => getDraft(draftKey));
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  /** Karşı tarafın hangi mesajının seçenek menüsü açık (mesaj id). */
  const [openMsgMenu, setOpenMsgMenu] = useState<string | null>(null);
  /** Bildir modalı açık olan karşı-taraf mesaj id'si. */
  const [reportMsgId, setReportMsgId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  // En az bir kez geçmiş BAŞARIYLA yüklendi mi? (Arka plan tazeleme hatası, hazır
  // görünümü hata ekranına düşürmesin diye.)
  const hasLoadedOnce = useRef(false);
  // Aynı konuşma için aynı anda yalnız BİR fetch uçsun (initial + focus çakışması
  // / focus+visibility ikili tetiklemesi ikinci isteği başlatmasın). Farklı
  // konuşma serbest (sohbet değişiminde yeni hydrate gerekir).
  const inFlightConvRef = useRef<string | null>(null);
  // Monoton istek jetonu: geç gelen (bayat) fetch sonucu daha yeni state'i
  // ezmesin. Konuşma değişince eski uçuş sonucu yutulur.
  const reqTokenRef = useRef(0);

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
      setCtxDraft(draftKey, v);
    },
    [setCtxDraft, draftKey]
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
      // Aynı konuşma için zaten bir fetch uçuyorsa ikinciyi başlatma.
      if (inFlightConvRef.current === convId) return;
      inFlightConvRef.current = convId;
      const token = ++reqTokenRef.current;
      if (isInitial) setHistoryStatus("loading");
      try {
        const { ok, rows } = await fetchConversationHistory(convId);
        // Bu sırada daha yeni bir fetch (ör. konuşma değişimi) başladıysa bayat
        // sonucu YUT: ne listeyi ne durumu ezme.
        if (token !== reqTokenRef.current) return;
        if (ok) {
          setMessages(rows);
          hasLoadedOnce.current = true;
          setHistoryStatus("ready");
          scrollToBottom("auto");
          // mark-read YALNIZ gerçek okunmamış GELEN mesaj varsa (kendi
          // gönderdiklerim recipient değil; boş/okunmuş sohbette RPC israfı yok).
          const hasUnreadInbound = rows.some(
            (m) => m.recipientId === myProfileId && m.readAt === null
          );
          if (hasUnreadInbound) {
            await markConversationRead(convId);
            if (token === reqTokenRef.current) void refreshUnread();
          }
        } else if (!hasLoadedOnce.current) {
          // Hiç başarılı yükleme olmadıysa hata (boş değil → retry). Daha önce
          // yüklendiyse arka plan tazelemesi sessiz başarısız, "ready" korunur.
          setHistoryStatus("error");
        }
      } finally {
        // Yalnız hâlâ bu konuşma uçuştaysa serbest bırak (yeni konuşma
        // başladıysa onun bayrağını silme).
        if (inFlightConvRef.current === convId) inFlightConvRef.current = null;
      }
    },
    [refreshUnread, scrollToBottom, myProfileId]
  );

  /* ── Konuşma hazır olunca: hydrate + realtime bağla. Tüm bağımlılıklar STABİL
       (hydrate/bindIncoming/unbindIncoming/addMessage/scrollToBottom) → bu effect
       YALNIZ conversationId değişiminde çalışır; unread güncellemeleri yeniden
       tetiklemez (sonsuz fetch döngüsü buradan engellenir). ── */
  useEffect(() => {
    if (!conversationId) return;
    hasLoadedOnce.current = false; // yeni konuşma → temiz başla
    // Açılışta geçmişi SERVER'dan TEK SEFER yükle (tek gerçek kaynak).
    void hydrate(conversationId, true);
    // Realtime: bu konuşmaya gelen mesajları doğrudan listeye düşür (dedupe id).
    bindIncoming(conversationId, (m) => {
      addMessage(m);
      scrollToBottom("smooth");
    });
    return () => {
      unbindIncoming();
    };
  }, [conversationId, addMessage, scrollToBottom, hydrate, bindIncoming, unbindIncoming]);

  /* ── Emniyet ağı: sekmeye/pencereye dönünce geçmişi DB'den tazele (arka planda
       kaçan realtime olabilir; tek gerçek kaynak yine server). ── */
  useEffect(() => {
    if (!conversationId) return;
    // Debounce: sekmeye dönüş çoğu tarayıcıda focus + visibilitychange'i ART ARDA
    // tetikler; kısa pencerede tek tazeleme yeter (inFlightConvRef de ikinciyi
    // ayrıca eler). Aksiyon yoksa periyodik istek OLUŞMAZ — yalnız gerçek dönüşte.
    let last = 0;
    const onActive = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      void hydrate(conversationId, false);
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
      if (reportMsgId) return; // ReportModal kendi ESC'sini yönetir
      if (openMsgMenu) {
        setOpenMsgMenu(null);
        return;
      }
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      if (confirmClear) {
        setConfirmClear(false);
        return;
      }
      closeChat();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeChat, menuOpen, confirmClear, openMsgMenu, reportMsgId]);

  /* ── Mesaj seçenek menüsü: dışarı tık ile kapan. ── */
  useEffect(() => {
    if (!openMsgMenu) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest(".dm-msg-menu-wrap")) setOpenMsgMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openMsgMenu]);

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
      void refreshUnread();
      setConfirmClear(false);
    } else {
      setConfirmClear(false);
      showNotice("Sohbet temizlenemedi, tekrar dene.");
    }
  }, [conversationId, clearing, refreshUnread, showNotice]);

  const ready = !loading && !!conversationId;

  return (
    <div
      className={`dm-overlay${isMobile ? " dm-overlay--sheet" : ""}`}
      onClick={() => closeChat()}
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
            <button type="button" className="dm-close" onClick={() => closeChat()} aria-label="Kapat">
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
                // Karşı tarafın GERÇEK (optimistic olmayan) mesajı bildirilebilir.
                const canReport = !isMe && !m.id.startsWith("temp-");
                return (
                  <div key={m.id} className={`dm-msg ${isMe ? "dm-msg--me" : "dm-msg--them"}`}>
                    <span className="dm-bubble">{m.content}</span>
                    {canReport && (
                      <div className="dm-msg-menu-wrap">
                        <button
                          type="button"
                          className="dm-msg-menu-btn"
                          onClick={() => setOpenMsgMenu((cur) => (cur === m.id ? null : m.id))}
                          aria-label="Mesaj seçenekleri"
                          aria-haspopup="menu"
                          aria-expanded={openMsgMenu === m.id}
                        >
                          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
                            <circle cx="5" cy="12" r="1.7" fill="currentColor" />
                            <circle cx="12" cy="12" r="1.7" fill="currentColor" />
                            <circle cx="19" cy="12" r="1.7" fill="currentColor" />
                          </svg>
                        </button>
                        {openMsgMenu === m.id && (
                          <div className="dm-msg-menu" role="menu">
                            <button
                              type="button"
                              className="dm-msg-menu-item"
                              role="menuitem"
                              onClick={() => {
                                setOpenMsgMenu(null);
                                setReportMsgId(m.id);
                              }}
                            >
                              Mesajı bildir
                            </button>
                          </div>
                        )}
                      </div>
                    )}
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
            nested /* DM overlay'i (6500) içinden açılır → üstünde dursun */
            busy={clearing}
            onConfirm={() => void doClear()}
            onCancel={() => setConfirmClear(false)}
          />
        </div>
      )}

      {reportMsgId && (
        <div onClick={(e) => e.stopPropagation()} role="presentation">
          <ReportModal
            kind="message"
            onSubmit={(reason, detail) => reportDmMessage(reportMsgId, reason, detail)}
            onClose={() => setReportMsgId(null)}
          />
        </div>
      )}
    </div>
  );
}
