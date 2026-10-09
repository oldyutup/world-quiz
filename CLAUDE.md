# CLAUDE.md

## Party Lab: yeni mod kuralı

Yeni mod eklerken Mixed ve Tahta Oyunu rotasyonuna girmeli, winner doğru dolmalı, mümkünse placements() eklenmeli, uygun oyuncu sayısı tanımlanmalı.

Her yeni mod Yerel Test Arenası'na da botlarıyla birlikte eklenmeli.

Nasıl:

- `shared/party-lab/modes.ts` → `GAME_MODES`'a ekle. `MODE_SELECTIONS`, Mixed (`mixedCycle`/`MixedRotation`) ve Tahta Oyunu'nun mini oyun rotasyonu buradan türer; ayrı bir listeye eklemek gerekmez.
- Aynı dosyada `MODE_PLAYERS` (min/max oyuncu), `MODE_NAMES`, `MODE_MAP` girdileri. Mixed, Tahta Oyunu ve tek-mod lobisi oyuncu sayısını `modeFits` ile buradan okur.
- `servers/party-lab/src/PartyRoom.ts` → `createSimulation`'a dal ekle (eksikse sessizce Çatı Kavgası simülasyonu kurulur).
- Simülasyon (`OnlineSimulation`): `winner` results'ta kazananın **slot**'u (seat index değil), beraberlikte −1; `placements()` slot başına sıra (0 en iyi, eşitler aynı sırayı paylaşır, oynamayan −1). `start()` yalnız `MODE_PLAYERS` aralığındaki oyuncu sayısını kabul etmeli.
- Biri oyundan çıkınca kalan oyuncu turu kazanmalı; skor korunan modlar (`SCORE_KEPT_ON_FORFEIT`) bilinçli istisnadır.
- `servers/party-lab/tests/modeContract.test.ts` bunların hepsini `GAME_MODES` üzerinde döner; yeni mod sağlamazsa patlar. Mod sayısını sabitleyen eski testler (örn. `12`/`11`, `GAME_MODES.length + 1`) elle güncellenir.
- İstemci: `src/party-lab/scene/OnlineArena.tsx`'te görünüm dalı (eksikse Çatı Kavgası görünümüne düşer), `src/party-lab/PartyLobby.tsx`'te mod açıklaması.
- Oyun içi sohbet: arena girdisini `useArenaMenu()`'nun `chatOpen`'ı açıkken de kesmeli (`menu.view !== null || menu.chatOpen`; `scene/gameChat.test.ts` eksikse patlar). `scene/gameChat.ts` → `CHAT_LAYOUT`'a modun HUD'unu kapatmayan yerini (alt boşluk, gerekirse genişlik; geniş/dar/telefon) ekle (Record olduğu için eksikse derlenmez).
- Yerel Test Arenası: `shared/party-lab/localArenas.ts` → `LOCAL_MODE_ARENAS`'a modun `MODE_MAP` id'sini ekle (sözleşme testi eksikse patlar). `src/party-lab/scene/ArenaScene.tsx`'te isim, oynatma alanı, HUD ve menüdeki "sen + bot" oyuncu sayısı; botlar oyuncunun yerine geçmeyen, modu gerçekten oynayan rakipler olmalı.
