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
    panorama: "/assets/history/harita-dedektifi/map_001_ancient_egypt_giza_pyramids_construction_4096.jpg",
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

  {
    id: "map_002_berlin_wall_fall",
    yearLabel: "1989",
    eventLabel: "Berlin Duvarı'nın Yıkılışı",
    panorama: "/assets/history/harita-dedektifi/map_002_berlin_wall_fall_4096.jpg",
    location: {
      lat: 52.5163,
      lng: 13.3777,
      placeLabel: "Brandenburg Kapısı çevresi, Berlin, Almanya",
    },
    scoreCurve: {
      maxScore: 5000,
      scaleKm: 500,
    },
    explanation:
      "Bu sahne, 1989'da Berlin Duvarı'nın yıkılışını temsil eder. Referans nokta olarak Berlin Duvarı'nın en ikonik bölgelerinden biri olan Brandenburg Kapısı çevresi alınmıştır.",
  },

  {
    id: "map_003_gobekli_tepe_ritual_life",
    yearLabel: "MÖ 9600",
    eventLabel: "Göbekli Tepe'de Ritüel Yaşam",
    panorama: "/assets/history/harita-dedektifi/map_003_gobekli_tepe_ritual_life_4096.jpg",
    location: {
      lat: 37.2231,
      lng: 38.9225,
      placeLabel: "Göbekli Tepe, Şanlıurfa, Türkiye",
    },
    scoreCurve: {
      maxScore: 5000,
      scaleKm: 450,
    },
    explanation:
      "Bu sahne, Şanlıurfa yakınlarındaki Göbekli Tepe'de erken Neolitik döneme ait ritüel yaşamı temsil eder. Doğru coğrafi referans noktası bugünkü Göbekli Tepe arkeolojik alanıdır.",
  },

  {
    id: "map_004_eiffel_tower_opening_1889",
    yearLabel: "1889",
    eventLabel: "Eiffel Kulesi'nin Açılışı",
    panorama: "/assets/history/harita-dedektifi/map_004_eiffel_tower_opening_1889_4096.jpg",
    location: {
      lat: 48.8584,
      lng: 2.2945,
      placeLabel: "Eiffel Kulesi, Paris, Fransa",
    },
    scoreCurve: {
      maxScore: 5000,
      scaleKm: 450,
    },
    explanation:
      "Bu sahne, 1889 Paris Dünya Fuarı döneminde Eiffel Kulesi çevresini temsil eder. Doğru coğrafi referans noktası bugünkü Eiffel Kulesi'nin bulunduğu Champ de Mars çevresidir.",
  },
];
