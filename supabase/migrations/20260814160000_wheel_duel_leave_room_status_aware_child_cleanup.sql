-- ============================================================================
-- Çark Düello — wheel_duel_leave_room · üyelik kontrolü + durum duyarlı çıkış
-- ============================================================================
-- Bu migration, Bayrak Düello (20260813140000) ve Ülke Yaz Düello
-- (20260813150000) denetimlerinin Çark Düello ayağıdır. Aynı iki problem
-- sınıfı arandı; FK sınıfı Çark'ta YOK, durum körlüğü VAR, ve aranmayan
-- (daha ağır) bir yetkilendirme açığı çıktı.
--
-- Regresyon kilidi: scripts/check-wheel-duel-leave-room.ts
--   (statik sözleşme + gerçek Postgres'te clean-room runtime suite)
--
-- BASELINE — CANLI GÖVDE DOĞRULANDI, DRIFT YOK (2026-08-14)
-- ---------------------------------------------------------------------------
-- Production'dan read-only okunan gövde 20260702120000 ile BİREBİR aynıdır:
--   md5(prosrc) = bafbd4e6a0f8b8840559c34a360946e8   length(prosrc) = 1733
-- Bu değer 20260702120000'in dolar-alıntılı gövdesinin (yorumlar DÂHİL) md5'i
-- ile TAM eşleşir → canlı fonksiyon repo'nun aynısı, drift YOKTUR.
-- Denetim sırasında bir ara "repo baseline 5d3340ae… / 1467" değeri dolaştı ve
-- drift sanıldı; o değer bu repodaki HİÇBİR fonksiyon gövdesine ait değil
-- (tüm migration'lar tarandı) — yanlış alarmdı. Bu migration canlı gövdeyi
-- baseline alır; rebase gerekmedi.
-- POST-DEPLOY beklenen: md5(prosrc) = 8dca12ed189c67a1f055e13fdeafabb8 (4156)
--
-- SORUN 1 — ÜYELİK KONTROLÜ YOK  ⚠ İSTİSMAR EDİLEBİLİR (bu migration'ın asıl
--           gerekçesi)
-- ---------------------------------------------------------------------------
-- 20260702120000'deki gövde YALNIZ `wheel_duel_authorize_player` çağırıyor:
-- "bu player_id'nin sahibi sen misin?". Çağıranın p_room_id odasının ÜYESİ
-- olup olmadığı HİÇ sorulmuyor. 'playing' dalı da bu kontrolsüz yoldan
-- geçiyor:
--
--   leave_room(<yabancı oda>, <kendi player_id'in>, <kendi token'ın>)
--     → v_is_host = false (null değil, çünkü oda VAR ve host doludur)
--     → status='playing' → forfeit dalı → oda 'finished',
--       finished_reason='opponent_left', winner = o odanın EN ESKİ oyuncusu
--
-- Yani odaya hiç girmemiş biri, CANLI bir maçı bitirebiliyor ve kazananı
-- belirleyebiliyor. Hedef bulmak serbest: `wheel_duel_rooms_select_public`
-- (20260530120000) anon dâhil herkese `using (true)` SELECT veriyor → tüm
-- oda id'leri + status'ları listelenebilir.
--
-- İki somut istismar:
--   a) Kitlesel bozma — 'playing' tüm odalara sırayla çağrı → her maç anında
--      biter (rakip ekranda oynarken "rakip ayrıldı" sonucu görür).
--   b) XP/lider tablosu manipülasyonu — maçı KAYBEDEN host, ikinci bir kimlikle
--      (misafir yeter; misafir oda kurabilir ve claim_token alır) kendi odasına
--      bu çağrıyı yapar. Kazanan "caller DIŞINDAKİ en eski oyuncu" olduğu için
--      sonuç host'un lehine yazılır: 0-9 geriden gelen oyuncu tek RPC ile
--      "kazandı" olur, XP + istatistik + rozet akışı normal galibiyet gibi işler.
--
-- Karşılaştırma: `wheel_duel_advance_if_due`, `wheel_duel_request_rematch`,
-- `wheel_duel_process_rematch_if_ready` ZATEN üyelik kontrollü
-- (`not_a_member` / `player_room_mismatch`). leave_room istisnaydı.
--
-- SORUN 2 — host_player_id NULL → TAM SESSİZLİK (latent)
-- ---------------------------------------------------------------------------
--   select (host_player_id = p_player_id) into v_is_host ...
--   if v_is_host is null then return; end if;
-- Bu erken çıkış "oda yok" için yazılmış ama `host_player_id IS NULL` olan bir
-- ODA VARSA da tetikleniyor (NULL = x → NULL). O odada leave_room HİÇBİR ŞEY
-- yapmaz: 'playing' ise forfeit yazılmaz (rakip süre dolana kadar boşa oynar),
-- 'waiting' ise oyuncunun kendi satırı bile silinmez (öksüz slot).
-- Çark QM odalarında host'un dolu olduğu sanılıyor (dolmasa host-only
-- finish_game/pick_target akışları hiç çalışmazdı) → bugün LATENT. Precheck'te
-- `host_player_id is null` sayımı bunu kesinleştirir.
--
-- SORUN 3 — FK CASCADE VARSAYIMI: Çark'ta varsayım DOĞRU (canlıda DOĞRULANDI)
-- ---------------------------------------------------------------------------
-- Bayrak/Ülke Yaz'daki kök neden (`duel_*` legacy tabloları, CASCADE YOK)
-- Çark'ta YOKTUR: wheel_duel_* tablolarının HEPSİ bu repodaki migration'larla
-- CREATE TABLE edildi ve cascade'ler orada TANIMLI. Dördü de 2026-08-14
-- production precheck'inde OKUNARAK doğrulandı (artık varsayım DEĞİL):
--
--   wheel_duel_players.room_id        -> wheel_duel_rooms(id)    ON DELETE CASCADE
--                                        (20260514120000 · canlıda DOĞRULANDI)
--   wheel_duel_player_claims.player_id-> wheel_duel_players(id)  ON DELETE CASCADE
--                                        (20260528120000 · canlıda DOĞRULANDI)
--   wheel_duel_room_sequences.room_id -> wheel_duel_rooms(id)    ON DELETE CASCADE
--                                        (20260814150000 · canlıda DOĞRULANDI)
--   wheel_duel_queue.matched_room_id  -> wheel_duel_rooms(id)    ON DELETE SET NULL
--                                        (tablo + QM RPC gövdeleri repoda YOK;
--                                         canlıda DOĞRULANDI — country_duel_queue
--                                         deseniyle aynı çıktı)
--   duel_messages                     -> FK YOK; room_code ile eşleşir, DOKUNULMAZ
--
-- Aynı precheck: öksüz players/claims/sequences = 0, dangling queue işaretçisi
-- = 0, `host_player_id is null` oda = 0 (SORUN 2 bugün LATENT).
--
-- Yine de "oda silinirken child kalmaz" değişmezi artık GÖVDEDEN okunuyor:
-- child'lar parent'tan ÖNCE, doğru FK sırasıyla ve YALNIZ p_room_id kapsamında
-- siliniyor. FK gerçekten CASCADE ise bu silmeler zararsız no-op olur; canlı FK
-- drift etmişse (ya da queue işaretçisi engelleyiciyse) gövde yine çalışır.
--
-- SORUN 4 — 'finished' ODA YIKICI SİLİNİYORDU
-- ---------------------------------------------------------------------------
-- Eski gövdede status kontrolü yalnız 'playing' içindi; 'finished' oda host
-- dalına düşüp DELETE ediliyordu. Bu yol CANLI İSTEMCİDEN tetikleniyor: sonuç
-- ekranındaki "⌂ Ana Menü" ve "⚡ Hızlı Eşleş" düğmeleri leaveRoom() çağırıyor
-- (WheelDuelGame.tsx L2817, L2844). Host rakipten önce basarsa oda satırı
-- rakibin ALTINDAN siliniyordu:
--   • rakip realtime DELETE event'ini alıp setup'a fırlatılıyor (L530-545),
--   • sonuç ekranı + rövanş oyları kayboluyor,
--   • XP effect'i `room` + `players` gerektirdiği için (L1016-1030) rakip
--     'finished' UPDATE'ini işlemeden oda giderse XP HİÇ yazılmayabiliyor.
-- Çıkan sonuç: bir oyuncunun ekranından çıkması diğerinin sonuç/XP/rövanş
-- akışıyla YARIŞIYORDU.
--
-- YENİ SEMANTİK
-- -------------
--   oda yok                          → no-op (DEĞİŞMEDİ, idempotent)
--   çağıran bu odanın üyesi değil     → 'player_room_mismatch' (42501)   [YENİ]
--   status='finished'                → NO-OP (host/non-host FARK ETMEZ)  [YENİ]
--   status='playing'                 → FORFEIT: oda SİLİNMEZ, satır bugünküyle
--                                      BİREBİR aynı yazılır (finished /
--                                      opponent_left / winner = kalan oyuncu)
--   status='waiting'                 → host  : child'lar + oda silinir
--                                      diğer : yalnız kendi slotu; oda boşalırsa
--                                              child + oda
--
-- DEĞİŞEN DAVRANIŞLAR (hepsi yukarıdaki dört sorunun doğrudan sonucu)
-- ------------------------------------------------------------------
--   1. Odaya ait olmayan çağıran: sessizce forfeit yazabiliyordu → 42501.
--   2. host_player_id NULL olan oda: tam no-op → normal (non-host) yol; 'playing'
--      ise artık forfeit de yazılır.
--   3. Oda satırı `for update` ile kilitleniyor (iki eşzamanlı çıkış yarışı;
--      gövde satır SİLEBİLDİĞİ için kilit şart).
--   4. Non-host çıkışında oda boşaldıysa oda kapatılıyor (eskiden öksüz kalırdı).
--   5. Silme artık açık child temizliğiyle yapılıyor (cascade'e ek güvence).
--   6. 'finished' + host  → oda DELETE  ⇒ NO-OP.
--      'finished' + non-host → kendi satırı DELETE ⇒ NO-OP.
--      Bayrak Düello (20260813140000) ve Ülke Yaz Düello (20260813150000) ile
--      AYNI güvenli semantik. Kullanıcı yine kendi ekranından çıkabilir:
--      istemci lokal session'ı temizleyip setup'a döner, RPC void/başarılı
--      döner — istemci DEĞİŞMEDİ.
--
-- BUNUN BİLİNEN BEDELİ (kabul edildi, ayrı iş)
-- --------------------------------------------
-- 'finished' odaları artık hiçbir çıkış yolu silmiyor → biten Çark maçlarının
-- oda + oyuncu satırları geride kalır (Bayrak/Ülke Yaz'da da durum böyle).
-- Kalıcı temizlik (reaper/TTL) bu migration'ın KAPSAMI DIŞINDADIR.
--
-- DEĞİŞMEYENLER
-- -------------
--   • imza (uuid, uuid, uuid) → void, SECURITY DEFINER, search_path, GRANT modeli
--   • unauthorized (wheel_duel_authorize_player) → 42501; misafir claim_token yolu
--   • oda yok → sessiz no-op; silinmiş oyuncunun ikinci çağrısı → authorize
--     başarısız → 42501 (bugünkü davranış, değişmedi)
--   • forfeit satırının kolonları/kazanan seçimi (order by joined_at asc)
--   • host tespiti INLINE `host_player_id = p_player_id` (authorize_host'a
--     geçilmedi: o helper ekstra bir authorize_player turu daha atardı ve
--     NULL-host odada hiç true dönmez)
--   • diğer tüm wheel_duel_* RPC'leri, tablo şeması, FK'ler, RLS policy'leri
--   • wheel_group_* / flag_duel_* / duel_* / route_duel_* — hiçbiri
--   • host-SPOF işi (20260814120000 / 20260814130000 / 20260814150000)
-- ============================================================================

create or replace function public.wheel_duel_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room      public.wheel_duel_rooms;
  v_is_host   boolean;
  v_other_id  uuid;
  v_remaining int;
  v_close     boolean := false;
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- Satırı KİLİTLE: bu gövde odayı silebiliyor, iki eşzamanlı çıkış
  -- birbirinin üstüne yazmamalı.
  select * into v_room from public.wheel_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    return;  -- oda yok → no-op (DEĞİŞMEDİ, idempotent)
  end if;

  -- Çağıran gerçekten BU odanın oyuncusu mu? (advance_if_due /
  -- process_rematch_if_ready ile aynı kontrol.) Oda yokluğu YUKARIDA
  -- ayrıldığı için "host odayı sildi" durumu hâlâ sessiz no-op'tur.
  if not exists (
    select 1 from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- NULL-safe host tespiti: host_player_id NULL olan odada erken çıkış YOK.
  v_is_host := (v_room.host_player_id is not null
                and v_room.host_player_id = p_player_id);

  -- ── FINISHED → NO-OP (host/non-host FARK ETMEZ) ──────────────────────────
  -- Sonuç satırı (winner_player_id / finished_reason / current_match_id) ve
  -- rövanş oyları KORUNUR. Üyelik kontrolünden SONRA duruyor: 'finished' bir
  -- odaya yabancı çağrı da yine 42501 alır.
  if v_room.status = 'finished' then
    return;
  end if;

  -- ── PLAYING → FORFEIT (oda ASLA silinmez) ────────────────────────────────
  -- Yazılan satır 20260702120000 ile BİREBİR aynı: aynı 5 kolon, aynı kazanan
  -- seçimi, aynı `and status='playing'` koşulu.
  if v_room.status = 'playing' then
    select id into v_other_id
      from public.wheel_duel_players
     where room_id = p_room_id
       and id <> p_player_id
     order by joined_at asc
     limit 1;

    if v_other_id is not null then
      update public.wheel_duel_rooms
         set status                = 'finished',
             finished_at           = now(),
             finished_reason       = 'opponent_left',
             winner_player_id      = v_other_id,
             current_target_topoid = null
       where id = p_room_id
         and status = 'playing';
      return;
    end if;
    -- Kalan oyuncu yoksa (anormal: 'playing' ama tek kişilik oda) → aşağıdaki
    -- temizliğe düşülür. Bugünkü davranışla aynı.
  end if;

  -- ── waiting (ve 'playing' tek-kişilik anomali) ───────────────────────────
  if v_is_host then
    -- HOST ÇIKIŞI → oda kapanır.
    v_close := true;
  else
    -- NON-HOST (veya host_player_id NULL olan oda): yalnız kendi slotu.
    delete from public.wheel_duel_player_claims where player_id = p_player_id;
    delete from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id;

    -- Oda boşaldıysa kapat (eskiden öksüz kalırdı).
    select count(*) into v_remaining
      from public.wheel_duel_players where room_id = p_room_id;
    v_close := (v_remaining = 0);
  end if;

  if not v_close then
    return;
  end if;

  -- ── ODA KAPATMA — child'lar parent'tan ÖNCE, doğru FK sırasıyla ve YALNIZ
  --    bu odanın kapsamında. Tüm gövde tek transaction: ya hepsi ya hiçbiri.
  --    (1) Odaya işaret eden QM kuyruk satırının işaretçisi düşürülür: FK
  --        ON DELETE SET NULL DEĞİLSE delete'i engellerdi, SET NULL ise bu
  --        update zaten zararsız — ayrıca bekleyen oyuncu yok olan odaya
  --        yönlendirilmemiş olur.
  update public.wheel_duel_queue
     set matched_room_id = null
   where matched_room_id = p_room_id;

  --    (2) sıra deposu (cascade'i VAR — 20260814150000; açık siliyoruz ki
  --        değişmez gövdeden okunabilsin)
  delete from public.wheel_duel_room_sequences where room_id = p_room_id;

  --    (3) claim'ler → (4) oyuncular → (5) oda
  delete from public.wheel_duel_player_claims
   where player_id in (
     select id from public.wheel_duel_players where room_id = p_room_id
   );
  delete from public.wheel_duel_players where room_id = p_room_id;
  delete from public.wheel_duel_rooms   where id = p_room_id;
end;
$$;


-- ACL — AÇIK ve KASITLI, varsayılana GÜVENİLMEZ (bkz. 20260809130000 hotfix'i:
-- public şemadaki yeni fonksiyonlar anon'a DOĞRUDAN EXECUTE ile doğar).
-- anon EXECUTE İSTENEN durumdur: Çark Düello'ya misafir katılabilir ve kendi
-- odasından çıkabilmelidir. Yetki reddini gövdedeki authorize_player +
-- player_room_mismatch kontrolü yapar.
revoke all     on function public.wheel_duel_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_duel_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama: npx tsx scripts/check-wheel-duel-leave-room.ts
--   1) 'playing' + üye çıkışı → oda DURUYOR, status='finished',
--      finished_reason='opponent_left', winner_player_id = kalan oyuncu.
--   2) 'playing' + ÜYE OLMAYAN çağrı → 42501 player_room_mismatch, oda
--      DEĞİŞMEDEN 'playing' kalır.
--   3) 'waiting' + host çıkışı → oda + players + claims + sequences GİTTİ,
--      queue.matched_room_id NULL'landı.
--   4) 'waiting' + non-host çıkışı → yalnız kendi satırı; host'un odası durur.
--   5) 'finished' + host VE non-host → hiçbir satır değişmez (NO-OP).
--   6) host_player_id NULL oda + üye çıkışı → satır silinir (eskiden no-op'tu).
-- ============================================================================
