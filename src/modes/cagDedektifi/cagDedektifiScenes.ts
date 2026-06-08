export interface CagDedektifiTarget {
  label: string;
  category: string;
  yaw: number;
  pitch: number;
  radius: number;
}

export interface CagDedektifiScene {
  id: string;
  title: string;
  subtitle: string;
  task: string;
  panorama: string;
  timeLimitSeconds: number;
  maxWrongClicks: number;
  wrongClickPenalty: number;
  correctBaseScore: number;
  target: CagDedektifiTarget;
  explanation: string;
}

export const CAG_DEDEKTIFI_SCENES: CagDedektifiScene[] = [
  {
    id: "scene_001_1453_istanbul_modern_soldier",
    title: "1453 İstanbul Kuşatması",
    subtitle: "Zaman yolcusu geçmişte bir iz bıraktı.",
    task: "Sahnedeki anakronizmi bul.",
    panorama: "/assets/history/cag-dedektifi/scene_001_1453_istanbul_360_modern_soldier_4096.jpg",
    timeLimitSeconds: 60,
    maxWrongClicks: 3,
    wrongClickPenalty: 150,
    correctBaseScore: 1000,
    target: {
      label: "Modern asker",
      category: "Askerî anakronizm",
      yaw: 0,
      pitch: 0,
      radius: 12,
    },
    explanation:
      "Bu sahne 1453 İstanbul kuşatmasını temsil ediyor. Modern kamuflaj üniforması, balistik kask, taktik yelek ve modern tüfek taşıyan bu asker 21. yüzyıla aittir; 1453 yılında böyle bir askerî ekipman bulunamazdı.",
  },
  {
    id: "scene_002_1800s_france_black_car",
    title: "1800'ler Fransa",
    subtitle: "Zaman yolcusu geçmişte bir iz bıraktı.",
    task: "Sahnedeki anakronizmi bul.",
    panorama: "/assets/history/cag-dedektifi/scene_002_1800s_france_black_car_360_8k.jpg",
    timeLimitSeconds: 60,
    maxWrongClicks: 3,
    wrongClickPenalty: 150,
    correctBaseScore: 1000,
    target: {
      label: "Modern siyah otomobil",
      category: "Teknolojik anakronizm",
      yaw: 0,
      pitch: -12,
      radius: 22,
    },
    explanation:
      "Bu sahne 19. yüzyıl Fransa sokak hayatını temsil ediyor. Görseldeki modern siyah otomobil bu döneme ait değildir; ilk benzinli otomobiller 1880'lerin sonunda ortaya çıktı ve 1800'lerin sokaklarında at arabaları ve yaya trafiği hâkimdi.",
  },
  {
    id: "ancient_egypt_pyramid_hilti",
    title: "Antik Mısır'da Piramit İnşası",
    subtitle: "Zaman yolcusu geçmişte bir iz bıraktı.",
    task: "Sahnedeki anakronizmi bul.",
    panorama: "/assets/history/cag-dedektifi/scene_003_ancient_egypt_pyramid_hilti_360.jpg",
    timeLimitSeconds: 60,
    maxWrongClicks: 3,
    wrongClickPenalty: 150,
    correctBaseScore: 1000,
    target: {
      label: "Elektrikli hilti / modern kırıcı matkap",
      category: "Teknolojik anakronizm",
      yaw: -102,
      pitch: -62,
      radius: 18,
    },
    explanation:
      "Antik Mısır'da piramit inşasında taş, ahşap, halat, kızak, rampa ve basit el aletleri kullanılabilirdi. Sahnedeki kırmızı-siyah elektrikli hilti/kırıcı matkap ise modern döneme ait bir inşaat aletidir ve Gize platosunda bulunması imkânsızdır.",
  },
];
