/**
 * cizimTestWords.ts — Çizim Test kelime havuzu.
 *
 * Modun eğlencesi birbirine BENZEYEN şeyleri çizip ayırt etmeye çalışmak;
 * bu yüzden havuz düz bir liste değil, "tema kümeleri"nden oluşur. Maç
 * seçici her maçta 3-4 kümeden 2-4'er kelime alır: aynı maçta hem kafa
 * karıştıran benzerler (futbol topu / voleybol topu) hem de çeşitlilik olur.
 *
 * Genişletme: yeni küme eklemek ya da mevcut kümeye kelime eklemek yeterli —
 * seçici otomatik uyum sağlar. Kelimeler 10 sn'de mouse'la çizilebilir
 * olmalı; soyut kavramlardan kaçının.
 */

export interface CizimWordCluster {
  id: string;
  /** İnsan-okur etiket (şimdilik yalnız geliştirici/debug için). */
  label: string;
  words: string[];
}

export const CIZIM_WORD_CLUSTERS: readonly CizimWordCluster[] = [
  {
    id: "toplar",
    label: "Toplar",
    words: [
      "Futbol topu",
      "Basketbol topu",
      "Voleybol topu",
      "Tenis topu",
      "Bowling topu",
      "Plaj topu",
      "Rugby topu",
    ],
  },
  {
    id: "kalem-kozmetik",
    label: "Kalem & Kozmetik",
    words: [
      "Kurşun kalem",
      "Tükenmez kalem",
      "Keçeli kalem",
      "Ruj",
      "Rimel",
      "Oje",
      "Makyaj fırçası",
    ],
  },
  {
    id: "beyaz-esya",
    label: "Ev Aletleri",
    words: [
      "Çamaşır makinesi",
      "Bulaşık makinesi",
      "Kurutma makinesi",
      "Mikrodalga",
      "Fırın",
      "Buzdolabı",
      "Klima",
      "Televizyon",
      "Kamera",
    ],
  },
  {
    id: "ilginc-ikizler",
    label: "İlginç İkizler",
    words: [
      "Yumurta",
      "Kızarmış patates",
      "Tırnak",
      "Jüpiter",
      "Dolunay",
      "Muz",
      "Hilal",
    ],
  },
  {
    id: "yuvarlaklar",
    label: "Yuvarlak Şeyler",
    words: [
      "Portakal",
      "Simit",
      "Pizza",
      "Saat",
      "Bilye",
      "Donut",
      "Kurabiye",
    ],
  },
  {
    id: "kaplar",
    label: "İçecek Kapları",
    words: [
      "Çay bardağı",
      "Kupa",
      "Kadeh",
      "Termos",
      "Pet şişe",
      "Fincan",
    ],
  },
  {
    id: "basliklar",
    label: "Başlıklar",
    words: ["Şapka", "Bere", "Kasket", "Taç", "Kask", "Silindir şapka"],
  },
  {
    id: "ucanlar",
    label: "Uçanlar",
    words: [
      "Uçak",
      "Helikopter",
      "Roket",
      "Uçurtma",
      "Uçan balon",
      "Drone",
      "Kelebek",
    ],
  },
  {
    id: "deniz",
    label: "Deniz Canlıları",
    words: [
      "Balık",
      "Yunus",
      "Köpekbalığı",
      "Balina",
      "Denizanası",
      "Ahtapot",
      "Yengeç",
    ],
  },
  {
    id: "oturaklar",
    label: "Oturulacak Şeyler",
    words: [
      "Sandalye",
      "Koltuk",
      "Tabure",
      "Salıncak",
      "Sallanan koltuk",
      "Puf",
    ],
  },
];

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Bir maç için kelime seç. Karışık sırada 3-4 kümeden 2-4'er kelime toplar;
 * böylece benzerlik (küme içi) ile çeşitlilik (kümeler arası) dengelenir.
 * Host çağırır ve sonucu broadcast eder — deterministik olması gerekmez.
 */
export function pickCizimWords(count = 10): string[] {
  const clusters = shuffleInPlace([...CIZIM_WORD_CLUSTERS]);
  const picked: string[] = [];

  for (const cluster of clusters) {
    if (picked.length >= count) break;
    const take = Math.min(
      2 + Math.floor(Math.random() * 3), // kümeden 2-4 kelime
      count - picked.length,
      cluster.words.length,
    );
    const words = shuffleInPlace([...cluster.words]);
    picked.push(...words.slice(0, take));
  }

  // Havuz yeterince büyük olduğundan normalde dolmuştur; yine de güvence:
  if (picked.length < count) {
    const leftovers = shuffleInPlace(
      CIZIM_WORD_CLUSTERS.flatMap((c) => c.words).filter(
        (w) => !picked.includes(w),
      ),
    );
    picked.push(...leftovers.slice(0, count - picked.length));
  }

  return shuffleInPlace(picked.slice(0, count));
}
