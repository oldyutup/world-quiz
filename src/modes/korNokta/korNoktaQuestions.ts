/**
 * korNoktaQuestions — Kör Nokta soru bankası (gizli-kategori dengeli akış).
 *
 * Dedektif her tur, server'ın ürettiği 12 ADAY soru içinden 5 soru seçer;
 * raporcular/casuslar bu sorulara Evet / Hayır / Emin değilim ile cevap verir.
 * Sorular YALNIZ gözlem/kanıt sorar — hiçbir soru doğrudan ülke/şehir/bölge adı
 * sormaz (spec §soru havuzu).
 *
 * Gizli kategori dengesi: havuz 4 kategoriye ayrılır (alphabet / traffic /
 * architecture / nature; her kategoride ≥16 soru, toplam ≥64). Server her tur HER
 * kategoriden 3 soru çekip 12'yi karıştırır ve game_state'e round.questionCandidates
 * olarak KALICI yazar. Kategori başlıkları UI'da GÖSTERİLMEZ; dedektif yalnız 12
 * karışık kart görür. Aynı tur içinde (refresh/reconnect) aday seti ve sıra
 * sabittir; yeni turda yeniden üretilir (build_round bir kez random çalışır,
 * sonuç saklanır).
 *
 * Sahne uygunluğu: bazı sorular yalnız gerçek-dünya (Panoramax) sahnelerinde
 * anlamlıdır (modern trafik çizgisi, plaka, marka logosu, gökdelen…); tarihi/AI
 * sahnelerde anlamsızdır. Bu sorular `applicableSourceTypes: ["real_world"]` ile
 * işaretlenir; alan BOŞ ise soru HER iki sahne türünde de geçerlidir. Server tur
 * başına o sahnenin türüne uygun havuzdan aday çeker (build_round per-scene pool);
 * her kategoride her sahne türü için ≥3 uygun soru bulunması GARANTİDİR (server
 * 3/kategori ister). Bu denge bozulmamalı: yeni real-only soru eklerken o
 * kategoride en az 3 evrensel (her iki türe uygun) soru kaldığından emin ol.
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

/**
 * Sahne kaynağı türü (korNoktaScenes.ts KorNoktaScene.sourceType ile uyumlu).
 * undefined sahne = "historical_ai" (mevcut AI/tarihi sahneler) sayılır.
 */
export type KnSceneSourceType = "historical_ai" | "real_world";

export interface KorNoktaQuestion {
  id: string;
  text: string;
  /** Gizli kategori — server denge için kullanır; kullanıcıya gösterilmez. */
  category: KnQuestionCategory;
  /**
   * Sorunun anlamlı olduğu sahne türleri. BOŞ/undefined = her iki türde de
   * geçerli (varsayılan). ["real_world"] = yalnız gerçek-dünya sahnelerinde
   * (modern trafik/levha/araç/marka gibi); tarihi/AI sahnelere ASLA düşmez.
   */
  applicableSourceTypes?: KnSceneSourceType[];
}

/** Bir sorunun verilen sahne türünde gösterilebilir olup olmadığı. */
export function isKnQuestionApplicable(
  q: KorNoktaQuestion,
  sourceType: KnSceneSourceType,
): boolean {
  const apt = q.applicableSourceTypes;
  if (!apt || apt.length === 0) return true; // evrensel (her iki tür)
  return apt.includes(sourceType);
}

/**
 * Aktif soru havuzu. Her kategoride en az 16 soru (toplam 64). Sıra burada
 * sabittir ama dedektife gösterilmez — server tur başına HER kategoriden 3 soru
 * seçip 12'yi karıştırarak round.questionCandidates üretir.
 *
 * Her soru "tek başına coğrafi olasılığı anlamlı daraltır mı?" testini geçer;
 * kategori içinde anlamca kopya/çok-benzer soru YOKTUR (12 aday = 4 kategori × 3
 * olduğundan, kategori-içi tekilsizlik tek turdaki 12 sorunun da çeşitliliğini
 * garantiler). Hiçbir soru ülke/şehir/bölge adı sormaz. `applicableSourceTypes`
 * yoksa soru her iki sahne türünde de geçerlidir; ["real_world"] = yalnız gerçek
 * dünya (modern öğe gerektiren) sorular.
 */
export const korNoktaQuestions: KorNoktaQuestion[] = [
  /* ── Yazı / Alfabe (alphabet) — 16 ── */
  // Evrensel (tarihi + gerçek): görünür yazının varlığı/türü/yönü.
  { id: "q_sign_clear",          category: "alphabet", text: "Tabela veya yazı net görünüyor mu?" },
  { id: "q_no_script",           category: "alphabet", text: "Yazı hiç görünmüyor mu?" },
  { id: "q_script_strong",       category: "alphabet", text: "Yazı/tabela ipucu güçlü mü?" },
  { id: "q_script_letters_clue", category: "alphabet", text: "Harfler/alfabe konum için belirgin ipucu veriyor mu?" },
  { id: "q_latin_script",        category: "alphabet", text: "Latin alfabesi var mı?" },
  { id: "q_nonlatin_script",     category: "alphabet", text: "Latin dışı alfabe var mı?" },
  { id: "q_east_asian_script",   category: "alphabet", text: "Yazılar Doğu Asya dili gibi mi (Çince/Japonca/Korece)?" },
  { id: "q_script_arabic",       category: "alphabet", text: "Arap harfleri/yazısı görünüyor mu?" },
  { id: "q_script_cyrillic",     category: "alphabet", text: "Kiril harfleri görünüyor mu?" },
  { id: "q_script_devanagari",   category: "alphabet", text: "Hint (Devanagari) türü yazı görünüyor mu?" },
  { id: "q_script_handpainted",  category: "alphabet", text: "Yazılar oyma/kabartma/el yapımı gibi mi (matbu değil)?" },
  // Yalnız gerçek dünya: modern tabela/levha/marka/plaka.
  { id: "q_script_navigation",   category: "alphabet", text: "Tabelalar modern şehir içi yönlendirme gibi mi?", applicableSourceTypes: ["real_world"] },
  { id: "q_storefront_text",     category: "alphabet", text: "Dükkan/mağaza tabelaları yoğun mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_script_diacritics",   category: "alphabet", text: "Yazıda aksanlı Latin harfler (ç, ñ, ü) seçiliyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_digits_visible",      category: "alphabet", text: "Plaka/numara gibi rakamlar görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_script_brandlatin",   category: "alphabet", text: "Uluslararası marka/Latin logolar görünüyor mu?", applicableSourceTypes: ["real_world"] },

  /* ── Yol / Trafik / Altyapı (traffic) — 16 ── */
  // Evrensel: yol/zemin biçimi, eğim, yaya alanı, yerleşim ölçeği.
  { id: "q_road_europe",         category: "traffic", text: "Yol çevresi Avrupa düzenine benziyor mu?" },
  { id: "q_road_narrow_local",   category: "traffic", text: "Yol dar ve yerel/kırsal gibi mi?" },
  { id: "q_tidy_layout",         category: "traffic", text: "Sokak düzeni temiz ve planlı mı?" },
  { id: "q_road_unpaved",        category: "traffic", text: "Zemin toprak, taş veya parke gibi mi?" },
  { id: "q_steep_street",        category: "traffic", text: "Sokak belirgin eğimli (yokuş) mu?" },
  { id: "q_path_pedestrian",     category: "traffic", text: "Araç yolu değil, yaya alanı/meydan gibi mi?" },
  // Yalnız gerçek dünya: modern trafik öğeleri.
  { id: "q_traffic_right",       category: "traffic", text: "Trafik sağdan akıyor gibi mi?", applicableSourceTypes: ["real_world"] },
  { id: "q_traffic_left",        category: "traffic", text: "Trafik soldan akıyor gibi mi?", applicableSourceTypes: ["real_world"] },
  { id: "q_highway",             category: "traffic", text: "Otoyol veya geniş ana yol var mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_road_markings",       category: "traffic", text: "Yol çizgileri belirgin bir ipucu veriyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_vehicles_clue",       category: "traffic", text: "Araçlar güçlü ipucu veriyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_road_wide_multilane", category: "traffic", text: "Yol çok şeritli/geniş mi?", applicableSourceTypes: ["real_world"] },
  { id: "q_traffic_signs_modern",category: "traffic", text: "Modern trafik levhası/sinyalizasyon var mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_parked_cars",         category: "traffic", text: "Park etmiş araçlar diziliyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_bike_infra",          category: "traffic", text: "Bisiklet yolu/şeridi görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_overhead_wires",      category: "traffic", text: "Havai elektrik/tramvay telleri görünüyor mu?", applicableSourceTypes: ["real_world"] },

  /* ── Mimari / Yerleşim / Şehir dokusu (architecture) — 16 ── */
  // Evrensel: malzeme, yoğunluk, ölçek, yapı tipi, çağ dokusu.
  { id: "q_arch_europe",         category: "architecture", text: "Avrupa mimarisi gibi mi?" },
  { id: "q_village",             category: "architecture", text: "Köy/kasaba havası var mı?" },
  { id: "q_historic_buildings",  category: "architecture", text: "Binalar eski/tarihi doku taşıyor mu?" },
  { id: "q_dense_buildings",     category: "architecture", text: "Binalar yoğun ve bitişik mi?" },
  { id: "q_market_district",     category: "architecture", text: "Dükkan/çarşı dokusu belirgin mi?" },
  { id: "q_touristic",           category: "architecture", text: "Turistik/tarihi çevre hissi var mı?" },
  { id: "q_stone_masonry",       category: "architecture", text: "Binalar taş/yığma malzemeden mi?" },
  { id: "q_religious_structure", category: "architecture", text: "Dini yapı (kilise, cami, tapınak, kule) görünüyor mu?" },
  { id: "q_low_rise",            category: "architecture", text: "Binalar alçak (1-2 katlı) mı?" },
  { id: "q_monumental",          category: "architecture", text: "Anıtsal/görkemli büyük yapı(lar) var mı?" },
  // Yalnız gerçek dünya: modern kentsel doku.
  { id: "q_modern_city",         category: "architecture", text: "Modern şehir dokusu baskın mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_suburb",              category: "architecture", text: "Banliyö hissi var mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_highrise",            category: "architecture", text: "Çok katlı yüksek binalar/gökdelenler var mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_glass_facade",        category: "architecture", text: "Cam/çelik cepheli modern binalar var mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_detached_houses",     category: "architecture", text: "Müstakil/bahçeli evler baskın mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_balconies_shutters",  category: "architecture", text: "Cephelerde balkon/panjur gibi konut detayları var mı?", applicableSourceTypes: ["real_world"] },

  /* ── Doğa / İklim / Ortam (nature) — 16 ── */
  // Evrensel: arazi, iklim, bitki örtüsü, su, açıklık. (İklim/arazi soruları
  // birbirinin kopyası DEĞİL — her biri farklı bir bölge kümesini eler.)
  { id: "q_mountainous",         category: "nature", text: "Dağlık alan hissi var mı?" },
  { id: "q_hilly_terrain",       category: "nature", text: "Arazi tepelik/engebeli mi?" },
  { id: "q_flat_plain",          category: "nature", text: "Düz ova/polder hissi var mı?" },
  { id: "q_coastal",             category: "nature", text: "Deniz/kıyı etkisi hissediliyor mu?" },
  { id: "q_river_canal",         category: "nature", text: "Nehir, kanal veya su yolu görünüyor mu?" },
  { id: "q_green_forest",        category: "nature", text: "Yeşil/ormanlık alan baskın mı?" },
  { id: "q_street_greenery",     category: "nature", text: "Çevrede/sokakta bol ağaç var mı?" },
  { id: "q_tropical_vegetation", category: "nature", text: "Palmiye/tropik bitki örtüsü var mı?" },
  { id: "q_humid_lush",          category: "nature", text: "Ortam nemli ve gür yeşil mi?" },
  { id: "q_arid_hot",            category: "nature", text: "Kurak/sıcak iklim gibi mi?" },
  { id: "q_snow_cold",           category: "nature", text: "Kar veya soğuk iklim izi var mı?" },
  { id: "q_overcast",            category: "nature", text: "Hava kapalı/bulutlu mu?" },
  { id: "q_open_horizon",        category: "nature", text: "Yapılar az, açık ufuk/boşluk baskın mı?" },
  { id: "q_rural_road",          category: "nature", text: "Kırsal/taşra ortamı gibi mi?" },
  { id: "q_big_city",            category: "nature", text: "Büyük şehir gibi mi?" },
  // Yalnız gerçek dünya: motorlu araç yoğunluğu.
  { id: "q_motorcycles",         category: "nature", text: "Motosiklet/scooter yoğunluğu dikkat çekiyor mu?", applicableSourceTypes: ["real_world"] },
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

function emptyPool(): Record<KnQuestionCategory, string[]> {
  return { alphabet: [], traffic: [], architecture: [], nature: [] };
}

/**
 * start_game payload'ı: kategori → id[] sözlüğü (TÜM havuz, sahne türü farketmez).
 * Server bu GLOBAL sözlüğü, sahnenin kendi havuzu yoksa fallback olarak kullanır.
 * (Önceden düz string[] idi; gizli-kategori dengesi için sözlüğe geçildi.)
 */
export function buildKnQuestionPool(): Record<KnQuestionCategory, string[]> {
  const pool = emptyPool();
  for (const q of korNoktaQuestions) pool[q.category].push(q.id);
  return pool;
}

/**
 * Belirli bir sahne türüne UYGUN kategori → id[] havuzu. start_game her sahne
 * payload'ına bunu ekler; server build_round o sahnenin türüne uygun havuzdan
 * 3/kategori aday çeker → tarihi/AI sahneye modern-trafik sorusu DÜŞMEZ. Tasarım
 * gereği her kategoride her sahne türü için ≥3 uygun soru kalır (server şartı).
 */
export function buildKnQuestionPoolFor(
  sourceType: KnSceneSourceType,
): Record<KnQuestionCategory, string[]> {
  const pool = emptyPool();
  for (const q of korNoktaQuestions) {
    if (isKnQuestionApplicable(q, sourceType)) pool[q.category].push(q.id);
  }
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
