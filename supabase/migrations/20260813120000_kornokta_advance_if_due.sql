-- ============================================================================
-- Kör Nokta — sunucu-otoriter deadline ilerletme (host SPOF kaldırılıyor)
-- ============================================================================
-- SORUN
-- ─────
-- Bugün bir Kör Nokta maçının fazını ilerleten TEK şey host tarayıcısındaki
-- `setInterval`'dir (KorNoktaGame.tsx). `tevatur_kn_advance_phase` yalnız
-- host'u kabul eder ve `phaseEndsAt`'a HİÇ BAKMAZ: sunucu için "süre doldu"
-- diye bir kavram yoktur, host'un çağırması tanım gereği süre dolmuş demektir.
-- Host iPhone'unu kilitlerse / uygulamayı arka plana atarsa / tab throttle
-- edilirse / interneti giderse o interval durur ve maç DİĞER ÜÇ OYUNCU İÇİN DE
-- donar. Misafirlerin watchdog'u yalnız state'i yeniden OKUR, ilerletemez.
--
-- ÇÖZÜM — İKİ AYRI YETKİ MODELİ
-- ─────────────────────────────
--   A) MANUAL / ERKEN GEÇİŞ  → public.tevatur_kn_advance_phase  (DEĞİŞMEDİ)
--      yalnız host, zaman kontrolü YOK, "şimdi geç" demektir.
--      Bu migration onun ne gövdesine ne ACL'ine DOKUNUR.
--
--   B) OTOMATİK / DEADLINE   → public.tevatur_kn_advance_if_due (YENİ, burada)
--      odanın doğrulanmış HER üyesi (kayıtlı + misafir) çağırabilir, ama
--      sunucu `now()` ile süreyi kendisi doğrular. Anlamı "bu fazın süresi
--      GERÇEKTEN dolduysa ilerlet"tir; "istediğim anda geç" DEĞİLDİR.
--
-- Misafir burada host OLMAZ. Yaptırabildiği tek durum geçişi, sunucunun o an
-- zaten yapacağı geçiştir. Süre dolmadıysa hiçbir şey olmaz. Faz seçemez, tur
-- atlayamaz, puanlamayı istediği an tetikleyemez, maçı erken bitiremez,
-- host_player_id'ye dokunamaz — bu fonksiyon o kolonu okumaz bile.
--
-- EMSAL: aynı desen Rota Düello'da zaten canlı çalışıyor
-- (`route_duel_advance_round`, 20260802120000 §14): odadaki herhangi bir
-- oyuncu çağırır, sunucu deadline'ı doğrular, erken atlama imkânsız.
--
-- ŞEMA DEĞİŞMEZ: tablo yok, kolon yok, RLS yok, policy yok, trigger yok.
-- Tek yeni nesne bu fonksiyondur.
--
-- İSTEMCİDEN ALINMAYANLAR (kasıtlı): deadline, client timestamp, guest_id,
-- nickname. Deadline sunucunun KİLİTLİ oda satırından okunur; client yalnız
-- "hangi durumu ilerlettiğini sandığını" (round + phase) söyler.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- tevatur_kn_advance_if_due — süre dolduysa ilerlet, dolmadıysa hiçbir şey yapma
-- ----------------------------------------------------------------------------
-- Kontrol sırası (hepsi FOR UPDATE satır kilidi ALTINDA, 3'ten itibaren):
--   1. Kimlik    — tevatur_authorize_player (kayıtlı: JWT; misafir: claim_token)
--   2. Üyelik    — o oyuncu satırı BU odada mı? (başka odadan alınmış geçerli
--                  token bu odayı ilerletemez — get_room_state ile aynı desen)
--   3. Kilit     — select … for update
--   4. Durum     — oda 'playing' ve game_state dolu mu?
--   5. CAS       — roundIndex + phase çağıranın beklediğiyle aynı mı?
--   6. Terminal  — final_results ilerletilemez
--   7. DEADLINE  — phaseEndsAt KİLİTLİ SATIRDAN okunur ve
--                  tevatur_kn_now_ms() >= phaseEndsAt olmalı
--
-- 4–7 arasındaki her ret "zararsız no-op"tur: exception DEĞİL, DEĞİŞMEMİŞ oda
-- satırı döner. Bunun iki faydası var: (a) yarışı kaybeden 3 çağıran hata
-- toast'u görmez, (b) bayat state'le çağıran istemci aynı gidiş-dönüşte TAZE
-- odayı alır, yani kendi kendini onarır.
--
-- ÇİFT İLERLEME NEDEN İMKÂNSIZ: 4 istemci aynı anda çağırsa `for update`
-- onları seri hâle getirir; READ COMMITTED altında ikinci çağıran birincinin
-- commit'inden sonra GÜNCELLENMİŞ satırı okur, 5. adımdaki CAS artık tutmaz ve
-- no-op döner. Dolayısıyla faz geçişi, apply_round (puanlama), rounds[] append,
-- roundIndex artışı ve finished_at yazımı tam bir kez olur.
--
-- submit_answer İLE YARIŞ: `tevatur_kn_submit_answer` (20260723120000) tüm
-- cevaplar tamamlanınca answer_questions → detective_guess geçişini kendisi
-- yapabilir. O fonksiyon da AYNI oda satırını `for update` ile kilitler ve
-- fazı kilitli satırdan okur → iki yol aynı kilit üzerinde serialize olur.
-- Hangisi önce girerse geçişi o yapar, diğeri no-op'a düşer (submit_answer
-- 'wrong_phase' ile, bu fonksiyon CAS ile). Çift geçiş imkânsızdır.
--
-- GEÇİŞ ZİNCİRİ: advance_phase'in (20260723120000) zinciriyle BİREBİR aynıdır.
-- Ortak bir helper'a çıkarmak advance_phase'in GÖVDESİNİ değiştirmeyi
-- gerektirirdi; o fonksiyon bilinçli olarak dokunulmaz bırakıldı. Bunun yerine
-- eşdeğerlik testle kilitlendi: scripts/check-kornokta-advance-if-due.ts hem
-- metinsel drift'i hem de altı fazın TAMAMINDA runtime çıktı eşitliğini
-- doğrular (aynı girdi state → iki fonksiyondan bit-eş game_state).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_advance_if_due(
  p_room_id        uuid,
  p_player_id      uuid,
  p_claim_token    uuid,
  p_expected_round int,
  p_expected_phase text
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room     public.tevatur_rooms;
  v_state    jsonb;
  v_idx      int;
  v_phase    text;
  v_deadline bigint;
begin
  -- 1) Kimlik. Kayıtlıda auth.uid(), misafirde claim_token tek kanıttır.
  --    Hesabı silinmiş tombstone satırları iki dalın da dışında kalır → false.
  if not public.tevatur_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- 2) Üyelik. Bu şart olmadan BAŞKA bir odadaki geçerli bir claim_token bu
  --    odanın fazını ilerletebilirdi (tevatur_get_room_state ile aynı desen).
  if not exists (
    select 1
      from public.tevatur_players
     where id = p_player_id
       and room_id = p_room_id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  -- 3) Satır kilidi — bundan sonraki her okuma kanonik ve yarışsızdır.
  select * into v_room from public.tevatur_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- 4) Oyun aktif değilse sessizce çık (lobi / bitmiş maç).
  if v_room.status <> 'playing' or v_room.game_state is null then
    return v_room;
  end if;

  v_state := v_room.game_state;
  v_idx   := (v_state->>'roundIndex')::int;
  v_phase := v_state->>'phase';

  -- 5) CAS: çağıranın ilerlettiğini sandığı durum hâlâ aktif mi? Yarışı
  --    kaybeden çağıranlar (ve bayat istemciler) burada no-op'a düşer.
  if v_idx <> p_expected_round or v_phase <> p_expected_phase then
    return v_room;
  end if;

  -- 6) Terminal faz ilerletilemez.
  if v_phase = 'final_results' then
    return v_room;
  end if;

  -- 7) DEADLINE OTORİTESİ. phaseEndsAt KİLİTLİ satırdan okunur; istemci
  --    parametre olarak deadline GÖNDEREMEZ ve istemcinin Date.now()'ı
  --    karara girmez. Süre dolmadıysa durum DEĞİŞMEZ.
  v_deadline := (v_state->>'phaseEndsAt')::bigint;
  if v_deadline is null then
    return v_room;
  end if;
  if public.tevatur_kn_now_ms() < v_deadline then
    return v_room;   -- not_due
  end if;

  -- ── Geçiş zinciri — advance_phase (20260723120000) ile BİREBİR ──────────
  if v_phase = 'role_reveal' then
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('observe_report'::text));
    -- Ortak inceleme + dedektif soru seçimi fazı: 35 sn (tek kaynak).
    v_state := jsonb_set(v_state, '{phaseEndsAt}',
                         to_jsonb(public.tevatur_kn_now_ms() + public.tevatur_kn_phase_duration_ms()));

  elsif v_phase = 'observe_report' then
    -- Süre doldu; dedektif(ler)in eksik seçimi havuzdan 5'e tamamlanır.
    v_state := public.tevatur_kn_fill_questions(v_state);
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('answer_questions'::text));
    -- Cevaplama fazı: 35 sn (tek kaynak).
    v_state := jsonb_set(v_state, '{phaseEndsAt}',
                         to_jsonb(public.tevatur_kn_now_ms() + public.tevatur_kn_phase_duration_ms()));

  elsif v_phase = 'answer_questions' then
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('detective_guess'::text));
    -- Konum tahmini fazı: 35 sn (tek kaynak).
    v_state := jsonb_set(v_state, '{phaseEndsAt}',
                         to_jsonb(public.tevatur_kn_now_ms() + public.tevatur_kn_phase_duration_ms()));

  elsif v_phase = 'detective_guess' then
    -- Süre doldu; eksik tahmin(ler) 0 puan, mevcutlar hesaplanır → round_reveal.
    v_state := public.tevatur_kn_apply_round(v_state);

  elsif v_phase = 'round_reveal' then
    if v_idx + 1 >= (v_state->>'roundCount')::int then
      v_state := jsonb_set(v_state, '{phase}', to_jsonb('final_results'::text));
      v_state := jsonb_set(v_state, '{phaseEndsAt}', 'null'::jsonb);

      update public.tevatur_rooms
         set status          = 'finished',
             finished_at     = now(),
             finished_reason = 'completed',
             game_state      = v_state
       where id = p_room_id
       returning * into v_room;
      return v_room;
    end if;

    v_state := jsonb_set(v_state, '{roundIndex}', to_jsonb(v_idx + 1));
    v_state := jsonb_set(
      v_state, '{rounds}',
      (v_state->'rounds') || jsonb_build_array(
        public.tevatur_kn_build_round(v_state, v_idx + 1)
      )
    );
    v_state := jsonb_set(v_state, '{phase}', to_jsonb('role_reveal'::text));
    v_state := jsonb_set(v_state, '{phaseEndsAt}', to_jsonb(public.tevatur_kn_now_ms() + 4000));

  else
    return v_room;  -- bilinmeyen faz → dokunma
  end if;

  update public.tevatur_rooms
     set game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

-- ACL — AÇIK ve KASITLI.
-- `revoke all … from public` tek başına YETMEZ: Supabase'de public şemasında
-- doğan bir fonksiyon anon'a DOĞRUDAN EXECUTE ile gelir, PUBLIC üzerinden
-- değil. Burada anon'un çağırabilmesi ZATEN İSTENEN durumdur (misafir, host
-- arka plandayken maçı kurtaran taraftır), o yüzden grant açıkça yazılır —
-- varsayılan davranışa güvenilmez.
--
-- Misafirin bu fonksiyona erişebilmesi ona host yetkisi VERMEZ: gövdedeki
-- deadline + CAS kontrolleri, yapabileceği tek şeyi "sunucunun zaten yapacağı
-- geçişi tetiklemek" ile sınırlar.
revoke all     on function public.tevatur_kn_advance_if_due(uuid, uuid, uuid, int, text) from public;
grant  execute on function public.tevatur_kn_advance_if_due(uuid, uuid, uuid, int, text) to anon, authenticated;

-- NOT: public.tevatur_kn_advance_phase(uuid, uuid, uuid, int, text) ACL'i
-- BİLİNÇLİ OLARAK DEĞİŞMEDİ. anon'un onda da EXECUTE'u vardır (20260809120000
-- §B4) ama `tevatur_authorize_host` misafiri reddeder — misafir oda kuramaz,
-- host devrinde de aday olamaz (20260810120000). Yetki kararı tek yerde kalsın
-- diye grant değil, gövde karar verir.


-- ============================================================================
-- DOĞRULAMA (Supabase Studio → SQL Editor)
-- ============================================================================
--
-- A) Fonksiyon var ve ACL doğru:
--   select p.proname, p.prosecdef, pg_catalog.array_to_string(p.proacl, E'\n')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('tevatur_kn_advance_if_due','tevatur_kn_advance_phase');
--   -- Beklenen: ikisi de prosecdef = t; if_due'da anon=X ve authenticated=X.
--
-- B) Süre DOLMADAN çağır → durum DEĞİŞMEMELİ:
--   select game_state->>'phase', game_state->>'phaseEndsAt'
--     from tevatur_rooms where id = '<ODA>';
--   select public.tevatur_kn_advance_if_due(
--            '<ODA>','<OYUNCU>','<TOKEN>',
--            (select (game_state->>'roundIndex')::int from tevatur_rooms where id='<ODA>'),
--            (select  game_state->>'phase'            from tevatur_rooms where id='<ODA>'));
--   -- Beklenen: phase ve phaseEndsAt AYNI kalır.
--
-- C) Başka odanın geçerli token'ı → reddedilmeli:
--   select public.tevatur_kn_advance_if_due('<BU_ODA>','<BASKA_ODANIN_OYUNCUSU>','<ONUN_TOKENI>',0,'role_reveal');
--   -- Beklenen: ERROR 42501 not_a_member
--
-- D) Misafir manuel geçiş YAPAMAZ (anon anahtarıyla, Studio DEĞİL):
--   POST /rest/v1/rpc/tevatur_kn_advance_phase  → 42501 unauthorized
--   POST /rest/v1/rpc/tevatur_kn_advance_if_due → süre dolduysa ilerler
-- ============================================================================
