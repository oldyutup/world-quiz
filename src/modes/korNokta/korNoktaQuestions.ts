/**
 * korNoktaQuestions — Kör Nokta soru bankası (yeni soru-cevap akışı).
 *
 * Dedektif her tur bu havuzdan 5 soru seçer; raporcular/casuslar bu sorulara
 * Evet / Hayır / Emin değilim ile cevap verir. Sorular YALNIZ gözlem/kanıt
 * sorar — hiçbir soru doğrudan ülke/şehir/bölge adı sormaz (spec §soru havuzu).
 *
 * id'ler kalıcıdır ve game_state içinde (selectedQuestions / answers) ve
 * start_game'in p_question_pool payload'ında ham string olarak taşınır; server
 * yalnız id'lerle çalışır (metin client tarafında kalır). Bir id'yi ASLA yeniden
 * anlamlandırma — soruyu değiştireceksen yeni id ver, eskisini havuzdan çıkar.
 *
 * Tek yazıcı server kuralı korunur: bu dosya saf veridir, hiçbir state yazmaz.
 */

export interface KorNoktaQuestion {
  id: string;
  text: string;
}

/**
 * Aktif soru havuzu (~30 soru, gözlem-temelli). Sıra burada sabittir; dedektife
 * gösterilirken tur başına deterministic olarak karıştırılır (shuffleQuestions).
 */
export const korNoktaQuestions: KorNoktaQuestion[] = [
  // Yazı / Alfabe
  { id: "q_sign_clear",        text: "Tabela veya yazı net görünüyor mu?" },
  { id: "q_latin_script",      text: "Latin alfabesi var mı?" },
  { id: "q_nonlatin_script",   text: "Latin dışı alfabe var mı?" },
  { id: "q_east_asian_script", text: "Yazılar Doğu Asya dili gibi mi?" },
  { id: "q_script_strong",     text: "Yazı/tabela ipucu güçlü mü?" },

  // Yol / Trafik
  { id: "q_traffic_right",     text: "Trafik sağdan akıyor gibi mi?" },
  { id: "q_traffic_left",      text: "Trafik soldan akıyor gibi mi?" },
  { id: "q_highway",           text: "Otoyol veya geniş ana yol var mı?" },
  { id: "q_road_markings",     text: "Yol çizgileri belirgin bir ipucu veriyor mu?" },
  { id: "q_road_europe",       text: "Yol çevresi Avrupa düzenine benziyor mu?" },

  // Mimari / Şehir dokusu
  { id: "q_arch_europe",       text: "Avrupa mimarisi gibi mi?" },
  { id: "q_modern_city",       text: "Modern şehir dokusu baskın mı?" },
  { id: "q_village",           text: "Köy/kasaba havası var mı?" },
  { id: "q_suburb",            text: "Banliyö hissi var mı?" },
  { id: "q_historic_buildings", text: "Binalar eski/tarihi doku taşıyor mu?" },
  { id: "q_dense_buildings",   text: "Binalar yoğun ve bitişik mi?" },

  // Doğa / İklim
  { id: "q_mountainous",       text: "Dağlık alan hissi var mı?" },
  { id: "q_coastal",           text: "Deniz/kıyı etkisi hissediliyor mu?" },
  { id: "q_green_forest",      text: "Yeşil/ormanlık alan baskın mı?" },
  { id: "q_arid_hot",          text: "Kurak/sıcak iklim gibi mi?" },
  { id: "q_flat_plain",        text: "Düz ova/polder hissi var mı?" },

  // Ortam / İnsan / Araç
  { id: "q_big_city",          text: "Büyük şehir gibi mi?" },
  { id: "q_rural_road",        text: "Kırsal yol gibi mi?" },
  { id: "q_crowded_street",    text: "Kalabalık cadde/pazar hissi var mı?" },
  { id: "q_motorcycles",       text: "Motosiklet yoğunluğu dikkat çekiyor mu?" },
  { id: "q_vehicles_clue",     text: "Araçlar güçlü ipucu veriyor mu?" },
  { id: "q_tidy_layout",       text: "Sokak düzeni temiz ve planlı mı?" },
  { id: "q_touristic",         text: "Görselde turistik/tarihi çevre hissi var mı?" },
  { id: "q_feels_europe",      text: "Sahne daha çok Avrupa'ya mı yakın hissettiriyor?" },
  { id: "q_feels_asia",        text: "Sahne daha çok Asya'ya mı yakın hissettiriyor?" },
];

/** id → soru hızlı arama. */
const questionById: Map<string, KorNoktaQuestion> = new Map(
  korNoktaQuestions.map(q => [q.id, q]),
);

export function findKnQuestion(id: string): KorNoktaQuestion | null {
  return questionById.get(id) ?? null;
}

/** Bir id'nin gösterilecek metni; bilinmeyen id güvenli fallback döner. */
export function knQuestionText(id: string): string {
  return questionById.get(id)?.text ?? "Bilinmeyen soru";
}

/** start_game payload'ı: havuzdaki tüm soru id'leri (server auto-fill için). */
export function buildKnQuestionPool(): string[] {
  return korNoktaQuestions.map(q => q.id);
}

/** Dedektifin tur başına seçebileceği soru sayısı. */
export const KN_QUESTION_PICK_COUNT = 5;

/* ── Cevap seçenekleri (game_state kontratı) ── */
export type KnAnswerValue = "yes" | "no" | "unsure";
export const KN_ANSWER_VALUES: readonly KnAnswerValue[] = ["yes", "no", "unsure"];

export const KN_ANSWER_LABELS: Record<KnAnswerValue, string> = {
  yes:    "Evet",
  no:     "Hayır",
  unsure: "Emin değilim",
};

/** Anonim cevap kartında gösterilen kısa işaret. */
export const KN_ANSWER_GLYPHS: Record<KnAnswerValue, string> = {
  yes:    "✓ Evet",
  no:     "✕ Hayır",
  unsure: "? Emin değil",
};

export function isKnAnswerValue(value: unknown): value is KnAnswerValue {
  return value === "yes" || value === "no" || value === "unsure";
}

/* ── Deterministic karıştırma (tur başına sabit sıra) ──────────────────────
 * Dedektif grid'i her render'da yeniden karışmasın diye sıra roundIndex'e
 * bağlı seed'li PRNG ile belirlenir. Saf fonksiyon; aynı seed → aynı sıra. */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Soru havuzunu verilen tur için deterministic karıştırılmış kopyasıyla döner. */
export function shuffleQuestions(roundIndex: number): KorNoktaQuestion[] {
  const rng = mulberry32((roundIndex + 1) * 0x9e3779b1);
  const deck = [...korNoktaQuestions];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
