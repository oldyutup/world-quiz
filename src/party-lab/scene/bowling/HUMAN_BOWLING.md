> Historical implementation notes. The current speed/angle rules and measurements are in [FLATOUT_REPORT.md](FLATOUT_REPORT.md); research is in [FLATOUT_RESEARCH.md](FLATOUT_RESEARCH.md). Power-meter descriptions below describe the preserved earlier implementation.

# Local İnsan Bowlingi: polish / redesign raporu

27 Eylül 2026. Bu rapor oturum başındaki çalışan V2 üzerine yapılan değişiklikleri anlatır. Başlangıç dosyalarının kopyası `/private/tmp/bowling-polish/before/` altında tutuldu. Mevcut uncommitted çalışma korundu. Commit, push ve deploy yapılmadı.

## 1. Ne değişti?

### Pist ve mesafeler

| Ölçü | Önce | Sonra |
|---|---:|---:|
| Arena uzunluğu × genişliği | 160 × 24 m | **252 × 24 m** |
| Sürüş/iniş hattı genişliği | 14 m | 14 m |
| Başlangıç | z=−60, yükseklik 10 m | z=−98, yükseklik **14 m** |
| Downhill | 38 m | **76 m**, z=−94…−18 |
| Düz yol | 40 m | **40 m**, z=−18…22 |
| Engellerden sonraki açık hazırlık | 16 m | 16 m, z=6…22 |
| Kicker | 7 m / 1,6 m yükselme | 7 m / 1,6 m yükselme, z=22…29 |
| Ramp exit → ilk labut | 50 m | **100 m**, z=29…129 |
| Rack konumu | z=79 | **z=129** |
| Arka sınır | z=96 | z=150 |
| Araç azami hızı | 18 m/s | **22 m/s (79,2 km/sa)** |

Akış: 14 m yüksek başlangıç → uzun iniş → engelli düz hazırlık → açık release bölgesi → küçük kicker → 100 m stunt hattı → rack. Düz bölgeyi sürüş çizgisini toparlamak için 40 m tuttum; yeni downhill bunun yaklaşık iki katı. Downhill giriş/çıkışındaki 2 m yumuşak geçişler ve görsel/çarpışma yüzeyinin ortak geometrisi korunuyor.

**Engeller:** iki labut kutusu ve ortada bevel yüzeyli foam splitter. Kutular daha geniş/uzun ve üzerlerinde low-poly labut işaretleri var. Çarpışma hız kaybettiriyor; bevel yüzeyler aracı kilitlemeden üzerinden/yanından geçmeye izin veriyor. Yan bariyer ve pad'ler fiziksel temas sağlıyor. Uçuş hattında yeni görünmez engel yok. Işık portalları, mesafe şeritleri, uzatılmış bariyerler, tribünler ve stunt panoları pistin uzunluğunu görünür kılıyor.

**Dört layout:** splitter x konumu −0,55 / 0 / +0,55 / +0,25 m; z konumu 1 veya 2,2 m. Fizik ve görsel aynı seed'i kullanıyor. Yeni maç/restart seed'i değiştiriyor; maç içindeki üç atış boyunca tüm oyuncular aynı layout'u görüyor. Bu, küçük ve öğrenilebilir bir varyasyon; tamamen rastgele engel dağılımı değil.

### Güç, açı ve slow motion

- Space basıldığı ilk presentation tick'inde dünya **0,40×** hızına geçer. Araç sürüşü ve yönlendirme devam eder.
- Güç, gerçek zamanda 1 saniyede %0→100 olur; ardından %100→55→100 salınır. Release tek kez fırlatır.
- Açı **12–55°**, başlangıç 25°, ayarlama hızı **24°/gerçek saniye**. Şarjdan önce ve şarj sırasında değişir.
- Yeni formül, aracın ileri momentumunu da seçilen açıya yönlendirir. Aracın yanal hızı korunur; ölçülen ramp yükseliş hızının %15'i dikey bileşene eklenir. Güç boost'u `0,6 + 13,4 × power^1,5` m/s.
- Release sonrası mevcut kısa kuyruk korunur: 0,15 s hold + 0,30 s easing. **0,45 gerçek saniyede 1×**. Temas daha erken olursa kuyruk biter. Uçuşun çoğu ve rack tepkisi normal hızdadır.
- Rapier adımı daima 1/60 s. Power/angle ve easing 240 Hz presentation saatinde; fizik timestep'i değiştirilmez.
- Esc, blur ve görünürlük kaybında şarj iptal edilir; menü arkasında release olmaz.

### Uçuş, iniş ve kayış

Beden hâlâ gerçek **9 rigid body / 8 joint** ragdoll. Fırlatmada ortak ileri dönüş alanı ve eklemleri zorlamayan `ω × r` parça hızları var. Gövde ile uçuş yönü ayrışıyor; kol/bacaklara küçük karşılıklı torklar uygulanıyor. Bu torklar kütle merkezine ileri itki eklemiyor. Sinüs fazları simülasyon saatinden geliyor; frame başına rastgele kuvvet yok. Pasif eklem limitleri ve CCD korunuyor.

A/D hava kontrolü **1,8 m/s²**, ek yanal hız sınırı **1,8 m/s**, toplam mutlak düzeltme bütçesi **4,8 m**. Yön değiştirerek bütçe yenilenemez. ↑/↓ dikey hızda sınırlı düzeltme verir: **0,85 m/s²**, toplam mutlak Δv bütçesi **1,35 m/s**. Sürekli yükselme veya ileri roket itişi oluşturamaz. İlk çevre/labut teması hava kontrolünü bitirir.

İniş artık gerçek solver temasından tespit edilir; labut teması ile zemin teması ölçümlerde ayrıdır. İlk zeminde normal yerçekimi geri gelir. **Impact damping 1,1→0,16**, beden sürtünmesi **0,32→0,20**, açısal damping **0,65→0,14**. Beden restitution değeri 0,16; küçük sekme ve tumble mümkün, yapışıp durma azalıyor. İnişte toz/ses ve kayış boyunca sınırlı toz izi var. Yerel hız güvenlik sınırı 44 m/s; shared ragdoll sınırı/değerleri değişmedi.

### HUD ve kamera

Sol altta tek sabit gösterge: **hız + power bar + sayısal açı + angle bar**. Countdown, sürüş, uçuş ve sonuçta panel kalır; release sonrası seçilen güç/açı kilitli gösterilir. Hız etiketi uçuşta “BEDEN HIZI” olur. Şarjda “0,40× · AĞIR ÇEKİM” ve “SPACE’i bırak · Fırla” belirginleşir. Alt sağda o ana ait kontrol ipucu var; düşük genişlikte yerleşim uyarlanır.

Kamera dünya yukarısını korur; ragdoll ile ufuk dönmez. Havada 8 m geriden ve daha yüksekten uçuşu okutur. Şarjda FOV 6° daralır; rack yaklaşımında mevcut sonuç kamerasına yumuşak geçiş korunur.

## 2. FlatOut 2 hissine yaklaşım

Önceki 50 m hat ve yaklaşık 2 s uçuş yerine 100 m hat ve yaklaşık 3,3 s iyi uçuş var. Açı artık aracın büyük ileri hız bileşenini etkiliyor; aynı güçte yüksek açı fiziksel olarak rack'i aşabiliyor. Gövde ters dönüp uzuvlar salınırken oyuncu sınırlı rota düzeltmesi yapabiliyor. İniş, atışın sonu olmaktan çıkıp pinlere momentum taşıyan bir aşama oldu.

Bu bir web/low-poly yorumu: dokuz parçalı gövde, ayrı diz/ayak bileği simülasyonu, parçalanan araç ve yıkılabilir dekor yok. Görsel/animasyon birebir FlatOut kopyası değil. **Kullanıcının sözünü ettiği üç ekli görsel bu oturumda erişilebilir görünmedi; doğrudan görsel karşılaştırma yapılmadı, ayrıntılı yazılı hedefler izlendi.**

## 3. Ölçümler

Aynı gerçek sürüşün release durumu: araç `(−2,493; 2,003; 28,082)`, **22,00 m/s**. Yalnız seçilen güç ve açı değiştirilerek karşılaştırıldı; havada manuel düzeltme yok. Başlangıç hız vektörü `(x,y,z)` m/s. Süreler **simülasyon saniyesi**; kısa slow tail iyi uçuşa yaklaşık 0,18 s gerçek zaman ekler.

| Örnek | Araç m/s | Güç | Açı | İlk hız (x,y,z), m/s | Air s | Air m | Slide/tumble m | Total m | Labut |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| Weak | 22.00 | %20 | 25° | (0.53, 10.87, 21.56) | 2.60 | 54.13 | 28.21 | 82.35 | 0/10 |
| Medium | 22.00 | %40 | 25° | (0.58, 11.79, 23.55) | 2.75 | 62.36 | 32.53 | 94.88 | 0/10 |
| Kayış ağırlıklı alternatif | 22.00 | %60 | 25° | (0.64, 12.99, 26.12) | 3.00 | 75.08 | 32.33 | 107.41 | 10/10 |
| Good | 22.00 | %80 | 25° | (0.72, 14.41, 29.16) | 3.30 | 91.60 | 20.05 | 111.66 | 10/10 |
| High-angle | 22.00 | %80 | 40° | (0.61, 21.50, 24.65) | 4.77 | 108.81 | 20.28 | 129.09 | 0/10 |
| Fazla güç | 22.00 | %100 | 25° | (0.80, 16.02, 32.62) | 3.63 | 111.80 | 11.72 | 123.51 | 0/10 |
| Alçak açı / güçlü | 22.00 | %80 | 15° | (0.77, 9.14, 31.08) | 2.23 | 67.36 | 44.30 | 111.66 | 10/10 |

“Air” ilk zemin temasına kadarki yatay yer değiştirme. “Slide/tumble” ilk zemin temasından sonuçlanmaya kadar pelvisin yatay yolunun toplamı; sekme ve labut çarpışmalarını da içerir. “Total” release'ten sonuçlanmaya kadar yatay yol toplamı, 3D yay uzunluğu değil. Çok yüksek/kaçan atış zemine temas etmeden biterse JSON'da `groundContact:false`; airtime o durumda ölçüm sonuna kadardır.

İyi atış ilk zemine **z=119,66**, rack'ten **9,34 m önce** temas etti; temas öncesi ileri hız **25,99 m/s**, toplam hız **30,19 m/s**. High-angle örneği z=136,86'da, rack'in 7,86 m ilerisinde indi. Fazla güçlü örnek z=139,85'e uçtu. %60 / 25° daha erken iniş ve daha uzun kayışla başarılı ikinci bir rota sunuyor; tek bir ideal açıya zorlanmıyor.

Eşlenik A/D deneyinde, 1 s'de yaklaşık ±0,91 m, 2 s'de ±2,68 m, ilk temasta **−4,61 / +4,57 m** fark oluştu. Ek ileri itki verilmedi. Up/down testinde iniş süreleri >0,2 s ve uçuş mesafeleri >5 m ayrıştı; tümü 4 s altında kaldı.

**100 yetkin bot profili**, yalnız `quality≥0,18` koşuluyla seçildi, sonuç filtresi yok. Ortalama **5,74 labut**; 0–3: **42**, 4–7: **14**, 8–9: **8**, strike: **36**. Ortalama atış süresi **22,59 gerçek saniye**, gözlenen aralık **17,60–25,13 s** (countdown, sürüş ve sonuç geri bildirimi dahil). Retry: **0**. 100 atışta hız sınırına takılma: **0**. Skor sonrası 2 ek fizik saniyesinde geç labut kaybı: **0**.

Gerçek Chrome klavye akışıyla iki ölçülü iyi atış ve tam maçlar çalıştırıldı:

| Yerel oyuncu sayısı | Maç süresi | Toplam puanlar | Retry |
|---|---:|---|---:|
| 2 | 138.2 s | 30 / 13 | 0 |
| 3 | 201.9 s | 29 / 18 / 19 | 0 |

Mevcut yerel akış korunur: bir klavye oyuncusu ve 1–2 bot, oyuncu başına üç atış, 0–30 skor. Bu pass yeni hot-seat veya eşzamanlı çok klavye sistemi eklemedi.

## 4. Performans

Bu makinede headed Chrome, 1440×900 ve 1366×768. Tam maçlar 1366×768'de. Tüm frontend testleri ve build bittikten sonra performans oturumu başlatıldı. Drive **2102**, flight **2653** snapshot.

| Ölçüm | Drive | Flight |
|---|---:|---:|
| FPS ortalaması | 60.0 | 60.0 |
| Bowling JS / frame, ms | 0.383 | 0.630 |
| Physics/controller ortalama, ms | 0.364 | 0.378 |
| Rolling p99 ortalaması, ms | 1.097 | 1.116 |
| En yüksek rolling p99, ms | 1.500 | 1.500 |
| En yüksek tek step, ms | 5.700 | 5.700 |
| Draw calls | 20–26 | 19–27 |
| Triangles | 41177–45315 | 38470–44949 |

JS/frame yalnız Bowling `useFrame` işini ölçer, tüm sayfanın JS maliyeti değildir. Physics/controller ölçümü gerçek fixed-step maliyeti. p99, 1200 step'lik rolling pencerelerden gelir; tabloda hem ortalama rolling p99 hem gözlenen en yüksek rolling p99 var, global p99 diye sunulmaz. FPS de rolling sample ortalamasıdır.

Dinamik gövde sayısı **20** (9 insan + 10 labut + 1 araç). Toplam collider **285**; artış uzayan statik yol yüzünden. Yeni dinamik dekor gövdesi yok. Toz havuzu 36 parçacık, tek draw call. Statik geometri merge, tekrar eden dekor instancing kullanır. Yeni texture/model paketi eklenmedi. Bowling lazy chunk **34,30 kB / gzip 12,66 kB**; mevcut lazy sınırı korunur.

Bu ölçümler masaüstü Chrome içindir; düşük seviye telefon için aynı FPS garantisi verilmez.

## 5. Validation ve kapsam koruması

- **550/550** frontend + edge testi (41 dosya), **40/40 Bowling testi** dahil.
- `npx tsc --noEmit`: geçti. `npm run build`: geçti; mevcut >500 kB chunk uyarısı devam ediyor.
- `git diff --check`: geçti. Untracked Bowling dosyalarının trailing whitespace kontrolü: temiz.
- Tarayıcı: **22/22 kontrol**, **0 page exception**. İki çözünürlükte Space/angle, pause/cancel, resume/fren, sürekli meter, kısa tail, normal uçuş; tam 2/3 oyuncu maçları; yeni seed ile restart; 390 px HUD sınır kontrolü. Son CSS düzeltmesinden sonra ek dar ekran kontrolü **4/4** geçti: ipucu ayrı satırda, panel ekran içinde, iki meter görünür, normal modda debug gizli. Production build bu CSS düzeltmesinden sonra yeniden geçti.
- Fizik: 15 power/angle kombinasyonu, 100 yetkin bot, sağ/sol hava bütçesi, yukarı/aşağı bütçesi, ters dönme/uzuv ayrışması, iniş taşıması, joint/CCD ve tam deterministik maçlar.
- Normal ve bullet-time saatleriyle aynı 180 fixed-step sonucu parça pozisyon/hızlarında **bit-identical**. 0,45 s tail: 0,27125 s birikmiş simülasyon; ardından 1×.
- Mevcut `ArenaScene.tsx`, oturum başı kopyasıyla SHA-256 eşit: `82e9616ddf6867154deeeb2252c8266bcd53c56887f0512890b46fdb58ef8a49`.
- Online, PartyRoom, lobby, Mixed, shared physics ve protocol dosyaları değiştirilmedi. **Protocol 9** aynı. Oturum başındaki tracked diff byte-for-byte aynı kaldı; tüm yeni düzenleme mevcut untracked local Bowling dosyalarının içinde.

Altı deterministik regresyon hash'i önceki baseline ile eşit:

| Simülasyon | SHA-256 |
|---|---|
| Rooftop | `8d89030cf2d5752364f82321950b42a6aa1100986c329955a5969c1876661de6` |
| Barn | `88562a77268129b7f9601a990678cd87037fe3e5e51d7b7d8e637c345de5fc94` |
| Layers | `ef1303cc5b33cf14a3e6fe7211d2ebbdc50ae0dc8a6f827d088530afe625a069` |
| Colors | `818900429dd23650e989ef4545e55a70257bb90938a4e3453e048385c9fefea6` |
| Bomb | `5be7de86b5f30dd9b1db691edf2463fc018fe13196fa63e7fb8306bdf05bf8d2` |
| Prop Hunt | `0c359d893dbb349c394cbfb640b3dbd299ac4791b7828a1004f504e84b076ed0` |

## 6. Dosyalar ve kanıtlar

Bu oturumun başlangıcına göre değişen dosyalar:

| Dosya | Değişiklik |
|---|---|
| `src/party-lab/scene/bowling/config.ts` | Course, hızlar, yerel damping, uçuş bütçeleri, seed/layout, bot profilleri |
| `src/party-lab/scene/bowling/car.ts` | Fizikle aynı seed'e ait engellerden hız kaybı |
| `src/party-lab/scene/bowling/game.ts` | Launch formülü, fiziksel tumble, pitch, gerçek zemin teması, mesafe ölçümleri, bot hava hedefi |
| `src/party-lab/scene/bowling/camera.ts` | Yeni araç hızına göre FOV, daha geniş uçuş takibi |
| `src/party-lab/scene/bowling/visual.ts` | Uzun pist, tematik engeller, portallar, tribün/dekor, aynı seed |
| `src/party-lab/scene/bowling/BowlingPlayground.tsx` | Maç seed'i, iniş/kayış feedback, charge FOV, hız/telemetri |
| `src/party-lab/scene/bowling/BowlingHud.tsx` | Sürekli power/angle/hız göstergesi ve açıklamalar |
| `src/party-lab/scene/bowling/bowling.css` | Sabit gösterge, charge durumu, dar ekran düzeni |
| `src/party-lab/scene/bowling.test.ts` | Güncel tuning beklentileri ve 5 yeni davranış testi |
| `scripts/validate-party-lab-bowling.ts` | Uzun pist için gerçek sürüş fixture'ı; yeni ölçüm alanları otomatik kaydedilir |
| `src/party-lab/scene/bowling/HUMAN_BOWLING.md` | Bu rapor |

Yeni bağımlılık veya yeni asset yok. Var olan uncommitted kit, builder, clock, audio, effects ve ArenaScene entegrasyonu korundu. Bu dosyalar Git'te zaten untracked olduğundan `git diff --stat` tek başına bu pass'in kapsamını göstermez; başlangıç kopyasıyla karşılaştırıldı.

Kanıt kökü: `/private/tmp/bowling-polish/`. `initial/` son fizik koşusunu içerir (klasör adı ilk iterasyondan kalmıştır): `matrix.json`, `bots.json`, `air.json`, `summary.json`. `browser-results.json`, `browser-final.log`, `performance.json`, `all-tests.log`, `build.log`, `typecheck-initial.log`, `regression-hashes.json`, `prop-hash.txt` `narrow.json` ve PNG ekran görüntüleri burada. İlk tarayıcı geçişi sırasında geliştirme hot reload'u debug nesnesini kaldırdığı için harness kesilmişti; son geçiş kaynak düzenlemesi yapılmadan tekrarlandı.

Tekrar çalıştırma:

```sh
npx tsx scripts/validate-party-lab-bowling.ts /private/tmp/bowling-measurements
npx tsx --test --test-concurrency=1 $(rg --files src edge -g '*.test.ts')
npx tsc --noEmit
npm run build
git diff --check
```

## 7. Açık tuning kararları

1. **Alternatif kayış rotası:** yüksek hızlı düşük açı hâlâ uzun kayışla strike yapabilir. Açı sonucu belirgin biçimde değiştiriyor ama tek kazanan yörünge yok. Düşük açıların daha sert cezalandırılması bir sonraki öznel zorluk kararı olabilir.
2. **Bot zorluğu:** yetkin profillerde %36 strike ve 5,74 ortalama. İstenirse hedef çizgi/power dağılımından daha kolay veya zor yapılabilir; fizik ayrıcalıkları yok.
3. **Sonuç bekleme süresi:** daha uzun momentum için normal fizik çözüm penceresi 13 s, hareketli labutlara en fazla 12 s ek süre korunuyor. Ortalama toplam atış 22,59 s. Daha hızlı maç istenirse skor artık kesin olduğunda sunum kısaltılabilir.
4. **Savrulma miktarı:** gerçek tork/başlangıç spin'i artırılabilir; şu an oyuncu çizgisini okuyabilsin diye sınırlı. Dizli tam iskelet ve yıkılabilir çevre bu pass kapsamında değil.
5. **Referans eşleştirmesi ve düşük cihazlar:** üç görsel erişilebilir olduğunda doğrudan görsel karşılaştırma; düşük güçlü mobil cihazda ayrı profil ölçümü yapılabilir. Masaüstü kabul kontrolleri tamamlandı.
