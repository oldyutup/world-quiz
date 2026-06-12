export interface HaritaDedektifiScene {
  id: string;
  yearLabel: string;
  eventLabel: string;
  panorama: string;
  location: {
    lat: number;
    lng: number;
    placeLabel: string;
  };
  scoreCurve?: {
    maxScore: number;
    scaleKm: number;
  };
  explanation: string;
}

export const HARITA_DEDEKTIFI_SCENES: HaritaDedektifiScene[] = [
  {
    id: "viking_village_birka",
    yearLabel: "900'ler",
    eventLabel: "Viking Köyü",
    panorama:
      "/assets/history/harita-dedektifi/map_008_viking_village_scandinavia_900s_4096.png",
    location: {
      lat: 59.3361,
      lng: 17.5419,
      placeLabel: "Birka, Björkö, İsveç",
    },
    scoreCurve: {
      maxScore: 5000,
      scaleKm: 400,
    },
    explanation:
      "Bu sahne, 900'lerde İskandinavya'daki bir Viking yerleşimini temsil eder. Doğru coğrafi referans noktası, dönemin en önemli Viking ticaret kasabalarından biri olan İsveç'teki Birka'dır (Mälaren Gölü'ndeki Björkö adası).",
  },
  {
    id: "ephesus_harbor_city_roman",
    yearLabel: "MS 2. yüzyıl",
    eventLabel: "Efes Liman Kenti",
    panorama:
      "/assets/history/harita-dedektifi/map_008_ephesus_harbor_city_roman_4096.png",
    // TODO: final hotspot coordinates will be adjusted after in-game debug click test.
    location: {
      lat: 37.9410,
      lng: 27.3380,
      placeLabel: "Efes Antik Kenti, Selçuk, İzmir",
    },
    scoreCurve: {
      maxScore: 5000,
      scaleKm: 300,
    },
    explanation:
      "Bu sahne, Roma İmparatorluk Dönemi'nde (MS 2. yüzyıl) Efes'in aktif bir liman kenti olduğu dönemdeki gündelik yaşamı temsil eder. Doğru coğrafi referans noktası, Batı Anadolu'da bugünkü Selçuk yakınlarındaki Efes Antik Kenti ve antik liman bölgesidir.",
  },
  {
    id: "battle_of_ankara_1402",
    yearLabel: "1402",
    eventLabel: "Ankara Savaşı Öncesi",
    panorama:
      "/assets/history/harita-dedektifi/map_009_battle_of_ankara_1402_4096.png",
    // TODO: final hotspot coordinates will be adjusted after in-game debug click test.
    location: {
      lat: 40.1000,
      lng: 33.0500,
      placeLabel: "Çubuk Ovası, Ankara yakınları",
    },
    scoreCurve: {
      maxScore: 5000,
      scaleKm: 300,
    },
    explanation:
      "Bu sahne, 1402'de (Geç Orta Çağ Anadolu) Ankara Savaşı başlamadan hemen önce Osmanlı ve Timurlu ordularının karşı karşıya geldiği anı temsil eder. Doğru coğrafi referans noktası, Ankara yakınlarındaki Çubuk Ovası'dır.",
  },
  {
    id: "titanic_shipyard_belfast_1911",
    yearLabel: "1911",
    eventLabel: "Titanic Tersanesi",
    panorama:
      "/assets/history/harita-dedektifi/map_010_titanic_shipyard_belfast_1911_4096.png",
    // TODO: final hotspot coordinates will be adjusted after in-game debug click test.
    location: {
      lat: 54.6080,
      lng: -5.9080,
      placeLabel: "Harland & Wolff Tersanesi, Belfast",
    },
    scoreCurve: {
      maxScore: 5000,
      scaleKm: 300,
    },
    explanation:
      "Bu sahne, RMS Titanic'in 1911'de Belfast'taki Harland & Wolff tersanesinde inşa edildiği dönemi temsil eder. Doğru coğrafi referans noktası, Belfast'taki Harland & Wolff Tersanesi'dir.",
  },
  {
    id: "trial_of_socrates_athens_399bc",
    yearLabel: "MÖ 399",
    eventLabel: "Sokrates'in Yargılanması",
    panorama:
      "/assets/history/harita-dedektifi/map_011_trial_of_socrates_athens_399bc_4096.png",
    // TODO: final hotspot coordinates will be adjusted after in-game debug click test.
    location: {
      lat: 37.9755,
      lng: 23.7220,
      placeLabel: "Atina, Yunanistan",
    },
    scoreCurve: {
      maxScore: 5000,
      scaleKm: 300,
    },
    explanation:
      "Bu sahne, Klasik Yunan döneminde (MÖ 399) Sokrates'in Atina'da yurttaş jürisi önünde yargılandığı kamusal mahkeme atmosferini temsil eder. Doğru coğrafi referans noktası, Atina'daki antik Agora ve mahkeme (Heliaia) bölgesidir.",
  },
];
