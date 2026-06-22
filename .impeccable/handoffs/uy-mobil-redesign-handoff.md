# Ülke Yaz — Mobil/Native HUD Redesign · Handoff

> Süregelen bir tasarım çalışmasının devir notu. Yeni oturum buradan devam edebilir.
> Tarih: 2026-06-20 · Register: product · İlgili: `PRODUCT.md`, `DESIGN.md` (§1.1–§1.2), `.impeccable/critique/`.

## 1. Amaç ve Kapsam

- **Torble "Ülke Yaz" mobil/native HUD redesign.** Hedef yüzey: tek oyunculu harita-oyunu kontrol çubuğu (`TopBar`, `src/App.tsx`) ve onun `src/App.css`'teki stilleri.
- **Desktop/web FROZEN.** Yalnız `@media (max-width: 600px)` ve native-app (`html.is-native-app`) katmanı değişebilir. Geniş web deneyimine ve görünümüne dokunulmaz.
- **Korunan çekirdek:** Oyun kuralları, state mantığı (`useGameCore`), harita altyapısı (`WorldMap`), mevcut bilgi mimarisi ve temel navigasyon değişmez. Yalnız görsel sistem + HUD düzeni evrilir.

## 2. Kesinleşen Görsel Kararlar

- **Renk yönü: A2 "Mavi Atlas"** (kilitli). Açık/canlı/nefes alan koyu mavi; mavi/lacivert kimlik korunur.
- **Krem / parşömen / kahverengi YOK.** "Keşif defteri" yalnızca atmosfer referansı, literal doku/skeuomorphism değil.
- **Hedef his:** boğuk kurumsal dashboard değil; **ferah, derin, modern, premium keşif oyunu.**
- **Kırmızı yalnız hata / yanlış cevap / destructive.** Başarı = kontrollü yeşil (neon değil), maviyle çakışmaz.
- **Idle tipografisi:** mevcut **DM Sans** yönü beğenildi; idle'da yeni font çalışması ŞU AN yapılmayacak. (Bebas/condensed display kararı yalnız rakamlarda — playing HUD'una ait, ayrı `typeset` turunda kesinleşecek; idle'da rakam olmadığı için devreye girmedi.)

### A2 token referansı (mobil-scoped, `--uy-*` ile; web `:root` DEĞİŞMEZ)
`bg #122038` · `surface #1c2c4c` · `surface2 #273b60` · `surface3 #334b76` · `border #47608f` ·
`text #eaf0fa` · `muted #9aa4c1` · `dim #7682a0` ·
**`accent #2fbef3`** (CTA + seçili segment) · `accent-text #05203a` · `accent-tint rgba(47,190,243,.18)` ·
`green #3ecb8b` · `amber #f0ab33` · `red #f4615a` ·
`ocean #1d4570` · `land #395688` · `land-stroke #5170a8` · `guessed #588ce2` · `guessed-last #59d2f7 (cyan)`.
İki fren: accent yalnız CTA/seçili/durum/focus; `--muted` küçük metin `surface2` üzerinde kullanılmaz (orada `--text`).

## 3. Yapılmış İşler

- `PRODUCT.md` ve `DESIGN.md`'de mobil kapsam / tasarım yönü güncellendi (eski "yalnız profil yüzeyleri" kısıtı kaldırıldı; §1.1 kapsam + §1.2 yön).
- Ülke Yaz mobil HUD **critique** yapıldı → 24/40 "Needs work"; snapshot: `.impeccable/critique/2026-06-20T11-09-05Z__src-app-tsx-ulkeyaz-mobile-hud-topbar.md`.
- **İlk idle redesign uygulandı** (`src/App.tsx` `TopBar` içine `.uy-idle` bloğu + `src/App.css` mobil-scoped stiller): görev cümlesi "Ülke adlarını yaz, haritada yerlerini keşfet." + Serbest|Süreli segment + tek CTA "Oyuna Başla" + bağlamsal chip popover (Bölge / Süreli'de Süre). Eski ölü disabled input + "Önce bir mod seç" + 0/197 + kırmızı Süreli düğmesi kaldırıldı. Back/caret inline SVG.
- **Teknik kontroller:** `npx tsc --noEmit` temiz; `npx vite build` temiz.
- **Test edilen genişlikler:** 390×844, 360×740, 320×568 (device-emülasyonu). Taşma yok (`taskOverflow=false`, `idleOverflow=false`, `bodyScroll=false`).
- **Davranış doğrulandı:** idle state, segment seçimi (`aria-pressed`), alt-metin değişimi, Süreli'de chip'in "Dünya · 1 dk" göstermesi, chip popover aç/dışarı-tıkla-kapat, bölge seçimi, ve "Oyuna Başla"nın gerçek oyunu başlatması (`is-playing`, `guess-input` enabled).
- **Desktop etkilenmiyor** (1280px'de `.uy-idle` `display:none`, legacy bar duruyor).

## 4. Mevcut Idle İmplementasyonunun Sorunu

- Üst idle alanı (hero chrome) **fazla büyük**; haritadan gereğinden fazla dikey alan alıyor (~245px CSS @390).
- Sağ üstteki **"Dünya / Dünya · 1 dk" chip'i idle durumda gereksiz**; ekranı bir ayar paneli gibi gösteriyor.
- Harita henüz **eski koyu renklerde** (`ocean #0d2137`); A2 idle yüzeyiyle arasında görünür bir **dikiş** var ve harita şu an ekranın en karanlık bölgesi (hedefe ters).
- Font ve CTA genel olarak kullanıcı tarafından **olumlu** bulundu (korunacak).

## 5. Bir Sonraki Kesin İş: Compact Idle Revision

- Idle sağ-üst **bölge/süre chip'i tamamen kaldırılacak.**
- Üst bar yalnız **geri + ortada "Ülke Yaz"** içerecek.
- **Serbest/Süreli segmenti hem mod seçimi hem bağlamsal ayar giriş noktası** olacak.
  - Serbest seçilince: kullanıcı isterse segment üzerinden **kompakt inline Bölge** ayarını açabilecek.
  - Süreli seçilince: segment üzerinden **kompakt inline Bölge + Süre** ayarını açabilecek.
- Bu ayar alanı **büyük popover / modal / üstten taşan kutu OLMAYACAK**; segmentin hemen altında **küçük inline expander** olacak.
- İlk açılışta ayarlar **kapalı**; varsayılan **Serbest** seçili; kullanıcı doğrudan **"Oyuna Başla"** diyebilecek (sıfır ek karar).
- Süreli'ye geçince ilgili ayar alanı açılabilir; **seçili segmente yeniden dokunmak alanı açıp kapatabilmeli** (toggle).
- **CTA, görev cümlesi ve segment korunacak**; fakat idle chrome yüksekliği **belirgin biçimde küçültülecek.**
- **Harita ekranda daha erken başlayacak ve daha büyük kalacak.**
- Bu tur **yalnız idle düzeni**; playing, feedback ve harita recolor YAPILMAYACAK.

## 6. Sonraki Backlog Sırası

- **A.** Compact Idle Revision'ı uygula ve emülatörde (390/360/320) kontrol et.
- **B.** Onaydan sonra **Playing HUD:** skor, timer, input, Gir/Pas hiyerarşisi.
- **C.** **Feedback:** doğru/yanlış/tekrar için **ikon + metin + renk** (yalnız renk değil; renk-körü güvenli).
- **D.** **Harita A2 recolor:** `ocean`, `land`, `land-stroke`, `guessed`, `guessed-last`; idle–harita dikişini kapat.
- **E.** "İsimler" gibi harita görünüm ayarlarını **harita sağ-alt katman/kontrolüne** taşı.
- **F.** Final mobil acceptance + yeniden **critique** (24/40 trendini izle).

## 7. Korunacak Sınırlar

- **Commit / push / deploy YOK.**
- Bu oturumdan ÖNCE değiştirilmiş **`LeaderboardModal.tsx`, `MobileHome.tsx`, `RouteGame.tsx`** dosyalarına dokunma.
- Global **`:root` tokenları** veya **desktop web** görünümünü değiştirme. Mobil değişiklikler `@media (max-width:600px)` / native-scoped kalır; A2 yalnız `--uy-*` ile ilgili yüzeye scope'lanır.
- **Görsel amaçlı sahte state üretme;** gerçek mevcut state ve davranışları kullan (örn. `useGameCore`, mevcut `Dropdown`/`onContinentChange`/`onDurationChange`/`onStartGame`).

### Ek teknik notlar (devir kolaylığı)
- Idle bloğu: `TopBar` içinde `showIdleHero = gameType==="map-game" && !isPlaying && mode!=="finished"`; `barClass`'a `is-idle` ekleniyor; CSS `.control-bar.gt-map-game.is-idle` + `@media(max-width:600px)` ile legacy satırları gizleyip `.uy-idle`'ı gösteriyor.
- Doğrulama için bu oturumda geçici `?shot=1` deep-link'i kullanıldı ve **geri alındı** (kodda kalıntı yok). Emülatör testinde `puppeteer-core` system Chrome ile `--no-save` kuruldu (package.json'a yazılmadı). Not: *headless* Chrome CSS viewport'u ~500px min'e kelepçeler; tam iPhone genişlikleri device-emülasyonu (puppeteer-core `setViewport`) veya DevTools device-mode ile alınır.
