-- ============================================================================
-- Kullanıcı adı KEY sistemi — Türkçe-katlamalı benzersizlik + onboarding flag
-- ============================================================================
-- Amaç:
--   1) Görünen ad (profiles.username) kullanıcının yazdığı gibi kalsın
--      (Türkçe karakter + büyük/küçük korunur): "padır", "Çağrı", "İbrahim".
--   2) Benzersizlik, Türkçe/aksan ASCII'ye katlanmış bir ANAHTAR üzerinden
--      yapılsın: "padır" == "padir", "Çağrı" == "cagri". Bu anahtar mevcut
--      profiles.username_normalized kolonunda tutulur (yeni kolon eklenmez;
--      yalnızca anlamı "lower(btrim)" → "Türkçe-katlanmış" olarak güçlendirilir).
--   3) İlk-giriş onboarding modalını tetiklemek için has_chosen_username flag'i
--      ve teşhis için username_source eklenir.
--
-- Tasarım kararları (kullanıcı onaylı):
--   * Mevcut adlı profiller has_chosen_username=true ile işaretlenir → ASLA
--     zorunlu modal görmezler. Yalnız adı olmayan YENİ girişler modal görür.
--   * Backfill ÇAKIŞMAYA DAYANIKLI: bir anahtar başka bir satırda zaten varsa
--     o satırın username_normalized'ı OLDUĞU GİBİ bırakılır (migration patlamaz,
--     veri kaybı olmaz). Yeni kullanıcılar o anahtarı yine de alamaz.
--
-- Idempotent + elle uygulanabilir. Mevcut auth/XP/Gold/oda akışlarına dokunmaz.
-- change_username RPC imzası ({ ok,... } jsonb) AYNEN korunur.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0) Şema: onboarding flag + kaynak alanı
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists has_chosen_username boolean not null default false,
  add column if not exists username_source     text;


-- ----------------------------------------------------------------------------
-- 1) Ortak katlama fonksiyonu — public.username_key(text)
-- ----------------------------------------------------------------------------
-- Frontend src/lib/username.ts → normalizeUsernameKey ile BİREBİR aynı:
--   * baştaki '@' atılır, baş/son boşluk kırpılır
--   * noktalı/noktasız I (İ, I, ı) → 'i' (locale-bağımsız, lower'dan ÖNCE)
--   * lower()
--   * Türkçe + yaygın Latin aksanları ASCII'ye katlanır
-- immutable → ifade indeksinde / generated kullanımda güvenli.
create or replace function public.username_key(p text)
returns text
language sql
immutable
as $fn$
  select translate(
           lower(
             translate(
               btrim(regexp_replace(coalesce(p, ''), '^@+', '')),
               'İIı',
               'iii'
             )
           ),
           'çğıöşüàáâäãåèéêëìíîïòóôõùúûñýÿ',
           'cgiosuaaaaaaeeeeiiiioooouuunyy'
         )
$fn$;


-- ----------------------------------------------------------------------------
-- 2) Trigger — username_normalized'ı daima username_key(username) ile doldur
-- ----------------------------------------------------------------------------
-- Eski sürüm lower(btrim(...)) kullanıyordu; artık Türkçe-katlanmış anahtar.
-- Client ne gönderirse göndersin (yanlış normalized dahi) server tutarlı tutar.
create or replace function public._sync_username_normalized()
returns trigger
language plpgsql
as $fn$
begin
  if new.username is not null and btrim(new.username) <> '' then
    new.username_normalized := public.username_key(new.username);
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_sync_username_normalized on public.profiles;
create trigger trg_sync_username_normalized
  before insert or update of username, username_normalized on public.profiles
  for each row
  execute function public._sync_username_normalized();


-- ----------------------------------------------------------------------------
-- 3) Backfill — mevcut kullanıcıları bozmadan
-- ----------------------------------------------------------------------------
-- 3a) Adı olan herkes "kendi adını seçmiş" sayılır → onboarding modal görmez.
update public.profiles
   set has_chosen_username = true
 where username is not null
   and btrim(username) <> ''
   and has_chosen_username = false;

update public.profiles
   set username_source = 'legacy'
 where username is not null
   and btrim(username) <> ''
   and username_source is null;

-- 3b) username_normalized'ı yeni katlanmış anahtara taşı — ÇAKIŞMAYA DAYANIKLI.
--   * Yalnız anahtarı değişen satırlar aday.
--   * Aynı yeni anahtara düşen birden çok satırdan yalnız ilki (row_number) güncellenir.
--   * O anahtar BAŞKA bir satırda zaten varsa hiç dokunulmaz (eski normalized kalır).
-- Geride kalan nadir çakışmalar eski (katlanmamış) normalized ile yaşamaya devam
-- eder; yeni kullanıcılar o anahtarı yine de alamaz (index başka satırda dolu).
with changed as (
  select p.id,
         public.username_key(p.username) as new_key
    from public.profiles p
   where p.username is not null
     and btrim(p.username) <> ''
     and public.username_key(p.username) <> ''
     and p.username_normalized is distinct from public.username_key(p.username)
),
safe as (
  select c.id,
         c.new_key,
         row_number() over (partition by c.new_key order by c.id) as rn
    from changed c
)
update public.profiles p
   set username_normalized = s.new_key
  from safe s
 where p.id = s.id
   and s.rn = 1
   and not exists (
     select 1
       from public.profiles e
      where e.username_normalized = s.new_key
        and e.id <> p.id
   );


-- ----------------------------------------------------------------------------
-- 4) is_username_available(text) — canlı UI müsaitlik kontrolü
-- ----------------------------------------------------------------------------
-- security definer: profiles SELECT RLS'i kapalı olsa da çalışır; yalnız
-- varlık kontrolü yapar (private veri dönmez). Kendi profilini hariç tutar.
create or replace function public.is_username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select char_length(public.username_key(p_username)) >= 3
     and public.username_key(p_username) ~ '^[a-z0-9_.\-]+$'
     and not exists (
       select 1
         from public.profiles
        where username_normalized = public.username_key(p_username)
          and id <> coalesce(
            auth.uid(),
            '00000000-0000-0000-0000-000000000000'::uuid
          )
     );
$fn$;

revoke all on function public.is_username_available(text) from public;
grant  execute on function public.is_username_available(text) to authenticated;


-- ----------------------------------------------------------------------------
-- 5) change_username RPC — Türkçe destekli, display-koruyan V2
-- ----------------------------------------------------------------------------
-- İmza ve cevap şekli AYNI: change_username(p_new_username text) -> jsonb.
-- Farklar:
--   * 3-20 karakter (eski 3-16).
--   * Görünen ad Türkçe/büyük-küçük KORUNUR; lowercase'e zorlanmaz.
--   * İzinli karakterler: Unicode harf, rakam, '_', '.', '-' (katlanmış anahtar
--     ASCII [a-z0-9_.-] olmalı — emoji/boşluk/@ reddedilir).
--   * Benzersizlik username_key üzerinden (Türkçe-katlanmış).
--   * Başarıda has_chosen_username=true, username_source='change'.
-- Kurallar (V1 ile aynı): ilk değişiklik ücretsiz+cooldownsuz; sonrası 500 Gold
-- + 14 gün cooldown. Gold düşmesi ve update tek transaction, satır kilitli.
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
    return jsonb_build_object(
      'ok', false, 'code', 'unauthenticated',
      'message', 'Giriş yapmalısın.'
    );
  end if;

  if p_new_username is null then
    return jsonb_build_object(
      'ok', false, 'code', 'invalid_format',
      'message', 'Geçerli bir kullanıcı adı seçmelisin.'
    );
  end if;

  -- Görünen ad: baştaki '@' at + baş/son boşluk kırp (case + Türkçe KORUNUR).
  v_display := btrim(regexp_replace(p_new_username, '^@+', ''));

  if length(v_display) = 0 then
    return jsonb_build_object(
      'ok', false, 'code', 'invalid_format',
      'message', 'Geçerli bir kullanıcı adı seçmelisin.'
    );
  end if;

  -- İçeride boşluk yasak (@username gibi kullanılıyor).
  if v_display ~ '\s' then
    return jsonb_build_object(
      'ok', false, 'code', 'invalid_format',
      'message', 'Kullanıcı adında boşluk olamaz.'
    );
  end if;

  if char_length(v_display) < 3 then
    return jsonb_build_object(
      'ok', false, 'code', 'too_short',
      'message', 'Kullanıcı adı en az 3 karakter olmalı.'
    );
  end if;
  if char_length(v_display) > 20 then
    return jsonb_build_object(
      'ok', false, 'code', 'too_long',
      'message', 'Kullanıcı adı en fazla 20 karakter olabilir.'
    );
  end if;

  v_key := public.username_key(v_display);

  -- Katlanmış anahtar ASCII olmalı (Türkçe/Latin dışı harf, emoji, @, sembol →
  -- katlanamaz ve buraya takılır). Nokta, tire, alt çizgi serbest.
  if v_key !~ '^[a-z0-9_.\-]+$' then
    return jsonb_build_object(
      'ok', false, 'code', 'invalid_format',
      'message', 'Sadece harf, rakam, nokta, tire ve alt çizgi kullanabilirsin.'
    );
  end if;
  if char_length(v_key) < 3 then
    return jsonb_build_object(
      'ok', false, 'code', 'too_short',
      'message', 'Kullanıcı adı en az 3 karakter olmalı.'
    );
  end if;

  if v_key = any(v_banned) then
    return jsonb_build_object(
      'ok', false, 'code', 'banned',
      'message', 'Bu kullanıcı adı kullanılamaz.'
    );
  end if;

  -- Mevcut profil satırını kilitle.
  select p.username, p.username_normalized, p.username_change_count,
         p.username_changed_at, p.gold
    into v_cur_username, v_cur_norm, v_change_count, v_last_change, v_gold
    from public.profiles p
   where p.id = v_uid
   for update;

  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'no_profile',
      'message', 'Profil bulunamadı.'
    );
  end if;

  -- Aynı anahtar tekrar girilirse işlem yapma (büyük/küçük + Türkçe varyasyon).
  if coalesce(v_cur_norm, public.username_key(coalesce(v_cur_username, ''))) = v_key then
    return jsonb_build_object(
      'ok', false, 'code', 'same_as_current',
      'message', 'Bu zaten mevcut kullanıcı adın.'
    );
  end if;

  v_is_first := coalesce(v_change_count, 0) = 0;

  -- Cooldown sadece >=2. değişiklik için geçerli.
  if not v_is_first and v_last_change is not null
     and now() < v_last_change + v_cooldown then
    v_seconds_left := extract(epoch from (v_last_change + v_cooldown - now()))::bigint;
    v_days_left    := greatest(1, ceil(v_seconds_left / 86400.0)::int);
    return jsonb_build_object(
      'ok',         false,
      'code',       'cooldown',
      'days_left',  v_days_left,
      'message',    format(
        'Kullanıcı adını tekrar değiştirmek için %s gün beklemelisin.',
        v_days_left
      )
    );
  end if;

  -- Gold yeterli mi? (sadece ücretli değişiklikte)
  if not v_is_first then
    if coalesce(v_gold, 0) < v_cost then
      return jsonb_build_object(
        'ok',      false,
        'code',    'insufficient_gold',
        'cost',    v_cost,
        'gold',    coalesce(v_gold, 0),
        'message', format(
          'Bu işlem %s Gold gerektiriyor. Yeterli Gold''un yok.',
          v_cost
        )
      );
    end if;
  end if;

  -- Anahtar başkasında mı? (Türkçe-katlanmış, partial unique index üzerinden)
  if exists (
    select 1 from public.profiles
     where username_normalized = v_key
       and id <> v_uid
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'taken',
      'message', 'Bu kullanıcı adı zaten alınmış.'
    );
  end if;

  -- Tüm kontroller geçti — atomik update. Görünen ad ham (Türkçe) haliyle yazılır;
  -- username_normalized'ı trigger username_key(username) ile garanti doldurur.
  update public.profiles
     set username              = v_display,
         username_normalized   = v_key,
         has_chosen_username   = true,
         username_source       = 'change',
         username_changed_at   = now(),
         username_change_count = coalesce(username_change_count, 0) + 1,
         gold                  = case
                                   when v_is_first then coalesce(gold, 0)
                                   else greatest(0, coalesce(gold, 0) - v_cost)
                                 end,
         updated_at            = now()
   where id = v_uid;

  return jsonb_build_object(
    'ok',        true,
    'username',  v_display,
    'gold',      case
                   when v_is_first then coalesce(v_gold, 0)
                   else greatest(0, coalesce(v_gold, 0) - v_cost)
                 end,
    'was_first', v_is_first,
    'cost',      case when v_is_first then 0 else v_cost end
  );

exception when unique_violation then
  -- Race: aynı anda iki kişi aynı anahtarı almaya kalkıştıysa biri buraya düşer.
  return jsonb_build_object(
    'ok', false, 'code', 'taken',
    'message', 'Bu kullanıcı adı zaten alınmış.'
  );
end
$fn$;

revoke all on function public.change_username(text) from public;
grant  execute on function public.change_username(text) to authenticated;


-- ----------------------------------------------------------------------------
-- 6) search_public_profiles — sorguyu da Türkçe-katlanmış anahtarla ara
-- ----------------------------------------------------------------------------
-- İmza/dönen kolonlar/güvenlik/grant AYNI. Tek fark: nick araması artık
-- username_key(p_query) ile yapılır; böylece "cagri" yazınca "Çağrı" bulunur.
-- profile_code araması ham upper() ile korunur.
create or replace function public.search_public_profiles(p_query text)
returns table (
  profile_id             uuid,
  username               text,
  avatar_id              text,
  level                  int,
  profile_code           text,
  active_avatar_frame_id text,
  relationship_status    text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me   uuid := auth.uid();
  v_raw  text;
  v_key  text;
  v_like text;
  v_code text;
begin
  -- "@username" girişini ve baştaki/sondaki boşlukları normalize et.
  v_raw := btrim(ltrim(btrim(coalesce(p_query, '')), '@'));

  -- Türkçe-katlanmış arama anahtarı (username_normalized ile aynı uzayda).
  v_key := public.username_key(v_raw);

  -- Minimum 2 karakter (aşırı geniş arama + DoS engeli).
  if length(v_key) < 2 then
    return;
  end if;

  -- LIKE özel karakterlerini (\ _ %) escape et — username'lerde '_' geçerli.
  v_like := replace(v_key, '\', '\\');
  v_like := replace(v_like, '_', '\_');
  v_like := replace(v_like, '%', '\%');

  v_code := upper(v_raw);

  return query
  select
    p.id,
    p.username,
    p.avatar_id,
    public._social_level(p.id),
    p.profile_code,
    c.active_avatar_frame_id,
    case
      when v_me is null then 'none'
      when p.id = v_me then 'self'
      when exists (
        select 1 from public.friends f
         where f.profile_id = v_me and f.friend_profile_id = p.id
      ) then 'friends'
      when exists (
        select 1 from public.friend_requests r
         where r.requester_profile_id = v_me and r.recipient_profile_id = p.id
           and r.status = 'pending'
      ) then 'request_sent'
      when exists (
        select 1 from public.friend_requests r
         where r.requester_profile_id = p.id and r.recipient_profile_id = v_me
           and r.status = 'pending'
      ) then 'request_received'
      else 'none'
    end as relationship_status
  from public.profiles p
  left join public.profile_cosmetics c on c.profile_id = p.id
  where p.username is not null
    and length(btrim(p.username)) > 0
    and (
      coalesce(p.username_normalized, public.username_key(p.username))
        like v_like || '%' escape '\'
      or p.profile_code = v_code
    )
  order by
    (p.profile_code = v_code) desc,
    (coalesce(p.username_normalized, public.username_key(p.username)) = v_key) desc,
    lower(coalesce(p.username, '')) asc
  limit 20;
end
$fn$;

revoke all on function public.search_public_profiles(text) from public;
grant  execute on function public.search_public_profiles(text) to authenticated;


-- ============================================================================
-- Doğrulama (Studio SQL editor):
--   select public.username_key('Padır');      -- 'padir'
--   select public.username_key('@Çağrı');      -- 'cagri'
--   select public.username_key('İbrahim');     -- 'ibrahim'
--   select public.is_username_available('padir');
--   -- Çakışan eski kayıt sayısı (nadir, beklenen, sorun değil):
--   select username_normalized, count(*) from public.profiles
--    where username_normalized is not null
--    group by 1 having count(*) > 1;
-- ============================================================================
