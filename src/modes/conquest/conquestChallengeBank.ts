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
  // ── Capitals — extended ────────────────────────────────────────────────
  {
    id: "q21",
    prompt:          "Hollanda'nın başkenti neresidir?",
    choices:         ["Amsterdam", "Rotterdam", "Lahey", "Utrecht"],
    acceptedAnswers: ["Amsterdam"],
  },
  {
    id: "q22",
    prompt:          "Yunanistan'ın başkenti neresidir?",
    choices:         ["Atina", "Selanik", "Patra", "Korfu"],
    acceptedAnswers: ["Atina", "Athens"],
  },
  {
    id: "q23",
    prompt:          "İsveç'in başkenti neresidir?",
    choices:         ["Stockholm", "Göteborg", "Malmö", "Uppsala"],
    acceptedAnswers: ["Stockholm", "Stokholm"],
  },
  {
    id: "q24",
    prompt:          "Norveç'in başkenti neresidir?",
    choices:         ["Oslo", "Bergen", "Trondheim", "Stavanger"],
    acceptedAnswers: ["Oslo"],
  },
  {
    id: "q25",
    prompt:          "Finlandiya'nın başkenti neresidir?",
    choices:         ["Helsinki", "Espoo", "Tampere", "Turku"],
    acceptedAnswers: ["Helsinki"],
  },
  {
    id: "q26",
    prompt:          "Danimarka'nın başkenti neresidir?",
    choices:         ["Kopenhag", "Aarhus", "Odense", "Aalborg"],
    acceptedAnswers: ["Kopenhag", "Copenhagen"],
  },
  {
    id: "q27",
    prompt:          "Polonya'nın başkenti neresidir?",
    choices:         ["Varşova", "Krakov", "Gdansk", "Poznan"],
    acceptedAnswers: ["Varşova", "Varsova", "Warszawa", "Warsaw"],
  },
  {
    id: "q28",
    prompt:          "Avusturya'nın başkenti neresidir?",
    choices:         ["Viyana", "Salzburg", "Graz", "Innsbruck"],
    acceptedAnswers: ["Viyana", "Wien", "Vienna"],
  },
  {
    id: "q29",
    prompt:          "Macaristan'ın başkenti neresidir?",
    choices:         ["Budapeşte", "Debrecen", "Szeged", "Pécs"],
    acceptedAnswers: ["Budapeşte", "Budapeste", "Budapest"],
  },
  {
    id: "q30",
    prompt:          "Çekya'nın başkenti neresidir?",
    choices:         ["Prag", "Brno", "Ostrava", "Plzen"],
    acceptedAnswers: ["Prag", "Prague", "Praha"],
  },
  {
    id: "q31",
    prompt:          "İrlanda'nın başkenti neresidir?",
    choices:         ["Dublin", "Cork", "Limerick", "Galway"],
    acceptedAnswers: ["Dublin"],
  },
  {
    id: "q32",
    prompt:          "İran'ın başkenti neresidir?",
    choices:         ["Tahran", "İsfahan", "Tebriz", "Şiraz"],
    acceptedAnswers: ["Tahran", "Tehran"],
  },
  {
    id: "q33",
    prompt:          "Suudi Arabistan'ın başkenti neresidir?",
    choices:         ["Riyad", "Cidde", "Mekke", "Medine"],
    acceptedAnswers: ["Riyad", "Riyadh"],
  },
  {
    id: "q34",
    prompt:          "Tayland'ın başkenti neresidir?",
    choices:         ["Bangkok", "Phuket", "Pattaya", "Chiang Mai"],
    acceptedAnswers: ["Bangkok"],
  },
  {
    id: "q35",
    prompt:          "Vietnam'ın başkenti neresidir?",
    choices:         ["Hanoi", "Ho Chi Minh", "Da Nang", "Hue"],
    acceptedAnswers: ["Hanoi"],
  },
  {
    id: "q36",
    prompt:          "Güney Kore'nin başkenti neresidir?",
    choices:         ["Seul", "Busan", "Incheon", "Daegu"],
    acceptedAnswers: ["Seul", "Seoul"],
  },
  {
    id: "q37",
    prompt:          "Endonezya'nın başkenti neresidir?",
    choices:         ["Jakarta", "Bali", "Surabaya", "Bandung"],
    acceptedAnswers: ["Jakarta", "Cakarta"],
  },
  {
    id: "q38",
    prompt:          "Pakistan'ın başkenti neresidir?",
    choices:         ["İslamabad", "Karaçi", "Lahor", "Peşaver"],
    acceptedAnswers: ["İslamabad", "Islamabad"],
  },
  {
    id: "q39",
    prompt:          "Yeni Zelanda'nın başkenti neresidir?",
    choices:         ["Wellington", "Auckland", "Christchurch", "Hamilton"],
    acceptedAnswers: ["Wellington"],
  },
  {
    id: "q40",
    prompt:          "Şili'nin başkenti neresidir?",
    choices:         ["Santiago", "Valparaiso", "Concepción", "Antofagasta"],
    acceptedAnswers: ["Santiago"],
  },
  {
    id: "q41",
    prompt:          "Peru'nun başkenti neresidir?",
    choices:         ["Lima", "Cusco", "Arequipa", "Trujillo"],
    acceptedAnswers: ["Lima"],
  },
  {
    id: "q42",
    prompt:          "Kolombiya'nın başkenti neresidir?",
    choices:         ["Bogotá", "Medellín", "Cali", "Cartagena"],
    acceptedAnswers: ["Bogotá", "Bogota"],
  },
  {
    id: "q43",
    prompt:          "Güney Afrika'nın yasama başkenti neresidir?",
    choices:         ["Cape Town", "Pretoria", "Johannesburg", "Durban"],
    acceptedAnswers: ["Cape Town", "Kap Town", "Kapstadt"],
  },
  {
    id: "q44",
    prompt:          "Kenya'nın başkenti neresidir?",
    choices:         ["Nairobi", "Mombasa", "Kisumu", "Nakuru"],
    acceptedAnswers: ["Nairobi"],
  },
  {
    id: "q45",
    prompt:          "Fas'ın başkenti neresidir?",
    choices:         ["Rabat", "Kazablanka", "Marakeş", "Fes"],
    acceptedAnswers: ["Rabat"],
  },
  // ── Rivers ─────────────────────────────────────────────────────────────
  {
    id: "q46",
    prompt:          "Mısır'dan geçen, eski uygarlıkların beşiği sayılan büyük nehir hangisidir?",
    choices:         ["Nil", "Kongo", "Niger", "Zambezi"],
    acceptedAnswers: ["Nil", "Nile"],
  },
  {
    id: "q47",
    prompt:          "Güney Amerika'nın büyük yağmur ormanlarından geçen nehir hangisidir?",
    choices:         ["Amazon", "Orinoco", "Paraná", "Magdalena"],
    acceptedAnswers: ["Amazon"],
  },
  {
    id: "q48",
    prompt:          "Çin'de yer alan ve Asya'nın en uzun nehri olan hangisidir?",
    choices:         ["Yangtze", "Sarı Irmak", "Mekong", "İndus"],
    acceptedAnswers: ["Yangtze", "Yangçe", "Çangciang"],
  },
  {
    id: "q49",
    prompt:          "Hindistan ve Bangladeş'i besleyen kutsal nehir hangisidir?",
    choices:         ["Ganj", "İndus", "Brahmaputra", "Godavari"],
    acceptedAnswers: ["Ganj", "Ganga", "Ganges"],
  },
  {
    id: "q50",
    prompt:          "Avrupa'nın 10 ülkesinden geçen, Karadeniz'e dökülen nehir hangisidir?",
    choices:         ["Tuna", "Ren", "Volga", "Elbe"],
    acceptedAnswers: ["Tuna", "Danube", "Donau"],
  },
  {
    id: "q51",
    prompt:          "Türkiye'nin en uzun nehri hangisidir?",
    choices:         ["Kızılırmak", "Fırat", "Yeşilırmak", "Sakarya"],
    acceptedAnswers: ["Kızılırmak", "Kizilirmak"],
  },
  {
    id: "q52",
    prompt:          "Paris şehrini ortadan ikiye bölen nehir hangisidir?",
    choices:         ["Sen", "Loire", "Rhône", "Garonne"],
    acceptedAnswers: ["Sen", "Seine"],
  },
  {
    id: "q53",
    prompt:          "Londra'dan geçen, Britanya'nın simge nehri hangisidir?",
    choices:         ["Thames", "Severn", "Mersey", "Tyne"],
    acceptedAnswers: ["Thames", "Tems"],
  },
  // ── Mountains ──────────────────────────────────────────────────────────
  {
    id: "q54",
    prompt:          "Dünyanın en yüksek dağı hangisidir?",
    choices:         ["Everest", "K2", "Kanchenjunga", "Lhotse"],
    acceptedAnswers: ["Everest", "Mount Everest"],
  },
  {
    id: "q55",
    prompt:          "Afrika'nın en yüksek dağı hangisidir?",
    choices:         ["Kilimanjaro", "Kenya Dağı", "Ras Daşen", "Mulhacén"],
    acceptedAnswers: ["Kilimanjaro", "Kilimancaro"],
  },
  {
    id: "q56",
    prompt:          "Güney Amerika'nın en yüksek dağı hangisidir?",
    choices:         ["Aconcagua", "Chimborazo", "Huascarán", "Ojos del Salado"],
    acceptedAnswers: ["Aconcagua"],
  },
  {
    id: "q57",
    prompt:          "Avrupa'nın en yüksek dağı hangisidir?",
    choices:         ["Elbruz", "Mont Blanc", "Matterhorn", "Mulhacén"],
    acceptedAnswers: ["Elbruz", "Elbrus"],
  },
  {
    id: "q58",
    prompt:          "Türkiye'nin en yüksek dağı hangisidir?",
    choices:         ["Ağrı Dağı", "Kaçkar", "Süphan", "Erciyes"],
    acceptedAnswers: ["Ağrı Dağı", "Ağrı", "Agri Dagi", "Agri", "Ararat"],
  },
  {
    id: "q59",
    prompt:          "Alp Dağları başlıca hangi kıtada yer alır?",
    choices:         ["Avrupa", "Asya", "Afrika", "Amerika"],
    acceptedAnswers: ["Avrupa", "Europe"],
  },
  // ── Seas / oceans / lakes ──────────────────────────────────────────────
  {
    id: "q60",
    prompt:          "Türkiye'nin kuzeyinde bulunan deniz hangisidir?",
    choices:         ["Karadeniz", "Akdeniz", "Ege Denizi", "Marmara Denizi"],
    acceptedAnswers: ["Karadeniz", "Kara Deniz", "Black Sea"],
  },
  {
    id: "q61",
    prompt:          "Türkiye'nin batısında bulunan deniz hangisidir?",
    choices:         ["Ege Denizi", "Akdeniz", "Karadeniz", "Marmara Denizi"],
    acceptedAnswers: ["Ege Denizi", "Ege", "Aegean Sea"],
  },
  {
    id: "q62",
    prompt:          "İstanbul Boğazı hangi iki denizi birbirine bağlar?",
    choices:         ["Karadeniz ve Marmara", "Karadeniz ve Ege", "Akdeniz ve Marmara", "Marmara ve Ege"],
    acceptedAnswers: ["Karadeniz ve Marmara"],
  },
  {
    id: "q63",
    prompt:          "Dünyanın en büyük okyanusu hangisidir?",
    choices:         ["Büyük Okyanus", "Atlas Okyanusu", "Hint Okyanusu", "Arktik Okyanus"],
    acceptedAnswers: ["Büyük Okyanus", "Pasifik", "Pacific", "Pasifik Okyanusu"],
  },
  {
    id: "q64",
    prompt:          "Yüzölçümü olarak dünyanın en büyük gölü hangisidir?",
    choices:         ["Hazar Gölü", "Superior Gölü", "Victoria Gölü", "Baykal Gölü"],
    acceptedAnswers: ["Hazar Gölü", "Hazar", "Caspian", "Caspian Sea"],
  },
  {
    id: "q65",
    prompt:          "Dünyanın en derin gölü hangisidir?",
    choices:         ["Baykal Gölü", "Tanganika", "Hazar", "Victoria"],
    acceptedAnswers: ["Baykal Gölü", "Baykal", "Baikal", "Lake Baikal"],
  },
  // ── Continents / geography ─────────────────────────────────────────────
  {
    id: "q66",
    prompt:          "Yüzölçümü en büyük kıta hangisidir?",
    choices:         ["Asya", "Afrika", "Kuzey Amerika", "Antarktika"],
    acceptedAnswers: ["Asya", "Asia"],
  },
  {
    id: "q67",
    prompt:          "Sahara Çölü hangi kıtada yer alır?",
    choices:         ["Afrika", "Asya", "Avustralya", "Güney Amerika"],
    acceptedAnswers: ["Afrika", "Africa"],
  },
  {
    id: "q68",
    prompt:          "Amazon yağmur ormanları hangi kıtada bulunur?",
    choices:         ["Güney Amerika", "Afrika", "Asya", "Okyanusya"],
    acceptedAnswers: ["Güney Amerika", "Guney Amerika", "South America"],
  },
  {
    id: "q69",
    prompt:          "Yüzölçümü en küçük kıta hangisidir?",
    choices:         ["Avustralya", "Avrupa", "Antarktika", "Güney Amerika"],
    acceptedAnswers: ["Avustralya", "Okyanusya", "Australia"],
  },
  {
    id: "q70",
    prompt:          "Ekvator hangi kıtanın tamamen kuzeyinden geçer?",
    choices:         ["Avrupa", "Asya", "Afrika", "Güney Amerika"],
    acceptedAnswers: ["Avrupa", "Europe"],
  },
  // ── Neighbours / borders ───────────────────────────────────────────────
  {
    id: "q71",
    prompt:          "Aşağıdaki ülkelerden hangisi Türkiye ile sınır komşusudur?",
    choices:         ["Gürcistan", "Mısır", "Romanya", "Ukrayna"],
    acceptedAnswers: ["Gürcistan", "Gurcistan", "Georgia"],
  },
  {
    id: "q72",
    prompt:          "Türkiye'nin güneyindeki sınır komşularından biri hangisidir?",
    choices:         ["Suriye", "Lübnan", "İsrail", "Ürdün"],
    acceptedAnswers: ["Suriye", "Syria"],
  },
  {
    id: "q73",
    prompt:          "Aşağıdakilerden hangisi Türkiye'nin sınır komşusu DEĞİLDİR?",
    choices:         ["Mısır", "Ermenistan", "Bulgaristan", "İran"],
    acceptedAnswers: ["Mısır", "Misir", "Egypt"],
  },
  {
    id: "q74",
    prompt:          "Aşağıdaki ülkelerden hangisi Almanya ile sınır komşusudur?",
    choices:         ["Polonya", "Romanya", "İspanya", "Norveç"],
    acceptedAnswers: ["Polonya", "Poland"],
  },
  {
    id: "q75",
    prompt:          "Portekiz'in tek kara sınırına sahip olduğu ülke hangisidir?",
    choices:         ["İspanya", "Fransa", "Fas", "Andorra"],
    acceptedAnswers: ["İspanya", "Ispanya", "Spain"],
  },
  {
    id: "q76",
    prompt:          "Kanada'nın tek kara sınırına sahip olduğu ülke hangisidir?",
    choices:         ["ABD", "Meksika", "Rusya", "Grönland"],
    acceptedAnswers: ["ABD", "Amerika", "Amerika Birleşik Devletleri", "USA", "United States"],
  },
  {
    id: "q77",
    prompt:          "ABD'nin güney komşusu hangi ülkedir?",
    choices:         ["Meksika", "Kanada", "Guatemala", "Küba"],
    acceptedAnswers: ["Meksika", "Mexico"],
  },
  // ── Flags / symbols ───────────────────────────────────────────────────
  {
    id: "q78",
    prompt:          "Bayrağında akçaağaç yaprağı bulunan ülke hangisidir?",
    choices:         ["Kanada", "Avustralya", "Yeni Zelanda", "İrlanda"],
    acceptedAnswers: ["Kanada", "Canada"],
  },
  {
    id: "q79",
    prompt:          "Bayrağında doğan güneş motifi bulunan ülke hangisidir?",
    choices:         ["Japonya", "Çin", "Güney Kore", "Vietnam"],
    acceptedAnswers: ["Japonya", "Japan"],
  },
  {
    id: "q80",
    prompt:          "Bayrağında ay-yıldız bulunan ve Türkiye dışındaki bir ülke hangisidir?",
    choices:         ["Tunus", "İtalya", "Mısır", "Hindistan"],
    acceptedAnswers: ["Tunus", "Tunisia"],
  },
  {
    id: "q81",
    prompt:          "Mavi-beyaz çizgili bayrağıyla bilinen Avrupa ülkesi hangisidir?",
    choices:         ["Yunanistan", "İtalya", "Portekiz", "Almanya"],
    acceptedAnswers: ["Yunanistan", "Greece"],
  },
  {
    id: "q82",
    prompt:          "Kırmızı zemin üzerinde beyaz haç bulunan, İskandinav bayrağına sahip ülke hangisidir?",
    choices:         ["Danimarka", "İsveç", "Norveç", "Finlandiya"],
    acceptedAnswers: ["Danimarka", "Denmark"],
  },
  // ── Misc geography ─────────────────────────────────────────────────────
  {
    id: "q83",
    prompt:          "Süveyş Kanalı hangi iki denizi birbirine bağlar?",
    choices:         ["Akdeniz ve Kızıldeniz", "Karadeniz ve Akdeniz", "Akdeniz ve Hint Okyanusu", "Kızıldeniz ve Arap Denizi"],
    acceptedAnswers: ["Akdeniz ve Kızıldeniz", "Akdeniz - Kızıldeniz"],
  },
  {
    id: "q84",
    prompt:          "Panama Kanalı hangi iki okyanusu birbirine bağlar?",
    choices:         ["Pasifik ve Atlas", "Pasifik ve Hint", "Atlas ve Hint", "Pasifik ve Arktik"],
    acceptedAnswers: ["Pasifik ve Atlas", "Atlas ve Pasifik", "Büyük Okyanus ve Atlas"],
  },
  {
    id: "q85",
    prompt:          "Aşağıdaki ülkelerden hangisi bir ada ülkesidir?",
    choices:         ["Madagaskar", "Şili", "Vietnam", "Portekiz"],
    acceptedAnswers: ["Madagaskar", "Madagascar"],
  },
  {
    id: "q86",
    prompt:          "Vatikan hangi şehrin içinde yer alır?",
    choices:         ["Roma", "Floransa", "Cenova", "Milano"],
    acceptedAnswers: ["Roma", "Rome"],
  },
  {
    id: "q87",
    prompt:          "Eyfel Kulesi hangi şehirde bulunur?",
    choices:         ["Paris", "Londra", "Berlin", "Madrid"],
    acceptedAnswers: ["Paris"],
  },
  {
    id: "q88",
    prompt:          "Big Ben adlı saat kulesi hangi şehirdedir?",
    choices:         ["Londra", "Edinburgh", "Manchester", "Dublin"],
    acceptedAnswers: ["Londra", "London"],
  },
  {
    id: "q89",
    prompt:          "Kolezyum hangi şehirde yer alır?",
    choices:         ["Roma", "Atina", "Napoli", "İstanbul"],
    acceptedAnswers: ["Roma", "Rome"],
  },
  {
    id: "q90",
    prompt:          "Akropolis hangi şehirde bulunur?",
    choices:         ["Atina", "Roma", "İstanbul", "Selanik"],
    acceptedAnswers: ["Atina", "Athens"],
  },
  {
    id: "q91",
    prompt:          "Ayasofya hangi şehirde bulunur?",
    choices:         ["İstanbul", "Ankara", "İzmir", "Bursa"],
    acceptedAnswers: ["İstanbul", "Istanbul"],
  },
  {
    id: "q92",
    prompt:          "Kapadokya hangi ülkede yer alır?",
    choices:         ["Türkiye", "Yunanistan", "İran", "Gürcistan"],
    acceptedAnswers: ["Türkiye", "Turkiye", "Turkey"],
  },
  {
    id: "q93",
    prompt:          "Machu Picchu antik kenti hangi ülkededir?",
    choices:         ["Peru", "Şili", "Bolivya", "Meksika"],
    acceptedAnswers: ["Peru"],
  },
  {
    id: "q94",
    prompt:          "Petra antik kenti hangi ülkededir?",
    choices:         ["Ürdün", "İsrail", "Mısır", "Suriye"],
    acceptedAnswers: ["Ürdün", "Urdun", "Jordan"],
  },
  {
    id: "q95",
    prompt:          "Tac Mahal hangi ülkede bulunur?",
    choices:         ["Hindistan", "Pakistan", "Nepal", "Bangladeş"],
    acceptedAnswers: ["Hindistan", "India"],
  },
  {
    id: "q96",
    prompt:          "Çin Seddi hangi ülkededir?",
    choices:         ["Çin", "Moğolistan", "Kore", "Japonya"],
    acceptedAnswers: ["Çin", "Cin", "China"],
  },
  {
    id: "q97",
    prompt:          "Aşağıdaki şehirlerden hangisi iki kıtaya yayılmıştır?",
    choices:         ["İstanbul", "Roma", "Atina", "Kahire"],
    acceptedAnswers: ["İstanbul", "Istanbul"],
  },
  {
    id: "q98",
    prompt:          "Avrupa'nın en büyük yüzölçümüne sahip ülkesi hangisidir?",
    choices:         ["Rusya", "Ukrayna", "Fransa", "Almanya"],
    acceptedAnswers: ["Rusya", "Russia"],
  },
  {
    id: "q99",
    prompt:          "Aşağıdaki ülkelerden hangisi denize kıyısı olmayan bir ülkedir?",
    choices:         ["İsviçre", "Portekiz", "Norveç", "Yunanistan"],
    acceptedAnswers: ["İsviçre", "Isvicre", "Switzerland"],
  },
  {
    id: "q100",
    prompt:          "Galapagos Adaları hangi ülkeye aittir?",
    choices:         ["Ekvador", "Peru", "Şili", "Kolombiya"],
    acceptedAnswers: ["Ekvador", "Ecuador"],
  },
  {
    id: "q101",
    prompt:          "Aşağıdaki çöllerden hangisi Asya'da yer alır?",
    choices:         ["Gobi", "Sahara", "Kalahari", "Atacama"],
    acceptedAnswers: ["Gobi"],
  },
  {
    id: "q102",
    prompt:          "Dünyanın en kurak çölü olarak bilinen Atacama hangi kıtadadır?",
    choices:         ["Güney Amerika", "Afrika", "Asya", "Avustralya"],
    acceptedAnswers: ["Güney Amerika", "Guney Amerika", "South America"],
  },
  {
    id: "q103",
    prompt:          "İskandinav ülkesi olmayan hangisidir?",
    choices:         ["Hollanda", "İsveç", "Norveç", "Danimarka"],
    acceptedAnswers: ["Hollanda", "Netherlands"],
  },
  {
    id: "q104",
    prompt:          "Aşağıdakilerden hangisi Balkan ülkesi DEĞİLDİR?",
    choices:         ["Polonya", "Sırbistan", "Bulgaristan", "Arnavutluk"],
    acceptedAnswers: ["Polonya", "Poland"],
  },
  {
    id: "q105",
    prompt:          "Akdeniz'in en büyük adası hangisidir?",
    choices:         ["Sicilya", "Sardunya", "Kıbrıs", "Korsika"],
    acceptedAnswers: ["Sicilya", "Sicily"],
  },
  {
    id: "q106",
    prompt:          "Britanya Adaları'nın en büyük adası hangisidir?",
    choices:         ["Büyük Britanya", "İrlanda", "Man Adası", "Wight"],
    acceptedAnswers: ["Büyük Britanya", "Buyuk Britanya", "Great Britain"],
  },
  {
    id: "q107",
    prompt:          "Dünyanın en uzun sıradağı hangisidir?",
    choices:         ["And Dağları", "Himalayalar", "Kayalık Dağlar", "Alpler"],
    acceptedAnswers: ["And Dağları", "Andlar", "Andes"],
  },
  {
    id: "q108",
    prompt:          "Ural Dağları hangi iki kıta arasında doğal sınır oluşturur?",
    choices:         ["Avrupa-Asya", "Asya-Afrika", "Avrupa-Afrika", "Asya-Okyanusya"],
    acceptedAnswers: ["Avrupa-Asya", "Avrupa Asya", "Asya-Avrupa"],
  },
  {
    id: "q109",
    prompt:          "İber Yarımadası'nda yer alan iki ülke hangileridir?",
    choices:         ["İspanya ve Portekiz", "Fransa ve İspanya", "Portekiz ve Fransa", "İtalya ve İspanya"],
    acceptedAnswers: ["İspanya ve Portekiz", "Portekiz ve İspanya"],
  },
  {
    id: "q110",
    prompt:          "Skandinav Yarımadası'nda yer alan iki ülke hangileridir?",
    choices:         ["İsveç ve Norveç", "Norveç ve Finlandiya", "Danimarka ve İsveç", "Finlandiya ve İzlanda"],
    acceptedAnswers: ["İsveç ve Norveç", "Norveç ve İsveç"],
  },
  {
    id: "q111",
    prompt:          "Aşağıdaki ülkelerden hangisi Güney Yarımküre'de yer alır?",
    choices:         ["Avustralya", "İtalya", "Japonya", "Kanada"],
    acceptedAnswers: ["Avustralya", "Australia"],
  },
  {
    id: "q112",
    prompt:          "Aşağıdaki şehirlerden hangisi Güney Amerika'da DEĞİLDİR?",
    choices:         ["Madrid", "Lima", "Bogotá", "Buenos Aires"],
    acceptedAnswers: ["Madrid"],
  },
  {
    id: "q113",
    prompt:          "Ren (Rhein) Nehri hangi ülkelerden geçer?",
    choices:         ["Almanya ve Hollanda", "Fransa ve İspanya", "İtalya ve Avusturya", "Polonya ve Çekya"],
    acceptedAnswers: ["Almanya ve Hollanda", "Hollanda ve Almanya"],
  },
  {
    id: "q114",
    prompt:          "Volga Nehri hangi ülkenin sınırları içinde akar?",
    choices:         ["Rusya", "Ukrayna", "Belarus", "Kazakistan"],
    acceptedAnswers: ["Rusya", "Russia"],
  },
  {
    id: "q115",
    prompt:          "İndus Nehri ağırlıklı olarak hangi ülkede yer alır?",
    choices:         ["Pakistan", "Hindistan", "Afganistan", "Bangladeş"],
    acceptedAnswers: ["Pakistan"],
  },
  {
    id: "q116",
    prompt:          "Mississippi Nehri hangi ülkede akar?",
    choices:         ["ABD", "Kanada", "Meksika", "Brezilya"],
    acceptedAnswers: ["ABD", "Amerika", "Amerika Birleşik Devletleri", "USA", "United States"],
  },
  {
    id: "q117",
    prompt:          "Dicle ve Fırat nehirleri ağırlıklı olarak hangi ülkeden doğar?",
    choices:         ["Türkiye", "Irak", "İran", "Suriye"],
    acceptedAnswers: ["Türkiye", "Turkey"],
  },
  {
    id: "q118",
    prompt:          "Boğaziçi Köprüsü hangi şehirde yer alır?",
    choices:         ["İstanbul", "İzmir", "Ankara", "Bursa"],
    acceptedAnswers: ["İstanbul", "Istanbul"],
  },
  {
    id: "q119",
    prompt:          "Çanakkale Boğazı hangi iki denizi birbirine bağlar?",
    choices:         ["Marmara ve Ege", "Karadeniz ve Marmara", "Akdeniz ve Ege", "Marmara ve Akdeniz"],
    acceptedAnswers: ["Marmara ve Ege", "Ege ve Marmara"],
  },
  {
    id: "q120",
    prompt:          "Ölü Deniz hangi iki ülkenin sınırında yer alır?",
    choices:         ["İsrail ve Ürdün", "Suriye ve Lübnan", "Mısır ve İsrail", "Türkiye ve Suriye"],
    acceptedAnswers: ["İsrail ve Ürdün", "Ürdün ve İsrail"],
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
      "Kamboçya", "Komorlar", "Karadağ", "Kongo", "Kuzey Makedonya",
      "Kore", "Kap Verde", "Kiribati",
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
      "Çad", "Nijer", "Niger", "Somali", "Eritre", "Cibuti", "Gambiya",
      "Togo", "Benin", "Liberya", "Sierra Leone", "Malavi", "Zambia",
      "Lesotho", "Eswatini", "Svaziland", "Burundi", "Komoro", "Gabon",
      "Ekvator Ginesi", "Gine", "Gine-Bissau", "Güney Sudan",
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
      "Mali", "Niger", "Nijer", "Lüksemburg", "Andorra", "Çad", "Malavi",
      "Zimbabve", "Botsvana", "Lesotho", "Eswatini", "Svaziland", "Zambia",
      "Burundi", "Kırgızistan", "Tacikistan", "Türkmenistan", "Özbekistan",
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
  {
    id: "tr17",
    prompt: "C harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Cezayir", "Cibuti",
    ],
  },
  {
    id: "tr18",
    prompt: "D harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Danimarka", "Dominik Cumhuriyeti", "Dominika",
    ],
  },
  {
    id: "tr19",
    prompt: "H harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Hindistan", "Hollanda", "Hırvatistan", "Honduras", "Haiti",
    ],
  },
  {
    id: "tr20",
    prompt: "T harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Türkiye", "Tayland", "Tayvan", "Tunus", "Türkmenistan", "Tacikistan",
      "Tanzanya", "Togo", "Tonga", "Trinidad", "Tuvalu",
    ],
  },
  {
    id: "tr21",
    prompt: "L harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Letonya", "Litvanya", "Lübnan", "Libya", "Liberya", "Lihtenştayn",
      "Liechtenstein", "Lüksemburg", "Laos", "Lesotho",
    ],
  },
  {
    id: "tr22",
    prompt: "N harfiyle başlayan bir ülke yaz.",
    acceptedAnswers: [
      "Norveç", "Nepal", "Nikaragua", "Nijerya", "Nijer", "Niger",
      "Namibya", "Nauru",
    ],
  },
  {
    id: "tr23",
    prompt: "Atlas Okyanusu'na kıyısı olan bir ülke yaz.",
    acceptedAnswers: [
      "Portekiz", "İspanya", "Fransa", "İrlanda", "İngiltere", "Birleşik Krallık",
      "Norveç", "İzlanda", "ABD", "Amerika", "Kanada", "Brezilya", "Arjantin",
      "Uruguay", "Fas", "Senegal", "Gana", "Nijerya", "Angola", "Namibya",
      "Güney Afrika", "Mauritania", "Moritanya", "Fildişi Sahili",
    ],
  },
  {
    id: "tr24",
    prompt: "Adalar topluluğundan oluşan bir ülke yaz.",
    acceptedAnswers: [
      "Japonya", "Endonezya", "Filipinler", "İngiltere", "Birleşik Krallık",
      "İrlanda", "İzlanda", "Yeni Zelanda", "Malta", "Kıbrıs", "Maldivler",
      "Madagaskar", "Sri Lanka", "Küba", "Bahamas", "Jamaika", "Seyşeller",
      "Komorlar", "Tonga", "Fiji", "Mauritius",
    ],
  },
  {
    id: "tr25",
    prompt: "Türkiye'ye komşu olan bir ülke yaz.",
    acceptedAnswers: [
      "Yunanistan", "Bulgaristan", "Gürcistan", "Ermenistan", "İran",
      "Irak", "Suriye", "Nahçıvan", "Azerbaycan",
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
  { id: "fg25", flag: "🇵🇱", acceptedAnswers: ["Polonya", "Poland"] },
  { id: "fg26", flag: "🇧🇪", acceptedAnswers: ["Belçika", "Belcika", "Belgium"] },
  { id: "fg27", flag: "🇦🇹", acceptedAnswers: ["Avusturya", "Austria"] },
  { id: "fg28", flag: "🇨🇿", acceptedAnswers: ["Çekya", "Cekya", "Çek Cumhuriyeti", "Czech Republic", "Czechia"] },
  { id: "fg29", flag: "🇭🇺", acceptedAnswers: ["Macaristan", "Hungary"] },
  { id: "fg30", flag: "🇮🇪", acceptedAnswers: ["İrlanda", "Irlanda", "Ireland"] },
  { id: "fg31", flag: "🇫🇮", acceptedAnswers: ["Finlandiya", "Finland"] },
  { id: "fg32", flag: "🇩🇰", acceptedAnswers: ["Danimarka", "Denmark"] },
  { id: "fg33", flag: "🇺🇦", acceptedAnswers: ["Ukrayna", "Ukraine"] },
  { id: "fg34", flag: "🇸🇦", acceptedAnswers: ["Suudi Arabistan", "Saudi Arabia", "Suudi"] },
  { id: "fg35", flag: "🇮🇷", acceptedAnswers: ["İran", "Iran"] },
  { id: "fg36", flag: "🇮🇶", acceptedAnswers: ["Irak", "Iraq"] },
  { id: "fg37", flag: "🇮🇩", acceptedAnswers: ["Endonezya", "Indonesia"] },
  { id: "fg38", flag: "🇵🇰", acceptedAnswers: ["Pakistan"] },
  { id: "fg39", flag: "🇹🇭", acceptedAnswers: ["Tayland", "Thailand"] },
  { id: "fg40", flag: "🇻🇳", acceptedAnswers: ["Vietnam"] },
  { id: "fg41", flag: "🇨🇱", acceptedAnswers: ["Şili", "Sili", "Chile"] },
  { id: "fg42", flag: "🇨🇴", acceptedAnswers: ["Kolombiya", "Colombia"] },
  { id: "fg43", flag: "🇵🇪", acceptedAnswers: ["Peru"] },
  { id: "fg44", flag: "🇿🇦", acceptedAnswers: ["Güney Afrika", "Guney Afrika", "South Africa"] },
  { id: "fg45", flag: "🇰🇪", acceptedAnswers: ["Kenya"] },
  { id: "fg46", flag: "🇳🇿", acceptedAnswers: ["Yeni Zelanda", "New Zealand"] },
  { id: "fg47", flag: "🇲🇦", acceptedAnswers: ["Fas", "Morocco"] },
  { id: "fg48", flag: "🇳🇬", acceptedAnswers: ["Nijerya", "Nigeria"] },
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
