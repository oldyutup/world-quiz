/**
 * korNoktaQuestions — Kör Nokta soru bankası (gizli-kategori dengeli akış).
 *
 * Dedektif her tur, server'ın ürettiği 12 ADAY soru içinden 5 soru seçer;
 * raporcular/casuslar bu sorulara Evet / Hayır / Emin değilim ile cevap verir.
 * Sorular YALNIZ gözlem/kanıt sorar — hiçbir soru doğrudan ülke/şehir/bölge adı
 * sormaz (spec §soru havuzu).
 *
 * Gizli kategori dengesi: havuz 4 kategoriye ayrılır (alphabet / traffic /
 * architecture / nature; her kategoride ≥8 soru). Server her tur HER kategoriden
 * 3 soru çekip 12'yi karıştırır ve game_state'e round.questionCandidates olarak
 * KALICI yazar. Kategori başlıkları UI'da GÖSTERİLMEZ; dedektif yalnız 12 karışık
 * kart görür. Aynı tur içinde (refresh/reconnect) aday seti ve sıra sabittir;
 * yeni turda yeniden üretilir (build_round bir kez random çalışır, sonuç saklanır).
 *
 * id'ler kalıcıdır ve game_state içinde (questionCandidates / selectedQuestions /
 * answers) ham string olarak taşınır; server yalnız id'lerle çalışır (metin client
 * tarafında kalır). Bir id'yi ASLA yeniden anlamlandırma — soruyu değiştireceksen
 * yeni id ver, eskisini havuzdan çıkar.
 *
 * Tek yazıcı server kuralı korunur: bu dosya saf veridir, hiçbir state yazmaz.
 */

/** Gizli kategoriler — yalnız tasarım/denge içindir, UI'da ASLA gösterilmez. */
export type KnQuestionCategory = "alphabet" | "traffic" | "architecture" | "nature";

export const KN_QUESTION_CATEGORIES: readonly KnQuestionCategory[] = [
  "alphabet",
  "traffic",
  "architecture",
  "nature",
];

export interface KorNoktaQuestion {
  id: string;
  text: string;
  /** Gizli kategori — server denge için kullanır; kullanıcıya gösterilmez. */
  category: KnQuestionCategory;
}

/**
 * Aktif soru havuzu. Her kategoride en az 8 soru (toplam 32). Sıra burada
 * sabittir ama dedektife gösterilmez — server tur başına HER kategoriden 3 soru
 * seçip 12'yi karıştırarak round.questionCandidates üretir.
 */
export const korNoktaQuestions: KorNoktaQuestion[] = [
  /* ── Yazı / Alfabe (alphabet) ── */
  { id: "q_sign_clear",         category: "alphabet",     text: "Tabela veya yazı net görünüyor mu?" },
  { id: "q_latin_script",       category: "alphabet",     text: "Latin alfabesi var mı?" },
  { id: "q_nonlatin_script",    category: "alphabet",     text: "Latin dışı alfabe var mı?" },
  { id: "q_east_asian_script",  category: "alphabet",     text: "Yazılar Doğu Asya dili gibi mi?" },
  { id: "q_script_strong",      category: "alphabet",     text: "Yazı/tabela ipucu güçlü mü?" },
  { id: "q_script_letters_clue", category: "alphabet",    text: "Harfler/alfabe konum için belirgin ipucu veriyor mu?" },
  { id: "q_script_navigation",  category: "alphabet",     text: "Tabelalar şehir içi yönlendirme gibi mi?" },
  { id: "q_no_script",          category: "alphabet",     text: "Yazı hiç görünmüyor mu?" },

  /* ── Yol / Trafik (traffic) ── */
  { id: "q_traffic_right",      category: "traffic",      text: "Trafik sağdan akıyor gibi mi?" },
  { id: "q_traffic_left",       category: "traffic",      text: "Trafik soldan akıyor gibi mi?" },
  { id: "q_highway",            category: "traffic",      text: "Otoyol veya geniş ana yol var mı?" },
  { id: "q_road_markings",      category: "traffic",      text: "Yol çizgileri belirgin bir ipucu veriyor mu?" },
  { id: "q_road_europe",        category: "traffic",      text: "Yol çevresi Avrupa düzenine benziyor mu?" },
  { id: "q_road_narrow_local",  category: "traffic",      text: "Yol dar ve yerel/kırsal gibi mi?" },
  { id: "q_vehicles_clue",      category: "traffic",      text: "Araçlar güçlü ipucu veriyor mu?" },
  { id: "q_tidy_layout",        category: "traffic",      text: "Sokak düzeni temiz ve planlı mı?" },

  /* ── Mimari / Şehir dokusu (architecture) ── */
  { id: "q_arch_europe",        category: "architecture", text: "Avrupa mimarisi gibi mi?" },
  { id: "q_modern_city",        category: "architecture", text: "Modern şehir dokusu baskın mı?" },
  { id: "q_village",            category: "architecture", text: "Köy/kasaba havası var mı?" },
  { id: "q_suburb",             category: "architecture", text: "Banliyö hissi var mı?" },
  { id: "q_historic_buildings", category: "architecture", text: "Binalar eski/tarihi doku taşıyor mu?" },
  { id: "q_dense_buildings",    category: "architecture", text: "Binalar yoğun ve bitişik mi?" },
  { id: "q_market_district",    category: "architecture", text: "Dükkan/çarşı dokusu belirgin mi?" },
  { id: "q_touristic",          category: "architecture", text: "Turistik/tarihi çevre hissi var mı?" },

  /* ── Doğa / İklim / Ortam (nature) ── */
  { id: "q_mountainous",        category: "nature",       text: "Dağlık alan hissi var mı?" },
  { id: "q_coastal",            category: "nature",       text: "Deniz/kıyı etkisi hissediliyor mu?" },
  { id: "q_green_forest",       category: "nature",       text: "Yeşil/ormanlık alan baskın mı?" },
  { id: "q_arid_hot",           category: "nature",       text: "Kurak/sıcak iklim gibi mi?" },
  { id: "q_flat_plain",         category: "nature",       text: "Düz ova/polder hissi var mı?" },
  { id: "q_rural_road",         category: "nature",       text: "Kırsal yol gibi mi?" },
  { id: "q_big_city",           category: "nature",       text: "Büyük şehir gibi mi?" },
  { id: "q_motorcycles",        category: "nature",       text: "Motosiklet yoğunluğu dikkat çekiyor mu?" },
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

/**
 * start_game payload'ı: kategori → id[] sözlüğü. Server bu sözlükten her tur
 * kategori başına {KN_QUESTION_PER_CATEGORY} soru çekerek 12 aday üretir.
 * (Önceden düz string[] idi; gizli-kategori dengesi için sözlüğe geçildi.)
 */
export function buildKnQuestionPool(): Record<KnQuestionCategory, string[]> {
  const pool = {
    alphabet:     [] as string[],
    traffic:      [] as string[],
    architecture: [] as string[],
    nature:       [] as string[],
  };
  for (const q of korNoktaQuestions) pool[q.category].push(q.id);
  return pool;
}

/** Dedektifin tur başına seçebileceği soru sayısı. */
export const KN_QUESTION_PICK_COUNT = 5;

/** Server'ın tur başına ürettiği toplam aday soru sayısı (3 × 4 kategori). */
export const KN_QUESTION_CANDIDATE_COUNT = 12;

/** Aday üretiminde kategori başına çekilen soru sayısı. */
export const KN_QUESTION_PER_CATEGORY = 3;

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
