# Kör Nokta — gerçek dünya 360 sahne pipeline

Kör Nokta için açık-lisanslı **gerçek dünya** 360 panoramalarını indirip
normalize eden, mevcut AI/tarihi sahneleri bozmadan test sahnesi üreten iki
adımlı hat. **Kör Nokta web-only'dir; bu sahneler native bundle'a girmez.**

```
fetch-panoramax.mjs ─► raw/<id>.jpg + preview/<id>.jpg + candidates.json
        │  (preview'ları gözle incele, iyileri CURATION'a ekle)
        ▼
build-real-scenes.mjs ─► public/assets/kor-nokta-real/<sceneId>.webp
                         public/assets/kor-nokta-real/manifest.json
                         src/modes/korNokta/korNoktaRealScenes.ts (codegen)
```

## Kaynak: Panoramax (Mapillary değil)

[Panoramax](https://panoramax.xyz) STAC API'si (`api.panoramax.xyz`) **tokensız**
çalışır; görüntüler **açık lisanslı** ama lisans **item başına değişir** (çoğu
CC-BY-SA 4.0, bazıları Etalab 2.0 / Licence Ouverte). Lisansı HARDCODE ETME —
`build-real-scenes.mjs` her sahnenin gerçek lisansını `resolveLicense(cand.license)`
ile çözer, whitelist dışı bir lisans görürse sahneyi atlar. Mapillary token
gerektirir (yoksa kullanılmaz; `MAPILLARY_TOKEN` `.env`'den okunmalı — `.env`
gitignore'lu). Bu POC tamamen Panoramax ile, **secret olmadan** çalışır.

360 ayırt edici: `properties.pers:interior_orientation.field_of_view === 360`
**ve** 2:1 en-boy **ve** genişlik ≥ 4096 (düz telefon fotoğrafları elenir).

### Bölge önceliği (tier) + kapsam gerçeği

`fetch-panoramax.mjs` bölgeleri **öncelik sırasıyla** tarar (tier alanı):
**1 = Türkiye**, **2 = Avrupa + ABD**, **3 = Japonya/Çin/gelişmiş Asya**. Öncelik
"mümkünse" geçerlidir; kapsam yoksa bir sonraki gruba geçilir, **kalite önceliğin
önünde**. Panoramax kapsamı çok dengesizdir: Türkiye (İstanbul/Bursa/İzmir),
Fransa, Hollanda, Belçika, Japonya (Tokyo/Kyoto) güçlü; Almanya/Avusturya/İsviçre/
İskandinavya/Balkanlar ve çoğu ABD şehri + Çin/Kore/Singapur **0 360-HD** döndü.

### Ayna (mirror) sorunu — viewer'da çözülür, asset'te DEĞİL

`Panorama360` küreyi `BackSide` ile çizer ama three.js'in equirectangular
reçetesindeki `geometry.scale(-1,1,1)` adımını uygulamaz → panorama **yatayda
aynalanır** (tabela yazıları ters). AI/tarihi sahnelerde okunur yazı olmadığından
fark edilmez ve görünümleri KORUNMALI olduğu için viewer global düzeltilmez.
Gerçek dünya sahnelerinde tabela önemli ipucu → viewer **yalnız `real_world`**
sahnelerde `mirrorX` prop'uyla dokuyu örneklerken (`repeat.x=-1`) aynalamayı geri
alır. **Asset'e dokunulmaz** (kaynağa sadık; `modified=true` yalnız resize içindir).

## 1) fetch-panoramax.mjs

```bash
node scripts/korNokta/fetch-panoramax.mjs [--per-region N] [--regions a,b]
```

- `REGIONS` bbox'larında arar (kapsam değişken; bazı bölgeler 0 dönebilir —
  360 HD kapsamı şu an Fransa/Hollanda/Belçika/Hindistan'da yoğun).
- **Tekilleştirme:** sekans (`collection`) başına 1 kare, bölge içi min mesafe
  (~350m), zaten indirilmiş `sourceImageId` atlanır → tekrar çalıştırılabilir.
- **Kalite kapıları:** 2:1 oran, ≥4096px, ortalama parlaklık 42–225 (çok
  karanlık/patlamış elenir).
- Her aday için tokensız **Nominatim** reverse-geocode (1.1s throttle + UA).
- HD'yi `raw/`'a, küçük `preview/`'a yazar; `candidates.json` (preview manifest)
  merge eder.

`raw/`, `preview/`, `candidates.json` **gitignore'lu** (ara çıktı).

## 2) build-real-scenes.mjs

```bash
node scripts/korNokta/build-real-scenes.mjs
```

- Dosya içindeki `CURATION` listesi = gözle seçilmiş final set (sıra + nötr,
  **konum sızdırmayan** TR başlık + zorluk + ekstra yasaklı kelimeler).
- Her sahneyi `sharp` ile **4096×2048 WebP q82** yapar (gerçek equirectangular →
  seam düzeltmesi gerekmez). Çıktı `public/assets/kor-nokta-real/<id>.webp`.
- `manifest.json` (atıf defteri) + `korNoktaRealScenes.ts` (codegen) yazar.
- `bannedWords` otomatik: ülke + bölge + şehir + Türkçe/ASCII katlamaları +
  `CURATION.extraBans`.

**Yeni sahne eklemek:** fetch çalıştır → `preview/` incele → `sourceImageId`'yi
`CURATION`'a ekle → build çalıştır.

## Lisans & atıf

- Görüntüler **açık lisanslı** (Panoramax); lisans **sahne başına** değişir —
  `manifest.json` → `scenes[].license` ve `licenseBreakdown`. Atıf zorunlu.
- Uygulama içi: viewer sağ-alt köşesinde `Panoramax · <lisans> · <yazar>` badge'i;
  kaynağa (Panoramax viewer) tıklanır link.
- `attribution.modified = true`: görüntüler 4096×2048'e **resize** edildi (görsel
  içeriği aynalanmadı/çevrilmedi); "değişiklik belirt" gereği manifest + badge'te.
- Tam atıf defteri: `public/assets/kor-nokta-real/manifest.json`.

## Sahneleri test etme

- **Viewer + badge (havuzu açmadan):** `npm run dev` → `/kor-nokta-real-test`.
- **Tam oyun-döngüsü (tahmin/pin/puan):** `korNoktaGameTypes.ts` içinde
  `KN_INCLUDE_REAL_SCENES = true` yap, Kör Nokta maçı başlat.
