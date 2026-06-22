/**
 * korNoktaQuestions — Kör Nokta soru bankası (gizli-kategori dengeli akış).
 *
 * Dedektif her tur, server'ın ürettiği 20 ADAY soru içinden 5 soru seçer;
 * raporcular/casuslar bu sorulara Evet / Hayır / Emin değilim ile cevap verir.
 * Sorular YALNIZ gözlem/kanıt sorar — hiçbir soru doğrudan ülke/şehir/bölge adı
 * sormaz (spec §soru havuzu).
 *
 * Gizli kategori dengesi: havuz 4 kategoriye ayrılır (alphabet / traffic /
 * architecture / nature; her kategoride 25 soru, toplam 100). Server her tur HER
 * kategoriden EN FAZLA 5 soru çeker (standart sahnede 5×4 = 20); bir kategoride 5
 * uygun soru yoksa hepsi alınır ve eksik kalan aday DİĞER kategorilerden benzersizce
 * doldurulur → toplam DAİMA 20, karışık sıra; game_state'e round.questionCandidates
 * olarak KALICI yazılır. Kategori başlıkları UI'da GÖSTERİLMEZ; dedektif yalnız 20
 * karışık kart görür. Aynı tur içinde (refresh/reconnect) aday seti ve sıra
 * sabittir; yeni turda yeniden üretilir (build_round bir kez random çalışır,
 * sonuç saklanır).
 *
 * Sahne uygunluğu: bazı sorular yalnız gerçek-dünya (Panoramax) sahnelerinde
 * anlamlıdır (modern trafik çizgisi, plaka, marka logosu, gökdelen…); tarihi/AI
 * sahnelerde anlamsızdır. Bu sorular `applicableSourceTypes: ["real_world"]` ile
 * işaretlenir; alan BOŞ ise soru HER iki sahne türünde de geçerlidir. Server tur
 * başına o sahnenin türüne uygun havuzdan aday çeker (build_round per-scene pool);
 * her kategoride her sahne türü için ≥3 uygun soru bulunması (start_game tabanı) ve
 * toplam ≥20 uygun soru bulunması GARANTİDİR. Bu denge bozulmamalı: yeni real-only
 * soru eklerken o kategoride en az 3 evrensel (her iki türe uygun) soru kaldığından,
 * ve historical_ai havuzunda toplam ≥20 soru bulunduğundan emin ol.
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
 * Sahne-özel soru profili: belirli gerçek-dünya sahne türlerinde içerikle
 * uyuşmayan soruları eler (örn. iç mekâna trafik, orman patikasına yoğun şehir,
 * otoyola mimari-detay sorusu DÜŞMESİN). null/undefined = standart (sourceType)
 * havuzu. KRİTİK: her profil HER gizli kategoride ≥3 soru ve TOPLAMDA ≥20 soru
 * BIRAKIR — server build_round (kategori başına ≤5 + eksiği diğer kategorilerden
 * benzersizce doldurup 20'ye tamamlama) ve start_game (3/kategori tabanı) şartları
 * bozulmaz (KN_QUESTION_PROFILE_EXCLUDES setleri bu garantiyle seçildi;
 * korNoktaProfileInvariantOk() doğrular).
 */
export type KnQuestionProfile = "interior_monument" | "forest_path" | "highway" | "open_nature";

export const KN_QUESTION_PROFILES: readonly KnQuestionProfile[] = [
  "interior_monument",
  "forest_path",
  "highway",
  "open_nature",
];

/** Profil → elenecek soru id'leri (yalnız real_world sahnelerde uygulanır). */
export const KN_QUESTION_PROFILE_EXCLUDES: Record<KnQuestionProfile, readonly string[]> = {
  // İç mekân anıt: yol/araç/şerit/plaka/trafik-yönü uygunsuz → traffic'te yalnız
  // yaya-alanı/zemin/düzen kalır (3). Dış-cephe/çatı odaklı yeni mimari kartlar da
  // iç mekânda anlamsız (kemerli geçit/revak HARİÇ — iç mekânda görülebilir).
  // Alphabet (yazıt/tabela iç mekânda okunur) ve nature dokunulmaz.
  interior_monument: [
    "q_road_europe", "q_road_narrow_local", "q_steep_street",
    "q_traffic_right", "q_traffic_left", "q_highway", "q_road_markings",
    "q_vehicles_clue", "q_road_wide_multilane", "q_traffic_signs_modern",
    "q_parked_cars", "q_bike_infra", "q_overhead_wires",
    // yeni trafik (hepsi dış-mekân yol/araç) — iç mekânda anlamsız
    "q_yellow_plates", "q_tram_tracks", "q_double_yellow_lines",
    "q_priority_diamond_sign", "q_reflector_posts", "q_red_white_curbs",
    "q_bus_stop_sign", "q_tuk_tuk", "q_zebra_crossing",
    // yeni mimari dış-cephe/çatı/sokak — iç mekânda görülmez
    "q_red_brick_facades", "q_sloped_tile_roofs", "q_flat_roofs", "q_ac_units",
    "q_ground_floor_shops", "q_walled_compounds", "q_rooftop_water_tanks", "q_raised_houses",
  ],
  // Orman/park/patika: yoğun şehir/metro/gökdelen/çarşı + büyük-şehir + otoyol uygunsuz.
  // Yeni trafik (plaka/ray/şerit/durak/zebra) ve yeni mimari (cephe/çatı/dükkân) de
  // orman patikasında görülmez; doğa kartları (ağaç/zemin/kaya) korunur — burada
  // en zengin kategori odur. Alphabet (patika tabelası) korunur.
  forest_path: [
    "q_modern_city", "q_dense_buildings", "q_highrise", "q_glass_facade", "q_market_district",
    "q_big_city", "q_highway", "q_road_wide_multilane",
    // yeni trafik — orman patikasında yol/araç/şehir öğesi yok
    "q_yellow_plates", "q_tram_tracks", "q_double_yellow_lines",
    "q_priority_diamond_sign", "q_reflector_posts", "q_red_white_curbs",
    "q_bus_stop_sign", "q_tuk_tuk", "q_zebra_crossing",
    // yeni mimari — orman patikasında bina/cephe/çatı yok
    "q_red_brick_facades", "q_sloped_tile_roofs", "q_flat_roofs", "q_ac_units",
    "q_ground_floor_shops", "q_archways_arcades", "q_walled_compounds",
    "q_rooftop_water_tanks", "q_raised_houses",
  ],
  // Otoyol/üst geçit: yerleşim/mimari-detay odaklı uygunsuz → modern-kent/gökdelen/
  // cam-cephe/banliyö/Avrupa-mimari kalır. Otoyolda araç/yol kartları geçerlidir →
  // yalnız kentsel-cadde öğeleri (tramvay rayı/zebra/durak) ve sokak-seviyesi yakın
  // mimari detay (tuğla cephe/kiremit çatı/klima/dükkân/revak) elenir; doğa korunur.
  highway: [
    "q_village", "q_historic_buildings", "q_dense_buildings", "q_market_district",
    "q_touristic", "q_stone_masonry", "q_religious_structure", "q_low_rise",
    "q_monumental", "q_detached_houses", "q_balconies_shutters",
    // yeni trafik — otoyolda yer almayan kentsel-cadde öğeleri
    "q_tram_tracks", "q_zebra_crossing", "q_bus_stop_sign",
    // yeni mimari — otoyoldan görülmeyen sokak-seviyesi yakın detay
    "q_red_brick_facades", "q_sloped_tile_roofs", "q_ac_units",
    "q_ground_floor_shops", "q_archways_arcades",
  ],
  // Açık doğa/saha: yoğun şehir/gökdelen/çarşı/anıt + büyük-şehir + otoyol uygunsuz.
  // Kırsal yoldan geçen araç/levha kartları geçerli kalır → yalnız belirgin kentsel
  // öğeler (tramvay rayı/zebra) ve kentsel-ticari mimari (dükkân/revak/çatı tankı)
  // elenir; doğa kartları korunur (en zengin kategori).
  open_nature: [
    "q_modern_city", "q_dense_buildings", "q_highrise", "q_glass_facade",
    "q_market_district", "q_monumental", "q_big_city", "q_highway", "q_road_wide_multilane",
    // yeni trafik — açık doğada belirgin kentsel-cadde öğesi
    "q_tram_tracks", "q_zebra_crossing",
    // yeni mimari — açık doğada kentsel-ticari/çatı öğesi
    "q_ground_floor_shops", "q_archways_arcades", "q_rooftop_water_tanks",
  ],
};

/**
 * Aktif soru havuzu. Her kategoride 25 soru (toplam 100). Sıra burada
 * sabittir ama dedektife gösterilmez — server tur başına HER kategoriden EN FAZLA
 * 5 soru seçip (eksik kalırsa diğer kategorilerden doldurup) 20'yi karıştırarak
 * round.questionCandidates üretir.
 *
 * Her soru "tek başına coğrafi olasılığı anlamlı daraltır mı?" testini geçer;
 * kategori içinde anlamca kopya/çok-benzer soru YOKTUR (standart turda 20 aday =
 * 4 kategori × 5 olduğundan, kategori-içi tekilsizlik tek turdaki 20 sorunun da
 * çeşitliliğini garantiler). Hiçbir soru ülke/şehir/bölge adı sormaz. `applicableSourceTypes`
 * yoksa soru her iki sahne türünde de geçerlidir; ["real_world"] = yalnız gerçek
 * dünya (modern öğe gerektiren) sorular.
 */
export const korNoktaQuestions: KorNoktaQuestion[] = [
  /* ── Yazı / Alfabe (alphabet) — 25 ── */
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
  // Yalnız gerçek dünya: somut alfabe/karakter aileleri (görünür yazıdan okunur).
  { id: "q_turkish_chars",       category: "alphabet", text: "Yazıda Türkçe karakterler (ç, ğ, ı, ö, ş, ü) seçiliyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_greek_script",        category: "alphabet", text: "Yunanca harfler görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_hangul_script",       category: "alphabet", text: "Kore alfabesi (Hangul) seçiliyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_japanese_kana",       category: "alphabet", text: "Japonca kana/kanji karakterleri görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_scandinavian_chars",  category: "alphabet", text: "Yazıda İskandinav karakterleri (å, ä, ö, æ, ø) seçiliyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_german_sharp_s",      category: "alphabet", text: "Yazıda ß harfi seçiliyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_balkan_latin_chars",  category: "alphabet", text: "Yazıda č, ć, đ, š veya ž gibi Balkan Latin karakterleri seçiliyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_multilingual_signs",  category: "alphabet", text: "Tabelalarda birden fazla dil veya alfabe birlikte mi kullanılmış?", applicableSourceTypes: ["real_world"] },
  { id: "q_right_to_left_script",category: "alphabet", text: "Yazılar sağdan sola okunuyor gibi mi?", applicableSourceTypes: ["real_world"] },

  /* ── Yol / Trafik / Altyapı (traffic) — 25 ── */
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
  // Yalnız gerçek dünya: somut trafik/yol/araç işaretleri.
  { id: "q_yellow_plates",       category: "traffic", text: "Araçlarda sarı plaka görülüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_tram_tracks",         category: "traffic", text: "Yol üzerinde tramvay rayları görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_double_yellow_lines", category: "traffic", text: "Yol kenarında çift sarı çizgi var mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_priority_diamond_sign",category: "traffic", text: "Sarı elmas biçimli bir öncelik levhası görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_reflector_posts",     category: "traffic", text: "Yol kenarında reflektörlü beyaz trafik dikmeleri var mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_red_white_curbs",     category: "traffic", text: "Kaldırım veya yol kenarında kırmızı-beyaz boyalı şeritler var mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_bus_stop_sign",       category: "traffic", text: "Belirgin bir durak tabelası veya toplu taşıma işareti görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_tuk_tuk",             category: "traffic", text: "Üç tekerlekli motorlu araç veya tuk-tuk benzeri araç görülüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_zebra_crossing",      category: "traffic", text: "Belirgin zebra yaya geçidi çizgileri var mı?", applicableSourceTypes: ["real_world"] },

  /* ── Mimari / Yerleşim / Şehir dokusu (architecture) — 25 ── */
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
  // Yalnız gerçek dünya: somut yapı/çatı/cephe öğeleri.
  { id: "q_red_brick_facades",   category: "architecture", text: "Kırmızı tuğlalı bina cepheleri belirgin mi?", applicableSourceTypes: ["real_world"] },
  { id: "q_sloped_tile_roofs",   category: "architecture", text: "Eğimli/kiremit çatılı yapılar baskın mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_flat_roofs",          category: "architecture", text: "Düz çatılı açık renkli yapılar baskın mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_ac_units",            category: "architecture", text: "Bina cephelerinde dış klima üniteleri yaygın mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_ground_floor_shops",  category: "architecture", text: "Binaların zemin katlarında dükkânlar baskın mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_archways_arcades",    category: "architecture", text: "Kemerli geçitler veya revaklı yapılar görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_walled_compounds",    category: "architecture", text: "Yüksek duvarlı ve kapılı müstakil yapılar baskın mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_rooftop_water_tanks", category: "architecture", text: "Çatılarda su depoları veya büyük tanklar görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_raised_houses",       category: "architecture", text: "Yerden yükseltilmiş veya ayaklar üzerinde yapılar görünüyor mu?", applicableSourceTypes: ["real_world"] },

  /* ── Doğa / İklim / Ortam (nature) — 25 ── */
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
  // Yalnız gerçek dünya: somut bitki örtüsü/zemin/iklim izleri.
  { id: "q_conifer_trees",       category: "nature", text: "İğne yapraklı ağaçlar baskın mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_mediterranean_scrub", category: "nature", text: "Akdeniz tipi kuru çalılar veya makilik bitki örtüsü var mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_autumn_foliage",      category: "nature", text: "Ağaçlarda sonbahar renkleri belirgin mi?", applicableSourceTypes: ["real_world"] },
  { id: "q_volcanic_dark_rock",  category: "nature", text: "Koyu volkanik kaya veya zemin görünümü var mı?", applicableSourceTypes: ["real_world"] },
  { id: "q_desert_sand",         category: "nature", text: "Kumlu, tozlu veya çöl benzeri açık alanlar görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_rice_fields",         category: "nature", text: "Pirinç tarlası veya suyla bölünmüş tarım alanları görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_large_tropical_leaves",category: "nature", text: "Muz yaprağı gibi büyük tropik yapraklar görünüyor mu?", applicableSourceTypes: ["real_world"] },
  { id: "q_leafless_trees",      category: "nature", text: "Yapraklarını dökmüş ağaçlar belirgin mi?", applicableSourceTypes: ["real_world"] },
  { id: "q_rocky_cliffs",        category: "nature", text: "Kayalık yamaçlar veya sarp kaya oluşumları görünüyor mu?", applicableSourceTypes: ["real_world"] },
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
 * Belirli bir sahne türüne (+ opsiyonel sahne profiline) UYGUN kategori → id[]
 * havuzu. start_game her sahne payload'ına bunu ekler; server build_round o
 * sahnenin havuzundan kategori başına ≤5 aday çekip eksiği diğer kategorilerden
 * doldurarak 20'ye tamamlar → tarihi/AI sahneye modern-trafik, iç mekâna yol,
 * ormana yoğun-şehir sorusu DÜŞMEZ. Tasarım gereği her kategoride (profil elemesi
 * sonrası dahi) ≥3 uygun soru ve toplamda ≥20 uygun soru kalır (server şartı).
 */
export function buildKnQuestionPoolFor(
  sourceType: KnSceneSourceType,
  profile?: KnQuestionProfile | null,
): Record<KnQuestionCategory, string[]> {
  const excluded = profile ? new Set(KN_QUESTION_PROFILE_EXCLUDES[profile]) : null;
  const pool = emptyPool();
  for (const q of korNoktaQuestions) {
    if (!isKnQuestionApplicable(q, sourceType)) continue;
    if (excluded && excluded.has(q.id)) continue;
    pool[q.category].push(q.id);
  }
  return pool;
}

/**
 * Güvenlik ağı: server build_round'un her (sahne türü + profil) havuzundan tam
 * KN_QUESTION_CANDIDATE_COUNT (20) aday üretebildiğini doğrular. İki şart:
 *   (a) toplam uygun soru ≥ 20 — kategori başına ≤5 alınıp eksik diğer
 *       kategorilerden benzersizce doldurularak 20'ye ulaşılır;
 *   (b) her kategoride ≥3 uygun soru — server start_game sanitizasyon tabanı
 *       (bunun altındaki havuz reddedilir).
 * false dönerse bir profil ELEMESİ aşırı agresiftir. Testte/DEV'de çağrılır;
 * üretim yolunu yavaşlatmaz.
 */
export function korNoktaProfileInvariantOk(): boolean {
  const check = (pool: Record<KnQuestionCategory, string[]>) => {
    const total = KN_QUESTION_CATEGORIES.reduce((n, c) => n + pool[c].length, 0);
    return (
      total >= KN_QUESTION_CANDIDATE_COUNT &&
      KN_QUESTION_CATEGORIES.every((c) => pool[c].length >= KN_QUESTION_MIN_PER_CATEGORY)
    );
  };
  if (!check(buildKnQuestionPoolFor("historical_ai"))) return false;
  if (!check(buildKnQuestionPoolFor("real_world"))) return false;
  return KN_QUESTION_PROFILES.every((p) => check(buildKnQuestionPoolFor("real_world", p)));
}

/** Dedektifin tur başına seçebileceği (kilitlediği) soru sayısı. */
export const KN_QUESTION_PICK_COUNT = 5;

/** Server'ın tur başına ürettiği toplam aday soru sayısı (standart: 5 × 4 kategori). */
export const KN_QUESTION_CANDIDATE_COUNT = 20;

/**
 * Aday üretiminde kategori başına çekilen ÜST sınır. Kategoride bu kadar uygun
 * soru yoksa (profilli sahne) hepsi alınır; eksik kalan aday DİĞER kategorilerin
 * sorularıyla benzersizce doldurulur (toplam KN_QUESTION_CANDIDATE_COUNT'a tamamlanır).
 */
export const KN_QUESTION_PER_CATEGORY_CAP = 5;

/**
 * Bir kategorinin geçerli sayılması için gereken minimum uygun soru sayısı
 * (server start_game sanitizasyon tabanı; bunun altındaki havuz reddedilir).
 */
export const KN_QUESTION_MIN_PER_CATEGORY = 3;

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
