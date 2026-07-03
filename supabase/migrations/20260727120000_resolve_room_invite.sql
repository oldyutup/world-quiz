-- ============================================================================
-- resolve_room_invite(p_id) — bir oda/oyun davetini KALICI olarak "geçersiz"
-- işaretler (bayat aksiyon temizliği).
-- ============================================================================
-- Amac:
--   Kullanıcı bir davete "Katıl" dediğinde oda kapanmış / oyun başlamış / oda
--   silinmiş (ya da davet bağlantısı geçersiz) olabilir. Bu durumda bildirim
--   kartı artık "Katıl / Reddet" göstermemeli; "Davet artık geçerli değil"
--   pasif durumuna geçmeli ve sayfa yenilense de geri gelmemeli.
--
--   Oda daveti için AYRI bir entity tablosu yoktur (davet = notifications satırı).
--   Bu yüzden "geçersiz" durumu, davetin kendi kalıcı alanlarına yazılır:
--     * read_at            → yanıtlanmış/çözülmüş kabul edilir (butonlar kalkar)
--     * payload.inviteState = 'invalid' → kartın "Davet artık geçerli değil"
--       pasif metnini KALICI (cihazlar arası) göstermesi için.
--
-- GÜVENLİK / KAPSAM:
--   * notifications tablosunda UPDATE policy YOK (bkz. 20260715121000_social_core);
--     tüm yazma yolları SECURITY DEFINER RPC'lerden geçer. Bu RPC de aynı deseni
--     izler ve YALNIZ auth.uid() = recipient olan room_invite/game_invite
--     satırını günceller. Başka kullanıcının / başka türün bildirimi etkilenmez.
--   * Idempotent: tekrar çağrılırsa aynı damgayı yazar (read_at coalesce ile
--     korunur — ilk yanıt zamanı kaymaz).
--
-- Idempotent (create or replace) + elle uygulanır. Bağımlılık: notifications
--   (20260715121000_social_core.sql).
-- ============================================================================

create or replace function public.resolve_room_invite(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  update public.notifications
     set read_at = coalesce(read_at, now()),
         payload = coalesce(payload, '{}'::jsonb)
                   || jsonb_build_object('inviteState', 'invalid')
   where id = p_id
     and recipient_profile_id = v_me
     and type in ('room_invite', 'game_invite');

  return jsonb_build_object('ok', true);
end
$fn$;

revoke all     on function public.resolve_room_invite(uuid) from public;
grant  execute on function public.resolve_room_invite(uuid) to authenticated;

-- ============================================================================
-- Doğrulama (Studio SQL editor, oturum açık kullanıcı olarak):
--   -- kendi bir room_invite bildirim id'nle:
--   select public.resolve_room_invite('<notif_id>');       -- { ok: true }
--   select read_at, payload->>'inviteState' from public.notifications
--    where id = '<notif_id>';                               -- read_at dolu + 'invalid'
--   -- RLS/kapsam: başkasının / friend_request türünün bildirimi değişmemeli.
-- ============================================================================
