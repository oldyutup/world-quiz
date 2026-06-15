-- ============================================================================
-- Profil aramasını düzelten kalıcı fix: username_normalized garantisi
-- ============================================================================
-- Kök sebep:
--   Bazı profillerde username DOLU ama username_normalized NULL. Bunlar web
--   e-posta kaydı (createProfile) ve username güncelleme (updateUsername) gibi
--   client akışlarından geliyor; bu akışlar yalnız `username` yazıp
--   `username_normalized` alanını boş bırakıyordu. search_public_profiles ise
--   username_normalized üzerinden aradığı için (tanidiknamlu, ucakcideniz,
--   frestist gibi) bu kullanıcılar nick ile BULUNAMIYORDU.
--
-- Çözüm (3 katman):
--   1) Backfill — mevcut tüm NULL username_normalized'ları doldur (çakışmaya
--      dayanıklı; tek seferlik ve idempotent).
--   2) Trigger — bundan sonra her insert/update'te (Google/email/guest fark
--      etmez) username_normalized'ı otomatik ve garanti doldur; username
--      değişirse normalized da güncellensin. Artık client'a güvenmiyoruz.
--   3) search_public_profiles — yalnız username_normalized'a bağımlı kalmasın;
--      coalesce(username_normalized, lower(btrim(username))) ile fallback arasın.
--      Böylece ileride herhangi bir sebeple normalized NULL kalsa bile arama
--      çalışır.
--
-- Normalize tanımı, projedeki mevcut helper ile birebir aynı:
--   lower(btrim(username))   (bkz. 20260623120000_profile_username_change.sql)
--
-- Idempotent + elle uygulanabilir. Yazma sadece profiles.username_normalized'a.
-- Gold/email/private veri DÖNMEZ; RPC imzası değişmez.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Backfill — NULL username_normalized'ları doldur (çakışmaya dayanıklı)
-- ----------------------------------------------------------------------------
-- profiles_username_normalized_uniq partial unique index var. Geçmişte NULL
-- normalized sayesinde aynı ada (case-insensitive) sahip iki kayıt yan yana
-- yaşayabilmiş olabilir. Naif bir UPDATE bu durumda 23505 ile patlar. Bu yüzden:
--   * Her normalized değeri için yalnız İLK NULL satırı doldururuz (row_number).
--   * Üstelik o değer zaten dolu bir satıra aitse hiç dokunmayız.
-- Geride kalan nadir kopyalar NULL kalır ama (3) numaradaki fallback sayesinde
-- yine de nick ile bulunur.
with ranked as (
  select
    p.id,
    lower(btrim(p.username)) as norm,
    row_number() over (
      partition by lower(btrim(p.username))
      order by p.id
    ) as rn
  from public.profiles p
  where p.username is not null
    and btrim(p.username) <> ''
    and p.username_normalized is null
)
update public.profiles p
   set username_normalized = r.norm
  from ranked r
 where p.id = r.id
   and r.rn = 1
   and not exists (
     select 1
       from public.profiles e
      where e.username_normalized = r.norm
        and e.id <> p.id
   );

-- ----------------------------------------------------------------------------
-- 2) Trigger — insert/update'te username_normalized'ı garanti doldur
-- ----------------------------------------------------------------------------
-- username dolu ise normalized'ı daima türet; boş/null ise dokunma.
-- BEFORE INSERT OR UPDATE: client ne gönderirse göndersin (hatta yanlış bir
-- normalized gönderse bile) tutarlı tutarız. change_username / setInitialUsername
-- zaten aynı değeri yazıyor; bu trigger onları bozmaz, sadece eksikleri tamamlar.
create or replace function public._sync_username_normalized()
returns trigger
language plpgsql
as $fn$
begin
  if new.username is not null and btrim(new.username) <> '' then
    new.username_normalized := lower(btrim(new.username));
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
-- 3) search_public_profiles — username_normalized fallback'lı sağlam sürüm
-- ----------------------------------------------------------------------------
-- (5) ile aynı sözleşme: imza, dönen kolonlar, güvenlik, grant'lar AYNI.
-- Tek fark: arama ve sıralama coalesce(username_normalized, lower(btrim(username)))
-- üzerinden. profile_code araması aynen korunur, @ önekı temizlenir,
-- LIKE wildcard escape korunur, gold/email/private veri dönmez.
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
  v_q    text;
  v_like text;
  v_code text;
begin
  -- "@username" girişini ve baştaki/sondaki boşlukları normalize et.
  v_q := lower(btrim(coalesce(p_query, '')));
  v_q := btrim(ltrim(v_q, '@'));

  -- Minimum 2 karakter (aşırı geniş arama + DoS engeli).
  if length(v_q) < 2 then
    return;
  end if;

  -- LIKE özel karakterlerini (\ _ %) escape et — username'lerde '_' geçerli.
  v_like := replace(v_q, '\', '\\');
  v_like := replace(v_like, '_', '\_');
  v_like := replace(v_like, '%', '\%');

  v_code := upper(v_q);

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
      -- Fallback: normalized NULL olsa bile username üzerinden türet.
      coalesce(p.username_normalized, lower(btrim(p.username)))
        like v_like || '%' escape '\'
      or p.profile_code = v_code
    )
  order by
    (p.profile_code = v_code) desc,                                   -- tam kod
    (coalesce(p.username_normalized, lower(btrim(p.username))) = v_q) desc, -- tam nick
    lower(coalesce(p.username, '')) asc
  limit 20;
end
$fn$;

-- ----------------------------------------------------------------------------
-- 4) Grants (değişmez; yeniden uygulanması zararsız)
-- ----------------------------------------------------------------------------
revoke all on function public.search_public_profiles(text) from public;
grant  execute on function public.search_public_profiles(text) to authenticated;

-- ============================================================================
-- Doğrulama (Studio SQL editor):
--   -- NULL normalized kalan adlı satır olmamalı (kopyalar hariç):
--   select count(*) from public.profiles
--    where username is not null and btrim(username) <> ''
--      and username_normalized is null;
--   -- Şu kullanıcılar nick ile bulunmalı:
--   select * from public.search_public_profiles('tanidiknamlu');
--   select * from public.search_public_profiles('ucakcideniz');
--   select * from public.search_public_profiles('frestist');
--   -- Profil kodu ile de bulunmaya devam etmeli:
--   select * from public.search_public_profiles( (select profile_code
--     from public.profiles where username = 'frestist') );
-- ============================================================================
