-- ============================================================================
-- Duel Group (Online Çok Oyunculu Ülke Yaz, 3–10 kişi) — RLS hardening · M1
-- ============================================================================
-- AMAÇ
-- ----
-- DuelGroupGame.tsx'in kullandığı `duel_group_*` tablolarını (duel_group_rooms,
-- duel_group_players, duel_group_claims) ileride RPC-only yazma modeline
-- geçirmek için gereken altyapıyı oluşturur. Bu migration HİÇBİR mevcut
-- davranışı değiştirmez — yalnız yeni nesneler ekler. Mevcut geniş RLS
-- politikaları (Studio'da kurulmuş `anon_all_group_*` ve M0
-- `duel_group_claims_all_authenticated`) yerinde kalır; frontend dokunulmaz,
-- canlı oda kapatılmaz, mid-flight maç bozulmaz.
--
-- M1 → M2 → FE switch → M3 sıralaması wheel_duel, wheel_group, conquest ve
-- duel 1v1 hardening'inde dört kez doğrulandı (20260527–20260605). Bu dosya
-- aynı pattern'in `duel_group_*` karşılığıdır.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_group_rooms / duel_group_players / duel_group_claims MEVCUT RLS
--     politikaları (anon FOR ALL ve authenticated FOR ALL) bilinçli olarak
--     yerinde bırakılıyor; M3'te kaldırılacak.
--   • duel_group_rooms / duel_group_players / duel_group_claims MEVCUT
--     SATIRLARI (backfill yok — duel_group_players.profile_id ve guest_id
--     NULL kalır; eski satırlar M3 sonrasında zaten yalnız okunabilir olur,
--     yeni satırlar M2 RPC'leri ile doğru doldurulur).
--   • duel_group_rooms_cleanup_after_player_delete trigger ve onun açtığı
--     duel_group_players REPLICA IDENTITY FULL (20260520130000).
--   • duel_group_claims_all_authenticated policy (20260522120000).
--   • supabase_realtime publication üyelikleri (duel_group_rooms,
--     duel_group_players, duel_group_claims olduğu gibi kalır; yeni
--     duel_group_player_claims tablosu KASTEN dahil EDİLMEZ).
--   • duel_messages tablosu (paylaşımlı chat — Duel 1v1 M2'de eklenen
--     duel_send_message RPC yalnız Duel 1v1 odaları için; Duel Group hâlâ
--     LobbyChat default "direct" yolunu kullanıyor). Bu M1 ona dokunmaz.
--   • Duel 1v1 (duel_rooms / duel_players / duel_claims / duel_player_claims /
--     duel_authorize_player / duel_authorize_host / 12 RPC) — M1+M2+M3+patch
--     ile sertleştirildi; bu migration onlara dokunmaz.
--   • wheel_duel_*, wheel_group_*, conquest_* — kendi M1/M2/M3 setleri.
--   • flag_duel_queue + flag_duel_quick_match / cancel RPC'leri.
--   • cleanup_expired_duel_lobbies RPC.
--   • profiles, xp_events.
--
-- YENİ NESNELER
-- -------------
--   • duel_group_players tablosuna iki yeni kolon:
--       profile_id  uuid null   — logged-in oyuncunun auth.users(id)'si
--       guest_id    text null   — misafir oyuncunun client-üretimli id'si
--     NOT: Duel Group host kavramı duel_group_players.is_host KOLONU ile
--     temsil ediliyor (DuelGroupGame.tsx:28 default false). Bu yüzden Duel 1v1
--     ve Wheel Duel pattern'lerinde yapıldığı gibi rooms'a ayrıca
--     host_player_id kolonu EKLEMİYORUZ — is_host yeterli ve canonical.
--   • public.duel_group_player_claims
--       (player_id PK FK→duel_group_players.id ON DELETE CASCADE,
--        claim_token uuid not null, created_at timestamptz default now())
--       INSERT-only, SELECT/UPDATE/DELETE grant YOK, realtime publication'a
--       EKLENMEZ.
--   • public.duel_group_authorize_player(uuid, uuid) — player yetki helper'ı
--   • public.duel_group_authorize_host  (uuid, uuid, uuid) — host yetki
--     helper'ı (duel_group_players.is_host üzerinden doğrular).
--
-- IDEMPOTENT
-- ----------
--   • "add column if not exists", "create table if not exists",
--     "drop policy if exists" + "create policy", "create or replace function".
--   • Migration tekrar çalıştırılırsa hata vermez.
--
-- TEHDİT MODELİ NOTU
-- ------------------
-- Bu migration TEK BAŞINA güvenlik kazancı sağlamaz; mevcut geniş RLS hâlâ
-- yerinde. M2 (RPC'ler) + FE switch + M3 (RLS daraltma) tamamlanana kadar
-- token yardımcıları beklemede kalır. Bu sıralama bilinçli: önce altyapı,
-- sonra callable yol, en sonda lockdown — her adım bağımsız geri alınabilir.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) duel_group_players — kimlik kolonları
-- ----------------------------------------------------------------------------
-- profile_id: logged-in oyuncuda auth.uid() ile eşleştirilir. NULL → misafir.
-- guest_id  : misafir oyuncuda client-üretimli stabil id (UUID metni).
--             NULL → logged-in. M2 RPC'leri tutarlılığı zorlayacak (XOR check);
--             bu migration sadece kolonları ekler, constraint koymaz (mevcut
--             satırlar her ikisi de NULL kalır, eski yolların ilerideki
--             okumaları bozulmasın). Eski direkt-yazma yolları (lockdown
--             öncesi cached client) bu kolonları doldurmadan INSERT atmaya
--             devam edebilir; nullable olduğu için kabul edilir.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.duel_group_players
  add column if not exists profile_id uuid null;

alter table public.duel_group_players
  add column if not exists guest_id text null;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) duel_group_player_claims — özel claim-token deposu
-- ----------------------------------------------------------------------------
-- Token'lar duel_group_players ile aynı tabloda DURMAZ; eklenirse realtime
-- WAL akışında (duel_group_players supabase_realtime publication'ında ve
-- REPLICA IDENTITY FULL ile) her aboneye token yayınlanırdı. Ayrı tabloda
-- tutarak:
--   (a) supabase_realtime publication'a eklemiyoruz,
--   (b) SELECT policy hiç eklemiyoruz + SELECT grant'i de geri alıyoruz
--       → token sadece insert eden tarafta bilinir.
--
-- player_id PK ve FK ON DELETE CASCADE → bir player satırı silindiğinde
-- (kick, leave_room, room cascade) claim_token de otomatik temizlenir.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.duel_group_player_claims (
  player_id   uuid        primary key
                          references public.duel_group_players(id) on delete cascade,
  claim_token uuid        not null,
  created_at  timestamptz not null default now()
);

alter table public.duel_group_player_claims enable row level security;

-- INSERT açık (anon ve authenticated). Misafir bile join sırasında kendi
-- claim'ini bırakabilmeli. UPDATE/DELETE policy YOK → token rotate edilemez,
-- silinemez (player_id cascade ile silindiğinde otomatik temizlenir).
drop policy if exists "duel_group_player_claims_insert"
  on public.duel_group_player_claims;

create policy "duel_group_player_claims_insert"
  on public.duel_group_player_claims
  for insert
  to anon, authenticated
  with check (true);

-- Defense-in-depth: PostgREST yine de RLS'i uygular, ama SELECT için tablo
-- üstünde grant olmamasını da garanti altına al. (Supabase default tüm public
-- tablolarına anon+authenticated rolüne grant verir; biz select'i geri alıyoruz.)
revoke select, update, delete on public.duel_group_player_claims from anon, authenticated;
grant  insert                   on public.duel_group_player_claims to anon, authenticated;

-- NOT: alter publication supabase_realtime ADD TABLE duel_group_player_claims
-- ÇAĞRILMIYOR. Bu kasıtlı. Token asla broadcast edilmemeli.


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Yetki yardımcıları (read-only, SECURITY DEFINER)
-- ----------------------------------------------------------------------------
-- Duel 1v1 pattern'inin birebir Duel Group karşılığı. M2 RPC'leri bu
-- helper'ları giriş noktası olarak kullanacak; M1 sırasında çağıran yok ama
-- tablo şeması ve grant'lar şimdiden hazır.
--
-- search_path = public, auth → SECURITY DEFINER fonksiyonlarda search_path
-- enjeksiyonunu engellemek için açıkça set ediliyor (Supabase security best
-- practice; tüm prior hardening setlerinde aynısı).
-- ────────────────────────────────────────────────────────────────────────────

-- (a) Bir player_id için: caller ya o satırın profile_id = auth.uid() sahibi
--     ya da claim_token eşleşen misafir mi?
create or replace function public.duel_group_authorize_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.duel_group_players p
      left join public.duel_group_player_claims c
        on c.player_id = p.id
     where p.id = p_player_id
       and (
            -- Logged-in: JWT subject == profile.
            (p.profile_id is not null and p.profile_id = auth.uid())
         or -- Misafir: claim_token eşleşmesi gereken yegane kanıt.
            (p_claim_token is not null and c.claim_token = p_claim_token)
       )
  );
$$;

revoke all     on function public.duel_group_authorize_player(uuid, uuid) from public;
grant  execute on function public.duel_group_authorize_player(uuid, uuid) to anon, authenticated;


-- (b) Verilen oda için: caller, oda host'unun ta kendisi mi?
--     duel_group_players.is_host=true eşleşmesi + authorize_player ZORUNLU.
--
-- NOT: Duel Group şemasında host kavramı duel_group_players.is_host KOLONU
-- (DuelGroupGame.tsx:28 default false; createRoom is_host=true atar, leave
-- akışında oldest joined_at'e host transfer eder — DuelGroupGame.tsx:1129
-- bloku). Bu yüzden Duel 1v1'deki host_player_id kolonu yerine, host
-- doğrulamasını duel_group_players (id, room_id, is_host=true) üçlüsü
-- üzerinden yapıyoruz.
--
-- room_id eşleşmesi şart: aynı player_id başka bir odanın host'u olsa bile
-- bu odanın host'u değilse helper false döner (cross-room host spoof'unu
-- engeller).
create or replace function public.duel_group_authorize_host(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.duel_group_players p
     where p.id        = p_player_id
       and p.room_id   = p_room_id
       and p.is_host   = true
       and public.duel_group_authorize_player(p_player_id, p_claim_token)
  );
$$;

revoke all     on function public.duel_group_authorize_host(uuid, uuid, uuid) from public;
grant  execute on function public.duel_group_authorize_host(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel olarak Studio SQL editor'de çalıştırılabilir):
--
--   -- Yeni kolonlar var mı?
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'duel_group_players'
--      and column_name in ('profile_id', 'guest_id');
--   -- Beklenen: 2 satır, ikisi de YES (nullable).
--
--   -- Yeni tablo:
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name = 'duel_group_player_claims';
--
--   -- Policy yalnız INSERT olmalı:
--   select policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename = 'duel_group_player_claims';
--   -- Beklenen: tek satır, cmd=INSERT, roles={anon,authenticated}.
--
--   -- Grant durumu: anon/authenticated sadece INSERT'e sahip olmalı.
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name   = 'duel_group_player_claims'
--    order by grantee, privilege_type;
--   -- Beklenen: anon → INSERT, authenticated → INSERT (SELECT/UPDATE/DELETE yok).
--
--   -- Claim tablosu realtime publication'da OLMAMALI:
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and schemaname = 'public'
--      and tablename = 'duel_group_player_claims';
--   -- Beklenen: 0 satır.
--
--   -- Fonksiyonlar (security definer flag'i):
--   select proname, prosecdef
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('duel_group_authorize_player', 'duel_group_authorize_host');
--   -- Beklenen: 2 satır, ikisi de prosecdef=true.
--
--   -- Mevcut duel_group_* RLS politikaları HÂLÂ YERİNDE olmalı (M1 dokunmaz):
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('duel_group_rooms', 'duel_group_players', 'duel_group_claims')
--    order by tablename, cmd;
--   -- Beklenen: Studio'da daha önce kurulmuş anon_all_group_* (FOR ALL anon)
--   --           politikaları + duel_group_claims_all_authenticated (M0)
--   --           olduğu gibi listelensin. M1 hiçbirini düşürmez, hiçbirini eklemez.
-- ============================================================================
