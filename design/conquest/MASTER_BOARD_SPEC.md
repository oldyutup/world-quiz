# Kuşatma · Master Map Board üretim şartnamesi

Bu klasör yalnızca **tasarım kaynağıdır**. Buradaki hiçbir dosya runtime'a
import edilmez; amaç, Kuşatma tahtasının arka plan görselini (Master Map Board)
mevcut Türkiye SVG'siyle birebir hizalı üretmek için sabit bir referans vermek.

Runtime tarafında hiçbir CSS, React bileşeni, oyun layout'u, Türkiye SVG
yerleşimi veya hit-test **değişmez**. Bu şartname yalnızca tahtanın altına
girecek görseli nasıl çizeceğini/üreteceğini anlatır.

## Dosyalar

| Dosya | Ne işe yarar |
|---|---|
| `master-board-guide.svg` | Çizim/üretim rehberi: Türkiye silhouette + bölge sınırları + Türkiye dışı "board background" bölgesi + (silinecek) overlay not katmanı. |
| `master-board-turkey-mask.svg` | Üretim maskesi: Türkiye içini tamamen kaplayan temiz beyaz alan. Final görselde Türkiye içindeki yanlış AI kıyı/terrain detaylarını temizlemek/knock-out etmek için. |
| `MASTER_BOARD_SPEC.md` | Bu dosya. |

## Koordinat sistemi (pazarlık konusu değil)

- viewBox: **`0 0 1005 490`** (runtime Türkiye SVG'siyle aynı).
- En/boy oranı: **1005 / 490 ≈ 2.051 : 1**.
- Geometri kaynağı: `src/modes/conquest/maps/turkey-regions.ts`
  (`TURKEY_CONQUEST_REGION_PATHS`, 25 bölge path'i). Runtime terrain texture'ı
  da bu 25 path'in birleşimi (union) üzerinden stamp edilir; silhouette ve maske
  birebir bu union'dır, yeniden türetilmez.
- Kara kütlesinin gerçek bounding box'ı (1005×490 içinde):
  **x ≈ 16.8, y ≈ -0.2, genişlik ≈ 990.7, yükseklik ≈ 443.1**
  (sağ kenar ≈ 1007.5, alt kenar ≈ 442.8).
  Van/Hakkari köşesi sağ kenarda 1005'i birkaç birim aşar; bu kasıtlıdır ve
  runtime'da `.cq-turkey-map-svg { overflow: visible }` ile karşılanır. Üretilen
  görsel de bu taşmayı kırpmamalı.

## Çözünürlük (1005×490'ın tam katı)

Master eşleşme kaynağı **tam tamsayı katı** olmalı; rastgele yuvarlanmış
ölçüler (eski 4096×1997, 2560×1248) kullanılmaz, çünkü birim başına piksel
kesirli olur ve SVG ile birebir register bozulur.

- Source (üretim) çözünürlüğü: **4020 × 1960 px** PNG = **tam 4×** (1005×4, 490×4).
- Runtime export hedefi: **3015 × 1470 px** WebP = **tam 3×** (1005×3, 490×3).
- 1 SVG birimi = source'ta **tam 4 px**, runtime WebP'sinde **tam 3 px**. Maskedeki
  ~1.2 birimlik beyaz kontur source'ta ~4.8 px, runtime'da ~3.6 px; coğrafi hizayı
  bozmaz. Başka çözünürlük gerekirse yalnız 1005×490'ın tam katı seçilir
  (örn. 2× = 2010×980, 5× = 5025×2450).

## Katman sırası (arkadan öne)

1. **Board background** ← *üretilecek Master Map Board görseli budur.*
   Türkiye dışındaki ambient deniz/atmosfer + Türkiye içindeki (maskeyle
   temizlenmiş) zemin. Tahtanın en alt katı.
2. **Türkiye terrain SVG** (runtime, mevcut). 25 bölge path'i + terrain PNG
   pattern; `opacity: 0.82` ile yarı saydam, yani altındaki board background
   Türkiye içinde de bir miktar görünür. Maskenin sebebi budur: alttaki
   görselde Türkiye içinde yanlış bir kıyı/terrain olursa gerçek terrain'le
   çakışıp "çift coğrafya" hissi verir.
3. **Ownership renkleri / border** (runtime, mevcut). Bölge sahiplik dolguları
   ve renkli kenarlar.
4. **Marker / label** (runtime, mevcut). Etiket, puan rozeti, bonus ikonu,
   oyuncu adı, FX katmanları.

> 2, 3 ve 4 mevcut runtime SVG katmanında **kalır**. Master Map Board yalnızca
> 1. katı (board background) besler.

## Üretim akışı

1. `master-board-guide.svg`'yi 4020×1960'a (tam 4×) ölçekleyip altlık olarak aç.
   Silhouette + bölge sınırları Türkiye'nin nereye oturduğunu birebir gösterir.
2. Board background görselini bu altlığa göre boya/üret: Türkiye dışı = ambient
   deniz/atmosfer; Türkiye içi = sade, gerçek terrain'le çakışmayan bir zemin.
3. `master-board-turkey-mask.svg`'yi knock-out maskesi olarak uygula: Türkiye
   içindeki yanlış AI kıyı/terrain detaylarını temizle (aşağıdaki konvansiyon).
4. 4020×1960 PNG olarak dışa ver, sonra 3015×1470 (tam 3×) WebP'ye optimize et.
5. Bu WebP, mevcut Türkiye SVG'sinin **altına** board background olarak girer.
   SVG dokunulmadan kalır.

İlk PoC bu akışın prosedürel uygulamasıdır; bkz. `board/build-board.mjs`
(geometriyi `turkey-regions.ts`'ten parse eder, board-source.svg → 4020×1960 PNG
→ 3015×1470 WebP üretir, clean + diagnostic overlay çıkarır).

## Maske konvansiyonu (`master-board-turkey-mask.svg`)

- **Beyaz (`#ffffff`) = Türkiye içi** = korunacak/temizlenecek alan. Türkiye
  içindeki yanlış AI terrain'i knock-out etmek için bu alanı kullan; gerçek
  bölge SVG'si üstüne temiz otursun.
- **Saydam = board background** (Türkiye dışı ambient deniz). Olduğu gibi geçer.
- Maske saf `#ffffff` + saydam ile çizilir. Maske dosyasında temiz luminance/alpha
  kenarı gerektiği için marka "saf beyaz kullanma" kuralı burada **geçerli
  değildir**; bu teknik bir asset, marka yüzeyi değil.
- Göllerin (Tuz Gölü, Van Gölü, Marmara koyları) `evenodd` ile delik olarak
  kalması kasıtlıdır; runtime geometrisiyle birebir aynıdır. Gerekirse
  compositor'da maskeyi tersine çevirip "hide" maskesi olarak kullan.

## Hizalama kuralları (kritik)

- **Desktop'ta board `contain` ile görünür.** SVG `preserveAspectRatio="xMidYMid meet"`;
  desktop sarmalayıcı `width: min(100%, calc((100dvh - 150px) * 1005 / 490))` +
  `aspect-ratio: 1005 / 490`. Yani tahta, kullanılabilir yüksekliğe sığacak
  şekilde oranı korunarak **tam görünür**; kırpılmaz. Tahtanın dışında kalan
  ekran alanı yalnızca ambient olabilir.
- **Mobilde aynı board tam genişlikte, doğal oran korunarak** kullanılır
  (`width: 100%`, `height: auto`). Oran her iki yüzeyde de 1005/490'dır.
- **Generic viewport `cover` ile hizalama YAPILMAZ.** Board background görseli
  ekrana `cover` ile yayılıp SVG'yle hizalanmaya çalışılmaz; görsel 1005×490
  koordinat sisteminde, SVG ile aynı kutuya `contain` mantığıyla oturur.
- **Türkiye SVG'si asset üzerinde yeniden konumlandırılmaz.** Görsel SVG'ye göre
  üretilir; SVG görsele göre kaydırılmaz/ölçeklenmez.
- Türkiye içindeki terrain, sahiplik renkleri, sınırlar, marker'lar ve hit-test
  mevcut SVG katmanında kalır; board background bunların hiçbirini taşımaz.

## Rehber dosyasındaki not katmanı

`master-board-guide.svg` içindeki `#guide-annotations` grubu (safe margin,
header/soru-kartı/side-panel overlay bölgeleri) yalnızca rehberdir. Bu
overlay'ler runtime'da tahtayı **yeniden boyutlandırmaz**; DOM olarak tahtanın
üstünde yüzer. Bu yüzden bölge işaretleri, "buraya UI gelebilir, kritik
coğrafyayı altına gizleme" uyarısıdır. Final görseli dışa verirken
`#guide-annotations` grubunu **sil/gizle**; o iskele, sanat değil.

Rehberin içinde etiket, puan rozeti, bonus ikonu, oyuncu adı, marker veya
interaktif katman **yoktur** ve eklenmemelidir.

## Teknik risk · doğu kenarı taşması (gelecek runtime entegrasyonu)

Türkiye geometrisinin **doğu kenarı viewBox'ı aşar**: kara kütlesinin sağ
sınırı ≈ **x 1007.5**, yani `1005`'in ~2.5 birim dışına (Van/Hakkari/Iğdır
köşesi) taşar. Runtime'da bu, `.cq-turkey-map-svg { overflow: visible }` ile
zaten karşılanıyor ve **Türkiye SVG'sinin x/y/width/height'i veya layout'u bu
yüzden DEĞİŞMEYECEK**.

Sonuç (board background entegrasyonunda dikkat): board görseli tam `1005×490`
kadrajında biterse, doğu kenarındaki bu ~2.5 birimlik kara, board'un sağ
kenarında deniz/zemin olmadan asılı kalabilir. Bu yüzden gelecekte runtime
entegrasyonu yapılırken board background:

- doğu (ve emniyet için dört) kenarında **küçük bir dış bleed güvenlik payı**
  taşımalı (örn. board görselini `1005×490` yerine her kenardan ~6–10 birim
  taşan bir kadrajda üretip ortalamak, ya da CSS'te board katmanını birkaç
  piksel `inset: -Npx` ile genişletmek). Böylece doğu taşması her zaman board
  zemini üstünde kalır, kenarda kesik görünmez.
- Bu pay yalnız **board background katmanını** etkiler; Türkiye SVG'nin
  koordinat sistemi, boyutu, konumu ve hit-test'i **olduğu gibi kalır**.
- Mevcut PoC bilinçli olarak tam `1005×490` kadrajındadır (taşma kırpılmaz,
  `diagnostic` overlay'de magenta maske çizgisinin sağ kenara değdiği görülür);
  bleed payı entegrasyon adımının işidir, asset üretiminin değil.

## Yeniden üretim

`turkey-regions.ts` değişirse silhouette ve maske de güncellenmeli. İkisi de
o dosyadaki path'lerden türetilir; geometriyi elle kopyalama. (Bu iki SVG, src
dışındaki tek seferlik bir parser script'iyle üretildi; runtime kaynaklarına
dokunulmadı.)
