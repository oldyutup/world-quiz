-- ============================================================================
-- UGC GÜVENLİK PAKETİ — İçerik filtresi + Raporlama + Moderasyon (App Store 1.2)
-- ============================================================================
-- AMAÇ (minimum ama gerçek anlamda çalışan sistem):
--   A) Sunucu-otoriter içerik normalizasyonu + filtre (username/display/mesaj).
--   B) profiles.username backend zorlaması (tüm yazma yolları tek trigger'da).
--   C) Misafir görünen ad guard'ını ortak filtreyle birleştirme.
--   D) 9 lobi/oda mesaj yolu — tek duel_messages BEFORE INSERT trigger'ı.
--   E) DM mesaj filtresi.
--   F) reports tablosu + güvenli hedef-türüne-özgü RPC'ler + dedup/rate-limit.
--   G) Moderasyon durumu (active/suspended/banned) + gerçek zorlama.
--   H) Doğrulama/audit sorguları (read-only).
--
-- GÜVENLİK İLKELERİ:
--   * Yardımcı filtre fonksiyonları PRIVATE (revoke from public/anon/authenticated).
--     Yalnız SECURITY DEFINER trigger/RPC'lerden (owner: postgres) çağrılır.
--   * reports tablosuna anon/authenticated DOĞRUDAN erişemez (INSERT/SELECT/
--     UPDATE/DELETE yok). Yalnız güvenli RPC üzerinden rapor oluşur.
--   * Reporter kimliği DAİMA sunucuda (auth.uid() / doğrulanmış claim) türetilir.
--   * Snapshot'lar DAİMA sunucudan (gerçek tablodan) alınır; istemci gönderemez.
--   * Uygunsuz içerik maskelenmez — işlem tamamen reddedilir, tabloya yazılmaz.
--
-- IDEMPOTENT: create or replace + if not exists + drop trigger if exists.
-- Elle (Supabase Studio SQL editor) uygulanabilir. Canlıya BU migration ile
-- push edilmedi; deploy sırası repodaki MODERATION_RUNBOOK.md'de.
-- ============================================================================

-- Extension GEREKMEZ: gen_random_uuid() (PG13+), sha256()/convert_to()/encode()
-- (PG11+) pg_catalog BUILTIN'leridir. Canlı Postgres 17 → hepsi mevcut. pgcrypto
-- (extensions şemasındaki digest) ya da başka bir extension'a BAĞIMLILIK YOK.


-- ════════════════════════════════════════════════════════════════════════════
-- BÖLÜM A — ORTAK İÇERİK NORMALİZASYONU VE FİLTRE
-- ════════════════════════════════════════════════════════════════════════════

-- ----------------------------------------------------------------------------
-- A1) normalize_moderation_text — deterministik, immutable normalizasyon.
-- ----------------------------------------------------------------------------
-- Adımlar (username_key ile BİREBİR aynı katlama haritası — kanıtlanmış):
--   1) noktalı/noktasız I (İ, I, ı) → 'i'  (locale-bağımsız, lower'dan ÖNCE)
--   2) lower()
--   3) Türkçe + yaygın Latin aksanları ASCII'ye katla
--   4) 3+ ardışık aynı karakteri 1'e indir  ("siktirrr" → "siktir", "aaaa" → "a")
--   5) ardışık boşlukları tek boşluğa indir + btrim
-- Yalnız EŞLEŞTİRME için kullanılır; kullanıcının gerçek metni DEĞİŞTİRİLMEZ.
create or replace function public.normalize_moderation_text(p_text text)
returns text
language sql
immutable
as $fn$
  select btrim(
           regexp_replace(
             regexp_replace(
               translate(
                 lower(translate(coalesce(p_text, ''), 'İIı', 'iii')),
                 'çğıöşüàáâäãåèéêëìíîïòóôõùúûñýÿ',
                 'cgiosuaaaaaaeeeeiiiioooouuunyy'
               ),
               '(.)\1{2,}', '\1', 'g'      -- 3+ ardışık tekrar → 1
             ),
             '\s+', ' ', 'g'              -- boşluk normalize
           )
         );
$fn$;

comment on function public.normalize_moderation_text(text) is
  'UGC içerik filtresi için deterministik normalizasyon (lower + Türkçe/aksan '
  'katlama + tekrar/boşluk sadeleştirme). Yalnız eşleştirme amaçlı; PRIVATE.';

-- ----------------------------------------------------------------------------
-- A2) text_has_forbidden_content(p_text, p_context) — çekirdek filtre.
-- ----------------------------------------------------------------------------
-- FALSE-POSITIVE ÖNCELİKLİ tasarım (task gereği):
--   * NAME bağlamı (username/display_name): ad tek token'dır (boşluk yok) →
--     agresif "contains/substring" güvenli. Mevcut assert_display_name_allowed
--     davranışıyla uyumlu + impersonation/rezerv listesi.
--   * MESSAGE bağlamı (room_message/dm_message): metin token'lara bölünür; her
--     token için YALNIZ tam-eşleşme veya ÖN-EK (prefix) kontrolü yapılır.
--     Böylece cümle içi infix çakışması OLMAZ:
--       "eksiktir" LIKE 'siktir%' = false     (yanlış pozitif değil)
--       "push it"  → token 'shit' YOK          (yanlış pozitif değil)
--       "therapist" → prefix 'rapist' = false
--     Impersonation/rezerv kelimeleri mesajlarda ENGELLENMEZ ("torble süper" ok).
--
-- Kısa/genel parçalar (sex, ass, sik, got, am, pic ...) BİLİNÇLİ olarak listede
-- YOK — yaygın masum kelimelere çarpar. Leetspeak: birkaç yüksek-güvenli varyant
-- (0→o 1→i 3→e 4→a 5→s 7→t $→s @→a) türetilip aynı listeyle taranır.
create or replace function public.text_has_forbidden_content(p_text text, p_context text)
returns boolean
language plpgsql
immutable
as $fn$
declare
  v_norm  text := public.normalize_moderation_text(p_text);
  v_name  text;
  v_nlt   text;                          -- name, deleetlenmiş
  v_tlt   text;                          -- aday/token, deleetlenmiş
  v_pref  text;
  v_term  text;

  -- Her iki bağlamda geçerli, tek başına token olduğunda küfür kısaltmaları.
  c_exact_crude constant text[] := array['amk','amq','aq','mk'];

  -- YALNIZ NAME bağlamı: tam ad bu değerlerden biriyse reddet (rezerv/otorite).
  c_exact_reserved constant text[] := array[
    'mod','staff','owner','host','system','sistem','support','destek',
    'admin','moderator','null','undefined','none','noone','nobody',
    'anon','anonymous','guest','torble','official','yetkili','kurucu',
    'yonetici','bot','npc'
  ];

  -- Her iki bağlam: token bunlardan biriyle BAŞLIYORSA reddet (küfür kökleri).
  -- Prefix-güvenli seçildi (ör. 'siktir' → "eksiktir" ile ÇAKIŞMAZ).
  c_prefix constant text[] := array[
    -- İngilizce
    'fuck','shit','bitch','cunt','whore','slut','faggot','nigger','nigga',
    'rapist','pussy','cumshot','blowjob','dickhead','asshole','motherfuck',
    'bullshit','cocksuck',
    -- Türkçe (aksan katlanmış)
    'orospu','siktir','sikey','siker','sikecek','sikik','sikis',
    'amcik','amcig','amcuk','yarrak','yarak','yarag','pezeven','gotveren',
    'gotver','ibne','ibno','yavsak','serefsiz','kahpe','kaltak','gavat',
    'surtuk','godos','oxpicti'
  ];

  -- YALNIZ NAME bağlamı: adın HERHANGİ bir yerinde geçerse reddet. Infix-güvenli
  -- (masum kelimelere çarpmayan) çekirdek + impersonation.
  c_contains_name constant text[] := array[
    'admin','administrator','moderator','official','torble','geoquiz',
    'orospu','pezevenk','gotveren'
  ];
begin
  if v_norm is null or length(v_norm) = 0 then
    return false;
  end if;

  if p_context in ('username','display_name') then
    -- Ad → tek token'a sıkıştır (boşluk/noktalama at).
    v_name := regexp_replace(v_norm, '[^a-z0-9]', '', 'g');
    if length(v_name) = 0 then
      return false;
    end if;
    v_nlt := translate(v_name, '013457$@', 'oieastsa');

    -- Tam-eşleşme (crude + reserved).
    if v_name = any(c_exact_crude) or v_nlt = any(c_exact_crude)
       or v_name = any(c_exact_reserved) or v_nlt = any(c_exact_reserved) then
      return true;
    end if;
    -- Prefix (küfür kökleri).
    foreach v_pref in array c_prefix loop
      if v_name like v_pref || '%' or v_nlt like v_pref || '%' then
        return true;
      end if;
    end loop;
    -- Contains (impersonation + infix-güvenli küfür).
    foreach v_term in array c_contains_name loop
      if position(v_term in v_name) > 0 or position(v_term in v_nlt) > 0 then
        return true;
      end if;
    end loop;
    return false;

  elsif p_context in ('room_message','dm_message') then
    -- Mesaj → aday-kelime bazlı (infix çakışması YOK → "eksiktir"/"push it" temiz):
    --   (a) her gerçek token,
    --   (b) ardışık TEK-karakter token dizileri birleştirilir ("s.i.k.t.i.r",
    --       "f u c k" gibi ayırıcıyla-hecele aşımını yakalar; çok-harfli kelimeler
    --       böyle bir diziye ASLA girmez → yanlış pozitif üretmez).
    -- Her aday YALNIZ exact-crude veya ÖN-EK ile eşleşir.
    declare
      v_toks text[] := (
        select array_agg(t)
          from regexp_split_to_table(v_norm, '[^a-z0-9]+') as t
         where length(t) > 0
      );
      v_cands text[];
      v_buf   text := '';
      v_run   int := 0;
      i       int;
      v_cand  text;
    begin
      if v_toks is null then
        return false;
      end if;
      v_cands := v_toks;                                   -- (a) tokenlar
      for i in 1 .. array_length(v_toks, 1) loop          -- (b) tek-karakter dizileri
        if length(v_toks[i]) = 1 then
          v_buf := v_buf || v_toks[i];
          v_run := v_run + 1;
        else
          if v_run >= 2 then v_cands := array_append(v_cands, v_buf); end if;
          v_buf := ''; v_run := 0;
        end if;
      end loop;
      if v_run >= 2 then v_cands := array_append(v_cands, v_buf); end if;

      foreach v_cand in array v_cands loop
        v_tlt := translate(v_cand, '013457$@', 'oieastsa');
        if v_cand = any(c_exact_crude) or v_tlt = any(c_exact_crude) then
          return true;
        end if;
        foreach v_pref in array c_prefix loop
          if v_cand like v_pref || '%' or v_tlt like v_pref || '%' then
            return true;
          end if;
        end loop;
      end loop;
      return false;
    end;

  else
    -- Bilinmeyen bağlam → güvenli taraf: engelleme (false). Çağıranlar sabit
    -- bağlam string'leri kullanır; buraya düşmek beklenmez.
    return false;
  end if;
end
$fn$;

comment on function public.text_has_forbidden_content(text, text) is
  'UGC filtre çekirdeği. Bağlam: username|display_name (contains, sıkı) veya '
  'room_message|dm_message (token-prefix, precision). PRIVATE.';

-- ----------------------------------------------------------------------------
-- A3) assert_text_allowed — reddederse STABİL kod ile exception fırlatır.
-- ----------------------------------------------------------------------------
-- Eşleşen kelime / liste İFŞA EDİLMEZ (yalnız stabil kod). Frontend bu kodları
-- kullanıcı-dostu Türkçe mesaja çevirir.
create or replace function public.assert_text_allowed(p_text text, p_context text)
returns void
language plpgsql
immutable
as $fn$
begin
  if public.text_has_forbidden_content(p_text, p_context) then
    if p_context = 'username' then
      raise exception 'UGC_USERNAME_NOT_ALLOWED' using errcode = 'P0001';
    elsif p_context = 'display_name' then
      raise exception 'UGC_DISPLAY_NAME_NOT_ALLOWED' using errcode = 'P0001';
    else
      raise exception 'UGC_MESSAGE_NOT_ALLOWED' using errcode = 'P0001';
    end if;
  end if;
end
$fn$;

-- Yardımcılar PRIVATE — public/anon/authenticated doğrudan çağıramaz.
revoke all on function public.normalize_moderation_text(text)        from public, anon, authenticated;
revoke all on function public.text_has_forbidden_content(text, text) from public, anon, authenticated;
revoke all on function public.assert_text_allowed(text, text)        from public, anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- BÖLÜM G-öncesi — MODERASYON ŞEMASI (helper'lar filtre trigger'larından önce
--   gerektiği için burada tanımlanır)
-- ════════════════════════════════════════════════════════════════════════════

-- G1) profiles moderasyon kolonları.
-- moderation_note BİLİNÇLİ olarak BURADA YOK — profiles DÜNYA-OKUNUR (canlı
-- schema dump: RLS "Profiles are viewable by everyone" USING(true) + tablo GRANT
-- anon/authenticated). Not ayrı PRIVATE tabloda (G2b). Yalnız durum kolonları —
-- düşük hassasiyet, self-update REVOKE'lu, SECURITY DEFINER helper'ların okuduğu.
alter table public.profiles
  add column if not exists moderation_status text not null default 'active'
    check (moderation_status in ('active','suspended','banned')),
  add column if not exists suspended_until   timestamptz null;

comment on column public.profiles.moderation_status is
  'active | suspended | banned. YALNIZ service_role/postgres değiştirebilir. '
  'Kullanıcı self-update ile DEĞİŞTİREMEZ — GERÇEK zorlama _profiles_ugc_enforce '
  'BEFORE UPDATE trigger''ında (kolon REVOKE tek başına yetersiz, aşağıya bkz.).';

-- G2) KRİTİK: profiles'ta tablo-seviyesi 'GRANT ALL ... TO authenticated' var
--     (kanıtlı canlı schema dump). PostgreSQL'de tablo-seviyesi UPDATE grant'ı
--     varken KOLON-seviyesi 'REVOKE UPDATE (col)' NO-OP'tur → kullanıcı kendi
--     satırında (RLS own-row update'e izin verir) moderation_status'u 'active'
--     yapıp KENDİNİ BAN'DAN ÇIKARABİLİRDİ. Kanıtlandı ve düzeltildi. Aşağıdaki
--     REVOKE'lar belt-and-suspenders (grant ileride daralırsa etkir); GERÇEK
--     zorlama _profiles_ugc_enforce trigger'ının moderasyon-immutability dalıdır.
--     (Aynı no-op deseni mevcut 'gold' REVOKE'unu da etkiler — ayrı/kapsam-dışı.)
revoke update (moderation_status) on public.profiles from anon, authenticated;
revoke update (suspended_until)   on public.profiles from anon, authenticated;

-- G2b) PRIVATE moderasyon notu tablosu. moderation_note ASLA public.profiles'ta
--      TUTULMAZ (profiles dünya-okunur; kanıtlı canlı schema dump). Not burada,
--      anon/authenticated'a HİÇBİR erişim YOK. Public şemada
--      'ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon,authenticated'
--      yeni tabloya OTOMATİK grant verdiğinden hemen ardından REVOKE ALL alınır +
--      RLS açık/policy yok → iki katmanlı deny. Sahip postgres (SQL Editor /
--      SECURITY DEFINER) ve service_role (bypassrls) erişir; not oradan yönetilir.
create table if not exists public.profile_moderation (
  profile_id  uuid        primary key references public.profiles(id) on delete cascade,
  note        text        null,
  updated_at  timestamptz not null default now()
);

comment on table public.profile_moderation is
  'PRIVATE moderasyon notları (ban/askı gerekçesi). anon/authenticated ERİŞEMEZ '
  '(REVOKE ALL + RLS policy YOK). Yalnız postgres/service_role. profiles dünya-'
  'okunur olduğundan not ASLA orada tutulmaz; buradan yönetilir.';

alter table public.profile_moderation enable row level security;
revoke all on public.profile_moderation from anon, authenticated;
-- (Bilinçli olarak HİÇBİR policy tanımlanmadı → anon/authenticated tümüyle deny.)

-- G3) assert_profile_moderation_active(profile_id) — banned/aktif-suspended ise
--     STABİL kod fırlatır. Süresi GEÇMİŞ suspension engellemez (auto-expiry).
--     moderation_note İFŞA EDİLMEZ.
create or replace function public.assert_profile_moderation_active(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_status text;
  v_until  timestamptz;
begin
  if p_profile_id is null then
    return;                              -- misafir/sistem bağlamı → no-op
  end if;
  select moderation_status, suspended_until
    into v_status, v_until
    from public.profiles
   where id = p_profile_id;
  if not found then
    return;
  end if;
  if v_status = 'banned' then
    raise exception 'ACCOUNT_BANNED' using errcode = 'P0001';
  end if;
  if v_status = 'suspended' and (v_until is null or v_until > now()) then
    raise exception 'ACCOUNT_SUSPENDED' using errcode = 'P0001';
  end if;
end
$fn$;

revoke all on function public.assert_profile_moderation_active(uuid) from public, anon, authenticated;

-- G4) get_my_moderation_status() — kullanıcı kendi durumunu okur (giriş/başlangıç
--     akışı için). moderation_note DÖNMEZ. suspended_until süresi geçmişse
--     'active' gibi raporlanır.
create or replace function public.get_my_moderation_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me    uuid := auth.uid();
  v_status text;
  v_until  timestamptz;
begin
  if v_me is null then
    return jsonb_build_object('status', 'active', 'suspended_until', null);
  end if;
  select moderation_status, suspended_until into v_status, v_until
    from public.profiles where id = v_me;
  if v_status is null then
    return jsonb_build_object('status', 'active', 'suspended_until', null);
  end if;
  if v_status = 'suspended' and v_until is not null and v_until <= now() then
    return jsonb_build_object('status', 'active', 'suspended_until', null);
  end if;
  return jsonb_build_object(
    'status', v_status,
    'suspended_until', case when v_status = 'suspended' then v_until else null end
  );
end
$fn$;

revoke all     on function public.get_my_moderation_status() from public;
grant  execute on function public.get_my_moderation_status() to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- BÖLÜM B — USERNAME BACKEND ZORLAMASI (tüm yazma yolları tek trigger'da)
-- ════════════════════════════════════════════════════════════════════════════
-- profiles.username üzerinde BEFORE INSERT OR UPDATE trigger. Böylece:
--   normal UI / doğrudan REST / createProfile / setInitialUsername /
--   change_username — HEPSİ aynı sunucu filtresinden geçer, self-write bypass
--   edemez. SECURITY DEFINER (owner postgres) → PRIVATE helper'ları çağırabilir.
--
-- KORUNANLAR:
--   * NULL / tamamlanmamış profil akışı: username boş/null ise filtre atlanır.
--   * Hesap silme: profiles satırını DELETE eder (username UPDATE etmez) →
--     'Silinmiş#...' anonim adları profiles'ta OLUŞMAZ, bu trigger'a takılmaz.
--   * username_normalized senkron trigger'ı (_sync_username_normalized) ayrı ve
--     dokunulmadan kalır; bu trigger yalnız içerik + moderasyon zorlar.
create or replace function public._profiles_ugc_enforce()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- (1) İçerik filtresi — YALNIZ kullanıcı adı gerçekten yazılıyor/DEĞİŞİYORSA.
  --     (Trigger moderasyon kolonları için de tetiklendiğinden, ad değişmemişse
  --     mevcut adı yeniden filtreleyip moderatör işlemini engellemeyelim.)
  if (tg_op = 'INSERT' or new.username is distinct from old.username)
     and new.username is not null and btrim(new.username) <> '' then
    perform public.assert_text_allowed(new.username, 'username');
  end if;

  -- (2) Kullanıcı-oturumu bağlamı: aktör KENDİ profilini güncelliyor (auth.uid()
  --     dolu ve = new.id). Moderatör service_role/postgres ile yazar → auth.uid()
  --     NULL → bu blok atlanır, moderatör serbesttir.
  if tg_op = 'UPDATE' and auth.uid() is not null and auth.uid() = new.id then
    -- (2a) MODERASYON KOLONLARI SUNUCU-ONLY (self-unban savunması). Kolon-seviyesi
    --      REVOKE, tablo-seviyesi GRANT ALL nedeniyle NO-OP olduğundan gerçek
    --      immutability BURADA zorlanır. Kullanıcı kendi durumunu/askısını
    --      değiştiremez; değeri değiştirmeyen no-op update'ler serbesttir.
    if new.moderation_status is distinct from old.moderation_status
       or new.suspended_until is distinct from old.suspended_until then
      raise exception 'MODERATION_SELF_UPDATE_FORBIDDEN' using errcode = '42501';
    end if;
    -- (2b) Banned/suspended hesap kendi kullanıcı adını değiştiremez.
    if new.username is distinct from old.username then
      perform public.assert_profile_moderation_active(new.id);
    end if;
  end if;

  return new;
end
$fn$;

revoke all on function public._profiles_ugc_enforce() from public, anon, authenticated;

drop trigger if exists trg_profiles_ugc_enforce on public.profiles;
-- Moderasyon kolonlarını da izlemek için trigger onların UPDATE'inde de tetiklenir
-- (yalnız username değil). Böylece self-unban denemesi mutlaka trigger'a düşer.
create trigger trg_profiles_ugc_enforce
  before insert or update of username, moderation_status, suspended_until on public.profiles
  for each row
  execute function public._profiles_ugc_enforce();

-- B2) change_username — GRACEFUL katman. Trigger zaten backstop; ancak UI'ye
--     tutarlı jsonb { ok:false, code } dönmek için önden reddet. İmza ve tüm
--     mevcut kurallar (3–20, reserved, cooldown, gold, uniqueness) KORUNUR;
--     yalnız iki erken kontrol eklendi. Gövde 20260716120000'den kopyalandı.
create or replace function public.change_username(p_new_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid             uuid := auth.uid();
  v_display         text;
  v_key             text;
  v_cur_username    text;
  v_cur_norm        text;
  v_change_count    int;
  v_last_change     timestamptz;
  v_gold            int;
  v_is_first        boolean;
  v_cost            int := 500;
  v_cooldown        interval := interval '14 days';
  v_seconds_left    bigint;
  v_days_left       int;
  v_banned          text[] := array[
    'admin','administrator','moderator','mod','system','sistem',
    'torble','bot','npc','test','support','destek','official',
    'owner','root','staff','null','undefined','geoquiz','geo_quiz',
    'developer','dev','yetkili','kurucu','yonetici','help','helper'
  ];
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated',
      'message', 'Giriş yapmalısın.');
  end if;

  -- YENİ: Banned/suspended hesap kullanıcı adını değiştiremez (graceful).
  begin
    perform public.assert_profile_moderation_active(v_uid);
  exception
    when others then
      if sqlerrm = 'ACCOUNT_BANNED' then
        return jsonb_build_object('ok', false, 'code', 'account_banned',
          'message', 'Hesabın kalıcı olarak kısıtlandı.');
      elsif sqlerrm = 'ACCOUNT_SUSPENDED' then
        return jsonb_build_object('ok', false, 'code', 'account_suspended',
          'message', 'Hesabın geçici olarak kısıtlandı.');
      else
        raise;
      end if;
  end;

  if p_new_username is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_format',
      'message', 'Geçerli bir kullanıcı adı seçmelisin.');
  end if;

  v_display := btrim(regexp_replace(p_new_username, '^@+', ''));

  if length(v_display) = 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_format',
      'message', 'Geçerli bir kullanıcı adı seçmelisin.');
  end if;
  if v_display ~ '\s' then
    return jsonb_build_object('ok', false, 'code', 'invalid_format',
      'message', 'Kullanıcı adında boşluk olamaz.');
  end if;
  if char_length(v_display) < 3 then
    return jsonb_build_object('ok', false, 'code', 'too_short',
      'message', 'Kullanıcı adı en az 3 karakter olmalı.');
  end if;
  if char_length(v_display) > 20 then
    return jsonb_build_object('ok', false, 'code', 'too_long',
      'message', 'Kullanıcı adı en fazla 20 karakter olabilir.');
  end if;

  v_key := public.username_key(v_display);

  if v_key !~ '^[a-z0-9_.\-]+$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_format',
      'message', 'Sadece harf, rakam, nokta, tire ve alt çizgi kullanabilirsin.');
  end if;
  if char_length(v_key) < 3 then
    return jsonb_build_object('ok', false, 'code', 'too_short',
      'message', 'Kullanıcı adı en az 3 karakter olmalı.');
  end if;

  if v_key = any(v_banned) then
    return jsonb_build_object('ok', false, 'code', 'banned',
      'message', 'Bu kullanıcı adı kullanılamaz.');
  end if;

  -- YENİ: Ortak içerik filtresi (graceful). Trigger de aynı sonucu backstop'lar.
  if public.text_has_forbidden_content(v_display, 'username') then
    return jsonb_build_object('ok', false, 'code', 'not_allowed',
      'message', 'Bu kullanıcı adı kullanılamaz.');
  end if;

  select p.username, p.username_normalized, p.username_change_count,
         p.username_changed_at, p.gold
    into v_cur_username, v_cur_norm, v_change_count, v_last_change, v_gold
    from public.profiles p
   where p.id = v_uid
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_profile',
      'message', 'Profil bulunamadı.');
  end if;

  if coalesce(v_cur_norm, public.username_key(coalesce(v_cur_username, ''))) = v_key then
    return jsonb_build_object('ok', false, 'code', 'same_as_current',
      'message', 'Bu zaten mevcut kullanıcı adın.');
  end if;

  v_is_first := coalesce(v_change_count, 0) = 0;

  if not v_is_first and v_last_change is not null
     and now() < v_last_change + v_cooldown then
    v_seconds_left := extract(epoch from (v_last_change + v_cooldown - now()))::bigint;
    v_days_left    := greatest(1, ceil(v_seconds_left / 86400.0)::int);
    return jsonb_build_object('ok', false, 'code', 'cooldown', 'days_left', v_days_left,
      'message', format('Kullanıcı adını tekrar değiştirmek için %s gün beklemelisin.', v_days_left));
  end if;

  if not v_is_first then
    if coalesce(v_gold, 0) < v_cost then
      return jsonb_build_object('ok', false, 'code', 'insufficient_gold',
        'cost', v_cost, 'gold', coalesce(v_gold, 0),
        'message', format('Bu işlem %s Gold gerektiriyor. Yeterli Gold''un yok.', v_cost));
    end if;
  end if;

  if exists (select 1 from public.profiles where username_normalized = v_key and id <> v_uid) then
    return jsonb_build_object('ok', false, 'code', 'taken',
      'message', 'Bu kullanıcı adı zaten alınmış.');
  end if;

  update public.profiles
     set username              = v_display,
         username_normalized   = v_key,
         has_chosen_username   = true,
         username_source       = 'change',
         username_changed_at   = now(),
         username_change_count = coalesce(username_change_count, 0) + 1,
         gold                  = case when v_is_first then coalesce(gold, 0)
                                      else greatest(0, coalesce(gold, 0) - v_cost) end,
         updated_at            = now()
   where id = v_uid;

  return jsonb_build_object(
    'ok', true, 'username', v_display,
    'gold', case when v_is_first then coalesce(v_gold, 0)
                 else greatest(0, coalesce(v_gold, 0) - v_cost) end,
    'was_first', v_is_first,
    'cost', case when v_is_first then 0 else v_cost end
  );

exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'taken',
    'message', 'Bu kullanıcı adı zaten alınmış.');
end
$fn$;

revoke all     on function public.change_username(text) from public;
grant  execute on function public.change_username(text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- BÖLÜM C — MİSAFİR GÖRÜNEN AD (assert_display_name_allowed ortak filtreyle)
-- ════════════════════════════════════════════════════════════════════════════
-- Mevcut helper'ın inline yasak-kelime listesi, ortak text_has_forbidden_content
-- ('display_name') çağrısıyla değiştirilir. İmza/hata etiketleri/akış KORUNUR:
--   name_invalid (22023), display_name_forbidden (P0001), registered_username_taken.
-- SECURITY DEFINER olduğundan PRIVATE filtreyi çağırabilir.
create or replace function public.assert_display_name_allowed(
  p_name        text,
  p_profile_id  uuid,
  p_guest_id    text
) returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_trim   text;
  v_norm   text;
  v_owner  uuid;
begin
  if p_name is null then
    raise exception 'name_invalid' using errcode = '22023';
  end if;

  v_trim := btrim(p_name);

  if length(v_trim) < 2 or length(v_trim) > 16 then
    raise exception 'name_invalid' using errcode = '22023';
  end if;

  v_norm := lower(v_trim);

  -- Ortak filtre (rezerv/otorite/marka/küfür) — profiles lookup'ından ÖNCE.
  if public.text_has_forbidden_content(v_trim, 'display_name') then
    raise exception 'display_name_forbidden' using errcode = 'P0001';
  end if;

  -- Kayıtlı kullanıcı adı taklidi koruması (MEVCUT davranış).
  select id into v_owner
    from public.profiles
   where username_normalized = v_norm
   limit 1;

  if v_owner is null then
    return v_trim;
  end if;
  if p_profile_id is not null and v_owner = p_profile_id then
    return v_trim;
  end if;
  raise exception 'registered_username_taken' using errcode = 'P0001';
end
$$;

revoke all     on function public.assert_display_name_allowed(text, uuid, text) from public;
grant  execute on function public.assert_display_name_allowed(text, uuid, text) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- BÖLÜM D — LOBİ/ODA SOHBETİ FİLTRESİ (tek duel_messages BEFORE INSERT trigger)
-- ════════════════════════════════════════════════════════════════════════════
-- MİMARİ KARARI: 9 mod-özel send-message RPC'sinin (duel, flag_duel, wheel_duel,
--   wheel_group, duel_group, conquest, tevatur, flag_group, route_duel) TAMAMI
--   duel_messages'a INSERT eder (tek ortak yazma noktası). 9 RPC gövdesini tek
--   tek kopyalamak yerine bu ORTAK yazma noktasına BEFORE INSERT trigger'ı
--   konur → guard/antispam/imza/grant'lara SIFIR dokunuş, bypass İMKÂNSIZ,
--   gelecekteki modlar da otomatik kapsanır. Trigger yalnız INSERT'te çalışır →
--   hesap silme UPDATE süpürmesiyle çakışmaz. sender_profile_id doluysa (giriş
--   yapmış gönderen) moderasyon da burada zorlanır; misafirde NULL → atlanır.
create or replace function public._duel_messages_ugc_enforce()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.assert_text_allowed(new.message, 'room_message');
  if new.sender_profile_id is not null then
    perform public.assert_profile_moderation_active(new.sender_profile_id);
  end if;
  return new;
end
$fn$;

revoke all on function public._duel_messages_ugc_enforce() from public, anon, authenticated;

drop trigger if exists trg_duel_messages_ugc_enforce on public.duel_messages;
create trigger trg_duel_messages_ugc_enforce
  before insert on public.duel_messages
  for each row
  execute function public._duel_messages_ugc_enforce();


-- ════════════════════════════════════════════════════════════════════════════
-- BÖLÜM E — DM MESAJ FİLTRESİ (dm_send_message)
-- ════════════════════════════════════════════════════════════════════════════
-- Gövde 20260718170000'den KOPYALANDI (authoritative). Korunanlar: arkadaşlık
-- zorunluluğu, engel kontrolü, auth.uid() aktörü, katılımcı doğrulaması, uzunluk,
-- antispam, okunmamış limiti, realtime. EKLENEN: moderasyon + dm_message filtresi.
create or replace function public.dm_send_message(p_recipient uuid, p_content text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me            uuid := auth.uid();
  v_conv          uuid;
  v_text          text;
  v_last_text     text;
  v_last_at       timestamptz;
  v_recent        int;
  v_recip_cleared timestamptz;
  v_unread        int;
  v_row           public.dm_messages;
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  -- YENİ: Banned/suspended gönderemez.
  perform public.assert_profile_moderation_active(v_me);

  if p_recipient is null or p_recipient = v_me then
    raise exception 'invalid_recipient' using errcode = '22023';
  end if;
  if not public._dm_are_friends(v_me, p_recipient) then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;
  if public.is_blocked_between(v_me, p_recipient) then
    raise exception 'blocked_between' using errcode = 'P0001';
  end if;

  v_text := btrim(coalesce(p_content, ''));
  if length(v_text) = 0 then
    raise exception 'empty_message' using errcode = '22023';
  end if;
  if length(v_text) > 500 then
    raise exception 'message_too_long' using errcode = '22023';
  end if;

  -- YENİ: Ortak içerik filtresi (dm_message bağlamı).
  perform public.assert_text_allowed(v_text, 'dm_message');

  v_conv := public._dm_resolve_conversation(v_me, p_recipient);

  perform 1 from public.dm_conversations where id = v_conv for update;

  select content, created_at into v_last_text, v_last_at
    from public.dm_messages
   where conversation_id = v_conv and sender_id = v_me
   order by created_at desc
   limit 1;

  if v_last_at is not null and v_last_at > now() - interval '500 milliseconds' then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  if v_last_text is not null and v_last_text = v_text
     and v_last_at > now() - interval '4 seconds' then
    raise exception 'duplicate_message' using errcode = 'P0001';
  end if;

  select count(*) into v_recent
    from public.dm_messages
   where conversation_id = v_conv and sender_id = v_me
     and created_at > now() - interval '10 seconds';
  if v_recent >= 10 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  select case when user_a = p_recipient then cleared_a_at else cleared_b_at end
    into v_recip_cleared
    from public.dm_conversations
   where id = v_conv;

  select count(*) into v_unread
    from public.dm_messages
   where conversation_id = v_conv
     and sender_id       = v_me
     and recipient_id    = p_recipient
     and read_at is null
     and (v_recip_cleared is null or created_at > v_recip_cleared);

  if v_unread >= 10 then
    raise exception 'unread_limit' using errcode = 'P0001';
  end if;

  insert into public.dm_messages (conversation_id, sender_id, recipient_id, content)
  values (v_conv, v_me, p_recipient, v_text)
  returning * into v_row;

  update public.dm_conversations
     set last_message_at      = v_row.created_at,
         last_message_preview = left(v_text, 120),
         last_sender_id       = v_me
   where id = v_conv;

  return jsonb_build_object(
    'ok', true, 'id', v_row.id, 'conversation_id', v_row.conversation_id,
    'sender_id', v_row.sender_id, 'recipient_id', v_row.recipient_id,
    'content', v_row.content, 'created_at', v_row.created_at, 'read_at', v_row.read_at
  );
end
$fn$;

revoke all on function public.dm_send_message(uuid, text) from public;
grant  execute on function public.dm_send_message(uuid, text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- BÖLÜM F — RAPORLAMA (reports tablosu + hedef-türüne-özgü güvenli RPC'ler)
-- ════════════════════════════════════════════════════════════════════════════

-- F1) reports tablosu — hesap silme kanıt korumalı FK'ler (on delete set null).
create table if not exists public.reports (
  id                          uuid        primary key default gen_random_uuid(),
  reporter_profile_id         uuid        null references public.profiles(id) on delete set null,
  reporter_guest_key_hash     text        null,
  target_type                 text        not null
                                            check (target_type in ('profile','dm_message','room_message')),
  target_id                   text        not null,      -- profile uuid / message uuid (metin)
  target_profile_id           uuid        null references public.profiles(id) on delete set null,
  room_code                   text        null,
  conversation_id             uuid        null,
  reason                      text        not null
                                            check (reason in (
                                              'harassment','inappropriate_language','hate_speech',
                                              'sexual_content','spam_scam','inappropriate_username','other')),
  detail                      text        null,          -- yalnız 'other' için, kısa isteğe bağlı
  content_snapshot            text        null,          -- SUNUCUDAN alınır
  reported_username_snapshot  text        null,          -- SUNUCUDAN alınır
  status                      text        not null default 'open'
                                            check (status in ('open','reviewing','resolved','dismissed')),
  moderator_note              text        null,
  created_at                  timestamptz not null default now(),
  reviewed_at                 timestamptz null,
  resolved_at                 timestamptz null,
  check (reporter_profile_id is not null or reporter_guest_key_hash is not null)
);

comment on table public.reports is
  'Uygulama içi UGC raporları. YALNIZ SECURITY DEFINER RPC üzerinden yazılır. '
  'anon/authenticated doğrudan erişemez. Snapshot''lar sunucudan alınır; hesap '
  'silinince FK''ler NULL''lanır, snapshot güvenlik kanıtı olarak kalır.';

create index if not exists reports_status_created_idx  on public.reports (status, created_at desc);
create index if not exists reports_target_idx          on public.reports (target_type, target_id);
create index if not exists reports_reporter_idx        on public.reports (reporter_profile_id, created_at desc)
  where reporter_profile_id is not null;
create index if not exists reports_reporter_guest_idx  on public.reports (reporter_guest_key_hash, created_at desc)
  where reporter_guest_key_hash is not null;

-- F2) RLS — anon/authenticated'a HİÇBİR doğrudan erişim yok. Yalnız definer RPC.
--     service_role/postgres (Dashboard moderasyonu) RLS'i bypass eder.
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;
-- (Bilinçli olarak HİÇBİR policy tanımlanmadı → tüm client rolleri için deny.)

-- F3) Private helper — dedup + saatlik rate-limit + insert. Reporter kimliği ve
--     snapshot'lar ÇAĞIRAN RPC'de sunucudan türetilip buraya verilir.
--     STABİL kodlar: REPORT_ALREADY_SUBMITTED / REPORT_RATE_LIMITED.
create or replace function public._insert_report(
  p_reporter_profile     uuid,
  p_reporter_guest_hash  text,
  p_target_type          text,
  p_target_id            text,
  p_target_profile       uuid,
  p_room_code            text,
  p_conversation_id      uuid,
  p_reason               text,
  p_detail               text,
  p_content_snapshot     text,
  p_username_snapshot    text
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_dup   int;
  v_rate  int;
  v_id    uuid;
  v_detail text := left(nullif(btrim(coalesce(p_detail, '')), ''), 300);
begin
  -- Duplicate: aynı reporter + aynı target zaten var mı?
  if p_reporter_profile is not null then
    select count(*) into v_dup from public.reports
     where reporter_profile_id = p_reporter_profile
       and target_type = p_target_type and target_id = p_target_id;
  else
    select count(*) into v_dup from public.reports
     where reporter_guest_key_hash = p_reporter_guest_hash
       and target_type = p_target_type and target_id = p_target_id;
  end if;
  if v_dup > 0 then
    raise exception 'REPORT_ALREADY_SUBMITTED' using errcode = 'P0001';
  end if;

  -- Rate limit: son 1 saatte en fazla 10 başarılı rapor.
  if p_reporter_profile is not null then
    select count(*) into v_rate from public.reports
     where reporter_profile_id = p_reporter_profile
       and created_at > now() - interval '1 hour';
  else
    select count(*) into v_rate from public.reports
     where reporter_guest_key_hash = p_reporter_guest_hash
       and created_at > now() - interval '1 hour';
  end if;
  if v_rate >= 10 then
    raise exception 'REPORT_RATE_LIMITED' using errcode = 'P0001';
  end if;

  insert into public.reports (
    reporter_profile_id, reporter_guest_key_hash, target_type, target_id,
    target_profile_id, room_code, conversation_id, reason, detail,
    content_snapshot, reported_username_snapshot
  ) values (
    p_reporter_profile, p_reporter_guest_hash, p_target_type, p_target_id,
    p_target_profile, p_room_code, p_conversation_id, p_reason,
    case when p_reason = 'other' then v_detail else null end,
    p_content_snapshot, p_username_snapshot
  )
  returning id into v_id;

  return v_id;
end
$fn$;

revoke all on function public._insert_report(uuid, text, text, text, uuid, text, uuid, text, text, text, text) from public, anon, authenticated;

-- F4) report_profile — profil/kullanıcı adı raporu (authenticated).
create or replace function public.report_profile(
  p_target_profile uuid,
  p_reason         text,
  p_detail         text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me    uuid := auth.uid();
  v_uname text;
  v_id    uuid;
begin
  if v_me is null then
    raise exception 'REPORT_NOT_ALLOWED' using errcode = '42501';
  end if;
  perform public.assert_profile_moderation_active(v_me);
  if p_reason not in ('harassment','inappropriate_language','hate_speech',
                      'sexual_content','spam_scam','inappropriate_username','other') then
    raise exception 'REPORT_NOT_ALLOWED' using errcode = '22023';
  end if;
  if p_target_profile is null or p_target_profile = v_me then
    raise exception 'REPORT_NOT_ALLOWED' using errcode = 'P0001';
  end if;

  -- Snapshot SUNUCUDAN (kullanıcı adı) — istemci gönderemez.
  select username into v_uname from public.profiles where id = p_target_profile;
  if not found then
    raise exception 'REPORT_TARGET_NOT_FOUND' using errcode = 'P0001';
  end if;

  v_id := public._insert_report(
    v_me, null, 'profile', p_target_profile::text, p_target_profile,
    null, null, p_reason, p_detail, null, v_uname
  );
  return jsonb_build_object('ok', true, 'report_id', v_id);
end
$fn$;

revoke all     on function public.report_profile(uuid, text, text) from public;
grant  execute on function public.report_profile(uuid, text, text) to authenticated;

-- F5) report_dm_message — DM mesajı raporu. YALNIZ konuşmanın gerçek ALICISI.
create or replace function public.report_dm_message(
  p_message_id uuid,
  p_reason     text,
  p_detail     text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me    uuid := auth.uid();
  v_m     public.dm_messages;
  v_uname text;
  v_id    uuid;
begin
  if v_me is null then
    raise exception 'REPORT_NOT_ALLOWED' using errcode = '42501';
  end if;
  perform public.assert_profile_moderation_active(v_me);
  if p_reason not in ('harassment','inappropriate_language','hate_speech',
                      'sexual_content','spam_scam','inappropriate_username','other') then
    raise exception 'REPORT_NOT_ALLOWED' using errcode = '22023';
  end if;

  select * into v_m from public.dm_messages where id = p_message_id;
  if not found then
    raise exception 'REPORT_TARGET_NOT_FOUND' using errcode = 'P0001';
  end if;
  -- Kendi mesajını raporlayamaz + yalnız gerçek alıcı raporlayabilir.
  if v_m.sender_id = v_me then
    raise exception 'REPORT_NOT_ALLOWED' using errcode = 'P0001';
  end if;
  if v_m.recipient_id <> v_me then
    raise exception 'REPORT_NOT_ALLOWED' using errcode = 'P0001';
  end if;

  select username into v_uname from public.profiles where id = v_m.sender_id;

  v_id := public._insert_report(
    v_me, null, 'dm_message', v_m.id::text, v_m.sender_id,
    null, v_m.conversation_id, p_reason, p_detail, v_m.content, v_uname
  );
  return jsonb_build_object('ok', true, 'report_id', v_id);
end
$fn$;

revoke all     on function public.report_dm_message(uuid, text, text) from public;
grant  execute on function public.report_dm_message(uuid, text, text) to authenticated;

-- F6) report_room_message — lobi/oda mesajı raporu. Authenticated VEYA misafir
--     (claim token'lı). Katılım MOD-özel doğrulanır; snapshot sunucudan alınır.
--     Misafirde raw claim SAKLANMAZ (SHA-256 hex hash). Kendi mesajı → NOT_ALLOWED.
create or replace function public.report_room_message(
  p_message_id  uuid,
  p_reason      text,
  p_mode        text,
  p_player_id   uuid default null,
  p_claim_token uuid default null,
  p_detail      text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me     uuid := auth.uid();
  v_m      public.duel_messages;
  v_base   text;
  v_pname  text;           -- reporter'ın o odadaki player adı (katılım kanıtı)
  v_self   boolean := false;
  v_ghash  text := null;
  v_rprof  uuid := null;
  v_id     uuid;
begin
  if p_reason not in ('harassment','inappropriate_language','hate_speech',
                      'sexual_content','spam_scam','inappropriate_username','other') then
    raise exception 'REPORT_NOT_ALLOWED' using errcode = '22023';
  end if;

  select * into v_m from public.duel_messages where id = p_message_id;
  if not found then
    raise exception 'REPORT_TARGET_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Mesajın oda kodundan MOD namespace'ini soyarak gerçek oda kodunu çöz.
  if p_mode = 'flag_group' then
    v_base := regexp_replace(v_m.room_code, '^flag_group:', '');
  elsif p_mode = 'route_duel' then
    v_base := regexp_replace(v_m.room_code, '^route_duel:', '');
  elsif p_mode = 'tevatur' then
    v_base := split_part(v_m.room_code, '#', 1);
  else
    v_base := v_m.room_code;
  end if;

  -- Reporter'ın GERÇEKTEN o odadaki oyuncu olduğunu kanıtla (auth: profile_id;
  -- misafir: player_id + claim_token). Tek sorgu her iki yolu da kapsar.
  if p_mode in ('duel','flag_duel') then
    select p.name into v_pname from public.duel_players p
      join public.duel_rooms r on r.id = p.room_id
     where r.code = v_base
       and ((v_me is not null and p.profile_id = v_me)
         or (v_me is null and p.id = p_player_id and public.duel_authorize_player(p_player_id, p_claim_token)))
     limit 1;
  elsif p_mode = 'wheel_duel' then
    select p.name into v_pname from public.wheel_duel_players p
      join public.wheel_duel_rooms r on r.id = p.room_id
     where r.code = v_base
       and ((v_me is not null and p.profile_id = v_me)
         or (v_me is null and p.id = p_player_id and public.wheel_duel_authorize_player(p_player_id, p_claim_token)))
     limit 1;
  elsif p_mode = 'wheel_group' then
    select p.name into v_pname from public.wheel_group_players p
      join public.wheel_group_rooms r on r.id = p.room_id
     where r.code = v_base
       and ((v_me is not null and p.profile_id = v_me)
         or (v_me is null and p.id = p_player_id and public.wheel_group_authorize_player(p_player_id, p_claim_token)))
     limit 1;
  elsif p_mode = 'duel_group' then
    select p.name into v_pname from public.duel_group_players p
      join public.duel_group_rooms r on r.id = p.room_id
     where r.code = v_base
       and ((v_me is not null and p.profile_id = v_me)
         or (v_me is null and p.id = p_player_id and public.duel_group_authorize_player(p_player_id, p_claim_token)))
     limit 1;
  elsif p_mode = 'conquest' then
    select p.name into v_pname from public.conquest_players p
      join public.conquest_rooms r on r.id = p.room_id
     where r.room_code = v_base
       and ((v_me is not null and p.profile_id = v_me)
         or (v_me is null and p.id = p_player_id and public.conquest_authorize_player(p_player_id, p_claim_token)))
     limit 1;
  elsif p_mode = 'tevatur' then
    select p.name into v_pname from public.tevatur_players p
      join public.tevatur_rooms r on r.id = p.room_id
     where r.code = v_base
       and ((v_me is not null and p.profile_id = v_me)
         or (v_me is null and p.id = p_player_id and public.tevatur_authorize_player(p_player_id, p_claim_token)))
     limit 1;
  elsif p_mode = 'flag_group' then
    select p.name into v_pname from public.flag_group_players p
      join public.flag_group_rooms r on r.id = p.room_id
     where r.code = v_base
       and ((v_me is not null and p.profile_id = v_me)
         or (v_me is null and p.id = p_player_id and public.flag_group_authorize_player(p_player_id, p_claim_token)))
     limit 1;
  elsif p_mode = 'route_duel' then
    select p.name into v_pname from public.route_duel_players p
      join public.route_duel_rooms r on r.id = p.room_id
     where r.code = v_base
       and ((v_me is not null and p.profile_id = v_me)
         or (v_me is null and p.id = p_player_id and public.route_duel_authorize_player(p_player_id, p_claim_token)))
     limit 1;
  else
    raise exception 'REPORT_NOT_ALLOWED' using errcode = '22023';
  end if;

  if v_pname is null then
    -- Reporter bu odanın gerçek oyuncusu değil (başka oda / sahte claim / ayrılmış).
    raise exception 'REPORT_NOT_ALLOWED' using errcode = 'P0001';
  end if;

  -- Kendi mesajını raporlayamaz (auth: sender_profile_id; her ikisi: oda-içi ad).
  if (v_me is not null and v_m.sender_profile_id is not null and v_m.sender_profile_id = v_me)
     or (v_pname = v_m.player_name) then
    raise exception 'REPORT_NOT_ALLOWED' using errcode = 'P0001';
  end if;

  if v_me is not null then
    perform public.assert_profile_moderation_active(v_me);
    v_rprof := v_me;
  else
    -- Raw claim token HİÇBİR yerde SAKLANMAZ — tek yönlü SHA-256 hex türev
    -- (dedup/rate-limit için yeterli). sha256()/convert_to()/encode() pg_catalog
    -- BUILTIN'leri (PG11+); pgcrypto/extensions.digest'e bağımlılık YOK, bu yüzden
    -- 'set search_path = public' altında da güvenle çözülür. 64 hane hex çıktı.
    v_ghash := encode(
      sha256(convert_to(p_claim_token::text || ':' || p_player_id::text || ':torble-report', 'utf8')),
      'hex');
  end if;

  v_id := public._insert_report(
    v_rprof, v_ghash, 'room_message', v_m.id::text, v_m.sender_profile_id,
    v_m.room_code, null, p_reason, p_detail, v_m.message, v_m.player_name
  );
  return jsonb_build_object('ok', true, 'report_id', v_id);
end
$fn$;

revoke all     on function public.report_room_message(uuid, text, text, uuid, uuid, text) from public;
grant  execute on function public.report_room_message(uuid, text, text, uuid, uuid, text) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- BÖLÜM G — MODERASYON ZORLAMASI (friend_requests + davet notifications)
-- ════════════════════════════════════════════════════════════════════════════
-- Username/DM/room-message/report choke-point'leri yukarıda zaten moderasyonu
-- zorluyor. Kalan iki sosyal yazma yolu (arkadaşlık isteği + oda/oyun daveti)
-- BEFORE INSERT trigger'larıyla kapatılır — aktör her ikisinde de auth.uid()'dir.

-- G5) friend_requests — istek atan (requester = auth.uid()) banned/suspended olamaz.
create or replace function public._friend_requests_moderation()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.assert_profile_moderation_active(new.requester_profile_id);
  return new;
end
$fn$;

revoke all on function public._friend_requests_moderation() from public, anon, authenticated;

drop trigger if exists trg_friend_requests_moderation on public.friend_requests;
create trigger trg_friend_requests_moderation
  before insert on public.friend_requests
  for each row
  execute function public._friend_requests_moderation();

-- G6) notifications — davet tipleri için aktör (actor = davet eden) moderasyonu.
--     Diğer bildirim tipleri (kabul/başarım/sistem) ETKİLENMEZ.
create or replace function public._notifications_invite_moderation()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.type in ('game_invite','room_invite') and new.actor_profile_id is not null then
    perform public.assert_profile_moderation_active(new.actor_profile_id);
  end if;
  return new;
end
$fn$;

revoke all on function public._notifications_invite_moderation() from public, anon, authenticated;

drop trigger if exists trg_notifications_invite_moderation on public.notifications;
create trigger trg_notifications_invite_moderation
  before insert on public.notifications
  for each row
  execute function public._notifications_invite_moderation();


-- ════════════════════════════════════════════════════════════════════════════
-- BÖLÜM H — DOĞRULAMA / AUDIT (read-only; canlı veriyi DEĞİŞTİRMEZ)
-- ════════════════════════════════════════════════════════════════════════════
--   -- Filtre birim kontrolü (true = engellenir):
--   select public.text_has_forbidden_content('orospucocugu','username');   -- t
--   select public.text_has_forbidden_content('s1kt1r','room_message');     -- t
--   select public.text_has_forbidden_content('eksiktir','room_message');   -- f (FP değil)
--   select public.text_has_forbidden_content('push it','room_message');    -- f
--   select public.text_has_forbidden_content('mode','username');           -- f
--   select public.text_has_forbidden_content('admin123','username');       -- t
--
--   -- Mevcut username'lerden YENİ filtreye takılacaklar (SADECE LİSTELER, yazmaz):
--   select id, username from public.profiles
--    where username is not null and btrim(username) <> ''
--      and public.text_has_forbidden_content(username, 'username');
--   -- (Migration bu kullanıcıları OTOMATİK değiştirmez/silmez — moderatör kararı.)
--
--   -- Şema kontrolleri:
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='profiles'
--      and column_name in ('moderation_status','suspended_until');                    -- 2
--   -- moderation_note ARTIK profiles'ta DEĞİL; PRIVATE tabloda + client'a kapalı:
--   select count(*) from information_schema.tables
--    where table_schema='public' and table_name='profile_moderation';                -- 1
--   select has_table_privilege('authenticated','public.profile_moderation','select');-- f
--   select has_table_privilege('anon','public.profile_moderation','select');         -- f
--   select tgname from pg_trigger where tgrelid='public.duel_messages'::regclass
--     and tgname='trg_duel_messages_ugc_enforce';                                     -- 1
--   select relrowsecurity from pg_class where oid='public.reports'::regclass;         -- t
-- ============================================================================
