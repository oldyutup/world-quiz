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
    id: "map_001_1453_istanbul_siege",
    yearLabel: "1453",
    eventLabel: "İstanbul Kuşatması",
    panorama:
      "/assets/history/cag-dedektifi/scene_001_1453_istanbul_360_modern_soldier_4096.jpg",
    location: {
      lat: 41.0136,
      lng: 28.955,
      placeLabel: "İstanbul, Türkiye",
    },
    scoreCurve: {
      maxScore: 1000,
      scaleKm: 750,
    },
    explanation:
      "1453 İstanbul Kuşatması, Konstantinopolis'in kara surları ve Tarihi Yarımada çevresinde gerçekleşen Osmanlı kuşatmasıdır.",
  },
  {
    id: "map_002_giza_pyramids_construction",
    yearLabel: "M.Ö. 2500",
    eventLabel: "Giza Piramitleri'nin İnşası",
    // TODO: Giza için özel panorama asset'i eklendiğinde güncellenecek.
    panorama:
      "/assets/history/cag-dedektifi/scene_003_ancient_egypt_pyramid_hilti_360.jpg",
    location: {
      lat: 29.9792,
      lng: 31.1342,
      placeLabel: "Giza Piramitleri, Mısır",
    },
    scoreCurve: {
      maxScore: 1000,
      scaleKm: 450,
    },
    explanation:
      "Giza Piramitleri, günümüzde Kahire'nin batısındaki Giza Platosu'nda yer alır. Harita tahmininde referans nokta bu fiziksel konumdur.",
  },
  {
    id: "map_003_1800s_paris_streets",
    yearLabel: "1800'ler",
    eventLabel: "Paris Sokakları",
    panorama:
      "/assets/history/cag-dedektifi/scene_002_1800s_france_black_car_360_8k.jpg",
    location: {
      lat: 48.8566,
      lng: 2.3522,
      placeLabel: "Paris, Fransa",
    },
    scoreCurve: {
      maxScore: 1000,
      scaleKm: 750,
    },
    explanation:
      "19. yüzyıl Paris sahnesi için referans konum Paris şehir merkezidir. Oyuncudan tam sokak noktasını değil, sahnenin geçtiği şehri ve bölgeyi doğru tahmin etmesi beklenir.",
  },
  {
    id: "map_004_berlin_wall",
    yearLabel: "1961–1989",
    eventLabel: "Berlin Duvarı",
    // TODO: Berlin Duvarı için özel panorama asset'i eklendiğinde güncellenecek.
    panorama:
      "/assets/history/cag-dedektifi/scene_001_1453_istanbul_360_modern_soldier_4096.jpg",
    location: {
      lat: 52.5076,
      lng: 13.3904,
      placeLabel: "Berlin Duvarı, Berlin, Almanya",
    },
    scoreCurve: {
      maxScore: 1000,
      scaleKm: 550,
    },
    explanation:
      "Berlin Duvarı, Soğuk Savaş döneminde Berlin'i bölen tarihî sınır hattıdır. Referans nokta Berlin'de duvarın sembolik merkezî bölgelerinden biridir.",
  },
];
