/**
 * Conquest (Kuşatma) — Phase 9A static challenge bank.
 *
 * 60 hand-authored entries across three families: quiz, type_race, flag_guess.
 * Each entry has a stable `id` used by the anti-repetition tracker in
 * conquestGameplay.ts so the same question never appears twice in a match
 * as long as the bank has enough unused entries.
 *
 * Runtime answer comparison goes through `conquestChallengeValidation` which
 * handles trimming, casing, and Turkish diacritic tolerance.
 *
 * No React, no Supabase — pure data.  Pickers are called only by the host
 * client; the selected challenge is stored in gameplay_state so every other
 * client renders the same payload.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Quiz — short geography Q&A with optional multiple-choice
// ─────────────────────────────────────────────────────────────────────────────

export interface QuizBankEntry {
  id:               string;
  prompt:           string;
  /** When present, UI renders choice buttons instead of a text input. */
  choices?:         string[];
  /** All forms that should validate as correct.  Case / diacritic insensitive. */
  acceptedAnswers:  string[];
}

export const CONQUEST_QUIZ_BANK: QuizBankEntry[] = [
  {
    id: "q01",
    prompt:          "Türkiye'nin başkenti hangi şehirdir?",
    choices:         ["Ankara", "İstanbul", "İzmir", "Bursa"],
    acceptedAnswers: ["Ankara"],
  },
  {
    id: "q02",
    prompt:          "Almanya'nın başkenti neresidir?",
    choices:         ["Berlin", "Münih", "Hamburg", "Frankfurt"],
    acceptedAnswers: ["Berlin"],
  },
  {
    id: "q03",
    prompt:          "Japonya'nın başkenti neresidir?",
    choices:         ["Tokyo", "Osaka", "Kyoto", "Seul"],
    acceptedAnswers: ["Tokyo", "Tokio"],
  },
  {
    id: "q04",
    prompt:          "İtalya'nın başkenti neresidir?",
    choices:         ["Roma", "Milano", "Napoli", "Venedik"],
    acceptedAnswers: ["Roma", "Rome"],
  },
  {
    id: "q05",
    prompt:          "Mısır'ın başkenti neresidir?",
    choices:         ["Kahire", "İskenderiye", "Lüksor", "Asvan"],
    acceptedAnswers: ["Kahire", "Cairo"],
  },
  {
    id: "q06",
    prompt:          "Avustralya'nın başkenti neresidir?",
    choices:         ["Canberra", "Sidney", "Melbourne", "Perth"],
    acceptedAnswers: ["Canberra"],
  },
  {
    id: "q07",
    prompt:          "Brezilya'nın başkenti neresidir?",
    choices:         ["Brasilia", "Rio de Janeiro", "São Paulo", "Salvador"],
    acceptedAnswers: ["Brasilia", "Brasília"],
  },
  {
    id: "q08",
    prompt:          "Kanada'nın başkenti neresidir?",
    choices:         ["Ottawa", "Toronto", "Montreal", "Vancouver"],
    acceptedAnswers: ["Ottawa"],
  },
  {
    id: "q09",
    prompt:          "Hangi kıta en kalabalık nüfusa sahiptir?",
    choices:         ["Asya", "Afrika", "Avrupa", "Amerika"],
    acceptedAnswers: ["Asya", "Asia"],
  },
  {
    id: "q10",
    prompt:          "Dünyanın en uzun nehri hangisidir?",
    choices:         ["Nil", "Amazon", "Yangtze", "Mississippi"],
    acceptedAnswers: ["Nil", "Nile"],
  },
  {
    id: "q11",
    prompt:          "Everest Dağı hangi sıradağda yer alır?",
    choices:         ["Himalayalar", "Alpler", "Andlar", "Karpatlar"],
    acceptedAnswers: ["Himalayalar", "Himalaya", "Himalayas"],
  },
  {
    id: "q12",
    prompt:          "Türkiye'nin en büyük gölü hangisidir?",
    choices:         ["Van Gölü", "Tuz Gölü", "Beyşehir Gölü", "Eğirdir Gölü"],
    acceptedAnswers: ["Van Gölü", "Van"],
  },
  {
    id: "q13",
    prompt:          "Fransa'nın başkenti neresidir?",
    choices:         ["Paris", "Lyon", "Marsilya", "Nice"],
    acceptedAnswers: ["Paris"],
  },
  {
    id: "q14",
    prompt:          "Rusya'nın başkenti neresidir?",
    choices:         ["Moskova", "St. Petersburg", "Novosibirsk", "Vladivostok"],
    acceptedAnswers: ["Moskova", "Moscow"],
  },
  {
    id: "q15",
    prompt:          "Amerika Birleşik Devletleri'nin başkenti neresidir?",
    choices:         ["Washington D.C.", "New York", "Los Angeles", "Chicago"],
    acceptedAnswers: ["Washington D.C.", "Washington", "Washington DC"],
  },
  {
    id: "q16",
    prompt:          "Çin'in başkenti neresidir?",
    choices:         ["Pekin", "Şangay", "Hong Kong", "Guangzhou"],
    acceptedAnswers: ["Pekin", "Beijing"],
  },
  {
    id: "q17",
    prompt:          "Hindistan'ın başkenti neresidir?",
    choices:         ["Yeni Delhi", "Mumbai", "Kolkata", "Chennai"],
    acceptedAnswers: ["Yeni Delhi", "Delhi", "New Delhi"],
  },
  {
    id: "q18",
    prompt:          "İspanya'nın başkenti neresidir?",
    choices:         ["Madrid", "Barselona", "Sevilla", "Valencia"],
    acceptedAnswers: ["Madrid"],
  },
  {
    id: "q19",
    prompt:          "Arjantin'in başkenti neresidir?",
    choices:         ["Buenos Aires", "Córdoba", "Rosario", "Mendoza"],
    acceptedAnswers: ["Buenos Aires"],
  },
  {
    id: "q20",
    prompt:          "Portekiz'in başkenti neresidir?",
    choices:         ["Lizbon", "Porto", "Braga", "Coimbra"],
    acceptedAnswers: ["Lizbon", "Lisbon"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Type race — "X harfiyle başlayan bir ülke yaz" style prompts
// ─────────────────────────────────────────────────────────────────────────────

export interface TypeRaceBankEntry {
  id:               string;
  prompt:           string;
  /** Every accepted country/answer.  First correct typist wins. */
  acceptedAnswers:  string[];
}

export const CONQUEST_TYPE_RACE_BANK: TypeRaceBankEntry[] = [
  {
    id: "tr01",
    prompt: "A harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Almanya", "Avusturya", "Avustralya", "Arnavutluk", "Azerbaycan",
      "Afganistan", "Andorra", "Angola", "Arjantin", "Amerika", "ABD",
      "Aruba", "Antigua", "Andorra",
    ],
  },
  {
    id: "tr02",
    prompt: "B harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Brezilya", "Bulgaristan", "Belçika", "Bangladeş", "Bolivya",
      "Bahreyn", "Belarus", "Birleşik Krallık", "Bosna Hersek", "Botsvana",
      "Butan", "Burkina Faso", "Burundi", "Bahamas",
    ],
  },
  {
    id: "tr03",
    prompt: "F harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Fransa", "Finlandiya", "Filipinler", "Fas", "Filistin", "Fiji",
    ],
  },
  {
    id: "tr04",
    prompt: "İ harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "İtalya", "İran", "İrlanda", "İspanya", "İsrail", "İsveç",
      "İsviçre", "İzlanda", "Irak",
    ],
  },
  {
    id: "tr05",
    prompt: "K harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Kanada", "Katar", "Kazakistan", "Kenya", "Kıbrıs", "Kolombiya",
      "Kosova", "Küba", "Kuveyt", "Kırgızistan", "Kuzey Kore", "Kamerun",
      "Kamboçya", "Komorlar",
    ],
  },
  {
    id: "tr06",
    prompt: "Avrupa'da yer alan bir ülke yaz.",
    acceptedAnswers: [
      "Almanya", "Fransa", "İspanya", "İtalya", "İngiltere", "Yunanistan",
      "Portekiz", "Belçika", "Hollanda", "İsveç", "Norveç", "Finlandiya",
      "Polonya", "Avusturya", "İsviçre", "Macaristan", "Çekya", "Romanya",
      "Bulgaristan", "Hırvatistan", "Sırbistan", "Slovenya", "Slovakya",
      "Danimarka", "İrlanda", "İzlanda", "Estonya", "Letonya", "Litvanya",
      "Türkiye", "Arnavutluk", "Bosna Hersek", "Kosova", "Kuzey Makedonya",
      "Karadağ", "Lüksemburg", "Malta", "Kıbrıs",
    ],
  },
  {
    id: "tr07",
    prompt: "Güney Amerika'da yer alan bir ülke yaz.",
    acceptedAnswers: [
      "Brezilya", "Arjantin", "Şili", "Peru", "Kolombiya", "Venezuela",
      "Uruguay", "Paraguay", "Ekvador", "Bolivya", "Guyana", "Surinam",
    ],
  },
  {
    id: "tr08",
    prompt: "Afrika'da yer alan bir ülke yaz.",
    acceptedAnswers: [
      "Mısır", "Fas", "Cezayir", "Tunus", "Libya", "Sudan", "Etiyopya",
      "Kenya", "Nijerya", "Gana", "Senegal", "Mali", "Güney Afrika",
      "Angola", "Kongo", "Kamerun", "Uganda", "Tanzanya", "Zimbabve",
      "Mozambik", "Botsvana", "Namibya", "Madagaskar", "Ruanda", "Fildişi Sahili",
    ],
  },
  {
    id: "tr09",
    prompt: "G harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Gürcistan", "Gana", "Guatemala", "Gine", "Gabon", "Gambiya",
      "Grenada", "Guyana", "Guam",
    ],
  },
  {
    id: "tr10",
    prompt: "M harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Mısır", "Meksika", "Macaristan", "Malezya", "Moğolistan", "Monako",
      "Mozambik", "Madagaskar", "Mali", "Malta", "Mauritius", "Moritanya",
      "Malavi", "Maldivler", "Makedonya",
    ],
  },
  {
    id: "tr11",
    prompt: "P harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Portekiz", "Peru", "Pakistan", "Panama", "Paraguay", "Polonya",
      "Papua Yeni Gine", "Palau",
    ],
  },
  {
    id: "tr12",
    prompt: "S harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Suriye", "Suudi Arabistan", "Sudan", "Senegal", "Sırbistan",
      "Slovenya", "Slovakya", "Somali", "Sri Lanka", "Singapur", "Seyşeller",
      "Svaziland", "Surinam",
    ],
  },
  {
    id: "tr13",
    prompt: "Asya'da yer alan bir ülke yaz.",
    acceptedAnswers: [
      "Japonya", "Çin", "Hindistan", "Türkiye", "İran", "Irak", "Suudi Arabistan",
      "Tayland", "Vietnam", "Endonezya", "Malezya", "Pakistan", "Afganistan",
      "Kazakistan", "Özbekistan", "Azerbaycan", "Gürcistan", "Ermenistan",
      "Filipinler", "Moğolistan", "Kuzey Kore", "Güney Kore", "Myanmar",
      "Kamboçya", "Laos", "Nepal", "Butan", "Bangladeş", "Sri Lanka",
      "Katar", "Bahreyn", "Kuveyt", "BAE", "Umman", "Yemen", "Ürdün",
      "Lübnan", "İsrail", "Suriye", "Singapur", "Tayvan",
    ],
  },
  {
    id: "tr14",
    prompt: "Denize kıyısı olmayan bir ülke yaz.",
    acceptedAnswers: [
      "İsviçre", "Avusturya", "Macaristan", "Çekya", "Slovakya", "Sırbistan",
      "Kosova", "Kuzey Makedonya", "Kazakistan", "Afganistan", "Moğolistan",
      "Nepal", "Bolivya", "Paraguay", "Ruanda", "Uganda", "Etiyopya",
      "Mali", "Niger", "Nijer", "Lüksemburg", "Andorra",
    ],
  },
  {
    id: "tr15",
    prompt: "Akdeniz'e kıyısı olan bir ülke yaz.",
    acceptedAnswers: [
      "Türkiye", "Yunanistan", "İtalya", "Fransa", "İspanya", "Fas",
      "Cezayir", "Tunus", "Libya", "Mısır", "Lübnan", "İsrail", "Suriye",
      "Kıbrıs", "Malta", "Hırvatistan", "Arnavutluk", "Karadağ",
    ],
  },
  {
    id: "tr16",
    prompt: "Orta Doğu'da yer alan bir ülke yaz.",
    acceptedAnswers: [
      "Türkiye", "İran", "Irak", "Suriye", "Lübnan", "İsrail", "Ürdün",
      "Suudi Arabistan", "Katar", "Bahreyn", "Kuveyt", "BAE", "Umman", "Yemen",
      "Filistin",
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Flag guess — flag emoji → country name
// ─────────────────────────────────────────────────────────────────────────────

export interface FlagGuessBankEntry {
  id:               string;
  /** Flag emoji (or composed regional indicator pair). */
  flag:             string;
  acceptedAnswers:  string[];
}

export const CONQUEST_FLAG_GUESS_BANK: FlagGuessBankEntry[] = [
  { id: "fg01", flag: "🇯🇵", acceptedAnswers: ["Japonya", "Japan"] },
  { id: "fg02", flag: "🇧🇷", acceptedAnswers: ["Brezilya", "Brazil"] },
  { id: "fg03", flag: "🇩🇪", acceptedAnswers: ["Almanya", "Germany"] },
  { id: "fg04", flag: "🇫🇷", acceptedAnswers: ["Fransa", "France"] },
  { id: "fg05", flag: "🇮🇹", acceptedAnswers: ["İtalya", "Italya", "Italy"] },
  { id: "fg06", flag: "🇪🇸", acceptedAnswers: ["İspanya", "Ispanya", "Spain"] },
  { id: "fg07", flag: "🇬🇧", acceptedAnswers: ["İngiltere", "Ingiltere", "Birleşik Krallık", "UK", "Britanya"] },
  { id: "fg08", flag: "🇺🇸", acceptedAnswers: ["ABD", "Amerika", "Amerika Birleşik Devletleri", "USA", "United States"] },
  { id: "fg09", flag: "🇨🇦", acceptedAnswers: ["Kanada", "Canada"] },
  { id: "fg10", flag: "🇨🇳", acceptedAnswers: ["Çin", "Cin", "China"] },
  { id: "fg11", flag: "🇷🇺", acceptedAnswers: ["Rusya", "Russia"] },
  { id: "fg12", flag: "🇰🇷", acceptedAnswers: ["Güney Kore", "Guney Kore", "Kore", "South Korea", "Korea"] },
  { id: "fg13", flag: "🇲🇽", acceptedAnswers: ["Meksika", "Mexico"] },
  { id: "fg14", flag: "🇦🇷", acceptedAnswers: ["Arjantin", "Argentina"] },
  { id: "fg15", flag: "🇦🇺", acceptedAnswers: ["Avustralya", "Australia"] },
  { id: "fg16", flag: "🇪🇬", acceptedAnswers: ["Mısır", "Misir", "Egypt"] },
  { id: "fg17", flag: "🇹🇷", acceptedAnswers: ["Türkiye", "Turkiye", "Turkey"] },
  { id: "fg18", flag: "🇬🇷", acceptedAnswers: ["Yunanistan", "Greece"] },
  { id: "fg19", flag: "🇳🇱", acceptedAnswers: ["Hollanda", "Netherlands"] },
  { id: "fg20", flag: "🇵🇹", acceptedAnswers: ["Portekiz", "Portugal"] },
  { id: "fg21", flag: "🇸🇪", acceptedAnswers: ["İsveç", "Isveç", "Sweden"] },
  { id: "fg22", flag: "🇳🇴", acceptedAnswers: ["Norveç", "Norway"] },
  { id: "fg23", flag: "🇨🇭", acceptedAnswers: ["İsviçre", "Isviçre", "Switzerland"] },
  { id: "fg24", flag: "🇮🇳", acceptedAnswers: ["Hindistan", "India"] },
];

// ─────────────────────────────────────────────────────────────────────────────
// Picker helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick a random quiz entry that has not yet been used in this match.
 * Falls back to the full pool only when every quiz question has been shown.
 */
export function pickQuizBankEntry(usedIds: string[] = []): { entry: QuizBankEntry; id: string } {
  const available = CONQUEST_QUIZ_BANK.filter(e => !usedIds.includes(e.id));
  const pool = available.length > 0 ? available : CONQUEST_QUIZ_BANK;
  const entry = pool[Math.floor(Math.random() * pool.length)];
  return { entry, id: entry.id };
}

/**
 * Pick a random type-race entry, preferring unused ones.
 */
export function pickTypeRaceBankEntry(usedIds: string[] = []): { entry: TypeRaceBankEntry; id: string } {
  const available = CONQUEST_TYPE_RACE_BANK.filter(e => !usedIds.includes(e.id));
  const pool = available.length > 0 ? available : CONQUEST_TYPE_RACE_BANK;
  const entry = pool[Math.floor(Math.random() * pool.length)];
  return { entry, id: entry.id };
}

/**
 * Pick a random flag-guess entry, preferring unused ones.
 */
export function pickFlagGuessBankEntry(usedIds: string[] = []): { entry: FlagGuessBankEntry; id: string } {
  const available = CONQUEST_FLAG_GUESS_BANK.filter(e => !usedIds.includes(e.id));
  const pool = available.length > 0 ? available : CONQUEST_FLAG_GUESS_BANK;
  const entry = pool[Math.floor(Math.random() * pool.length)];
  return { entry, id: entry.id };
}
