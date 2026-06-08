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
    id: "map_001_giza_pyramids_construction",
    yearLabel: "MÖ 2560",
    eventLabel: "Giza Piramitlerinin İnşası",
    panorama:
      "/assets/history/harita-dedektifi/map_001_ancient_egypt_giza_pyramids_construction_4096.jpg",
    location: {
      lat: 29.9792,
      lng: 31.1342,
      placeLabel: "Giza Platosu, Mısır",
    },
    scoreCurve: {
      maxScore: 5000,
      scaleKm: 350,
    },
    explanation:
      "Bu sahne, Antik Mısır'da Giza Platosu'nda piramitlerin inşa sürecini temsil eder. Doğru coğrafi referans noktası bugünkü Giza Piramitleri bölgesidir.",
  },
];
