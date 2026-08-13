-- ============================================================================
-- Ülke Yaz Düello — duel_leave_room · durum duyarlı çıkış + açık child cleanup
-- ============================================================================
-- SORUN 1 — FK (Bayrak Düello'daki 20260813140000 ile AYNI kök neden)
-- -------------------------------------------------------------------
-- 20260604120000'deki gövde host dalında doğrudan `delete from duel_rooms`
-- yapıyor ve bunu "(FK cascade ile players + player_claims)" diye yorumluyor.
-- Bu varsayım YANLIŞ: `duel_players.room_id -> duel_rooms(id)` production'da
-- ON DELETE CASCADE DEĞİL (Bayrak Düello'da CANLIDA hata olarak gözlendi:
-- `update or delete on table "duel_rooms" violates foreign key constraint
-- "duel_players_room_id_fkey"`). duel_rooms/duel_players/duel_claims LEGACY
-- tablolardır (dashboard'da yaratıldılar, hiçbir migration onları CREATE TABLE
-- ile tanımlamaz) → cascade davranışı bu repo tarafından hiç garanti edilmedi.
-- Sonuç: host 'waiting' odadan çıkınca RPC patlar, oda silinemez, ÖKSÜZ bir
-- 'waiting' oda geride kalır.
--
-- SORUN 2 — DURUM KÖRLÜĞÜ (Bayrak'ta YOK, burada VAR)
-- ----------------------------------------------------
-- Mevcut gövdede HİÇBİR status kontrolü yok. Host dalı `status`a bakmadan
-- çalışıyor; yani 'playing' ve 'finished' odalarda da odayı DELETE etmeye
-- çalışıyor:
--   • 'playing'  → FK bugün kazara koruyor. Koruma kalkarsa (ya da FK CASCADE
--                  yapılırsa) CANLI maç, rakip ekranda oynarken komple yok
--                  olur; rakip ne forfeit sonucu ne kazanan görür — oda
--                  satırı ortadan kalktığı için realtime yalnız "oda yok"
--                  der. duel_forfeit_game'in yazdığı otoritatif sonuç ASLA
--                  yazılmaz.
--   • 'finished' → maç sonucu (winner_player_id / finished_reason) ve rövanş
--                  işaretçisi (rematch_room_id) taşıyan satır silinir;
--                  sonuç ekranı ve rövanş akışı zeminini kaybeder.
-- Bugün bu iki yol CANLI İSTEMCİDEN TETİKLENMİYOR: DuelGame.tsx `backToLobby`
-- RPC'yi YALNIZ `phase === "waiting"` iken çağırıyor (L1996) ve maç içi çıkış
-- `duel_forfeit_game`e gidiyor (useRoomExitHandler L2027). Yani bu, açıkta
-- duran ama henüz ısırmamış bir yol: RPC anon+authenticated'a grant'li ve
-- durum körü olduğu için bayat/elle bir çağrı canlı maçı yok edebilir.
--
-- FK GRAFİĞİ (bu migration'ın dayandığı olgular)
-- ----------------------------------------------
--   duel_players.room_id         -> duel_rooms(id)      CASCADE YOK  ⚠ (kanıt: canlı hata)
--   duel_player_claims.player_id -> duel_players(id)    ON DELETE CASCADE
--                                   (20260603120000'de TANIMLI — repo garantisi)
--   duel_claims.room_id          -> duel_rooms(id)      davranış BİLİNMİYOR (legacy)
--   duel_claims.player_id        -> duel_players(id)    davranış BİLİNMİYOR (legacy)
--   duel_rooms.rematch_room_id   -> duel_rooms(id)?     FK VAR MI BİLİNMİYOR (legacy)
--   country_duel_queue.matched_room_id -> duel_rooms(id) ON DELETE SET NULL
--                                   (20260701120000'de TANIMLI — engellemez)
--   flag_duel_queue.matched_room_id    -> duel_rooms(id) ON DELETE SET NULL
--                                   (20260516130000'de TANIMLI — engellemez)
--   duel_messages                -> FK YOK; room_code ile eşleşir, DOKUNULMAZ
-- Bilinmeyen üçü için EN KÖTÜ DURUM (hepsi NO ACTION) varsayıldı: gövde child
-- satırları parent'tan ÖNCE ve YALNIZ p_room_id kapsamında elle siler. FK
-- gerçekte CASCADE ise bu silmeler zararsız no-op olur.
--
-- ÇÖZÜM
-- -----
-- FK'ye DOKUNULMADI. Gerekçe 20260813140000 ile aynı: duel_rooms/duel_players
-- Ülke Yaz'a ait değil — Bayrak Düello, Çark Düello, Çark Grup ve iki Quick
-- Match akışı AYNI tabloları paylaşıyor. FK davranışını değiştirmek hepsinin
-- silme semantiğini tek hamlede değiştirir. Kapsam: TEK RPC gövdesi.
--
-- YENİ SEMANTİK (durum duyarlı)
-- -----------------------------
--   status='finished'                → no-op (sonuç + rövanş işaretçisi korunur)
--   status='playing'                 → FORFEIT: oda SİLİNMEZ, satır
--                                      duel_forfeit_game ile BİREBİR aynı hale
--                                      gelir (finished/forfeit/forfeited_player_id/
--                                      winner_player_id = rakip)
--   status='waiting'|'waiting_rematch'
--     · host  → child'lar doğru sırayla silinir, sonra oda
--     · diğer → yalnız kendi satırı; oda boşalırsa child + oda
--
-- DEĞİŞEN DAVRANIŞLAR (bilinçli, hepsi yukarıdaki iki sorunun sonucu)
-- ------------------------------------------------------------------
--   1. 'playing' + host  : oda DELETE denemesi (FK ile patlıyordu) → FORFEIT.
--      Rakip artık mağdur olmuyor: otoritatif "kazandın" satırını görüyor.
--   2. 'playing' + non-host: kendi satırını silip odayı yarım bırakıyordu
--      (rakip 1 kişilik canlı odada asılı kalıyordu) → FORFEIT.
--   3. 'finished' + host : oda DELETE → no-op.
--   4. 'finished' + non-host son oyuncuysa: oda DELETE → no-op.
--   5. Odaya ait olmayan oyuncu: sessiz no-op → 'player_room_mismatch' (42501).
--      duel_forfeit_game ve duel_handle_disconnect ZATEN bu kontrole sahip;
--      leave_room istisnaydı. Eski gövdede bu yol, çağıranın hiç üyesi olmadığı
--      BOŞ bir odayı silebiliyordu (v_remaining=0 dalı).
--   6. Oda satırı artık `for update` ile kilitleniyor (iki eşzamanlı çıkış
--      yarışı). duel_forfeit_game kilitlemiyor; burada kilit ŞART çünkü bu
--      gövde satırı silebiliyor.
--
-- DEĞİŞMEYEN DAVRANIŞLAR
-- ----------------------
--   • imza, dönüş tipi (void), SECURITY DEFINER, search_path, GRANT modeli
--   • unauthorized (duel_authorize_player) → 42501; misafir claim_token yolu
--   • oda yok → sessiz no-op (idempotent; çift çağrı güvenli)
--   • host tespiti: `host_player_id = p_player_id` (INLINE, bugünküyle aynı).
--     duel_authorize_host'a GEÇİLMEDİ — o helper da aynı eşitliği kuruyor ama
--     ekstra bir authorize_player turu daha atardı. Bayrak'taki
--     flag_duel_authorize_host'un "host_player_id NULL → en eski joined_at"
--     yedeği Ülke Yaz'da YOKTUR; QM odaları host_player_id'yi zaten dolduruyor
--     (20260701120000 L341), eski NULL-host satırlarında bugünkü gibi non-host
--     dalı çalışır.
--   • duel_forfeit_game / duel_handle_disconnect / duel_accept_rematch /
--     duel_join_rematch_room ve diğer tüm duel_* RPC'leri
--   • duel_messages (FK'siz, room_code ile eşleşir)
--   • duel_rooms / duel_players / duel_claims şeması ve constraint'leri
--
-- DOKUNULMAYANLAR
-- ---------------
--   • flag_duel_leave_room (20260813140000 ile ZATEN düzeltildi, CANLIDA)
--   • wheel_duel_leave_room / route_duel_leave_room — AYNI deseni taşıyor
--     olabilir, AYRI doğrulama ister, bu migration'ın kapsamı DIŞINDA.
--   • Eski öksüz odalar: bu migration GEÇMİŞİ TEMİZLEMEZ.
-- ============================================================================


create or replace function public.duel_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room      public.duel_rooms;
  v_opp_id    uuid;
  v_remaining int;
begin
  if not public.duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- Satırı KİLİTLE: bu gövde odayı silebiliyor, iki eşzamanlı çıkış
  -- birbirinin üstüne yazmamalı.
  select * into v_room from public.duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    return;  -- oda yok → no-op (DEĞİŞMEDİ, idempotent)
  end if;

  -- Bitmiş maç: sonuç satırı + rematch_room_id işaretçisi korunur.
  if v_room.status = 'finished' then
    return;
  end if;

  -- Çağıran gerçekten bu odanın oyuncusu mu? (duel_forfeit_game /
  -- duel_handle_disconnect ile aynı kontrol.) Oda yokluğu YUKARIDA
  -- ayrıldığı için "host odayı sildi" durumu hâlâ sessiz no-op'tur.
  if not exists (
    select 1 from public.duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- ── PLAYING → FORFEIT (oda ASLA silinmez) ────────────────────────────────
  -- Yazılan satır durumu duel_forfeit_game (20260606120000) ile BİREBİR aynı:
  -- aynı 4 kolon, aynı kazanan seçimi, aynı `and status='playing'` koşulu.
  if v_room.status = 'playing' then
    select id into v_opp_id
      from public.duel_players
     where room_id = p_room_id and id <> p_player_id
     limit 1;

    update public.duel_rooms
       set status              = 'finished',
           finished_reason     = 'forfeit',
           forfeited_player_id = p_player_id,
           winner_player_id    = v_opp_id
     where id = p_room_id
       and status = 'playing';
    return;
  end if;

  -- ── Buradan sonrası YALNIZ 'waiting' / 'waiting_rematch' ─────────────────
  -- ('waiting_rematch' = accepter'ın kurduğu, requester'ın henüz katılmadığı
  --  rövanş lobisi — ürün olarak bir bekleme lobisidir, bugünkü gövde de onu
  --  waiting gibi ele alıyordu.)

  if v_room.host_player_id is not null and v_room.host_player_id = p_player_id then
    -- HOST ÇIKIŞI → oda kapanır. Child'lar parent'tan ÖNCE, doğru FK sırasıyla
    -- ve YALNIZ bu odanın kapsamında silinir. Tüm gövde tek transaction:
    -- ya hepsi olur ya hiçbiri.
    --
    -- 1) Bu odayı GÖSTEREN rövanş işaretçilerini düşür. Silinmek üzere olan
    --    bir odaya işaret eden satır kalırsa (rematch_room_id'nin FK'si varsa)
    --    delete patlar; FK yoksa da dangling pointer kalır ve requester'ın
    --    istemcisi var olmayan odaya katılmaya çalışır. Kapsam: YALNIZ
    --    p_room_id'yi gösteren satırlar; başka odanın verisi değişmez.
    update public.duel_rooms
       set rematch_room_id = null
     where rematch_room_id = p_room_id;

    -- 2) duel_player_claims: duel_players'tan CASCADE ile de giderdi
    --    (20260603120000 repo garantisi) — açıkça siliyoruz ki "oda silinirken
    --    child kalmaz" değişmezi legacy FK bilgisine muhtaç olmadan gövdeden
    --    okunabilsin. Cascade zaten sildiyse bu no-op'tur.
    delete from public.duel_player_claims
     where player_id in (
       select id from public.duel_players where room_id = p_room_id
     );

    -- 3) duel_claims: 'waiting' odada bugün İSPATLANABİLİR biçimde 0 satırdır
    --    (claim yalnız 'playing' odada yazılır ve playing → waiting dönüşü YOK).
    --    Savunma amaçlı duruyor.
    delete from public.duel_claims  where room_id = p_room_id;

    delete from public.duel_players where room_id = p_room_id;
    delete from public.duel_rooms   where id = p_room_id;
    return;
  end if;

  -- NON-HOST (veya host_player_id NULL olan eski oda): yalnız kendi slotu.
  delete from public.duel_player_claims where player_id = p_player_id;
  delete from public.duel_claims
   where room_id = p_room_id and player_id = p_player_id;   -- waiting'te no-op
  delete from public.duel_players
   where id = p_player_id and room_id = p_room_id;

  -- Oda boşaldıysa temizle. Aynı değişmez: parent'tan önce child.
  select count(*) into v_remaining
    from public.duel_players where room_id = p_room_id;
  if v_remaining = 0 then
    update public.duel_rooms
       set rematch_room_id = null
     where rematch_room_id = p_room_id;
    delete from public.duel_claims where room_id = p_room_id;
    delete from public.duel_rooms  where id = p_room_id;
  end if;
end;
$$;

-- ACL — AÇIK ve KASITLI, varsayılana GÜVENİLMEZ.
-- `create or replace` mevcut grant'leri korur, ama Supabase'de public şemadaki
-- fonksiyonlar anon'a DOĞRUDAN EXECUTE ile doğduğu için grant modeli her
-- migration'da açıkça yeniden yazılır (bkz. 20260809130000 hotfix'i).
-- anon EXECUTE İSTENEN durumdur: Ülke Yaz Düello'ya misafir katılabilir ve
-- kendi odasından çıkabilmelidir; yetki reddini gövdedeki
-- duel_authorize_player + player_room_mismatch kontrolü yapar.
revoke all     on function public.duel_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.duel_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
