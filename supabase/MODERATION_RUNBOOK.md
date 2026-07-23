# Torble — Moderasyon Runbook (manuel)

App Store Guideline 1.2 UGC güvenlik paketi için **Supabase SQL Editor** üzerinden
elle moderasyon rehberi. Admin panel YOK; tüm işlemler `postgres`/`service_role`
ile SQL Editor'da yapılır (bu roller RLS ve kolon-kısıtlarını bypass eder).

> **Güvenlik kuralları**
> - Aşağıdaki tüm `UPDATE`'lerde **önce `SELECT` ile hedefi doğrula**, sonra
>   dar `WHERE id = '<uuid>'` ile güncelle. **WHERE'siz UPDATE ASLA.**
> - Placeholder `<...>` değerlerini gerçek uuid ile değiştir.
> - Reporter kimliğini (bildiren kişi) dışarı, özellikle bildirilen kullanıcıya
>   **paylaşma**. `reporter_profile_id` / `reporter_guest_key_hash` iç veridir.
> - Açık raporları makul sürede incele; kesin çözüm süresi taahhüt etme.
> - Bu dosya secret/anahtar içermez ve içermemeli.

İlgili migration: `20260806120000_ugc_safety_reports_moderation.sql`.

---

## 1) Açık raporları listele

```sql
select id, target_type, reason, status, created_at,
       reported_username_snapshot,
       left(coalesce(content_snapshot, ''), 120) as content_preview
  from public.reports
 where status = 'open'
 order by created_at asc
 limit 100;
```

Hedef türüne göre daralt (örn. yalnız mesaj raporları):

```sql
select id, reason, room_code, reported_username_snapshot,
       left(coalesce(content_snapshot,''), 160) as content_preview, created_at
  from public.reports
 where status = 'open' and target_type = 'room_message'
 order by created_at asc;
```

## 2) Tek bir raporun tüm detayı (snapshot dahil)

```sql
select *
  from public.reports
 where id = '<report_uuid>';
```

- `content_snapshot` / `reported_username_snapshot`: rapor anındaki **sunucu**
  kopyasıdır (mesaj sonradan silinse de burada kalır).
- `target_profile_id`: bildirilen kullanıcı (silinmişse `NULL`).
- `room_code` / `conversation_id`: bağlam.

## 3) Raporun durumunu güncelle (inceleniyor / çözüldü / reddedildi)

Önce doğrula, sonra güncelle:

```sql
-- (a) doğrula
select id, status, target_type, target_profile_id
  from public.reports
 where id = '<report_uuid>';

-- (b) incelemeye al
update public.reports
   set status = 'reviewing', reviewed_at = now()
 where id = '<report_uuid>';

-- (c) sonuçlandır: 'resolved' (işlem yapıldı) veya 'dismissed' (aksiyon yok)
update public.reports
   set status = 'resolved',
       resolved_at = now(),
       moderator_note = 'Kısa iç not: yapılan işlem.'
 where id = '<report_uuid>';
```

## 4) Kullanıcıyı geçici olarak askıya al (suspended)

`assert_profile_moderation_active` süresi geçmemiş suspension'da işlemi reddeder;
süre dolunca kullanıcı otomatik tekrar aktif davranır (kolonu sıfırlamaya gerek yok).

> **Not:** Ban/askı gerekçesi (`moderation_note`) ayrı **private** tabloda tutulur:
> `public.profile_moderation`. `profiles` tablosu dünya-okunur olduğundan
> (RLS `USING(true)` + REST GRANT), not orada TUTULAMAZ. `profile_moderation`'a
> yalnız `postgres`/`service_role` (SQL Editor) erişir; anon/authenticated erişemez.

```sql
-- (a) hedefi doğrula
select id, username, moderation_status, suspended_until
  from public.profiles
 where id = '<target_profile_uuid>';

-- (b) 7 gün askıya al (durum profiles'ta, gerekçe private tabloda)
update public.profiles
   set moderation_status = 'suspended',
       suspended_until   = now() + interval '7 days'
 where id = '<target_profile_uuid>';

insert into public.profile_moderation (profile_id, note)
values ('<target_profile_uuid>', 'Sebep: <kısa iç not>')
on conflict (profile_id) do update
   set note = excluded.note, updated_at = now();
```

## 5) Kullanıcıyı kalıcı yasakla (banned)

```sql
select id, username, moderation_status
  from public.profiles
 where id = '<target_profile_uuid>';

update public.profiles
   set moderation_status = 'banned',
       suspended_until   = null
 where id = '<target_profile_uuid>';

insert into public.profile_moderation (profile_id, note)
values ('<target_profile_uuid>', 'Sebep: <kısa iç not>')
on conflict (profile_id) do update
   set note = excluded.note, updated_at = now();
```

Notu okumak / güncellemek (yalnız `postgres`/`service_role`):

```sql
select pm.note, pm.updated_at, p.username, p.moderation_status
  from public.profile_moderation pm
  join public.profiles p on p.id = pm.profile_id
 where pm.profile_id = '<target_profile_uuid>';
```

Banned/suspended kullanıcı yeni sosyal/UGC işlemi yapamaz (mesaj, DM, arkadaşlık,
davet, rapor, kullanıcı adı değişimi). **Hesap silme HAKKI engellenmez** — banned
kullanıcı da hesabını silebilir, gizlilik/destek sayfalarına ulaşabilir.

## 6) Ban / askıyı kaldır (yeniden aktif et)

```sql
select id, username, moderation_status, suspended_until
  from public.profiles
 where id = '<target_profile_uuid>';

update public.profiles
   set moderation_status = 'active',
       suspended_until   = null
 where id = '<target_profile_uuid>';
```

## 7) Uygunsuz kullanıcı adını güvenli bir sistem adıyla değiştir

Kullanıcı adı içerik filtresini otomatik geçer; ama moderatör olarak elle de
değiştirebilirsin. `postgres` bağlamında `auth.uid()` NULL olduğundan username
enforce trigger'ının moderasyon dalı atlanır ve filtre yalnız içerik için çalışır
(temiz sistem adı sorun çıkarmaz). Benzersizlik için deterministik bir ad kullan:

```sql
-- (a) doğrula
select id, username, username_normalized
  from public.profiles
 where id = '<target_profile_uuid>';

-- (b) güvenli sistem adına çek (username_normalized'ı trigger otomatik üretir)
update public.profiles
   set username = 'Kullanici_' || substr(md5(id::text), 1, 6),
       username_source = 'moderation'
 where id = '<target_profile_uuid>';
```

## 8) Moderasyon sonrası: ilgili raporları kapat

Bir kullanıcı hakkında işlem yaptıysan, o kullanıcıya ait açık raporları toplu
sonuçlandır (yine önce SELECT):

```sql
-- (a) doğrula
select id, reason, status
  from public.reports
 where target_profile_id = '<target_profile_uuid>' and status in ('open','reviewing');

-- (b) hedefli toplu kapatma
update public.reports
   set status = 'resolved', resolved_at = now(),
       moderator_note = coalesce(moderator_note, '') || ' [toplu: kullanıcıya işlem uygulandı]'
 where target_profile_id = '<target_profile_uuid>' and status in ('open','reviewing');
```

## 9) İşlemi transaction içinde güvenle uygula (opsiyonel, önerilir)

Kritik değişikliklerde önce `select` ile satır sayısını gör, sonra tek transaction:

```sql
begin;
  -- doğrula (0/1 satır beklenir)
  select id, moderation_status from public.profiles where id = '<target_profile_uuid>';

  update public.profiles
     set moderation_status = 'suspended', suspended_until = now() + interval '3 days'
   where id = '<target_profile_uuid>';

  -- yanlışsa: rollback;  doğruysa: commit;
commit;
```

---

## contact@torble.com talepleri

- Destek e-postasından gelen bildirim/itirazları yukarıdaki adımlarla işле.
- İtiraz üzerine ban/askı kaldırılacaksa **6. adım**.
- Yanıtta reporter kimliğini paylaşma; yalnız sonucu (işlem yapıldı / yapılmadı)
  gerektiği kadar ilet.
- Kesin çözüm süresi taahhüdü verme.

## Hızlı sağlık kontrolleri

```sql
-- Son 24 saatteki rapor hacmi (spam tespiti):
select target_type, reason, count(*)
  from public.reports where created_at > now() - interval '24 hours'
 group by 1,2 order by 3 desc;

-- Aktif kısıtlı hesaplar:
select id, username, moderation_status, suspended_until
  from public.profiles
 where moderation_status <> 'active'
 order by moderation_status, suspended_until nulls last;
```
