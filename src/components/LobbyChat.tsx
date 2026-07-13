/**
 * LobbyChat.tsx — v3 (production)
 *
 * Mimari:
 *   - Mesajlar HEM Supabase tablosuna yazılır (kalıcılık) HEM de
 *     Supabase Broadcast ile anlık iletilir (Realtime postgres_changes
 *     açık olmasa bile çalışır).
 *   - Optimistic update: mesaj gönderildiğinde anında UI'a yansır.
 *   - postgres_changes (varsa) sadece dedupe + reconcile için kullanılır.
 *
 * Focus problemi çözümü:
 *   - InputRow / MessageList component'leri DIŞARDA tanımlı (her render'da
 *     yeniden oluşturulmuyor) → React inputu unmount etmiyor → focus kalır.
 *
 * UI:
 *   - Desktop: kartın sağında 320px panel, collapse edilebilir.
 *   - Mobile : sağ alt FAB → bottom-sheet.
 */
import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { supabase, type DuelMessage } from "../lib/supabase";
import { listBlockedUsers } from "../lib/social";

const MAX_LEN = 200;

/** Sohbet adı katlama — engelli kullanıcı adıyla eşleştirmek için (TR-duyarlı). */
function foldName(s: string | null | undefined): string {
  return (s ?? "").trim().toLocaleLowerCase("tr");
}

interface Props {
  roomCode:   string;
  playerName: string;
  mobileSheetOpen?:         boolean;
  onMobileSheetOpenChange?: (open: boolean) => void;
  hideMobileFab?:           boolean;
  /**
   * Yazma yolu seçici (M-Chat-A / 20260614120000):
   *   - "duel"        → duel_send_message RPC          (Duel 1v1)
   *   - "flag_duel"   → flag_duel_send_message RPC     (Flag Duel manual+QM)
   *   - "wheel_duel"  → wheel_duel_send_message RPC    (Wheel Duel 1v1)
   *   - "wheel_group" → wheel_group_send_message RPC   (Wheel Group)
   *   - "duel_group"  → duel_group_send_message RPC    (Duel Group)
   *   - "conquest"    → conquest_send_message RPC      (Conquest)
   *   - "tevatur"     → tevatur_send_message RPC       (Kör Nokta — tevatur_* DB adları reuse)
   *   - "direct"      → fallback: supabase.from("duel_messages").insert
   *                     Dilim 1 (yumuşak geçiş) süresince tutuluyor; tüm
   *                     call-site'lar RPC moduna geçtikten ve Dilim 2
   *                     duel_messages INSERT lockdown'ı uygulandıktan sonra
   *                     bu yol komple ölür ve kaldırılabilir.
   *
   * Tüm RPC modlarında: player_name CLIENT'TAN GÖNDERİLMEZ — server-side
   * <mode>_players.name resolve edilir. playerId + claimToken zorunlu.
   */
  sendMode?:   "duel" | "flag_duel" | "wheel_duel" | "wheel_group" | "flag_group" | "duel_group" | "conquest" | "tevatur" | "direct";
  /** RPC modları için zorunlu — <mode>_players.id */
  playerId?:   string;
  /** RPC modları için zorunlu — <mode>_player_claims.claim_token */
  claimToken?: string;
  /**
   * Opsiyonel zaman penceresi (ISO 8601). Verilirse HEM geçmiş yüklemesi HEM
   * realtime intake yalnız `created_at >= minCreatedAt` mesajlarını gösterir.
   * Kör Nokta round_reveal sohbeti bunu kullanır: her tur reveal'i taze
   * başlasın, önceki turun mesajları taşmasın. Verilmezse (lobi + diğer
   * modlar) eski davranış: odanın tüm mesajları görünür.
   */
  minCreatedAt?: string;
  /**
   * Opsiyonel: "Sohbet" başlığının solunda gösterilecek özel ikon (verilmezse
   * 💬 emoji). Yalnız Kuşatma geçer — diğer modlar etkilenmez.
   */
  titleIcon?: import("react").ReactNode;
}

/** sendMode → RPC adı eşlemesi. "direct" buraya düşmez. */
const SEND_RPC: Record<
  "duel" | "flag_duel" | "wheel_duel" | "wheel_group" | "flag_group" | "duel_group" | "conquest" | "tevatur",
  string
> = {
  duel:        "duel_send_message",
  flag_duel:   "flag_duel_send_message",
  wheel_duel:  "wheel_duel_send_message",
  wheel_group: "wheel_group_send_message",
  flag_group:  "flag_group_send_message",
  duel_group:  "duel_group_send_message",
  conquest:    "conquest_send_message",
  tevatur:     "tevatur_send_message",
};

/* ────────────────────────────────────────────────────────────
   Sabit alt component'ler (parent'ın dışında — focus kaybı yok)
   ──────────────────────────────────────────────────────────── */

interface MsgListProps {
  messages: DuelMessage[];
  myName:   string;
  listRef: React.RefObject<HTMLDivElement>;
  onMessagesScroll: (el: HTMLDivElement) => void;
}
const MsgList = memo(({ messages, myName, listRef, onMessagesScroll }: MsgListProps) => {
  return (
    <div
      className="lc-messages"
      ref={listRef}
      onScroll={e => onMessagesScroll(e.currentTarget)}
    >
      {messages.length === 0 && (
        <p className="lc-empty">Henüz mesaj yok. İlk sen yaz! 👋</p>
      )}
      {messages.map(m => {
        const isMe = m.player_name === myName;
        return (
          <div key={m.id} className={`lc-msg ${isMe ? "lc-msg-me" : "lc-msg-opp"}`}>
            {!isMe && <span className="lc-sender">{m.player_name}</span>}
            <span className="lc-bubble">{m.message}</span>
          </div>
        );
      })}
      {/* Scroll alanı doğrudan .lc-messages ref'iyle yönetilir. */}
    </div>
  );
});

interface InputRowProps {
  draft:    string;
  setDraft: (v: string) => void;
  onSend:   () => void;
  sending:  boolean;
  inputRef: React.RefObject<HTMLInputElement>;
}
const InputRow = memo(({ draft, setDraft, onSend, sending, inputRef }: InputRowProps) => {
  return (
    <div className="lc-input-row">
      <input
        ref={inputRef}
        className="lc-input"
        type="text"
        placeholder="Mesaj yaz…"
        maxLength={MAX_LEN}
        value={draft}
        onChange={e => setDraft(e.target.value.slice(0, MAX_LEN))}
        onKeyDown={e => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSend();
          }
        }}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <button
        className="lc-send-btn"
        // onMouseDown + preventDefault → input blur olmadan tıklama yakalanır
        onMouseDown={e => { e.preventDefault(); onSend(); }}
        disabled={!draft.trim() || sending}
        type="button"
        aria-label="Gönder"
      >
        ➤
      </button>
    </div>
  );
});

/* ────────────────────────────────────────────────────────────
   Ana bileşen
   ──────────────────────────────────────────────────────────── */

export default function LobbyChat({
  roomCode,
  playerName,
  mobileSheetOpen,
  onMobileSheetOpenChange,
  hideMobileFab,
  sendMode   = "direct",
  playerId,
  claimToken,
  minCreatedAt,
  titleIcon,
}: Props) {
  const myName = playerName.trim();
  const isControlled = onMobileSheetOpenChange !== undefined;

  const [messages, setMessages] = useState<DuelMessage[]>([]);
  // Engellenen kullanıcıların adları (katlanmış). Mount'ta bir kez çekilir;
  // engelli oyuncuların mesajları HEM geçmişte HEM realtime'da gizlenir.
  // Sınır: chat mesajları profile_id taşımaz (yalnız player_name) → eşleşme
  // kullanıcı adı üzerinden yapılır (giriş yapan oyuncuda ad = username).
  const [blockedNames, setBlockedNames] = useState<Set<string>>(() => new Set());
  const blockedNamesRef = useRef<Set<string>>(blockedNames);
  useEffect(() => { blockedNamesRef.current = blockedNames; }, [blockedNames]);
  useEffect(() => {
    let alive = true;
    void listBlockedUsers().then((list) => {
      if (!alive) return;
      setBlockedNames(new Set(list.map((u) => foldName(u.username)).filter(Boolean)));
    });
    return () => { alive = false; };
  }, []);

  const [draft,    setDraft]    = useState("");
  const [open,     setOpen]     = useState(true);
  const [sheetOpen,setSheetOpen]= useState(false);
  const [unread,   setUnread]   = useState(0);
  const [sending,  setSending]  = useState(false);
  // Soft anti-spam UX (M-Chat-C): rate_limited / duplicate_message gibi
  // server-side baraj hatalarında kısa süreli kullanıcı uyarısı. 2.5sn
  // sonra otomatik kaybolur. Normal hata akışı (network/auth) etkilenmez.
  const [notice,   setNotice]   = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const effectiveSheetOpen = isControlled ? (mobileSheetOpen ?? false) : sheetOpen;
  const openSheet  = () => { if (isControlled) onMobileSheetOpenChange!(true);  else setSheetOpen(true);  };
  const closeSheet = () => { if (isControlled) onMobileSheetOpenChange!(false); else setSheetOpen(false); };

  const desktopMessagesRef = useRef<HTMLDivElement>(null);
  const sheetMessagesRef   = useRef<HTMLDivElement>(null);
  const atBottomRef        = useRef(true);
  const desktopRef    = useRef<HTMLInputElement>(null);
  const sheetRef      = useRef<HTMLInputElement>(null);
  const channelRef    = useRef<ReturnType<typeof supabase.channel> | null>(null);

  /* ── Soft notice helper: 2.5sn sonra otomatik kaybolur ── */
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 2500);
  }, []);

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
  }, []);

  /* ── Pencere filtresi: realtime intake'i de minCreatedAt'e göre kıs.
     Ref üzerinden okunur → minCreatedAt değişince kanal yeniden kurulmaz. ── */
  const minCreatedAtRef = useRef(minCreatedAt);
  useEffect(() => { minCreatedAtRef.current = minCreatedAt; }, [minCreatedAt]);

  /* ── Ortak ekleyici: dedupe + (varsa) zaman penceresi filtresi ── */
  const addMessage = useCallback((msg: DuelMessage) => {
    const floor = minCreatedAtRef.current;
    if (floor && msg.created_at && msg.created_at < floor) return;
    // Engellenen kullanıcının mesajı local state'e hiç girmesin.
    if (blockedNamesRef.current.has(foldName(msg.player_name))) return;
    setMessages(prev => {
      if (prev.some(m => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  /* ── Görünür mesajlar: engelli kullanıcı mesajları gizlenir. Geçmiş yüklemesi
     setMessages'i doğrudan kullandığından (addMessage'i atlar) ve block seti
     async geldiğinden, render + unread bu türetilmiş listeden beslenir. ── */
  const visibleMessages = useMemo(
    () => (blockedNames.size === 0
      ? messages
      : messages.filter(m => !blockedNames.has(foldName(m.player_name)))),
    [messages, blockedNames],
  );

  /* ── 1) Geçmişi yükle (minCreatedAt verilirse yalnız o andan sonrası) ── */
  useEffect(() => {
    let query = supabase
      .from("duel_messages")
      .select("*")
      .eq("room_code", roomCode);
    if (minCreatedAt) query = query.gte("created_at", minCreatedAt);
    query
      .order("created_at", { ascending: true })
      .limit(100)
      .then(({ data, error }) => {
        if (error) {
          console.error("[LobbyChat] history load error:", error);
          return;
        }
        if (data) setMessages(data as DuelMessage[]);
      });
  }, [roomCode, minCreatedAt]);

  /* ── 2) Realtime: HEM broadcast HEM postgres_changes ──
     Broadcast: anında çalışır, replication ayarı gerektirmez.
     postgres_changes: yedek + diğer tab'tan açılan istemciler için.
  */
  useEffect(() => {
    const chan = supabase.channel(`chat-${roomCode}`, {
      config: { broadcast: { self: false } },
    });

    chan
      .on("broadcast", { event: "msg" }, payload => {
        const msg = payload.payload as DuelMessage;
        addMessage(msg);
      })
      .on(
        "postgres_changes",
        {
          event:  "INSERT",
          schema: "public",
          table:  "duel_messages",
          filter: `room_code=eq.${roomCode}`,
        },
        payload => addMessage(payload.new as DuelMessage),
      )
      .subscribe();

    channelRef.current = chan;
    return () => { supabase.removeChannel(chan); channelRef.current = null; };
  }, [roomCode, addMessage]);

  /* ── 3) Scroll yönetimi ── */
  const handleMessagesScroll = useCallback((el: HTMLDivElement) => {
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    requestAnimationFrame(() => {
      const el = effectiveSheetOpen
        ? sheetMessagesRef.current
        : desktopMessagesRef.current;

      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior });
      atBottomRef.current = true;
    });
  }, [effectiveSheetOpen]);

  const prevVisibleMsgCountRef = useRef(0);

  // Yeni mesaj → kullanıcı zaten alttaysa otomatik kaydır.
  // Toplu geçmiş yüklemesi → her zaman en alta.
  useEffect(() => {
    const delta = visibleMessages.length - prevVisibleMsgCountRef.current;
    prevVisibleMsgCountRef.current = visibleMessages.length;
    if (delta <= 0) return;

    if (delta > 1 || atBottomRef.current) {
      scrollToBottom(delta > 1 ? "auto" : "smooth");
    }
  }, [visibleMessages.length, scrollToBottom]);

  // Desktop panel açıldığında en alta in (MsgList remount olur, messages değişmez).
  useEffect(() => {
    if (open) scrollToBottom("auto");
  }, [open, scrollToBottom]);

  // Mobil sheet açıldığında en alta in.
  useEffect(() => {
    if (effectiveSheetOpen) scrollToBottom("auto");
  }, [effectiveSheetOpen, scrollToBottom]);

  useEffect(() => {
    if (visibleMessages.length === 0) return;
    const last = visibleMessages[visibleMessages.length - 1];
    if (last.player_name === myName) return; // kendi mesajım sayılmaz
    if (last.player_name !== myName) setUnread(u => u + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleMessages]);

  useEffect(() => { if (open) setUnread(0); }, [open]);
  useEffect(() => { if (effectiveSheetOpen) setUnread(0); }, [effectiveSheetOpen]);

  /* ── 4) Mesaj gönder ──
     Adımlar:
       a) Optimistic mesaj UI'a koy
       b) Broadcast ile rakibe ilet (anlık)
       c) DB'ye yaz (kalıcılık)
       d) Hata olursa optimistic'i geri al + draft'ı geri koy
  */
  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !myName || sending) return;

    setSending(true);
    setDraft("");

    // a) Optimistic
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const optimistic: DuelMessage = {
      id:          tempId,
      room_code:   roomCode,
      player_name: myName,
      message:     text,
      created_at:  new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimistic]);

    let rpcName: string | null = null;
    try {
      // c) DB write — mode'a göre RPC ya da (geçici) direct insert
      let real: DuelMessage;
      if (sendMode !== "direct") {
        // RPC yolu (M-Chat-A): player_name CLIENT'TAN GÖNDERİLMEZ —
        // server-side <mode>_players.name kullanılır.
        if (!playerId) {
          throw new Error(
            `LobbyChat: ${sendMode} mode requires playerId`,
          );
        }
        rpcName = SEND_RPC[sendMode];
        // p_claim_token uuid: PostgREST empty string'i uuid'e cast edemez
        // ('22P02 invalid_text_representation'). Flag Duel QM gibi senaryolarda
        // claim_token boş kalabilir; authorize helper'ları null'da profile_id
        // (auth.uid()) fallback'ine düşer. Boş string'i açıkça null'a normalize
        // ediyoruz ki PG parser hatası yerine düzgün authorize akışı çalışsın.
        const claimTokenParam =
          claimToken && claimToken.length > 0 ? claimToken : null;
        const { data, error } = await supabase.rpc(rpcName, {
          p_room_code:   roomCode,
          p_player_id:   playerId,
          p_claim_token: claimTokenParam,
          p_message:     text,
        });
        if (error) throw error;
        real = data as DuelMessage;
      } else {
        // Direct insert (yumuşak geçiş dönemi fallback'i). Tüm call-site'lar
        // RPC moduna geçtikten + duel_messages INSERT lockdown'ı yapıldıktan
        // sonra bu dal ölü kalacak ve kaldırılabilir.
        const { data, error } = await supabase
          .from("duel_messages")
          .insert({
            room_code:   roomCode,
            player_name: myName,
            message:     text,
          })
          .select("*")
          .single();
        if (error) throw error;
        real = data as DuelMessage;
      }

      // Optimistic'i gerçek satırla değiştir
      setMessages(prev =>
        prev.map(m => (m.id === tempId ? real : m))
      );

      // b) Broadcast (gerçek id ile)
      channelRef.current?.send({
        type:    "broadcast",
        event:   "msg",
        payload: real,
      });
    } catch (err) {
      // Diagnostic: gerçek claim_token değerini loglamıyoruz; yalnız boolean
      // varlığı + RPC adı + hata mesajı/kodu. Bu, sendMode prop hatası vs
      // RPC server hatası ayrımını hızlıca yapmamızı sağlıyor.
      const e = err as { message?: string; code?: string; details?: string; hint?: string };
      console.error("[LobbyChat] send failed:", {
        sendMode,
        rpc:           rpcName,
        roomCode,
        hasPlayerId:   !!playerId,
        hasClaimToken: !!(claimToken && claimToken.length > 0),
        errorCode:     e?.code,
        errorMessage:  e?.message,
        errorDetails:  e?.details,
        errorHint:     e?.hint,
      });
      // d) Geri al
      setMessages(prev => prev.filter(m => m.id !== tempId));

      // Soft anti-spam hataları: server-side baraj (M-Chat-C migration).
      // Kullanıcıya kısa uyarı göster, draft'ı GERİ KOYMA — aksi halde
      // kullanıcı tekrar tıklasa bile aynı baraja takılır, döngü kötüleşir.
      const errMsg = e?.message ?? "";
      if (errMsg === "rate_limited") {
        showNotice("Çok hızlı yazıyorsun, biraz yavaşla.");
      } else if (errMsg === "duplicate_message") {
        showNotice("Aynı mesajı arka arkaya gönderemezsin.");
      } else {
        // Diğer hatalar: önceki davranış — mesajı input'a geri koy ki
        // kullanıcı tekrar deneyebilsin (network / auth / transient errors).
        setDraft(text);
      }
    } finally {
      setSending(false);
      // Focus geri ver — hangi panel açıksa ona
      setTimeout(() => {
        if (effectiveSheetOpen) sheetRef.current?.focus();
        else                    desktopRef.current?.focus();
      }, 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, myName, roomCode, sending, effectiveSheetOpen, sendMode, playerId, claimToken, showNotice]);

  /* ─────────── render ─────────── */
  return (
    <>
      {/* ════ DESKTOP PANEL ════ */}
      <aside className={`lc-panel ${open ? "is-open" : "is-collapsed"}`}>
        <header
          className="lc-header"
          onClick={() => setOpen(v => !v)}
          role="button"
          tabIndex={0}
        >
          <span className="lc-title">
            <span className="lc-title-icon">{titleIcon ?? "💬"}</span>
            <span>Sohbet</span>
            {!open && unread > 0 && <span className="lc-badge">{unread}</span>}
          </span>
          <span className="lc-chevron">{open ? "▾" : "◂"}</span>
        </header>

        {open && (
          <>
            <MsgList
              messages={visibleMessages}
              myName={myName}
              listRef={desktopMessagesRef}
              onMessagesScroll={handleMessagesScroll}
            />
            {notice && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  margin: "0 12px 8px",
                  padding: "6px 10px",
                  background: "rgba(15, 23, 42, 0.92)",
color: "#ffffff",
border: "1px solid rgba(255, 255, 255, 0.65)",
boxShadow: "0 0 14px rgba(255, 255, 255, 0.12)",
fontWeight: 700,
                  borderRadius: 8,
                  fontSize: 12.5,
                  lineHeight: 1.35,
                  textAlign: "center",
                }}
              >
                {notice}
              </div>
            )}
            <InputRow
              draft={draft}
              setDraft={setDraft}
              onSend={send}
              sending={sending}
              inputRef={desktopRef}
            />
          </>
        )}
      </aside>

      {/* ════ MOBILE FAB ════ */}
      <button
        className="lc-fab"
        onClick={openSheet}
        type="button"
        aria-label="Sohbeti aç"
        style={hideMobileFab ? { display: "none" } : undefined}
      >
        <span>{titleIcon ?? "💬"}</span>
        <span>Sohbet</span>
        {unread > 0 && <span className="lc-fab-badge">{unread}</span>}
      </button>

      {/* ════ MOBILE BOTTOM-SHEET ════ */}
      {effectiveSheetOpen && (
        <div className="lc-sheet-backdrop" onClick={closeSheet}>
          <div className="lc-sheet" onClick={e => e.stopPropagation()}>
            <div className="lc-sheet-handle" />
            <header className="lc-sheet-header">
              <span className="lc-title">
                <span className="lc-title-icon">{titleIcon ?? "💬"}</span>
                <span>Sohbet</span>
              </span>
              <button
                className="lc-sheet-close"
                onClick={closeSheet}
                type="button"
                aria-label="Kapat"
              >
                ✕
              </button>
            </header>
            <MsgList
              messages={visibleMessages}
              myName={myName}
              listRef={sheetMessagesRef}
              onMessagesScroll={handleMessagesScroll}
            />
            {notice && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  margin: "0 12px 8px",
                  padding: "6px 10px",
                  background: "rgba(15, 23, 42, 0.92)",
color: "#ffffff",
border: "1px solid rgba(255, 255, 255, 0.65)",
boxShadow: "0 0 14px rgba(255, 255, 255, 0.12)",
fontWeight: 700,
                  borderRadius: 8,
                  fontSize: 12.5,
                  lineHeight: 1.35,
                  textAlign: "center",
                }}
              >
                {notice}
              </div>
            )}
            <InputRow
              draft={draft}
              setDraft={setDraft}
              onSend={send}
              sending={sending}
              inputRef={sheetRef}
            />
          </div>
        </div>
      )}
    </>
  );
}
