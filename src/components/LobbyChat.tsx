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
import { useState, useEffect, useRef, useCallback, memo } from "react";
import { supabase, type DuelMessage } from "../lib/supabase";

const MAX_LEN = 200;

interface Props {
  roomCode:   string;
  playerName: string;
}

/* ────────────────────────────────────────────────────────────
   Sabit alt component'ler (parent'ın dışında — focus kaybı yok)
   ──────────────────────────────────────────────────────────── */

interface MsgListProps {
  messages: DuelMessage[];
  myName:   string;
  scrollRef: React.RefObject<HTMLDivElement>;
}
const MsgList = memo(({ messages, myName, scrollRef }: MsgListProps) => {
  return (
    <div className="lc-messages">
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
      <div ref={scrollRef} />
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

export default function LobbyChat({ roomCode, playerName }: Props) {
  const myName = playerName.trim();

  const [messages, setMessages] = useState<DuelMessage[]>([]);
  const [draft,    setDraft]    = useState("");
  const [open,     setOpen]     = useState(true);
  const [sheetOpen,setSheetOpen]= useState(false);
  const [unread,   setUnread]   = useState(0);
  const [sending,  setSending]  = useState(false);

  const scrollRef     = useRef<HTMLDivElement>(null);
  const desktopRef    = useRef<HTMLInputElement>(null);
  const sheetRef      = useRef<HTMLInputElement>(null);
  const channelRef    = useRef<ReturnType<typeof supabase.channel> | null>(null);

  /* ── Ortak ekleyici: dedupe garantili ── */
  const addMessage = useCallback((msg: DuelMessage) => {
    setMessages(prev => {
      if (prev.some(m => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  /* ── 1) Geçmişi yükle ── */
  useEffect(() => {
    supabase
      .from("duel_messages")
      .select("*")
      .eq("room_code", roomCode)
      .order("created_at", { ascending: true })
      .limit(100)
      .then(({ data, error }) => {
        if (error) {
          console.error("[LobbyChat] history load error:", error);
          return;
        }
        if (data) setMessages(data as DuelMessage[]);
      });
  }, [roomCode]);

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

  /* ── 3) Yeni mesaj geldikçe scroll + unread sayacı ── */
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.player_name === myName) return; // kendi mesajım sayılmaz
    if (!open && !sheetOpen) setUnread(u => u + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => { if (open || sheetOpen) setUnread(0); }, [open, sheetOpen]);

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

    try {
      // c) DB INSERT (id'yi DB üretsin, geri al)
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

      const real = data as DuelMessage;

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
      console.error("[LobbyChat] send failed:", err);
      // d) Geri al
      setMessages(prev => prev.filter(m => m.id !== tempId));
      setDraft(text);
    } finally {
      setSending(false);
      // Focus geri ver — hangi panel açıksa ona
      setTimeout(() => {
        if (sheetOpen) sheetRef.current?.focus();
        else           desktopRef.current?.focus();
      }, 0);
    }
  }, [draft, myName, roomCode, sending, sheetOpen]);

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
            <span className="lc-title-icon">💬</span>
            <span>Sohbet</span>
            {!open && unread > 0 && <span className="lc-badge">{unread}</span>}
          </span>
          <span className="lc-chevron">{open ? "▾" : "◂"}</span>
        </header>

        {open && (
          <>
            <MsgList messages={messages} myName={myName} scrollRef={scrollRef} />
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
        onClick={() => setSheetOpen(true)}
        type="button"
        aria-label="Sohbeti aç"
      >
        <span>💬</span>
        <span>Sohbet</span>
        {unread > 0 && <span className="lc-fab-badge">{unread}</span>}
      </button>

      {/* ════ MOBILE BOTTOM-SHEET ════ */}
      {sheetOpen && (
        <div className="lc-sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="lc-sheet" onClick={e => e.stopPropagation()}>
            <div className="lc-sheet-handle" />
            <header className="lc-sheet-header">
              <span className="lc-title">
                <span className="lc-title-icon">💬</span>
                <span>Sohbet</span>
              </span>
              <button
                className="lc-sheet-close"
                onClick={() => setSheetOpen(false)}
                type="button"
                aria-label="Kapat"
              >
                ✕
              </button>
            </header>
            <MsgList messages={messages} myName={myName} scrollRef={scrollRef} />
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
