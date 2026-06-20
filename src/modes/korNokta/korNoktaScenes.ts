// Kör Nokta sahne havuzu.
// Görseller: public/assets/history/kor-nokta/ (4096x2048 equirectangular 360 panorama, PNG).
// bannedWords: anlatıcının kullanamayacağı kelimeler. Listeler Türkçe karakterli ve
// karaktersiz varyasyonları birlikte içerir (örn. "türkiye" + "turkiye").
// Karşılaştırma yapılırken girdinin normalize edilmesi beklenir:
// lowercase + Türkçe karakter sadeleştirme (ı->i, ç->c, ş->s, ğ->g, ö->o, ü->u)
// + boşluk/tire temizliği ("t r", "t-r" -> "tr"). Bu sayede "tr" gibi kısa
// yasaklılar da kaçaklarıyla birlikte yakalanır.

/** Sahne kaynağı: AI üretimi tarihi sahne mi, açık-lisanslı gerçek dünya 360 mı. */
export type KorNoktaSceneSource = "panoramax" | "mapillary";

/** Gerçek dünya sahneleri için lisans/atıf bilgisi (real_world'de zorunlu). */
export interface KorNoktaAttribution {
  source: KorNoktaSceneSource;
  sourceImageId: string;
  author: string;
  attributionUrl: string;
  license: string;       // ör. "CC-BY-SA 4.0"
  licenseUrl?: string;
  captureDate?: string;  // ISO yyyy-mm-dd
  modified?: boolean;    // görsel resize/yeniden encode edildiyse true
}

export type KorNoktaScene = {
  id: string;
  title: string;
  shortTitle: string;
  imagePath: string;
  location: {
    lat: number;
    lng: number;
  };
  yearLabel: string;
  regionLabel: string;
  /**
   * Kısa ülke anahtarı (ISO-2 gibi: "tr", "fr", "jp"…). Sahne planında ardışık
   * aynı-ülke tekrarını engellemek için kullanılır (knSceneCountry). Gerçek
   * sahnelerde codegen verir; tarihi sahnelerde elle. Boşsa knSceneCountry
   * id öneki / regionLabel'dan türetir (güvenli fallback).
   */
  countryKey?: string;
  difficulty: "easy" | "normal" | "hard";
  categories: Array<"geography" | "architecture" | "people" | "period">;
  bannedWords: string[];
  notes?: string;
  /** undefined => "historical_ai" (mevcut AI sahneleri). */
  sourceType?: "historical_ai" | "real_world";
  /** Yalnız real_world sahnelerde dolu; viewer köşesinde atıf badge'i render eder. */
  attribution?: KorNoktaAttribution;
};

export const korNoktaScenes: KorNoktaScene[] = [
  {
    id: "kn_001_colosseum_duel_rome",
    title: "Kolezyum'da Gladyatör Düellosu",
    shortTitle: "Kolezyum",
    imagePath: "/assets/history/kor-nokta/kn_001_colosseum_duel_rome_360.png",
    location: {
      lat: 41.8902,
      lng: 12.4922,
    },
    yearLabel: "Roma İmparatorluğu Dönemi",
    regionLabel: "Roma, İtalya",
    countryKey: "it",
    difficulty: "easy",
    categories: ["architecture", "people", "period"],
    bannedWords: [
      "roma",
      "rome",
      "italy",
      "italya",
      "italyan",
      "kolezyum",
      "colosseum",
      "coliseum",
      "kolosseum",
      "gladyatör",
      "gladyator",
      "gladiator",
      "arena",
      "imparatorluk",
      "imparator",
      "roman",
      "romalı",
      "romali",
    ],
    notes:
      "Çok tanınır bir yapı; anlatıcı için asıl zorluk yasaklı kelimelere takılmadan tarif etmek.",
  },
  {
    id: "kn_002_ankara_battle_cubuk_1402",
    title: "Ankara Savaşı: Timur ve Osmanlı Orduları Karşı Karşıya",
    shortTitle: "Ankara 1402",
    imagePath: "/assets/history/kor-nokta/kn_002_ankara_battle_cubuk_1402_360.png",
    location: {
      lat: 40.238,
      lng: 33.032,
    },
    yearLabel: "1402",
    regionLabel: "Çubuk Ovası, Ankara",
    countryKey: "tr",
    difficulty: "hard",
    categories: ["geography", "people", "period"],
    bannedWords: [
      "ankara",
      "çubuk",
      "cubuk",
      "çubuk ovası",
      "cubuk ovasi",
      "türkiye",
      "turkiye",
      "turkey",
      "tr",
      "anadolu",
      "osmanlı",
      "osmanli",
      "ottoman",
      "timur",
      "timurlu",
      "tamerlane",
      "bayezid",
      "bayezit",
      "beyazıt",
      "beyazit",
      "yıldırım",
      "yildirim",
    ],
    notes:
      "Açık ova sahnesi; görselde yeri ele veren mimari öğe yok, tahmin dönem ve ordu detaylarına dayanır.",
  },
  {
    id: "kn_003_giza_pyramid_construction",
    title: "Giza'da Piramit İnşası",
    shortTitle: "Piramit İnşası",
    imagePath: "/assets/history/kor-nokta/kn_003_giza_pyramid_construction_360.png",
    location: {
      lat: 29.9792,
      lng: 31.1342,
    },
    yearLabel: "Eski Krallık (MÖ ~2500)",
    regionLabel: "Giza Platosu, Mısır",
    countryKey: "eg",
    difficulty: "easy",
    categories: ["architecture", "geography", "period"],
    bannedWords: [
      "mısır",
      "misir",
      "egypt",
      "egyptian",
      "giza",
      "gize",
      "gizeh",
      "kahire",
      "cairo",
      "piramit",
      "piramid",
      "pyramid",
      "pyramids",
      "firavun",
      "pharaoh",
      "nil",
      "nile",
      "kheops",
      "keops",
      "khufu",
      "sfenks",
      "sphinx",
    ],
  },
  {
    id: "kn_004_pompeii_daily_life",
    title: "Pompeii'de Günlük Yaşam",
    shortTitle: "Pompeii",
    imagePath: "/assets/history/kor-nokta/kn_004_pompeii_daily_life_360.png",
    location: {
      lat: 40.7497,
      lng: 14.4869,
    },
    yearLabel: "MS 1. yüzyıl (Roma Dönemi)",
    regionLabel: "Pompeii, Campania, İtalya",
    countryKey: "it",
    difficulty: "normal",
    categories: ["people", "architecture", "period"],
    bannedWords: [
      "pompeii",
      "pompei",
      "pompey",
      "pompeji",
      "italya",
      "italy",
      "italyan",
      "roma",
      "rome",
      "roman",
      "campania",
      "kampanya",
      "napoli",
      "naples",
      "vezüv",
      "vezuv",
      "vesuvius",
    ],
    notes:
      "Patlama öncesi sıradan bir gün; arka plandaki yanardağ silüeti en güçlü görsel ipucu.",
  },
  {
    id: "kn_005_viking_village_kaupang",
    title: "Viking Köyünde Hayat",
    shortTitle: "Viking Köyü",
    imagePath: "/assets/history/kor-nokta/kn_005_viking_village_kaupang_360.png",
    location: {
      lat: 59.041,
      lng: 10.038,
    },
    yearLabel: "Viking Çağı (800-1000)",
    regionLabel: "Kaupang, Norveç",
    countryKey: "no",
    difficulty: "hard",
    categories: ["geography", "people", "period"],
    bannedWords: [
      "viking",
      "vikingler",
      "norveç",
      "norvec",
      "norway",
      "norsk",
      "norse",
      "scandinavia",
      "skandinavya",
      "skandinav",
      "iskandinav",
      "iskandinavya",
      "kaupang",
      "longhouse",
      "uzun ev",
      "odin",
      "thor",
      "fjord",
      "fiyort",
    ],
    notes:
      "Konum referansı Kaupang ticaret yerleşimi; jenerik bir köy sahnesi olduğundan nokta tahmini zordur.",
  },
  {
    id: "kn_006_socrates_trial_athens",
    title: "Sokrates'in Yargılanması",
    shortTitle: "Sokrates",
    imagePath: "/assets/history/kor-nokta/kn_006_socrates_trial_athens_360.png",
    location: {
      lat: 37.9755,
      lng: 23.7221,
    },
    yearLabel: "MÖ 399",
    regionLabel: "Antik Agora, Atina",
    countryKey: "gr",
    difficulty: "normal",
    categories: ["people", "architecture", "period"],
    bannedWords: [
      "sokrates",
      "sokrat",
      "socrates",
      "atina",
      "athens",
      "yunanistan",
      "greece",
      "greek",
      "yunan",
      "antik yunan",
      "agora",
      "akropolis",
      "akropol",
      "acropolis",
      "platon",
      "plato",
      "baldıran",
      "baldiran",
      "hemlock",
    ],
  },
  {
    id: "kn_007_paris_street_pre_car_1880s",
    title: "1880'ler Paris Sokakları: Otomobil Öncesi Şehir Yaşamı",
    shortTitle: "Paris 1880'ler",
    imagePath: "/assets/history/kor-nokta/kn_007_paris_street_pre_car_1880s_360.png",
    location: {
      lat: 48.8566,
      lng: 2.3522,
    },
    yearLabel: "1880'ler",
    regionLabel: "Paris, Fransa",
    countryKey: "fr",
    difficulty: "normal",
    categories: ["people", "architecture", "period"],
    bannedWords: [
      "paris",
      "fransa",
      "france",
      "french",
      "fransız",
      "fransiz",
      "avrupa",
      "europe",
      "eiffel",
      "eyfel",
      "araba",
      "otomobil",
      "oto",
      "car",
      "modern araba",
      "seine",
      "sen nehri",
      "notre dame",
      "louvre",
      "luvr",
    ],
    notes:
      "Çağ dışı nesne: sahnede modern bir araba var. Kör Nokta'da şu an nesne bulma mekaniği yok; ileride 'çağ dışı nesneyi bul' varyantı için ayrılmıştır. Araba ile ilgili kelimeler bu yüzden yasaklıdır.",
  },
  {
    id: "kn_008_lindisfarne_viking_raid_793",
    title: "Lindisfarne Baskını: Vikingler Savaşa Hazırlanıyor",
    shortTitle: "Lindisfarne 793",
    imagePath: "/assets/history/kor-nokta/kn_008_lindisfarne_viking_raid_793_360.png",
    location: {
      lat: 55.6697,
      lng: -1.802,
    },
    yearLabel: "793",
    regionLabel: "Lindisfarne (Holy Island), İngiltere",
    countryKey: "gb",
    difficulty: "hard",
    categories: ["geography", "people", "period"],
    bannedWords: [
      "lindisfarne",
      "holy island",
      "kutsal ada",
      "northumberland",
      "ingiltere",
      "england",
      "britain",
      "britanya",
      "viking",
      "vikingler",
      "norse",
      "iskandinav",
      "iskandinavya",
      "raid",
      "baskın",
      "baskin",
      "manastır",
      "manastir",
      "monastery",
      "keşiş",
      "kesis",
      "monk",
      "drakkar",
    ],
    notes:
      "Viking Çağı'nın başlangıcı sayılan 793 baskını; kıyı ve manastır silüeti başlıca görsel ipuçları.",
  },
];
