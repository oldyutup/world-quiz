---
name: Torble
description: Dünya haritası temelli, çok modlu coğrafya quiz oyunu — gece gökyüzü estetiğinde, parıltıyla canlanan koyu bir arayüz. Masaüstü/web frozen; mobil/native yüzeyler sıcak "gece atlası / keşif defteri" yönüne evriliyor (bkz. §1.1–§1.2).
colors:
  bg: "#0d1117"
  surface: "#161b22"
  surface2: "#21262d"
  surface3: "#2d333b"
  border: "#30363d"
  text: "#e6edf3"
  muted: "#7d8590"
  accent: "#58a6ff"
  green: "#3fb950"
  red: "#f85149"
  amber: "#f59e0b"
  ocean: "#0d2137"
  land: "#1e2d40"
  land-stroke: "#2a3e55"
  guessed: "#3b82f6"
  guessed-last: "#22c55e"
typography:
  display:
    fontFamily: "Bebas Neue, sans-serif"
    fontSize: "clamp(1.5rem, 4vw, 3.2rem)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.05em"
  body:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.2px"
rounded:
  sm: "6px"
  md: "9px"
  lg: "14px"
  xl: "16px"
  pill: "999px"
spacing:
  xs: "5px"
  sm: "8px"
  md: "14px"
  lg: "22px"
components:
  button-accent:
    backgroundColor: "{colors.accent}"
    textColor: "#000000"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 15px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 11px"
  button-danger:
    backgroundColor: "{colors.red}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 15px"
  mode-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "22px 18px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 13px"
  modal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "28px 24px 22px"
---

# Design System: Torble

## 1. Overview

**Creative North Star: "Gece Gökyüzü Atlası"**

Torble bir gece gökyüzü atlasıdır. Karanlık, derin bir uzay-laciverti zemin üzerinde süzülen bir dünya, yıldız tozu serpintileri ve etkileşim anında uyanan mavi/yeşil parıltılar. His; bir teleskobun başında, "şurası neresiymiş?" merakıyla geçirilen sakin ama keşif dolu bir gece. Zemin sessiz ve koyu durur ki üzerindeki dünya, bayraklar ve oyuncunun her doğru hamlesi parlasın. Arayüz öğretmez, yanına alıp gezdirir.

Sistem koyu bir tonal katmanlama üzerine kuruludur: `bg → surface → surface2 → surface3` adımları derinliği gölgeyle değil, ton farkıyla kurar. Renk **ölçülüdür (restrained)**: kimliği ve birincil eylemi tek bir mavi (`#58a6ff`) taşır; yeşil, kırmızı ve kehribar yalnızca anlam (doğru / yanlış / ödül) için ayrılmıştır, dekorasyon için asla. Tipografi sıkıştırılmış Bebas Neue başlıklar ile sıcak-nötr DM Sans gövde arasındaki güçlü kontrasttan beslenir. Hareket; sakin, yumuşak ve ease-out; yalnızca kutlama anlarında (doğru tahmin, ödül) hafif bir taşma/zıplama kendine izin verir.

Bu sistem `PRODUCT.md`'deki anti-referansları görsel olarak reddeder: ucuz/spam mobil oyunların parlak gradyan ve agresif pop-up gürültüsü yok; aşırı ciddi sınav yazılımının kuru griliği yok; kalabalık, her yeri bağıran bir UI yok; ve birbirinin aynı kart ızgaralı, ruhsuz kurumsal/SaaS dashboard hissi yok.

> **Önceki kısıt — ARTIK GEÇERSİZ:** Eskiden sıcaklaştırma yalnızca profil yüzeyleriyle sınırlıydı; ana menü, oyun kartları ve ekranlar bilinçli olarak "donuk" tutuluyordu. **Bu kısıt kaldırıldı.** Yeni kapsam ve yön §1.1–§1.2'dedir. Aşağıdaki §2–§6 kanonik sistemi **masaüstü/web için** referans olmaya devam eder.

### 1.1 Kapsam — Neyin Değiştiği

**Donuk / dokunulmaz — Masaüstü & geniş web.** Mevcut desktop/web deneyimi bütünüyle **frozen**. Bu dokümandaki kanonik tokenlar (§2–§6) web yüzeyleri için aynen geçerlidir; web bu çalışmada DEĞİŞMEZ.

**Açık çalışma alanı — Mobil / dar viewport (≤600px) & native-app oyun yüzeyleri.** Yeniden ele alınabilir: ana menü (MobileHome), mod kartları, mod seçimleri, modal'lar ve oyun-içi HUD'lar.

**Korunan çekirdek (değişmez).** Oyun kuralları, mod mantıkları, harita altyapısı, mevcut bilgi mimarisi ve temel navigasyon. Görsel sistem değişir, akış/IA değişmez.

**Değişebilen yüzey.** Renk tokenları, yüzey derinliği/katmanlama, tipografi, başlık dili, buton hiyerarşisi, HUD düzeni ve mikro etkileşimler.

> §1.2'deki yön, koda dökülmeden önce ayrı bir tasarım turunda (critique → shape) somut tokenlara çevrilecektir. §2–§6'daki sayılar bu aşamada **web kanonu**dur, mobil için yeniden kalibre edilebilecek başlangıç noktasıdır.

### 1.2 Mobil/Native Hedef Yön — "Gece Atlası / Keşif Defteri"

North Star sıcaklaşarak evrilir: gökyüzü atlası kalır ama bir **keşif defteri** sıcaklığı kazanır. Koyu tema korunur; ancak yüzeyler daha **sıcak, daha katmanlı ve daha canlı** olur. Harita arka plan değil, **oyun alanı** gibi okunmalı.

**Bugünkü sorun.** Koyu lacivert-mavi sistem teknik olarak temiz ama fazla **soğuk** ve **düşük enerjili**; yer yer kurumsal dashboard / harita aracı hissi veriyor. Harita güçlü olsa da arka plan gibi algılanabiliyor.

**Sıcaklık yönü (yön, kesin token DEĞİL).**
- **Yüzeyler:** Tek-ton soğuk laciverdden, hafifçe sıcağa kaçan **katmanlı koyu yüzeylere**; tonal derinlik korunur ama daha okunur ve daha az "araç" hisli olur.
- **Vurgu adayları:** Kontrollü **atlas-parşömen**, **turkuaz**, **mercan**, **güneş tonu**. Bunlar keşfedilecek yön adaylarıdır; final palet critique/shape turunda kararlaşır. **Tek Ses Kuralı korunur:** bir kimlik sesi + anlam renkleri; "her şey renkli" değil.
- **Yasaklar (sürer + güçlenir):** çocukça/ucuz mobil-oyun estetiği YOK; generic neon-gradient dili YOK; sahte premium / dekoratif cam YOK. Premium his **özen + katmandan** gelir.

**HUD & düzen prensipleri (referans: Ülke Yaz mobil ekranı).**
- **Tek net birincil eylem.** Geri / dünya bilgisi / sayaç / ayar / mod seçimi / Serbest–Süreli kontrolleri **aynı anda eşit ağırlık taşımamalı**. Ana aksiyon görsel olarak öne çıkmalı; ikincil kontroller gruplanmalı/gizlenmeli. Üst HUD sadeleşmeli.
- **Ölü state'i öldür.** "Önce bir mod seç" gibi pasif/ölü ifadeler yerine **davetkâr, yönlendiren bir başlangıç hali** (boş durum bir keşif daveti gibi okunmalı, eksik bir form gibi değil).
- **Serbest/Süreli entegrasyonu.** Bu ayrım genel görsel dilden kopuk durmamalı; dile oturmuş, net bir **segment kontrolü** olmalı (anlam yalnız renge değil, etiket/ikona da dayanmalı — bkz. erişilebilirlik).

**Tipografi tutarlılığı.** Modal başlıklarındaki condensed/display (Bebas Neue) ile genel gövde (DM Sans) arasındaki **kopukluk hissi** giderilmeli. "Sayılar Bebas, Cümleler DM" kuralı korunur; display **"büyük an"** (skor, sayaç, kahraman başlık) anlarına ayrılır; başlık/etiket hiyerarşisi DM Sans ile ölçek-ağırlık üzerinden tutarlı kurulur. Amaç: iki font tek bir sese hizmet etsin, iki ayrı sistem gibi çarpışmasın.

**Key Characteristics:**
- Gece gökyüzü / uzay atmosferi: koyu lacivert zemin, yıldız alanı, süzülen dünya logosu.
- Tonal katmanlı derinlik (4 yüzey adımı), gölge değil ton.
- Tek-ses renk stratejisi: mavi kimlik + anlam-yüklü yeşil/kırmızı/kehribar.
- Bebas Neue (sıkış. başlık) × DM Sans (gövde) güçlü ölçek kontrastı.
- Parıltıyla canlanan etkileşim: hover/focus'ta glow halkaları.
- Sakin ease-out hareket; coşku yalnızca kutlamada.

## 2. Colors

Koyu, lacivere çalan nötrler üzerine tek bir parlak mavi kimlik ve anlam için ayrılmış üç sinyal rengi.

### Primary
- **Gökyüzü Mavisi** (`#58a6ff`): Kimliğin ve birincil eylemin sesi. Birincil butonlar, skor sayıları, aktif/seçili durumlar, focus halkaları ve hover vurgusu. Üzerine her zaman siyah metin (`#000`) gelir; mavi yeterince parlaktır.
- **Tahmin Mavisi** (`#3b82f6`): Haritada tahmin edilmiş/işaretlenmiş ülkelerin dolgusu. Kimlik mavisinden ayrı tutulur ki "eylem" ile "durum" karışmasın.

### Secondary (anlam sinyalleri)
- **Doğru Yeşili** (`#3fb950`, son hamle `#22c55e`): Yalnızca başarı/onay. Doğru cevap, tamamlanma, paylaşım onayı. Dekoratif kullanımı yasak.
- **Hata Kırmızısı** (`#f85149`): Yalnızca hata, tehlike, yıkıcı eylem (sil/çık). Uyarı tonunu asla kimlik rengi gibi yaymaz.
- **Ödül Kehribarı** (`#f59e0b`): Gold/ödül, "en iyi skor", "Çok Yakında" rozetleri. Para birimi ve değer sinyali.

### Neutral (gece yüzeyleri)
- **Uzay Zemini** (`#0d1117`): En arka kat; tüm uygulamanın gece-laciveri tabanı.
- **Yüzey** (`#161b22`): Kartlar, modallar, control-bar; içeriğin oturduğu birincil yüzey.
- **Yüzey-2 / Yüzey-3** (`#21262d` / `#2d333b`): Yükselen katmanlar; pill'ler, geri butonu, ikincil yüzeyler.
- **Kenar** (`#30363d`): İnce 1–1.5px ayrım çizgileri ve dinlenmedeki kart kenarları.
- **Metin** (`#e6edf3`): Birincil metin; saf beyaz değil, hafif mavi-soğuk.
- **Sönük** (`#7d8590`): İkincil metin, açıklamalar, pasif ikonlar.

### Harita Renkleri (özel alan)
- **Okyanus** (`#0d2137`), **Kara** (`#1e2d40`), **Kara Çizgisi** (`#2a3e55`): Yalnızca dünya haritasının kendi içinde; genel UI paletinden ayrı, kıtaları gece denizinde okutmak için kalibre edilmiştir.

### Named Rules
**Tek Ses Kuralı.** Kimlik ve birincil eylem yalnız **Gökyüzü Mavisi**'yle konuşur. Yeşil, kırmızı ve kehribar **yalnızca anlam** taşır (doğru/yanlış/ödül); bir kartı süslemek, bir başlığı renklendirmek ya da "canlılık katmak" için asla kullanılmaz. Bir ekranda ikinci bir "kimlik rengi" belirdiyse, kural çiğnenmiştir.

**Parıltı Renk Değil Kuraldır.** `accent-glow`/`green-glow`/`red-glow` (ör. `rgba(88,166,255,.22)`) birer renk değil, durum geri bildirimidir. Yalnızca focus, hover ve kutlama anlarında belirir; dinlenmedeki bir yüzeye boyanmaz.

## 3. Typography

**Display Font:** Bebas Neue (yedek: sans-serif)
**Body Font:** DM Sans (yedek: sans-serif)
**Label Font:** DM Sans (600, hafif letter-spacing)

**Character:** Sıkıştırılmış, büyük-harf enerjisindeki Bebas Neue başlıklar, sakin ve okunaklı DM Sans gövdeyle yan yana güçlü bir ölçek kontrastı kurar. Bebas; skorlara, sayaçlara ve büyük yüzdelere "stadyum skorbordu" havası verir; DM Sans her şeyi sıcak ve net tutar. İkisi arasındaki kontrast hiyerarşinin motorudur, dekorasyon değil.

### Hierarchy
- **Display / Skor** (Bebas Neue, ~3.2rem, line-height 1): Modal skor sayıları (`.ms-num`), büyük yüzdeler. Oyunun "büyük an" tipografisi.
- **Headline / Modal Başlık** (Bebas Neue, ~2rem, letter-spacing .05em): Modal başlıkları (`.modal-title`).
- **Title / Kart Başlık** (Bebas Neue, ~1.5rem, letter-spacing .05em): Mod kartı başlıkları (`.mode-card-title`), skor pill sayıları (~1.35rem).
- **Body** (DM Sans, 400, 1rem, line-height 1.45): Açıklamalar, paragraflar, genel metin. Satır uzunluğu uzun metinlerde 65–75ch ile sınırlanmalı. Mobilde girdiler `max(16px, 1rem)` ile iOS zoom'unu engeller.
- **Label** (DM Sans, 600, ~.78rem, letter-spacing .2px): Buton metni, pill etiketleri, rozetler, sönük üst-bilgi.

### Named Rules
**Sayılar Bebas, Cümleler DM Kuralı.** Sayısal/kahraman öğeler (skor, sayaç, yüzde, başlık) Bebas Neue ile; okunacak her şey (açıklama, cümle, form) DM Sans ile. Bebas asla bir paragrafa, DM Sans asla dev bir skora konmaz.

**16px Taban Kuralı.** Hiçbir girdi (input/textarea/select) mobilde 16px'in altına düşmez; aksi halde iOS odakta sayfayı zoom'lar. Bu pazarlık konusu değildir.

## 4. Elevation

Torble **hibrit** bir derinlik sistemidir: dinlenmede **tonal katmanlama**, etkileşimde **parıltı**, yüzen yüzeylerde **derin ortam gölgesi**. Düz yüzeyler birbirinden gölgeyle değil, `bg → surface → surface2 → surface3` ton adımları ve 1–1.5px `border` ile ayrılır. Gölge yalnızca gerçekten "yüzen" bir şey için devreye girer.

### Shadow Vocabulary
- **Yüzen Modal** (`box-shadow: 0 24px 60px rgba(0,0,0,.6)`): Modallar ve tam-overlay paneller; sahneden tamamen koparır.
- **Kalkık Panel** (`box-shadow: 0 8px 24px rgba(0,0,0,.5)` / `0 4px 16px rgba(0,0,0,.4)`): Dropdown'lar, harita kontrolleri, küçük açılır paneller.
- **Kart Hover Parıltısı** (`box-shadow: 0 12px 36px rgba(88,166,255,.15)`): Mod kartı hover'da yukarı kalkar (`translateY(-3px)`) ve altına mavi bir hale düşer.
- **Focus/Durum Halkası** (`box-shadow: 0 0 0 3px var(--accent-glow)` / `--green-glow` / `--red-glow`): Girdi ve buton focus'u, doğru/yanlış geri bildirimi. Yapısal, durum-tetiklemeli.

### Named Rules
**Önce Ton, Sonra Gölge Kuralı.** Yeni bir yüzeyi ayırmak için ilk araç ton adımı + ince kenardır, gölge değil. Gölge yalnızca öğe sahnenin üstünde "yüzüyorsa" (modal, dropdown) kullanılır. Dinlenmedeki kartlara dekoratif drop-shadow eklenmez.

**Cam Yalnız Harita Kuralı.** `backdrop-filter: blur(...)` (glassmorphism) yalnızca harita/oyun üstü yüzen kontrollerde (zoom, tema paneli, modal backdrop) amaçlıdır. Yeni bileşenlerde dekoratif cam efekti varsayılan DEĞİLDİR.

## 5. Components

Component felsefesi: **net, parıltıyla canlanan.** Yüzeyler dinlenmede sakin ve koyu durur; dokunma/odak/hover anında mavi ya da yeşil bir glow ile hayat bulur. Tepki hızlıdır (`:active` → `scale(.97)`), gösteriş değil geri bildirim için.

### Buttons
- **Shape:** Yumuşak köşeler (9px, `--radius`); yükseklik 40px (sm: 33px), 1.5px şeffaf kenarlık.
- **Primary (accent):** Gökyüzü mavisi zemin + siyah metin; hover'da `0 0 0 3px accent-glow` halkası belirir.
- **Danger:** Kırmızı zemin + beyaz metin; hover'da kırmızı glow halkası.
- **Ghost:** Şeffaf zemin, `border` kenar, sönük metin; hover'da metin aydınlanır ve kenar `muted`'a kayar.
- **Share:** Yüzey-3 zemin; hover'da maviye, tamamlanınca yeşile döner.
- **Hover / Focus:** Glow halkası + `transform .1s`; bounce yok, ease-out.

### Cards / Containers (Mod Kartı = imza)
- **Corner Style:** 14px (mod kartı), genel kartlar 9–16px arası.
- **Background:** `surface`, 1.5px `border` kenar.
- **Shadow Strategy:** Dinlenmede gölgesiz (tonal); hover'da yukarı kalkar + mavi hale (bkz. Elevation).
- **Internal Padding:** 22px 18px (mobilde sıkışır, satır düzenine geçer).
- **"Çok Yakında" durumu:** `opacity .6` + `grayscale(.4)` + kehribar rozet; tıklanamaz olduğu görsel olarak nettir.

### Inputs / Fields
- **Style:** Koyu yüzey zemin, 1–1.5px `border`, 9px köşe, `text` rengi; placeholder `muted`.
- **Focus:** Kenar maviye döner + `0 0 0 3px accent-glow` halkası. Doğru cevapta yeşil halka + kısa `inputPulse`.
- **Disabled:** `opacity ~.38–.6`, `cursor: not-allowed`.
- **Mobil:** Font `max(16px, 1rem)`; dokunma hedefi ~36–54px.

### Navigation (Control Bar)
- **Style:** `surface` zemin, altında 2px `border` çizgi; dikey istiflenen satırlar (üst eylem + dropdown + alt bilgi).
- **Back butonu:** Yüzey-2 zemin, sönük metin; hover'da maviye. Etiket yalnız ≥480px'te görünür (mobilde sadeleşir).
- **Mobil/oyun-içi:** `gt-map-game` modunda gold-bar, dropdown ve alt satır gizlenir; harita en geniş alanı alır.

### Atmosfer (imza): Ana Ekran Temaları
Ana ekran 4 ayrı atmosfer arka planını destekler (`--earth`, `--dark-space`, `--adventure`, varsayılan): gradyan katmanlar + yıldız alanı + süzülen dünya logosu (`float` animasyonu, mavi drop-shadow). Bu, "Gece Gökyüzü Atlası" North Star'ının somut karşılığıdır.

### Takım Şeridi (sınırlı istisna)
Mavi/Kırmızı takım öğelerinde `box-shadow: inset 3px 0 0 ...` ile renkli bir sol şerit kullanılır. Bu, genel "yan-şerit yasağına" bilinçli ve **anlam-yüklü** bir istisnadır (takım kimliği) ve her zaman etiket/ikonla birlikte gelir. Yeni, dekoratif yan-şeritler için emsal DEĞİLDİR.

## 6. Do's and Don'ts

### Do:
- **Do** kimliği ve birincil eylemi yalnız **Gökyüzü Mavisi** (`#58a6ff`) ile taşı; yeşil/kırmızı/kehribarı yalnız anlam (doğru/yanlış/ödül) için kullan (Tek Ses Kuralı).
- **Do** derinliği önce tonla kur (`bg → surface → surface2 → surface3` + 1.5px kenar); gölgeyi yalnız yüzen öğeye sakla.
- **Do** etkileşimi parıltıyla bildir: focus/hover'da `0 0 0 3px *-glow` halkası, `:active`'te `scale(.97)`.
- **Do** sayıları Bebas Neue, cümleleri DM Sans ile diz; aralarındaki ölçek kontrastını koru.
- **Do** her girdiyi mobilde ≥16px font ile ver ve ~44px dokunma hedefini koru (WCAG AA + dokunma önceliği).
- **Do** `prefers-reduced-motion`'a uy: yıldız alanı, parıltı ve geçişleri sönümle.
- **Do** anlamı renkten bağımsız da ver: doğru/yanlış ve Mavi/Kırmızı takım ayrımı ikon/etiket/şekille de okunabilsin (renk körlüğü dostu).

### Don't:
- **Don't** ucuz/spam mobil oyun diline kay: agresif pop-up, sahte aciliyet, her köşede reklam, ucuz parlak gradyan YOK.
- **Don't** aşırı ciddi sınav/eğitim yazılımı kuruluğu üret: gri, neşesiz, cezalandırıcı "doğru/yanlış" tonu YOK.
- **Don't** bilgi kirliliği / kalabalık UI yarat: aynı anda bağıran onlarca rozet/buton/bildirim YOK; tek net birincil eylemi koru.
- **Don't** sıkıcı kurumsal/SaaS dashboard hissi ver: birbirinin aynı kart ızgaraları ve klişe "büyük rakam + küçük etiket" hero-metric şablonu YOK.
- **Don't** 1px'i aşan renkli yan-şerit (`border-left`/`inset` şerit) ekleme; takım kimliği şeridi tek istisnadır ve emsal değildir.
- **Don't** gradyanlı metin (`background-clip: text`) kullanma; vurgu ağırlık/boyutla verilir.
- **Don't** dekoratif cam/blur'ü varsayılan yapma; `backdrop-filter` yalnız harita/overlay yüzeylerinde.
- **Don't** yeni bir yüzeyde ilk düşünce olarak modal'a koşma; önce inline/kademeli alternatifleri tüket.
- **Don't** ikinci bir "kimlik rengi" icat etme; mavi tek sestir.
