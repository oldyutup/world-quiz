-- ============================================================================
-- Arkadaş presence — server-otoriteli heartbeat/expiry (gizlilik korumalı)
-- ============================================================================
-- NEDEN BU TASARIM (global Realtime Presence DEĞİL):
--   Supabase Realtime Presence bir kanala katılan HER istemciye, o kanaldaki
--   TÜM üyelerin presence state'ini (key'ler = profil id'leri) websocket
--   üzerinden yayar. Tek bir global "online-users" kanalı kullanılsaydı,
--   herhangi bir authenticated kullanıcı `presenceState()` ile arkadaşı OLMAYAN
--   kişilerin online profil id'lerini görebilirdi. UI'da gizlemek yetmez; veri
--   tel üzerinde sızar. Bu yüzden presence verisi İSTEMCİYE YALNIZ ARKADAŞLAR
--   İÇİN gelir: okuma server-side SECURITY DEFINER RPC'den geçer ve arkadaşlığı
--   + block durumunu server'da zorlar. Hiçbir istemci başkalarının presence'ını
--   enumerate edemez.
--
-- MODEL:
--   * user_presence(profile_id, last_seen_at): kullanıcı başına TEK satır.
--   * presence_heartbeat(): aktif istemci ~30sn'de bir last_seen_at = now().
--   * Online tanımı = son N saniye (varsayılan 90) içinde heartbeat görülmesi.
--     Kalıcı is_online flag'i YOK → sekme kapanır/kopar/logout olursa heartbeat
--     durur, kullanıcı pencere dışına düşünce otomatik "gri" olur.
--   * friends_presence(window): SADECE benim karşılıklı arkadaşlarımdan, pencere
--     içinde görülmüş ve engellenmemiş olanların id listesi.
--
-- GÜVENLİK (RLS):
--   * user_presence: SELECT yalnız KENDİ satırın; INSERT/UPDATE policy YOK →
--     yazma yalnız definer heartbeat RPC'sinden. Arkadaş presence'ı tabloyu
--     doğrudan okumaktan DEĞİL, friends_presence() RPC'sinden gelir.
--
-- ÇOKLU SEKME: tüm sekmeler aynı tek satırı günceller → en az bir sekme beat
--   attıkça online kalır; hepsi durunca pencere dolunca gri.
--
-- Idempotent + elle (Supabase Studio) uygulanabilir. Client ile BİRLİKTE deploy.
-- Bağımlılık: profiles, friends, is_blocked_between (20260716160000).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) TABLO — kullanıcı başına tek presence satırı.
-- ----------------------------------------------------------------------------
create table if not exists public.user_presence (
  profile_id   uuid        primary key references public.profiles(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);

-- Pencere içi "online" sorgusu için (last_seen_at filtresi).
create index if not exists user_presence_last_seen_idx
  on public.user_presence (last_seen_at);

-- ----------------------------------------------------------------------------
-- 2) RLS — yalnız kendi satırını oku; yazma definer RPC'den.
-- ----------------------------------------------------------------------------
alter table public.user_presence enable row level security;

drop policy if exists "user_presence_self_select" on public.user_presence;
create policy "user_presence_self_select"
  on public.user_presence for select
  to authenticated
  using (profile_id = auth.uid());
-- INSERT/UPDATE/DELETE policy YOK → client doğrudan yazamaz.

-- ----------------------------------------------------------------------------
-- 3) RPC: presence_heartbeat() — kendi last_seen_at'ini now() yapar (upsert).
-- ----------------------------------------------------------------------------
create or replace function public.presence_heartbeat()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    return;  -- sessiz: presence opsiyonel, oturum yoksa no-op.
  end if;
  insert into public.user_presence (profile_id, last_seen_at)
  values (v_me, now())
  on conflict (profile_id) do update set last_seen_at = now();
end
$fn$;

-- ----------------------------------------------------------------------------
-- 4) RPC: friends_presence(p_window_seconds) → SADECE benim KARŞILIKLI
--    arkadaşlarımdan, pencere içinde görülmüş ve engellenmemiş olanların id'leri.
--    KARŞILIKLI (mutual) zorunlu: friends tablosunda HEM (me → X) HEM (X → me)
--    satırı olmalı. Böylece:
--      * Bekleyen arkadaşlık isteği (friend_requests'te, friends'te DEĞİL) → hariç,
--      * Tek yönlü kalıntı satır → hariç,
--      * Arkadaşlıktan çıkarılmış (satır yok) → hariç,
--      * İki yönden herhangi birinde blok (is_blocked_between) → hariç.
-- ----------------------------------------------------------------------------
create or replace function public.friends_presence(p_window_seconds int default 90)
returns table (profile_id uuid)
language sql
stable
security definer
set search_path = public
as $fn$
  select up.profile_id
    from public.user_presence up
   where auth.uid() is not null
     and up.last_seen_at >
         now() - make_interval(secs => greatest(least(coalesce(p_window_seconds, 90), 300), 15))
     and exists (
       select 1 from public.friends f1
        where f1.profile_id = auth.uid()
          and f1.friend_profile_id = up.profile_id
     )
     and exists (
       select 1 from public.friends f2
        where f2.profile_id = up.profile_id
          and f2.friend_profile_id = auth.uid()
     )
     and not public.is_blocked_between(auth.uid(), up.profile_id);
$fn$;

-- ----------------------------------------------------------------------------
-- 5) GRANTS — yalnız authenticated; PUBLIC execute kaldırılır.
-- ----------------------------------------------------------------------------
revoke all on function public.presence_heartbeat() from public;
grant  execute on function public.presence_heartbeat() to authenticated;

revoke all on function public.friends_presence(int) from public;
grant  execute on function public.friends_presence(int) to authenticated;

-- ============================================================================
-- Doğrulama (Studio SQL editor; p1, p2 arkadaş, p3 yabancı):
--   -- p1 oturumunda:
--   select public.presence_heartbeat();
--   -- p2 oturumunda (p1 arkadaşı): p1 görünür
--   select public.friends_presence();        -- → p1
--   -- p3 oturumunda (yabancı): p1 GÖRÜNMEZ
--   select public.friends_presence();        -- → boş
--   -- Hiçbir kullanıcı başkasının satırını doğrudan okuyamaz:
--   select * from public.user_presence;      -- → yalnız kendi satırın (RLS)
-- ============================================================================
