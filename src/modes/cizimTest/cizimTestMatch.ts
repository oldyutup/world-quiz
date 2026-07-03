/**
 * cizimTestMatch.ts — Çizim Test eşleştirme tahtasının deterministik state
 * machine'i.
 *
 * Neden event-sourced: prototip DB'siz, yalnız Supabase Realtime broadcast
 * ile çalışır (bkz. CizimTestMode.tsx). Sunucu-otoriter bir satır olmadığı
 * için her client AYNI event akışına AYNI reducer'ı uygular ve aynı sonuca
 * varır. Bunun güvencesi:
 *
 *   - Her event, gönderenin gördüğü `turnSeq`'i taşır; reducer yalnız kendi
 *     `turnSeq`'iyle eşleşen eventi uygular (bayat/çift event no-op).
 *   - İkinci kart açıldığında sonuç HEMEN uygulanmaz; `resolving` alanına
 *     yazılır. UI kısa bir gösterim süresi sonunda `resolveBoard`'u lokal
 *     çağırır (event yok — sonuç state'ten deterministik türetilir).
 *   - Bir client resolve timer'ı geç kalmışken sıradaki event gelirse,
 *     reducer `turnSeq + 1` ipucuyla önce kendi kendine resolve eder
 *     (auto-resolve) — akış kilitlenmez, state'ler yakınsar.
 *
 * Kurallar (1v1 ortak tahta / 2v2 takım-içi tahta aynı makine):
 *   - Sıradaki oyuncu kart açar; ilk kart ~3 sn açık kalır, ikinci kart
 *     seçilmezse "pass" ile kapanır ve sıra geçer.
 *   - İkinci kart aynı kelimenin diğer çizimiyse çift bulunur, kartlar
 *     tahtadan alınır ve AYNI oyuncu devam eder; yanlışsa kartlar kapanır,
 *     sıra rotasyondaki sonraki oyuncuya geçer.
 */

export type CtTeam = "blue" | "red";

export interface CtCard {
  /** Tahtadaki pozisyon (0..N-1) — event'ler bu id ile konuşur. */
  cardId: number;
  /** Maç kelime listesindeki indeks (çizim turu = kelime indeksi). */
  wordIdx: number;
  /** Çizimi yapan oyuncu. */
  ownerId: string;
}

export interface CtMatchedPair {
  wordIdx: number;
  byPlayerId: string;
  cardIds: [number, number];
}

export interface CtBoardState {
  cards: CtCard[];
  /** cardId → tahtadan alındı mı. */
  removed: boolean[];
  /** Açık (yüzü dönük) kartlar; 0..2 eleman. */
  open: number[];
  /** İkinci kart açıldı, kısa gösterim bekleniyor (bkz. resolveBoard). */
  resolving: {
    a: number;
    b: number;
    correct: boolean;
    byPlayerId: string;
  } | null;
  turnOrder: string[];
  turnPos: number;
  /** Her state geçişinde artar; event'lerin bayatlık guard'ı. */
  turnSeq: number;
  pairsByPlayer: Record<string, number>;
  matched: CtMatchedPair[];
  complete: boolean;
}

export interface CtFlipEvent {
  kind: "flip";
  playerId: string;
  cardId: number;
  turnSeq: number;
}
export interface CtPassEvent {
  kind: "pass";
  playerId: string;
  turnSeq: number;
}
export type CtBoardEvent = CtFlipEvent | CtPassEvent;

export function createBoard(cards: CtCard[], turnOrder: string[]): CtBoardState {
  const pairsByPlayer: Record<string, number> = {};
  turnOrder.forEach((id) => {
    pairsByPlayer[id] = 0;
  });
  return {
    cards,
    removed: cards.map(() => false),
    open: [],
    resolving: null,
    turnOrder,
    turnPos: 0,
    turnSeq: 0,
    pairsByPlayer,
    matched: [],
    complete: false,
  };
}

export function currentPlayer(s: CtBoardState): string {
  return s.turnOrder[s.turnPos % s.turnOrder.length];
}

/**
 * Bekleyen ikinci-kart sonucunu uygula. `resolving` yoksa no-op (idempotent).
 * Doğruysa: çift tahtadan alınır, bulan oyuncunun sırası DEVAM eder.
 * Yanlışsa: kartlar kapanır, sıra sonraki oyuncuya geçer.
 */
export function resolveBoard(s: CtBoardState): CtBoardState {
  if (!s.resolving) return s;
  const { a, b, correct, byPlayerId } = s.resolving;

  if (correct) {
    const removed = [...s.removed];
    removed[a] = true;
    removed[b] = true;
    const complete = removed.every(Boolean);
    return {
      ...s,
      removed,
      open: [],
      resolving: null,
      pairsByPlayer: {
        ...s.pairsByPlayer,
        [byPlayerId]: (s.pairsByPlayer[byPlayerId] ?? 0) + 1,
      },
      matched: [
        ...s.matched,
        { wordIdx: s.cards[a].wordIdx, byPlayerId, cardIds: [a, b] },
      ],
      turnSeq: s.turnSeq + 1,
      complete,
    };
  }

  return {
    ...s,
    open: [],
    resolving: null,
    turnPos: (s.turnPos + 1) % s.turnOrder.length,
    turnSeq: s.turnSeq + 1,
  };
}

export function applyBoardEvent(s: CtBoardState, ev: CtBoardEvent): CtBoardState {
  let st = s;

  // Geç kalmış resolve güvencesi: event, resolve-sonrası turnSeq'i bekliyorsa
  // önce bekleyen sonucu uygula (her client'ta deterministik).
  if (st.resolving && ev.turnSeq === st.turnSeq + 1) {
    st = resolveBoard(st);
  }

  if (st.complete || st.resolving) return st;
  if (ev.turnSeq !== st.turnSeq) return st; // bayat / duplicate event
  if (ev.playerId !== currentPlayer(st)) return st;

  if (ev.kind === "pass") {
    return {
      ...st,
      open: [],
      turnPos: (st.turnPos + 1) % st.turnOrder.length,
      turnSeq: st.turnSeq + 1,
    };
  }

  // flip
  const { cardId } = ev;
  if (cardId < 0 || cardId >= st.cards.length) return st;
  if (st.removed[cardId] || st.open.includes(cardId)) return st;

  if (st.open.length === 0) {
    return { ...st, open: [cardId], turnSeq: st.turnSeq + 1 };
  }
  if (st.open.length === 1) {
    const a = st.open[0];
    const correct = st.cards[a].wordIdx === st.cards[cardId].wordIdx;
    return {
      ...st,
      open: [a, cardId],
      resolving: { a, b: cardId, correct, byPlayerId: ev.playerId },
      turnSeq: st.turnSeq + 1,
    };
  }
  return st;
}

/** Takım tahtası kartlarını üret: her kelime için takımın her üyesinden bir
 *  çizim. Host karıştırır ve match_start ile yayınlar. */
export function buildBoardCards(
  wordCount: number,
  memberIds: string[],
): CtCard[] {
  const raw: { wordIdx: number; ownerId: string }[] = [];
  for (let w = 0; w < wordCount; w++) {
    for (const ownerId of memberIds) raw.push({ wordIdx: w, ownerId });
  }
  for (let i = raw.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [raw[i], raw[j]] = [raw[j], raw[i]];
  }
  return raw.map((r, idx) => ({ cardId: idx, ...r }));
}
