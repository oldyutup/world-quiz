-- ============================================================================
-- 20260720140000_room_invite_open_redirect_hardening.sql
--
-- AMAÇ: Oda daveti (send_room_invite) open-redirect / phishing sıkılaştırması.
--   Bir kullanıcı, başka bir kullanıcıya harici/sahte login linki içeren bir
--   "oda daveti" göndererek onu Torble dışına yönlendirebiliyordu. Bu migration
--   yalnız send_room_invite gövdesini FORWARD-ONLY olarak yeniden tanımlar;
--   tablo/RLS/başka RPC DEĞİŞMEZ, eski migration dosyalarına DOKUNULMAZ.
--
-- EKLENEN KURALLAR (mevcut auth/self/block/spam kontrollerine ek):
--   1) Gönderen daima auth.uid() — client'tan gelen sender ID'ye güvenilmez
--      (zaten böyleydi; korunur).
--   2) Davet YALNIZ iki kullanıcı arkadaşsa gönderilebilir (public.friends —
--      accept_friend_request iki yönlü satır yazar, tek yön kontrolü yeterli).
--   3) İki yönlü block ilişkisinde davet üretilmez (is_blocked_between; korunur).
--   4) Gönderen ve alıcı aynı kişi olamaz (korunur).
--   5) p_room_url YALNIZ Torble-içi göreceli path olabilir:
--        - '/' ile başlamalı (mutlak URL değil),
--        - '//' ile başlamamalı (protocol-relative //evil.com yasak),
--        - backslash içermemeli ('/\evil.com' bazı tarayıcılarda '//'a döner),
--        - boşluk / kontrol karakteri içermemeli,
--        - yalnız güvenli path karakterlerinden oluşmalı (allowlist).
--      Örn. KABUL: '/?conquest=K6MEDT', '/?korNokta=ABC', '/?flagDuel=XYZ'.
--      Örn. RED : 'https://…', 'http://…', 'javascript:…', 'data:…',
--                 '//evil.com', '\\evil.com', boşluklu/kontrol karakterli.
--      Harici URL sessizce dönüştürülmez; güvenli hata ile reddedilir.
--
-- GERİYE UYUM: Uygulamanın ürettiği tüm mevcut geçerli davetler ('/?<mode>=CODE')
--   bu kuralı geçer; bozulmaz. Var olan bildirim satırlarına dokunulmaz.
-- ============================================================================

create or replace function public.send_room_invite(
  p_recipient uuid,
  p_room_code text,
  p_mode      text,
  p_room_url  text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me       uuid := auth.uid();
  v_me_uname text;
  v_notif_id uuid;
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if p_recipient is null or p_room_code is null or length(btrim(p_room_code)) = 0 then
    raise exception 'invite_args_required' using errcode = '22023';
  end if;
  if p_recipient = v_me then
    raise exception 'cannot_invite_self' using errcode = 'P0001';
  end if;

  -- Block (iki yön): engelli ilişkide oda/oyun daveti gönderilemez.
  if public.is_blocked_between(v_me, p_recipient) then
    raise exception 'blocked_between' using errcode = 'P0001';
  end if;

  -- Arkadaşlık zorunlu: yalnız arkadaşlar birbirini odaya davet edebilir.
  -- (public.friends çift yönlü satır tutar; tek yön kontrolü yeterli.)
  if not exists (
    select 1 from public.friends f
     where f.profile_id = v_me
       and f.friend_profile_id = p_recipient
  ) then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;

  -- Oda URL doğrulaması: yalnız Torble-içi göreceli path.
  --   * '/' ile başlar, '//' ile başlamaz (protocol-relative red)
  --   * backslash yok, boşluk/kontrol karakteri yok
  --   * yalnız güvenli path karakterleri (harf/rakam ve /?=&%._~#-)
  if p_room_url is null
     or left(p_room_url, 1) <> '/'
     or left(p_room_url, 2) = '//'
     or position('\' in p_room_url) > 0
     or p_room_url ~ '[[:cntrl:]]'
     or p_room_url ~ '\s'
     or p_room_url !~ '^/[-A-Za-z0-9/?=&%._~#]*$'
  then
    raise exception 'invalid_room_url' using errcode = '22023';
  end if;

  -- Spam guard: aynı alıcıya aynı oda için son 60sn'de davet varsa tekrar üretme.
  if exists (
    select 1 from public.notifications
     where recipient_profile_id = p_recipient
       and actor_profile_id = v_me
       and type = 'room_invite'
       and payload->>'roomCode' = p_room_code
       and created_at > now() - interval '60 seconds'
  ) then
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;

  select username into v_me_uname from public.profiles where id = v_me;

  insert into public.notifications (recipient_profile_id, actor_profile_id, type, title, body, payload)
  values (
    p_recipient, v_me, 'room_invite', 'Oyun daveti',
    '@' || coalesce(v_me_uname, 'biri') || ' seni bir oyuna davet etti.',
    jsonb_build_object('roomCode', p_room_code, 'mode', p_mode, 'roomUrl', p_room_url)
  )
  returning id into v_notif_id;

  return jsonb_build_object('ok', true, 'notificationId', v_notif_id);
end
$fn$;

-- Grant'lar social_core.sql'deki ile aynı; imza değişmediği için yeniden
-- vermeye gerek yok, ancak idempotent olması için tekrar belirtiriz.
revoke all on function public.send_room_invite(uuid, text, text, text) from public;
grant  execute on function public.send_room_invite(uuid, text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Manuel doğrulama (psql):
--   -- arkadaş + göreceli path → OK
--   select public.send_room_invite('<friend>','K6MEDT','conquest','/?conquest=K6MEDT');
--   -- arkadaş değil → 'not_friends'
--   select public.send_room_invite('<stranger>','K6MEDT','conquest','/?conquest=K6MEDT');
--   -- harici URL → 'invalid_room_url'
--   select public.send_room_invite('<friend>','K6MEDT','conquest','https://evil.example');
--   select public.send_room_invite('<friend>','K6MEDT','conquest','javascript:alert(1)');
--   select public.send_room_invite('<friend>','K6MEDT','conquest','//evil.example');
--   select public.send_room_invite('<friend>','K6MEDT','conquest','\\evil.example');
-- ----------------------------------------------------------------------------
