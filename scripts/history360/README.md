# Harita Dedektifi — 360 panorama test pipeline

`/history-360-test` dev sayfasının (src/dev/History360TestPage.tsx) asset'lerini
üreten iki adımlı pipeline. Amaç: eski "1774px ham → 6× naive upscale → 55MB
JPG" akışının yerini alan, tekrarlanabilir ve ücretsiz bir üretim hattı.

## Akış

```
scenes.json  ──►  generate.mjs  ──►  raw/<sceneId>_candN.webp (5632×2816)
                                          │  (gözle aday seçimi)
                                          ▼
                  postprocess.mjs ──►  public/assets/history/360-test/
                                       <sceneId>_4096x2048.webp (~0.7-1MB)
```

1. **generate.mjs** — AI Horde (anonim, ücretsiz) üzerinde Flux.1-Schnell ile
   1408×704 equirectangular taban üretir; worker tarafında RealESRGAN_x4plus
   ile 5632×2816'ya çıkarır. Anonim piksel bütçesi (1024×1024) nedeniyle taban
   1408×704'tür. Sahne başına 2 aday üretilir; bekleme tipik 2-25 dk.
   - Worker'ın NSFW filtresi nadiren yanlış-pozitif verir ("censored by
     worker") — aynı sahneyi yeniden çalıştırmak yeterli:
     `node generate.mjs h360_003`
2. **Aday seçimi (manuel)** — raw/ altındaki adaylar gözle karşılaştırılır:
   anakronizm (araba, modern kıyafet), üst/alt siyah bant (kutuplarda siyah
   kapak yapar), boş/zayıf kompozisyon elenir.
3. **postprocess.mjs** — seçilen adayı Lanczos3 ile 4096×2048'e indirger
   (süpersampling), sol/sağ kenarlarda 128px gradyan seam düzeltmesi uygular
   (yaw 180°'deki sert dikey çizgiyi giderir), hafif unsharp + WebP q82 yazar.

## Neden bu hedef format?

- 4096×2048: GPU texture limitleri içinde, mipmap dostu, viewer'da FOV 80°'de
  ekran başına ~1100px kaynak düşer — "çamur" hissi yok.
- WebP q82: 55MB JPG'lere karşılık ~0.7-1MB, gözle ayırt edilir kayıp yok.

## Sınırlamalar

- Flux çıktısı gerçek equirectangular projeksiyon garantisi vermez; kutuplara
  bakışta (pitch ±85°) germe/bulanıklık görülür. Ufuk çevresinde sorun yok.
- Seam düzeltmesi renk sıçramasını yok eder; içerik uyumsuzluğu (yapının yarım
  kesilmesi) kalabilir ama sert çizgi olmadığı için gözden kaçar.
