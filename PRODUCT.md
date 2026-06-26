# Product

## Register

product

## Users

Torble'ın birincil kitlesi **coğrafya meraklısı, gündelik oyuncular** (ağırlıklı Türkçe konuşan). Profesyonel coğrafyacı ya da hardcore rekabetçi değiller; dünyayı, bayrakları ve haritaları eğlenerek öğrenmek/keşfetmek için kısa oturumlarda oynuyorlar. Çoğu zaman mobilde, boş bir vakitte, tek elle. Arkadaşlarıyla düello/takım modlarında yarışmak, profil ve kozmetiklerle kendilerini ifade etmek hoşlarına gidiyor ama oyunun kalbi "merak + keşif", "kazanma baskısı" değil.

**Yapılacak iş (job to be done):** "Dünya hakkında bir şeyler öğrenirken iyi vakit geçirmek" — düşük giriş eşiği, hızlı bir tur, küçük bir başarı/keşif hissi.

## Product Purpose

Torble, dünya haritası temelli çok modlu bir quiz/coğrafya oyunudur: Düello, Çark, Bayrak, Rota, Kuşatma, Kör Nokta (360° gerçek dünya panoramaları) ve Çağ Dedektifi gibi modlar; üstüne profil, arkadaşlık, birebir DM, bildirim merkezi, liderlik tablosu, Gold ekonomisi, başarımlar ve kozmetikler. Web + Capacitor (iOS/Android) olarak yayınlanıyor.

Var oluş sebebi: coğrafyayı bir sınav değil, bir **oyun ve keşif alanı** haline getirmek. Başarı şöyle görünür: kullanıcı "bir tur daha" demek ister, yeni bir yer/bayrak öğrendiğini fark eder, arkadaşını davet eder ve geri döner. Elde tutma; reklam/spam baskısıyla değil, gerçek keyifle gelir.

## Brand Personality

Üç kelime: **Davetkâr, merağı kışkırtan, neşeli.**

- **Ses/ton:** Sıcak, arkadaşça, hafif oyuncu bir "dünya rehberi". Ders veren değil, yanına alıp gezdiren. Türkçe metinler net, samimi ve kısa.
- **Duygusal hedef:** Merak ("şurası neresiymiş?"), küçük zaferlerin keyfi, ait olma/sosyallik. Stres ve kaygı değil; hata yapmak güvenli ve oyunun parçası.

## Anti-references

Torble **kesinlikle** şunlara benzememeli:

- **Ucuz/spam mobil oyun:** Agresif pop-up'lar, her köşede reklam, bedava-oyun tuzakları, sahte aciliyet, ucuz parlak gradyanlar. Para kazanma asla kullanıcıyı sıkıştırmaz.
- **Aşırı ciddi eğitim/sınav yazılımı:** Ders kitabı kuruluğu, neşesiz bürokratik form hissi, "doğru/yanlış" cezalandırıcı tonu.
- **Bilgi kirliliği / kalabalık UI:** Her yere serpiştirilmiş rozet/buton/bildirim, aynı anda bağıran onlarca öğe, dikkat dağıtan yoğunluk.
- **Sıkıcı kurumsal/SaaS dashboard:** Gri ve ruhsuz admin paneli, birbirinin aynı kart ızgaraları, klişe "büyük rakam + küçük etiket" hero-metric şablonu.

## Design Principles

1. **Eğlence öğretir.** Öğrenme her zaman oyunun *içinden* gelir; hiçbir ekran ödev/sınav gibi hissettirmez. Önce keyif, bilgi onunla birlikte sızar.
2. **Davet et, bunaltma.** Çok özellik var ama her ekran sakin kalır: kademeli açığa çıkarma (progressive disclosure), sakin yoğunluk, tek bir net birincil eylem. Kalabalık bir vitrin değil, davetkâr bir kapı.
3. **Her ekran bir keşif.** Merakı tasarımla ödüllendir: küçük sürprizler, canlı bir dünya hissi, "bir tur daha" dedirten ufak kazanımlar. Boşluk ve sessizlik de bir araçtır.
4. **Sıcaklık güven verir.** Karanlık desenler, agresif para kazanma ve spam yok. Cömert, dürüst, öngörülebilir; kullanıcıyı kandırmaya değil, ağırlamaya çalışır.
5. **Herkese, her ekranda erişilebilir.** Mobil/dokunma önce: büyük dokunma hedefleri, tek el kullanımı, küçük ekranda okunabilirlik; ve baştan kapsayıcı tasarım (bkz. aşağıdaki bölüm).

## Accessibility & Inclusion

- **Hedef seviye:** WCAG **AA**. Metin/arka plan kontrast oranlarına, görünür odak halkalarına ve klavye erişimine dikkat et.
- **Hareket azaltma:** `prefers-reduced-motion` desteklenir; arka plan parıltıları, yıldız alanı ve geçiş animasyonları bu kullanıcılar için sönümlenir/kapanır.
- **Renk körlüğü dostu:** Anlam asla yalnız renge dayanmaz. Doğru/yanlış, takım renkleri (Mavi/Kırmızı) ve durum bildirimleri ikon, etiket veya şekil ile de ayırt edilebilir olmalı.
- **Mobil/dokunma önceliği:** Yeterli dokunma hedefi boyutu (≈44px), tek el erişimi, ve küçük ekranlarda okunabilir tipografi temel gerekliliktir.
