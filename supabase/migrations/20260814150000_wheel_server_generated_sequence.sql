-- ============================================================================
-- Çark Düello + Çark Grup — SIRA ARTIK SUNUCUDA ÜRETİLİR (client payload YOK)
-- ============================================================================
-- GÜVENLİK AÇIĞI (20260814140000'de tanıtıldı, bu migration KAPATIR)
-- ---------------------------------------------------------------
-- `*_seed_target_sequence` host şartı aramıyordu: odanın HERHANGİ bir üyesi,
-- `target_sequence is null` iken maçın TAM hedef sırasını kendisi yazabiliyordu.
-- Doğrulama yalnız BİÇİMSELDİ (1..512, NULL/boş yok, tekrar yok), yani:
--
--   • kötü niyetli NON-HOST, host'tan önce yarışı kazanıp sırayı belirleyebilir,
--   • kolay hedefleri öne alabilir,
--   • oyunda hiç bulunmayan/bölge dışı topoid yazabilir (griefing: kimsenin
--     tıklayamayacağı hedef),
--   • ve sıra CAS ile kilitlendiği için bu, maçın TAMAMINI etkiler.
--
-- "Host zaten hedefleri seçebiliyordu" savunması GEÇERSİZDİ: host'un sahip
-- olduğu yetki, non-host'un BUGÜNE KADAR SAHİP OLMADIĞI bir yetkiydi.
--
-- Dahası, `target_sequence` oda satırında (client-readable + realtime
-- `replica identity full`) duruyordu → İKİ oyuncu da maçın tüm gelecek hedef
-- sırasını okuyabilirdi. Hız oyununda bu, imleci önceden konumlandırma
-- avantajı demektir; hijack'ten bile ağır bir sızıntı.
--
-- ÇÖZÜM — istemciden sıra ALINMAZ
-- -------------------------------
-- Sıra artık TAMAMEN SUNUCUDA üretilir:
--   1. `wheel_target_catalog` — kanonik havuz (bölge × topo_id × fame_tier).
--      İçerik `src/data/countries.ts`ten GERÇEK `getWheelPool()` / `getFameTier()`
--      çağrılarıyla üretildi (scripts/build-wheel-target-catalog.ts) → mikro-devlet
--      dışlamaları, MULTI_CONTINENT ve tier kuralları birebir korunur; SQL'e
--      elle port EDİLMEDİ.
--   2. `wheel_generate_sequence(region, span)` — `buildProgressionQueue`nun
--      SQL portu: tier kovaları + `progressionTierWeights` bantları + ağırlıklı
--      seçim + boş-kova "en yakın ortalama" yedeği. Rastgelelik SUNUCUDA.
--   3. Sıra `*_room_sequences` PRIVATE tablosunda tutulur (anon/authenticated'a
--      grant YOK, RLS default-deny, realtime publication DIŞI) → hiçbir istemci
--      gelecekteki hedefleri okuyamaz.
--   4. `*_advance_if_due` FAZ 0'da sırayı TEMBEL ve ATOMİK olarak oluşturur
--      (`on conflict do nothing` → ilk çağrı üretir, diğerleri onu kullanır).
--
-- SONUÇ:
--   • İstemci artık sıra GÖNDEREMEZ  → hijack yüzeyi TAMAMEN kapandı.
--   • İstemci sırayı OKUYAMAZ        → bilgi avantajı kalmadı (host dâhil).
--   • Sırayı kim tetiklerse tetiklesin içerik AYNI kurala göre sunucuda üretilir
--     → "yarışı kim kazandı" artık önemsiz; QM race window kavramı ORTADAN KALKTI.
--   • Host hiç görünmese bile ilk advance_if_due sırayı kurar → SPOF yok.
--
-- ZORLUK EĞRİSİ DEĞİŞMEDİ: aynı havuz, aynı tier'lar, aynı bant ağırlıkları
-- ([10,3,0,0] / [2,8,2,0] / [0,2,7,2] / [0,0,2,8]), aynı span formülü
-- (max(6, round(duration/6))).
--
-- KALDIRILANLAR (artık gereksiz + tehlikeli):
--   • wheel_duel_set_target_sequence / wheel_duel_seed_target_sequence
--   • wheel_group_set_target_sequence / wheel_group_seed_target_sequence
--   • wheel_duel_rooms.target_sequence / wheel_group_rooms.target_sequence
--     (istemciye açık kolon → sızıntı kaynağıydı)
--
-- DOKUNULMAYANLAR: wheel_duel_quick_match (gövdesi repoda YOK), pick_target,
-- finish_game, claim_target, vote_pass, process_skip, process_rematch,
-- leave_room ve diğer tüm modlar.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Kanonik hedef kataloğu — PRIVATE
-- ----------------------------------------------------------------------------
-- Satırlar scripts/build-wheel-target-catalog.ts tarafından ÜRETİLDİ. Elle
-- düzenleme; countries.ts değişirse script yeniden koşulur (drift testi
-- check-wheel-advance-if-due.ts'te kilitli).
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.wheel_target_catalog (
  region    text not null,
  topo_id   text not null,
  fame_tier int  not null check (fame_tier between 1 and 4),
  primary key (region, topo_id)
);

alter table public.wheel_target_catalog enable row level security;
-- Policy YOK → RLS default-deny. SECURITY DEFINER fonksiyonları (owner) bypass
-- eder. Grant de yok → çifte kilit.
revoke all on table public.wheel_target_catalog from anon, authenticated, public;

insert into public.wheel_target_catalog (region, topo_id, fame_tier) values
  ('world', '008', 2),
  ('world', '040', 2),
  ('world', '112', 2),
  ('world', '056', 2),
  ('world', '070', 2),
  ('world', '100', 2),
  ('world', '191', 2),
  ('world', '196', 2),
  ('world', '203', 2),
  ('world', '208', 2),
  ('world', '233', 3),
  ('world', '246', 2),
  ('world', '250', 1),
  ('world', '276', 1),
  ('world', '300', 1),
  ('world', '348', 2),
  ('world', '352', 2),
  ('world', '372', 2),
  ('world', '380', 1),
  ('world', '428', 2),
  ('world', '440', 2),
  ('world', '442', 2),
  ('world', '498', 3),
  ('world', '499', 3),
  ('world', '528', 1),
  ('world', '807', 2),
  ('world', '578', 2),
  ('world', '616', 2),
  ('world', '620', 1),
  ('world', '642', 2),
  ('world', '643', 1),
  ('world', '688', 2),
  ('world', '703', 2),
  ('world', '705', 2),
  ('world', '724', 1),
  ('world', '752', 2),
  ('world', '756', 2),
  ('world', '804', 1),
  ('world', '826', 1),
  ('world', 'XK', 4),
  ('world', '004', 2),
  ('world', '051', 2),
  ('world', '031', 1),
  ('world', '050', 2),
  ('world', '064', 4),
  ('world', '116', 3),
  ('world', '156', 1),
  ('world', '268', 3),
  ('world', '356', 1),
  ('world', '360', 2),
  ('world', '364', 1),
  ('world', '368', 1),
  ('world', '376', 2),
  ('world', '392', 1),
  ('world', '400', 3),
  ('world', '398', 2),
  ('world', '414', 2),
  ('world', '417', 3),
  ('world', '418', 3),
  ('world', '422', 2),
  ('world', '458', 2),
  ('world', '496', 2),
  ('world', '104', 2),
  ('world', '524', 2),
  ('world', '408', 2),
  ('world', '512', 3),
  ('world', '586', 2),
  ('world', '275', 3),
  ('world', '608', 2),
  ('world', '634', 3),
  ('world', '682', 1),
  ('world', '410', 1),
  ('world', '144', 2),
  ('world', '760', 2),
  ('world', '762', 3),
  ('world', '764', 2),
  ('world', '626', 4),
  ('world', '792', 1),
  ('world', '795', 3),
  ('world', '784', 2),
  ('world', '860', 3),
  ('world', '704', 2),
  ('world', '887', 2),
  ('world', '012', 2),
  ('world', '024', 2),
  ('world', '204', 4),
  ('world', '072', 3),
  ('world', '854', 4),
  ('world', '108', 4),
  ('world', '120', 2),
  ('world', '140', 3),
  ('world', '148', 2),
  ('world', '178', 3),
  ('world', '180', 2),
  ('world', '384', 2),
  ('world', '262', 4),
  ('world', '818', 1),
  ('world', '226', 4),
  ('world', '232', 4),
  ('world', '231', 2),
  ('world', '266', 4),
  ('world', '270', 4),
  ('world', '288', 2),
  ('world', '324', 4),
  ('world', '624', 4),
  ('world', '404', 2),
  ('world', '426', 4),
  ('world', '430', 4),
  ('world', '434', 2),
  ('world', '450', 2),
  ('world', '454', 3),
  ('world', '466', 2),
  ('world', '478', 4),
  ('world', '504', 2),
  ('world', '508', 2),
  ('world', '516', 2),
  ('world', '562', 4),
  ('world', '566', 2),
  ('world', '646', 2),
  ('world', '686', 2),
  ('world', '694', 4),
  ('world', '706', 2),
  ('world', '710', 2),
  ('world', '728', 2),
  ('world', '729', 2),
  ('world', '748', 4),
  ('world', '834', 2),
  ('world', '768', 4),
  ('world', '788', 2),
  ('world', '800', 2),
  ('world', '894', 2),
  ('world', '716', 2),
  ('world', '044', 3),
  ('world', '084', 4),
  ('world', '124', 1),
  ('world', '188', 3),
  ('world', '192', 2),
  ('world', '214', 2),
  ('world', '222', 3),
  ('world', '320', 2),
  ('world', '332', 2),
  ('world', '340', 2),
  ('world', '388', 3),
  ('world', '484', 1),
  ('world', '558', 3),
  ('world', '591', 2),
  ('world', '780', 3),
  ('world', '840', 1),
  ('world', '032', 1),
  ('world', '068', 3),
  ('world', '076', 1),
  ('world', '152', 2),
  ('world', '170', 2),
  ('world', '218', 2),
  ('world', '328', 4),
  ('world', '600', 4),
  ('world', '604', 2),
  ('world', '740', 4),
  ('world', '858', 4),
  ('world', '862', 2),
  ('world', '036', 1),
  ('world', '554', 2),
  ('world', '598', 3),
  ('world', '090', 4),
  ('world', '548', 4),
  ('europe', '008', 2),
  ('europe', '040', 2),
  ('europe', '112', 2),
  ('europe', '056', 2),
  ('europe', '070', 2),
  ('europe', '100', 2),
  ('europe', '191', 2),
  ('europe', '196', 2),
  ('europe', '203', 2),
  ('europe', '208', 2),
  ('europe', '233', 3),
  ('europe', '246', 2),
  ('europe', '250', 1),
  ('europe', '276', 1),
  ('europe', '300', 1),
  ('europe', '348', 2),
  ('europe', '352', 2),
  ('europe', '372', 2),
  ('europe', '380', 1),
  ('europe', '428', 2),
  ('europe', '440', 2),
  ('europe', '442', 2),
  ('europe', '498', 3),
  ('europe', '499', 3),
  ('europe', '528', 1),
  ('europe', '807', 2),
  ('europe', '578', 2),
  ('europe', '616', 2),
  ('europe', '620', 1),
  ('europe', '642', 2),
  ('europe', '643', 1),
  ('europe', '688', 2),
  ('europe', '703', 2),
  ('europe', '705', 2),
  ('europe', '724', 1),
  ('europe', '752', 2),
  ('europe', '756', 2),
  ('europe', '804', 1),
  ('europe', '826', 1),
  ('europe', 'XK', 4),
  ('asia', '004', 2),
  ('asia', '051', 2),
  ('asia', '031', 1),
  ('asia', '050', 2),
  ('asia', '064', 4),
  ('asia', '116', 3),
  ('asia', '156', 1),
  ('asia', '268', 3),
  ('asia', '356', 1),
  ('asia', '360', 2),
  ('asia', '364', 1),
  ('asia', '368', 1),
  ('asia', '376', 2),
  ('asia', '392', 1),
  ('asia', '400', 3),
  ('asia', '398', 2),
  ('asia', '414', 2),
  ('asia', '417', 3),
  ('asia', '418', 3),
  ('asia', '422', 2),
  ('asia', '458', 2),
  ('asia', '496', 2),
  ('asia', '104', 2),
  ('asia', '524', 2),
  ('asia', '408', 2),
  ('asia', '512', 3),
  ('asia', '586', 2),
  ('asia', '275', 3),
  ('asia', '608', 2),
  ('asia', '634', 3),
  ('asia', '682', 1),
  ('asia', '410', 1),
  ('asia', '144', 2),
  ('asia', '760', 2),
  ('asia', '762', 3),
  ('asia', '764', 2),
  ('asia', '626', 4),
  ('asia', '792', 1),
  ('asia', '795', 3),
  ('asia', '784', 2),
  ('asia', '860', 3),
  ('asia', '704', 2),
  ('asia', '887', 2),
  ('africa', '012', 2),
  ('africa', '024', 2),
  ('africa', '204', 4),
  ('africa', '072', 3),
  ('africa', '854', 4),
  ('africa', '108', 4),
  ('africa', '120', 2),
  ('africa', '140', 3),
  ('africa', '148', 2),
  ('africa', '178', 3),
  ('africa', '180', 2),
  ('africa', '384', 2),
  ('africa', '262', 4),
  ('africa', '818', 1),
  ('africa', '226', 4),
  ('africa', '232', 4),
  ('africa', '231', 2),
  ('africa', '266', 4),
  ('africa', '270', 4),
  ('africa', '288', 2),
  ('africa', '324', 4),
  ('africa', '624', 4),
  ('africa', '404', 2),
  ('africa', '426', 4),
  ('africa', '430', 4),
  ('africa', '434', 2),
  ('africa', '450', 2),
  ('africa', '454', 3),
  ('africa', '466', 2),
  ('africa', '478', 4),
  ('africa', '504', 2),
  ('africa', '508', 2),
  ('africa', '516', 2),
  ('africa', '562', 4),
  ('africa', '566', 2),
  ('africa', '646', 2),
  ('africa', '686', 2),
  ('africa', '694', 4),
  ('africa', '706', 2),
  ('africa', '710', 2),
  ('africa', '728', 2),
  ('africa', '729', 2),
  ('africa', '748', 4),
  ('africa', '834', 2),
  ('africa', '768', 4),
  ('africa', '788', 2),
  ('africa', '800', 2),
  ('africa', '894', 2),
  ('africa', '716', 2),
  ('north_america', '044', 3),
  ('north_america', '084', 4),
  ('north_america', '124', 1),
  ('north_america', '188', 3),
  ('north_america', '192', 2),
  ('north_america', '214', 2),
  ('north_america', '222', 3),
  ('north_america', '320', 2),
  ('north_america', '332', 2),
  ('north_america', '340', 2),
  ('north_america', '388', 3),
  ('north_america', '484', 1),
  ('north_america', '558', 3),
  ('north_america', '591', 2),
  ('north_america', '780', 3),
  ('north_america', '840', 1),
  ('south_america', '032', 1),
  ('south_america', '068', 3),
  ('south_america', '076', 1),
  ('south_america', '152', 2),
  ('south_america', '170', 2),
  ('south_america', '218', 2),
  ('south_america', '328', 4),
  ('south_america', '600', 4),
  ('south_america', '604', 2),
  ('south_america', '740', 4),
  ('south_america', '858', 4),
  ('south_america', '862', 2),
  ('oceania', '036', 1),
  ('oceania', '554', 2),
  ('oceania', '598', 3),
  ('oceania', '090', 4),
  ('oceania', '548', 4)
on conflict (region, topo_id) do update set fame_tier = excluded.fame_tier;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Sıra deposu — PRIVATE (istemci OKUYAMAZ)
-- ----------------------------------------------------------------------------
-- Oda satırında DEĞİL ayrı tabloda: wheel_*_rooms client-readable ve realtime
-- `replica identity full` ile tam satır yayınlıyor. Sıra orada dursa iki oyuncu
-- da gelecek hedefleri okurdu.
-- FK cascade: oda silinince sıra da gider (wheel_*_players ile aynı desen).
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.wheel_duel_room_sequences (
  room_id    uuid primary key references public.wheel_duel_rooms(id) on delete cascade,
  targets    text[] not null,
  created_at timestamptz not null default now()
);

create table if not exists public.wheel_group_room_sequences (
  room_id    uuid primary key references public.wheel_group_rooms(id) on delete cascade,
  targets    text[] not null,
  created_at timestamptz not null default now()
);

alter table public.wheel_duel_room_sequences enable row level security;
alter table public.wheel_group_room_sequences enable row level security;
revoke all on table public.wheel_duel_room_sequences from anon, authenticated, public;
revoke all on table public.wheel_group_room_sequences from anon, authenticated, public;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) progressionTierWeights portu
-- ----------------------------------------------------------------------------
-- countries.ts L762-768 ile BİREBİR aynı bantlar ve ağırlıklar.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_progression_tier_weights(p numeric)
returns int[]
language sql
immutable
as $$
  select case
    when least(greatest(coalesce(p, 0), 0), 1) < 0.40 then array[10, 3, 0, 0]
    when least(greatest(coalesce(p, 0), 0), 1) < 0.70 then array[2,  8, 2, 0]
    when least(greatest(coalesce(p, 0), 0), 1) < 0.90 then array[0,  2, 7, 2]
    else                                                   array[0,  0, 2, 8]
  end;
$$;

revoke all on function public.wheel_progression_tier_weights(numeric) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) buildProgressionQueue portu
-- ----------------------------------------------------------------------------
-- countries.ts L816-831 + chooseTier (L772-797) + bucketByTier (L799-804).
-- Rastgelelik SUNUCUDA (`random()`), istemci etkileyemez.
-- Bilinmeyen bölge → 'world' havuzuna düşer (dizi ASLA boş dönmez).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_generate_sequence(p_region text, p_span int)
returns text[]
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_region  text := p_region;
  b         text[][];
  v_out     text[] := '{}';
  v_total   int;
  v_span    int := greatest(coalesce(p_span, 6), 1);
  i         int;
  k         int;
  p         numeric;
  w         int[];
  avail     int[];
  sum_w     int;
  r         numeric;
  t         int;
  mean_t    numeric;
  tot_w     int;
  best      int;
  best_dist numeric;
  b1 text[]; b2 text[]; b3 text[]; b4 text[];
begin
  if v_region is null
     or not exists (select 1 from public.wheel_target_catalog where region = v_region) then
    v_region := 'world';
  end if;

  -- bucketByTier: tier başına kova + kova İÇİNDE rastgele sıra
  select coalesce(array_agg(topo_id order by random()), '{}'::text[]) into b1
    from public.wheel_target_catalog where region = v_region and fame_tier = 1;
  select coalesce(array_agg(topo_id order by random()), '{}'::text[]) into b2
    from public.wheel_target_catalog where region = v_region and fame_tier = 2;
  select coalesce(array_agg(topo_id order by random()), '{}'::text[]) into b3
    from public.wheel_target_catalog where region = v_region and fame_tier = 3;
  select coalesce(array_agg(topo_id order by random()), '{}'::text[]) into b4
    from public.wheel_target_catalog where region = v_region and fame_tier = 4;

  v_total := coalesce(array_length(b1,1),0) + coalesce(array_length(b2,1),0)
           + coalesce(array_length(b3,1),0) + coalesce(array_length(b4,1),0);
  if v_total = 0 then
    return '{}'::text[];
  end if;

  for i in 0..(v_total - 1) loop
    p := least(i::numeric / greatest(v_span - 1, 1)::numeric, 1);
    w := public.wheel_progression_tier_weights(p);

    avail := array[
      case when coalesce(array_length(b1,1),0) > 0 then w[1] else 0 end,
      case when coalesce(array_length(b2,1),0) > 0 then w[2] else 0 end,
      case when coalesce(array_length(b3,1),0) > 0 then w[3] else 0 end,
      case when coalesce(array_length(b4,1),0) > 0 then w[4] else 0 end
    ];
    sum_w := avail[1] + avail[2] + avail[3] + avail[4];
    t := -1;

    if sum_w > 0 then
      r := random() * sum_w;
      for k in 1..4 loop
        r := r - avail[k];
        if r < 0 then t := k; exit; end if;
      end loop;
      if t < 0 then                                   -- kayan nokta yedeği
        for k in reverse 4..1 loop
          if avail[k] > 0 then t := k; exit; end if;
        end loop;
      end if;
    else
      -- chooseTier yedeği: ağırlıklı ortalama tier'a EN YAKIN dolu kova
      tot_w := w[1] + w[2] + w[3] + w[4];
      if tot_w > 0 then
        mean_t := (w[1]*0 + w[2]*1 + w[3]*2 + w[4]*3)::numeric / tot_w;
      else
        mean_t := 0;
      end if;
      best := -1; best_dist := null;
      for k in 1..4 loop
        if (k = 1 and coalesce(array_length(b1,1),0) > 0)
        or (k = 2 and coalesce(array_length(b2,1),0) > 0)
        or (k = 3 and coalesce(array_length(b3,1),0) > 0)
        or (k = 4 and coalesce(array_length(b4,1),0) > 0) then
          if best_dist is null or abs((k-1) - mean_t) < best_dist then
            best_dist := abs((k-1) - mean_t);
            best := k;
          end if;
        end if;
      end loop;
      t := best;
    end if;

    exit when t < 0;

    -- seçilen kovadan pop
    if t = 1 then v_out := array_append(v_out, b1[1]); b1 := b1[2:];
    elsif t = 2 then v_out := array_append(v_out, b2[1]); b2 := b2[2:];
    elsif t = 3 then v_out := array_append(v_out, b3[1]); b3 := b3[2:];
    else             v_out := array_append(v_out, b4[1]); b4 := b4[2:];
    end if;
  end loop;

  return v_out;
end;
$$;

revoke all on function public.wheel_generate_sequence(text, int) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) Tembel + atomik kurulum
-- ----------------------------------------------------------------------------
-- `on conflict do nothing`: iki istemci aynı anda tetiklerse yalnız biri üretir,
-- diğeri var olanı okur. Sıra bir kez yazıldıktan sonra DEĞİŞTİRİLEMEZ.
-- span = expectedWheelTargets(duration) = max(6, round(duration/6)).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_ensure_sequence(p_room_id uuid)
returns text[]
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_seq  text[];
  v_room public.wheel_duel_rooms;
begin
  select targets into v_seq
    from public.wheel_duel_room_sequences where room_id = p_room_id;
  if v_seq is not null then
    return v_seq;
  end if;

  select * into v_room from public.wheel_duel_rooms where id = p_room_id;
  if v_room.id is null then
    return null;
  end if;

  v_seq := public.wheel_generate_sequence(
             v_room.region,
             greatest(6, round(coalesce(v_room.duration_seconds, 60) / 6.0)::int));
  if coalesce(array_length(v_seq, 1), 0) = 0 then
    return null;
  end if;

  insert into public.wheel_duel_room_sequences (room_id, targets)
  values (p_room_id, v_seq)
  on conflict (room_id) do nothing;

  select targets into v_seq
    from public.wheel_duel_room_sequences where room_id = p_room_id;
  return v_seq;
end;
$$;

revoke all on function public.wheel_duel_ensure_sequence(uuid) from public, anon, authenticated;

create or replace function public.wheel_group_ensure_sequence(p_room_id uuid)
returns text[]
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_seq  text[];
  v_room public.wheel_group_rooms;
begin
  select targets into v_seq
    from public.wheel_group_room_sequences where room_id = p_room_id;
  if v_seq is not null then
    return v_seq;
  end if;

  select * into v_room from public.wheel_group_rooms where id = p_room_id;
  if v_room.id is null then
    return null;
  end if;

  v_seq := public.wheel_generate_sequence(
             v_room.region,
             greatest(6, round(coalesce(v_room.duration_seconds, 60) / 6.0)::int));
  if coalesce(array_length(v_seq, 1), 0) = 0 then
    return null;
  end if;

  insert into public.wheel_group_room_sequences (room_id, targets)
  values (p_room_id, v_seq)
  on conflict (room_id) do nothing;

  select targets into v_seq
    from public.wheel_group_room_sequences where room_id = p_room_id;
  return v_seq;
end;
$$;

revoke all on function public.wheel_group_ensure_sequence(uuid) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) next_target — artık PRIVATE tablodan okur
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_next_target(p_room_id uuid)
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select s.topoid
    from public.wheel_duel_rooms r
    join public.wheel_duel_room_sequences q on q.room_id = r.id
    cross join lateral unnest(q.targets) with ordinality as s(topoid, ord)
   where r.id = p_room_id
     and s.topoid is not null
     and s.topoid <> ''
     and not (s.topoid = any (coalesce(r.used_target_topoids, '{}'::text[])))
     and s.topoid is distinct from r.current_target_topoid
   order by s.ord
   limit 1;
$$;

revoke all on function public.wheel_duel_next_target(uuid) from public, anon, authenticated;

create or replace function public.wheel_group_next_target(p_room_id uuid)
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select s.topoid
    from public.wheel_group_rooms r
    join public.wheel_group_room_sequences q on q.room_id = r.id
    cross join lateral unnest(q.targets) with ordinality as s(topoid, ord)
   where r.id = p_room_id
     and s.topoid is not null
     and s.topoid <> ''
     and not (s.topoid = any (coalesce(r.used_target_topoids, '{}'::text[])))
     and s.topoid is distinct from r.current_target_topoid
   order by s.ord
   limit 1;
$$;

revoke all on function public.wheel_group_next_target(uuid) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) İSTEMCİ TARAFLI SIRA YAZMA YOLLARINI KALDIR
-- ----------------------------------------------------------------------------
-- Bu dört RPC'nin VARLIĞI açığın kendisiydi. Kolonlar da istemciye açık
-- olduğu için (sızıntı) düşürülür.
-- ────────────────────────────────────────────────────────────────────────────

drop function if exists public.wheel_duel_set_target_sequence(uuid, uuid, uuid, text[]);
drop function if exists public.wheel_duel_seed_target_sequence(uuid, uuid, uuid, text[]);
drop function if exists public.wheel_group_set_target_sequence(uuid, uuid, uuid, text[]);
drop function if exists public.wheel_group_seed_target_sequence(uuid, uuid, uuid, text[]);

alter table public.wheel_duel_rooms  drop column if exists target_sequence;
alter table public.wheel_group_rooms drop column if exists target_sequence;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) advance_if_due — FAZ 0: sırayı tembel/atomik kur
-- ----------------------------------------------------------------------------
-- 20260814120000/130000'deki otomatın AYNISI; tek fark FAZ 0 ve "dizi yok"
-- dalının artık PRIVATE tabloya bakması.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_advance_if_due(
  p_room_id         uuid,
  p_player_id       uuid,
  p_claim_token     uuid,
  p_expected_target text
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.wheel_duel_rooms;
  v_now        timestamptz := now();
  v_next       text;
  v_winner     uuid;
  v_pass_count int;
  v_seq        text[];
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select * into v_room from public.wheel_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'playing' then
    return v_room;
  end if;

  -- ── FAZ 0: SIRAYI GARANTİ ET (sunucu üretir; istemci veri göndermez) ────
  v_seq := public.wheel_duel_ensure_sequence(p_room_id);

  -- ── FAZ 1: MAÇ SONU (CAS'tan ÖNCE — deadline mutlaktır) ────────────────
  if v_room.started_at is not null
     and v_now >= v_room.started_at + make_interval(secs => v_room.duration_seconds)
  then
    v_winner := public.wheel_duel_score_winner(p_room_id);
    update public.wheel_duel_rooms
       set status                = 'finished',
           finished_at           = v_now,
           finished_reason       = 'timeout',
           winner_player_id      = v_winner,
           current_target_topoid = null
     where id = p_room_id
       and status = 'playing'
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.wheel_duel_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  -- ── FAZ 2: CAS ─────────────────────────────────────────────────────────
  if v_room.current_target_topoid is distinct from p_expected_target then
    return v_room;
  end if;

  -- ── FAZ 3: SKIP (pas eşiği) ────────────────────────────────────────────
  if v_room.current_target_topoid is not null
     and v_room.pass_target_topoid is not distinct from v_room.current_target_topoid
  then
    select coalesce(array_length(v_room.pass_requested_by, 1), 0) into v_pass_count;
    if v_pass_count >= 2 then
      update public.wheel_duel_rooms
         set used_target_topoids   = array_append(
                                       coalesce(used_target_topoids, '{}'::text[]),
                                       current_target_topoid),
             current_target_topoid = null,
             pass_requested_by     = '{}',
             pass_target_topoid    = null
       where id = p_room_id
         and status = 'playing'
         and current_target_topoid = v_room.current_target_topoid
       returning * into v_room;
      if v_room.id is null then
        select * into v_room from public.wheel_duel_rooms where id = p_room_id;
      end if;
      return v_room;
    end if;
  end if;

  if v_room.current_target_topoid is not null then
    return v_room;
  end if;

  -- ── FAZ 4: REFILL ──────────────────────────────────────────────────────
  if v_room.updated_at is not null
     and v_now < v_room.updated_at
                 + make_interval(secs => public.wheel_duel_feedback_delay_ms() / 1000.0)
  then
    return v_room;
  end if;

  v_next := public.wheel_duel_next_target(p_room_id);

  if v_next is null then
    -- Sıra hiç kurulamadıysa (katalog boş) maçı bitirme — host yolu dursun.
    if coalesce(array_length(v_seq, 1), 0) = 0 then
      return v_room;
    end if;
    v_winner := public.wheel_duel_score_winner(p_room_id);
    update public.wheel_duel_rooms
       set status                = 'finished',
           finished_at           = v_now,
           finished_reason       = 'pool',
           winner_player_id      = v_winner,
           current_target_topoid = null
     where id = p_room_id
       and status = 'playing'
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.wheel_duel_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  update public.wheel_duel_rooms
     set current_target_topoid = v_next,
         pass_requested_by     = '{}',
         pass_target_topoid    = null
   where id = p_room_id
     and status = 'playing'
     and current_target_topoid is null
   returning * into v_room;
  if v_room.id is null then
    select * into v_room from public.wheel_duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_advance_if_due(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_duel_advance_if_due(uuid, uuid, uuid, text) to anon, authenticated;


create or replace function public.wheel_group_advance_if_due(
  p_room_id         uuid,
  p_player_id       uuid,
  p_claim_token     uuid,
  p_expected_target text
) returns public.wheel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.wheel_group_rooms;
  v_now  timestamptz := now();
  v_next text;
  v_seq  text[];
begin
  if not public.wheel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.wheel_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select * into v_room from public.wheel_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'playing' then
    return v_room;
  end if;

  -- FAZ 0
  v_seq := public.wheel_group_ensure_sequence(p_room_id);

  -- FAZ 1: maç sonu
  if v_room.started_at is not null
     and v_now >= v_room.started_at + make_interval(secs => v_room.duration_seconds)
  then
    update public.wheel_group_rooms
       set status                = 'finished',
           finished_at           = v_now,
           finished_reason       = 'timeout',
           current_target_topoid = null
     where id = p_room_id
       and status = 'playing'
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.wheel_group_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  -- FAZ 2: CAS
  if v_room.current_target_topoid is distinct from p_expected_target then
    return v_room;
  end if;
  if v_room.current_target_topoid is not null then
    return v_room;
  end if;

  -- FAZ 3: refill
  if v_room.updated_at is not null
     and v_now < v_room.updated_at
                 + make_interval(secs => public.wheel_group_feedback_delay_ms() / 1000.0)
  then
    return v_room;
  end if;

  v_next := public.wheel_group_next_target(p_room_id);

  if v_next is null then
    if coalesce(array_length(v_seq, 1), 0) = 0 then
      return v_room;
    end if;
    update public.wheel_group_rooms
       set status                = 'finished',
           finished_at           = v_now,
           finished_reason       = 'pool',
           current_target_topoid = null
     where id = p_room_id
       and status = 'playing'
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.wheel_group_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  update public.wheel_group_rooms
     set current_target_topoid = v_next
   where id = p_room_id
     and status = 'playing'
     and current_target_topoid is null
   returning * into v_room;
  if v_room.id is null then
    select * into v_room from public.wheel_group_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_group_advance_if_due(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_group_advance_if_due(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) Rövanş — sıra satırını da düşür (yeni maç yeni sıra üretsin)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_process_rematch_if_ready(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.wheel_duel_rooms;
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select * into v_room from public.wheel_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room.status <> 'finished'
     or coalesce(array_length(v_room.rematch_requested_by, 1), 0) < 2 then
    return v_room;
  end if;

  update public.wheel_duel_players set score = 0 where room_id = p_room_id;

  -- Yeni maç → yeni sıra (sunucu bir sonraki advance_if_due'da üretir).
  delete from public.wheel_duel_room_sequences where room_id = p_room_id;

  update public.wheel_duel_rooms
     set status                = 'waiting',
         started_at            = null,
         finished_at           = null,
         finished_reason       = null,
         winner_player_id      = null,
         current_target_topoid = null,
         used_target_topoids   = '{}',
         pass_requested_by     = '{}',
         pass_target_topoid    = null,
         rematch_requested_by  = '{}',
         -- XP IDEMPOTENCY: process_rematch ile BİREBİR aynı rotasyon.
         match_seq             = coalesce(match_seq, 1) + 1,
         current_match_id      = gen_random_uuid()
   where id = p_room_id
     and status = 'finished'
   returning * into v_room;
  if v_room.id is null then
    select * into v_room from public.wheel_duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_process_rematch_if_ready(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_duel_process_rematch_if_ready(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
