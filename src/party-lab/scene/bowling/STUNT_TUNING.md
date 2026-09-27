> Historical implementation notes. The current speed/angle rules and measurements are in [FLATOUT_REPORT.md](FLATOUT_REPORT.md); research is in [FLATOUT_RESEARCH.md](FLATOUT_RESEARCH.md). Power-meter descriptions below describe the preserved earlier implementation.

# LOCAL Human Bowling V2: pist ve stunt engeli tuning

27 Eylül 2026. Bu çalışma, oturum başındaki uncommitted V2'yi temel alır. Önceki `HUMAN_BOWLING.md` tarihsel raporu korunmuştur. Bu pass yalnızca pist/görüş ve engeller üzerindedir.

## Pist, eğim ve görüş

| Ölçü | Oturum başı | Bu pass |
|---|---:|---:|
| Başlangıç yüksekliği | 14 m | 34 m |
| Start sonrası düz mesafe | 4 m | 4 m |
| İnişin yatay uzunluğu | 76 m | 76 m |
| Sabit ana eğim | yaklaşık 10,7° | yaklaşık 27,3° |
| Tepe / dip geçişi | 2 / 2 m | 10 / 10 m |
| İniş sonrası düz yol | 40 m | 40 m |
| Engelsiz fırlatma hazırlığı | 16 m | 16 m |
| Kicker | 7 m uzunluk, 1,6 m yükseklik | aynı |
| Kicker ucu → ilk skor labutu | 100 m | aynı |
| Toplam arena sınırı | 252 m | 264 m |

Eklenen 12 m, start çizgisinin arkasındaki platformdur. Alçalan kamera platform dışından alt yapıyı görmesin diye arka pay artırıldı; start ile kicker arasındaki sürüş mesafesi değişmedi. Başlangıç z=−98, iniş −94…−18, kicker 22…29, ilk skor labutu z=129.

Başlangıç kamerası artık 9 m geride ve şasinin 1,05 m üstünde. Pist tepesi aşağıdaki hattı gerçekten örter; sis veya ekran maskesi kullanılmaz. İlk 12 m inişte takip mesafesi 7 m'ye, şasi üstü hedef yükseklik 2,7 m'ye geçer. Arkadaki yol yüzeyine göre ek yerden açıklık uygulanır. Dünya-yukarı ufku, sürate bağlı FOV ve uçuş/sonuç kameraları korunur.

Tepe ve dipte parabolik yükseklik geçişleri eğimi sürekli tutar. Çarpışma ve görünür yol aynı `roadHeight` / hull verisini kullanır. Dik inişte yol çizgileri, oklar ve bariyer parçaları yolun teğetine yatırıldı; eski yatay işaretlerin havada kalması önlendi. Yol dışındaki çelik ayaklar yüksek stunt rampası siluetini tamamlar.

## Üç stunt düzeni, 12 temaslı öğe

- **Labut kapısı:** z≈−16'da iki adet 3,3 m labut ve yanlarında ahşap kasalar. İniş sonunu bowling temalı dar bir kapı gibi okutur.
- **Şaşırtmalı omuzlar:** z≈−9 ve −4,5'te karşılıklı ama offset kasa/labut çiftleri. Pist kenarına yaslanarak dümdüz gitmek yerine çizgi seçtirir.
- **Merkez kırılma düzeneği:** bir ahşap kasa ve arkasında üç labut. Oyuncu iki yanından akabilir veya merkezden kırıp sınırlı hız bedeli ödeyebilir. Eski tek foam splitter siluetinin yerini alır.

Beş kasa ve yedi stunt labutu vardır. Kasalar renkli tek katı blok değildir: çıtalar, dikmeler, üst tahtalar ve çapraz kuşaklardan oluşur. Temas sonrası 14'er parçaya ayrılıp yana dağılır; labutlar devrilip kayar. Mevcut kısa darbe sesi ve sınırlı toz havuzu teması destekler.

Temas, Rapier'ın gerçek şasi/sensor kesişimiyle belirlenir. Kasa 1,7 m/s, labut 0,75 m/s ileri hız kaybettirir; aynı fixed step içindeki toplam kayıp en fazla 3,2 m/s. Temas tek kez kilitlenir ve collider devreden çıkar. Engeller destek ışınlarına girmez, aracı yükseltmez veya şasiyi takmaz. **Dağılan parçalar görsel, deterministik animasyondur; ayrı dinamik fizik gövdeleri değildir.** Uçuş ragdoll'u ve on skor labutunun gerçek fiziği aynı kalır. Stunt engelleri puan üretmez.

Dört seed düzeni korunur ve geliştirilir: kapı/merkez küçük yanal kaymalar yapar, iki omuzun sağ/sol sırası aynalanır. Maç boyunca aynı düzen, her atışta yeniden kurulan engeller; yeniden maçta yeni seed. Son 16 m hazırlık ve uçuş hattı yeni engellerden arındırılmıştır.

## Korunanlar ve kapsam

Space slow-motion charge, güç/açı formülü ve sınırları, 22 m/s araç hız sınırı, havada ragdoll salınımı, A/D ve dikey hava bütçeleri, iniş damping/sürtünmesi, skor, bot profilleri, üç atış ve sonuç kuralları değişmedi. HUD, CSS, clock, audio ve effects dosyaları başlangıç kopyasıyla aynı. `game.ts` değişikliği eski üç sabit engel collider'ını kaldırıp yerel şasi temaslarına geçişle sınırlı.

Online, protocol 9, PartyRoom, lobby, Mixed ve diğer modlarda kaynak değişikliği yok. Oturum öncesindeki tracked diff byte-for-byte korundu. Commit, push veya deploy yapılmadı.

## Otomatik doğrulama

- 553/553 frontend + edge testi; 43/43 Bowling testi dahil.
- Dört layout × sol/sağ/doğrudan rota: rampaya ulaşım, >20 m/s yaklaşım ve sıfır retry.
- Yeni testler: yol tepesinin rack'i fiziksel ray ile gizlemesi ve inişte açması; tek seferlik kırılma, atışta reset ve gövde sayısı; tüm düzenlerde kararlı atış.
- 15 güç/açı örneği ve 100 yetkin bot profili. Bot ortalaması 5,90 labut; 35 strike; geç labut kaybı ve hız güvenlik sınırına takılan atış yok. Retry yok.
- %80 / 25° kontrollü iyi atış: 22,00 m/s araç, 3,30 s uçuş, 91,61 m hava mesafesi, 21,32 m kayma/tumble, 10 labut. 100 m uçuş hattı korunur.
- Aynı fırlatma durumunda normal ve bullet-time sunumuyla 180 fizik adımı birebir eşit. Slow tail 0,45 gerçek saniyede 1× olur.
- `npx tsc --noEmit`, `npm run build`, `git diff --check`: başarılı. Build'de mevcut >500 kB chunk uyarısı sürer.

Kanıt kökü: `/private/tmp/bowling-stunt-tuning/`. Başlangıç kopyası `before/`, eski tracked diff `tracked-before.diff`, testler `tests.log` / `all-tests.log`, fizik ölçümleri `physics/`, build `build.log`. Tarayıcı ve performans sonuçları aşağıdadır.

## Gerçek Chrome doğrulaması

26/26 browser kontrolü geçti; 0 page exception. Headed Chrome, gerçek W/S/A/D/Space/ok klavye girişleri. 1440×900 ve 1366×768'de başlangıç, iniş, kapı yaklaşımı, charge, uçuş, iniş/kayış, skor ve doğrudan kırılma görüntüleri kontrol edildi. Pause/cancel/resume, kalıcı iki meter, kısa slow tail ve çarpışmadan sonra >20 m/s rampaya yaklaşım geçti. İlave 390 px HUD sınır kontrolü de geçti.

| Oyuncu | Maç süresi | Toplamlar | Retry |
|---|---:|---|---:|
| 2 | 133.7 s | 30 / 7 | 0 |
| 3 | 196.9 s | 30 / 22 / 21 | 0 |

Her oyuncu tam üç atış yaptı. İki maç sonunda restart yeni seed üretti. Maçlar 1366×768’de oynandı. Ekran görüntüleri ve ham snapshotlar `browser-results.json` / `browser.log` yanında bulunur.

## Performans

Build/test işlemleri tamamlandıktan sonra browser performansı ölçüldü. Aynı makinede aynı 1440×900, W basılı doğrudan sürüş harness’iyle önce/sonra karşılaştırıldı; ortak z=−90…22 bölümündeki snapshot ortalamaları aşağıda. Bunlar rolling telemetri ortalamalarıdır, bağımsız benchmark veya global p99 değildir.

| Ölçüm | Önce | Sonra |
|---|---:|---:|
| Snapshot | 101 | 53 |
| FPS | 60.0 | 60.0 |
| Bowling JS / frame, ms | 0.397 | 0.44 |
| Physics/controller, ms | 0.262 | 0.308 |
| Rolling p99 ortalaması, ms | 0.8 | 1.025 |
| Draw calls | [23, 26] | [23, 26] |
| Triangles | [41177, 44035] | [44381, 47239] |
| Dinamik gövdeler | [20, 20] | [20, 20] |
| Collider sayısı | [285, 285] | [294, 294] |

Tam maçlar ve iki ölçülü atıştan alınan daha uzun örneklem:

| Faz | Snapshot | FPS | JS/frame ms | Physics ms | Draw calls |
|---|---:|---:|---:|---:|---|
| Sürüş | 2067 | 60.002 | 0.316 | 0.303 | [22, 26] |
| Uçuş | 2539 | 60.0 | 0.52 | 0.312 | [21, 30] |

Bu masaüstü Chrome ölçümünde görünür FPS gerilemesi yok. Geometri ve sensor sayısı artıyor; dinamik fizik gövdesi sayısı 20 olarak kalıyor. Eski üç sabit engelin yerine 12 sensor: toplam collider 285→294. Yeni stunt çizimleri iki instanced mesh; 70 tahta parçası ve yedi labut, sabit kapasite. Yeni particle havuzu, bağımlılık veya asset eklenmedi. Bowling lazy chunk 34,30→37,29 kB (gzip 12,66→13,78 kB). Ham karşılaştırma `baseline.json`, `direct-performance.json`, `performance.json`.

## Değişen dosyalar

`config.ts`, `camera.ts`, `car.ts`, `game.ts`, `visual.ts`, `BowlingPlayground.tsx`; yeni `stuntVisual.ts`; `../bowling.test.ts`; bu rapor. Tümü LOCAL Bowling sınırındadır. Başlangıçtaki ArenaScene değişikliği korunmuştur, bu pass değiştirmemiştir. Önceki uncommitted kit/builder/validation script ve HUD dosyaları korunur.

Kontroller sonrası her şey uncommitted bırakıldı; commit, push veya deploy yapılmadı.
