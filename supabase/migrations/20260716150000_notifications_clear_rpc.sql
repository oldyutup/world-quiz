-- ============================================================================
-- Bildirimleri Temizle: clear_my_notifications() RPC
-- ============================================================================
-- Amac:
--   Kullanıcının bildirim panelindeki eski bildirimleri temizlemesi. notifications
--   tablosunda DELETE policy YOK (bkz. 20260715121000_social_core.sql); tüm yazma
--   yolları SECURITY DEFINER RPC'lerden geçer. Bu yüzden temizleme de güvenli bir
--   RPC ile yapılır. Client doğrudan DELETE yapamaz / yapmamalı.
--
-- GÜVENLİK / KAPSAM:
--   * Yalnız auth.uid() = recipient olan satırlar silinir. Başka kullanıcının
--     bildirimi ASLA etkilenmez.
--   * Yalnız notifications satırları silinir (hard delete). Asıl entity'ler
--     ETKİLENMEZ: friend_requests, friends, davet verisi, achievement reward
--     claim hakkı (claim_achievement_rewards ayrı sistemdir), XP, Gold, profil.
--
-- AKSİYON GEREKTİREN BİLDİRİMLER KORUNUR (silinmez):
--   * friend_request  → alttaki istek hâlâ 'pending' ise (kullanıcı Kabul/Reddet
--     butonunu kaybetmesin; bu bildirim masaüstünde isteğin tek görünür yeri).
--   * room_invite / game_invite → henüz okunmamışsa (kullanıcı görüp karar vermedi).
--   Çözülmüş istek bildirimleri, kabul/ödül/başarım/sistem bildirimleri ve
--   okunmuş genel bildirimler silinir.
--
-- Dönüş: { ok, deleted, preserved }. Client preserved > 0 ise "aksiyon gerektiren
--   bildirimler korundu" notunu gösterir.
--
-- Idempotent (create or replace) + elle uygulanır. Bağımlılık: notifications,
--   friend_requests (20260715121000_social_core.sql).
-- ============================================================================

create or replace function public.clear_my_notifications()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me        uuid := auth.uid();
  v_deleted   int  := 0;
  v_preserved int  := 0;
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  with preserved as (
    -- Hâlâ aksiyon bekleyen bildirimler — silinmez.
    select n.id
      from public.notifications n
     where n.recipient_profile_id = v_me
       and (
         (
           n.type = 'friend_request'
           and exists (
             select 1
               from public.friend_requests fr
              where fr.status = 'pending'
                and fr.id::text = n.payload->>'friendRequestId'
           )
         )
         or (n.type in ('room_invite', 'game_invite') and n.read_at is null)
       )
  ),
  removed as (
    delete from public.notifications n
     where n.recipient_profile_id = v_me
       and n.id not in (select id from preserved)
    returning n.id
  )
  select
    (select count(*) from removed),
    (select count(*) from preserved)
    into v_deleted, v_preserved;

  return jsonb_build_object('ok', true, 'deleted', v_deleted, 'preserved', v_preserved);
end
$fn$;

revoke all     on function public.clear_my_notifications() from public;
grant  execute on function public.clear_my_notifications() to authenticated;

-- ============================================================================
-- Doğrulama (Studio SQL editor, oturum açık kullanıcı olarak):
--   select public.clear_my_notifications();   -- { ok, deleted, preserved }
--   -- pending friend_request + unread room_invite preserved sayılır;
--   -- accepted/reward/achievement/system + okunmuş davetler deleted.
--   -- RLS: başka kullanıcının notification'ı silinmemeli (recipient = auth.uid()).
-- ============================================================================
