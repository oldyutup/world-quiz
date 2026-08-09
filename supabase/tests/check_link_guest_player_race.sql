-- ============================================================================
-- M2 EŞZAMANLILIK TESTİ — torble_link_guest_player
-- 20260814120000_link_guest_player_room_lock.sql'in doğrulaması
-- ============================================================================
-- Supabase Studio → SQL Editor.
--
-- TEST A tamamen bir transaction içinde çalışır ve SONUNDA ROLLBACK yapar →
-- veritabanında HİÇBİR KALICI İZ BIRAKMAZ. Önce A'yı koş.
-- TEST B gerçek yarışı kanıtlar; iki AYRI sekme gerektirir (commit şart) ve
-- kendi temizliğini içerir.
--
-- GERÇEK KULLANICI VERİSİNE DOKUNULMAZ: `tevatur_players.profile_id` üzerinde
-- `profiles`e yabancı anahtar YOKTUR, bu yüzden test SENTETİK profil uuid'leri
-- kullanır. Hiçbir gerçek hesap, oda veya oyuncu satırı okunmaz/yazılmaz.
--
-- ŞEMA NOTLARI (test bunlara uymak ZORUNDA — 20260711120000 + 20260809120000):
--   • tevatur_rooms.status ∈ ('waiting','playing','finished')   ('lobby' YOK)
--   • tevatur_players kimlik kısıtı `tevatur_players_identity_xor`:
--       kayıtlı (profile_id) XOR misafir (guest_id) XOR tombstone
--     tombstone satırının ADI id'den TÜRETİLMEK ZORUNDA:
--       'Silinmiş#' || substr(md5(id::text), 1, 7)
-- ============================================================================


-- ############################################################################
-- TEST A — invariant + yetki zinciri (tek oturum, ROLLBACK ile biter)
-- ############################################################################
begin;

do $$
declare
  v_uid_a  uuid := gen_random_uuid();          -- sentetik "hesap A"
  v_uid_b  uuid := gen_random_uuid();          -- sentetik "hesap B"
  v_room   uuid := gen_random_uuid();
  v_p1     uuid := gen_random_uuid();          -- misafir slot 1
  v_p2     uuid := gen_random_uuid();          -- misafir slot 2 (AYNI oda)
  v_p3     uuid := gen_random_uuid();          -- tombstone slot
  v_tok1   uuid := gen_random_uuid();
  v_tok2   uuid := gen_random_uuid();
  v_tok3   uuid := gen_random_uuid();
  v_res    boolean;
  v_err    text;
  v_passed int := 0;
  v_failed int := 0;
begin
  -- ── Sentetik oda + iki MİSAFİR slot + bir TOMBSTONE ─────────────────────
  insert into public.tevatur_rooms (id, code, host_player_id, status)
  values (v_room, 'ZZTEST', v_p1, 'waiting');

  insert into public.tevatur_players (id, room_id, profile_id, guest_id, name)
  values
    (v_p1, v_room, null, 'guest-aaa', 'misafir_bir'),
    (v_p2, v_room, null, 'guest-bbb', 'misafir_iki'),
    -- Tombstone: ad kimlik kısıtı gereği id'den TÜRETİLİR.
    (v_p3, v_room, null, null, 'Silinmiş#' || substr(md5(v_p3::text), 1, 7));

  insert into public.tevatur_player_claims (player_id, claim_token)
  values (v_p1, v_tok1), (v_p2, v_tok2), (v_p3, v_tok3);

  -- Caller'ı A yap (auth.uid() → request.jwt.claims.sub).
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid_a)::text, true);

  -- ── 1) İlk devir başarılı ────────────────────────────────────────────────
  v_res := public.torble_link_guest_player('korNokta', v_p1, v_tok1);
  if v_res then v_passed := v_passed + 1; raise notice '  ✓ 1. slot devri başarılı';
  else v_failed := v_failed + 1; raise notice '  ✗ 1. slot devri BAŞARISIZ'; end if;

  -- Satır KORUNDU mu? (aynı id, profil bağlandı, guest_id temizlendi)
  if exists (select 1 from public.tevatur_players
              where id = v_p1 and profile_id = v_uid_a and guest_id is null
                and room_id = v_room and name = 'misafir_bir')
  then v_passed := v_passed + 1;
       raise notice '  ✓ AYNI satır: profile_id doldu, guest_id null, room/name korundu';
  else v_failed := v_failed + 1; raise notice '  ✗ satır beklenen hâlde değil'; end if;

  if (select count(*) from public.tevatur_players where room_id = v_room) = 3
  then v_passed := v_passed + 1; raise notice '  ✓ YENİ satır oluşmadı (oda hâlâ 3 satır)';
  else v_failed := v_failed + 1; raise notice '  ✗ oda satır sayısı değişti'; end if;

  -- ── 2) İdempotentlik ─────────────────────────────────────────────────────
  v_res := public.torble_link_guest_player('korNokta', v_p1, v_tok1);
  if v_res then v_passed := v_passed + 1; raise notice '  ✓ aynı çağrı tekrar → idempotent true';
  else v_failed := v_failed + 1; raise notice '  ✗ idempotentlik bozuldu'; end if;

  -- ── 3) ASIL INVARIANT: aynı profil, aynı odada İKİNCİ slot ───────────────
  begin
    v_res := public.torble_link_guest_player('korNokta', v_p2, v_tok2);
    v_failed := v_failed + 1;
    raise notice '  ✗ İKİNCİ SLOT DEVREDİLDİ — invariant KIRIK!';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err = 'already_in_room' then
      v_passed := v_passed + 1;
      raise notice '  ✓ aynı odada ikinci slot reddedildi (already_in_room)';
    else
      v_failed := v_failed + 1; raise notice '  ✗ beklenmeyen hata: %', v_err;
    end if;
  end;

  -- ── 4) Yanlış claim_token reddediliyor (caller artık B) ──────────────────
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid_b)::text, true);
  begin
    v_res := public.torble_link_guest_player('korNokta', v_p2, gen_random_uuid());
    v_failed := v_failed + 1; raise notice '  ✗ YANLIŞ claim_token kabul edildi!';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err = 'claim_mismatch' then
      v_passed := v_passed + 1; raise notice '  ✓ yanlış claim_token reddedildi (claim_mismatch)';
    else
      v_failed := v_failed + 1; raise notice '  ✗ beklenmeyen hata: %', v_err;
    end if;
  end;

  -- ── 5) FARKLI profil ETKİLENMİYOR ────────────────────────────────────────
  v_res := public.torble_link_guest_player('korNokta', v_p2, v_tok2);
  if v_res and exists (select 1 from public.tevatur_players
                        where id = v_p2 and profile_id = v_uid_b)
  then v_passed := v_passed + 1;
       raise notice '  ✓ FARKLI profil kendi slotunu alabiliyor (izolasyon korunuyor)';
  else v_failed := v_failed + 1; raise notice '  ✗ farklı profil etkilendi'; end if;

  -- ── 6) Başkasının (artık kayıtlı) satırı devralınamaz ────────────────────
  begin
    v_res := public.torble_link_guest_player('korNokta', v_p1, v_tok1);
    v_failed := v_failed + 1; raise notice '  ✗ BAŞKA hesabın satırı devralındı!';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err = 'not_a_guest_row' then
      v_passed := v_passed + 1; raise notice '  ✓ başkasının satırı reddedildi (not_a_guest_row)';
    else
      v_failed := v_failed + 1; raise notice '  ✗ beklenmeyen hata: %', v_err;
    end if;
  end;

  -- ── 7) Tombstone (silinmiş hesap satırı) devralınamaz ────────────────────
  begin
    v_res := public.torble_link_guest_player('korNokta', v_p3, v_tok3);
    v_failed := v_failed + 1; raise notice '  ✗ TOMBSTONE satırı devralındı!';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err = 'not_a_guest_row' then
      v_passed := v_passed + 1; raise notice '  ✓ tombstone satırı reddedildi (not_a_guest_row)';
    else
      v_failed := v_failed + 1; raise notice '  ✗ beklenmeyen hata: %', v_err;
    end if;
  end;

  -- ── 8) Geçersiz mod ──────────────────────────────────────────────────────
  begin
    v_res := public.torble_link_guest_player('__yok__', v_p2, v_tok2);
    v_failed := v_failed + 1; raise notice '  ✗ geçersiz mod kabul edildi!';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err = 'mode_invalid' then
      v_passed := v_passed + 1; raise notice '  ✓ geçersiz mod reddedildi (mode_invalid)';
    else
      v_failed := v_failed + 1; raise notice '  ✗ beklenmeyen hata: %', v_err;
    end if;
  end;

  -- ── 9) Girişsiz (auth.uid() null) çağrı ──────────────────────────────────
  perform set_config('request.jwt.claims', '', true);
  begin
    v_res := public.torble_link_guest_player('korNokta', v_p2, v_tok2);
    v_failed := v_failed + 1; raise notice '  ✗ auth.uid() NULL iken devir yapıldı!';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err = 'auth_required' then
      v_passed := v_passed + 1; raise notice '  ✓ girişsiz çağrı reddedildi (auth_required)';
    else
      v_failed := v_failed + 1; raise notice '  ✗ beklenmeyen hata: %', v_err;
    end if;
  end;

  -- ── 10) Serileştirme gövdede mi? ─────────────────────────────────────────
  if pg_get_functiondef(to_regprocedure('public.torble_link_guest_player(text,uuid,uuid)'))
     ~ 'pg_advisory_xact_lock'
  then v_passed := v_passed + 1; raise notice '  ✓ oda bazında serileştirme gövdede mevcut';
  else v_failed := v_failed + 1;
       raise notice '  ✗ pg_advisory_xact_lock YOK — migration uygulanmamış'; end if;

  -- ── 11) Grant'lar ────────────────────────────────────────────────────────
  if not has_function_privilege('anon',
        'public.torble_link_guest_player(text,uuid,uuid)', 'execute')
  then v_passed := v_passed + 1; raise notice '  ✓ anon EXECUTE kapalı';
  else v_failed := v_failed + 1; raise notice '  ✗ anon EXECUTE AÇIK!'; end if;

  if has_function_privilege('authenticated',
        'public.torble_link_guest_player(text,uuid,uuid)', 'execute')
  then v_passed := v_passed + 1; raise notice '  ✓ authenticated EXECUTE açık';
  else v_failed := v_failed + 1; raise notice '  ✗ authenticated EXECUTE kapalı!'; end if;

  raise notice '';
  if v_failed = 0 then
    raise notice '✅ TEST A: % geçti, 0 başarısız', v_passed;
  else
    raise notice '❌ TEST A: % geçti, % BAŞARISIZ', v_passed, v_failed;
  end if;
end$$;

-- Hiçbir kalıcı iz bırakma.
rollback;


-- ############################################################################
-- TEST B — GERÇEK YARIŞ (iki AYRI SQL Editor sekmesi)
-- ############################################################################
-- Amaç: iki EŞZAMANLI devrin artık SIRAYA girdiğini ve ikincisinin
-- `already_in_room` ile reddedildiğini kanıtlamak.
--
-- Migration ÖNCESİ bu senaryo İKİ slotu da bağlardı (iki transaction birbirinin
-- commit edilmemiş güncellemesini göremediği için). Sonrasında SEKME 2
-- BLOKLANIR, SEKME 1 commit edince uyanır ve reddedilir.
--
-- ─────────────────────────────────────────────────────────────────────────
-- HAZIRLIK (tek sefer, herhangi bir sekme). Çıktıdaki değerleri not al.
-- ─────────────────────────────────────────────────────────────────────────
/*
do $$
declare v_uid uuid := gen_random_uuid(); v_room uuid := gen_random_uuid();
        v_p1 uuid := gen_random_uuid(); v_p2 uuid := gen_random_uuid();
        v_t1 uuid := gen_random_uuid(); v_t2 uuid := gen_random_uuid();
begin
  insert into public.tevatur_rooms (id, code, host_player_id, status)
  values (v_room, 'ZZRACE', v_p1, 'waiting');
  insert into public.tevatur_players (id, room_id, profile_id, guest_id, name)
  values (v_p1, v_room, null, 'race-a', 'yaris_bir'),
         (v_p2, v_room, null, 'race-b', 'yaris_iki');
  insert into public.tevatur_player_claims (player_id, claim_token)
  values (v_p1, v_t1), (v_p2, v_t2);
  raise notice 'UID=%', v_uid;
  raise notice 'ROOM=%', v_room;
  raise notice 'P1=%  T1=%', v_p1, v_t1;
  raise notice 'P2=%  T2=%', v_p2, v_t2;
end$$;
*/

-- ── SEKME 1 — çalıştır, COMMIT ETMEDEN BEKLE ─────────────────────────────
/*
begin;
select set_config('request.jwt.claims', json_build_object('sub','<UID>')::text, true);
select public.torble_link_guest_player('korNokta', '<P1>', '<T1>');   -- true
-- COMMIT ETME. Sekme 2'ye geç.
*/

-- ── SEKME 2 — çalıştır: BLOKLANMALI (oda kilidi Sekme 1'de) ──────────────
/*
begin;
select set_config('request.jwt.claims', json_build_object('sub','<UID>')::text, true);
select public.torble_link_guest_player('korNokta', '<P2>', '<T2>');
-- ⏳ BEKLER. Bu bekleme düzeltmenin ta kendisidir: migration ÖNCESİ burada
--    ANINDA `true` dönerdi ve hesap odada İKİ slota sahip olurdu.
*/

-- ── SEKME 1 — şimdi commit et ────────────────────────────────────────────
/*
commit;
*/

-- ── SEKME 2 — uyanır ve REDDEDİLİR ───────────────────────────────────────
--   BEKLENEN:  ERROR: already_in_room
--   Ardından:  rollback;

-- ── SONUÇ DOĞRULAMASI + TEMİZLİK ─────────────────────────────────────────
/*
-- Beklenen: TAM OLARAK 1 satır bağlanmış.
select count(*) as baglanan_slot
  from public.tevatur_players
 where room_id = '<ROOM>' and profile_id is not null;   -- => 1

delete from public.tevatur_player_claims
 where player_id in (select id from public.tevatur_players where room_id = '<ROOM>');
delete from public.tevatur_players where room_id = '<ROOM>';
delete from public.tevatur_rooms   where id = '<ROOM>';
*/
-- ============================================================================
